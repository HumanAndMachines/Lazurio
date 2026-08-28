import { expect, test } from "bun:test";

import { validateAgainstSchema } from "../runtime/json-schema-mini.mjs";
import schema from "../organization-activation-report.v0.schema.json";
import organizationManifestSchema from "../lazurio.organization.v1.schema.json";
import {
  ORGANIZATION_ACTIVATION_ERROR_CODES,
  ORGANIZATION_ACTIVATION_NEXT_ACTIONS,
  ORGANIZATION_ACTIVATION_OUTCOMES,
  ORGANIZATION_ACTIVATION_REASON_CODES,
  ORGANIZATION_LEGACY_PROJECTION_HASH_ALGORITHM,
  ORGANIZATION_LEGACY_COMPANY_RESERVED_FIELDS,
  ORGANIZATION_LEGACY_RESERVED_FIELDS,
  ORGANIZATION_MANIFEST_SCHEMA_VERSION,
  ORGANIZATION_MANIFEST_STATES,
  ORGANIZATION_RESOURCE_SCHEMA_VERSION,
  createOrganizationActivationRequest,
  isValidOrganizationActivationObservations,
  isValidOrganizationActivationReport,
  organizationActivationError,
  organizationActivationExitCode,
  organizationLegacyProjectionHash,
  projectLegacyOrganizationManifest,
  resolveOrganizationActivation,
  resolveOrganizationRootDocuments,
} from "./organization-activation-lib.mjs";
import {
  createOrganizationScaffold,
  ORGANIZATION_GITHUB_LOGIN_PATTERN,
  ORGANIZATION_POSITIVE_GITHUB_ID_PATTERN,
} from "./organization-scaffold-lib.mjs";

const request = createOrganizationActivationRequest({ githubOrganizationId: "314957563" });

test("Core derives only the three public outcomes from observation facts", () => {
  const absent = report({ root: { presence: "absent" } });
  const empty = report({ root: { presence: "empty" } });
  const legacy = report({ root: { presence: "present", resolverStatus: "supported", format: "legacy" } });
  const current = report({ root: { presence: "present", resolverStatus: "supported", format: "current" } });
  const transition = report({ root: { presence: "present", resolverStatus: "supported", format: "transition" } });
  const unsupported = report({ root: { presence: "present", resolverStatus: "unsupported" } });

  expect(absent).toMatchObject({
    execution: { status: "ok" },
    outcome: "needs_activation",
    reasons: ["root_repository_absent"],
    next_action: { kind: "run_activation" },
  });
  expect(empty).toMatchObject({ outcome: "needs_activation", reasons: ["root_repository_empty"] });
  expect(legacy).toMatchObject({ outcome: "active", reasons: ["root_supported_legacy"] });
  expect(current).toMatchObject({ outcome: "active", reasons: ["root_supported_current"] });
  expect(transition).toMatchObject({ outcome: "active", reasons: ["root_supported_transition"] });
  expect(unsupported).toMatchObject({
    outcome: "action_required",
    reasons: ["root_manifest_unsupported"],
    next_action: { kind: "inspect_existing_repository" },
  });
  expect(new Set([absent.outcome, legacy.outcome, unsupported.outcome])).toEqual(
    new Set(ORGANIZATION_ACTIVATION_OUTCOMES),
  );
});

test("access facts fail closed without inventing more lifecycle states", () => {
  expect(report({ owner: false })).toMatchObject({
    outcome: "action_required",
    reasons: ["github_organization_owner_required"],
    next_action: { kind: "request_organization_owner" },
  });
  expect(report({ app: { status: "missing" } })).toMatchObject({
    outcome: "action_required",
    reasons: ["github_app_installation_required"],
    next_action: { kind: "install_github_app" },
  });
  expect(report({ canCreate: false })).toMatchObject({
    outcome: "action_required",
    reasons: ["github_repository_creation_required"],
  });
  expect(report({ root: { presence: "empty", canPush: false } })).toMatchObject({
    outcome: "action_required",
    reasons: ["github_repository_push_required"],
  });
  expect(report({ root: { presence: "absent", candidateCount: 1 } })).toMatchObject({
    outcome: "action_required",
    reasons: ["root_repository_conflict"],
  });
});

