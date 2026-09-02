import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { dirname, join, posix, resolve } from "node:path";

import {
  GIT_LOCAL_TIMEOUT_MS,
  materializeGitCheckout,
} from "./core/git-materialization-lib.mjs";
import {
  createTrustedGitHubProvider,
  readGitHubRepositoryJsonDocument,
  runTrustedGitHubCliSync,
} from "./core/github-provider-lib.mjs";
import { resolveTrustedGitHubCliExecutable } from "./core/cli-provenance-lib.mjs";
import { resolveOrganizationRootDocuments } from "./core/organization-activation-lib.mjs";
import { readOrganizationRoot } from "./core/organization-root-reader-lib.mjs";
import { isValidOrganizationForgeBinding } from "./core/organization-scaffold-lib.mjs";
import {
  githubRepositoryCoordinate,
  normalizeOrganizationSlotPath,
  organizationSlotRepositoryBranch,
  organizationSlotRepositoryRemote,
  organizationSlotScope,
} from "./core/organization-slot-scope-lib.mjs";
import { isSamePath } from "./core/path-boundary-lib.mjs";
import { runIsolatedLazurioUpdate } from "./runtime/lazurio-update-runner-lib.mjs";
import {
  runGit,
  runGitInPinnedTemporaryChild,
  safeGitRemoteEnv,
} from "./runtime/git-lib.mjs";

export const ORGANIZATION_INSTALL_REPORT_SCHEMA = "lazurio.organization.install.v0";
export const ORGANIZATION_INSTALL_STATES = Object.freeze(["current", "updated", "blocked"]);

const githubLoginPattern = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/u;

export async function installOrganization({
  rootPath,
  githubLogin,
  expectedOrganizationId = null,
  platform = process.platform,
  environment = process.env,
  deps = {},
} = {}) {
  if (!rootPath) throw new TypeError("Organization install requires a Lazurio Root.");
  const locator = normalizeGitHubLogin(githubLogin);
  const expectedId = normalizeOptionalOrganizationId(expectedOrganizationId);
  const absoluteRoot = resolve(rootPath);
  const observe = deps.observe ?? observeOrganizationInstallSource;
  const reobserve = deps.reobserve ?? observeOrganizationInstallIdentity;
  const run = deps.runGit ?? runGit;
  const runPinnedChild = deps.runPinnedChild ?? runGitInPinnedTemporaryChild;
  const runUpdate = deps.runUpdate ?? runIsolatedLazurioUpdate;
  const installRepositoryDb = deps.installRepositoryDb ?? installOrganizationRepositoryDbMounts;

  const localRoot = await verifyInstallRootBoundary(absoluteRoot);
  if (!localRoot.ok) {
    return blockedReport({
      rootPath: absoluteRoot,
      locator,
      root: rootOutcome("blocked", localRoot.code, `organizations/${locator}_GEN3`, localRoot.message),
    });
  }

  const source = await observe({
    githubLogin: locator,
    expectedOrganizationId: expectedId,
    platform,
    environment,
    resolveGitHubCli: deps.resolveGitHubCli,
    runGitHubCli: deps.runGitHubCli,
  });
  if (!source.ok) return blockedReport({ rootPath: absoluteRoot, locator, source });
  if (expectedId !== null && source.organization.id !== expectedId) {
    return blockedReport({
      rootPath: absoluteRoot,
      locator,
      source,
      root: rootOutcome(
        "blocked",
        "organization_identity_mismatch",
        `organizations/${source.organization.login}_GEN3`,
        "GitHub Organization login už neodpovídá očekávané immutable identitě.",
      ),
    });
  }

  const organizationPath = `organizations/${source.organization.login}_GEN3`;
  const targetPath = join(absoluteRoot, organizationPath);
  const targetName = `${source.organization.login}_GEN3`;
  const caseCollision = await caseFoldedOrganizationTarget({
    organizationsPath: join(absoluteRoot, "organizations"),
    targetName,
    readDirectory: deps.readDirectory ?? readdir,
  });
  if (caseCollision) {
    return blockedReport({
      rootPath: absoluteRoot,
      locator,
      source,
      root: rootOutcome(
        "blocked",
        "materialization_target_case_collision",
        organizationPath,
        `Cílová Organization koliduje s existující cestou ${caseCollision}.`,
      ),
    });
  }
  const existing = await lstatOrNull(targetPath);
  let rootResult;
  if (existing) {
    if (existing.isSymbolicLink() || !existing.isDirectory()) {
      return blockedReport({
        rootPath: absoluteRoot,
        locator,
        source,
        root: rootOutcome("blocked", "root_target_unsafe", organizationPath),
      });
    }
    const verification = await verifyOrganizationRootCheckout({
      path: targetPath,
      source,
      run,
    });
    if (!verification.ok) {
      return blockedReport({
        rootPath: absoluteRoot,
        locator,
        source,
        root: rootOutcome("blocked", verification.code, organizationPath, verification.message),
      });
    }
    const identity = await reobserveSourceIdentity({
      source,
      platform,
      environment,
      deps,
      reobserve,
    });
    if (!identity.ok) {
      return blockedReport({
        rootPath: absoluteRoot,
        locator,
        source,
        root: rootOutcome("blocked", identity.code, organizationPath, identity.message),
      });
    }
    rootResult = rootOutcome("current", "root_current", organizationPath);
  } else {
    const materialized = await materializeGitCheckout({
      mode: "organization-root",
      boundaryRoot: absoluteRoot,
      targetPath,
      remote: source.repository.read_url,
      branch: source.repository.default_branch,
      run,
      runPinnedChild,
      remoteEnvironment: safeGitRemoteEnv(platform),
      verifyStaged: async ({ path }) => {
        const checkout = await verifyOrganizationRootCheckout({ path, source, run });
        if (!checkout.ok) return checkout;
        return reobserveSourceIdentity({
          source,
          platform,
          environment,
          deps,
          reobserve,
        });
      },
      deps: deps.materialization,
    });
    if (!materialized.ok) {
      return blockedReport({
        rootPath: absoluteRoot,
        locator,
        source,
        root: rootOutcome(
          "blocked",
          materialized.code ?? "root_materialization_failed",
          organizationPath,
          materialized.message,
        ),
      });
    }
    rootResult = rootOutcome("updated", "root_materialized", organizationPath);
  }

  const organization = organizationInventoryDescriptor({ source, organizationPath });
  let convergence = await runUpdate({ rootPath: absoluteRoot, organizations: [organization] });
  if (convergence.state !== "blocked") {
    const repositoryDbResults = await installRepositoryDb({
      rootPath: absoluteRoot,
      organizationPath,
      organizationRoot: targetPath,
      source,
      platform,
      run,
      runPinnedChild,
      materializationDeps: deps.materialization,
    });
    convergence = appendConvergenceResults(convergence, repositoryDbResults);
  }
  const state = convergence.state === "blocked"
    ? "blocked"
    : rootResult.state === "updated" || convergence.state === "updated"
      ? "updated"
      : "current";
  const report = freeze({
    schema_version: ORGANIZATION_INSTALL_REPORT_SCHEMA,
    state,
    ok: state !== "blocked",
    root: absoluteRoot,
    organization: organizationIdentity(source, locator),
    target: rootResult,
    convergence,
  });
  if (!isValidOrganizationInstallReport(report)) {
    throw new Error("Organization install produced an invalid report.");
  }
  return report;
}

