import { createHash } from "node:crypto";

import { normalizeOrganizationPortPool } from "./organization-port-policy-lib.mjs";
import { isValidOrganizationForgeBinding } from "./organization-scaffold-lib.mjs";
import {
  githubRepositoryCoordinate,
  normalizeOrganizationSlotPath,
  organizationRootRepositoryAliasIssues,
  organizationSlotPathScope,
} from "./organization-slot-scope-lib.mjs";

export const ORGANIZATION_ACTIVATION_CONTRACT_VERSION = "lazurio.organization.activation.v0";
export const ORGANIZATION_ACTIVATION_REQUEST_SCHEMA = "lazurio.organization.activation.request.v0";
export const ORGANIZATION_ACTIVATION_REPORT_SCHEMA = "lazurio.organization.activation.report.v0";
export const ORGANIZATION_ROOT_RESOLUTION_VERSION = "lazurio.organization.root-resolution.v1";
export const ORGANIZATION_MANIFEST_SCHEMA_VERSION = "lazurio.organization.v1";
export const ORGANIZATION_RESOURCE_SCHEMA_VERSION = "lazurio.organization.resource.v1";
export const ORGANIZATION_LEGACY_PROJECTION_HASH_ALGORITHM = "sha256-canonical-json-v1";
export const ORGANIZATION_MANIFEST_STATES = Object.freeze([
  "legacy",
  "transition",
  "projection_drift",
  "conflict",
  "current",
  "missing",
]);

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
const githubLoginPattern = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/u;
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
  expectedOrganizationId,
  expectedOrganizationLogin,
  expectedRepositoryId,
  expectedRepositoryFullName,
}) {
  const legacyPresent = companyManifest !== null && companyManifest !== undefined;
  const canonicalPresent = canonicalManifest !== null && canonicalManifest !== undefined;
  const modules = normalizeModulesManifest(modulesManifest);
  const legacy = legacyPresent ? normalizeLegacyOrganization(companyManifest, modulesManifest) : invalidNormalization();
  const canonical = canonicalPresent ? normalizeCanonicalOrganization(canonicalManifest, modulesManifest) : invalidNormalization();
  const issues = [...modules.issues];
  if (legacyPresent) issues.push(...legacy.issues);
  if (canonicalPresent) issues.push(...canonical.issues);

  let state = "missing";
  let resource = null;
  let semanticHash = null;
  let projection = null;

  if (legacyPresent && !canonicalPresent) {
    state = legacy.valid && modules.valid ? "legacy" : "conflict";
    resource = state === "legacy" ? legacy.resource : null;
  } else if (!legacyPresent && canonicalPresent) {
    state = canonical.valid && modules.valid ? "current" : "conflict";
    resource = state === "current" ? canonical.resource : null;
  } else if (legacyPresent && canonicalPresent) {
    if (!legacy.valid || !canonical.valid || !modules.valid) {
      state = "conflict";
    } else {
      const legacyHash = organizationSemanticHash(legacy.resource);
      const canonicalHash = organizationSemanticHash(canonical.resource);
      if (legacyHash !== canonicalHash) {
        state = "conflict";
        issues.push("normalized_semantics_conflict");
      } else {
        const expectedHash = organizationLegacyProjectionHash(canonicalManifest, modulesManifest);
        const declaredHash = canonicalManifest.compatibility?.legacy_projection?.sha256 ?? null;
        const actualHash = hashCanonicalJson(companyManifest);
        projection = {
          algorithm: ORGANIZATION_LEGACY_PROJECTION_HASH_ALGORITHM,
          expected_hash: expectedHash,
          declared_hash: declaredHash,
          actual_hash: actualHash,
        };
        if (declaredHash !== expectedHash) {
          state = "conflict";
          issues.push("canonical_projection_hash_invalid");
        } else {
          state = actualHash === expectedHash ? "transition" : "projection_drift";
          resource = canonical.resource;
        }
      }
    }
  }

  if (resource) semanticHash = organizationSemanticHash(resource);
  const activation = legacyActivationProjection({
    state,
    resource,
    canonicalPresent,
    companyManifest,
    expectedOrganizationId,
    expectedOrganizationLogin,
    expectedRepositoryId,
    expectedRepositoryFullName,
  });
  return freeze({
    contract_version: ORGANIZATION_ROOT_RESOLUTION_VERSION,
    state,
    resource,
    resource_count: resource === null ? 0 : 1,
    semantic_hash: semanticHash,
    projection,
    issues: [...new Set(issues)].sort(),
    activation,
  });
}

