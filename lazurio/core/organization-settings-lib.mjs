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
  "settings_value_invalid",
]);

/**
 * Microsoft 365 company app (decision 0162, addendum 2026-10-14): the parts
 * a connected account gets as one Integration (`outlook` is mail and
 * calendar). Teams joins in phase 2.
 */
export const MICROSOFT365_APPS = Object.freeze(["outlook", "one_drive", "share_point"]);

// Lowercase GUID, the form the Azure CLI prints for tenant and client ids.
const GUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// A work Environment's hosted Launchpad callback, exactly as registered at
// Microsoft: HTTPS on `launchpad.<machine>.<github-org-login>.lazurio.io`
// (the Organization URL contract), no port, query or fragment. Any other host
// would receive the authorization response, so it is refused.
const LAUNCHPAD_CALLBACK_PATTERN =
  /^https:\/\/launchpad\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?\.lazurio\.io\/api\/integrations\/oauth\/callback$/;
// Entra registers at most 256 redirect URIs per app; Executor's localhost
// callback always takes one of them.
const MICROSOFT365_MAX_CALLBACKS = 255;

// A Workspace tab of GEN4's Apps (LazurioPlatform decision F32, addendum of
// 2026-10-16): a name of 1 to 40 characters without control characters or
// space at either end, and the modules in it by id. The same patterns and
// bounds as LazurioPlatform's `organizationSettings`.
// biome-ignore lint/suspicious/noControlCharactersInRegex: the control characters are what it refuses.
const WORKSPACE_TAB_NAME_PATTERN = /^(?=[^\u0000-\u001f\u007f]{1,40}$)[^\s\u0000-\u001f\u007f](?:.*[^\s\u0000-\u001f\u007f])?$/;
const WORKSPACE_MODULE_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
const WORKSPACE_TABS_MAX = 12;
const WORKSPACE_TAB_MODULES_MAX = 500;

const CANONICAL_SOURCE = "lazurio.organization.json";

// The whole contract as one closed tree. The contract and its schema belong
// to LazurioPlatform (decision 0225): a new setting is added there first, in
// its reader and in `$defs.organizationSettings` of the schema, which this
// root pins as `lazurio.organization.v1.schema.json`. Core follows with the
// same leaf (organization-settings-lib.test.mjs holds both together), plus
// the consumers that apply and report it.
//
// `microsoft365` carries only identifiers that are not secrets (decision
// 0162, addendum 2026-10-14): the Organization's single-tenant Entra app is a
// public client, so no field may name a secret, and the closed tree refuses
// any other key.
//
// `chatgpt_apps` ("Aplikace z ChatGPT", decision 0162, addendum 2026-10-27):
// whether agents in the Organization's work and Team Environments may use the
// apps of the person's ChatGPT account for apps that Integrace do not have.
// Unlike `composio`, an ungoverned value means off on every Environment, so an
// Organization writes it only to allow them.
//
// `access_requests` ("Žádosti o přístup", decision 0204, addendum 2026-10-17
// afternoon, point b; plan DEV-6668 M8) is the Dashboard's own setting: Core
// validates it so an Organization that writes it keeps its other settings,
// but no Environment receives, applies or reports it, so it has no key in
// `ORGANIZATION_SETTINGS_KEYS`.
//
// `workspace.tabs` is the Organization's own tabs in GEN4's Apps, in order,
// each a name and the modules in it. The GEN3 Launchpad shows no tabs; Core
// validates and reports them so that an Organization that sets them keeps
// every other setting here too.
const SETTINGS_CONTRACT = objectNode({
  integrations: objectNode({
    composio: objectNode({ allowed: booleanLeaf() }, ["allowed"]),
    microsoft365: objectNode(
      {
        tenant_id: stringLeaf(GUID_PATTERN),
        client_id: stringLeaf(GUID_PATTERN),
        apps: arrayLeaf(enumItem(MICROSOFT365_APPS), { minItems: 1 }),
        callbacks: arrayLeaf(stringLeaf(LAUNCHPAD_CALLBACK_PATTERN), { maxItems: MICROSOFT365_MAX_CALLBACKS }),
      },
      ["tenant_id", "client_id", "apps", "callbacks"],
    ),
    chatgpt_apps: objectNode({ allowed: booleanLeaf() }, ["allowed"]),
  }),
  access_requests: dashboardOnly(objectNode({ enabled: booleanLeaf() }, ["enabled"])),
  workspace: objectNode(
    {
      tabs: arrayLeaf(
        objectNode(
          {
            name: stringLeaf(WORKSPACE_TAB_NAME_PATTERN),
            modules: arrayLeaf(stringLeaf(WORKSPACE_MODULE_PATTERN), { maxItems: WORKSPACE_TAB_MODULES_MAX }),
          },
          ["name", "modules"],
        ),
        { minItems: 1, maxItems: WORKSPACE_TABS_MAX },
      ),
    },
    ["tabs"],
  ),
});