// General `lazurio update` intentionally excludes repository-db checkouts from
// its Git action inventory. The explicit Organization install command is the
// bounded bootstrap authority: it may materialize an active declared mount,
// but it never gains repository-db commit/publish or ongoing sync authority.
export async function installOrganizationRepositoryDbMounts({
  rootPath,
  organizationPath,
  organizationRoot,
  source,
  platform = process.platform,
  run = runGit,
  runPinnedChild = runGitInPinnedTemporaryChild,
  materializationDeps = {},
} = {}) {
  let resolution;
  try {
    resolution = readOrganizationRoot({ organizationRoot });
  } catch {
    return [repositoryDbBlockedResult({
      source,
      organizationPath,
      reason: "repository_db_manifest_invalid",
      message: "Organization root nemá čitelné manifesty pro repository-db instalaci.",
    })];
  }
  if (
    !["current", "legacy", "transition"].includes(resolution.state)
    || resolution.resource_count !== 1
    || !Array.isArray(resolution.resource?.repository_inventory)
  ) {
    return [repositoryDbBlockedResult({
      source,
      organizationPath,
      reason: "repository_db_manifest_invalid",
      message: "Organization root nemá jednoznačný validní repository inventory pro repository-db instalaci.",
    })];
  }
  const repositoryInventory = resolution.resource?.repository_inventory ?? [];
  const missionControlSlots = repositoryInventory
    .filter((slot) => normalizeOrganizationSlotPath(slot?.path) === "mission-control");
  const repositoryDbSlots = repositoryInventory
    .filter((slot) => normalizeOrganizationSlotPath(slot?.path) === "mission-control/db");

  // A plain Organization scaffold may not have Mission Control at all. Once
  // either side of the app/data boundary is declared, however, an explicit
  // install must not claim convergence while leaving its required data mount
  // absent, inactive, or under the wrong materialization contract.
  if (missionControlSlots.length === 0 && repositoryDbSlots.length === 0) return [];
  if (missionControlSlots.length !== 1) {
    return [repositoryDbBlockedResult({
      source,
      organizationPath,
      reason: "repository_db_parent_invalid",
      message: "Mission Control boundary nemá právě jeden deklarovaný parent repozitář.",
    })];
  }
  if (repositoryDbSlots.length === 0) {
    return [repositoryDbBlockedResult({
      source,
      organizationPath,
      reason: "repository_db_required_missing",
      message: "Deklarovaný Mission Control nemá povinný mission-control/db repository-db mount.",
    })];
  }
  if (repositoryDbSlots.length !== 1) {
    return [repositoryDbBlockedResult({
      source,
      organizationPath,
      reason: "repository_db_manifest_invalid",
      message: "Mission Control deklaruje více než jeden mission-control/db repository-db mount.",
    })];
  }

  const [slot] = repositoryDbSlots;
  if (slot?.path !== "mission-control/db" || slot?.status !== "active") {
    return [repositoryDbBlockedResult({
      source,
      organizationPath,
      slot,
      reason: "repository_db_not_active",
      message: "Mission Control repository-db mount musí být přesně aktivní mission-control/db.",
    })];
  }
  if (slot.materialization !== "repository_db_mount") {
    return [repositoryDbBlockedResult({
      source,
      organizationPath,
      slot,
      reason: "repository_db_materialization_invalid",
      message: "Aktivní mission-control/db musí používat materialization: repository_db_mount.",
    })];
  }
  return [await installOrganizationRepositoryDbMount({
    rootPath,
    organizationPath,
    organizationRoot,
    source,
    slot,
    repositoryInventory,
    platform,
    run,
    runPinnedChild,
    materializationDeps,
  })];
}

