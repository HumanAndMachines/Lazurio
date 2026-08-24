import { spawnSync } from "node:child_process";

import {
  createOrganizationActivationRequest,
  organizationActivationError,
  organizationActivationExitCode,
  resolveOrganizationActivation,
  resolveOrganizationRootDocuments,
} from "./core/organization-activation-lib.mjs";
import { resolveTrustedGitHubCliExecutable } from "./core/cli-provenance-lib.mjs";

export const LAZURIO_GITHUB_APP_SLUG = "lazurio-for-github";

const invalidRepositoryDocument = Object.freeze({ invalid: true });

const identityQuery = `query($login:String!){
  viewer { databaseId login }
  organization(login:$login) {
    databaseId
    login
    viewerCanAdminister
    viewerCanCreateRepositories
  }
}`;

export function checkOrganizationActivation({
  githubOrganizationId,
  appSlug = LAZURIO_GITHUB_APP_SLUG,
  platform = process.platform,
  environment = process.env,
  resolveGitHubCli = resolveTrustedGitHubCliExecutable,
  runGitHubCli = runGitHubCliSync,
} = {}) {
  const request = createOrganizationActivationRequest({ githubOrganizationId });
  const executable = resolveGitHubCli({ platform });
  if (!executable) {
    return organizationActivationError({
      request,
      code: "github_cli_unavailable",
      retryable: false,
      nextAction: "install_github_cli",
    });
  }

  try {
    assertGitHubAuthenticated({
      executable,
      platform,
      environment,
      runGitHubCli,
    });
    const observations = collectObservations({
      request,
      appSlug,
      executable,
      platform,
      environment,
      runGitHubCli,
    });
    return resolveOrganizationActivation({ request, observations });
  } catch (error) {
    const known = error instanceof ActivationProbeError;
    return organizationActivationError({
      request,
      code: known ? error.code : "github_response_invalid",
      retryable: known ? error.retryable : true,
      nextAction: known ? error.nextAction : "retry",
    });
  }
}

function assertGitHubAuthenticated({ executable, platform, environment, runGitHubCli }) {
  let result;
  try {
    result = runGitHubCli({
      executable,
      args: ["auth", "status", "--hostname", "github.com", "--active"],
      environment: sanitizedGitHubEnvironment(environment, platform),
    });
  } catch {
    throw new ActivationProbeError("github_transport_failed", true, "retry");
  }
  if (result?.status !== 0) {
    throw new ActivationProbeError("github_auth_required", false, "authenticate_github");
  }
}

export function renderHumanOrganizationActivation(report) {
  if (report.execution.status === "error") {
    return [
      "Lazurio Organization activation check v0 · read-only",
      `Výsledek: technická chyba (${report.execution.error.code})`,
      `Opakovatelná: ${report.execution.error.retryable ? "ano" : "ne"}`,
      `Další krok: ${report.next_action.kind}`,
    ].join("\n");
  }

  const { github, github_app: app, root_repository: root } = report.observations;
  return [
    "Lazurio Organization activation check v0 · read-only",
    `Organization: ${github.organization.login} · ID ${github.organization.id}`,
    `GitHub účet: ${github.principal.login} · owner ${yesNo(github.organization.viewer_is_owner)} · může vytvořit repo ${yesNo(github.organization.viewer_can_create_repositories)}`,
    `Root repo: ${root.full_name} · ${root.presence} · resolver ${root.resolver.status}${root.resolver.format ? `/${root.resolver.format}` : ""}`,
    `Lazurio for GitHub: ${app.status}${app.repository_selection ? `/${app.repository_selection}` : ""} · root access ${app.root_access}`,
    `Výsledek: ${report.outcome} (${report.reasons.join(", ")})`,
    `Další krok: ${report.next_action.kind}`,
  ].join("\n");
}

export { organizationActivationExitCode };

