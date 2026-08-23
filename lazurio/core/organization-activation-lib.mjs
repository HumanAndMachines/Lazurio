export const ORGANIZATION_ACTIVATION_CONTRACT_VERSION = "lazurio.organization.activation.v0";
export const ORGANIZATION_ACTIVATION_REQUEST_SCHEMA = "lazurio.organization.activation.request.v0";
export const ORGANIZATION_ACTIVATION_REPORT_SCHEMA = "lazurio.organization.activation.report.v0";

export const ORGANIZATION_ACTIVATION_OUTCOMES = Object.freeze([
  "needs_activation",
  "active",
  "action_required",
]);

export const ORGANIZATION_ACTIVATION_NEXT_ACTIONS = Object.freeze([
  "none",
  "run_activation",
  "install_github_cli",
  "authenticate_github",
  "retry",
  "verify_organization",
  "request_organization_owner",
  "allow_repository_creation",
  "install_github_app",
  "refresh_github_permissions",
  "grant_root_repository",
  "verify_root_repository_access",
  "inspect_existing_repository",
]);

export const ORGANIZATION_ACTIVATION_REASON_CODES = Object.freeze([
  "root_repository_absent",
  "root_repository_empty",
  "root_supported_legacy",
  "root_supported_current",
  "root_supported_transition",
  "github_organization_owner_required",
  "github_repository_creation_required",
  "github_repository_push_required",
  "github_app_installation_required",
  "github_app_scope_unavailable",
  "github_app_root_access_required",
  "github_app_root_access_unverified",
  "root_repository_conflict",
  "root_manifest_unsupported",
]);

export const ORGANIZATION_ACTIVATION_ERROR_CODES = Object.freeze([
  "github_cli_unavailable",
  "github_auth_required",
  "github_transport_failed",
  "github_access_denied",
  "github_organization_not_found",
  "github_identity_inconsistent",
  "github_repository_inspection_failed",
  "github_response_invalid",
]);

const organizationIdPattern = /^[1-9][0-9]{0,19}$/u;
const supportedFormats = new Set(["legacy", "current", "transition"]);

export function createOrganizationActivationRequest({ githubOrganizationId }) {
  const id = String(githubOrganizationId ?? "").trim();
  if (!organizationIdPattern.test(id)) {
    throw new TypeError("Organization activation requires a positive immutable GitHub Organization ID.");
  }
  return freeze({
    schema_version: ORGANIZATION_ACTIVATION_REQUEST_SCHEMA,
    github_organization_id: id,
  });
}

export function resolveOrganizationActivation({ request, observations }) {
  if (!isValidOrganizationActivationRequest(request)) {
    throw new TypeError("Organization activation request is invalid.");
  }
  if (!isValidOrganizationActivationObservations(observations)) {
    throw new TypeError("Organization activation observations are invalid.");
  }
  if (request.github_organization_id !== observations.github.organization.id) {
    return organizationActivationError({
      request,
      code: "github_identity_inconsistent",
      retryable: false,
      nextAction: "verify_organization",
    });
  }

  const accessBlock = accessBlocker(observations);
  if (accessBlock) return okReport(request, observations, "action_required", accessBlock.reasons, accessBlock.nextAction);

  const root = observations.root_repository;
  if (root.candidate_count > 0) {
    return okReport(
      request,
      observations,
      "action_required",
      ["root_repository_conflict"],
      "inspect_existing_repository",
    );
  }
  if (root.presence === "absent") {
    if (!observations.github.organization.viewer_can_create_repositories) {
      return okReport(
        request,
        observations,
        "action_required",
        ["github_repository_creation_required"],
        "allow_repository_creation",
      );
    }
    return okReport(request, observations, "needs_activation", ["root_repository_absent"], "run_activation");
  }
  if (root.presence === "empty") {
    if (!root.viewer_can_push) {
      return okReport(
        request,
        observations,
        "action_required",
        ["github_repository_push_required"],
        "request_organization_owner",
      );
    }
    return okReport(request, observations, "needs_activation", ["root_repository_empty"], "run_activation");
  }
  if (root.resolver.status !== "supported") {
    const reason = root.resolver.reason === "canonical_root_candidate_conflict"
      ? "root_repository_conflict"
      : "root_manifest_unsupported";
    return okReport(request, observations, "action_required", [reason], "inspect_existing_repository");
  }

  const appAccessBlock = installedAppAccessBlocker(observations.github_app);
  if (appAccessBlock) {
    return okReport(
      request,
      observations,
      "action_required",
      [appAccessBlock.reason],
      appAccessBlock.nextAction,
    );
  }

  return okReport(
    request,
    observations,
    "active",
    [`root_supported_${root.resolver.format}`],
    "none",
  );
}