async function installOrganizationRepositoryDbMount({
  rootPath,
  organizationPath,
  organizationRoot,
  source,
  slot,
  repositoryInventory,
  platform,
  run,
  runPinnedChild,
  materializationDeps,
}) {
  const identity = repositoryDbResultIdentity({ source, organizationPath, slot });
  const validation = await validateOrganizationRepositoryDbMount({
    rootPath,
    organizationPath,
    organizationRoot,
    source,
    slot,
    repositoryInventory,
    run,
  });
  if (!validation.ok) {
    return { ...identity, state: "blocked", reason: validation.code, message: validation.message };
  }
  const existing = await lstatOrNull(validation.targetPath);
  if (existing) {
    const verification = await verifyExistingRepositoryDbCheckout({
      targetPath: validation.targetPath,
      remote: validation.remote,
      branch: validation.branch,
      run,
    });
    if (!verification.ok) {
      return { ...identity, state: "blocked", reason: verification.code, message: verification.message };
    }
    return {
      ...identity,
      state: "current",
      reason: "repository_db_current",
      message: "Deklarovaný repository-db checkout je přítomný, čistý a odpovídá remote i branchi.",
      head: verification.head,
    };
  }
  const materialized = await materializeGitCheckout({
    mode: "nested-repo",
    boundaryRoot: organizationRoot,
    targetPath: validation.targetPath,
    remote: validation.remote,
    branch: validation.branch,
    run,
    runPinnedChild,
    remoteEnvironment: safeGitRemoteEnv(platform),
    verifyStaged: ({ path: stagingPath }) => (
      isSamePath(dirname(stagingPath), validation.parentRealPath)
        ? { ok: true }
        : providerFailure(
            "repository_db_parent_identity_changed",
            "Parent repository-db mountu se během materializace fyzicky změnil.",
          )
    ),
    deps: materializationDeps,
  });
  if (!materialized.ok) {
    return {
      ...identity,
      state: "blocked",
      reason: materialized.code ?? "repository_db_materialization_failed",
      message: materialized.message,
    };
  }
  return {
    ...identity,
    state: "updated",
    reason: "repository_db_materialized",
    message: "Repository-db checkout byl ověřený a atomicky materializovaný explicitní Organization instalací.",
    head: materialized.head,
    actions: ["materialize"],
  };
}

