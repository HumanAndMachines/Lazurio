// Organization settings: the optional, closed `settings` section of
// `lazurio.organization.json` (decision 0194; DEV-6653 contract C1).
//
// An absent value means the Organization does not govern it and every
// Environment decides for itself, as before. A present value governs every
// work Environment of the Organization; personal Environments ignore
// Organization settings. The section is excluded from the legacy compatibility
// projection and from the semantic hash, so editing it never regenerates
// `company.gen3.json` and never changes the Organization root state. An
// invalid section is never applied, not even in part: consumers keep their
// last applied version and report the issues.
//
// Pure: no filesystem, Git or network.

export const ORGANIZATION_SETTINGS_CONTRACT_VERSION = "lazurio.organization.settings.v1";
export const ORGANIZATION_SETTINGS_STATUSES = Object.freeze(["absent", "valid", "invalid", "unavailable"]);
export const ORGANIZATION_SETTINGS_ISSUE_CODES = Object.freeze([
  "settings_field_missing",
  "settings_field_unknown",
  "settings_type_invalid",
]);

const CANONICAL_SOURCE = "lazurio.organization.json";

// The whole contract as one closed tree. Adding an Organization setting adds
// one leaf here and the same leaf in `$defs.organizationSettings` of
// `lazurio.organization.v1.schema.json` (organization-settings-lib.test.mjs
// pins both), plus the consumers that apply and report it (decision 0194
// point 6).
const SETTINGS_CONTRACT = objectNode({
  integrations: objectNode({
    composio: objectNode({ allowed: booleanLeaf() }, ["allowed"]),
  }),
});

/** Dot-separated keys of every known setting, as reported per item to the Dashboard. */
export const ORGANIZATION_SETTINGS_KEYS = Object.freeze(leafKeys(SETTINGS_CONTRACT, []));

/**
 * The settings a new Organization starts with. Decision 0162 (addendum
 * 2026-10-09, point 4): a new Organization has Composio off; Organizations
 * that already use it keep an absent section and change nothing.
 */
export function newOrganizationSettings() {
  return { integrations: { composio: { allowed: false } } };
}

/**
 * Settings of one Organization root.
 *
 * `authority` names the document the root resolver reads: `canonical` when
 * `lazurio.organization.json` is the read authority (`transition`,
 * `projection_drift`, `current`), `legacy` for a root that only has the legacy
 * projection (it cannot declare settings, so it governs nothing) and `null`
 * when no document is a safe authority (`conflict`, `missing`).
 *
 * Statuses: `absent` (nothing governed), `valid` (`values` holds exactly the
 * declared keys), `invalid` (nothing from this document applies; `issues`
 * holds JSON Pointers into the manifest) and `unavailable` (no readable
 * authority; consumers keep what they last applied).
 */
export function resolveOrganizationSettings({ authority, canonicalManifest }) {
  if (authority === "legacy") return settingsResult({ status: "absent", source: null, values: {} });
  if (authority !== "canonical" || !isRecord(canonicalManifest)) {
    return settingsResult({ status: "unavailable", source: null, values: null });
  }
  if (!Object.hasOwn(canonicalManifest, "settings")) {
    return settingsResult({ status: "absent", source: CANONICAL_SOURCE, values: {} });
  }
  const issues = [];
  validateNode(canonicalManifest.settings, SETTINGS_CONTRACT, "/settings", issues);
  if (issues.length > 0) {
    return settingsResult({
      status: "invalid",
      source: CANONICAL_SOURCE,
      values: null,
      issues: issues.sort(compareIssues),
    });
  }
  return settingsResult({
    status: "valid",
    source: CANONICAL_SOURCE,
    values: structuredClone(canonicalManifest.settings),
  });
}

function settingsResult({ status, source, values, issues = [] }) {
  return freeze({
    contract_version: ORGANIZATION_SETTINGS_CONTRACT_VERSION,
    status,
    source,
    values,
    effective: values === null ? null : ORGANIZATION_SETTINGS_KEYS.map((key) => effectiveEntry(values, key)),
    issues,
  });
}

function effectiveEntry(values, key) {
  let node = values;
  for (const segment of key.split(".")) {
    if (!isRecord(node) || !Object.hasOwn(node, segment)) return { key, governed: false, value: null };
    node = node[segment];
  }
  return { key, governed: true, value: node };
}

function validateNode(value, node, path, issues) {
  if (node.kind === "boolean") {
    if (typeof value !== "boolean") issues.push({ code: "settings_type_invalid", path });
    return;
  }
  if (!isRecord(value)) {
    issues.push({ code: "settings_type_invalid", path });
    return;
  }
  for (const key of Object.keys(value)) {
    if (!node.fields.has(key)) issues.push({ code: "settings_field_unknown", path: pointer(path, key) });
  }
  for (const key of node.required) {
    if (!Object.hasOwn(value, key)) issues.push({ code: "settings_field_missing", path: pointer(path, key) });
  }
  for (const [key, child] of node.fields) {
    if (Object.hasOwn(value, key)) validateNode(value[key], child, pointer(path, key), issues);
  }
}

function objectNode(fields, required = []) {
  return Object.freeze({
    kind: "object",
    fields: new Map(Object.entries(fields)),
    required: Object.freeze([...required]),
  });
}

function booleanLeaf() {
  return Object.freeze({ kind: "boolean" });
}

function leafKeys(node, prefix) {
  if (node.kind !== "object") return [prefix.join(".")];
  return [...node.fields].flatMap(([key, child]) => leafKeys(child, [...prefix, key]));
}

// RFC 6901 JSON Pointer segment.
function pointer(path, key) {
  return `${path}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`;
}

function compareIssues(left, right) {
  if (left.path !== right.path) return left.path < right.path ? -1 : 1;
  return left.code < right.code ? -1 : left.code > right.code ? 1 : 0;
}

function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function freeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freeze(child);
  return Object.freeze(value);
}