export function projectLegacyOrganizationManifest(canonicalManifest, modulesManifest) {
  const canonical = normalizeCanonicalOrganization(canonicalManifest, modulesManifest);
  const modules = normalizeModulesManifest(modulesManifest);
  if (!canonical.valid || !modules.valid) {
    throw new TypeError(`Cannot project invalid Organization manifest: ${[...canonical.issues, ...modules.issues].join(", ")}`);
  }
  const extensionFields = canonicalManifest.extensions?.legacy ?? {};
  const organization = canonicalManifest.organization;
  const root = canonicalManifest.root_repository;
  const forgeBinding = projectLegacyForgeBinding(organization, root);
  const projected = {
    ...clone(extensionFields),
    organization_generation: "gen3",
    organization_kind: canonicalManifest.kind,
    company: projectLegacyCompany(organization, root),
    ...(forgeBinding ? { forge_binding: forgeBinding } : {}),
    ...(canonicalManifest.governance === undefined ? {} : { governance: clone(canonicalManifest.governance) }),
    ...(canonicalManifest.teams === undefined ? {} : { teams: clone(canonicalManifest.teams) }),
    ...(canonicalManifest.layers === undefined ? {} : { layers: clone(canonicalManifest.layers) }),
    ...(canonicalManifest.task_sources === undefined ? {} : { task_sources: clone(canonicalManifest.task_sources) }),
    ...(canonicalManifest.doctor === undefined ? {} : { doctor: clone(canonicalManifest.doctor) }),
    ...(canonicalManifest.module_port_pool === undefined
      ? {}
      : { module_port_pool: clone(canonicalManifest.module_port_pool) }),
    modules: projectLegacyModules(modulesManifest.module_slots),
  };
  return freeze(sortObject(projected));
}

export function organizationLegacyProjectionHash(canonicalManifest, modulesManifest) {
  return hashCanonicalJson(projectLegacyOrganizationManifest(canonicalManifest, modulesManifest));
}

export function organizationSemanticHash(resource) {
  return resource === null ? null : hashCanonicalJson(resource);
}

function normalizeModulesManifest(value) {
  const issues = [];
  if (!isRecord(value)) issues.push("modules_manifest_missing");
  const generationSupported = value?.organization_generation === "gen3"
    || value?.schema_version === "companiesascode.modules.v1";
  if (!generationSupported) issues.push("modules_manifest_schema_unsupported");
  if (!Array.isArray(value?.module_slots)) issues.push("modules_manifest_slots_invalid");
  const company = normalizedText(value?.company);
  const githubOrganization = normalizedText(value?.github_org);
  if (!company || company !== value?.company) issues.push("modules_manifest_company_missing");
  if (!githubOrganization || githubOrganization !== value?.github_org) {
    issues.push("modules_manifest_forge_locator_missing");
  }
  for (const [index, slot] of (Array.isArray(value?.module_slots) ? value.module_slots : []).entries()) {
    const path = slot?.path;
    if (
      !isRecord(slot)
      || typeof path !== "string"
      || path === ""
      || normalizeOrganizationSlotPath(path) !== path
      || organizationSlotPathScope(path) === null
    ) issues.push(`modules_manifest_slot_${index}_path_invalid`);
  }
  return {
    valid: issues.length === 0,
    issues,
    company,
    githubOrganization,
    slots: Array.isArray(value?.module_slots) ? normalizeRepositorySlots(value.module_slots) : [],
  };
}

