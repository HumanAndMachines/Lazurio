import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { validateAgainstSchema } from "../../runtime/json-schema-mini.mjs";
import canonicalSchema from "../../lazurio.organization.v1.schema.json";
import legacySchema from "../../schemas/company.gen3.schema.json";
import {
  organizationLegacyProjectionHash,
  organizationSemanticHash,
  projectLegacyOrganizationManifest,
  resolveOrganizationRootDocuments,
} from "../../core/organization-activation-lib.mjs";
import {
  deriveCanonicalOrganizationManifest,
  ORGANIZATION_CANONICAL_MANIFEST_FIELD_ORDER,
  reconcileLegacyModules,
} from "./derive-canonical-manifest.mjs";

const fixtureRoot = join(import.meta.dirname, "fixtures", "gen3-organization");

test("derivation is the exact inverse of the Core projection on a GEN3-shaped Organization", () => {
  const documents = fixtureDocuments();
  const legacy = resolveOrganizationRootDocuments({ ...documents, canonicalManifest: null });
  expect(legacy).toMatchObject({ state: "legacy", resource_count: 1, issues: [], warnings: [] });

  const derived = deriveCanonicalOrganizationManifest(documents);
  expect(derived.issues).toEqual([]);
  expect(derived.modulesReconciliation).toMatchObject({ legacy_entries: 4, reconciled: 4, unreconciled: [], field_conflicts: [], issues: [] });
  const canonical = derived.canonicalManifest;
  expect(Object.keys(canonical)).toEqual(ORGANIZATION_CANONICAL_MANIFEST_FIELD_ORDER.filter((key) => canonical[key] !== undefined));
  expect(validateAgainstSchema(canonical, canonicalSchema, "organization")).toEqual([]);
  expect(canonical).toMatchObject({
    schema_version: "lazurio.organization.v1",
    kind: "organization",
    organization: {
      slug: "Example-ai",
      display_name: "Example Organization",
      forge_binding: { forge: "github", locator: "Example-ai", binding_state: "verified", organization_id: "314957563" },
      metadata: {},
    },
    root_repository: {
      forge: "github",
      locator: "Example-ai/Example-ai_GEN3",
      default_branch: "main",
      binding_state: "verified",
      repository_id: "1276680840",
    },
    manifests: { modules: "modules.manifest.json" },
    module_port_pool: { start: 24200, end: 24299 },
  });
  expect(Object.keys(canonical.extensions.legacy).sort()).toEqual([
    "access_governance",
    "business_context",
    "colleague_overlays",
    "generation_policy",
    "glossary_contract",
    "source_of_truth_matrix",
    "template_sync_role",
  ]);
  expect(canonical.compatibility.legacy_projection.sha256)
    .toBe(organizationLegacyProjectionHash(canonical, documents.modulesManifest));

  // Round trip: canonical → projection resolves to `transition` with parity,
  // the same semantic hash as the legacy input and no issues.
  const projection = projectLegacyOrganizationManifest(canonical, documents.modulesManifest);
  expect(validateAgainstSchema(projection, legacySchema, "company.gen3.json")).toEqual([]);
  const transition = resolveOrganizationRootDocuments({
    canonicalManifest: canonical,
    companyManifest: projection,
    modulesManifest: documents.modulesManifest,
  });
  expect(transition).toMatchObject({ state: "transition", resource_count: 1, issues: [] });
  expect(transition.semantic_hash).toBe(legacy.semantic_hash);
  expect(organizationSemanticHash(transition.resource)).toBe(organizationSemanticHash(legacy.resource));

  // The original legacy file next to the derived canonical is drift, never a
  // second authority and never a conflict.
  expect(resolveOrganizationRootDocuments({ ...documents, canonicalManifest: canonical }).state).toBe("projection_drift");

  // Old-reader shape: productionspace entries carry no Team field and the
  // planned slot without a repository is not projected.
  const documentation = projection.modules.find((entry) => entry.path === "productionspace/documentation");
  expect(documentation).toBeDefined();
  expect(Object.hasOwn(documentation, "workspace")).toBe(false);
  expect(Object.hasOwn(documentation, "teams")).toBe(false);
  expect(projection.modules.some((entry) => entry.path === "workspace/brainstorm")).toBe(false);
  expect(projection.modules.every((entry) => typeof entry.repo === "string")).toBe(true);
});

