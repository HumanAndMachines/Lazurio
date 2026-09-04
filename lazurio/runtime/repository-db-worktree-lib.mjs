import { existsSync } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, posix, relative, resolve, sep, win32 } from "node:path";
import { normalizeModuleManifest } from "../core/module-contract-lib.mjs";
import { readOrganizationRoot } from "../core/organization-root-reader-lib.mjs";
import {
  githubRepositoryCoordinate,
  organizationSlotRepositoryBranch,
  organizationSlotRepositoryRemote,
} from "../core/organization-slot-scope-lib.mjs";
import {
  inspectCanonicalPathBoundary,
  readJsonWithinCanonicalBoundary,
} from "../core/path-boundary-lib.mjs";
import { normalizePackageRuntime } from "../core/runtime-contract-lib.mjs";
import { GIT_LOCAL_TIMEOUT_MS, runGit } from "./git-lib.mjs";
import { readGitOperationState } from "./git-status-lib.mjs";

const REPOSITORY_DB_SOURCE = /^repository-db:[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const SHA = /^[0-9a-f]{40}$/;

export async function readRequiredRepositoryDbWorktreeSlots({
  organizationRoot,
  moduleCheckoutRoot,
  moduleSlotPath,
  moduleId,
} = {}) {
  const organization = readOrganizationRoot({ organizationRoot });
  if (
    organization.state === "conflict"
    || organization.state === "missing"
    || organization.resource_count !== 1
  ) {
    return failure(
      "organization_manifest_invalid",
      `Organization manifest není jednoznačná autorita (${organization.issues.join(", ") || organization.state}).`,
    );
  }
  if (!safeRelativePath(moduleSlotPath, { allowDot: false })) {
    return failure("module_slot_path_invalid", `Module slot path ${String(moduleSlotPath)} není bezpečná Organization-relative cesta.`);
  }

  const checkoutBoundary = await inspectCanonicalPathBoundary({
    rootPath: organizationRoot,
    targetPath: moduleCheckoutRoot,
  });
  if (!checkoutBoundary.ok || !checkoutBoundary.targetRealPath) {
    return failure("module_checkout_boundary_invalid", "Module checkout neleží uvnitř canonical Organization rootu.");
  }
  const checkoutRoot = checkoutBoundary.targetRealPath;
  const moduleManifestPath = resolve(checkoutRoot, "lazurio.module.json");
  if (!existsSync(moduleManifestPath)) return { ok: true, dependencies: [] };
  let moduleManifest;
  try {
    moduleManifest = (await readJsonWithinCanonicalBoundary({
      rootPath: checkoutRoot,
      targetPath: moduleManifestPath,
      label: `${moduleSlotPath}/lazurio.module.json`,
    })).value;
  } catch (error) {
    return failure(
      "module_contract_unavailable",
      `Worktree module contract nejde bezpečně načíst: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (moduleManifest?.apps === undefined) return { ok: true, dependencies: [] };
  if (Array.isArray(moduleManifest.apps) && moduleManifest.apps.length === 0) {
    return { ok: true, dependencies: [] };
  }
  const normalizedModule = normalizeModuleManifest({
    manifest: moduleManifest,
    modulePath: `${moduleSlotPath}/lazurio.module.json`,
  });
  if (normalizedModule.issues.length > 0) {
    return failure("module_contract_invalid", "Worktree module contract je neplatný.", normalizedModule.issues);
  }
  if (normalizedModule.module.id !== moduleId) {
    return failure(
      "module_identity_mismatch",
      `Worktree module ${String(normalizedModule.module.id)} neodpovídá selected repo ${String(moduleId)}.`,
    );
  }

  const requiredPaths = new Set();
  for (const appPath of normalizedModule.module.apps ?? []) {
    let packageJson;
    try {
      packageJson = (await readJsonWithinCanonicalBoundary({
        rootPath: checkoutRoot,
        targetPath: resolve(checkoutRoot, appPath),
        label: `${moduleSlotPath}/${appPath}`,
      })).value;
    } catch (error) {
      return failure(
        "runtime_contract_unavailable",
        `Deklarovaný worktree runtime ${appPath} nejde bezpečně načíst: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const normalizedRuntime = normalizePackageRuntime({
      packageJson,
      packagePath: `${moduleSlotPath}/${appPath}`,
    });
    if (!normalizedRuntime) continue;
    if (normalizedRuntime.issues.length > 0) {
      return failure("runtime_contract_invalid", `Worktree runtime ${appPath} je neplatný.`, normalizedRuntime.issues);
    }
    for (const requiredPath of normalizedRuntime.app.required_module_slots ?? []) {
      requiredPaths.add(requiredPath);
    }
  }

  const inventory = Array.isArray(organization.resource.repository_inventory)
    ? organization.resource.repository_inventory
    : [];
  const dependencies = [];
  for (const slotPath of requiredPaths) {
    const matches = inventory.filter((slot) => slot?.path === slotPath);
    if (matches.length !== 1) {
      return failure(
        matches.length === 0 ? "required_slot_missing" : "required_slot_ambiguous",
        matches.length === 0
          ? `Organization manifest nedeklaruje required slot ${slotPath}.`
          : `Organization manifest deklaruje required slot ${slotPath} vícekrát.`,
      );
    }
    const normalized = repositoryDbWorktreeDependencyForSlot({ slot: matches[0], moduleSlotPath });
    if (!normalized.required) continue;
    if (!normalized.ok) return normalized;
    dependencies.push({
      ...normalized.dependency,
      source_path: resolve(organizationRoot, slotPath),
    });
  }
  return { ok: true, dependencies };
}

export function repositoryDbWorktreeDependencyForSlot({ slot, moduleSlotPath } = {}) {
  const slotPath = slot?.path;
  const sourceOfTruth = typeof slot?.source_of_truth === "string"
    ? slot.source_of_truth.trim().toLowerCase()
    : "";
  const required = slot?.status === "active"
    && slot?.materialization === "repository_db_mount"
    && REPOSITORY_DB_SOURCE.test(sourceOfTruth);
  if (!required) return { ok: true, required: false, dependency: null };
  const relativePath = posix.relative(moduleSlotPath, slotPath);
  if (!safeRelativePath(relativePath, { allowDot: false }) || relativePath.startsWith("../")) {
    return {
      ...failure(
        "repository_db_binding_outside_module",
        `Required repository-db slot ${slotPath} neleží uvnitř selected module slotu ${moduleSlotPath}.`,
      ),
      required: true,
    };
  }
  const expectedBranch = organizationSlotRepositoryBranch(slot, slotPath);
  const remote = organizationSlotRepositoryRemote(slot, slotPath);
  if (!expectedBranch || !githubRepositoryCoordinate(remote)) {
    return {
      ...failure(
        "repository_db_source_invalid",
        `Required repository-db slot ${slotPath} nemá jednoznačný GitHub remote a branch.`,
      ),
      required: true,
    };
  }
  return {
    ok: true,
    required: true,
    dependency: {
      slot_path: slotPath,
      relative_path: relativePath,
      expected_branch: expectedBranch,
      remote,
    },
  };
}

export async function inspectCanonicalRepositoryDbCheckout({ organizationRoot, dependency } = {}) {
  if (!dependency || !safeRelativePath(dependency.slot_path, { allowDot: false })) {
    return failure("repository_db_source_invalid", "Repository-db dependency nemá bezpečný slot path.");
  }
  const sourcePath = resolve(organizationRoot, dependency.slot_path);
  let entry;
  try {
    entry = await lstat(sourcePath);
  } catch {
    return failure("repository_db_source_missing", `Kanonický repository-db checkout ${dependency.slot_path} neexistuje.`);
  }
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    return failure("repository_db_source_boundary_invalid", `Kanonický repository-db checkout ${dependency.slot_path} není běžný adresář.`);
  }
  const boundary = await inspectCanonicalPathBoundary({
    rootPath: organizationRoot,
    targetPath: sourcePath,
  });
  if (!boundary.ok || !boundary.targetRealPath) {
    return failure("repository_db_source_boundary_invalid", `Kanonický repository-db checkout ${dependency.slot_path} opouští Organization root.`);
  }
  const expectedCoordinate = githubRepositoryCoordinate(dependency.remote);
  const [topLevel, branch, head, porcelain, upstream, upstreamHead, remoteUrls, operation] = await Promise.all([
    runGit(["rev-parse", "--show-toplevel"], { cwd: boundary.targetRealPath, timeoutMs: GIT_LOCAL_TIMEOUT_MS }),
    runGit(["branch", "--show-current"], { cwd: boundary.targetRealPath, timeoutMs: GIT_LOCAL_TIMEOUT_MS }),
    runGit(["rev-parse", "HEAD"], { cwd: boundary.targetRealPath, timeoutMs: GIT_LOCAL_TIMEOUT_MS }),
    runGit(["status", "--porcelain=v1", "--untracked-files=normal"], { cwd: boundary.targetRealPath, timeoutMs: GIT_LOCAL_TIMEOUT_MS }),
    runGit(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], { cwd: boundary.targetRealPath, timeoutMs: GIT_LOCAL_TIMEOUT_MS }),
    runGit(["rev-parse", `origin/${dependency.expected_branch}`], { cwd: boundary.targetRealPath, timeoutMs: GIT_LOCAL_TIMEOUT_MS }),
    runGit(["remote", "get-url", "--all", "origin"], { cwd: boundary.targetRealPath, timeoutMs: GIT_LOCAL_TIMEOUT_MS }),
    readGitOperationState({ absolute_path: boundary.targetRealPath }),
  ]);
  const sourceRealPath = await realpath(boundary.targetRealPath);
  const topLevelRealPath = topLevel.ok ? await realpathOrNull(topLevel.stdout) : null;
  const configuredUrls = remoteUrls.ok ? remoteUrls.stdout.split("\n").filter(Boolean) : [];
  const configuredCoordinate = configuredUrls.length === 1
    ? githubRepositoryCoordinate(configuredUrls[0])
    : null;
  const expectedUpstream = `origin/${dependency.expected_branch}`;
  const details = [];
  if (!topLevel.ok || !samePath(topLevelRealPath, sourceRealPath)) details.push("checkout není exact Git top-level");
  if (!branch.ok || branch.stdout !== dependency.expected_branch) details.push(`branch musí být ${dependency.expected_branch}`);
  if (!head.ok || !SHA.test(head.stdout)) details.push("HEAD nelze přesně určit");
  if (!porcelain.ok || porcelain.stdout !== "") details.push("checkout není clean včetně untracked souborů");
  if (operation) details.push(`probíhá Git operace ${operation.kind}`);
  if (!upstream.ok || upstream.stdout !== expectedUpstream) details.push(`upstream musí být ${expectedUpstream}`);
  if (!upstreamHead.ok || head.stdout !== upstreamHead.stdout) details.push(`HEAD neodpovídá ${expectedUpstream}`);
  if (!sameGitHubCoordinate(expectedCoordinate, configuredCoordinate)) details.push("origin neodpovídá Organization manifestu");
  if (details.length > 0) {
    return failure(
      "repository_db_source_not_ready",
      `Kanonický repository-db checkout ${dependency.slot_path} není bezpečný zdroj worktree bindingu.`,
      details,
    );
  }
  return {
    ok: true,
    source_path: sourceRealPath,
    head: head.stdout,
    base_ref: expectedUpstream,
  };
}

