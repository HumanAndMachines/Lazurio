import { realpath } from "node:fs/promises";
import { resolve } from "node:path";

import {
  GIT_LOCAL_TIMEOUT_MS,
  materializeGitCheckout,
} from "../../lazurio/core/git-materialization-lib.mjs";
import {
  inspectCanonicalPathBoundary,
  isSamePath,
} from "../../lazurio/core/path-boundary-lib.mjs";
import { runGit, runGitInPinnedTemporaryChild, safeGitRemoteEnv } from "./git-lib.mjs";

// Launchpad owns only the nested manifest policy. Core owns the one physical
// clone/verify/atomic-publication mechanism shared with Organization install.
export async function materializeRepoCheckout({ companiesRoot, repo, deps = {} } = {}) {
  if (!companiesRoot) throw new Error("materializeRepoCheckout requires companiesRoot");
  const {
    run: injectedRun,
    runPinnedChild: injectedPinnedChild,
    ...materializationDeps
  } = deps;
  const run = injectedRun ?? runGit;
  const runPinnedChild = injectedPinnedChild ?? runGitInPinnedTemporaryChild;
  const validation = await validateNestedRepoTarget({ companiesRoot, repo, run });
  if (!validation.ok) return validation;

  return materializeGitCheckout({
    mode: "nested-repo",
    boundaryRoot: validation.organizationRoot,
    targetPath: validation.targetPath,
    branch: validation.branch,
    remote: validation.remote,
    run,
    runPinnedChild,
    remoteEnvironment: safeGitRemoteEnv(),
    deps: materializationDeps,
  });
}

async function validateNestedRepoTarget({ companiesRoot, repo, run }) {
  if (!repo || typeof repo !== "object") return invalidTarget("Manifestovaný repo záznam chybí.");
  if (repo.repo_kind === "organization_root") {
    return invalidTarget("Organization root není nested-repo materialization target.");
  }
  const remote = typeof repo.repo === "string" ? repo.repo.trim() : "";
  const branch = typeof repo.expected_branch === "string" ? repo.expected_branch.trim() : "";
  const organizationPath = typeof repo.organization_path === "string" ? repo.organization_path.trim() : "";
  const slotPath = typeof repo.slot_path === "string" ? repo.slot_path.trim() : "";
  if (!remote || !branch || !organizationPath || !slotPath || !repo.absolute_path) {
    return invalidTarget("Aktivní manifestovaný slot nemá úplné repo, branch nebo path souřadnice.");
  }

  const organizationRoot = resolve(companiesRoot, organizationPath);
  const targetPath = resolve(organizationRoot, slotPath);
  if (!isSamePath(targetPath, repo.absolute_path)) {
    return boundaryFailure("Manifestovaná cesta neodpovídá akčnímu Git inventáři.");
  }
  const boundary = await inspectCanonicalPathBoundary({
    rootPath: organizationRoot,
    targetPath,
    allowMissingTarget: true,
  });
  if (!boundary.ok) return boundaryFailure("Manifestovaná cesta vede mimo kanonický root Organizace.");

  const [rootCheck, ignoreCheck, refCheck] = await Promise.all([
    run(["rev-parse", "--show-toplevel"], { cwd: organizationRoot, timeoutMs: GIT_LOCAL_TIMEOUT_MS }),
    run(["check-ignore", "--quiet", "--no-index", "--", `${targetPath}/`], {
      cwd: organizationRoot,
      timeoutMs: GIT_LOCAL_TIMEOUT_MS,
    }),
    run(["check-ref-format", "--branch", branch], {
      cwd: organizationRoot,
      timeoutMs: GIT_LOCAL_TIMEOUT_MS,
    }),
  ]);
  if (!rootCheck.ok) return invalidTarget("Organization mount není použitelný Git checkout.");
  let realDeclaredRoot;
  let realOrganizationRoot;
  try {
    [realDeclaredRoot, realOrganizationRoot] = await Promise.all([
      realpath(rootCheck.stdout),
      realpath(organizationRoot),
    ]);
  } catch {
    return boundaryFailure("Git root Organizace nejde kanonicky ověřit.");
  }
  if (!isSamePath(realDeclaredRoot, realOrganizationRoot)) {
    return boundaryFailure("Manifestovaný checkout by nevznikl v kořenovém Git repu Organizace.");
  }
  if (!ignoreCheck.ok) return invalidTarget("Manifestovaná checkout cesta není gitignored v Organization rootu.");
  if (!refCheck.ok) return invalidTarget("Manifest deklaruje neplatný název Git branche.");
  return { ok: true, organizationRoot, targetPath, branch, remote };
}

function invalidTarget(message) {
  return { ok: false, outcome: "failed", code: "materialization_manifest_invalid", message };
}

function boundaryFailure(message) {
  return { ok: false, outcome: "failed", code: "materialization_path_forbidden", message };
}