async function validateOrganizationRepositoryDbMount({
  rootPath,
  organizationPath,
  organizationRoot,
  source,
  slot,
  repositoryInventory,
  run,
}) {
  const path = normalizeOrganizationSlotPath(slot?.path);
  const remote = organizationSlotRepositoryRemote(slot, path);
  const branch = organizationSlotRepositoryBranch(slot, path);
  const coordinate = githubRepositoryCoordinate(remote);
  const sourceOfTruth = typeof slot?.source_of_truth === "string" ? slot.source_of_truth.trim() : "";
  const organizationLogin = source?.organization?.login;
  if (
    !path
    || path !== slot.path
    || path !== "mission-control/db"
    || organizationSlotScope(slot, path) !== "root"
    || !/^repository-db:[a-z0-9]+(?:[._-][a-z0-9]+)*$/u.test(sourceOfTruth)
    || typeof remote !== "string"
    || typeof branch !== "string"
    || !coordinate
    || coordinate.owner.toLowerCase() !== String(organizationLogin).toLowerCase()
    || coordinate.repository !== slot.slug
  ) {
    return providerFailure(
      "repository_db_manifest_invalid",
      "Aktivní repository-db mount nemá úplné a shodné Organization-owned path, remote, branch a repository-db souřadnice.",
    );
  }
  const targetPath = resolve(organizationRoot, path);
  const expectedTargetPath = resolve(rootPath, organizationPath, path);
  if (!isSamePath(targetPath, expectedTargetPath)) {
    return providerFailure("repository_db_path_forbidden", "Repository-db target neleží v deklarovaném Organization rootu.");
  }
  const parentSlotPath = posix.dirname(path);
  const parentSlots = (Array.isArray(repositoryInventory) ? repositoryInventory : [])
    .filter((candidate) => normalizeOrganizationSlotPath(candidate?.path) === parentSlotPath);
  const parentSlot = parentSlots.length === 1 ? parentSlots[0] : null;
  if (
    !parentSlot
    || parentSlot.path !== parentSlotPath
    || parentSlot.status !== "active"
    || parentSlot.materialization !== "doctor_managed_nested_repo"
    || organizationSlotScope(parentSlot, parentSlotPath) !== "root"
  ) {
    return providerFailure(
      "repository_db_parent_invalid",
      "Repository-db mount nemá právě jeden aktivní deklarovaný a installer-managed parent repozitář.",
    );
  }
  const parentPath = dirname(targetPath);
  const expectedParentPath = resolve(rootPath, organizationPath, parentSlotPath);
  if (!isSamePath(parentPath, expectedParentPath)) {
    return providerFailure("repository_db_parent_forbidden", "Parent repository-db mountu neleží v deklarovaném Organization rootu.");
  }
  const parent = await lstatOrNull(parentPath);
  if (!parent?.isDirectory() || parent.isSymbolicLink()) {
    return providerFailure(
      "repository_db_parent_missing",
      "Repository-db parent repozitář ještě není bezpečně materializovaný.",
    );
  }
  const [parentRoot, ignore, ref] = await Promise.all([
    run(["rev-parse", "--show-toplevel"], {
      cwd: parentPath,
      timeoutMs: GIT_LOCAL_TIMEOUT_MS,
    }),
    run(["check-ignore", "--quiet", "--no-index", "--", `${posix.basename(path)}/`], {
      cwd: parentPath,
      timeoutMs: GIT_LOCAL_TIMEOUT_MS,
    }),
    run(["check-ref-format", "--branch", branch], {
      cwd: organizationRoot,
      timeoutMs: GIT_LOCAL_TIMEOUT_MS,
    }),
  ]);
  if (!parentRoot.ok) {
    return providerFailure(
      "repository_db_parent_not_repository",
      "Repository-db parent není ověřitelný Git checkout.",
    );
  }
  let parentRealPath;
  let parentRootRealPath;
  try {
    [parentRealPath, parentRootRealPath] = await Promise.all([
      realpath(parentPath),
      realpath(parentRoot.stdout),
    ]);
  } catch {
    return providerFailure(
      "repository_db_parent_unverifiable",
      "Repository-db parent nemá ověřitelnou kanonickou cestu.",
    );
  }
  if (!isSamePath(parentRealPath, parentRootRealPath)) {
    return providerFailure(
      "repository_db_parent_not_repository",
      "Repository-db parent není kořenem deklarovaného Git checkoutu.",
    );
  }
  if (!ignore.ok) {
    return providerFailure("repository_db_target_not_ignored", "Repository-db target není gitignored ve svém parent repozitáři.");
  }
  if (!ref.ok) {
    return providerFailure("repository_db_branch_invalid", "Repository-db manifest deklaruje neplatnou Git branch.");
  }
  return { ok: true, targetPath, remote, branch, parentRealPath };
}

async function verifyExistingRepositoryDbCheckout({ targetPath, remote, branch, run }) {
  const entry = await lstatOrNull(targetPath);
  if (!entry?.isDirectory() || entry.isSymbolicLink()) {
    return providerFailure("repository_db_target_unsafe", "Existující repository-db target není skutečná lokální složka.");
  }
  const [root, currentBranch, origin, head, status] = await Promise.all([
    run(["rev-parse", "--show-toplevel"], { cwd: targetPath, timeoutMs: GIT_LOCAL_TIMEOUT_MS }),
    run(["branch", "--show-current"], { cwd: targetPath, timeoutMs: GIT_LOCAL_TIMEOUT_MS }),
    run(["remote", "get-url", "origin"], { cwd: targetPath, timeoutMs: GIT_LOCAL_TIMEOUT_MS }),
    run(["rev-parse", "--verify", "HEAD^{commit}"], { cwd: targetPath, timeoutMs: GIT_LOCAL_TIMEOUT_MS }),
    run(["status", "--porcelain=v1", "--untracked-files=all"], { cwd: targetPath, timeoutMs: GIT_LOCAL_TIMEOUT_MS }),
  ]);
  if ([root, currentBranch, origin, head, status].some((result) => !result.ok)) {
    return providerFailure("repository_db_git_unverifiable", "Existující repository-db checkout nejde bezpečně ověřit.");
  }
  let realRoot;
  let realTarget;
  try {
    [realRoot, realTarget] = await Promise.all([realpath(root.stdout), realpath(targetPath)]);
  } catch {
    return providerFailure("repository_db_path_unverifiable", "Repository-db checkout nemá ověřitelnou kanonickou cestu.");
  }
  if (
    !isSamePath(realRoot, realTarget)
    || currentBranch.stdout !== branch
    || origin.stdout !== remote
    || status.stdout !== ""
    || !/^[0-9a-f]{40}$/u.test(head.stdout)
  ) {
    return providerFailure(
      "repository_db_identity_mismatch",
      "Existující repository-db checkout neodpovídá přesnému remote, branchi nebo čistému HEADu; zůstal nedotčený.",
    );
  }
  return { ok: true, head: head.stdout };
}