export async function inspectRepositoryDbWorktreeBinding({
  organizationRoot,
  editWorktreeRoot,
  dependency,
  member,
} = {}) {
  const expectedBaseRef = `origin/${dependency?.expected_branch ?? ""}`;
  const shapeIssues = [];
  if (!member || member.role !== "dependency") shapeIssues.push("sidecar dependency member chybí");
  if (member?.slot_path !== dependency?.slot_path) shapeIssues.push("sidecar slot_path neodpovídá required slotu");
  if (member?.repo_path !== dependency?.relative_path) shapeIssues.push("sidecar repo_path neodpovídá deklarované child cestě");
  if (member?.materialization !== "linked_worktree") shapeIssues.push("dependency materialization musí být linked_worktree");
  if (member?.branch !== null) shapeIssues.push("dependency branch musí být null");
  if (member?.base_ref !== expectedBaseRef) shapeIssues.push(`dependency base_ref musí být ${expectedBaseRef}`);
  if (!SHA.test(member?.base_sha ?? "")) shapeIssues.push("dependency base_sha musí být exact 40-char SHA");
  if (shapeIssues.length > 0) {
    return failure("repository_db_binding_metadata_invalid", `Repository-db binding ${dependency?.slot_path ?? "<unknown>"} má neplatná metadata.`, shapeIssues);
  }

  const targetPath = resolve(editWorktreeRoot, member.repo_path);
  const lexicalRelative = relative(editWorktreeRoot, targetPath);
  if (!safeNativeDescendant(lexicalRelative)) {
    return failure("repository_db_binding_boundary_invalid", `Repository-db binding ${member.repo_path} opouští edit worktree.`);
  }
  let entry;
  try {
    entry = await lstat(targetPath);
  } catch {
    return failure("repository_db_binding_missing", `Repository-db binding ${member.repo_path} v edit worktree chybí.`);
  }
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    return failure("repository_db_binding_boundary_invalid", `Repository-db binding ${member.repo_path} není běžný adresář.`);
  }
  const boundary = await inspectCanonicalPathBoundary({
    rootPath: editWorktreeRoot,
    targetPath,
  });
  if (!boundary.ok || !boundary.targetRealPath) {
    return failure("repository_db_binding_boundary_invalid", `Repository-db binding ${member.repo_path} opouští edit worktree.`);
  }

  const [topLevel, branch, head, porcelain, operation, ignored] = await Promise.all([
    runGit(["rev-parse", "--show-toplevel"], { cwd: boundary.targetRealPath, timeoutMs: GIT_LOCAL_TIMEOUT_MS }),
    runGit(["branch", "--show-current"], { cwd: boundary.targetRealPath, timeoutMs: GIT_LOCAL_TIMEOUT_MS }),
    runGit(["rev-parse", "HEAD"], { cwd: boundary.targetRealPath, timeoutMs: GIT_LOCAL_TIMEOUT_MS }),
    runGit(["status", "--porcelain=v1", "--untracked-files=normal"], { cwd: boundary.targetRealPath, timeoutMs: GIT_LOCAL_TIMEOUT_MS }),
    readGitOperationState({ absolute_path: boundary.targetRealPath }),
    runGit(["check-ignore", "--no-index", "--quiet", "--", member.repo_path], {
      cwd: editWorktreeRoot,
      timeoutMs: GIT_LOCAL_TIMEOUT_MS,
    }),
  ]);
  const targetRealPath = await realpath(boundary.targetRealPath);
  const topLevelRealPath = topLevel.ok ? await realpathOrNull(topLevel.stdout) : null;
  const owner = await inspectRepositoryDbOwnerRegistration({
    organizationRoot,
    dependency,
    targetRealPath,
    expectedHead: member.base_sha,
  });
  const details = [];
  if (!topLevel.ok || !samePath(topLevelRealPath, targetRealPath)) details.push("binding není exact Git top-level");
  if (!branch.ok || branch.stdout !== "") details.push("binding není detached");
  if (!head.ok || head.stdout !== member.base_sha) details.push("binding HEAD neodpovídá sidecar base_sha");
  if (!porcelain.ok || porcelain.stdout !== "") details.push("binding není clean včetně untracked souborů");
  if (operation) details.push(`v bindingu probíhá Git operace ${operation.kind}`);
  if (!ignored.ok) details.push("dependency cesta není ignorovaná editovaným repem");
  if (!owner.ok) details.push(...owner.details);
  if (details.length > 0) {
    return failure(
      "repository_db_binding_not_ready",
      `Repository-db binding ${dependency.slot_path} není připravený.`,
      details,
    );
  }
  return { ok: true, target_path: targetRealPath, head: member.base_sha };
}

