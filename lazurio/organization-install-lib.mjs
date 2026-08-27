import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";

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
import { isValidOrganizationForgeBinding } from "./core/organization-scaffold-lib.mjs";
import { githubRepositoryCoordinate } from "./core/organization-slot-scope-lib.mjs";
import { isSamePath } from "./core/path-boundary-lib.mjs";
import { runIsolatedLazurioUpdate } from "../launchpad/src/lazurio-update-runner-lib.mjs";
import {
  runGit,
  runGitInPinnedTemporaryChild,
  safeGitRemoteEnv,
} from "../launchpad/src/git-lib.mjs";

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
  const convergence = await runUpdate({ rootPath: absoluteRoot, organizations: [organization] });
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
    const [company, modules, canonical] = await Promise.all([
      readJson(join(path, "company.gen3.json")),
      readJson(join(path, "modules.manifest.json")),
      readJson(join(path, "lazurio.organization.json"), { optional: true }),
    ]);
    return { ok: true, company, modules, canonical };
  } catch {
    return providerFailure("root_manifest_invalid", "Lokální Organization root nemá validní manifesty.");
  }
}

function verifyOrganizationRootDocuments({ documents, organization, repository }) {
  const resolver = resolveOrganizationRootDocuments({
    companyManifest: documents.company,
    modulesManifest: documents.modules,
    canonicalManifest: documents.canonical,
    expectedOrganizationId: organization.id,
    expectedOrganizationLogin: organization.login,
    expectedRepositoryId: repository.id,
    expectedRepositoryFullName: repository.full_name,
  });
  const forgeBinding = documents.company?.forge_binding;
  if (
    resolver.status !== "supported"
    || !isValidOrganizationForgeBinding(forgeBinding, {
      organizationId: organization.id,
      organizationLogin: organization.login,
      repositoryId: repository.id,
      repositoryFullName: repository.full_name,
    })
  ) {
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
