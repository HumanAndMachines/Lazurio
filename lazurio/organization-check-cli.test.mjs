import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  organizationLegacyProjectionHash,
  projectLegacyOrganizationManifest,
} from "./core/organization-activation-lib.mjs";

const cli = join(import.meta.dirname, "cli.mjs");
const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("help advertises the read-only Organization check", () => {
  const help = run(["--help"]);
  expect(help.status).toBe(0);
  expect(help.stdout).toContain("lazurio organization check <organization-root> [--json]");
});

test("a root with valid settings passes and prints the effective values without writing anything", () => {
  const root = transitionRoot({ integrations: { composio: { allowed: false } } });
  const before = snapshot(root);

  const result = run(["organization", "check", root, "--json"]);
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({
    schema_version: "lazurio.organization.check.v0",
    organization_root: root,
    ok: true,
    manifest: {
      state: "transition",
      declaration_source: "lazurio.organization.json",
      accepted: true,
      issues: [],
      warnings: [],
      schema_issues: [],
    },
    settings: {
      contract_version: "lazurio.organization.settings.v1",
      status: "valid",
      source: "lazurio.organization.json",
      values: { integrations: { composio: { allowed: false } } },
      effective: [{ key: "integrations.composio.allowed", governed: true, value: false }],
      issues: [],
    },
    failures: [],
  });

  const human = run(["organization", "check", root]);
  expect(human.status).toBe(0);
  expect(human.stdout).toContain("Lazurio Organization check: ok");
  expect(human.stdout).toContain("integrations.composio.allowed = false");
  expect(snapshot(root)).toEqual(before);
});

test("a root without settings passes: the Organization governs nothing", () => {
  const root = transitionRoot(undefined);
  const result = run(["organization", "check", root, "--json"]);
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({
    ok: true,
    settings: {
      status: "absent",
      values: {},
      effective: [{ key: "integrations.composio.allowed", governed: false, value: null }],
    },
  });
  expect(run(["organization", "check", root]).stdout).toContain("integrations.composio.allowed: neřízeno");
});

test("invalid settings fail the check with precise issues while the manifest itself stays accepted", () => {
  const root = transitionRoot({ integrations: { composio: { allowed: "no" }, slack: {} } });

  const result = run(["organization", "check", root, "--json"]);
  expect(result.status).toBe(1);
  const report = JSON.parse(result.stdout);
  expect(report).toMatchObject({
    ok: false,
    // The settings subtree is judged once, by Core, with exact pointers; the
    // schema pass covers the rest of the document.
    manifest: { state: "transition", accepted: true, issues: [], schema_issues: [] },
    settings: {
      status: "invalid",
      values: null,
      effective: null,
      issues: [
        { code: "settings_type_invalid", path: "/settings/integrations/composio/allowed" },
        { code: "settings_field_unknown", path: "/settings/integrations/slack" },
      ],
    },
  });
  expect(report.failures.map((failure) => failure.code)).toEqual(["settings_invalid"]);

  const human = run(["organization", "check", root]);
  expect(human.status).toBe(1);
  expect(human.stdout).toContain("Lazurio Organization check: chyba");
  expect(human.stdout).toContain("settings_type_invalid /settings/integrations/composio/allowed");
  expect(human.stdout).toContain("settings_field_unknown /settings/integrations/slack");
});

test("schema drift outside settings fails even where the Core resolver tolerates it", () => {
  const root = transitionRoot(undefined, { teams: [{ slug: "workspace" }] });
  const report = JSON.parse(run(["organization", "check", root, "--json"]).stdout);
  expect(report).toMatchObject({ ok: false, manifest: { state: "transition", accepted: true } });
  expect(report.manifest.schema_issues.length).toBeGreaterThan(0);
  expect(report.failures.map((failure) => failure.code)).toEqual(["manifest_schema_invalid"]);
});

