import { describe, expect, test } from "bun:test";

import { validateAgainstSchema } from "../runtime/json-schema-mini.mjs";
import organizationManifestSchema from "../lazurio.organization.v1.schema.json";
import {
  MICROSOFT365_APPS,
  newOrganizationSettings,
  ORGANIZATION_SETTINGS_CONTRACT_VERSION,
  ORGANIZATION_SETTINGS_DASHBOARD_KEYS,
  ORGANIZATION_SETTINGS_ISSUE_CODES,
  ORGANIZATION_SETTINGS_KEYS,
  ORGANIZATION_SETTINGS_STATUSES,
  resolveOrganizationSettings,
} from "./organization-settings-lib.mjs";

const canonicalSource = "lazurio.organization.json";
const microsoftKeys = [
  "integrations.microsoft365.tenant_id",
  "integrations.microsoft365.client_id",
  "integrations.microsoft365.apps",
  "integrations.microsoft365.callbacks",
];
const ungovernedMicrosoft = microsoftKeys.map((key) => ({ key, governed: false, value: null }));
const tenantId = "11111111-2222-4333-8444-aaaaaaaaaaaa";
const clientId = "11111111-2222-4333-8444-bbbbbbbbbbbb";
const callback = "https://launchpad.machine-1.example-org.lazurio.io/api/integrations/oauth/callback";
const manyCallbacks = (count) =>
  Array.from({ length: count }, (_, index) => `https://launchpad.machine-${index}.example-org.lazurio.io/api/integrations/oauth/callback`);
const microsoft365 = Object.freeze({
  tenant_id: tenantId,
  client_id: clientId,
  apps: ["outlook", "one_drive", "share_point"],
  callbacks: [callback],
});