const SETTINGS_LEAVES = leaves(SETTINGS_CONTRACT, [], true);

/** Dot-separated keys of every setting Environments apply, as reported per item to the Dashboard. */
export const ORGANIZATION_SETTINGS_KEYS = Object.freeze(
  SETTINGS_LEAVES.filter((leaf) => leaf.reported).map((leaf) => leaf.key),
);

/** Dot-separated keys of the Dashboard's own settings: validated here, never delivered to or reported by an Environment. */
export const ORGANIZATION_SETTINGS_DASHBOARD_KEYS = Object.freeze(
  SETTINGS_LEAVES.filter((leaf) => !leaf.reported).map((leaf) => leaf.key),
);

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
  if (issues.length === 0) workspaceIssues(canonicalManifest.settings, issues);
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
  if (node.kind === "string") {
    if (typeof value !== "string") issues.push({ code: "settings_type_invalid", path });
    else if (!node.pattern.test(value)) issues.push({ code: "settings_value_invalid", path });
    return;
  }
  if (node.kind === "enum") {
    if (typeof value !== "string") issues.push({ code: "settings_type_invalid", path });
    else if (!node.values.includes(value)) issues.push({ code: "settings_value_invalid", path });
    return;
  }
  if (node.kind === "array") {
    if (!Array.isArray(value)) {
      issues.push({ code: "settings_type_invalid", path });
      return;
    }
    if (value.length < node.minItems || value.length > node.maxItems) issues.push({ code: "settings_value_invalid", path });
    const seen = new Set();
    value.forEach((item, index) => {
      const itemPath = pointer(path, String(index));
      const before = issues.length;
      validateNode(item, node.items, itemPath, issues);
      if (issues.length === before && seen.has(item)) issues.push({ code: "settings_value_invalid", path: itemPath });
      seen.add(item);
    });
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

// What the closed tree cannot say about the tabs: two tabs never share a
// name (in NFC, letter case ignored), and a module is in one tab at most.
function workspaceIssues(settings, issues) {
  const tabs = settings.workspace?.tabs;
  if (tabs === undefined) return;
  const names = new Set();
  const modules = new Set();
  tabs.forEach((tab, index) => {
    const at = `/settings/workspace/tabs/${index}`;
    const name = tab.name.normalize("NFC").toLocaleLowerCase();
    if (names.has(name)) issues.push({ code: "settings_value_invalid", path: `${at}/name` });
    names.add(name);
    tab.modules.forEach((module, position) => {
      if (modules.has(module)) issues.push({ code: "settings_value_invalid", path: `${at}/modules/${position}` });
      modules.add(module);
    });
  });
}

function objectNode(fields, required = []) {
  return Object.freeze({
    kind: "object",
    fields: new Map(Object.entries(fields)),
    required: Object.freeze([...required]),
  });
}

// A setting of the Dashboard alone: validated like any other, never reported.
function dashboardOnly(node) {
  return Object.freeze({ ...node, reported: false });
}

function booleanLeaf() {
  return Object.freeze({ kind: "boolean" });
}

function stringLeaf(pattern) {
  return Object.freeze({ kind: "string", pattern });
}

function enumItem(values) {
  return Object.freeze({ kind: "enum", values });
}

// An array is one setting: its items are validated, never reported as keys.
// String items must be unique; an item may also be an object node (a tab).
function arrayLeaf(items, { minItems = 0, maxItems = Infinity } = {}) {
  return Object.freeze({ kind: "array", items, minItems, maxItems });
}

// Leaves in declaration order; a leaf under a Dashboard-only node is not reported.
function leaves(node, prefix, reported) {
  const here = reported && node.reported !== false;
  if (node.kind !== "object") return [{ key: prefix.join("."), reported: here }];
  return [...node.fields].flatMap(([key, child]) => leaves(child, [...prefix, key], here));
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
