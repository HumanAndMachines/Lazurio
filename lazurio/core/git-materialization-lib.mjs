import { lstat, mkdir, mkdtemp, readdir, realpath, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  inspectCanonicalPathBoundary,
  isSamePath,
} from "./path-boundary-lib.mjs";

export const GIT_CHECKOUT_MATERIALIZATION_MODES = Object.freeze([
  "organization-root",
  "nested-repo",
]);
export const GIT_CLONE_TIMEOUT_MS = 10 * 60_000;
export const GIT_FETCH_TIMEOUT_MS = 20_000;
export const GIT_LOCAL_TIMEOUT_MS = 10_000;
const PINNED_CHECKOUT_PUBLISH_MODE = "--lazurio-pinned-checkout-publisher";
const PINNED_CHECKOUT_DISCARD_MODE = "--lazurio-pinned-checkout-discarder";
const PINNED_CHECKOUT_OPERATION_TIMEOUT_MS = 60_000;

// One checkout publication primitive is shared by Organization install and
// Launchpad Sync. Callers own policy (manifest/root identity); Core owns the
// exact clone, verification, path boundary and atomic publication mechanism.
export async function materializeGitCheckout({
  mode,
  boundaryRoot,
  targetPath,
  remote,
  branch,
  run,
  runPinnedChild,
  remoteEnvironment = {},
  verifyStaged = async () => ({ ok: true }),
  deps = {},
} = {}) {
  const requestIssue = materializationRequestIssue({
    mode,
    boundaryRoot,
    targetPath,
    remote,
    branch,
    run,
    runPinnedChild,
    verifyStaged,
  });
  if (requestIssue) return invalidTarget(requestIssue);

  const absoluteBoundaryRoot = resolve(boundaryRoot);
  const absoluteTargetPath = resolve(targetPath);
  const boundary = await inspectCanonicalPathBoundary({
    rootPath: absoluteBoundaryRoot,
    targetPath: absoluteTargetPath,
    allowMissingTarget: true,
  });
  if (!boundary.ok) {
    return boundaryFailure("Cílová checkout cesta vede mimo kanonickou hranici vlastníka.");
  }

  const {
    makeDirectory = mkdir,
    makeTempDirectory = mkdtemp,
    remove = rm,
    readDirectory = readdir,
    pathEntry = lstatOrNull,
    publish = publishCheckoutWithPinnedParent,
    discard = discardCheckoutWithPinnedParent,
    beforeStage = async () => {},
    beforePublish = async () => {},
  } = deps;
  if (await pathEntry(absoluteTargetPath)) return targetExists();

  const targetParent = dirname(absoluteTargetPath);
  const targetName = basename(absoluteTargetPath);
  let transportCwd = null;
  let stagingPath = null;
  let stagingName = null;
  let expectedParentRealPath = null;
  let materialized = false;
  try {
    transportCwd = await makeTempDirectory(join(tmpdir(), "lazurio-git-transport-"));
    const source = await run(
      ["ls-remote", "--exit-code", "--heads", "--", remote, `refs/heads/${branch}`],
      {
        cwd: transportCwd,
        timeoutMs: GIT_FETCH_TIMEOUT_MS,
        env: remoteEnvironment,
      },
    );
    if (!source.ok || !source.stdout) return missingAccess();

    await makeDirectory(targetParent, { recursive: true });
    const parentBoundary = await inspectCanonicalPathBoundary({
      rootPath: absoluteBoundaryRoot,
      targetPath: targetParent,
      allowMissingTarget: false,
      allowTargetEqual: true,
    });
    if (!parentBoundary.ok) {
      return boundaryFailure("Rodič cílového checkoutu vede mimo kanonickou hranici vlastníka.");
    }
    expectedParentRealPath = parentBoundary.targetRealPath;
    if (await caseInsensitiveCollision({ targetParent, targetName, readDirectory })) {
      return targetCollision();
    }

    // The temporary sibling and the mutating Git clone are one OS-pinned cwd
    // operation. A concurrent lexical parent swap cannot redirect either
    // write outside the validated physical owner boundary.
    await beforeStage();
    const clone = await runPinnedChild(
      [
        "clone",
        "--branch",
        branch,
        "--single-branch",
        "--origin",
        "origin",
        "--",
        remote,
      ],
      {
        cwd: targetParent,
        expectedCwdRealPath: expectedParentRealPath,
        childPrefix: `.${targetName}.lazurio-materialize-`,
        timeoutMs: GIT_CLONE_TIMEOUT_MS,
        env: remoteEnvironment,
      },
    );
    if (!clone.ok) {
      if (["parent_identity_changed", "child_identity_changed"].includes(clone.code)) {
        return boundaryFailure("Rodič cílového checkoutu se před klonováním fyzicky změnil.");
      }
      return cloneFailure();
    }
    stagingName = clone.child_name;
    if (!isPortableChildName(stagingName)) return cloneFailure();
    // Verification follows the captured physical parent identity, not the
    // lexical targetParent name that another process could replace.
    stagingPath = join(expectedParentRealPath, stagingName);
    const stagingBoundary = await inspectCanonicalPathBoundary({
      rootPath: expectedParentRealPath,
      rootRealPath: expectedParentRealPath,
      targetPath: stagingPath,
    });
    if (!stagingBoundary.ok) {
      return boundaryFailure("Dočasný checkout nevznikl ve fyzicky ověřeném rodiči targetu.");
    }
    const gitVerification = await verifyClonedCheckout({
      path: stagingPath,
      branch,
      remote,
      run,
    });
    if (!gitVerification.ok) return gitVerification;

    const policyVerification = await verifyStaged({
      mode,
      path: stagingPath,
      branch,
      remote,
      head: gitVerification.head,
    });
    if (!policyVerification?.ok) {
      return verificationFailure(
        policyVerification?.message ?? "Naklonovaný checkout neprošel ověřením identity vlastníka.",
        policyVerification?.code,
      );
    }

    await beforePublish({
      targetParent,
      expectedParentRealPath,
      stagingName,
      targetName,
    });
    const publication = await publish({
      targetParent,
      expectedParentRealPath,
      stagingName,
      targetName,
    });
    if (!publication?.ok) {
      if (publication?.code === "target_exists") return targetExists();
      if (publication?.code === "target_case_collision") return targetCollision();
      if (["parent_identity_changed", "staging_identity_changed"].includes(publication?.code)) {
        return boundaryFailure("Rodič cílového checkoutu se během publikace fyzicky změnil.");
      }
      return cloneFailure();
    }
    materialized = true;

    return {
      ok: true,
      outcome: "materialized",
      code: null,
      message: "Git checkout byl ověřený a atomicky publikovaný do deklarovaného targetu.",
      mode,
      branch,
      head: gitVerification.head,
      remote,
    };
  } catch {
    return cloneFailure();
  } finally {
    if (transportCwd) {
      await remove(transportCwd, { recursive: true, force: true }).catch(() => {});
    }
    if (stagingName && expectedParentRealPath && !materialized) {
      try {
        await discard({
          targetParent,
          expectedParentRealPath,
          stagingName,
        });
      } catch {}
    }
  }
}