test("selected App access is an observed fact, never an assumed grant", () => {
  expect(report({
    root: { presence: "present", resolverStatus: "supported", format: "legacy" },
    app: { selection: "selected", rootAccess: "included" },
  }).outcome).toBe("active");
  expect(report({
    root: { presence: "present", resolverStatus: "supported", format: "legacy" },
    app: { selection: "selected", rootAccess: "missing" },
  })).toMatchObject({
    outcome: "action_required",
    reasons: ["github_app_root_access_required"],
    next_action: { kind: "grant_root_repository" },
  });
  expect(report({
    root: { presence: "present", resolverStatus: "supported", format: "legacy" },
    app: { selection: "selected", rootAccess: "unverified" },
  })).toMatchObject({
    outcome: "action_required",
    reasons: ["github_app_root_access_unverified"],
    next_action: { kind: "verify_root_repository_access" },
  });
});

test("contradictory all-repositories access cannot become active", () => {
  const observations = fixture({
    root: { presence: "present", resolverStatus: "supported", format: "legacy" },
  });
  observations.github_app.root_access = "missing";

  expect(isValidOrganizationActivationObservations(observations)).toBe(false);
  expect(() => resolveOrganizationActivation({ request, observations })).toThrow(
    "Organization activation observations are invalid",
  );
  const invalidReport = {
    ...report({ root: { presence: "present", resolverStatus: "supported", format: "legacy" } }),
    observations,
  };
  expect(validateAgainstSchema(invalidReport, schema, "activation")).not.toEqual([]);
});

test("technical failure has no Organization outcome or guessed observations", () => {
  const failure = organizationActivationError({
    request,
    code: "github_transport_failed",
    retryable: true,
    nextAction: "retry",
  });

  expect(failure.execution).toEqual({
    status: "error",
    error: { code: "github_transport_failed", retryable: true },
  });
  expect(failure).not.toHaveProperty("outcome");
  expect(failure).not.toHaveProperty("observations");
  expect(organizationActivationExitCode(failure)).toBe(2);
  expect(isValidOrganizationActivationReport(failure)).toBe(true);
  expect(validateAgainstSchema(failure, schema, "activation")).toEqual([]);
});

test("public schema and Core pin one vocabulary", () => {
  expect(schema.properties.outcome.enum).toEqual(ORGANIZATION_ACTIVATION_OUTCOMES);
  expect(schema.properties.reasons.items.enum).toEqual(ORGANIZATION_ACTIVATION_REASON_CODES);
  expect(schema.properties.next_action.properties.kind.enum).toEqual(ORGANIZATION_ACTIVATION_NEXT_ACTIONS);
  expect(schema.definitions.execution.properties.error.properties.code.enum).toEqual(
    ORGANIZATION_ACTIVATION_ERROR_CODES,
  );
  const active = report({ root: { presence: "present", resolverStatus: "supported", format: "legacy" } });
  expect(isValidOrganizationActivationReport(active)).toBe(true);
  expect(validateAgainstSchema(active, schema, "activation")).toEqual([]);
  expect(organizationActivationExitCode(active)).toBe(0);

  const schemaOnlyInvalid = structuredClone(active);
  schemaOnlyInvalid.observations.root_repository.resolver.format = null;
  expect(validateAgainstSchema(schemaOnlyInvalid, schema, "activation")).not.toEqual([]);
  expect(isValidOrganizationActivationReport(schemaOnlyInvalid)).toBe(false);
});

