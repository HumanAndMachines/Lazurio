import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, readFile, readdir, realpath, rename } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

import {
  githubRepositoryCoordinate,
  normalizeOrganizationSlotPath,
  organizationRepositorySlotCollectionConflicts,
  organizationSlotRepositoryAliasIssues,
  organizationSlotRepositoryBranch,
  organizationSlotRepositoryRemote,
} from "../core/organization-slot-scope-lib.mjs";
import { isSamePath } from "../core/path-boundary-lib.mjs";
import { moduleLocationRepairCommand } from "../core/module-location-repair-contract-lib.mjs";
import {
  ORGANIZATION_DOCUMENT_PATHS,
  readOrganizationRoot,
} from "../core/organization-root-reader-lib.mjs";
import {
  acquireUpdateLock,
  inspectLocalRepo,
} from "./lazurio-update-lib.mjs";
import {
  GIT_FETCH_TIMEOUT_MS,
  GIT_LOCAL_TIMEOUT_MS,
  runGit,
  safeGitRemoteEnv,
} from "./git-lib.mjs";
import {
  organizationRelativePathIssue,
  organizationSlotBoundaryIssueIsFatal,
} from "./discovery-lib.mjs";
import {
  classifyOrganizationModuleCheckoutLocation,
  inspectOrganizationModuleCheckoutCandidates,
  MODULE_MOUNT_CONTAINERS,
  organizationModuleDeclarationClaims,
} from "./module-location-candidates-lib.mjs";

const REPAIR_SCHEMA = "lazurio.module_location_repair.v1";
const allowedMountContainers = new Set(MODULE_MOUNT_CONTAINERS);

export async function runModuleLocationRepair({
  rootPath,
  organizationSlug,
  moduleSlug,
  apply = false,
  expectedFingerprint = null,
  deps = {},
} = {}) {
  const selectorCommand = moduleLocationRepairCommand({
    organization: organizationSlug,
    module: moduleSlug,
  });
  if (!rootPath) throw new Error("runModuleLocationRepair requires rootPath");
  if (!selectorCommand) {
    return blockedRepairReport({
      rootPath: resolve(rootPath),
      organizationSlug,
      moduleSlug,
      code: "selector_invalid",
      message: "Organization nebo Module selector není bezpečný stabilní slug.",
    });
  }

  const absoluteRoot = resolve(rootPath);
  if (!apply) {
    return checkModuleLocationRepair({
      rootPath: absoluteRoot,
      organizationSlug,
      moduleSlug,
      deps,
    });
  }

  const acquireLock = deps.acquireLock ?? acquireUpdateLock;
  let lock;
  try {
    lock = await acquireLock({
      rootPath: absoluteRoot,
      runId: `module-location-repair-${randomUUID()}`,
      now: deps.now ?? (() => new Date()),
    });
  } catch (error) {
    return blockedRepairReport({
      rootPath: absoluteRoot,
      organizationSlug,
      moduleSlug,
      code: "update_locked",
      message: error instanceof Error ? error.message : String(error),
    });
  }

  try {
    const checked = await checkModuleLocationRepair({
      rootPath: absoluteRoot,
      organizationSlug,
      moduleSlug,
      deps,
    });
    if (checked.state === "current") return checked;
    if (checked.state !== "ready") return checked;
    if (!expectedFingerprint || expectedFingerprint !== checked.fingerprint) {
      return blockedRepairReport({
        rootPath: absoluteRoot,
        organizationSlug,
        moduleSlug,
        code: "repair_plan_changed",
        message: "Ověřený stav se změnil. Spusť nejdřív znovu check-only příkaz a použij jen nový fingerprint.",
        plan: checked.plan,
      });
    }
    return applyCheckedRepair({ checked, deps });
  } finally {
    await lock.release().catch(() => {});
  }
}

