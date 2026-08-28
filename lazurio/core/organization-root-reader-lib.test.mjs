import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  ORGANIZATION_DOCUMENT_PATHS,
  readOrganizationRoot,
} from "./organization-root-reader-lib.mjs";

const roots = [];
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

test("filesystem adapter rejects symlinked Organization documents without following them", () => {
  const root = fixtureRoot();
  const outside = fixtureRoot();
  writeJson(outside, "foreign.json", legacyOrganization());
  symlinkSync(join(outside, "foreign.json"), join(root, ORGANIZATION_DOCUMENT_PATHS.legacy_projection));
  writeJson(root, ORGANIZATION_DOCUMENT_PATHS.modules, modulesManifest());

  expect(readOrganizationRoot({ organizationRoot: root })).toMatchObject({
    state: "conflict",
    resource_count: 0,
    issues: expect.arrayContaining(["legacy_projection_unreadable"]),
  });
});

test("filesystem adapter treats a dangling document symlink as a conflict, not absence", () => {
  const root = fixtureRoot();
  symlinkSync(join(root, "missing.json"), join(root, ORGANIZATION_DOCUMENT_PATHS.canonical));
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
  symlinkSync(fixtureRoot(), symlinkRoot);
  expect(readOrganizationRoot({ organizationRoot: symlinkRoot })).toMatchObject({
    state: "conflict",
    resource_count: 0,
    issues: expect.arrayContaining(["organization_root_boundary_invalid"]),
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