test("Organization manifest schema literals stay pinned to their Core authorities", () => {
  const organizationBinding = organizationManifestSchema.$defs.organizationForgeBinding.properties;
  const repositoryBinding = organizationManifestSchema.$defs.repositoryForgeBinding.properties;
  expect(organizationBinding.locator.pattern).toBe(ORGANIZATION_GITHUB_LOGIN_PATTERN.source);
  expect(organizationBinding.organization_id.pattern).toBe(ORGANIZATION_POSITIVE_GITHUB_ID_PATTERN.source);
  expect(repositoryBinding.repository_id.pattern).toBe(ORGANIZATION_POSITIVE_GITHUB_ID_PATTERN.source);
  expect(organizationManifestSchema.properties.organization.properties.metadata.propertyNames.not.enum)
    .toEqual(ORGANIZATION_LEGACY_COMPANY_RESERVED_FIELDS);
  expect(organizationManifestSchema.properties.extensions.properties.legacy.propertyNames.not.enum)
    .toEqual(ORGANIZATION_LEGACY_RESERVED_FIELDS);
});

test("legacy remote resolver requires the identity pair and does not preempt canonical rollout", () => {
  const companyManifest = {
    organization_generation: "gen3",
    organization_kind: "organization",
    company: {
      slug: "Example",
      github_org: "Example",
      root_repository: "Example/Example_GEN3",
    },
  };
  const modulesManifest = {
    organization_generation: "gen3",
    company: "Example",
    github_org: "Example",
    module_slots: [],
  };
  const input = {
    companyManifest,
    modulesManifest,
    canonicalManifest: null,
    expectedOrganizationLogin: "Example",
    expectedRepositoryFullName: "Example/Example_GEN3",
  };

  expect(resolveOrganizationRootDocuments(input).activation).toEqual({
    status: "supported",
    format: "legacy",
    reason: "legacy_identity_pair_supported",
  });
  expect(resolveOrganizationRootDocuments({
    ...input,
    expectedOrganizationLogin: "RenamedExample",
  }).activation).toMatchObject({ status: "unsupported", reason: "legacy_identity_pair_invalid" });
  const sshOnlyManifest = structuredClone(companyManifest);
  delete sshOnlyManifest.company.root_repository;
  sshOnlyManifest.company.repository = "ssh://git@github.com/Example/Example_GEN3.git";
  expect(resolveOrganizationRootDocuments({
    ...input,
    companyManifest: sshOnlyManifest,
  }).activation).toMatchObject({ status: "supported", format: "legacy" });
  expect(resolveOrganizationRootDocuments({
    ...input,
    companyManifest: sshOnlyManifest,
    expectedRepositoryFullName: "Example/Other",
  }).activation).toMatchObject({ status: "unsupported", reason: "legacy_identity_pair_invalid" });
  expect(resolveOrganizationRootDocuments({
    ...input,
    canonicalManifest: { schema_version: "lazurio.organization.v1" },
  }).activation).toEqual({
    status: "unsupported",
    format: null,
    reason: "canonical_resolver_unavailable",
  });
});