export async function checkModuleLocationRepair({
  rootPath,
  organizationSlug,
  moduleSlug,
  deps = {},
} = {}) {
  const absoluteRoot = resolve(rootPath);
  const run = deps.runGit ?? runGit;
  const inspect = deps.inspectLocalRepo ?? inspectLocalRepo;
  const lstatPath = deps.lstatPath ?? lstat;
  const repositoryCoordinate = deps.repositoryCoordinate ?? githubRepositoryCoordinate;
  const organizationMatch = await findOrganization({
    rootPath: absoluteRoot,
    organizationSlug,
  });
  if (!organizationMatch.ok) {
    return blockedRepairReport({
      rootPath: absoluteRoot,
      organizationSlug,
      moduleSlug,
      code: organizationMatch.code,
      message: organizationMatch.message,
    });
  }

  const { organizationRoot, resolution } = organizationMatch;
  const organizationResource = resolution.resource;
  const sourceFiles = [];
  for (const [presenceKey, path] of [
    ["canonical", ORGANIZATION_DOCUMENT_PATHS.canonical],
    ["legacy_projection", ORGANIZATION_DOCUMENT_PATHS.legacy_projection],
    ["modules", ORGANIZATION_DOCUMENT_PATHS.modules],
  ]) {
    if (!resolution.document_presence?.[presenceKey]) continue;
    const source = await readFileSource(join(organizationRoot, path));
    if (!source.ok) {
      return blockedRepairReport({
        rootPath: absoluteRoot,
        organizationSlug,
        moduleSlug,
        code: "organization_source_unreadable",
        message: `${path} nejde přečíst jako reviewovaný Organization source: ${source.message}`,
      });
    }
    sourceFiles.push({ path, source: source.source });
  }
  const organizationSource = await inspectReviewPublishedOrganizationRoot({
    organizationRoot,
    organizationSlug,
    expectedRemote: organizationResource.root_repository?.locator ?? null,
    expectedBranch: organizationResource.root_repository?.default_branch ?? "main",
    repositoryCoordinate,
    sourceFiles,
    run,
    inspect,
    deps,
  });
  if (!organizationSource.ok) {
    return blockedRepairReport({
      rootPath: absoluteRoot,
      organizationSlug,
      moduleSlug,
      code: organizationSource.code,
      message: organizationSource.message,
      plan: organizationSource.plan,
    });
  }

  const manifestSlots = Array.isArray(organizationResource.repository_inventory)
    ? organizationResource.repository_inventory.filter((slot) => slot?.slug === moduleSlug)
    : [];
  const companySlots = manifestSlots;
  const allManifestSlots = organizationResource.repository_inventory ?? [];
  const allCompanySlots = [];
  const unsafeDeclarationPaths = [
    ...allManifestSlots.map((slot, index) => ({
      slot,
      source: `modules.manifest.json module_slots[${index}]`,
    })),
  ].flatMap(({ slot: candidate, source }) => {
    const issue = organizationRelativePathIssue({
      organizationRoot,
      path: candidate?.path,
    });
    return organizationSlotBoundaryIssueIsFatal({ path: candidate?.path, issue })
      ? [{ source, path: candidate?.path ?? null, issue }]
      : [];
  });
  const declarationConflicts = [
    ...organizationRepositorySlotCollectionConflicts(allManifestSlots),
  ];
  if (
    manifestSlots.length !== 1
    || unsafeDeclarationPaths.length > 0
    || declarationConflicts.length > 0
  ) {
    return blockedRepairReport({
      rootPath: absoluteRoot,
      organizationSlug,
      moduleSlug,
      code: "module_declaration_ambiguous",
      message: "Oprava vyžaduje právě jednu explicitní deklaraci se stabilním slugem v normalizovaném Organization repository inventory. Nejdřív synchronizuj Organization root nebo oprav source kontrakt v PR.",
      plan: {
        ...(unsafeDeclarationPaths.length > 0
          ? { unsafe_declaration_paths: unsafeDeclarationPaths }
          : {}),
        ...(declarationConflicts.length > 0
          ? { declaration_conflicts: declarationConflicts }
          : {}),
      },
    });
  }

  const slot = manifestSlots[0];
  const companySlot = companySlots[0];
  const declaredPath = typeof slot.path === "string" ? slot.path : "";
  const targetRelativePath = normalizeOrganizationSlotPath(declaredPath);
  const targetRemote = organizationSlotRepositoryRemote(slot, targetRelativePath) ?? "";
  const targetCoordinate = repositoryCoordinate(targetRemote);
  const companySlug = String(organizationResource.organization?.slug ?? "").trim();
  const manifestCompany = companySlug;
  const companyGithubOrg = String(organizationResource.organization?.forge_binding?.locator ?? "").trim();
  const manifestGithubOrg = companyGithubOrg;
  const pathParts = targetRelativePath ? targetRelativePath.split("/") : [];
  const branch = organizationSlotRepositoryBranch(slot, targetRelativePath);
  const companyRemote = organizationSlotRepositoryRemote(companySlot, companySlot?.path) ?? "";
  const companyBranch = organizationSlotRepositoryBranch(companySlot, companySlot?.path);
  const aliasIssues = [
    ...organizationSlotRepositoryAliasIssues(slot, targetRelativePath),
    ...organizationSlotRepositoryAliasIssues(companySlot, companySlot?.path),
  ];
  if (
    !targetRelativePath
    || declaredPath !== targetRelativePath
    || pathParts.length !== 2
    || !allowedMountContainers.has(pathParts[0])
    || !targetCoordinate
    || !companySlug
    || manifestCompany !== companySlug
    || companySlug.toLowerCase() !== String(organizationSlug).toLowerCase()
    || !companyGithubOrg
    || companyGithubOrg !== manifestGithubOrg
    || targetCoordinate.owner !== companyGithubOrg
    || pathParts[1] !== targetCoordinate.repository
    || branch !== "main"
    || (companyBranch !== null && companyBranch !== "main")
    || aliasIssues.length > 0
    || companySlot.path !== targetRelativePath
    || normalizeRemote(companyRemote, repositoryCoordinate) !== normalizeRemote(targetRemote, repositoryCoordinate)
  ) {
    return blockedRepairReport({
      rootPath: absoluteRoot,
      organizationSlug,
      moduleSlug,
      code: "module_declaration_invalid",
      message: "Organization slug, stable module slug, exact workspace/<GitHub-repository> cesta, main, nový remote a jeho GitHub owner se musí shodovat v obou Organization manifestech. Oprava lokálního checkoutu nesmí suplovat neplatný source ani cross-Organization access kontrakt.",
      plan: {
        expected_path: targetRelativePath || null,
        expected_origin: targetRemote || null,
      },
    });
  }

  const targetPath = join(organizationRoot, targetRelativePath);
  const parentCheck = await safeDirectoryBoundary({ root: organizationRoot, path: dirname(targetPath) });
  if (!parentCheck.ok) {
    return blockedRepairReport({
      rootPath: absoluteRoot,
      organizationSlug,
      moduleSlug,
      code: "target_boundary_invalid",
      message: parentCheck.message,
    });
  }

  const candidateInventory = await inspectOrganizationModuleCheckoutCandidates({
    organizationRoot,
    organizationSlug,
    moduleSlug,
  });
  const candidates = candidateInventory.verified;
  const declaredModuleClaims = organizationModuleDeclarationClaims([
    ...allManifestSlots,
    ...allCompanySlots,
  ]);
  const location = await classifyOrganizationModuleCheckoutLocation({
    organizationRoot,
    inspection: candidateInventory,
    expectedPath: targetRelativePath,
    moduleSlug,
    declaredModuleClaims,
  });
  if (location.status === "boundary_invalid") {
    return blockedRepairReport({
      rootPath: absoluteRoot,
      organizationSlug,
      moduleSlug,
      code: "checkout_scan_boundary_invalid",
      message: "Lazurio nemůže bezpečně projít všechny Module mount containery. Repair nepoužije kandidáta z neúplného nebo hranici překračujícího inventáře.",
      plan: {
        expected_path: targetPath,
        boundary_errors: candidateInventory.boundary_errors,
      },
    });
  }
  if (location.status === "unverified") {
    return blockedRepairReport({
      rootPath: absoluteRoot,
      organizationSlug,
      moduleSlug,
      code: "checkout_unverified",
      message: "Lazurio našlo přímý Git checkout, který může patřit tomuto stabilnímu Modulu, ale jeho marker identitu nepotvrzuje. Repair jej nesmí přesunout ani přepsat odhadem.",
      plan: {
        expected_path: targetPath,
        verified_paths: candidates.map((candidate) => candidate.path),
        unverified_suspects: location.unverified,
      },
    });
  }
  if (location.status === "ambiguous") {
    const targetCollision = location.target_occupied && candidates.length === 1;
    return blockedRepairReport({
      rootPath: absoluteRoot,
      organizationSlug,
      moduleSlug,
      code: targetCollision ? "target_collision" : "checkout_ambiguous",
      message: location.reason?.includes("declaration_collision")
        ? "Reviewované Organization deklarace a lokální stable Module identita si odporují. Repair nesmí přesunout checkout claimnutý jiným modulem ani vybrat cíl s cizím vlastníkem."
        : targetCollision
          ? `Cílová cesta už existuje a není nalezeným checkoutem: ${targetPath}. Lazurio ji nepřepíše ani nevytvoří duplicitní clone.`
          : `Lazurio našlo nejednoznačné checkouty nebo obsazený cíl (${location.observed_paths.join(", ")}). Automatická volba by mohla přepsat práci.`,
      plan: {
        expected_path: targetPath,
        found_paths: location.observed_paths,
        reason: location.reason,
      },
    });
  }
  if (candidates.length !== 1) {
    return blockedRepairReport({
      rootPath: absoluteRoot,
      organizationSlug,
      moduleSlug,
      code: candidates.length === 0 ? "checkout_not_found" : "checkout_ambiguous",
      message: candidates.length === 0
        ? "Lazurio nenašlo právě jeden bezpečný checkout se shodným lazurio.module.json ID. Nic nebude klonovat ani přesouvat odhadem."
        : `Lazurio našlo ${candidates.length} checkoutů se stejnou identitou. Automatická volba by mohla přepsat práci.`,
      plan: {
        expected_path: targetPath,
        found_paths: candidates.map((candidate) => candidate.path),
      },
    });
  }

  const source = candidates[0];
  const sourcePath = source.path;
  const sourceBoundary = await safeDirectoryBoundary({ root: organizationRoot, path: sourcePath });
  if (!sourceBoundary.ok) {
    return blockedRepairReport({
      rootPath: absoluteRoot,
      organizationSlug,
      moduleSlug,
      code: "source_boundary_invalid",
      message: sourceBoundary.message,
    });
  }
  let targetEntry = null;
  try {
    targetEntry = await lstatPath(targetPath);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      return blockedRepairReport({
        rootPath: absoluteRoot,
        organizationSlug,
        moduleSlug,
        code: "target_unreadable",
        message: `Cílovou cestu nelze bezpečně ověřit: ${targetPath}. Lazurio ji nebude považovat za prázdnou ani nic mutovat.`,
        plan: { found_path: sourcePath, expected_path: targetPath },
      });
    }
  }
  const sameTarget = targetEntry ? await sameExistingPath(sourcePath, targetPath) : false;
  if (targetEntry && !sameTarget) {
    return blockedRepairReport({
      rootPath: absoluteRoot,
      organizationSlug,
      moduleSlug,
      code: "target_collision",
      message: `Cílová cesta už existuje a není nalezeným checkoutem: ${targetPath}. Lazurio ji nepřepíše ani nevytvoří duplicitní clone.`,
      plan: { found_path: sourcePath, expected_path: targetPath },
    });
  }

  const gitMetadata = await lstat(join(sourcePath, ".git")).catch(() => null);
  if (!gitMetadata?.isDirectory()) {
    return blockedRepairReport({
      rootPath: absoluteRoot,
      organizationSlug,
      moduleSlug,
      code: "git_metadata_nonstandard",
      message: "Checkout používá Git worktree nebo oddělený .git adresář. Relokace vlastníka worktrees vyžaduje samostatné rozhodnutí a tento příkaz ji nemutuje.",
      plan: { found_path: sourcePath, expected_path: targetPath },
    });
  }

  const descriptor = {
    key: `${organizationSlug}::${moduleSlug}`,
    repo_kind: "module",
    organization: organizationSlug,
    module: moduleSlug,
    repo_path: relative(absoluteRoot, sourcePath),
    absolute_path: sourcePath,
    expected_branch: "main",
    repo: targetRemote,
  };
  const local = await inspect(descriptor, { ...deps, runGit: run });
  if (!local.ok || local.directoryOnly) {
    return blockedRepairReport({
      rootPath: absoluteRoot,
      organizationSlug,
      moduleSlug,
      code: local.reason ?? "git_inspection_failed",
      message: local.detail ?? "Nalezená složka není samostatný bezpečně ověřitelný Git checkout.",
      plan: { found_path: sourcePath, expected_path: targetPath },
    });
  }
  if (local.operation || local.branch !== "main" || local.dirtyPaths.length > 0 || local.sparseOrHiddenIndex) {
    const reason = local.operation
      ? `${local.operation}_in_progress`
      : local.branch !== "main"
        ? "primary_branch_not_main"
        : local.dirtyPaths.length > 0
          ? "checkout_dirty"
          : "hidden_index_state";
    return blockedRepairReport({
      rootPath: absoluteRoot,
      organizationSlug,
      moduleSlug,
      code: reason,
      message: "Checkout není clean main bez skrytého indexu a probíhajících Git operací. CLI veškerou lokální práci zachovalo a nic nezměnilo.",
      plan: {
        found_path: sourcePath,
        expected_path: targetPath,
        head: local.head,
        branch: local.branch,
        dirty_paths: local.dirtyPaths,
      },
    });
  }

  const mainHead = await gitValue(run, ["rev-parse", "refs/heads/main"], sourcePath);
  if (!mainHead || mainHead !== local.head) {
    return blockedRepairReport({
      rootPath: absoluteRoot,
      organizationSlug,
      moduleSlug,
      code: "main_head_mismatch",
      message: "HEAD a lokální main neukazují na stejný commit. CLI historii nepřepisuje ani nepřepíná.",
      plan: { found_path: sourcePath, expected_path: targetPath, head: local.head },
    });
  }
  const markerProof = await provePublishedHeadFile({
    run,
    cwd: sourcePath,
    relativePath: "lazurio.module.json",
    source: source.marker_source,
    lstatPath,
  });
  if (!markerProof.ok) {
    return blockedRepairReport({
      rootPath: absoluteRoot,
      organizationSlug,
      moduleSlug,
      code: "module_marker_unpublished",
      message: "Stabilní lazurio.module.json marker není prokazatelně běžný trackovaný blob aktuálního Module HEADu. Ignored/untracked nebo odlišný lokální marker nesmí autorizovat remote změnu ani přesun checkoutu.",
      plan: {
        found_path: sourcePath,
        expected_path: targetPath,
        marker_path: source.marker_path,
        proof_issue: markerProof.issue,
      },
    });
  }

  const shallow = await gitValue(run, ["rev-parse", "--is-shallow-repository"], sourcePath);
  const worktrees = await run(["worktree", "list", "--porcelain", "-z"], {
    cwd: sourcePath,
    timeoutMs: GIT_LOCAL_TIMEOUT_MS,
  });
  const worktreePaths = worktrees.ok
    ? worktrees.stdout.split("\0").filter((token) => token.startsWith("worktree ")).map((token) => token.slice(9))
    : [];
  const soleWorktreeIsSource = worktreePaths.length === 1
    && await sameExistingPath(worktreePaths[0], sourcePath).catch(() => false);
  if (shallow !== "false" || !worktrees.ok || !soleWorktreeIsSource) {
    return blockedRepairReport({
      rootPath: absoluteRoot,
      organizationSlug,
      moduleSlug,
      code: shallow !== "false" ? "shallow_repository" : "linked_worktrees_present",
      message: shallow !== "false"
        ? "Shallow repository neposkytuje dost historie pro bezpečný důkaz identity."
        : "Repo má připojené worktrees nebo jejich inventář nejde ověřit. CLI vlastníka worktrees nepřesouvá.",
      plan: { found_path: sourcePath, expected_path: targetPath, worktrees: worktreePaths },
    });
  }

  const originRead = await readOrigin({ run, cwd: sourcePath, repositoryCoordinate });
  if (!originRead.ok) {
    return blockedRepairReport({
      rootPath: absoluteRoot,
      organizationSlug,
      moduleSlug,
      code: originRead.code,
      message: originRead.message,
      plan: { found_path: sourcePath, expected_path: targetPath },
    });
  }
  const plannedOrigin = remoteForTargetCoordinate({
    currentRemote: originRead.url,
    manifestRemote: targetRemote,
    targetCoordinate,
  });

  const targetRef = `refs/lazurio/repair/${randomUUID().replaceAll("-", "")}/target`;
  let targetHead = null;
  let proofIssue = null;
  try {
    targetHead = await fetchRemoteMain({ run, cwd: sourcePath, remote: plannedOrigin, ref: targetRef });
    if (!targetHead) {
      proofIssue = {
        code: "target_remote_unavailable",
        message: "Nový manifestovaný remote/main nejde bez interakce načíst. Ověř GitHub přístup; CLI nic nezměnilo.",
        plan: { found_path: sourcePath, expected_path: targetPath, expected_origin: targetRemote },
      };
    } else {
      // The review-published Organization manifest and the stable Module
      // marker authorize the target repository. Git only has to prove that
      // moving this local checkout cannot abandon local main history. The new
      // target may legitimately have advanced after a transfer/rename.
      const ancestor = await run(["merge-base", "--is-ancestor", mainHead, targetHead], {
        cwd: sourcePath,
        timeoutMs: GIT_LOCAL_TIMEOUT_MS,
      });
      if (!ancestor.ok) proofIssue = {
        code: "local_history_incompatible",
        message: "Lokální main není předkem nového remote/main. Ahead nebo diverged historii musí posoudit Agent; CLI ji nemerguje, nerebasuje ani neresetuje.",
        plan: {
          found_path: sourcePath,
          expected_path: targetPath,
          head: mainHead,
          target_remote_head: targetHead,
        },
      };
    }
  } catch (error) {
    proofIssue = {
      code: "target_remote_unavailable",
      message: `Nový manifestovaný remote/main nejde bezpečně načíst: ${error instanceof Error ? error.message : String(error)}`,
      plan: { found_path: sourcePath, expected_path: targetPath, expected_origin: targetRemote },
    };
  } finally {
    const cleanup = await deleteRefVerified(run, sourcePath, targetRef);
    if (!cleanup.ok) {
      proofIssue = {
        code: "temporary_ref_cleanup_failed",
        message: `Git nepotvrdil odstranění dočasného repair refu ${targetRef}; další mutace je zablokovaná.`,
        plan: { found_path: sourcePath, expected_path: targetPath, temporary_ref: targetRef },
      };
    }
  }
  if (proofIssue) {
    return blockedRepairReport({
      rootPath: absoluteRoot,
      organizationSlug,
      moduleSlug,
      ...proofIssue,
    });
  }

  const fingerprintPayload = {
    schema: REPAIR_SCHEMA,
    root: await realpath(absoluteRoot),
    organization: organizationSlug,
    organization_root: await realpath(organizationRoot),
    organization_root_head: organizationSource.head,
    organization_root_origin: organizationSource.origin,
    organization_root_origin_identity: organizationSource.originIdentity,
    module: moduleSlug,
    organization_sources: sourceFiles.map(({ path, source: documentSource }) => ({
      path,
      sha256: sha256(documentSource),
    })),
    marker_sha256: sha256(source.marker_source),
    source_path: sourcePath,
    source_real_path: await realpath(sourcePath),
    target_path: targetPath,
    head: mainHead,
    current_origin: originRead.url,
    current_origin_identity: originRead.normalized,
    target_origin: plannedOrigin,
    target_origin_identity: normalizeRemote(targetRemote, repositoryCoordinate),
    target_head: targetHead,
    worktrees: worktreePaths,
  };
  const fingerprint = `sha256:${sha256(JSON.stringify(fingerprintPayload))}`;
  const applyArgv = moduleLocationRepairArgv({
    rootPath: absoluteRoot,
    organizationSlug,
    moduleSlug,
    apply: true,
    expectedFingerprint: fingerprint,
  });
  const plan = {
    organization: organizationSlug,
    module: moduleSlug,
    found_path: sourcePath,
    expected_path: targetPath,
    current_origin: originRead.url,
    expected_origin: plannedOrigin,
    manifest_origin: targetRemote,
    head: mainHead,
    target_remote_head: targetHead,
    path_change_required: sourcePath !== targetPath,
    origin_change_required: originRead.normalized !== normalizeRemote(targetRemote, repositoryCoordinate),
    apply_argv: applyArgv,
    apply_command: commandFromArgv(applyArgv),
  };

  if (!plan.path_change_required && !plan.origin_change_required) {
    const updateArgv = lazurioUpdateArgv(absoluteRoot);
    return {
      schema_version: REPAIR_SCHEMA,
      state: "current",
      ok: true,
      root: absoluteRoot,
      organization: organizationSlug,
      module: moduleSlug,
      message: "Umístění i origin modulu už odpovídají manifestu. Další lazurio update je idempotentní dokončení.",
      fingerprint,
      plan,
      next_action: {
        kind: "update",
        argv: updateArgv,
        command: commandFromArgv(updateArgv),
      },
    };
  }

  return {
    schema_version: REPAIR_SCHEMA,
    state: "ready",
    ok: true,
    root: absoluteRoot,
    organization: organizationSlug,
    module: moduleSlug,
    message: "Checkout je jednoznačný, clean main, bez worktrees a jeho lokální main je bezpečně obsažený v manifestovaném target main. Plán zatím nic nezměnil.",
    fingerprint,
    plan,
    next_action: {
      kind: "apply",
      argv: plan.apply_argv,
      command: plan.apply_command,
    },
  };
}

