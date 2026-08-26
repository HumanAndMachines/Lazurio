import { lstat, mkdir, mkdtemp, readdir, realpath, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

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
    move = rename,
    remove = rm,
    readDirectory = readdir,
    pathEntry = lstatOrNull,
  } = deps;
  if (await pathEntry(absoluteTargetPath)) return targetExists();

  const targetParent = dirname(absoluteTargetPath);
  const targetName = basename(absoluteTargetPath);
  let transportCwd = null;
  let stagingPath = null;
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
    if (await caseInsensitiveCollision({ targetParent, targetName, readDirectory })) {
      return targetCollision();
    }

    // A sibling staging directory guarantees one same-volume atomic rename.
    // The final path is never observable before Git and caller-owned identity
    // verification both succeed.
    stagingPath = await makeTempDirectory(join(targetParent, `.${targetName}.lazurio-materialize-`));
    const clone = await run(
      [
        "clone",
        "--branch",
        branch,
        "--single-branch",
        "--origin",
        "origin",
        "--",
        remote,
        stagingPath,
      ],
      {
        cwd: transportCwd,
        timeoutMs: GIT_CLONE_TIMEOUT_MS,
        env: remoteEnvironment,
      },
    );
    if (!clone.ok) return cloneFailure();

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

    // Repeat both checks immediately before publication. This catches a
    // concurrent writer and a case-folding collision on every supported OS.
    if (await pathEntry(absoluteTargetPath)) return targetExists();
    if (await caseInsensitiveCollision({ targetParent, targetName, readDirectory })) {
      return targetCollision();
    }
    try {
      await move(stagingPath, absoluteTargetPath);
      materialized = true;
    } catch (error) {
      if (["EEXIST", "ENOTEMPTY"].includes(error?.code)) return targetExists();
      return cloneFailure();
    }

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
    if (stagingPath && !materialized) {
      await remove(stagingPath, { recursive: true, force: true }).catch(() => {});
    }
  }
}

function materializationRequestIssue({
  mode,
  boundaryRoot,
  targetPath,
  remote,
  branch,
  run,
  verifyStaged,
}) {
  if (!GIT_CHECKOUT_MATERIALIZATION_MODES.includes(mode)) return "Checkout materialization mode není podporovaný.";
  if (![boundaryRoot, targetPath, remote, branch].every((value) => typeof value === "string" && value.trim() !== "")) {
    return "Checkout materialization vyžaduje úplné root, target, remote a branch souřadnice.";
  }
  if (typeof run !== "function") return "Checkout materialization vyžaduje explicitní Git runner.";
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