function repositoryDbResultIdentity({ source, organizationPath, slot }) {
  const organization = source?.documents?.company?.company?.slug ?? source?.organization?.login ?? null;
  return {
    repo_key: `${organization}::${slot?.slug ?? "repository-db"}`,
    repo_kind: "root_repo",
    organization,
    module: slot?.slug ?? null,
    path: `${organizationPath}/${slot?.path ?? "repository-db"}`,
  };
}

function repositoryDbBlockedResult({ source, organizationPath, slot = null, reason, message }) {
  return {
    ...repositoryDbResultIdentity({ source, organizationPath, slot }),
    state: "blocked",
    reason,
    message,
  };
}

function appendConvergenceResults(convergence, additions) {
  if (!Array.isArray(additions) || additions.length === 0) return convergence;
  const results = [...(convergence.results ?? []), ...additions];
  const state = results.some((result) => result.state === "blocked")
    ? "blocked"
    : results.some((result) => result.state === "updated")
      ? "updated"
      : "current";
  const firstBlocked = results.find((result) => result.state === "blocked") ?? null;
  return {
    ...convergence,
    state,
    ok: state !== "blocked",
    message: state === "blocked"
      ? firstBlocked?.message ?? "Část Organization instalace potřebuje pomoc."
      : state === "updated"
        ? "Lazurio Organization je aktualizovaná."
        : "Lazurio Organization je aktuální.",
    summary: {
      current: results.filter((result) => result.state === "current").length,
      updated: results.filter((result) => result.state === "updated").length,
      blocked: results.filter((result) => result.state === "blocked").length,
    },
    results,
    next_action: firstBlocked
      ? {
          kind: firstBlocked.reason === "materialization_source_unavailable" ? "github_access" : "codex",
          label: firstBlocked.reason === "materialization_source_unavailable"
            ? "Ověřit přístup na GitHub"
            : "Vyřešit s Codexem",
          prompt: null,
        }
      : null,
  };
}

export function observeOrganizationInstallSource({
  githubLogin,
  expectedOrganizationId = null,
  platform = process.platform,
  environment = process.env,
  resolveGitHubCli = resolveTrustedGitHubCliExecutable,
  runGitHubCli = runTrustedGitHubCliSync,
} = {}) {
  const locator = normalizeGitHubLogin(githubLogin);
  const expectedId = normalizeOptionalOrganizationId(expectedOrganizationId);
  const provider = createTrustedGitHubProvider({
    platform,
    environment,
    resolveExecutable: resolveGitHubCli,
    runCommand: runGitHubCli,
  });
  if (!provider.available) return providerFailure("github_cli_unavailable", "GitHub CLI nebylo nalezeno.");
  const authentication = provider.command(
    ["auth", "status", "--hostname", "github.com", "--active"],
    { json: false },
  );
  if (!authentication.ok) return providerFailure("github_auth_required", "GitHub CLI vyžaduje přihlášení.");

  const organizationResponse = provider.json(["api", `orgs/${locator}`]);
  if (!organizationResponse.ok) return responseFailure(organizationResponse, "organization_not_found");
  const organization = providerIdentity(organizationResponse.value, "GitHub Organization");
  if (!organization || organization.login.toLowerCase() !== locator.toLowerCase()) {
    return providerFailure("organization_identity_mismatch", "GitHub Organization locator změnil identitu během ověření.");
  }
  if (expectedId !== null && organization.id !== expectedId) {
    return providerFailure(
      "organization_identity_mismatch",
      "GitHub Organization login už neodpovídá očekávané immutable identitě.",
    );
  }

  const repositoryName = `${organization.login}_GEN3`;
  const fullName = `${organization.login}/${repositoryName}`;
  const repositoryResponse = provider.json(["api", `repos/${fullName}`]);
  if (!repositoryResponse.ok) return responseFailure(repositoryResponse, "root_repository_unavailable");
  const repository = providerRepository(repositoryResponse.value, { organization, repositoryName, fullName });
  if (!repository) return providerFailure("root_repository_identity_mismatch", "Root repo neodpovídá kanonické Organization identitě.");

  const documents = readProviderRootDocuments({ provider, repository });
  if (!documents.ok) return documents;
  const rootVerification = verifyOrganizationRootDocuments({ documents, organization, repository });
  if (!rootVerification.ok) return rootVerification;
  return freeze({ ok: true, organization, repository, documents });
}