function normalizeLegacyOrganization(value, modulesManifest) {
  const issues = [];
  if (!isRecord(value)) return invalidNormalization("legacy_manifest_invalid");
  if (value.organization_generation !== "gen3") issues.push("legacy_manifest_schema_unsupported");
  const kind = value.organization_kind ?? "organization";
  if (!['organization', 'template'].includes(kind)) issues.push("organization_kind_invalid");
  const company = value.company;
  if (!isRecord(company)) issues.push("legacy_organization_identity_invalid");
  const slug = normalizedText(company?.slug);
  const displayName = normalizedText(company?.display_name) || slug;
  const forgeLocator = normalizedText(company?.github_org);
  if (!slug || !displayName || !forgeLocator) issues.push("legacy_organization_identity_invalid");
  issues.push(...organizationRootRepositoryAliasIssues(value).map((issue) => issue.code));
  const modules = normalizeModulesManifest(modulesManifest);
  if (modules.valid && (modules.company !== slug || !sameText(modules.githubOrganization, forgeLocator))) {
    issues.push("organization_modules_identity_conflict");
  }
  const repository = legacyRootRepository(value);
  if (repository.issue) issues.push(repository.issue);
  const forgeBinding = legacyOrganizationForgeBinding(value, forgeLocator);
  if (forgeBinding.issue) issues.push(forgeBinding.issue);
  const extensions = remainingFields(value, legacyReservedFields);
  const resource = issues.length === 0
    ? normalizedResource({
        kind,
        slug,
        displayName,
        organizationMetadata: remainingFields(company, legacyCompanyReservedFields),
        organizationForgeBinding: forgeBinding.value,
        rootRepository: repository.value,
        modules,
        manifest: value,
        extensions,
      })
    : null;
  return { valid: issues.length === 0, issues, resource };
}

function normalizeCanonicalOrganization(value, modulesManifest) {
  const issues = [];
  if (!isRecord(value)) return invalidNormalization("canonical_manifest_invalid");
  issues.push(...canonicalManifestShapeIssues(value));
  if (value.schema_version !== ORGANIZATION_MANIFEST_SCHEMA_VERSION) {
    issues.push("canonical_manifest_schema_unsupported");
  }
  if (!['organization', 'template'].includes(value.kind)) issues.push("organization_kind_invalid");
  const organization = value.organization;
  const slug = normalizedText(organization?.slug);
  const displayName = normalizedText(organization?.display_name);
  if (
    !isRecord(organization)
    || !slug
    || slug !== organization.slug
    || !displayName
    || displayName !== organization.display_name
  ) issues.push("canonical_organization_identity_invalid");
  const organizationForgeBinding = canonicalForgeBinding(organization?.forge_binding, "organization");
  if (organizationForgeBinding.issue) issues.push(organizationForgeBinding.issue);
  const rootRepository = canonicalForgeBinding(value.root_repository, "repository", { optional: true });
  if (rootRepository.issue) issues.push(rootRepository.issue);
  const compatibilityBindingIssue = canonicalCompatibilityBindingIssue(
    organizationForgeBinding.value,
    rootRepository.value,
  );
  if (compatibilityBindingIssue) issues.push(compatibilityBindingIssue);
  if (value.manifests?.modules !== "modules.manifest.json") issues.push("canonical_modules_pointer_invalid");
  const projection = value.compatibility?.legacy_projection;
  if (
    !isRecord(projection)
    || projection.path !== "company.gen3.json"
    || projection.algorithm !== ORGANIZATION_LEGACY_PROJECTION_HASH_ALGORITHM
    || !/^sha256:[0-9a-f]{64}$/u.test(projection.sha256 ?? "")
  ) issues.push("canonical_projection_contract_invalid");
  if (!isRecord(value.extensions) || !isRecord(value.extensions.legacy)) {
    issues.push("canonical_extensions_invalid");
  } else if (Object.keys(value.extensions.legacy).some((key) => legacyReservedFields.has(key))) {
    issues.push("canonical_extensions_reserved_field");
  }
  const modules = normalizeModulesManifest(modulesManifest);
  const forgeLocator = organizationForgeBinding.value?.locator ?? "";
  if (modules.valid && (modules.company !== slug || !sameText(modules.githubOrganization, forgeLocator))) {
    issues.push("organization_modules_identity_conflict");
  }
  const resource = issues.length === 0
    ? normalizedResource({
        kind: value.kind,
        slug,
        displayName,
        organizationMetadata: clone(organization.metadata ?? {}),
        organizationForgeBinding: organizationForgeBinding.value,
        rootRepository: rootRepository.value,
        modules,
        manifest: value,
        extensions: clone(value.extensions.legacy),
      })
    : null;
  return { valid: issues.length === 0, issues, resource };
}

