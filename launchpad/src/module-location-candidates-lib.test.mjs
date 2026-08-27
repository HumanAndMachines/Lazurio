import { afterEach, expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  classifyOrganizationModuleCheckoutLocation,
  inspectOrganizationModuleCheckoutCandidates,
  organizationModuleDeclarationClaims,
} from "./module-location-candidates-lib.mjs";

const cleanup = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

test("declaration claims reserve case-only mount container aliases portably", () => {
  expect(organizationModuleDeclarationClaims([
    { slug: "knowledgebase", path: "Workspace/legacy" },
    { slug: "INVALID", path: "Modules/archive" },
  ])).toEqual([
    // A case-drifted container reserves its physical alias, but its
    // non-canonical path cannot authorize the declared Module identity.
    { module: "__lazurio_unknown_module_owner__", path: "Workspace/legacy" },
    { module: "__lazurio_unknown_module_owner__", path: "Modules/archive" },
  ]);
});

test("inventory separates marker-authorized candidates from persistent Git suspects", async () => {
  const organizationRoot = await fixtureRoot("suspects");
  const workspace = join(organizationRoot, "workspace");
  const verified = join(workspace, "canonical");
  const missingMarker = join(workspace, "studio");
  const companyDrift = join(workspace, "legacy-company");
  await Promise.all([
    mkdir(verified, { recursive: true }),
    mkdir(join(missingMarker, ".git"), { recursive: true }),
    mkdir(join(companyDrift, ".git"), { recursive: true }),
  ]);
  await writeFile(join(verified, "lazurio.module.json"), marker("studio", "TestCo"));
  await writeFile(join(companyDrift, "lazurio.module.json"), marker("studio", "OtherCo"));

  const inventory = await inspectOrganizationModuleCheckoutCandidates({
    organizationRoot,
    organizationSlug: "TestCo",
    moduleSlug: "studio",
  });

  expect(inventory.boundary_errors).toEqual([]);
  expect(inventory.verified.map((candidate) => candidate.relative_path))
    .toEqual(["workspace/canonical"]);
  expect(inventory.unverified).toEqual([
    expect.objectContaining({
      relative_path: "workspace/legacy-company",
      reason: "marker_company_mismatch",
      marker_id: "studio",
      marker_company: "OtherCo",
    }),
    expect.objectContaining({
      relative_path: "workspace/studio",
      reason: "marker_missing",
      marker_id: null,
      marker_company: null,
    }),
  ]);
});

test("symlinked mount container is never traversed and returns a boundary error", async () => {
  if (process.platform === "win32") return;
  const sandbox = await mkdtemp(join(tmpdir(), "lazurio-candidates-boundary-"));
  cleanup.push(sandbox);
  const organizationRoot = join(sandbox, "organization");
  const outside = join(sandbox, "outside-workspace");
  await mkdir(join(organizationRoot, "modules"), { recursive: true });
  await mkdir(join(outside, "studio", ".git"), { recursive: true });
  await writeFile(join(outside, "studio", "lazurio.module.json"), marker("studio", "TestCo"));
  await symlink(outside, join(organizationRoot, "workspace"), "dir");

  const inventory = await inspectOrganizationModuleCheckoutCandidates({
    organizationRoot,
    organizationSlug: "TestCo",
    moduleSlug: "studio",
  });

  expect(inventory.verified).toEqual([]);
  expect(inventory.unverified).toEqual([]);
  expect(inventory.boundary_errors).toEqual([
    expect.objectContaining({
      container: "workspace",
      code: "container_boundary_invalid",
    }),
  ]);
});