async function inspectReviewPublishedOrganizationRoot({
  organizationRoot,
  organizationSlug,
  expectedRemote,
  expectedBranch,
  repositoryCoordinate,
  sourceFiles,
  run,
  inspect,
  deps,
}) {
  const descriptor = {
    key: `${organizationSlug}::root`,
    repo_kind: "organization_root",
    organization: organizationSlug,
    module: "root",
    absolute_path: organizationRoot,
    expected_branch: "main",
  };
  const local = await inspect(descriptor, { ...deps, runGit: run });
  const blocked = (code, message, extra = {}) => ({
    ok: false,
    code,
    message,
    plan: {
      organization_root: organizationRoot,
      head: local?.head ?? null,
      branch: local?.branch ?? null,
      dirty_paths: local?.dirtyPaths ?? [],
      ...extra,
    },
  });
  if (!local.ok || local.directoryOnly) {
    return blocked(
      local.reason ?? "organization_source_unverified",
      local.detail ?? "Organization root není samostatný bezpečně ověřitelný Git checkout.",
    );
  }
  if (local.operation || local.branch !== "main" || local.dirtyPaths.length > 0 || local.sparseOrHiddenIndex) {
    return blocked(
      local.operation
        ? `organization_source_${local.operation}_in_progress`
        : local.branch !== "main"
          ? "organization_source_branch_invalid"
          : local.dirtyPaths.length > 0
            ? "organization_source_dirty"
            : "organization_source_hidden_index",
      "Organization root s repair manifesty není clean main bez skrytého indexu a probíhajících Git operací. Zachovej lokální práci v PR, spusť Synchronizovat a repair check zopakuj; Module checkout zatím zůstal nedotčený.",
    );
  }
  for (const sourceFile of sourceFiles) {
    const proof = await provePublishedHeadFile({
      run,
      cwd: organizationRoot,
      relativePath: sourceFile.path,
      source: sourceFile.source,
      lstatPath: deps.lstatPath ?? lstat,
    });
    if (!proof.ok) {
      return blocked(
        "organization_source_file_unpublished",
        `${sourceFile.path} není prokazatelně běžný trackovaný blob aktuálního Organization HEADu. Repair nebude jednat podle ignored, untracked, symlinkovaného ani lokálně odlišného manifestu.`,
        { source_path: sourceFile.path, proof_issue: proof.issue },
      );
    }
  }
  if (expectedBranch !== "main") {
    return blocked(
      "organization_source_branch_invalid",
      `Publikovaný Organization root deklaruje branch ${JSON.stringify(expectedBranch)}, ale repair smí důvěřovat pouze main.`,
      { expected_branch: expectedBranch },
    );
  }
  const expectedOriginIdentity = normalizeRemote(expectedRemote, repositoryCoordinate);
  if (!expectedOriginIdentity) {
    return blocked(
      "organization_source_origin_invalid",
      "Publikovaný Organization root nemá právě jeden platný canonical GitHub repository remote.",
      { expected_origin: expectedRemote ?? null },
    );
  }
  const origin = await readOrigin({
    run,
    cwd: organizationRoot,
    repositoryCoordinate,
  });
  if (!origin.ok) {
    return blocked(
      `organization_source_${origin.code}`,
      `Organization root nemá jednoznačný bezpečný origin: ${origin.message}`,
      { expected_origin: expectedRemote },
    );
  }
  if (origin.normalized !== expectedOriginIdentity) {
    return blocked(
      "organization_source_origin_mismatch",
      "Lokální Organization root origin neodpovídá publikovanému canonical repository. Nejdřív bezpečně oprav root remote a znovu spusť Synchronizovat; Module checkout zůstal nedotčený.",
      {
        current_origin: origin.url,
        current_origin_identity: origin.normalized,
        expected_origin: expectedRemote,
        expected_origin_identity: expectedOriginIdentity,
      },
    );
  }
  const [localMain, cachedOriginMain, upstream] = await Promise.all([
    gitValue(run, ["rev-parse", "refs/heads/main"], organizationRoot),
    gitValue(run, ["rev-parse", "refs/remotes/origin/main"], organizationRoot),
    gitValue(run, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], organizationRoot),
  ]);
  if (
    !localMain
    || !cachedOriginMain
    || local.head !== localMain
    || localMain !== cachedOriginMain
    || upstream !== "origin/main"
  ) {
    return blocked(
      "organization_source_not_published",
      "Organization root s repair manifesty neodpovídá přesně lokálnímu main a ověřenému cached origin/main. Nejdřív dokonči review/publikaci source kontraktu a spusť Synchronizovat; CLI nebude jednat podle lokálního Draftu ani stale manifestu.",
      {
        local_main: localMain,
        cached_origin_main: cachedOriginMain,
        upstream,
      },
    );
  }
  return {
    ok: true,
    head: localMain,
    origin: origin.url,
    originIdentity: origin.normalized,
  };
}

