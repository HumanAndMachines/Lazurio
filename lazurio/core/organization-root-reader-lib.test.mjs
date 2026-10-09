import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  ORGANIZATION_DOCUMENT_PATHS,
  readOrganizationRoot,
  readOrganizationSettings,
} from "./organization-root-reader-lib.mjs";
import {
  organizationLegacyProjectionHash,
  projectLegacyOrganizationManifest,
} from "./organization-activation-lib.mjs";
import { supportsFileSymlinks } from "../../scripts/test-platform-capabilities.mjs";

const roots = [];
const fileSymlinkTest = (await supportsFileSymlinks()) ? test : test.skip;
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("filesystem adapter reads a legacy Organization through the single Core resolver", () => {
  const root = fixtureRoot();
  writeJson(root, ORGANIZATION_DOCUMENT_PATHS.legacy_projection, legacyOrganization());
  writeJson(root, ORGANIZATION_DOCUMENT_PATHS.modules, modulesManifest());

  expect(readOrganizationRoot({ organizationRoot: root })).toMatchObject({
    contract_version: "lazurio.organization.root-resolution.v1",
    state: "legacy",
    resource_count: 1,
    resource: {
      schema_version: "lazurio.organization.resource.v1",
      organization: { slug: "example", display_name: "Example" },
    },
  });
});

fileSymlinkTest("filesystem adapter rejects symlinked Organization documents without following them [requires file symlink capability]", () => {
  const root = fixtureRoot();
  const outside = fixtureRoot();
  writeJson(outside, "foreign.json", legacyOrganization());
  symlinkSync(join(outside, "foreign.json"), join(root, ORGANIZATION_DOCUMENT_PATHS.legacy_projection), "file");
  writeJson(root, ORGANIZATION_DOCUMENT_PATHS.modules, modulesManifest());

  expect(readOrganizationRoot({ organizationRoot: root })).toMatchObject({
    state: "conflict",
    resource_count: 0,
    issues: expect.arrayContaining(["legacy_projection_unreadable"]),
  });
});

fileSymlinkTest("filesystem adapter treats a dangling document symlink as a conflict, not absence [requires file symlink capability]", () => {
  const root = fixtureRoot();
  symlinkSync(join(root, "missing.json"), join(root, ORGANIZATION_DOCUMENT_PATHS.canonical), "file");
  writeJson(root, ORGANIZATION_DOCUMENT_PATHS.legacy_projection, legacyOrganization());
  writeJson(root, ORGANIZATION_DOCUMENT_PATHS.modules, modulesManifest());

  expect(readOrganizationRoot({ organizationRoot: root })).toMatchObject({
    state: "conflict",
    resource_count: 0,
    issues: expect.arrayContaining(["canonical_manifest_unreadable"]),
  });
});

test("filesystem adapter treats a present non-object JSON document as invalid, not absent", () => {
  const root = fixtureRoot();
  writeFileSync(join(root, ORGANIZATION_DOCUMENT_PATHS.canonical), "null\n");
  writeJson(root, ORGANIZATION_DOCUMENT_PATHS.legacy_projection, legacyOrganization());
  writeJson(root, ORGANIZATION_DOCUMENT_PATHS.modules, modulesManifest());

  expect(readOrganizationRoot({ organizationRoot: root })).toMatchObject({
    state: "conflict",
    resource_count: 0,
  });
});

test("Organization root boundary fails closed for missing, file and symlink roots", () => {
  const missing = join(fixtureRoot(), "missing-root");
  expect(readOrganizationRoot({ organizationRoot: missing })).toMatchObject({
    state: "missing",
    resource_count: 0,
  });

  const fileRoot = join(fixtureRoot(), "root-file");
  writeFileSync(fileRoot, "not a directory\n");
  expect(readOrganizationRoot({ organizationRoot: fileRoot })).toMatchObject({
    state: "conflict",
    resource_count: 0,
    issues: expect.arrayContaining(["organization_root_boundary_invalid"]),
  });

  const symlinkParent = fixtureRoot();
  const symlinkRoot = join(symlinkParent, "linked-root");
  symlinkSync(fixtureRoot(), symlinkRoot, process.platform === "win32" ? "junction" : "dir");
  expect(readOrganizationRoot({ organizationRoot: symlinkRoot })).toMatchObject({
    state: "conflict",
    resource_count: 0,
    issues: expect.arrayContaining(["organization_root_boundary_invalid"]),
  });
});