describe("Organization settings contract (decision 0194, DEV-6653 C1)", () => {
  test("names one closed vocabulary", () => {
    expect(ORGANIZATION_SETTINGS_CONTRACT_VERSION).toBe("lazurio.organization.settings.v1");
    expect(ORGANIZATION_SETTINGS_STATUSES).toEqual(["absent", "valid", "invalid", "unavailable"]);
    expect(ORGANIZATION_SETTINGS_ISSUE_CODES).toEqual([
      "settings_field_missing",
      "settings_field_unknown",
      "settings_type_invalid",
      "settings_value_invalid",
    ]);
    expect(ORGANIZATION_SETTINGS_KEYS).toEqual(["integrations.composio.allowed", ...microsoftKeys, "integrations.chatgpt_apps.allowed"]);
    expect(ORGANIZATION_SETTINGS_DASHBOARD_KEYS).toEqual(["access_requests.enabled"]);
    expect(MICROSOFT365_APPS).toEqual(["outlook", "one_drive", "share_point"]);
    expect(Object.isFrozen(ORGANIZATION_SETTINGS_KEYS)).toBe(true);
    expect(Object.isFrozen(ORGANIZATION_SETTINGS_DASHBOARD_KEYS)).toBe(true);
  });

  test("an absent section means the Organization governs nothing and each Environment decides", () => {
    expect(settingsOf(manifest())).toEqual({
      contract_version: ORGANIZATION_SETTINGS_CONTRACT_VERSION,
      status: "absent",
      source: canonicalSource,
      values: {},
      effective: [{ key: "integrations.composio.allowed", governed: false, value: null }, ...ungovernedMicrosoft, { key: "integrations.chatgpt_apps.allowed", governed: false, value: null }],
      issues: [],
    });
  });

  test("every level is optional and only declared keys are governed", () => {
    for (const settings of [{}, { integrations: {} }]) {
      expect(settingsOf(manifest(settings))).toEqual({
        contract_version: ORGANIZATION_SETTINGS_CONTRACT_VERSION,
        status: "valid",
        source: canonicalSource,
        values: settings,
        effective: [{ key: "integrations.composio.allowed", governed: false, value: null }, ...ungovernedMicrosoft, { key: "integrations.chatgpt_apps.allowed", governed: false, value: null }],
        issues: [],
      });
    }
    for (const allowed of [false, true]) {
      const settings = { integrations: { composio: { allowed } } };
      expect(settingsOf(manifest(settings))).toEqual({
        contract_version: ORGANIZATION_SETTINGS_CONTRACT_VERSION,
        status: "valid",
        source: canonicalSource,
        values: settings,
        effective: [{ key: "integrations.composio.allowed", governed: true, value: allowed }, ...ungovernedMicrosoft, { key: "integrations.chatgpt_apps.allowed", governed: false, value: null }],
        issues: [],
      });
    }
  });

  test("ChatGPT apps are governed only when an Organization writes them (decision 0162, addendum 2026-10-27)", () => {
    for (const allowed of [false, true]) {
      const settings = { integrations: { chatgpt_apps: { allowed } } };
      expect(settingsOf(manifest(settings))).toEqual({
        contract_version: ORGANIZATION_SETTINGS_CONTRACT_VERSION,
        status: "valid",
        source: canonicalSource,
        values: settings,
        effective: [
          { key: "integrations.composio.allowed", governed: false, value: null },
          ...ungovernedMicrosoft,
          { key: "integrations.chatgpt_apps.allowed", governed: true, value: allowed },
        ],
        issues: [],
      });
    }
    for (const [settings, expected] of [
      [{ integrations: { chatgpt_apps: {} } }, [issue("settings_field_missing", "/settings/integrations/chatgpt_apps/allowed")]],
      [{ integrations: { chatgpt_apps: { allowed: "true" } } }, [issue("settings_type_invalid", "/settings/integrations/chatgpt_apps/allowed")]],
      [{ integrations: { chatgptApps: { allowed: true } } }, [issue("settings_field_unknown", "/settings/integrations/chatgptApps")]],
    ]) {
      expect(settingsOf(manifest(settings))).toMatchObject({ status: "invalid", values: null, effective: null, issues: expected });
    }
  });

  test("closed objects and exact types are reported precisely with JSON Pointers", () => {
    const cases = [
      [null, [issue("settings_type_invalid", "/settings")]],
      [[], [issue("settings_type_invalid", "/settings")]],
      ["off", [issue("settings_type_invalid", "/settings")]],
      [{ policies: {} }, [issue("settings_field_unknown", "/settings/policies")]],
      [{ integrations: null }, [issue("settings_type_invalid", "/settings/integrations")]],
      [{ integrations: { slack: {} } }, [issue("settings_field_unknown", "/settings/integrations/slack")]],
      [{ integrations: { composio: true } }, [issue("settings_type_invalid", "/settings/integrations/composio")]],
      [{ integrations: { composio: {} } }, [issue("settings_field_missing", "/settings/integrations/composio/allowed")]],
      [
        { integrations: { composio: { allowed: "false" } } },
        [issue("settings_type_invalid", "/settings/integrations/composio/allowed")],
      ],
      [
        { integrations: { composio: { allowed: 0 } } },
        [issue("settings_type_invalid", "/settings/integrations/composio/allowed")],
      ],
      [
        { integrations: { composio: { allowed: null } } },
        [issue("settings_type_invalid", "/settings/integrations/composio/allowed")],
      ],
      [
        { integrations: { composio: { allowed: false, mode: "organization" } } },
        [issue("settings_field_unknown", "/settings/integrations/composio/mode")],
      ],
      [{ "a/b~c": 1 }, [issue("settings_field_unknown", "/settings/a~1b~0c")]],
    ];
    for (const [settings, issues] of cases) {
      expect(settingsOf(manifest(settings)), JSON.stringify(settings)).toEqual({
        contract_version: ORGANIZATION_SETTINGS_CONTRACT_VERSION,
        status: "invalid",
        source: canonicalSource,
        values: null,
        effective: null,
        issues,
      });
    }
  });

  test("an invalid section is never partially applied and lists every issue in a stable order", () => {
    const settings = {
      zeta: true,
      integrations: { composio: { mode: "x" }, alpha: 1 },
      beta: false,
    };
    const reordered = {
      beta: false,
      integrations: { alpha: 1, composio: { mode: "x" } },
      zeta: true,
    };
    const expected = [
      issue("settings_field_unknown", "/settings/beta"),
      issue("settings_field_unknown", "/settings/integrations/alpha"),
      issue("settings_field_missing", "/settings/integrations/composio/allowed"),
      issue("settings_field_unknown", "/settings/integrations/composio/mode"),
      issue("settings_field_unknown", "/settings/zeta"),
    ];
    const first = settingsOf(manifest(settings));
    expect(first).toMatchObject({ status: "invalid", values: null, effective: null, issues: expected });
    expect(JSON.stringify(settingsOf(manifest(reordered)))).toBe(JSON.stringify(first));
  });

  test("a legacy root governs nothing; a root without a readable authority is unavailable", () => {
    expect(resolveOrganizationSettings({ authority: "legacy", canonicalManifest: null })).toEqual({
      contract_version: ORGANIZATION_SETTINGS_CONTRACT_VERSION,
      status: "absent",
      source: null,
      values: {},
      effective: [{ key: "integrations.composio.allowed", governed: false, value: null }, ...ungovernedMicrosoft, { key: "integrations.chatgpt_apps.allowed", governed: false, value: null }],
      issues: [],
    });
    for (const input of [
      { authority: null, canonicalManifest: manifest({ integrations: { composio: { allowed: false } } }) },
      { authority: "canonical", canonicalManifest: null },
      { authority: "canonical", canonicalManifest: ["not", "an", "object"] },
    ]) {
      expect(resolveOrganizationSettings(input)).toEqual({
        contract_version: ORGANIZATION_SETTINGS_CONTRACT_VERSION,
        status: "unavailable",
        source: null,
        values: null,
        effective: null,
        issues: [],
      });
    }
  });

  test("the result is a deeply frozen copy of the declared section", () => {
    const document = manifest({ integrations: { composio: { allowed: false } } });
    const result = settingsOf(document);
    document.settings.integrations.composio.allowed = true;
    expect(result.values).toEqual({ integrations: { composio: { allowed: false } } });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.values.integrations.composio)).toBe(true);
    expect(Object.isFrozen(result.effective[0])).toBe(true);
  });

  test("a new Organization starts with Composio off (decision 0162, addendum 2026-10-09)", () => {
    const first = newOrganizationSettings();
    expect(first).toEqual({ integrations: { composio: { allowed: false } } });
    first.integrations.composio.allowed = true;
    expect(newOrganizationSettings()).toEqual({ integrations: { composio: { allowed: false } } });
    expect(settingsOf(manifest(newOrganizationSettings()))).toMatchObject({
      status: "valid",
      effective: [{ key: "integrations.composio.allowed", governed: true, value: false }, ...ungovernedMicrosoft, { key: "integrations.chatgpt_apps.allowed", governed: false, value: null }],
    });
  });

  test("the Microsoft 365 company app is governed as a whole by its identifiers (decision 0162, addendum 2026-10-14)", () => {
    const settings = { integrations: { composio: { allowed: false }, microsoft365 } };
    expect(settingsOf(manifest(settings))).toEqual({
      contract_version: ORGANIZATION_SETTINGS_CONTRACT_VERSION,
      status: "valid",
      source: canonicalSource,
      values: settings,
      effective: [
        { key: "integrations.composio.allowed", governed: true, value: false },
        { key: "integrations.microsoft365.tenant_id", governed: true, value: tenantId },
        { key: "integrations.microsoft365.client_id", governed: true, value: clientId },
        { key: "integrations.microsoft365.apps", governed: true, value: ["outlook", "one_drive", "share_point"] },
        { key: "integrations.microsoft365.callbacks", governed: true, value: [callback] },
        { key: "integrations.chatgpt_apps.allowed", governed: false, value: null },
      ],
      issues: [],
    });
    // One app is enough, and no callback means every Environment signs in
    // through Executor's always registered localhost callback in the Environment browser.
    const minimal = { integrations: { microsoft365: { ...microsoft365, apps: ["share_point"], callbacks: [] } } };
    expect(settingsOf(manifest(minimal))).toMatchObject({ status: "valid", values: minimal });
    const full = { integrations: { microsoft365: { ...microsoft365, callbacks: manyCallbacks(255) } } };
    expect(settingsOf(manifest(full))).toMatchObject({ status: "valid", values: full });
  });

  test("Microsoft 365 values are checked exactly and reported with JSON Pointers", () => {
    const base = "/settings/integrations/microsoft365";
    const cases = [
      [{ ...microsoft365, tenant_id: undefined }, [issue("settings_field_missing", `${base}/tenant_id`)]],
      [withoutKeys("callbacks"), [issue("settings_field_missing", `${base}/callbacks`)]],
      [{ ...microsoft365, tenant_id: "example.onmicrosoft.com" }, [issue("settings_value_invalid", `${base}/tenant_id`)]],
      [{ ...microsoft365, client_id: clientId.toUpperCase() }, [issue("settings_value_invalid", `${base}/client_id`)]],
      [{ ...microsoft365, client_id: 42 }, [issue("settings_type_invalid", `${base}/client_id`)]],
      [{ ...microsoft365, apps: [] }, [issue("settings_value_invalid", `${base}/apps`)]],
      [{ ...microsoft365, apps: "outlook" }, [issue("settings_type_invalid", `${base}/apps`)]],
      [{ ...microsoft365, apps: ["outlook", "gmail"] }, [issue("settings_value_invalid", `${base}/apps/1`)]],
      [{ ...microsoft365, apps: ["outlook", "microsoft_teams"] }, [issue("settings_value_invalid", `${base}/apps/1`)]],
      [{ ...microsoft365, apps: ["outlook", "outlook"] }, [issue("settings_value_invalid", `${base}/apps/1`)]],
      [{ ...microsoft365, apps: [null] }, [issue("settings_type_invalid", `${base}/apps/0`)]],
      [{ ...microsoft365, callbacks: [callback, callback] }, [issue("settings_value_invalid", `${base}/callbacks/1`)]],
      [{ ...microsoft365, callbacks: callback }, [issue("settings_type_invalid", `${base}/callbacks`)]],
      // Entra allows 256 redirect URIs per app and the localhost callback takes one.
      [{ ...microsoft365, callbacks: manyCallbacks(256) }, [issue("settings_value_invalid", `${base}/callbacks`)]],
      ...[
        "http://launchpad.machine-1.example-org.lazurio.io/api/integrations/oauth/callback",
        "http://localhost",
        "https://launchpad.machine-1.example-org.lazurio.io/api/integrations/oauth/callback?x=1",
        "https://launchpad.machine-1.example-org.lazurio.io:8443/api/integrations/oauth/callback",
        "https://Launchpad.machine-1.example-org.lazurio.io/api/integrations/oauth/callback",
        "https://*.example-org.lazurio.io/api/integrations/oauth/callback",
        "https://launchpad.machine-1.example-org.lazurio.io/",
        `https://${"a".repeat(60)}.${"b".repeat(60)}.${"c".repeat(60)}.${"d".repeat(40)}.example.com/api/integrations/oauth/callback`,
        // Only a hosted work Launchpad may receive the authorization response.
        "https://attacker.example/api/integrations/oauth/callback",
        "https://launchpad.machine-1.example-org.lazurio.io.attacker.example/api/integrations/oauth/callback",
        "https://launchpad.example-org.lazurio.io/api/integrations/oauth/callback",
        "https://app.machine-1.example-org.lazurio.io/api/integrations/oauth/callback",
        "https://launchpad.a.b.example-org.lazurio.io/api/integrations/oauth/callback",
      ].map((value) => [{ ...microsoft365, callbacks: [value] }, [issue("settings_value_invalid", `${base}/callbacks/0`)]]),
    ];
    for (const [value, issues] of cases) {
      const settings = { integrations: { microsoft365: JSON.parse(JSON.stringify(value)) } };
      expect(settingsOf(manifest(settings)), JSON.stringify(value)).toMatchObject({
        status: "invalid",
        values: null,
        effective: null,
        issues,
      });
    }
  });

  test("the Microsoft 365 setting refuses every secret-like field: the company app is a public client", () => {
    const base = "/settings/integrations/microsoft365";
    for (const key of ["client_secret", "secret", "password", "certificate", "token", "refresh_token", "secret_ref"]) {
      const settings = { integrations: { microsoft365: { ...microsoft365, [key]: "value" } } };
      expect(settingsOf(manifest(settings)), key).toMatchObject({
        status: "invalid",
        values: null,
        issues: [issue("settings_field_unknown", `${base}/${key}`)],
      });
      expect(validateAgainstSchema(manifest(settings), organizationManifestSchema, "organization").length, key)
        .toBeGreaterThan(0);
    }
  });

  test("access requests are the Dashboard's own setting: validated, never reported (decision 0204, DEV-6668 M8)", () => {
    for (const enabled of [true, false]) {
      const settings = { access_requests: { enabled } };
      expect(settingsOf(manifest(settings)), String(enabled)).toEqual({
        contract_version: ORGANIZATION_SETTINGS_CONTRACT_VERSION,
        status: "valid",
        source: canonicalSource,
        values: settings,
        effective: [{ key: "integrations.composio.allowed", governed: false, value: null }, ...ungovernedMicrosoft, { key: "integrations.chatgpt_apps.allowed", governed: false, value: null }],
        issues: [],
      });
    }
    // Beside it every other setting still parses and is reported as before.
    const settings = {
      integrations: { composio: { allowed: true }, microsoft365 },
      access_requests: { enabled: true },
    };
    expect(settingsOf(manifest(settings))).toEqual({
      contract_version: ORGANIZATION_SETTINGS_CONTRACT_VERSION,
      status: "valid",
      source: canonicalSource,
      values: settings,
      effective: [
        { key: "integrations.composio.allowed", governed: true, value: true },
        { key: "integrations.microsoft365.tenant_id", governed: true, value: tenantId },
        { key: "integrations.microsoft365.client_id", governed: true, value: clientId },
        { key: "integrations.microsoft365.apps", governed: true, value: ["outlook", "one_drive", "share_point"] },
        { key: "integrations.microsoft365.callbacks", governed: true, value: [callback] },
        { key: "integrations.chatgpt_apps.allowed", governed: false, value: null },
      ],
      issues: [],
    });
  });

  test("access requests are a closed object with a required boolean", () => {
    const base = "/settings/access_requests";
    const cases = [
      [{ access_requests: {} }, [issue("settings_field_missing", `${base}/enabled`)]],
      [{ access_requests: { enabled: "yes" } }, [issue("settings_type_invalid", `${base}/enabled`)]],
      [{ access_requests: { enabled: 1 } }, [issue("settings_type_invalid", `${base}/enabled`)]],
      [{ access_requests: { enabled: null } }, [issue("settings_type_invalid", `${base}/enabled`)]],
      [{ access_requests: { enabled: true, team: "guests" } }, [issue("settings_field_unknown", `${base}/team`)]],
      [{ access_requests: true }, [issue("settings_type_invalid", base)]],
      // An invalid leaf withholds the whole section, Composio included.
      [
        { integrations: { composio: { allowed: true } }, access_requests: { enabled: "yes" } },
        [issue("settings_type_invalid", `${base}/enabled`)],
      ],
    ];
    for (const [settings, issues] of cases) {
      expect(settingsOf(manifest(settings)), JSON.stringify(settings)).toEqual({
        contract_version: ORGANIZATION_SETTINGS_CONTRACT_VERSION,
        status: "invalid",
        source: canonicalSource,
        values: null,
        effective: null,
        issues,
      });
    }
  });

  test("the manifest schema and Core pin one settings contract", () => {
    expect(organizationManifestSchema.properties.settings).toEqual({ $ref: "#/$defs/organizationSettings" });
    expect(organizationManifestSchema.required).not.toContain("settings");
    expect(schemaLeafKeys(organizationManifestSchema.$defs.organizationSettings, [])).toEqual([
      ...ORGANIZATION_SETTINGS_KEYS,
      ...ORGANIZATION_SETTINGS_DASHBOARD_KEYS,
    ]);
    expect(validateAgainstSchema(manifest(), organizationManifestSchema, "organization")).toEqual([]);

    const documents = [
      {},
      { integrations: {} },
      { integrations: { composio: { allowed: false } } },
      { integrations: { composio: { allowed: true } } },
      null,
      [],
      { policies: {} },
      { integrations: null },
      { integrations: { slack: {} } },
      { integrations: { composio: {} } },
      { integrations: { composio: { allowed: "false" } } },
      { integrations: { composio: { allowed: false, mode: "organization" } } },
      { integrations: { microsoft365 } },
      { integrations: { composio: { allowed: true }, microsoft365: { ...microsoft365, apps: ["outlook"], callbacks: [] } } },
      { integrations: { microsoft365: {} } },
      { integrations: { microsoft365: withoutKeys("apps") } },
      { integrations: { microsoft365: { ...microsoft365, tenant_id: tenantId.toUpperCase() } } },
      { integrations: { microsoft365: { ...microsoft365, apps: [] } } },
      { integrations: { microsoft365: { ...microsoft365, apps: ["outlook", "outlook"] } } },
      { integrations: { microsoft365: { ...microsoft365, apps: ["microsoft_teams"] } } },
      { integrations: { microsoft365: { ...microsoft365, callbacks: [callback, callback] } } },
      { integrations: { microsoft365: { ...microsoft365, callbacks: ["http://localhost"] } } },
      { integrations: { microsoft365: { ...microsoft365, callbacks: [`${callback}?x=1`] } } },
      { integrations: { microsoft365: { ...microsoft365, callbacks: [`https://${"a".repeat(240)}.example.com/api/integrations/oauth/callback`] } } },
      { integrations: { microsoft365: { ...microsoft365, callbacks: ["https://attacker.example/api/integrations/oauth/callback"] } } },
      { integrations: { microsoft365: { ...microsoft365, callbacks: manyCallbacks(256) } } },
      { integrations: { microsoft365: { ...microsoft365, client_secret: "value" } } },
      { access_requests: { enabled: true } },
      { access_requests: { enabled: false } },
      { integrations: { composio: { allowed: false }, microsoft365 }, access_requests: { enabled: true } },
      { access_requests: {} },
      { access_requests: { enabled: "yes" } },
      { access_requests: { enabled: true, team: "guests" } },
      { access_requests: true },
    ];
    for (const settings of documents) {
      const coreValid = settingsOf(manifest(settings)).status === "valid";
      const schemaValid = validateAgainstSchema(manifest(settings), organizationManifestSchema, "organization").length === 0;
      expect(schemaValid, JSON.stringify(settings)).toBe(coreValid);
    }
  });
});