async function provePublishedHeadFile({
  run,
  cwd,
  relativePath,
  source,
  lstatPath = lstat,
}) {
  const entry = await lstatPath(join(cwd, relativePath)).catch(() => null);
  if (!entry?.isFile() || entry.isSymbolicLink()) {
    return { ok: false, issue: "working_path_not_regular" };
  }
  const [tree, objectFormat, unchanged] = await Promise.all([
    run(["ls-tree", "HEAD", "--", relativePath], {
      cwd,
      timeoutMs: GIT_LOCAL_TIMEOUT_MS,
    }),
    run(["rev-parse", "--show-object-format"], {
      cwd,
      timeoutMs: GIT_LOCAL_TIMEOUT_MS,
    }),
    run(["diff", "--quiet", "--no-ext-diff", "HEAD", "--", relativePath], {
      cwd,
      timeoutMs: GIT_LOCAL_TIMEOUT_MS,
    }),
  ]);
  const treeMatch = tree.ok
    ? tree.stdout.match(/^(100644|100755) blob ([0-9a-f]+)\t(.+)$/u)
    : null;
  if (!treeMatch || treeMatch[3] !== relativePath) {
    return { ok: false, issue: "head_path_not_regular_blob" };
  }
  if (!unchanged.ok) return { ok: false, issue: "working_source_differs_from_head" };
  const algorithm = objectFormat.ok && ["sha1", "sha256"].includes(objectFormat.stdout)
    ? objectFormat.stdout
    : null;
  if (!algorithm) return { ok: false, issue: "git_object_format_unverified" };
  const candidateSources = [source];
  if (source.includes("\r\n")) candidateSources.push(source.replace(/\r\n/g, "\n"));
  const expectedOids = new Set(candidateSources.map((candidate) =>
    gitBlobOid(candidate, algorithm)
  ));
  if (!expectedOids.has(treeMatch[2])) {
    return { ok: false, issue: "working_source_blob_mismatch" };
  }
  return { ok: true, oid: treeMatch[2] };
}