async function inspectRepositoryDbOwnerRegistration({
  organizationRoot,
  dependency,
  targetRealPath,
  expectedHead,
}) {
  const sourcePath = resolve(organizationRoot, dependency.slot_path);
  if (!existsSync(sourcePath)) return failure("repository_db_owner_missing", "Kanonický owner checkout chybí.");
  const [listed, remoteUrls] = await Promise.all([
    runGit(["worktree", "list", "--porcelain", "-z"], { cwd: sourcePath, timeoutMs: GIT_LOCAL_TIMEOUT_MS }),
    runGit(["remote", "get-url", "--all", "origin"], { cwd: sourcePath, timeoutMs: GIT_LOCAL_TIMEOUT_MS }),
  ]);
  const expectedCoordinate = githubRepositoryCoordinate(dependency.remote);
  const configuredUrls = remoteUrls.ok ? remoteUrls.stdout.split("\n").filter(Boolean) : [];
  const configuredCoordinate = configuredUrls.length === 1
    ? githubRepositoryCoordinate(configuredUrls[0])
    : null;
  const details = [];
  if (!sameGitHubCoordinate(expectedCoordinate, configuredCoordinate)) details.push("owner origin neodpovídá Organization manifestu");
  if (!listed.ok || !worktreeRegistrationMatches(listed.stdout, targetRealPath, expectedHead)) {
    details.push("binding není exact detached registrace kanonického repository-db ownera");
  }
  return details.length > 0
    ? failure("repository_db_owner_invalid", "Repository-db owner registrace nesedí.", details)
    : { ok: true };
}