test("derivation is deterministic across key order of the legacy input", () => {
  const documents = fixtureDocuments();
  const reordered = {
    ...documents,
    companyManifest: Object.fromEntries(Object.entries(documents.companyManifest).reverse()),
  };
  expect(JSON.stringify(deriveCanonicalOrganizationManifest(reordered).canonicalManifest))
    .toBe(JSON.stringify(deriveCanonicalOrganizationManifest(documents).canonicalManifest));
});

test("legacy modules[] must reconcile into modules.manifest.json or the derivation refuses", () => {
  const documents = fixtureDocuments();
  const foreign = structuredClone(documents);
  foreign.companyManifest.modules.push({
    slug: "ghost",
    path: "workspace/ghost",
    category: "knowledge",
    source_of_truth: "git-native",
    access: { default: "expected", roles: ["*"] },
    repo: "git@github.com:Example-ai/ghost.git",
  });
  const foreignResult = deriveCanonicalOrganizationManifest(foreign);
  expect(foreignResult.modulesReconciliation).toMatchObject({
    unreconciled: ["workspace/ghost"],
    issues: ["legacy_modules_unreconciled"],
  });
  // The canonical document is still derivable; only the plan blocks.
  expect(foreignResult.canonicalManifest).not.toBeNull();

  const drifted = structuredClone(documents);
  drifted.companyManifest.modules[0].notes = "Edited only in the deprecated inventory.";
  expect(deriveCanonicalOrganizationManifest(drifted).modulesReconciliation).toMatchObject({
    field_conflicts: [{ path: "workspace/knowledgebase", fields: ["notes"] }],
    issues: ["legacy_modules_field_conflict"],
  });

  expect(reconcileLegacyModules({
    companyManifest: { modules: [] },
    canonicalManifest: null,
    modulesManifest: documents.modulesManifest,
  })).toMatchObject({ legacy_entries: 0, reconciled: 0, issues: [] });
});

test("malformed, conflicting or non-main legacy roots fail closed with resolver issue codes", () => {
  const documents = fixtureDocuments();

  const invalid = deriveCanonicalOrganizationManifest({ ...documents, companyManifest: { invalid: true } });
  expect(invalid.canonicalManifest).toBeNull();
  expect(invalid.issues).toContain("legacy_resolution_conflict");

  const missingModules = deriveCanonicalOrganizationManifest({ ...documents, modulesManifest: null });
  expect(missingModules.canonicalManifest).toBeNull();
  expect(missingModules.issues).toContain("modules_manifest_missing");

  const nonMain = structuredClone(documents);
  nonMain.companyManifest.governance.default_branch = "develop";
  const nonMainResult = deriveCanonicalOrganizationManifest(nonMain);
  expect(nonMainResult.canonicalManifest).toBeNull();
  // The legacy resolver already refuses a non-main root branch; derivation
  // never gets to invent a canonical document for it.
  expect(nonMainResult.issues).toEqual(["legacy_resolution_conflict", "organization_root_branch_conflict"]);

  const template = structuredClone(documents);
  template.companyManifest.organization_kind = "template";
  const templateResult = deriveCanonicalOrganizationManifest(template);
  expect(templateResult.canonicalManifest?.kind).toBe("template");
});

function fixtureDocuments() {
  return {
    companyManifest: JSON.parse(readFileSync(join(fixtureRoot, "company.gen3.json"), "utf8")),
    modulesManifest: JSON.parse(readFileSync(join(fixtureRoot, "modules.manifest.json"), "utf8")),
    canonicalManifest: null,
    documentIssues: [],
  };
}