async function discardCheckoutWithPinnedParent({
  targetParent,
  expectedParentRealPath,
  stagingName,
}) {
  return runPinnedCheckoutOperation({
    mode: PINNED_CHECKOUT_DISCARD_MODE,
    targetParent,
    payload: {
      expected_parent_real_path: expectedParentRealPath,
      staging_name: stagingName,
    },
    failureCode: "discarder_failed",
  });
}

async function publishCheckoutWithPinnedParent({
  targetParent,
  expectedParentRealPath,
  stagingName,
  targetName,
}) {
  return runPinnedCheckoutOperation({
    mode: PINNED_CHECKOUT_PUBLISH_MODE,
    targetParent,
    payload: {
      expected_parent_real_path: expectedParentRealPath,
      staging_name: stagingName,
      target_name: targetName,
    },
    failureCode: "publisher_failed",
  });
}

async function runPinnedCheckoutOperation({ mode, targetParent, payload, failureCode }) {
  let child;
  let timeout;
  try {
    child = Bun.spawn(
      [process.execPath, fileURLToPath(import.meta.url), mode],
      {
        // The child is born inside the validated parent. Its cwd is an
        // OS-pinned directory capability, so relative checks and mutation
        // keep targeting that physical directory even if its name changes.
        cwd: targetParent,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        windowsHide: true,
      },
    );
    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
    const completed = Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    const expired = new Promise((resolveTimeout) => {
      timeout = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {}
        resolveTimeout(null);
      }, PINNED_CHECKOUT_OPERATION_TIMEOUT_MS);
    });
    const completion = await Promise.race([completed, expired]);
    if (!completion) return { ok: false, code: failureCode };
    const [stdout, , exitCode] = completion;
    const result = JSON.parse(stdout.trim());
    if (exitCode === 0 && result?.ok === true) return result;
    return { ok: false, code: result?.code ?? failureCode };
  } catch {
    return { ok: false, code: failureCode };
  } finally {
    clearTimeout(timeout);
  }
}