async function applyCheckedRepair({ checked, deps }) {
  const run = deps.runGit ?? runGit;
  const renamePath = deps.renamePath ?? rename;
  const lstatPath = deps.lstatPath ?? lstat;
  const { plan } = checked;
  let originMutationAttempted = false;
  const relocation = {
    original_path: plan.found_path,
    target_path: plan.expected_path,
    current_path: plan.found_path,
    temporary_path: null,
    completed: false,
  };
  try {
    if (plan.path_change_required) {
      const available = await relocationTargetAvailable(
        plan.found_path,
        plan.expected_path,
        lstatPath,
      );
      if (!available) throw new Error("Cílová cesta vznikla po kontrole; CLI ji nepřepíše.");
    }
    if (plan.origin_change_required) {
      originMutationAttempted = true;
      const changed = await run(["remote", "set-url", "origin", plan.expected_origin], {
        cwd: plan.found_path,
        timeoutMs: GIT_LOCAL_TIMEOUT_MS,
      });
      if (!changed.ok) throw new Error("Nový origin se nepodařilo zapsat.");
    }
    if (plan.path_change_required) {
      await relocateDirectory({
        sourcePath: plan.found_path,
        targetPath: plan.expected_path,
        renamePath,
        lstatPath,
        relocation,
      });
    }

    const verified = await checkModuleLocationRepair({
      rootPath: checked.root,
      organizationSlug: checked.organization,
      moduleSlug: checked.module,
      deps,
    });
    if (verified.state !== "current") {
      throw Object.assign(new Error("Po relokaci neprošel celý kontrakt znovu."), { verified });
    }
    return {
      schema_version: REPAIR_SCHEMA,
      state: "repaired",
      ok: true,
      organization: checked.organization,
      module: checked.module,
      message: "CLI bezpečně sladilo origin a cestu checkoutu. Git historie i pracovní data zůstala beze změny.",
      previous_fingerprint: checked.fingerprint,
      plan,
      next_action: {
        kind: "update",
        argv: lazurioUpdateArgv(checked.root),
        command: commandFromArgv(lazurioUpdateArgv(checked.root)),
      },
    };
  } catch (error) {
    const rollback = await rollbackRepair({
      run,
      renamePath,
      plan,
      checked,
      deps,
      originMutationAttempted,
      relocation,
    });
    return blockedRepairReport({
      rootPath: checked.root,
      organizationSlug: checked.organization,
      moduleSlug: checked.module,
      code: rollback.ok ? "repair_rolled_back" : "repair_recovery_required",
      message: rollback.ok
        ? `Oprava se nedokončila a CLI ji bezpečně vrátilo: ${error.message}`
        : `Oprava se nedokončila a automatický rollback nebyl úplný: ${error.message}. ${rollback.message}`,
      plan,
      recovery: rollback.recovery,
    });
  }
}