export function organizationActivationError({ request, code, retryable, nextAction }) {
  if (!isValidOrganizationActivationRequest(request)) {
    throw new TypeError("Organization activation request is invalid.");
  }
  if (!ORGANIZATION_ACTIVATION_ERROR_CODES.includes(code)) {
    throw new TypeError(`Unknown Organization activation error code '${code}'.`);
  }
  if (typeof retryable !== "boolean") {
    throw new TypeError("Organization activation error retryability must be a boolean.");
  }
  if (!ORGANIZATION_ACTIVATION_NEXT_ACTIONS.includes(nextAction)) {
    throw new TypeError(`Unknown Organization activation next action '${nextAction}'.`);
  }
  return freeze({
    schema_version: ORGANIZATION_ACTIVATION_REPORT_SCHEMA,
    contract_version: ORGANIZATION_ACTIVATION_CONTRACT_VERSION,
    request,
    execution: {
      status: "error",
      error: { code, retryable },
    },
    next_action: { kind: nextAction },
  });
}

export function organizationActivationExitCode(report) {
  if (report?.execution?.status === "error") return 2;
  return report?.outcome === "active" ? 0 : 1;
}

export function resolveOrganizationRootDocuments({
  companyManifest,
  modulesManifest,
  canonicalManifest,
  expectedOrganizationLogin,
  expectedRepositoryFullName,
}) {
  if (canonicalManifest !== null && canonicalManifest !== undefined) {
    return freeze({
      status: "unsupported",
      format: null,
      reason: "canonical_resolver_unavailable",
    });
  }
  if (!isRecord(companyManifest) || !isRecord(modulesManifest)) {
    return freeze({ status: "unsupported", format: null, reason: "legacy_manifest_pair_missing" });
  }

  const company = companyManifest.company;
  const organizationLogin = normalizedText(expectedOrganizationLogin);
  const repositoryFullName = normalizedText(expectedRepositoryFullName);
  const companyLogin = normalizedText(company?.github_org);
  const modulesLogin = normalizedText(modulesManifest.github_org);
  const companySlug = normalizedText(company?.slug);
  const modulesCompany = normalizedText(modulesManifest.company);
  const declaredRepository = normalizedText(company?.root_repository);
  const modulesGenerationSupported = modulesManifest.organization_generation === "gen3"
    || modulesManifest.schema_version === "companiesascode.modules.v1";
  const supported = companyManifest.organization_generation === "gen3"
    && (companyManifest.organization_kind ?? "organization") === "organization"
    && modulesGenerationSupported
    && Array.isArray(modulesManifest.module_slots)
    && companyLogin.toLowerCase() === organizationLogin.toLowerCase()
    && modulesLogin.toLowerCase() === organizationLogin.toLowerCase()
    && companySlug !== ""
    && companySlug === modulesCompany
    && (declaredRepository === "" || declaredRepository.toLowerCase() === repositoryFullName.toLowerCase());

  return freeze(supported
    ? { status: "supported", format: "legacy", reason: "legacy_identity_pair_supported" }
    : { status: "unsupported", format: null, reason: "legacy_identity_pair_invalid" });
}

export function isValidOrganizationActivationRequest(value) {
  return isRecord(value)
    && value.schema_version === ORGANIZATION_ACTIVATION_REQUEST_SCHEMA
    && organizationIdPattern.test(value.github_organization_id ?? "")
    && exactKeys(value, ["schema_version", "github_organization_id"]);
}