test("generated legacy scaffold binds live immutable Organization and repository IDs", () => {
  const scaffold = createOrganizationScaffold({
    organization: { id: "314957563", login: "Example", slug: "example-org", displayName: "Example" },
    repository: {
      id: "42424242",
      name: "Example_GEN3",
      fullName: "Example/Example_GEN3",
      defaultBranch: "main",
    },
  });
  const document = (path) => JSON.parse(scaffold.files.find((file) => file.path === path).content);
  const input = {
    companyManifest: document("company.gen3.json"),
    modulesManifest: document("modules.manifest.json"),
    canonicalManifest: null,
    expectedOrganizationId: "314957563",
    expectedOrganizationLogin: "Example",
    expectedRepositoryId: "42424242",
    expectedRepositoryFullName: "Example/Example_GEN3",
  };

  expect(resolveOrganizationRootDocuments(input).activation).toMatchObject({ status: "supported", format: "legacy" });
  expect(resolveOrganizationRootDocuments({ ...input, expectedOrganizationId: "999" }).activation)
    .toMatchObject({ status: "unsupported", reason: "legacy_identity_pair_invalid" });
  expect(resolveOrganizationRootDocuments({ ...input, expectedRepositoryId: "999" }).activation)
    .toMatchObject({ status: "unsupported", reason: "legacy_identity_pair_invalid" });
  const conflictingAliases = structuredClone(input.companyManifest);
  conflictingAliases.company.root_repository = "Example/Wrong";
  expect(resolveOrganizationRootDocuments({ ...input, companyManifest: conflictingAliases })).toMatchObject({
    state: "conflict",
    recovery_identity: {
      kind: "organization",
      slug: "example-org",
      display_name: "Example",
    },
    activation: { status: "unsupported", reason: "legacy_identity_pair_invalid" },
    issues: expect.arrayContaining(["organization_root_remote_conflict"]),
  });
});

test("Organization root resolver returns the six compatibility states through one normalized resource seam", () => {
  const modulesManifest = organizationModules();
  const legacy = legacyOrganization();
  const canonical = canonicalOrganization(modulesManifest);
  const projected = projectLegacyOrganizationManifest(canonical, modulesManifest);
  const drifted = structuredClone(projected);
  delete drifted.organization_kind;
  const inputs = {
    legacy: { companyManifest: legacy, canonicalManifest: null },
    transition: { companyManifest: projected, canonicalManifest: canonical },
    projection_drift: {
      companyManifest: drifted,
      canonicalManifest: canonical,
    },
    conflict: {
      companyManifest: { ...projected, company: { ...projected.company, slug: "different" } },
      canonicalManifest: canonical,
    },
    current: { companyManifest: null, canonicalManifest: canonical },
    missing: { companyManifest: null, canonicalManifest: null },
  };

  expect(Object.keys(inputs).sort()).toEqual([...ORGANIZATION_MANIFEST_STATES].sort());
  for (const [state, documents] of Object.entries(inputs)) {
    const resolution = resolveOrganizationRootDocuments({ ...documents, modulesManifest });
    expect(resolution.state).toBe(state);
    expect(resolution.resource_count).toBe(["legacy", "transition", "projection_drift", "current"].includes(state) ? 1 : 0);
    expect(Array.isArray(resolution.resource)).toBe(false);
    expect(resolution.resource?.doctor ? 1 : 0).toBe(resolution.resource_count);
  }
});

test("canonical-only state rejects a stale legacy compatibility projection receipt", () => {
  const modulesManifest = organizationModules();
  const canonicalManifest = canonicalOrganization(modulesManifest);
  canonicalManifest.compatibility.legacy_projection.sha256 = `sha256:${"0".repeat(64)}`;

  expect(resolveOrganizationRootDocuments({
    companyManifest: null,
    canonicalManifest,
    modulesManifest,
  })).toMatchObject({
    state: "conflict",
    resource: null,
    resource_count: 0,
    projection: {
      declared_hash: canonicalManifest.compatibility.legacy_projection.sha256,
      actual_hash: null,
    },
    issues: expect.arrayContaining(["canonical_projection_hash_invalid"]),
  });
});

test("recovery identity is null when legacy and canonical display names disagree", () => {
  const modulesManifest = organizationModules();
  const canonicalManifest = canonicalOrganization(modulesManifest);
  const companyManifest = structuredClone(projectLegacyOrganizationManifest(canonicalManifest, modulesManifest));
  companyManifest.company.display_name = "Conflicting presentation";

  expect(resolveOrganizationRootDocuments({
    companyManifest,
    canonicalManifest,
    modulesManifest,
  })).toMatchObject({
    state: "conflict",
    recovery_identity: null,
    resource_count: 0,
  });
});