async function rollbackRepair({ run, renamePath, plan, checked, deps, originMutationAttempted, relocation }) {
  const attemptFailures = [];
  let located = await locateRecoveryCheckout({ run, plan, checked, relocation });
  let checkoutPath = located.path;
  if (!located.ok) attemptFailures.push(located.message);

  if (checkoutPath && !await exactDirectoryEntryExists(plan.found_path)) {
    const rollbackRelocation = {
      original_path: checkoutPath,
      target_path: plan.found_path,
      current_path: checkoutPath,
      temporary_path: null,
      completed: false,
    };
    try {
      await relocateDirectory({
        sourcePath: checkoutPath,
        targetPath: plan.found_path,
        renamePath,
        lstatPath: deps.lstatPath ?? lstat,
        relocation: rollbackRelocation,
      });
      checkoutPath = plan.found_path;
    } catch (error) {
      attemptFailures.push(`cestu nelze vrátit (${error.message})`);
      located = await locateRecoveryCheckout({
        run,
        plan,
        checked,
        relocation: rollbackRelocation,
      });
      checkoutPath = located.path;
      if (!located.ok) attemptFailures.push(located.message);
    }
  }

  if (originMutationAttempted && checkoutPath) {
    const restored = await run(["remote", "set-url", "origin", plan.current_origin], {
      cwd: checkoutPath,
      timeoutMs: GIT_LOCAL_TIMEOUT_MS,
    });
    if (!restored.ok) attemptFailures.push("původní origin nelze vrátit");
  } else if (originMutationAttempted) {
    attemptFailures.push("checkout pro obnovu původního originu nebyl nalezen");
  }

  const verified = await verifyRepairRollback({
    run,
    plan,
    checked,
    deps,
    relocation,
  });
  const failures = verified.ok
    ? []
    : [...new Set([...attemptFailures, ...verified.failures])];
  const temporaryPath = relocation.temporary_path && existsSync(relocation.temporary_path)
    ? relocation.temporary_path
    : null;
  const recovery = {
    status: failures.length === 0 ? "rolled_back" : "recovery_required",
    checkout_path: verified.checkout_path ?? checkoutPath ?? relocation.current_path ?? null,
    temporary_path: temporaryPath,
    expected_original_path: plan.found_path,
    expected_original_origin: plan.current_origin,
  };
  return failures.length === 0
    ? { ok: true, message: "Rollback dokončen a znovu ověřen.", recovery }
    : { ok: false, message: failures.join("; "), recovery };
}

async function relocateDirectory({ sourcePath, targetPath, renamePath, lstatPath = lstat, relocation }) {
  if (sourcePath === targetPath) return;
  if (!await relocationTargetAvailable(sourcePath, targetPath, lstatPath)) {
    throw new Error(`Cílová cesta ${targetPath} už existuje a není přesouvaným checkoutem.`);
  }
  const caseOnly = sourcePath.toLowerCase() === targetPath.toLowerCase();
  if (!caseOnly) {
    await renamePath(sourcePath, targetPath);
    relocation.current_path = targetPath;
    relocation.completed = true;
    return;
  }
  const temporaryPath = join(dirname(sourcePath), `.${basename(sourcePath)}.lazurio-relocate-${randomUUID()}`);
  relocation.temporary_path = temporaryPath;
  await renamePath(sourcePath, temporaryPath);
  relocation.current_path = temporaryPath;
  try {
    if (!await relocationTargetAvailable(temporaryPath, targetPath, lstatPath)) {
      throw new Error(`Cílová cesta ${targetPath} vznikla během case-only relokace.`);
    }
    await renamePath(temporaryPath, targetPath);
    relocation.current_path = targetPath;
    relocation.temporary_path = null;
    relocation.completed = true;
  } catch (error) {
    try {
      await renamePath(temporaryPath, sourcePath);
      relocation.current_path = sourcePath;
      relocation.temporary_path = null;
    } catch (rollbackError) {
      const combined = new Error(
        `${error.message}; checkout zůstal v dočasné cestě ${temporaryPath}, protože návrat selhal: ${rollbackError.message}`,
      );
      combined.cause = error;
      throw combined;
    }
    throw error;
  }
}

async function relocationTargetAvailable(sourcePath, targetPath, lstatPath = lstat) {
  try {
    await lstatPath(targetPath);
  } catch (error) {
    return error?.code === "ENOENT";
  }
  try {
    return await sameExistingPath(sourcePath, targetPath);
  } catch {
    return false;
  }
}

async function locateRecoveryCheckout({ run, plan, checked, relocation }) {
  const paths = [...new Set([
    relocation.current_path,
    relocation.temporary_path,
    plan.expected_path,
    plan.found_path,
  ].filter(Boolean))];
  const matches = [];
  for (const path of paths) {
    if (!await checkoutMatchesRepairPlan({ run, path, plan, checked })) continue;
    const canonical = await realpath(path).catch(() => resolve(path));
    if (matches.some((candidate) => isSamePath(candidate.canonical, canonical))) continue;
    matches.push({ path, canonical });
  }
  if (matches.length === 1) return { ok: true, path: matches[0].path };
  return {
    ok: false,
    path: matches.length === 1 ? matches[0].path : null,
    message: matches.length === 0
      ? "checkout se stabilní Module identitou a původním HEADem nebyl v recovery cestách nalezen"
      : `recovery cesty obsahují ${matches.length} checkoutů se stejnou identitou`,
  };
}

async function checkoutMatchesRepairPlan({ run, path, plan, checked }) {
  if (!path || !existsSync(path)) return false;
  try {
    const [gitStat, markerStat] = await Promise.all([
      lstat(join(path, ".git")),
      lstat(join(path, "lazurio.module.json")),
    ]);
    if (
      !gitStat.isDirectory()
      || gitStat.isSymbolicLink()
      || !markerStat.isFile()
      || markerStat.isSymbolicLink()
    ) return false;
    const marker = JSON.parse(await readFile(join(path, "lazurio.module.json"), "utf8"));
    if (
      marker?.schema_version !== "lazurio.module.v1"
      || marker?.id !== checked.module
      || marker?.company !== checked.organization
    ) return false;
    return await gitValue(run, ["rev-parse", "HEAD"], path) === plan.head;
  } catch {
    return false;
  }
}