export function observeOrganizationInstallIdentity({
  source,
  platform = process.platform,
  environment = process.env,
  resolveGitHubCli = resolveTrustedGitHubCliExecutable,
  runGitHubCli = runTrustedGitHubCliSync,
} = {}) {
  const provider = createTrustedGitHubProvider({
    platform,
    environment,
    resolveExecutable: resolveGitHubCli,
    runCommand: runGitHubCli,
  });
  if (!provider.available) return providerFailure("github_cli_unavailable", "GitHub CLI nebylo nalezeno.");
  const organizationResponse = provider.json(["api", `orgs/${source.organization.login}`]);
  if (!organizationResponse.ok) return responseFailure(organizationResponse, "organization_identity_unavailable");
  const organization = providerIdentity(organizationResponse.value, "GitHub Organization");
  const repositoryResponse = provider.json(["api", `repositories/${source.repository.id}`]);
  if (!repositoryResponse.ok) return responseFailure(repositoryResponse, "root_repository_identity_unavailable");
  const repository = repositoryResponse.value;
  if (
    !organization
    || organization.id !== source.organization.id
    || organization.login !== source.organization.login
    || String(repository?.id ?? "") !== source.repository.id
    || repository?.full_name !== source.repository.full_name
    || String(repository?.owner?.id ?? "") !== source.organization.id
  ) {
    return providerFailure("provider_identity_changed", "GitHub Organization nebo root repo změnily identitu během instalace.");
  }
  return { ok: true };
}

export async function verifyOrganizationRootCheckout({ path, source, run = runGit } = {}) {
  const [root, branch, origin, head, status] = await Promise.all([
    run(["rev-parse", "--show-toplevel"], { cwd: path, timeoutMs: GIT_LOCAL_TIMEOUT_MS }),
    run(["branch", "--show-current"], { cwd: path, timeoutMs: GIT_LOCAL_TIMEOUT_MS }),
    run(["remote", "get-url", "origin"], { cwd: path, timeoutMs: GIT_LOCAL_TIMEOUT_MS }),
    run(["rev-parse", "--verify", "HEAD^{commit}"], { cwd: path, timeoutMs: GIT_LOCAL_TIMEOUT_MS }),
    run(["status", "--porcelain=v1", "--untracked-files=all"], { cwd: path, timeoutMs: GIT_LOCAL_TIMEOUT_MS }),
  ]);
  if ([root, branch, origin, head, status].some((result) => !result.ok)) {
    return providerFailure("root_git_unverifiable", "Lokální Organization root nejde bezpečně ověřit.");
  }
  let realRoot;
  let realPath;
  try {
    [realRoot, realPath] = await Promise.all([realpath(root.stdout), realpath(path)]);
  } catch {
    return providerFailure("root_path_unverifiable", "Lokální Organization root nemá ověřitelnou kanonickou cestu.");
  }
  if (!isSamePath(realRoot, realPath) || branch.stdout !== source.repository.default_branch) {
    return providerFailure("root_git_identity_mismatch", "Lokální Organization root není přesný main checkout očekávaného repa.");
  }
  if (status.stdout !== "") {
    return providerFailure("root_local_changes", "Lokální Organization root obsahuje změny; Organization install je nepřepisuje.");
  }
  const expectedCoordinate = githubRepositoryCoordinate(source.repository.read_url);
  const actualCoordinate = githubRepositoryCoordinate(origin.stdout);
  if (
    !expectedCoordinate
    || !actualCoordinate
    || actualCoordinate.ownerRepo.toLowerCase() !== expectedCoordinate.ownerRepo.toLowerCase()
  ) {
    return providerFailure("root_git_identity_mismatch", "Lokální Organization root používá jiný GitHub origin.");
  }
  if (!/^[0-9a-f]{40}$/u.test(head.stdout)) {
    return providerFailure("root_git_unverifiable", "Lokální Organization root nemá ověřitelný HEAD.");
  }

  const documents = await readLocalRootDocuments(path);
  if (!documents.ok) return documents;
  return verifyOrganizationRootDocuments({
    documents,
    organization: source.organization,
    repository: source.repository,
  });
}

export function isValidOrganizationInstallReport(report) {
  return Boolean(
    report
    && report.schema_version === ORGANIZATION_INSTALL_REPORT_SCHEMA
    && ORGANIZATION_INSTALL_STATES.includes(report.state)
    && report.ok === (report.state !== "blocked")
    && typeof report.root === "string"
    && report.organization
    && typeof report.organization.locator === "string"
    && report.target
    && ORGANIZATION_INSTALL_STATES.includes(report.target.state)
    && typeof report.target.reason === "string"
    && typeof report.target.path === "string"
    && (report.state === "blocked" || report.convergence?.schema_version === "lazurio.update.v1")
  );
}

