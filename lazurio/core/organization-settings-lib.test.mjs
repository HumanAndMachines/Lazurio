import { describe, expect, test } from "bun:test";

import { validateAgainstSchema } from "../runtime/json-schema-mini.mjs";
import organizationManifestSchema from "../lazurio.organization.v1.schema.json";
import {
  newOrganizationSettings,
  ORGANIZATION_SETTINGS_CONTRACT_VERSION,
  ORGANIZATION_SETTINGS_ISSUE_CODES,
  ORGANIZATION_SETTINGS_KEYS,
  ORGANIZATION_SETTINGS_STATUSES,
  resolveOrganizationSettings,
} from "./organization-settings-lib.mjs";

const canonicalSource = "lazurio.organization.json";

describe("Organization settings contract (decision 0194, DEV-6653 C1)", () => {
  test("names one closed vocabulary", () => {
    expect(ORGANIZATION_SETTINGS_CONTRACT_VERSION).toBe("lazurio.organization.settings.v1");
    expect(ORGANIZATION_SETTINGS_STATUSES).toEqual(["absent", "valid", "invalid", "unavailable"]);
    expect(ORGANIZATION_SETTINGS_ISSUE_CODES).toEqual([
      "settings_field_missing",
      "settings_field_unknown",
      "settings_type_invalid",
    ]);
    expect(ORGANIZATION_SETTINGS_KEYS).toEqual(["integrations.composio.allowed"]);
    expect(Object.isFrozen(ORGANIZATION_SETTINGS_KEYS)).toBe(true);
  });

  test("an absent section means the Organization governs nothing and each Environment decides", () => {
    expect(settingsOf(manifest())).toEqual({
      contract_version: ORGANIZATION_SETTINGS_CONTRACT_VERSION,
      status: "absent",
      source: canonicalSource,
      values: {},
      effective: [{ key: "integrations.composio.allowed", governed: false, value: null }],
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
        effective: [{ key: "integrations.composio.allowed", governed: false, value: null }],
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
        effective: [{ key: "integrations.composio.allowed", governed: true, value: allowed }],
        issues: [],
      });
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
      effective: [{ key: "integrations.composio.allowed", governed: false, value: null }],
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
      effective: [{ key: "integrations.composio.allowed", governed: true, value: false }],
    });
  });

  test("the manifest schema and Core pin one settings contract", () => {
    expect(organizationManifestSchema.properties.settings).toEqual({ $ref: "#/$defs/organizationSettings" });
    expect(organizationManifestSchema.required).not.toContain("settings");
    expect(schemaLeafKeys(organizationManifestSchema.$defs.organizationSettings, [])).toEqual(ORGANIZATION_SETTINGS_KEYS);
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

function issue(code, path) {
  return { code, path };
}

// Leaf keys of the JSON schema settings tree, in declaration order, so the
// published schema cannot gain or lose a setting without Core.
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
