import { expect, test } from "bun:test";

import { validateAgainstSchema } from "../runtime/json-schema-mini.mjs";
import schema from "../organization-activation-report.v0.schema.json";
import {
  ORGANIZATION_ACTIVATION_ERROR_CODES,
  ORGANIZATION_ACTIVATION_NEXT_ACTIONS,
  ORGANIZATION_ACTIVATION_OUTCOMES,
  ORGANIZATION_ACTIVATION_REASON_CODES,
  createOrganizationActivationRequest,
  isValidOrganizationActivationObservations,
  isValidOrganizationActivationReport,
  organizationActivationError,
  organizationActivationExitCode,
  resolveOrganizationActivation,
  resolveOrganizationRootDocuments,
} from "./organization-activation-lib.mjs";
import { createOrganizationScaffold } from "./organization-scaffold-lib.mjs";

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

  expect(resolveOrganizationRootDocuments(input)).toEqual({
    status: "supported",
    format: "legacy",
    reason: "legacy_identity_pair_supported",
  });
  expect(resolveOrganizationRootDocuments({
    ...input,
    expectedOrganizationLogin: "RenamedExample",
  })).toMatchObject({ status: "unsupported", reason: "legacy_identity_pair_invalid" });
  expect(resolveOrganizationRootDocuments({
    ...input,
    canonicalManifest: { schema_version: "lazurio.organization.v1" },
  })).toEqual({
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

  expect(resolveOrganizationRootDocuments(input)).toMatchObject({ status: "supported", format: "legacy" });
  expect(resolveOrganizationRootDocuments({ ...input, expectedOrganizationId: "999" }))
    .toMatchObject({ status: "unsupported", reason: "legacy_identity_pair_invalid" });
  expect(resolveOrganizationRootDocuments({ ...input, expectedRepositoryId: "999" }))
    .toMatchObject({ status: "unsupported", reason: "legacy_identity_pair_invalid" });
});

test("same request and observations produce byte-identical result", () => {
  const observations = fixture({
    root: { presence: "present", resolverStatus: "supported", format: "legacy" },
  });
  expect(JSON.stringify(resolveOrganizationActivation({ request, observations }))).toBe(
    JSON.stringify(resolveOrganizationActivation({ request, observations: structuredClone(observations) })),
  );
});

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