function normalizedResource({
  kind,
  slug,
  displayName,
  organizationMetadata,
  organizationForgeBinding,
  rootRepository,
  modules,
  manifest,
  extensions,
}) {
  return sortObject({
    schema_version: ORGANIZATION_RESOURCE_SCHEMA_VERSION,
    kind,
    organization: {
      slug,
      display_name: displayName,
      forge_binding: organizationForgeBinding,
      metadata: clone(organizationMetadata),
    },
    root_repository: rootRepository,
    manifests: { modules: "modules.manifest.json" },
    repository_inventory: clone(modules.slots),
    ...(manifest.module_port_pool === undefined ? {} : { module_port_pool: clone(manifest.module_port_pool) }),
    ...(manifest.governance === undefined ? {} : { governance: clone(manifest.governance) }),
    ...(manifest.teams === undefined ? {} : { teams: clone(manifest.teams) }),
    ...(manifest.layers === undefined ? {} : { layers: clone(manifest.layers) }),
    ...(manifest.task_sources === undefined ? {} : { task_sources: clone(manifest.task_sources) }),
    ...(manifest.doctor === undefined ? {} : { doctor: clone(manifest.doctor) }),
    extensions: { legacy: clone(extensions) },
  });
}

function legacyRootRepository(value) {
  const company = value.company;
  const binding = value.forge_binding;
  const locator = normalizedText(binding?.repository?.asserted_full_name)
    || normalizedText(company?.root_repository)
    || repositoryCoordinate(company?.repository)
    || repositoryCoordinate(company?.git_url);
  const defaultBranch = normalizedText(binding?.repository?.default_branch)
    || normalizedText(value.governance?.default_branch)
    || normalizedText(company?.default_branch)
    || normalizedText(value.default_branch)
    || "main";
  if (!locator) return { value: null, issue: null };
  const verified = binding !== null && binding !== undefined;
  if (verified && !isValidOrganizationForgeBinding(binding)) {
    return { value: null, issue: "legacy_forge_binding_invalid" };
  }
  return {
    issue: null,
    value: sortObject({
      forge: "github",
      locator,
      default_branch: defaultBranch,
      binding_state: verified ? "verified" : "unverified",
      ...(verified ? { repository_id: binding.repository.id } : {}),
    }),
  };
}

function legacyOrganizationForgeBinding(value, locator) {
  const binding = value.forge_binding;
  if (binding !== null && binding !== undefined && !isValidOrganizationForgeBinding(binding)) {
    return { value: null, issue: "legacy_forge_binding_invalid" };
  }
  const verified = binding !== null && binding !== undefined;
  return {
    issue: null,
    value: sortObject({
      forge: "github",
      locator,
      binding_state: verified ? "verified" : "unverified",
      ...(verified ? { organization_id: binding.organization.id } : {}),
    }),
  };
}

function canonicalForgeBinding(value, kind, { optional = false } = {}) {
  if ((value === null || value === undefined) && optional) return { value: null, issue: null };
  if (!isRecord(value)) return { value: null, issue: `canonical_${kind}_binding_invalid` };
  const locator = normalizedText(value.locator);
  const state = value.binding_state;
  const idKey = kind === "organization" ? "organization_id" : "repository_id";
  const id = value[idKey];
  const expectedKeys = ["forge", "locator", "binding_state", ...(kind === "repository" ? ["default_branch"] : [])];
  if (state === "verified") expectedKeys.push(idKey);
  if (
    !exactKeys(value, expectedKeys)
    ||
    value.forge !== "github"
    || !locator
    || locator !== value.locator
    || (kind === "organization" && !githubLoginPattern.test(locator))
    || !["unverified", "verified"].includes(state)
    || (state === "verified" && !organizationIdPattern.test(id ?? ""))
    || (state === "unverified" && id !== undefined)
    || (kind === "repository" && (
      normalizedText(value.default_branch) === ""
      || normalizedText(value.default_branch) !== value.default_branch
    ))
  ) return { value: null, issue: `canonical_${kind}_binding_invalid` };
  return {
    issue: null,
    value: sortObject({
      forge: "github",
      locator,
      ...(kind === "repository" ? { default_branch: value.default_branch } : {}),
      binding_state: state,
      ...(state === "verified" ? { [idKey]: id } : {}),
    }),
  };
}