test("a projection drift fails with the regeneration step", () => {
  const root = transitionRoot({ integrations: { composio: { allowed: true } } });
  const companyPath = join(root, "company.gen3.json");
  const company = JSON.parse(readFileSync(companyPath, "utf8"));
  delete company.organization_kind;
  writeFileSync(companyPath, `${JSON.stringify(company, null, 2)}\n`);

  const result = run(["organization", "check", root, "--json"]);
  expect(result.status).toBe(1);
  const report = JSON.parse(result.stdout);
  expect(report).toMatchObject({
    ok: false,
    manifest: { state: "projection_drift", accepted: false },
    settings: { status: "valid" },
  });
  expect(report.failures).toEqual([
    expect.objectContaining({
      code: "manifest_state_not_accepted",
      message: expect.stringContaining("lazurio migrate organization-manifest"),
    }),
  ]);
});

test("a legacy root passes and says settings need the canonical manifest", () => {
  const root = fixtureRoot();
  const modules = modulesManifest();
  writeJson(root, "company.gen3.json", projectLegacyOrganizationManifest(canonicalManifest(modules), modules));
  writeJson(root, "modules.manifest.json", modules);

  const report = JSON.parse(run(["organization", "check", root, "--json"]).stdout);
  expect(report).toMatchObject({
    ok: true,
    manifest: { state: "legacy", declaration_source: "legacy_compatibility_projection", accepted: true },
    settings: { status: "absent", source: null, values: {} },
  });
  expect(run(["organization", "check", root]).stdout).toContain("lazurio migrate organization-manifest");
});

test("a directory that is no Organization root fails", () => {
  const result = run(["organization", "check", join(fixtureRoot(), "missing"), "--json"]);
  expect(result.status).toBe(1);
  expect(JSON.parse(result.stdout)).toMatchObject({
    ok: false,
    manifest: { state: "missing", accepted: false },
    settings: { status: "unavailable" },
  });
});

test("usage errors stay usage errors", () => {
  const root = transitionRoot(undefined);
  const cases = [
    [["organization", "check"], "organization check vyžaduje <organization-root>"],
    [["organization", "check", root, "extra"], "organization check vyžaduje <organization-root>"],
    [["organization", "check", root, "--root", root], "nepřijímá --root"],
    [["organization", "check", root, "--check"], "--check lze použít pouze s `lazurio organization activate`"],
    [["organization", "check", root, "--github-id", "1"], "--github-id lze použít pouze s `lazurio organization activate`"],
    [["organization", "check", root, "--role", "builder"], "--role lze použít pouze s `lazurio organization install`"],
  ];
  for (const [args, message] of cases) {
    const result = run(args);
    expect(result.status, args.join(" ")).toBe(2);
    expect(result.stderr, args.join(" ")).toContain(message);
  }
});

function transitionRoot(settings, overrides = {}) {
  const root = fixtureRoot();
  const modules = modulesManifest();
  const canonical = canonicalManifest(modules, settings, overrides);
  writeJson(root, "lazurio.organization.json", canonical);
  writeJson(root, "company.gen3.json", projectLegacyOrganizationManifest(canonical, modules));
  writeJson(root, "modules.manifest.json", modules);
  return root;
}

function canonicalManifest(modules, settings, overrides = {}) {
  const canonical = {
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
    governance: { default_branch: "main", access_authority: "github" },
    teams: [{ slug: "workspace", display_name: "Workspace", default: true }],
    ...overrides,
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
  canonical.compatibility.legacy_projection.sha256 = organizationLegacyProjectionHash(canonical, modules);
  return canonical;
}

function modulesManifest() {
  return {
    organization_generation: "gen3",
    company: "example-org",
    github_org: "Example",
    module_slots: [],
  };
}

function fixtureRoot() {
  const root = mkdtempSync(join(tmpdir(), "lazurio-organization-check-"));
  roots.push(root);
  return root;
}

function writeJson(root, relativePath, value) {
  writeFileSync(join(root, relativePath), `${JSON.stringify(value, null, 2)}\n`);
}

function snapshot(root) {
  return Object.fromEntries(["lazurio.organization.json", "company.gen3.json", "modules.manifest.json"]
    .map((path) => [path, readFileSync(join(root, path), "utf8")]));
}

function run(args) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
  });
  return {
    status: result.status,
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? ""),
  };
}
