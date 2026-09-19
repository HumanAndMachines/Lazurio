// Migration-only code (DEV-6512, decision 0145). Legacy `company.gen3.json`
// → canonical `lazurio.organization.json`. Delete this folder once every
// Organization root is `current`; nothing in the forward-direction runtime
// may import it.

import {
  ORGANIZATION_LEGACY_PROJECTION_HASH_ALGORITHM,
  ORGANIZATION_MANIFEST_SCHEMA_VERSION,
  organizationLegacyProjectionHash,
  projectLegacyOrganizationManifest,
  resolveOrganizationRootDocuments,
} from "../../core/organization-activation-lib.mjs";
import { normalizeOrganizationSlotPath } from "../../core/organization-slot-scope-lib.mjs";

export const ORGANIZATION_CANONICAL_MANIFEST_FIELD_ORDER = Object.freeze([
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
]);

/**
 * Exact inverse of Core `projectLegacyOrganizationManifest` for one legacy
 * root. The canonical manifest is not re-derived field by field: it is the
 * resolver's own normalized legacy resource re-shaped into the authored
 * `lazurio.organization.v1` document plus the declared projection hash. The
 * resolver therefore proves lossless mapping by construction — the derived
 * manifest resolves to the same semantic hash as the legacy input, or the
 * derivation refuses with the resolver's issue codes.
 */
export function deriveCanonicalOrganizationManifest({ companyManifest, modulesManifest }) {
  const legacy = resolveOrganizationRootDocuments({
    companyManifest,
    modulesManifest,
    canonicalManifest: null,
  });
  if (legacy.state !== "legacy" || legacy.resource === null) {
    return {
      canonicalManifest: null,
      semanticHash: null,
      issues: [`legacy_resolution_${legacy.state}`, ...legacy.issues],
      modulesReconciliation: emptyReconciliation(),
    };
  }
  const resource = structuredClone(legacy.resource);
  const canonical = {
    schema_version: ORGANIZATION_MANIFEST_SCHEMA_VERSION,
    kind: resource.kind,
    organization: resource.organization,
    root_repository: resource.root_repository,
    manifests: { modules: "modules.manifest.json" },
    ...pick(resource, ["module_port_pool", "governance", "teams", "layers", "task_sources", "doctor"]),
    extensions: { legacy: resource.extensions.legacy },
    compatibility: {
      legacy_projection: {
        path: "company.gen3.json",
        algorithm: ORGANIZATION_LEGACY_PROJECTION_HASH_ALGORITHM,
        sha256: `sha256:${"0".repeat(64)}`,
      },
    },
  };
  const issues = [];
  let canonicalManifest = null;
  try {
    canonical.compatibility.legacy_projection.sha256 = organizationLegacyProjectionHash(canonical, modulesManifest);
    canonicalManifest = orderFields(canonical);
  } catch (error) {
    issues.push("canonical_projection_unavailable");
  }
  const modulesReconciliation = reconcileLegacyModules({ companyManifest, canonicalManifest, modulesManifest });
  if (canonicalManifest !== null) {
    const derived = resolveOrganizationRootDocuments({
      companyManifest: null,
      modulesManifest,
      canonicalManifest,
    });
    if (derived.state !== "current" || derived.semantic_hash !== legacy.semantic_hash) {
      issues.push(derived.state === "current" ? "lossy_mapping" : `derived_resolution_${derived.state}`);
      issues.push(...derived.issues);
    }
  }
  // Derivation issues make the canonical document unusable; reconciliation
  // issues keep it (so the plan can show the staged result) but block the
  // write in the planner.
  const unique = [...new Set(issues)].sort();
  return {
    canonicalManifest: unique.length === 0 ? canonicalManifest : null,
    semanticHash: legacy.semantic_hash,
    issues: unique,
    modulesReconciliation,
  };
}

/**
 * The deprecated duplicate inventory `company.gen3.json#modules[]` is never
 * copied. Every entry must already be reconciled into `modules.manifest.json`:
 * its path must be a declared slot and every field it carries must project
 * identically from that slot. Anything else would silently disappear from the
 * regenerated projection, so it blocks the migration instead.
 */
export function reconcileLegacyModules({ companyManifest, canonicalManifest, modulesManifest }) {
  const entries = Array.isArray(companyManifest?.modules) ? companyManifest.modules : [];
  const result = { ...emptyReconciliation(), legacy_entries: entries.length };
  if (entries.length === 0) return result;
  let projected = [];
  try {
    projected = canonicalManifest === null ? [] : projectLegacyOrganizationManifest(canonicalManifest, modulesManifest).modules;
  } catch {
    projected = [];
  }
  const projectedByPath = new Map(projected.map((entry) => [entry.path, entry]));
  for (const entry of entries) {
    const path = normalizeOrganizationSlotPath(entry?.path);
    const target = path === null ? undefined : projectedByPath.get(path);
    if (!target) {
      result.unreconciled.push(String(entry?.path ?? ""));
      continue;
    }
    const conflicts = Object.keys(entry ?? {})
      .filter((field) => canonicalJson(entry[field]) !== canonicalJson(target[field]))
      .sort();
    if (conflicts.length > 0) {
      result.field_conflicts.push({ path, fields: conflicts });
      continue;
    }
    result.reconciled += 1;
  }
  if (result.unreconciled.length > 0) result.issues.push("legacy_modules_unreconciled");
  if (result.field_conflicts.length > 0) result.issues.push("legacy_modules_field_conflict");
  return result;
}

function emptyReconciliation() {
  return { legacy_entries: 0, reconciled: 0, unreconciled: [], field_conflicts: [], issues: [] };
}

function pick(value, keys) {
  return Object.fromEntries(keys.filter((key) => value[key] !== undefined).map((key) => [key, value[key]]));
}

function orderFields(manifest) {
  return Object.fromEntries(ORGANIZATION_CANONICAL_MANIFEST_FIELD_ORDER
    .filter((key) => manifest[key] !== undefined)
    .map((key) => [key, manifest[key]]));
}

function canonicalJson(value) {
  if (value === undefined) return undefined;
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortKeys(value[key])]));
}