async function verifyRepairRollback({ run, plan, checked, deps, relocation }) {
  const failures = [];
  const located = await locateRecoveryCheckout({ run, plan, checked, relocation });
  const checkoutPath = located.path;
  if (!located.ok) failures.push(located.message);
  if (!await exactDirectoryEntryExists(plan.found_path)) {
    failures.push(`původní exact cesta ${plan.found_path} nebyla obnovena`);
  }
  if (
    plan.path_change_required
    && await exactDirectoryEntryExists(plan.expected_path)
    && await checkoutMatchesRepairPlan({
      run,
      path: plan.expected_path,
      plan,
      checked,
    })
  ) {
    failures.push(`přesouvaný checkout po rollbacku stále leží v cílové exact cestě ${plan.expected_path}`);
  }
  if (checkoutPath) {
    const repositoryCoordinate = deps.repositoryCoordinate ?? githubRepositoryCoordinate;
    const [origin, branch, head, status] = await Promise.all([
      readOrigin({ run, cwd: checkoutPath, repositoryCoordinate }),
      gitValue(run, ["branch", "--show-current"], checkoutPath),
      gitValue(run, ["rev-parse", "HEAD"], checkoutPath),
      run(["status", "--porcelain=v1", "--untracked-files=all"], {
        cwd: checkoutPath,
        timeoutMs: GIT_LOCAL_TIMEOUT_MS,
      }),
    ]);
    if (!origin.ok || origin.url !== plan.current_origin) failures.push("původní raw origin nebyl obnoven");
    if (branch !== "main" || head !== plan.head || !status.ok || status.stdout !== "") {
      failures.push("checkout po rollbacku není ověřený clean main na původním HEADu");
    }
  }
  return { ok: failures.length === 0, failures, checkout_path: checkoutPath };
}

async function exactDirectoryEntryExists(path) {
  const entries = await readdir(dirname(path), { withFileTypes: true }).catch(() => []);
  const entry = entries.find((candidate) => candidate.name === basename(path));
  return Boolean(entry?.isDirectory() && !entry.isSymbolicLink());
}

function moduleLocationRepairArgv({
  rootPath,
  organizationSlug,
  moduleSlug,
  apply = false,
  expectedFingerprint = null,
}) {
  const argv = [
    "lazurio",
    "repair",
    "module-location",
    "--org",
    organizationSlug,
    "--module",
    moduleSlug,
    "--root",
    rootPath,
  ];
  if (apply) argv.push("--apply", "--expect", expectedFingerprint);
  return argv;
}

function lazurioUpdateArgv(rootPath) {
  return ["lazurio", "update", "--root", rootPath];
}

function commandFromArgv(argv) {
  return argv.map((value) => {
    const argument = String(value);
    return /^[A-Za-z0-9_./:@%+=,-]+$/u.test(argument)
      ? argument
      : `'${argument.replaceAll("'", `'"'"'`)}'`;
  }).join(" ");
}

function remoteForTargetCoordinate({ currentRemote, manifestRemote, targetCoordinate }) {
  const current = String(currentRemote ?? "").trim();
  const owner = targetCoordinate.owner;
  const repository = targetCoordinate.repository;
  const gitSuffix = /\.git\/?$/iu.test(current) ? ".git" : "";
  const trailingSlash = current.endsWith("/") ? "/" : "";
  const prefixes = [
    /^git@github\.com:/iu,
    /^ssh:\/\/(?:git@)?github\.com\//iu,
    /^https?:\/\/github\.com\//iu,
    /^git:\/\/github\.com\//iu,
  ];
  for (const pattern of prefixes) {
    const match = current.match(pattern);
    if (match) return `${match[0]}${owner}/${repository}${gitSuffix}${trailingSlash}`;
  }
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?\/?$/u.test(current)) {
    return `${owner}/${repository}${gitSuffix}${trailingSlash}`;
  }
  return manifestRemote;
}

async function findOrganization({ rootPath, organizationSlug }) {
  const organizationsRoot = join(rootPath, "organizations");
  const rootBoundary = await safeDirectoryBoundary({ root: rootPath, path: organizationsRoot });
  if (!rootBoundary.ok) {
    return { ok: false, code: "organizations_boundary_invalid", message: rootBoundary.message };
  }
  const entries = await readdir(organizationsRoot, { withFileTypes: true }).catch(() => []);
  const matches = [];
  const templateMatches = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name.startsWith(".")) continue;
    const organizationRoot = join(organizationsRoot, entry.name);
    const resolution = readOrganizationRoot({ organizationRoot });
    if (resolution.state === "missing") continue;
    const matchesRequestedMount = resolution.resource?.organization?.slug === organizationSlug
      || entry.name === organizationSlug
      || entry.name === `${organizationSlug}_GEN3`;
    if (!matchesRequestedMount) continue;
    if (
      !["legacy", "transition"].includes(resolution.state)
      || resolution.resource_count !== 1
    ) {
      return {
        ok: false,
        code: "organization_manifest_not_mutation_safe",
        message: `Organization manifest není bezpečný pro repair (${resolution.state}; ${resolution.issues.join(", ") || "no stable resource"}).`,
      };
    }
    const match = {
      organizationRoot,
      resolution,
    };
    if (resolution.resource.kind === "template") templateMatches.push(match);
    else matches.push(match);
  }
  if (templateMatches.length > 0) {
    return {
      ok: false,
      code: "organization_template",
      message: `Slug ${organizationSlug} patří template mountu; repair CLI smí mutovat pouze skutečnou Organizaci.`,
    };
  }
  if (matches.length !== 1) {
    return {
      ok: false,
      code: matches.length === 0 ? "organization_not_found" : "organization_ambiguous",
      message: matches.length === 0
        ? `Není namountovaná právě jedna Organizace se slugem ${organizationSlug}.`
        : `Více Organization mountů deklaruje slug ${organizationSlug}; nic nelze bezpečně vybrat.`,
    };
  }
  return { ok: true, ...matches[0] };
}

async function readOrigin({ run, cwd, repositoryCoordinate }) {
  const [fetch, explicitPush] = await Promise.all([
    run(["config", "--local", "--get-all", "remote.origin.url"], { cwd, timeoutMs: GIT_LOCAL_TIMEOUT_MS }),
    run(["config", "--local", "--get-all", "remote.origin.pushurl"], { cwd, timeoutMs: GIT_LOCAL_TIMEOUT_MS }),
  ]);
  const fetchUrls = fetch.stdout.split("\n").filter(Boolean);
  const pushUrls = explicitPush.stdout.split("\n").filter(Boolean);
  if (!fetch.ok || fetchUrls.length !== 1) {
    return { ok: false, code: "origin_ambiguous", message: "Repo musí mít právě jeden explicitní fetch URL pro origin." };
  }
  if (explicitPush.ok && pushUrls.length > 0) {
    return { ok: false, code: "origin_pushurl_explicit", message: "Repo má explicitní origin pushurl. První repair verze jej nesmí částečně přepsat; stav musí posoudit Agent." };
  }
  if (!explicitPush.ok && explicitPush.exitCode !== 1) {
    return { ok: false, code: "origin_inspection_failed", message: "Explicitní origin pushurl nejde spolehlivě ověřit." };
  }
  const normalized = normalizeRemote(fetchUrls[0], repositoryCoordinate);
  if (!normalized) {
    return { ok: false, code: "origin_invalid", message: "Origin neoznačuje jeden ověřitelný GitHub repozitář." };
  }
  return { ok: true, url: fetchUrls[0], normalized, push_urls: [] };
}