export function organizationInstallExitCode(report) {
  return isValidOrganizationInstallReport(report) && report.state !== "blocked" ? 0 : 1;
}

export function renderHumanOrganizationInstall(report) {
  const lines = [
    `Lazurio Organization install: ${report.state}`,
    `Organization: ${report.organization.login ?? report.organization.locator}${report.organization.id ? ` · ID ${report.organization.id}` : ""}`,
    `Root: ${report.target.state} — ${report.target.reason} (${report.target.path})`,
  ];
  if (report.target.message) lines.push(`  ${report.target.message}`);
  for (const result of report.convergence?.results ?? []) {
    const symbol = result.state === "blocked" ? "!" : result.state === "updated" ? "✓" : "·";
    lines.push(`${symbol} ${result.path}: ${result.state} — ${result.message}`);
  }
  for (const warning of report.convergence?.warnings ?? []) lines.push(`! ${warning}`);
  return lines.join("\n");
}

async function reobserveSourceIdentity({ source, platform, environment, deps, reobserve }) {
  return reobserve({
    source,
    platform,
    environment,
    resolveGitHubCli: deps.resolveGitHubCli,
    runGitHubCli: deps.runGitHubCli,
  });
}

async function verifyInstallRootBoundary(rootPath) {
  const organizationsPath = join(rootPath, "organizations");
  try {
    const [root, organizations] = await Promise.all([
      lstat(rootPath),
      lstat(organizationsPath),
    ]);
    if (
      root.isSymbolicLink()
      || !root.isDirectory()
      || organizations.isSymbolicLink()
      || !organizations.isDirectory()
    ) {
      return providerFailure(
        "lazurio_root_unsafe",
        "Lazurio Root a jeho organizations/ musí být skutečné lokální složky, ne symlinky nebo junction aliasy.",
      );
    }
    return { ok: true };
  } catch {
    return providerFailure(
      "lazurio_root_not_ready",
      "Lazurio Root není připravený; nejdřív dokonči `lazurio install`.",
    );
  }
}

async function caseFoldedOrganizationTarget({ organizationsPath, targetName, readDirectory }) {
  const foldedTarget = targetName.toLocaleLowerCase("en-US");
  const entries = await readDirectory(organizationsPath);
  return entries.find((entry) => (
    entry !== targetName && entry.toLocaleLowerCase("en-US") === foldedTarget
  )) ?? null;
}

function readProviderRootDocuments({ provider, repository }) {
  const company = readProviderJson(provider, repository.full_name, "company.gen3.json", repository.default_branch);
  if (!company.ok) return company;
  const modules = readProviderJson(provider, repository.full_name, "modules.manifest.json", repository.default_branch);
  if (!modules.ok) return modules;
  const canonical = readProviderJson(
    provider,
    repository.full_name,
    "lazurio.organization.json",
    repository.default_branch,
    { optional: true },
  );
  if (!canonical.ok) return canonical;
  return { ok: true, company: company.value, modules: modules.value, canonical: canonical.value };
}

function readProviderJson(provider, fullName, path, ref, { optional = false } = {}) {
  const document = readGitHubRepositoryJsonDocument({
    invoke: (args) => provider.json(args),
    fullName,
    path,
    ref,
  });
  if (optional && !document.present) return { ok: true, value: null };
  if (!document.ok || !document.present) return responseFailure(document, "root_manifest_unavailable");
  if (!document.valid) {
    return providerFailure("root_manifest_invalid", `${path} nemá podporovaný GitHub content formát.`);
  }
  return { ok: true, value: document.value };
}

async function readLocalRootDocuments(path) {
  try {
    return { ok: true, resolution: readOrganizationRoot({ organizationRoot: path }) };
  } catch {
    return providerFailure("root_manifest_invalid", "Lokální Organization root nemá validní manifesty.");
  }
}