test("missing modules document keeps the compatibility reason on the missing-pair lane", () => {
  expect(resolveOrganizationRootDocuments({
    companyManifest: legacyOrganization(),
    canonicalManifest: null,
    modulesManifest: null,
  })).toMatchObject({
    state: "conflict",
    activation: { status: "unsupported", reason: "legacy_manifest_pair_missing" },
  });
});

test("canonical schema, semantic parity and projection hash are deterministic across key order and formatting", () => {
  const modulesManifest = organizationModules();
  const canonical = canonicalOrganization(modulesManifest);
  const projected = projectLegacyOrganizationManifest(canonical, modulesManifest);
  const reordered = Object.fromEntries(Object.entries(projected).reverse());
  const resolution = resolveOrganizationRootDocuments({
    companyManifest: reordered,
    modulesManifest,
    canonicalManifest: canonical,
  });

  expect(validateAgainstSchema(canonical, organizationManifestSchema, "organization")).toEqual([]);
  expect(resolution.state).toBe("transition");
  expect(resolution.resource.schema_version).toBe(ORGANIZATION_RESOURCE_SCHEMA_VERSION);
  expect(resolution.resource.schema_version).not.toBe(ORGANIZATION_MANIFEST_SCHEMA_VERSION);
  expect(resolution.semantic_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  expect(resolution.projection).toEqual({
    algorithm: ORGANIZATION_LEGACY_PROJECTION_HASH_ALGORITHM,
    expected_hash: canonical.compatibility.legacy_projection.sha256,
    declared_hash: canonical.compatibility.legacy_projection.sha256,
    actual_hash: canonical.compatibility.legacy_projection.sha256,
  });
  expect(projected.modules).toEqual([
    expect.objectContaining({
      path: "workspace/knowledgebase",
      description: "Organization knowledge and operating truth.",
      ui_exposure: "diagnostics-only",
    }),
  ]);

  const orderingModules = organizationModules();
  orderingModules.module_slots = [
    { ...structuredClone(orderingModules.module_slots[0]), path: "workspace/alpha", slug: "alpha" },
    { ...structuredClone(orderingModules.module_slots[0]), path: "workspace/Zed", slug: "zed" },
  ];
  const orderingCanonical = canonicalOrganization(orderingModules);
  expect(projectLegacyOrganizationManifest(orderingCanonical, orderingModules).modules.map(({ path }) => path)).toEqual([
    "workspace/Zed",
    "workspace/alpha",
  ]);
});

test("template kind remains one non-actionable normalized resource", () => {
  const modulesManifest = organizationModules();
  const canonical = canonicalOrganization(modulesManifest, { kind: "template" });
  const projected = projectLegacyOrganizationManifest(canonical, modulesManifest);
  const resolution = resolveOrganizationRootDocuments({
    companyManifest: projected,
    modulesManifest,
    canonicalManifest: canonical,
  });

  expect(resolution).toMatchObject({
    state: "transition",
    resource_count: 1,
    resource: { kind: "template" },
    activation: { status: "unsupported", reason: "canonical_resolver_unavailable" },
  });
});

test("canonical resolver rejects schema-shape drift and invalid Organization port policy", () => {
  const modulesManifest = organizationModules();
  const unknownField = canonicalOrganization(modulesManifest);
  unknownField.shadow_authority = true;
  const invalidPortPool = canonicalOrganization(modulesManifest);
  invalidPortPool.module_port_pool.end = 70_000;
  const nullPortPool = canonicalOrganization(modulesManifest);
  nullPortPool.module_port_pool = null;
  const reservedMetadata = canonicalOrganization(modulesManifest);
  reservedMetadata.organization.metadata.slug = "shadow";

  expect(validateAgainstSchema(unknownField, organizationManifestSchema, "organization").length).toBeGreaterThan(0);
  expect(resolveOrganizationRootDocuments({
    companyManifest: null,
    modulesManifest,
    canonicalManifest: unknownField,
  })).toMatchObject({
    state: "conflict",
    resource_count: 0,
    issues: expect.arrayContaining(["canonical_manifest_fields_invalid"]),
  });
  expect(resolveOrganizationRootDocuments({
    companyManifest: null,
    modulesManifest,
    canonicalManifest: invalidPortPool,
  })).toMatchObject({
    state: "conflict",
    resource_count: 0,
    issues: expect.arrayContaining(["canonical_module_port_pool_invalid"]),
  });
  expect(validateAgainstSchema(invalidPortPool, organizationManifestSchema, "organization").length).toBeGreaterThan(0);
  expect(validateAgainstSchema(nullPortPool, organizationManifestSchema, "organization").length).toBeGreaterThan(0);
  expect(resolveOrganizationRootDocuments({
    companyManifest: null,
    modulesManifest,
    canonicalManifest: nullPortPool,
  })).toMatchObject({
    state: "conflict",
    resource_count: 0,
    issues: expect.arrayContaining(["canonical_module_port_pool_invalid"]),
  });
  expect(validateAgainstSchema(reservedMetadata, organizationManifestSchema, "organization").length).toBeGreaterThan(0);
  expect(resolveOrganizationRootDocuments({
    companyManifest: null,
    modulesManifest,
    canonicalManifest: reservedMetadata,
  })).toMatchObject({
    state: "conflict",
    resource_count: 0,
    issues: expect.arrayContaining(["canonical_organization_metadata_reserved_field"]),
  });

  const invalidLegacyPortPool = legacyOrganization();
  invalidLegacyPortPool.module_port_pool = { start: 70_000, end: 5 };
  expect(resolveOrganizationRootDocuments({
    companyManifest: invalidLegacyPortPool,
    modulesManifest,
    canonicalManifest: null,
  })).toMatchObject({
    state: "conflict",
    resource_count: 0,
    issues: expect.arrayContaining(["legacy_module_port_pool_invalid"]),
  });
});

test("malformed repository slots stay inside the conflict state instead of throwing", () => {
  const validModules = organizationModules();
  const canonical = canonicalOrganization(validModules);
  const projected = projectLegacyOrganizationManifest(canonical, validModules);
  const malformedModules = { ...validModules, module_slots: [{}] };

  expect(() => resolveOrganizationRootDocuments({
    companyManifest: projected,
    modulesManifest: malformedModules,
    canonicalManifest: canonical,
  })).not.toThrow();
  expect(resolveOrganizationRootDocuments({
    companyManifest: projected,
    modulesManifest: malformedModules,
    canonicalManifest: canonical,
  })).toMatchObject({
    state: "conflict",
    resource_count: 0,
    issues: expect.arrayContaining(["modules_manifest_slot_0_path_invalid"]),
  });
});

test("canonical compatibility window admits only manifests with a lossless legacy projection", () => {
  const modulesManifest = organizationModules();
  const metadataCollision = canonicalOrganization(modulesManifest);
  metadataCollision.organization.metadata.repository = "shadow";
  const nonMain = canonicalOrganization(modulesManifest);
  nonMain.root_repository.default_branch = "develop";
  const partialVerification = canonicalOrganization(modulesManifest);
  partialVerification.organization.forge_binding = {
    ...partialVerification.organization.forge_binding,
    binding_state: "verified",
    organization_id: "314957563",
  };
  const invalidRootLocator = canonicalOrganization(modulesManifest);
  invalidRootLocator.root_repository.locator = "not-a-coordinate";
  const gitSuffixedRootLocator = canonicalOrganization(modulesManifest);
  gitSuffixedRootLocator.root_repository.locator = "Example/Example_GEN3.git";
  const conflictingGovernance = canonicalOrganization(modulesManifest);
  conflictingGovernance.governance.default_branch = "develop";
  const invalidAccessAuthority = canonicalOrganization(modulesManifest);
  invalidAccessAuthority.governance.access_authority = "shadow-acl";
  const extensionBranchAlias = canonicalOrganization(modulesManifest);
  extensionBranchAlias.extensions.legacy.default_branch = "develop";
  const invalidOrganizationLocator = canonicalOrganization(modulesManifest);
  invalidOrganizationLocator.organization.forge_binding.locator = "My_Org";

  for (const [manifest, issue] of [
    [metadataCollision, "canonical_organization_metadata_reserved_field"],
    [nonMain, "canonical_compatibility_binding_invalid"],
    [partialVerification, "canonical_compatibility_binding_invalid"],
    [invalidRootLocator, "canonical_compatibility_binding_invalid"],
    [gitSuffixedRootLocator, "canonical_compatibility_binding_invalid"],
    [conflictingGovernance, "canonical_governance_authority_invalid"],
    [invalidAccessAuthority, "canonical_governance_authority_invalid"],
    [extensionBranchAlias, "canonical_extensions_reserved_field"],
    [invalidOrganizationLocator, "canonical_organization_binding_invalid"],
  ]) {
    expect(resolveOrganizationRootDocuments({
      companyManifest: null,
      modulesManifest,
      canonicalManifest: manifest,
    })).toMatchObject({
      state: "conflict",
      resource_count: 0,
      issues: expect.arrayContaining([issue]),
    });
  }

  const verified = canonicalOrganization(modulesManifest);
  verified.organization.forge_binding = {
    forge: "github",
    locator: "Example",
    binding_state: "verified",
    organization_id: "314957563",
  };
  verified.root_repository = {
    forge: "github",
    locator: "Example/Example_GEN3",
    default_branch: "main",
    binding_state: "verified",
    repository_id: "42424242",
  };
  verified.compatibility.legacy_projection.sha256 = organizationLegacyProjectionHash(verified, modulesManifest);
  const verifiedProjection = projectLegacyOrganizationManifest(verified, modulesManifest);
  expect(resolveOrganizationRootDocuments({
    companyManifest: verifiedProjection,
    modulesManifest,
    canonicalManifest: verified,
  })).toMatchObject({ state: "transition", resource_count: 1 });

  const localFirst = canonicalOrganization(modulesManifest);
  localFirst.root_repository = null;
  localFirst.compatibility.legacy_projection.sha256 = organizationLegacyProjectionHash(localFirst, modulesManifest);
  expect(validateAgainstSchema(localFirst, organizationManifestSchema, "organization")).toEqual([]);
  expect(resolveOrganizationRootDocuments({
    companyManifest: projectLegacyOrganizationManifest(localFirst, modulesManifest),
    modulesManifest,
    canonicalManifest: localFirst,
  })).toMatchObject({ state: "transition", resource_count: 1 });
});

test("same request and observations produce byte-identical result", () => {
  const observations = fixture({
    root: { presence: "present", resolverStatus: "supported", format: "legacy" },
  });
  expect(JSON.stringify(resolveOrganizationActivation({ request, observations }))).toBe(
    JSON.stringify(resolveOrganizationActivation({ request, observations: structuredClone(observations) })),
  );
});

function organizationModules() {
  return {
    organization_generation: "gen3",
    company: "example-org",
    github_org: "Example",
    module_slots: [{
      path: "workspace/knowledgebase",
      slug: "knowledgebase",
      teams: ["workspace"],
      description: "Organization knowledge and operating truth.",
      ui_exposure: "diagnostics-only",
      default_access: "expected",
      required_roles: ["*"],
      source_of_truth: "git-native",
      git: { url: "git@github.com:Example/knowledgebase.git", branch: "main" },
    }],
  };
}

function legacyOrganization({ kind = "organization" } = {}) {
  return {
    organization_generation: "gen3",
    organization_kind: kind,
    company: {
      slug: "example-org",
      display_name: "Example Organization",
      github_org: "Example",
      root_repository: "Example/Example_GEN3",
      repository: "git@github.com:Example/Example_GEN3.git",
      legal_name: "Example Organization Ltd.",
    },
    governance: { default_branch: "main", access_authority: "github" },
    module_port_pool: { start: 24000, end: 24099 },
    teams: [{ slug: "workspace", display_name: "Workspace", default: true }],
    layers: [{ path: "workspace", kind: "workspace", ownership: "manual" }],
    task_sources: [{ slug: "todo", kind: "todo-tasks-json", path: "TODO.tasks.json" }],
    doctor: { command: ["bun", "run", "doctor"], timeout_ms: 30_000 },
    business_context: { purpose: "fixture" },
    modules: [],
  };
}

function canonicalOrganization(modulesManifest, { kind = "organization" } = {}) {
  const legacy = legacyOrganization({ kind });
  const canonical = {
    schema_version: ORGANIZATION_MANIFEST_SCHEMA_VERSION,
    kind,
    organization: {
      slug: legacy.company.slug,
      display_name: legacy.company.display_name,
      forge_binding: {
        forge: "github",
        locator: legacy.company.github_org,
        binding_state: "unverified",
      },
      metadata: { legal_name: legacy.company.legal_name },
    },
    root_repository: {
      forge: "github",
      locator: legacy.company.root_repository,
      default_branch: "main",
      binding_state: "unverified",
    },
    manifests: { modules: "modules.manifest.json" },
    governance: legacy.governance,
    module_port_pool: legacy.module_port_pool,
    teams: legacy.teams,
    layers: legacy.layers,
    task_sources: legacy.task_sources,
    doctor: legacy.doctor,
    extensions: { legacy: { business_context: legacy.business_context } },
    compatibility: {
      legacy_projection: {
        path: "company.gen3.json",
        algorithm: ORGANIZATION_LEGACY_PROJECTION_HASH_ALGORITHM,
        sha256: `sha256:${"0".repeat(64)}`,
      },
    },
  };
  canonical.compatibility.legacy_projection.sha256 = organizationLegacyProjectionHash(canonical, modulesManifest);
  return canonical;
}

function report(options) {
  return resolveOrganizationActivation({ request, observations: fixture(options) });
}

function fixture({ owner = true, canCreate = true, app = {}, root = {} } = {}) {
  const presence = root.presence ?? "absent";
  const resolverStatus = root.resolverStatus
    ?? (presence === "present" ? "unsupported" : "not_applicable");
  const format = resolverStatus === "supported" ? (root.format ?? "legacy") : null;
  const appStatus = app.status ?? "installed";
  const selection = app.selection ?? "all";
  return {
    github: {
      principal: { id: "16311043", login: "example-owner" },
      organization: {
        id: "314957563",
        login: "Example",
        viewer_is_owner: owner,
        viewer_can_create_repositories: canCreate,
      },
    },
    github_app: appStatus === "installed"
      ? {
          status: "installed",
          installation_id: "155781771",
          repository_selection: selection,
          root_access: app.rootAccess ?? (selection === "all" ? "included" : "unverified"),
        }
      : {
          status: appStatus,
          installation_id: null,
          repository_selection: null,
          root_access: "unverified",
        },
    root_repository: {
      presence,
      id: presence === "absent" ? null : "42424242",
      name: "Example_GEN3",
      full_name: "Example/Example_GEN3",
      default_branch: presence === "absent" ? null : "main",
      viewer_can_push: presence === "absent" ? null : (root.canPush ?? true),
      candidate_count: root.candidateCount ?? 0,
      resolver: {
        status: resolverStatus,
        format,
        reason: root.candidateCount
          ? "canonical_root_candidate_conflict"
          : resolverStatus === "supported"
            ? `${format}_supported`
            : presence === "present"
              ? "legacy_identity_pair_invalid"
              : `root_repository_${presence}`,
      },
    },
  };
}