async function runPinnedCheckoutPublisher() {
  try {
    const payload = JSON.parse(await Bun.stdin.text());
    assertPinnedPublisherPayload(payload);
    const actualParentRealPath = await realpath(".");
    if (!isSamePath(actualParentRealPath, payload.expected_parent_real_path)) {
      throw pinnedPublisherError("parent_identity_changed");
    }

    const stagingEntry = await lstatOrNull(payload.staging_name);
    if (!stagingEntry?.isDirectory() || stagingEntry.isSymbolicLink()) {
      throw pinnedPublisherError("staging_identity_changed");
    }
    const stagingRealPath = await realpath(payload.staging_name);
    if (!isSamePath(dirname(stagingRealPath), actualParentRealPath)) {
      throw pinnedPublisherError("staging_identity_changed");
    }
    if (await lstatOrNull(payload.target_name)) {
      throw pinnedPublisherError("target_exists");
    }
    if (await caseInsensitiveCollision({
      targetParent: ".",
      targetName: payload.target_name,
      readDirectory: readdir,
    })) {
      throw pinnedPublisherError("target_case_collision");
    }

    await rename(payload.staging_name, payload.target_name);
    process.stdout.write(`${JSON.stringify({ ok: true })}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      code: error?.pinnedPublisherCode ?? "publisher_failed",
    })}\n`);
    process.exitCode = 1;
  }
}

async function runPinnedCheckoutDiscarder() {
  try {
    const payload = JSON.parse(await Bun.stdin.text());
    if (
      typeof payload?.expected_parent_real_path !== "string"
      || payload.expected_parent_real_path === ""
      || !isPortableChildName(payload.staging_name)
    ) {
      throw pinnedPublisherError("invalid_request");
    }
    const actualParentRealPath = await realpath(".");
    if (!isSamePath(actualParentRealPath, payload.expected_parent_real_path)) {
      throw pinnedPublisherError("parent_identity_changed");
    }
    const stagingEntry = await lstatOrNull(payload.staging_name);
    if (!stagingEntry) {
      process.stdout.write(`${JSON.stringify({ ok: true })}\n`);
      return;
    }
    if (!stagingEntry.isDirectory() || stagingEntry.isSymbolicLink()) {
      throw pinnedPublisherError("staging_identity_changed");
    }
    const stagingRealPath = await realpath(payload.staging_name);
    if (!isSamePath(dirname(stagingRealPath), actualParentRealPath)) {
      throw pinnedPublisherError("staging_identity_changed");
    }
    await rm(payload.staging_name, { recursive: true, force: true });
    process.stdout.write(`${JSON.stringify({ ok: true })}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      code: error?.pinnedPublisherCode ?? "discarder_failed",
    })}\n`);
    process.exitCode = 1;
  }
}

function assertPinnedPublisherPayload(payload) {
  if (
    typeof payload?.expected_parent_real_path !== "string"
    || payload.expected_parent_real_path === ""
    || !isPortableChildName(payload.staging_name)
    || !isPortableChildName(payload.target_name)
  ) {
    throw pinnedPublisherError("invalid_request");
  }
}

function isPortableChildName(value) {
  return typeof value === "string"
    && value !== ""
    && value !== "."
    && value !== ".."
    && basename(value) === value;
}

function pinnedPublisherError(code) {
  const error = new Error(code);
  error.pinnedPublisherCode = code;
  return error;
}