function verifyOrganizationRootDocuments({ documents, organization, repository }) {
  const resolution = documents.resolution ?? resolveOrganizationRootDocuments({
    companyManifest: documents.company,
    modulesManifest: documents.modules,
    canonicalManifest: documents.canonical,
    expectedOrganizationId: organization.id,
    expectedOrganizationLogin: organization.login,
    expectedRepositoryId: repository.id,
    expectedRepositoryFullName: repository.full_name,
    activationFormats: ["legacy", "transition"],
  });
  const identity = resolution.resource;
  const bindingSupported = identity?.organization?.forge_binding?.binding_state === "verified"
    && identity?.root_repository?.binding_state === "verified"
    && isValidOrganizationForgeBinding({
      schema_version: "lazurio.forge-binding.github.v0",
      provider: "github",
      organization: {
        id: identity.organization.forge_binding.organization_id,
        asserted_login: identity.organization.forge_binding.locator,
      },
      repository: {
        id: identity.root_repository.repository_id,
        asserted_full_name: identity.root_repository.locator,
        default_branch: identity.root_repository.default_branch,
      },
    }, {
      organizationId: organization.id,
      organizationLogin: organization.login,
      repositoryId: repository.id,
      repositoryFullName: repository.full_name,
    });
  const compatibleState = ["legacy", "transition"].includes(resolution.state);
  const resolverSupported = documents.resolution
    ? compatibleState
    : resolution.activation.status === "supported";
  if (!resolverSupported || !bindingSupported) {
    return providerFailure(
      "root_manifest_identity_mismatch",
      "Organization root manifesty neodpovídají immutable GitHub Organization a repository identitě.",
    );
  }
  return { ok: true, company: documents.company, modules: documents.modules };
}

function organizationInventoryDescriptor({ source, organizationPath }) {
  return {
    slug: source.documents.company.company.slug,
    display_name: source.documents.company.company.display_name,
    path: organizationPath,
    status: "active",
    default_branch: source.repository.default_branch,
    repository: source.repository.read_url,
  };
}

function organizationIdentity(source, locator) {
  return {
    locator,
    id: source?.organization?.id ?? null,
    login: source?.organization?.login ?? null,
    repository_id: source?.repository?.id ?? null,
    repository: source?.repository?.full_name ?? null,
  };
}

function blockedReport({ rootPath, locator, source = null, root = null }) {
  const target = root ?? rootOutcome(
    "blocked",
    source?.code ?? "provider_observation_failed",
    `organizations/${source?.organization?.login ?? locator}_GEN3`,
    source?.message,
  );
  return freeze({
    schema_version: ORGANIZATION_INSTALL_REPORT_SCHEMA,
    state: "blocked",
    ok: false,
    root: rootPath,
    organization: organizationIdentity(source, locator),
    target,
    convergence: null,
  });
}

function rootOutcome(state, reason, path, message = null) {
  return { state, reason, path, message };
}

function providerIdentity(value, label) {
  const id = String(value?.id ?? "");
  const login = typeof value?.login === "string" ? value.login.trim() : "";
  if (!/^[1-9][0-9]{0,19}$/u.test(id) || !githubLoginPattern.test(login)) return null;
  return { id, login, label };
}

function providerRepository(value, { organization, repositoryName, fullName }) {
  const id = String(value?.id ?? "");
  const sshUrl = typeof value?.ssh_url === "string" ? value.ssh_url.trim() : "";
  const cloneUrl = typeof value?.clone_url === "string" ? value.clone_url.trim() : "";
  const isPrivate = value?.private;
  const readUrl = isPrivate === false ? cloneUrl : sshUrl;
  if (
    !/^[1-9][0-9]{0,19}$/u.test(id)
    || value?.name !== repositoryName
    || value?.full_name !== fullName
    || value?.default_branch !== "main"
    || String(value?.owner?.id ?? "") !== organization.id
    || value?.owner?.login !== organization.login
    || typeof isPrivate !== "boolean"
    || githubRepositoryCoordinate(readUrl)?.ownerRepo.toLowerCase() !== fullName.toLowerCase()
  ) return null;
  return {
    id,
    name: repositoryName,
    full_name: fullName,
    default_branch: "main",
    private: isPrivate,
    clone_url: cloneUrl,
    ssh_url: sshUrl,
    read_url: readUrl,
  };
}

function responseFailure(response, fallbackCode) {
  if (response?.httpStatus === 401) return providerFailure("github_auth_required", "GitHub CLI vyžaduje přihlášení.");
  if (response?.httpStatus === 404) return providerFailure(fallbackCode, "GitHub resource není dostupný.");
  if (response?.httpStatus === 403) return providerFailure("github_access_denied", "GitHub přístup nestačí ke čtení Organization rootu.");
  return providerFailure("github_transport_failed", response?.error?.message ?? "GitHub provider selhal.");
}

function providerFailure(code, message) {
  return { ok: false, code, message };
}

function normalizeGitHubLogin(value) {
  const login = typeof value === "string" ? value.trim() : "";
  if (!githubLoginPattern.test(login)) throw new TypeError("Organization install vyžaduje validní GitHub Organization login.");
  return login;
}

function normalizeOptionalOrganizationId(value) {
  if (value === null || value === undefined) return null;
  const id = String(value).trim();
  if (!/^[1-9][0-9]{0,19}$/u.test(id)) {
    throw new TypeError("Organization install expected immutable GitHub Organization ID must be positive.");
  }
  return id;
}

async function readJson(path, { optional = false } = {}) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (optional && error?.code === "ENOENT") return null;
    throw error;
  }
}

async function lstatOrNull(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function freeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freeze(child);
  return Object.freeze(value);
}