function collectObservations({ request, appSlug, executable, platform, environment, runGitHubCli }) {
  const invoke = (args) => githubApi({
    executable,
    args,
    platform,
    environment,
    runGitHubCli,
  });

  const principalResponse = invoke(["api", "user"]);
  requireSuccess(principalResponse, {
    missingCode: "github_transport_failed",
    missingNextAction: "retry",
  });
  const principal = identity(principalResponse.value, "GitHub principal");

  const organizationResponse = invoke(["api", `organizations/${request.github_organization_id}`]);
  if (organizationResponse.httpStatus === 404) {
    throw new ActivationProbeError("github_organization_not_found", false, "verify_organization");
  }
  requireSuccess(organizationResponse, {
    missingCode: "github_transport_failed",
    missingNextAction: "verify_organization",
  });
  const organization = identity(organizationResponse.value, "GitHub Organization");

  const liveIdentity = invoke([
    "api",
    "graphql",
    "-f",
    `query=${identityQuery}`,
    "-f",
    `login=${organization.login}`,
  ]);
  requireSuccess(liveIdentity, {
    missingCode: "github_transport_failed",
    missingNextAction: "verify_organization",
  });
  const graph = liveIdentity.value?.data;
  if (
    String(graph?.viewer?.databaseId ?? "") !== principal.id
    || normalized(graph?.viewer?.login).toLowerCase() !== principal.login.toLowerCase()
    || String(graph?.organization?.databaseId ?? "") !== organization.id
    || normalized(graph?.organization?.login).toLowerCase() !== organization.login.toLowerCase()
  ) {
    throw new ActivationProbeError("github_identity_inconsistent", false, "verify_organization");
  }

  const membership = invoke(["api", `user/memberships/orgs/${organization.login}`]);
  if (!membership.ok && ![403, 404].includes(membership.httpStatus)) {
    requireSuccess(membership, {
      missingCode: "github_transport_failed",
      missingNextAction: "retry",
    });
  }
  const membershipIsOwner = membership.ok
    && membership.value?.state === "active"
    && membership.value?.role === "admin"
    && String(membership.value?.organization?.id ?? "") === organization.id;
  const viewerIsOwner = membershipIsOwner && graph.organization.viewerCanAdminister === true;
  const viewerCanCreateRepositories = graph.organization.viewerCanCreateRepositories === true;

  const rootRepository = inspectRootRepository({ invoke, organization });
  const githubApp = inspectGitHubApp({
    invoke,
    organization,
    appSlug,
    rootRepository,
  });

  return {
    github: {
      principal,
      organization: {
        id: organization.id,
        login: organization.login,
        viewer_is_owner: viewerIsOwner,
        viewer_can_create_repositories: viewerCanCreateRepositories,
      },
    },
    github_app: githubApp,
    root_repository: rootRepository,
  };
}

function inspectRootRepository({ invoke, organization }) {
  const name = `${organization.login}_GEN3`;
  const fullName = `${organization.login}/${name}`;
  const repositoryResponse = invoke(["api", `repos/${fullName}`]);
  if (repositoryResponse.httpStatus === 404) {
    const candidateFound = hasAlternativeRootCandidate({ invoke, organization, expectedName: name });
    return {
      presence: "absent",
      id: null,
      name,
      full_name: fullName,
      default_branch: null,
      viewer_can_push: null,
      candidate_count: candidateFound ? 1 : 0,
      resolver: candidateFound
        ? { status: "unsupported", format: null, reason: "canonical_root_candidate_conflict" }
        : { status: "not_applicable", format: null, reason: "root_repository_absent" },
    };
  }
  requireSuccess(repositoryResponse, {
    missingCode: "github_repository_inspection_failed",
    missingNextAction: "retry",
  });

  const repository = repositoryResponse.value;
  const repositoryId = positiveId(repository?.id, "GitHub repository");
  const repositoryName = normalized(repository?.name);
  const repositoryFullName = normalized(repository?.full_name);
  if (repositoryName.toLowerCase() !== name.toLowerCase() || repositoryFullName.toLowerCase() !== fullName.toLowerCase()) {
    return {
      presence: "absent",
      id: null,
      name,
      full_name: fullName,
      default_branch: null,
      viewer_can_push: null,
      candidate_count: 1,
      resolver: { status: "unsupported", format: null, reason: "canonical_root_candidate_conflict" },
    };
  }
  const viewerCanPush = repository?.permissions?.push === true || repository?.permissions?.admin === true;
  const defaultBranch = normalized(repository?.default_branch) || null;

  const commits = invoke(["api", `repos/${fullName}/commits?per_page=1`]);
  if (commits.httpStatus === 409) {
    return {
      presence: "empty",
      id: repositoryId,
      name,
      full_name: fullName,
      default_branch: defaultBranch,
      viewer_can_push: viewerCanPush,
      candidate_count: 0,
      resolver: { status: "not_applicable", format: null, reason: "root_repository_empty" },
    };
  }
  requireSuccess(commits, {
    missingCode: "github_repository_inspection_failed",
    missingNextAction: "retry",
  });
  if (!Array.isArray(commits.value) || commits.value.length === 0) {
    throw new ActivationProbeError("github_response_invalid", true, "retry");
  }

  const companyDocument = readRepositoryJson({ invoke, fullName, path: "company.gen3.json", ref: defaultBranch });
  const modulesDocument = readRepositoryJson({ invoke, fullName, path: "modules.manifest.json", ref: defaultBranch });
  const canonicalDocument = readRepositoryJson({ invoke, fullName, path: "lazurio.organization.json", ref: defaultBranch });
  const resolver = resolveOrganizationRootDocuments({
    companyManifest: companyDocument.value,
    modulesManifest: modulesDocument.value,
    canonicalManifest: canonicalDocument.present ? canonicalDocument.value : null,
    expectedOrganizationLogin: organization.login,
    expectedRepositoryFullName: fullName,
  });
  return {
    presence: "present",
    id: repositoryId,
    name,
    full_name: fullName,
    default_branch: defaultBranch,
    viewer_can_push: viewerCanPush,
    candidate_count: 0,
    resolver,
  };
}