function settingsOf(canonicalManifest) {
  return resolveOrganizationSettings({ authority: "canonical", canonicalManifest });
}

function withoutKeys(...keys) {
  return Object.fromEntries(Object.entries(microsoft365).filter(([key]) => !keys.includes(key)));
}

function issue(code, path) {
  return { code, path };
}

// Leaf keys of the JSON schema settings tree, in declaration order, so the
// published schema cannot gain or lose a setting without Core. The Dashboard's
// own settings are declared last, after the ones Environments report.
function schemaLeafKeys(node, prefix) {
  if (node.type !== "object") return [prefix.join(".")];
  expect(node.additionalProperties).toBe(false);
  return Object.entries(node.properties).flatMap(([key, child]) => schemaLeafKeys(child, [...prefix, key]));
}

function manifest(settings) {
  return {
    schema_version: "lazurio.organization.v1",
    kind: "organization",
    organization: {
      slug: "example-org",
      display_name: "Example Organization",
      forge_binding: { forge: "github", locator: "Example", binding_state: "unverified" },
      metadata: {},
    },
    root_repository: {
      forge: "github",
      locator: "Example/Example_GEN3",
      default_branch: "main",
      binding_state: "unverified",
    },
    manifests: { modules: "modules.manifest.json" },
    ...(settings === undefined ? {} : { settings }),
    extensions: { legacy: {} },
    compatibility: {
      legacy_projection: {
        path: "company.gen3.json",
        algorithm: "sha256-canonical-json-v1",
        sha256: `sha256:${"0".repeat(64)}`,
      },
    },
  };
}