function canonicalManifestShapeIssues(value) {
  const issues = [];
  if (!hasOnlyKeys(value, [
    "schema_version",
    "kind",
    "organization",
    "root_repository",
    "manifests",
    "module_port_pool",
    "governance",
    "teams",
    "layers",
    "task_sources",
    "doctor",
    "extensions",
    "compatibility",
  ])) issues.push("canonical_manifest_fields_invalid");
  if (
    !isRecord(value.organization)
    || !exactKeys(value.organization, ["slug", "display_name", "forge_binding", "metadata"])
    || !isRecord(value.organization.metadata)
  ) issues.push("canonical_organization_shape_invalid");
  if (Object.keys(value.organization?.metadata ?? {}).some((key) => legacyCompanyReservedFields.has(key))) {
    issues.push("canonical_organization_metadata_reserved_field");
  }
  if (!isRecord(value.manifests) || !exactKeys(value.manifests, ["modules"])) {
    issues.push("canonical_manifests_shape_invalid");
  }
  if (
    !isRecord(value.extensions)
    || !exactKeys(value.extensions, ["legacy"])
    || !isRecord(value.extensions.legacy)
  ) issues.push("canonical_extensions_shape_invalid");
  if (
    !isRecord(value.compatibility)
    || !exactKeys(value.compatibility, ["legacy_projection"])
    || !isRecord(value.compatibility.legacy_projection)
    || !exactKeys(value.compatibility.legacy_projection, ["path", "algorithm", "sha256"])
  ) issues.push("canonical_compatibility_shape_invalid");
  for (const field of ["governance", "doctor"]) {
    if (value[field] !== undefined && !isRecord(value[field])) issues.push(`canonical_${field}_invalid`);
  }
  if (
    isRecord(value.governance)
    && (
      (Object.hasOwn(value.governance, "default_branch") && value.governance.default_branch !== "main")
      || (Object.hasOwn(value.governance, "access_authority") && value.governance.access_authority !== "github")
    )
  ) issues.push("canonical_governance_authority_invalid");
  for (const field of ["teams", "layers", "task_sources"]) {
    if (value[field] !== undefined && !Array.isArray(value[field])) issues.push(`canonical_${field}_invalid`);
  }
  if (
    value.module_port_pool === null
    || normalizeOrganizationPortPool({ manifest: value }).issues.length > 0
  ) {
    issues.push("canonical_module_port_pool_invalid");
  }
  return issues;
}

function canonicalCompatibilityBindingIssue(organization, root) {
  if (!organization) return null;
  if (root === null) {
    return organization.binding_state === "verified"
      ? "canonical_compatibility_binding_invalid"
      : null;
  }
  if (organization.binding_state !== root.binding_state) {
    return "canonical_compatibility_binding_invalid";
  }
  if (root.default_branch !== "main") return "canonical_compatibility_binding_invalid";
  const coordinate = githubRepositoryCoordinate(root.locator);
  if (
    !coordinate
    || !sameText(coordinate.owner, organization.locator)
    || !sameText(coordinate.ownerRepo, root.locator)
  ) {
    return "canonical_compatibility_binding_invalid";
  }
  if (organization.binding_state !== "verified") return null;
  return isValidOrganizationForgeBinding({
    schema_version: "lazurio.forge-binding.github.v0",
    provider: "github",
    organization: {
      id: organization.organization_id,
      asserted_login: organization.locator,
    },
    repository: {
      id: root.repository_id,
      asserted_full_name: root.locator,
      default_branch: root.default_branch,
    },
  })
    ? null
    : "canonical_compatibility_binding_invalid";
}

function legacyActivationProjection({
  state,
  resource,
  canonicalPresent,
  companyManifest,
  expectedOrganizationId,
  expectedOrganizationLogin,
  expectedRepositoryId,
  expectedRepositoryFullName,
}) {
  if (canonicalPresent) {
    return { status: "unsupported", format: null, reason: "canonical_resolver_unavailable" };
  }
  if (state !== "legacy" || resource?.kind !== "organization") {
    const reason = state === "missing"
      ? "legacy_manifest_pair_missing"
      : ["current", "transition", "projection_drift"].includes(state)
        ? "canonical_resolver_unavailable"
        : "legacy_identity_pair_invalid";
    return { status: "unsupported", format: null, reason };
  }
  const organizationLogin = normalizedText(expectedOrganizationLogin);
  const repositoryFullName = normalizedText(expectedRepositoryFullName);
  const organizationBinding = resource.organization.forge_binding;
  const repositoryBinding = resource.root_repository;
  const forgeBinding = companyManifest.forge_binding;
  const forgeBindingSupported = forgeBinding === undefined
    || isValidOrganizationForgeBinding(forgeBinding, {
      organizationId: expectedOrganizationId,
      organizationLogin,
      repositoryId: expectedRepositoryId,
      repositoryFullName,
    });
  const supported = sameText(organizationBinding.locator, organizationLogin)
    && (repositoryBinding === null || sameText(repositoryBinding.locator, repositoryFullName))
    && forgeBindingSupported;
  return supported
    ? { status: "supported", format: "legacy", reason: "legacy_identity_pair_supported" }
    : { status: "unsupported", format: null, reason: "legacy_identity_pair_invalid" };
}