test("one Core call reads an Organization's settings from its checked-out root", () => {
  const root = fixtureRoot();
  writeTransitionRoot(root, canonicalOrganization({ integrations: { composio: { allowed: false } } }));

  const settings = readOrganizationSettings({ organizationRoot: root });
  expect(settings).toEqual({
    contract_version: "lazurio.organization.settings.v1",
    status: "valid",
    source: "lazurio.organization.json",
    values: { integrations: { composio: { allowed: false } } },
    effective: [{ key: "integrations.composio.allowed", governed: true, value: false }],
    issues: [],
  });
  expect(readOrganizationRoot({ organizationRoot: root })).toMatchObject({
    state: "transition",
    resource_count: 1,
    issues: [],
    settings,
  });
});

test("an invalid settings section on disk stays a settings verdict, never an Organization conflict", () => {
  const root = fixtureRoot();
  writeTransitionRoot(root, canonicalOrganization({ integrations: { composio: { allowed: "yes" } } }));

  expect(readOrganizationSettings({ organizationRoot: root })).toMatchObject({
    status: "invalid",
    values: null,
    effective: null,
    issues: [{ code: "settings_type_invalid", path: "/settings/integrations/composio/allowed" }],
  });
  expect(readOrganizationRoot({ organizationRoot: root })).toMatchObject({
    state: "transition",
    resource_count: 1,
    issues: [],
  });
});

test("settings of a legacy root are absent and of an unreadable root unavailable", () => {
  const legacyRoot = fixtureRoot();
  writeJson(legacyRoot, ORGANIZATION_DOCUMENT_PATHS.legacy_projection, legacyOrganization());
  writeJson(legacyRoot, ORGANIZATION_DOCUMENT_PATHS.modules, modulesManifest());
  expect(readOrganizationSettings({ organizationRoot: legacyRoot })).toMatchObject({
    status: "absent",
    source: null,
    values: {},
  });

  const unreadableRoot = fixtureRoot();
  writeFileSync(join(unreadableRoot, ORGANIZATION_DOCUMENT_PATHS.canonical), "{ not json\n");
  writeJson(unreadableRoot, ORGANIZATION_DOCUMENT_PATHS.modules, modulesManifest());
  expect(readOrganizationSettings({ organizationRoot: unreadableRoot })).toMatchObject({
    status: "unavailable",
    values: null,
  });
});

function fixtureRoot() {
  const root = mkdtempSync(join(tmpdir(), "lazurio-organization-reader-"));
  roots.push(root);
  return root;
}

function writeJson(root, relativePath, value) {
  const path = join(root, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function legacyOrganization() {
  return {
    organization_generation: "gen3",
    organization_kind: "organization",
    company: { slug: "example", display_name: "Example", github_org: "Example" },
    teams: [],
  };
}

function modulesManifest() {
  return {
    organization_generation: "gen3",
    company: "example",
    github_org: "Example",
    module_slots: [],
  };
}

function canonicalOrganization(settings) {
  const canonical = {
    schema_version: "lazurio.organization.v1",
    kind: "organization",
    organization: {
      slug: "example",
      display_name: "Example",
      forge_binding: { forge: "github", locator: "Example", binding_state: "unverified" },
      metadata: {},
    },
    root_repository: null,
    manifests: { modules: "modules.manifest.json" },
    teams: [],
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
  canonical.compatibility.legacy_projection.sha256 = organizationLegacyProjectionHash(canonical, modulesManifest());
  return canonical;
}

function writeTransitionRoot(root, canonical) {
  writeJson(root, ORGANIZATION_DOCUMENT_PATHS.canonical, canonical);
  writeJson(root, ORGANIZATION_DOCUMENT_PATHS.legacy_projection, projectLegacyOrganizationManifest(canonical, modulesManifest()));
  writeJson(root, ORGANIZATION_DOCUMENT_PATHS.modules, modulesManifest());
}