function worktreeRegistrationMatches(porcelain, targetRealPath, expectedHead) {
  return parseWorktreePorcelain(porcelain).some((fields) => {
    const worktree = fields.find((field) => field.startsWith("worktree "));
    const head = fields.find((field) => field.startsWith("HEAD "));
    return worktree
      && samePath(worktree.slice("worktree ".length), targetRealPath)
      && head === `HEAD ${expectedHead}`
      && fields.includes("detached");
  });
}

function parseWorktreePorcelain(porcelain) {
  if (!porcelain.includes("\0")) {
    return porcelain.split("\n\n").filter(Boolean).map((block) => block.split("\n"));
  }
  const records = [];
  let current = [];
  for (const field of porcelain.split("\0")) {
    if (field === "") {
      if (current.length > 0) records.push(current);
      current = [];
    } else {
      current.push(field);
    }
  }
  if (current.length > 0) records.push(current);
  return records;
}

function safeRelativePath(value, { allowDot }) {
  if (typeof value !== "string" || value === "" || value.includes("\\") || value.includes("\0")) return false;
  if (value === ".") return allowDot;
  if (value.startsWith("/") || /^[A-Za-z]:/.test(value)) return false;
  const segments = value.split("/");
  return segments.every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

function safeNativeDescendant(value) {
  return value !== ""
    && value !== ".."
    && !value.startsWith(`..${sep}`)
    && !isAbsolute(value)
    && !win32.isAbsolute(value);
}

function sameGitHubCoordinate(left, right) {
  return Boolean(
    left
    && right
    && left.ownerRepo.toLowerCase() === right.ownerRepo.toLowerCase(),
  );
}

function samePath(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  if (process.platform === "win32") {
    return win32.resolve(left).toLowerCase() === win32.resolve(right).toLowerCase();
  }
  return resolve(left) === resolve(right);
}

async function realpathOrNull(path) {
  try {
    return await realpath(path);
  } catch {
    return null;
  }
}

function failure(code, message, details = []) {
  return { ok: false, code, message, details: details.length > 0 ? details : [message] };
}