function projectLegacyCompany(organization, root) {
  return sortObject({
    ...clone(organization.metadata ?? {}),
    slug: organization.slug,
    display_name: organization.display_name,
    github_org: organization.forge_binding.locator,
    ...(root === null || root === undefined ? {} : {
      repository: root.forge === "github" ? `git@github.com:${root.locator}.git` : root.locator,
      root_repository: root.locator,
      default_branch: root.default_branch,
    }),
  });
}

function projectLegacyForgeBinding(organization, root) {
  if (
    organization?.forge_binding?.binding_state !== "verified"
    || root?.binding_state !== "verified"
    || organization.forge_binding.forge !== "github"
    || root.forge !== "github"
  ) return null;
  return {
    schema_version: "lazurio.forge-binding.github.v0",
    provider: "github",
    organization: {
      id: organization.forge_binding.organization_id,
      asserted_login: organization.forge_binding.locator,
    },
    repository: {
      id: root.repository_id,
      asserted_full_name: root.locator,
      default_branch: root.default_branch,
    },
  };
}

function projectLegacyModules(slots) {
  return slots
    .filter((slot) => organizationSlotPathScope(slot?.path) !== "root")
    .map((slot) => {
      const projected = clone(slot);
      const remote = slot?.git?.url ?? slot?.repo ?? slot?.repository;
      const branch = slot?.git?.branch ?? slot?.branch;
      delete projected.git;
      delete projected.space;
      delete projected.default_access;
      delete projected.required_roles;
      projected.slug ??= slot.path.split("/").at(-1);
      if (remote !== undefined) projected.repo = remote;
      if (branch !== undefined) projected.branch = branch;
      if (slot.space === "productionspace") projected.workspace = "productionspace";
      else if (Array.isArray(slot.teams)) projected.teams = clone(slot.teams);
      else if (slot.workspace !== undefined) projected.workspace = slot.workspace;
      if (slot.default_access !== undefined || slot.required_roles !== undefined) {
        projected.access = {
          default: slot.default_access ?? "expected",
          roles: clone(slot.required_roles ?? []),
        };
      }
      return sortObject(projected);
    })
    .sort((left, right) => String(left.path).localeCompare(String(right.path), "en"));
}

function normalizeRepositorySlots(slots) {
  return slots.map((slot) => sortObject(clone(slot))).sort((left, right) => (
    String(left.path ?? "").localeCompare(String(right.path ?? ""), "en")
  ));
}

function remainingFields(value, reserved) {
  return Object.fromEntries(Object.entries(value ?? {})
    .filter(([key]) => !reserved.has(key))
    .map(([key, child]) => [key, clone(child)]));
}

function repositoryCoordinate(value) {
  const text = normalizedText(value);
  const match = text.match(/^(?:git@github\.com:|https?:\/\/github\.com\/)([^/]+\/[^/]+?)(?:\.git)?$/iu);
  return match?.[1] ?? "";
}

function sameText(left, right) {
  return normalizedText(left).toLowerCase() === normalizedText(right).toLowerCase();
}

function invalidNormalization(issue) {
  return { valid: false, issues: issue ? [issue] : [], resource: null };
}

function hashCanonicalJson(value) {
  return `sha256:${createHash("sha256").update(JSON.stringify(sortObject(value))).digest("hex")}`;
}

function sortObject(value) {
  if (Array.isArray(value)) return value.map(sortObject);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortObject(value[key])]));
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

const legacyReservedFields = new Set([
  "organization_generation",
  "organization_kind",
  "company",
  "forge_binding",
  "governance",
  "teams",
  "layers",
  "task_sources",
  "doctor",
  "module_port_pool",
  "modules",
  "default_branch",
]);

const legacyCompanyReservedFields = new Set([
  "slug",
  "display_name",
  "github_org",
  "repository",
  "git_url",
  "root_repository",
  "default_branch",
]);

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

function hasOnlyKeys(value, allowed) {
  const allowedKeys = new Set(allowed);
  return Object.keys(value).every((key) => allowedKeys.has(key));
}

function normalizedText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function freeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freeze(child);
  return Object.freeze(value);
}