function materializationRequestIssue({
  mode,
  boundaryRoot,
  targetPath,
  remote,
  branch,
  run,
  runPinnedChild,
  verifyStaged,
}) {
  if (!GIT_CHECKOUT_MATERIALIZATION_MODES.includes(mode)) return "Checkout materialization mode není podporovaný.";
  if (![boundaryRoot, targetPath, remote, branch].every((value) => typeof value === "string" && value.trim() !== "")) {
    return "Checkout materialization vyžaduje úplné root, target, remote a branch souřadnice.";
  }
  if (typeof run !== "function") return "Checkout materialization vyžaduje explicitní Git runner.";
  if (typeof runPinnedChild !== "function") {
    return "Checkout materialization vyžaduje OS-pinned Git runner pro mutující clone.";
  }
  if (typeof verifyStaged !== "function") return "Checkout materialization vyžaduje ověřovací callback.";
  return null;
}

async function verifyClonedCheckout({ path, branch, remote, run }) {
  const [root, currentBranch, origin, head, status] = await Promise.all([
    run(["rev-parse", "--show-toplevel"], { cwd: path, timeoutMs: GIT_LOCAL_TIMEOUT_MS }),
    run(["branch", "--show-current"], { cwd: path, timeoutMs: GIT_LOCAL_TIMEOUT_MS }),
    run(["remote", "get-url", "origin"], { cwd: path, timeoutMs: GIT_LOCAL_TIMEOUT_MS }),
    run(["rev-parse", "--verify", "HEAD^{commit}"], { cwd: path, timeoutMs: GIT_LOCAL_TIMEOUT_MS }),
    run(["status", "--porcelain=v1"], { cwd: path, timeoutMs: GIT_LOCAL_TIMEOUT_MS }),
  ]);
  if ([root, currentBranch, origin, head, status].some((result) => !result.ok)) {
    return verificationFailure("Naklonovaný checkout nejde spolehlivě ověřit.");
  }
  let realRoot;
  let realPath;
  try {
    [realRoot, realPath] = await Promise.all([realpath(root.stdout), realpath(path)]);
  } catch {
    return verificationFailure("Naklonovaný checkout nemá ověřitelný Git root.");
  }
  if (
    !isSamePath(realRoot, realPath)
    || currentBranch.stdout !== branch
    || origin.stdout !== remote
    || status.stdout !== ""
    || !/^[0-9a-f]{40}$/u.test(head.stdout)
  ) {
    return verificationFailure("Naklonovaný checkout neodpovídá repu, branchi nebo čistému HEADu.");
  }
  return { ok: true, head: head.stdout };
}

async function caseInsensitiveCollision({ targetParent, targetName, readDirectory }) {
  const foldedTarget = targetName.toLocaleLowerCase("en-US");
  const entries = await readDirectory(targetParent);
  return entries.some((entry) => (
    entry !== targetName && entry.toLocaleLowerCase("en-US") === foldedTarget
  ));
}

function invalidTarget(message) {
  return { ok: false, outcome: "failed", code: "materialization_manifest_invalid", message };
}

function boundaryFailure(message) {
  return { ok: false, outcome: "failed", code: "materialization_path_forbidden", message };
}

function verificationFailure(message, code = "materialization_verification_failed") {
  return { ok: false, outcome: "failed", code, message };
}

function targetExists() {
  return {
    ok: false,
    outcome: "target_exists",
    code: "materialization_target_exists",
    message: "Cílová cesta už existuje; Lazurio ji nepřepíše ani nepřevezme.",
  };
}

function targetCollision() {
  return {
    ok: false,
    outcome: "target_exists",
    code: "materialization_target_case_collision",
    message: "Cílová cesta koliduje s existující cestou bez ohledu na velikost písmen.",
  };
}

function missingAccess() {
  return {
    ok: false,
    outcome: "missing_access",
    code: "materialization_source_unavailable",
    message: "Repo nebo jeho větev nejsou s aktuálními GitHub přístupy dostupné; nic se nenaklonovalo.",
  };
}

function cloneFailure() {
  return {
    ok: false,
    outcome: "failed",
    code: "materialization_clone_failed",
    message: "Git nedokončil ověřený checkout; finální target zůstal nedotčený.",
  };
}

async function lstatOrNull(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

if (import.meta.main) {
  if (process.argv[2] === PINNED_CHECKOUT_PUBLISH_MODE) {
    await runPinnedCheckoutPublisher();
  } else if (process.argv[2] === PINNED_CHECKOUT_DISCARD_MODE) {
    await runPinnedCheckoutDiscarder();
  } else {
    throw new Error("git-materialization-lib.mjs je interní Core knihovna");
  }
}