async function fetchRemoteMain({ run, cwd, remote, ref }) {
  const fetched = await run([
    "fetch",
    "--no-tags",
    "--no-write-fetch-head",
    "--force",
    "--",
    remote,
    `+refs/heads/main:${ref}`,
  ], { cwd, timeoutMs: GIT_FETCH_TIMEOUT_MS, env: safeGitRemoteEnv() });
  if (!fetched.ok) return null;
  return gitValue(run, ["rev-parse", ref], cwd);
}

async function deleteRefVerified(run, cwd, ref) {
  let removed;
  try {
    removed = await run(["update-ref", "-d", ref], { cwd, timeoutMs: GIT_LOCAL_TIMEOUT_MS });
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
  if (!removed.ok) return { ok: false, message: removed.stderr || removed.error || "update-ref failed" };
  let remaining;
  try {
    remaining = await run(["show-ref", "--verify", "--quiet", ref], {
      cwd,
      timeoutMs: GIT_LOCAL_TIMEOUT_MS,
    });
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
  return remaining.ok
    ? { ok: false, message: `temporary ref ${ref} still exists` }
    : remaining.exitCode === 1
      ? { ok: true }
      : { ok: false, message: remaining.stderr || remaining.error || "show-ref verification failed" };
}

async function gitValue(run, args, cwd) {
  const result = await run(args, { cwd, timeoutMs: GIT_LOCAL_TIMEOUT_MS });
  return result.ok && result.stdout ? result.stdout : null;
}

async function safeDirectoryBoundary({ root, path }) {
  const absoluteRoot = resolve(root);
  const absolutePath = resolve(path);
  const lexical = relative(absoluteRoot, absolutePath);
  if (!lexical || lexical.startsWith("..") || isAbsolute(lexical)) {
    return { ok: false, message: `Cesta ${absolutePath} neleží bezpečně pod ${absoluteRoot}.` };
  }
  const stat = await lstat(absolutePath).catch(() => null);
  if (!stat?.isDirectory() || stat.isSymbolicLink()) {
    return { ok: false, message: `Cesta ${absolutePath} musí být existující běžný adresář bez symlink/junction.` };
  }
  const [realRoot, realPath] = await Promise.all([realpath(absoluteRoot), realpath(absolutePath)]);
  const canonical = relative(realRoot, realPath);
  if (!canonical || canonical.startsWith("..") || isAbsolute(canonical)) {
    return { ok: false, message: `Kanonická cesta ${realPath} uniká z ${realRoot}.` };
  }
  return { ok: true, realPath };
}

async function sameExistingPath(left, right) {
  const [leftStat, rightStat] = await Promise.all([
    lstat(left).catch(() => null),
    lstat(right).catch(() => null),
  ]);
  if (
    !leftStat?.isDirectory()
    || leftStat.isSymbolicLink()
    || !rightStat?.isDirectory()
    || rightStat.isSymbolicLink()
  ) return false;
  const [realLeft, realRight] = await Promise.all([realpath(left), realpath(right)]);
  return isSamePath(realLeft, realRight);
}

async function readFileSource(path) {
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error("source musí být běžný soubor bez symlinku");
    }
    return { ok: true, source: await readFile(path, "utf8") };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

function normalizeRemote(remote, repositoryCoordinate) {
  const coordinate = repositoryCoordinate(String(remote ?? "").trim());
  return coordinate ? `${coordinate.owner.toLowerCase()}/${coordinate.repository.toLowerCase()}` : null;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function gitBlobOid(value, algorithm) {
  const bytes = Buffer.from(value, "utf8");
  return createHash(algorithm)
    .update(Buffer.from(`blob ${bytes.length}\0`, "utf8"))
    .update(bytes)
    .digest("hex");
}

function blockedRepairReport({
  rootPath,
  organizationSlug,
  moduleSlug,
  code,
  message,
  plan = null,
  recovery = null,
}) {
  const command = moduleLocationRepairCommand({
    organization: organizationSlug,
    module: moduleSlug,
  });
  const retryArgv = command && rootPath
    ? moduleLocationRepairArgv({ rootPath, organizationSlug, moduleSlug })
    : null;
  return {
    schema_version: REPAIR_SCHEMA,
    state: "blocked",
    ok: false,
    root: rootPath,
    organization: organizationSlug ?? null,
    module: moduleSlug ?? null,
    message,
    blockers: [{ code, message }],
    plan,
    recovery,
    next_action: {
      kind: "agent_review",
      message: "Zachovej lokální Git data a vyřeš konkrétní blocker; potom spusť check-only příkaz znovu.",
      argv: retryArgv,
      command: retryArgv ? commandFromArgv(retryArgv) : command,
    },
  };
}

export function moduleLocationRepairExitCode(report) {
  if (["current", "repaired"].includes(report?.state)) return 0;
  if (report?.state === "ready") return 1;
  return 3;
}

export function renderHumanModuleLocationRepair(report) {
  const lines = [
    `Lazurio module-location repair · ${report.state}`,
    `${report.organization ?? "?"}/${report.module ?? "?"}: ${report.message}`,
  ];
  if (report.plan?.found_path) lines.push(`Nalezeno: ${report.plan.found_path}`);
  if (report.plan?.expected_path) lines.push(`Kanonicky: ${report.plan.expected_path}`);
  if (report.plan?.current_origin) lines.push(`Origin nyní: ${report.plan.current_origin}`);
  if (report.plan?.expected_origin) lines.push(`Origin cílově: ${report.plan.expected_origin}`);
  if (report.fingerprint) lines.push(`Fingerprint: ${report.fingerprint}`);
  if (report.recovery?.status) lines.push(`Recovery: ${report.recovery.status}`);
  if (report.recovery?.checkout_path) lines.push(`Checkout pro recovery: ${report.recovery.checkout_path}`);
  if (report.recovery?.temporary_path) lines.push(`Dočasná cesta: ${report.recovery.temporary_path}`);
  if (report.recovery?.expected_original_path) {
    lines.push(`Očekávaná původní cesta: ${report.recovery.expected_original_path}`);
  }
  if (report.recovery?.expected_original_origin) {
    lines.push(`Očekávaný původní origin: ${report.recovery.expected_original_origin}`);
  }
  if (report.next_action?.command) lines.push(`Další krok: ${report.next_action.command}`);
  if (report.blockers?.length) {
    lines.push("Blokace:");
    for (const blocker of report.blockers) lines.push(`  - ${blocker.code}: ${blocker.message}`);
  }
  return lines.join("\n");
}