export function isValidOrganizationActivationObservations(value) {
  if (!isRecord(value) || !exactKeys(value, ["github", "github_app", "root_repository"])) return false;
  const github = value.github;
  const principal = github?.principal;
  const organization = github?.organization;
  const app = value.github_app;
  const root = value.root_repository;
  const resolver = root?.resolver;
  if (
    !isRecord(github)
    || !exactKeys(github, ["principal", "organization"])
    || !isIdentity(principal)
    || !isRecord(organization)
    || !exactKeys(organization, ["id", "login", "viewer_is_owner", "viewer_can_create_repositories"])
    || !organizationIdPattern.test(organization.id ?? "")
    || normalizedText(organization.login) === ""
    || typeof organization.viewer_is_owner !== "boolean"
    || typeof organization.viewer_can_create_repositories !== "boolean"
  ) return false;
  if (!isRecord(app) || !exactKeys(app, ["status", "installation_id", "repository_selection", "root_access"])) return false;
  if (!["installed", "missing", "unobservable"].includes(app.status)) return false;
  if (app.status === "installed") {
    if (!organizationIdPattern.test(app.installation_id ?? "")) return false;
    if (!["all", "selected"].includes(app.repository_selection)) return false;
    if (!["included", "missing", "unverified", "not_applicable"].includes(app.root_access)) return false;
    if (app.repository_selection === "all" && app.root_access !== "included") return false;
  } else if (app.installation_id !== null || app.repository_selection !== null || app.root_access !== "unverified") {
    return false;
  }
  if (!isRecord(root) || !exactKeys(root, ["presence", "id", "name", "full_name", "default_branch", "viewer_can_push", "candidate_count", "resolver"])) return false;
  if (!["absent", "empty", "present"].includes(root.presence)) return false;
  if (normalizedText(root.name) === "" || normalizedText(root.full_name) === "") return false;
  if (!Number.isSafeInteger(root.candidate_count) || root.candidate_count < 0) return false;
  if (root.presence === "absent") {
    if (root.id !== null || root.default_branch !== null || root.viewer_can_push !== null) return false;
  } else {
    if (!organizationIdPattern.test(root.id ?? "") || typeof root.viewer_can_push !== "boolean") return false;
    if (root.default_branch !== null && normalizedText(root.default_branch) === "") return false;
  }
  if (!isRecord(resolver) || !exactKeys(resolver, ["status", "format", "reason"])) return false;
  if (!["not_applicable", "supported", "unsupported"].includes(resolver.status)) return false;
  if (normalizedText(resolver.reason) === "") return false;
  if (resolver.status === "supported") return supportedFormats.has(resolver.format);
  return resolver.format === null;
}

export function isValidOrganizationActivationReport(value) {
  if (!isRecord(value)) return false;
  if (
    value.schema_version !== ORGANIZATION_ACTIVATION_REPORT_SCHEMA
    || value.contract_version !== ORGANIZATION_ACTIVATION_CONTRACT_VERSION
    || !isValidOrganizationActivationRequest(value.request)
    || !isRecord(value.execution)
    || !isRecord(value.next_action)
    || !ORGANIZATION_ACTIVATION_NEXT_ACTIONS.includes(value.next_action.kind)
    || !exactKeys(value.next_action, ["kind"])
  ) return false;
  if (value.execution.status === "error") {
    return exactKeys(value, ["schema_version", "contract_version", "request", "execution", "next_action"])
      && exactKeys(value.execution, ["status", "error"])
      && isRecord(value.execution.error)
      && exactKeys(value.execution.error, ["code", "retryable"])
      && ORGANIZATION_ACTIVATION_ERROR_CODES.includes(value.execution.error.code)
      && typeof value.execution.error.retryable === "boolean";
  }
  return value.execution.status === "ok"
    && exactKeys(value.execution, ["status"])
    && exactKeys(value, ["schema_version", "contract_version", "request", "execution", "outcome", "reasons", "next_action", "observations"])
    && ORGANIZATION_ACTIVATION_OUTCOMES.includes(value.outcome)
    && Array.isArray(value.reasons)
    && value.reasons.length > 0
    && value.reasons.every((reason) => ORGANIZATION_ACTIVATION_REASON_CODES.includes(reason))
    && new Set(value.reasons).size === value.reasons.length
    && isValidOrganizationActivationObservations(value.observations);
}

function accessBlocker(observations) {
  if (!observations.github.organization.viewer_is_owner) {
    return { reasons: ["github_organization_owner_required"], nextAction: "request_organization_owner" };
  }
  if (observations.github_app.status === "missing") {
    return { reasons: ["github_app_installation_required"], nextAction: "install_github_app" };
  }
  if (observations.github_app.status === "unobservable") {
    return { reasons: ["github_app_scope_unavailable"], nextAction: "refresh_github_permissions" };
  }
  return null;
}

function installedAppAccessBlocker(app) {
  if (app.root_access === "included") return null;
  if (app.root_access === "missing") {
    return { reason: "github_app_root_access_required", nextAction: "grant_root_repository" };
  }
  return { reason: "github_app_root_access_unverified", nextAction: "verify_root_repository_access" };
}

function okReport(request, observations, outcome, reasons, nextAction) {
  return freeze({
    schema_version: ORGANIZATION_ACTIVATION_REPORT_SCHEMA,
    contract_version: ORGANIZATION_ACTIVATION_CONTRACT_VERSION,
    request,
    execution: { status: "ok" },
    outcome,
    reasons,
    next_action: { kind: nextAction },
    observations,
  });
}

function isIdentity(value) {
  return isRecord(value)
    && exactKeys(value, ["id", "login"])
    && organizationIdPattern.test(value.id ?? "")
    && normalizedText(value.login) !== "";
}

function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function exactKeys(value, expected) {
  return Object.keys(value).toSorted().join("\0") === [...expected].toSorted().join("\0");
}

function normalizedText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function freeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freeze(child);
  return Object.freeze(value);
}