function inspectGitHubApp({ invoke, organization, appSlug, rootRepository }) {
  let installation = null;
  for (let page = 1; ; page += 1) {
    const response = invoke([
      "api",
      `orgs/${organization.login}/installations?per_page=100&page=${page}`,
    ]);
    if (response.httpStatus === 403) {
      if (page === 1) return unavailableApp();
      throw new ActivationProbeError("github_transport_failed", true, "retry");
    }
    requireSuccess(response, {
      missingCode: "github_transport_failed",
      missingNextAction: "retry",
    });
    const installations = response.value?.installations;
    if (!Array.isArray(installations)) {
      throw new ActivationProbeError("github_response_invalid", true, "retry");
    }
    installation = installations.find((entry) => (
      normalized(entry?.app_slug).toLowerCase() === appSlug.toLowerCase()
      && String(entry?.target_id ?? "") === organization.id
      && entry?.target_type === "Organization"
    )) ?? null;
    if (installation || installations.length < 100) break;
  }
  if (!installation) {
    return {
      status: "missing",
      installation_id: null,
      repository_selection: null,
      root_access: "unverified",
    };
  }
  const installationId = positiveId(installation.id, "GitHub App installation");
  const selection = installation.repository_selection;
  if (selection !== "all" && selection !== "selected") {
    throw new ActivationProbeError("github_response_invalid", true, "retry");
  }
  if (selection === "all") {
    return {
      status: "installed",
      installation_id: installationId,
      repository_selection: "all",
      root_access: "included",
    };
  }
  if (rootRepository.presence === "absent") {
    return {
      status: "installed",
      installation_id: installationId,
      repository_selection: "selected",
      root_access: "not_applicable",
    };
  }

  const rootAccess = selectedRootAccess({ invoke, installationId, repositoryId: rootRepository.id });
  if (rootAccess === "unverified") {
    return {
      status: "installed",
      installation_id: installationId,
      repository_selection: "selected",
      root_access: "unverified",
    };
  }
  return {
    status: "installed",
    installation_id: installationId,
    repository_selection: "selected",
    root_access: rootAccess,
  };
}

function hasAlternativeRootCandidate({ invoke, organization, expectedName }) {
  for (let page = 1; ; page += 1) {
    const response = invoke([
      "api",
      `orgs/${organization.login}/repos?type=all&per_page=100&page=${page}`,
    ]);
    requireSuccess(response, {
      missingCode: "github_repository_inspection_failed",
      missingNextAction: "retry",
    });
    if (!Array.isArray(response.value)) {
      throw new ActivationProbeError("github_response_invalid", true, "retry");
    }
    if (response.value.some((entry) => (
      typeof entry?.name === "string"
      && /_GEN3$/iu.test(entry.name)
      && entry.name.toLowerCase() !== expectedName.toLowerCase()
    ))) return true;
    if (response.value.length < 100) return false;
  }
}

function selectedRootAccess({ invoke, installationId, repositoryId }) {
  for (let page = 1; ; page += 1) {
    const response = invoke([
      "api",
      `user/installations/${installationId}/repositories?per_page=100&page=${page}`,
    ]);
    if (response.httpStatus === 401 || response.httpStatus === 403) return "unverified";
    requireSuccess(response, {
      missingCode: "github_transport_failed",
      missingNextAction: "retry",
    });
    const repositories = response.value?.repositories;
    if (!Array.isArray(repositories)) {
      throw new ActivationProbeError("github_response_invalid", true, "retry");
    }
    if (repositories.some((entry) => String(entry?.id ?? "") === repositoryId)) return "included";
    if (repositories.length < 100) return "missing";
  }
}