test("location classification keeps ambiguity above unverified and repairable mismatch", async () => {
  const organizationRoot = await fixtureRoot("dominance");
  const workspace = join(organizationRoot, "workspace");
  const oldCheckout = join(workspace, "studio");
  const targetCheckout = join(workspace, "studio-v2");
  await Promise.all([
    mkdir(oldCheckout, { recursive: true }),
    mkdir(targetCheckout, { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(oldCheckout, "lazurio.module.json"), marker("studio", "TestCo")),
    writeFile(join(targetCheckout, "lazurio.module.json"), marker("studio", "TestCo")),
  ]);
  const inspection = await inspectOrganizationModuleCheckoutCandidates({
    organizationRoot,
    organizationSlug: "TestCo",
    moduleSlug: "studio",
  });

  const classification = await classifyOrganizationModuleCheckoutLocation({
    organizationRoot,
    expectedPath: "workspace/studio-v2",
    inspection,
  });

  expect(classification).toMatchObject({
    status: "ambiguous",
    expected_path: "workspace/studio-v2",
    observed_paths: ["workspace/studio", "workspace/studio-v2"],
  });
});

test("location classification persists one unverifiable direct Git suspect", async () => {
  const organizationRoot = await fixtureRoot("unverified");
  await mkdir(join(organizationRoot, "workspace", "studio", ".git"), { recursive: true });
  const inspection = await inspectOrganizationModuleCheckoutCandidates({
    organizationRoot,
    organizationSlug: "TestCo",
    moduleSlug: "studio",
  });

  const classification = await classifyOrganizationModuleCheckoutLocation({
    organizationRoot,
    expectedPath: "workspace/studio-v2",
    inspection,
  });

  expect(classification).toMatchObject({
    status: "unverified",
    found_path: "workspace/studio",
    expected_path: "workspace/studio-v2",
    reason: "marker_missing",
  });
});

test("an exact markerless checkout stays unverified for runtime identity and relocation", async () => {
  const organizationRoot = await fixtureRoot("exact-markerless");
  await mkdir(join(organizationRoot, "workspace", "studio", ".git"), { recursive: true });
  const inspection = await inspectOrganizationModuleCheckoutCandidates({
    organizationRoot,
    organizationSlug: "TestCo",
    moduleSlug: "studio",
  });

  expect(await classifyOrganizationModuleCheckoutLocation({
    organizationRoot,
    expectedPath: "workspace/studio",
    moduleSlug: "studio",
    declaredModuleClaims: [{ path: "workspace/studio", module: "studio" }],
    inspection,
  })).toMatchObject({
    status: "unverified",
    reason: "marker_missing",
    found_path: "workspace/studio",
    expected_path: "workspace/studio",
    target_occupied: true,
  });
});

test("an unassigned legacy Git checkout blocks a vacant renamed target across fresh scans", async () => {
  const organizationRoot = await fixtureRoot("unassigned-legacy");
  await mkdir(join(organizationRoot, "workspace", "legacy", ".git"), { recursive: true });

  for (const run of [1, 2]) {
    const inspection = await inspectOrganizationModuleCheckoutCandidates({
      organizationRoot,
      organizationSlug: "TestCo",
      moduleSlug: "renamed",
    });
    expect(inspection.unverified).toEqual([
      expect.objectContaining({
        relative_path: "workspace/legacy",
        reason: "marker_missing",
        identity_hint: "unassigned_git_checkout",
      }),
    ]);
    expect(await classifyOrganizationModuleCheckoutLocation({
      organizationRoot,
      expectedPath: "workspace/canonical",
      inspection,
    })).toMatchObject({
      status: "unverified",
      found_path: "workspace/legacy",
      expected_path: "workspace/canonical",
    });
    expect(run).toBeGreaterThan(0);
  }
});

test("an exact declared sibling checkout does not impersonate a different vacant Module", async () => {
  const organizationRoot = await fixtureRoot("assigned-legacy-sibling");
  await mkdir(join(organizationRoot, "workspace", "knowledgebase", ".git"), { recursive: true });
  const inspection = await inspectOrganizationModuleCheckoutCandidates({
    organizationRoot,
    organizationSlug: "TestCo",
    moduleSlug: "design-system",
  });

  expect(await classifyOrganizationModuleCheckoutLocation({
    organizationRoot,
    expectedPath: "workspace/design-system",
    moduleSlug: "design-system",
    declaredModuleClaims: [
      { path: "workspace/design-system", module: "design-system" },
      { path: "workspace/knowledgebase", module: "knowledgebase" },
    ],
    inspection,
  })).toMatchObject({
    status: "vacant",
    expected_path: "workspace/design-system",
    observed_paths: [],
  });

  // Without an explicit sibling declaration the same unknown checkout remains
  // a no-clone signal for a possible pre-rename location.
  expect(await classifyOrganizationModuleCheckoutLocation({
    organizationRoot,
    expectedPath: "workspace/design-system",
    moduleSlug: "design-system",
    inspection,
  })).toMatchObject({
    status: "unverified",
    found_path: "workspace/knowledgebase",
  });
});

test("a target claimed only by a sibling declaration is an ambiguity, never a vacant slot", async () => {
  const organizationRoot = await fixtureRoot("foreign-declared-target");
  const inspection = await inspectOrganizationModuleCheckoutCandidates({
    organizationRoot,
    organizationSlug: "TestCo",
    moduleSlug: "design-system",
  });

  expect(await classifyOrganizationModuleCheckoutLocation({
    organizationRoot,
    expectedPath: "workspace/shared",
    moduleSlug: "design-system",
    declaredModuleClaims: [{ path: "workspace/shared", module: "knowledgebase" }],
    inspection,
  })).toMatchObject({
    status: "ambiguous",
    reason: "target_declaration_collision:knowledgebase",
  });
});

test("a selected Module marker on a sibling-claimed path remains an ambiguity", async () => {
  const organizationRoot = await fixtureRoot("strong-sibling-collision");
  const siblingPath = join(organizationRoot, "workspace", "knowledgebase");
  await mkdir(siblingPath, { recursive: true });
  await writeFile(join(siblingPath, "lazurio.module.json"), marker("design-system", "TestCo"));
  const inspection = await inspectOrganizationModuleCheckoutCandidates({
    organizationRoot,
    organizationSlug: "TestCo",
    moduleSlug: "design-system",
  });

  expect(await classifyOrganizationModuleCheckoutLocation({
    organizationRoot,
    expectedPath: "workspace/design-system",
    moduleSlug: "design-system",
    declaredModuleClaims: [
      { path: "workspace/design-system", module: "design-system" },
      { path: "workspace/knowledgebase", module: "knowledgebase" },
    ],
    inspection,
  })).toMatchObject({
    status: "ambiguous",
    found_path: "workspace/knowledgebase",
    reason: "sibling_declaration_collision",
  });
});

test("an unrelated unassigned Git checkout does not quarantine an exact marker-authorized sibling", async () => {
  const organizationRoot = await fixtureRoot("healthy-sibling");
  const healthy = join(organizationRoot, "workspace", "healthy");
  await Promise.all([
    mkdir(healthy, { recursive: true }),
    mkdir(join(organizationRoot, "workspace", "legacy", ".git"), { recursive: true }),
  ]);
  await writeFile(join(healthy, "lazurio.module.json"), marker("healthy", "TestCo"));

  const inspection = await inspectOrganizationModuleCheckoutCandidates({
    organizationRoot,
    organizationSlug: "TestCo",
    moduleSlug: "healthy",
  });
  expect(await classifyOrganizationModuleCheckoutLocation({
    organizationRoot,
    expectedPath: "workspace/healthy",
    inspection,
  })).toMatchObject({
    status: "healthy",
    found_path: "workspace/healthy",
  });
});

test("an unrelated unassigned Git checkout does not quarantine an established legacy sibling directory", async () => {
  const organizationRoot = await fixtureRoot("legacy-sibling");
  await Promise.all([
    mkdir(join(organizationRoot, "modules", "demo", "app"), { recursive: true }),
    mkdir(join(organizationRoot, "workspace", "legacy", ".git"), { recursive: true }),
  ]);

  const inspection = await inspectOrganizationModuleCheckoutCandidates({
    organizationRoot,
    organizationSlug: "TestCo",
    moduleSlug: "demo",
  });
  expect(await classifyOrganizationModuleCheckoutLocation({
    organizationRoot,
    expectedPath: "modules/demo",
    inspection,
  })).toMatchObject({
    status: "vacant",
    expected_path: "modules/demo",
  });
});

test("an exact stable-slug symlink remains a persistent no-clone suspect", async () => {
  const organizationRoot = await fixtureRoot("checkout-symlink");
  const outsideCheckout = join(organizationRoot, "outside-studio");
  await mkdir(join(outsideCheckout, ".git"), { recursive: true });
  await symlink(
    outsideCheckout,
    join(organizationRoot, "workspace", "studio"),
    process.platform === "win32" ? "junction" : "dir",
  );

  const inspection = await inspectOrganizationModuleCheckoutCandidates({
    organizationRoot,
    organizationSlug: "TestCo",
    moduleSlug: "studio",
  });
  const classification = await classifyOrganizationModuleCheckoutLocation({
    organizationRoot,
    expectedPath: "workspace/studio-v2",
    inspection,
  });

  expect(inspection.unverified).toEqual([
    expect.objectContaining({
      relative_path: "workspace/studio",
      reason: "checkout_symlink",
    }),
  ]);
  expect(classification).toMatchObject({
    status: "unverified",
    found_path: "workspace/studio",
    expected_path: "workspace/studio-v2",
  });
});

test("a symlink at the canonical target is an ambiguity collision even when it aliases the old checkout", async () => {
  if (process.platform === "win32") return;
  const organizationRoot = await fixtureRoot("target-symlink");
  const oldCheckout = join(organizationRoot, "workspace", "legacy-name");
  await mkdir(oldCheckout, { recursive: true });
  await writeFile(join(oldCheckout, "lazurio.module.json"), marker("studio", "TestCo"));
  await symlink(oldCheckout, join(organizationRoot, "workspace", "studio-v2"), "dir");

  const inspection = await inspectOrganizationModuleCheckoutCandidates({
    organizationRoot,
    organizationSlug: "TestCo",
    moduleSlug: "studio",
  });
  const classification = await classifyOrganizationModuleCheckoutLocation({
    organizationRoot,
    expectedPath: "workspace/studio-v2",
    inspection,
  });

  expect(classification).toMatchObject({
    status: "ambiguous",
    expected_path: "workspace/studio-v2",
    observed_paths: ["workspace/legacy-name", "workspace/studio-v2"],
    target_occupied: true,
    reason: "target_boundary_collision",
  });
});

test("a non-ENOENT Git metadata failure remains a no-clone suspect", async () => {
  const organizationRoot = await fixtureRoot("git-unreadable");
  const checkout = join(organizationRoot, "workspace", "studio");
  await mkdir(checkout, { recursive: true });
  const metadataPath = join(checkout, ".git");
  const inspection = await inspectOrganizationModuleCheckoutCandidates({
    organizationRoot,
    organizationSlug: "TestCo",
    moduleSlug: "studio",
    lstatPath: async (path) => {
      if (path === metadataPath) {
        const error = new Error("permission denied");
        error.code = "EACCES";
        throw error;
      }
      return lstat(path);
    },
  });

  expect(inspection.unverified).toEqual([
    expect.objectContaining({
      relative_path: "workspace/studio",
      reason: "git_metadata_unreadable",
      git_metadata_kind: "unreadable",
    }),
  ]);
});

test("a valid same-Organization marker for another stable Module defeats the basename heuristic", async () => {
  const organizationRoot = await fixtureRoot("other-module");
  const otherCheckout = join(organizationRoot, "workspace", "studio");
  await mkdir(join(otherCheckout, ".git"), { recursive: true });
  await writeFile(join(otherCheckout, "lazurio.module.json"), marker("editor", "TestCo"));

  const inspection = await inspectOrganizationModuleCheckoutCandidates({
    organizationRoot,
    organizationSlug: "TestCo",
    moduleSlug: "studio",
  });

  expect(inspection.verified).toEqual([]);
  expect(inspection.unverified).toEqual([]);
  expect(inspection.foreign_verified).toEqual([
    expect.objectContaining({ relative_path: "workspace/studio", marker_id: "editor" }),
  ]);

  const unrelated = await classifyOrganizationModuleCheckoutLocation({
    organizationRoot,
    expectedPath: "workspace/studio-v2",
    inspection,
  });
  expect(unrelated.status).toBe("vacant");

  const occupied = await classifyOrganizationModuleCheckoutLocation({
    organizationRoot,
    expectedPath: "workspace/studio",
    inspection,
  });
  expect(occupied).toMatchObject({
    status: "ambiguous",
    expected_path: "workspace/studio",
    observed_paths: ["workspace/studio"],
    reason: "target_identity_collision:editor",
  });
});

async function fixtureRoot(name) {
  const sandbox = await mkdtemp(join(tmpdir(), `lazurio-candidates-${name}-`));
  cleanup.push(sandbox);
  const organizationRoot = join(sandbox, "organization");
  await Promise.all([
    mkdir(join(organizationRoot, "workspace"), { recursive: true }),
    mkdir(join(organizationRoot, "modules"), { recursive: true }),
  ]);
  return organizationRoot;
}

function marker(id, company) {
  return `${JSON.stringify({ schema_version: "lazurio.module.v1", id, company }, null, 2)}\n`;
}