function readRepositoryJson({ invoke, fullName, path, ref }) {
  const suffix = ref ? `?ref=${encodeURIComponent(ref)}` : "";
  const response = invoke(["api", `repos/${fullName}/contents/${path}${suffix}`]);
  if (response.httpStatus === 404) return { present: false, value: null };
  requireSuccess(response, {
    missingCode: "github_repository_inspection_failed",
    missingNextAction: "retry",
  });
  if (response.value?.encoding !== "base64" || typeof response.value?.content !== "string") {
    return { present: true, value: invalidRepositoryDocument };
  }
  try {
    const value = JSON.parse(Buffer.from(response.value.content.replace(/\s/gu, ""), "base64").toString("utf8"));
    return { present: true, value: value ?? invalidRepositoryDocument };
  } catch {
    return { present: true, value: invalidRepositoryDocument };
  }
}

function githubApi({ executable, args, platform, environment, runGitHubCli }) {
  let result;
  try {
    result = runGitHubCli({
      executable,
      args,
      environment: sanitizedGitHubEnvironment(environment, platform),
    });
  } catch {
    throw new ActivationProbeError("github_transport_failed", true, "retry");
  }
  const status = Number.isInteger(result?.status) ? result.status : 1;
  const stdout = String(result?.stdout ?? "");
  const stderr = String(result?.stderr ?? "");
  let value = null;
  if (stdout.trim() !== "") {
    try {
      value = JSON.parse(stdout);
    } catch {
      if (status === 0) throw new ActivationProbeError("github_response_invalid", true, "retry");
    }
  }
  const stderrHttpStatus = stderr.match(/(?:\(|\b)HTTP\s+([1-5][0-9]{2})(?:\)|\b)/u)?.[1];
  const httpStatus = Number(value?.status ?? stderrHttpStatus ?? 0) || null;
  return { ok: status === 0, status, httpStatus, value };
}

function runGitHubCliSync({ executable, args, environment }) {
  const result = spawnSync(executable, args, {
    env: environment,
    encoding: "utf8",
    shell: false,
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
  return {
    status: result.status,
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? result.error?.message ?? ""),
  };
}

function sanitizedGitHubEnvironment(environment, platform) {
  const result = {};
  for (const key of [
    "PATH",
    "HOME",
    "XDG_CONFIG_HOME",
    "GH_CONFIG_DIR",
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "APPDATA",
    "LOCALAPPDATA",
    "USERPROFILE",
    "TMPDIR",
    "TEMP",
    "TMP",
    "SystemRoot",
    "ComSpec",
    "PATHEXT",
  ]) {
    if (typeof environment[key] === "string") result[key] = environment[key];
  }
  result.GH_HOST = "github.com";
  result.GH_PAGER = "cat";
  result.NO_COLOR = "1";
  result.LC_ALL = "C";
  return result;
}

function requireSuccess(response, { missingCode, missingNextAction }) {
  if (response.ok) return;
  if (response.httpStatus === 401) {
    throw new ActivationProbeError("github_auth_required", false, "authenticate_github");
  }
  if (response.httpStatus === 403) {
    throw new ActivationProbeError("github_access_denied", false, missingNextAction);
  }
  if (response.httpStatus === 404 && missingCode === "github_organization_not_found") {
    throw new ActivationProbeError(missingCode, false, missingNextAction);
  }
  throw new ActivationProbeError(missingCode, true, missingNextAction);
}

function identity(value, label) {
  return {
    id: positiveId(value?.id, label),
    login: requiredText(value?.login, label),
  };
}

function positiveId(value, label) {
  const id = String(value ?? "");
  if (!/^[1-9][0-9]{0,19}$/u.test(id)) {
    throw new ActivationProbeError("github_response_invalid", true, "retry", `${label} ID invalid`);
  }
  return id;
}

function requiredText(value, label) {
  const text = normalized(value);
  if (!text) throw new ActivationProbeError("github_response_invalid", true, "retry", `${label} missing`);
  return text;
}

function normalized(value) {
  return typeof value === "string" ? value.trim() : "";
}

function unavailableApp() {
  return {
    status: "unobservable",
    installation_id: null,
    repository_selection: null,
    root_access: "unverified",
  };
}

function yesNo(value) {
  return value ? "ano" : "ne";
}

class ActivationProbeError extends Error {
  constructor(code, retryable, nextAction, message = code) {
    super(message);
    this.code = code;
    this.retryable = retryable;
    this.nextAction = nextAction;
  }
}
