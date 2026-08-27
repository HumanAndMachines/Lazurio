import { afterAll, expect, test } from "bun:test";
import { mkdir, readFile, rename, rm, symlink, writeFile } from "fs/promises";
import { join } from "path";
import { buildGitInventory } from "../../lazurio/runtime/git-inventory-lib.mjs";
import { createLaunchpadGitFixture, initGitRepo, runGit } from "./git-fixture-helpers.test.mjs";

const tempRoots = [];

afterAll(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
});

test("inventory reads repo paths from Organization manifests and does not infer layout from filesystem", async () => {
  const root = await createLaunchpadGitFixture();
  tempRoots.push(root);

  const inventory = await buildGitInventory({ companiesRoot: root });
  const repos = new Map(inventory.repos.map((repo) => [repo.key, repo]));

  expect(repos.get("OmegaCo::studio")).toMatchObject({
    organization: "OmegaCo",
    workspace: "workspace",
    module: "studio",
    repo_kind: "module",
    repo_path: "organizations/OmegaCo_GEN3/workspace/studio",
    expected_branch: "main",
  });
  expect(repos.get("BetaCo::deals")).toMatchObject({
    organization: "BetaCo",
    workspace: "workspace",
    module: "deals",
    repo_kind: "module",
    repo_path: "organizations/BetaCo_GEN3/workspace/deals",
    expected_branch: "main",
  });
  expect(repos.get("OmegaCo::infra")).toMatchObject({
    organization: "OmegaCo",
    space: "root",
    workspace: null,
    module: "infra",
    repo_kind: "root_repo",
    repo_path: "organizations/OmegaCo_GEN3/infra",
  });
  expect(repos.has("BetaCo::brainstorm")).toBe(false);
  expect(inventory.planned.map((slot) => `${slot.organization}::${slot.module}`)).toContain("BetaCo::brainstorm");
});

test("an Organization identity mismatch keeps its root updateable but excludes only its child repositories", async () => {
  const root = await createLaunchpadGitFixture();
  tempRoots.push(root);
  const manifestPath = join(root, "organizations", "OmegaCo_GEN3", "modules.manifest.json");
  const manifest = await Bun.file(manifestPath).json();
  manifest.github_org = "ForeignCo";
  await Bun.write(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const inventory = await buildGitInventory({ companiesRoot: root });

  expect(inventory.repos.some((repo) => repo.key === "OmegaCo::root")).toBe(true);
  expect(inventory.repos.some((repo) => repo.organization === "OmegaCo" && repo.repo_kind !== "organization_root")).toBe(false);
  expect(inventory.repos.some((repo) => repo.key === "BetaCo::deals")).toBe(true);
  expect(inventory.inventory_issues).toContainEqual(expect.objectContaining({
    scope: "organization",
    code: "organization_identity_invalid",
    organization: "OmegaCo",
    next_action: expect.objectContaining({ kind: "agent_review" }),
  }));
});

test("conflicting Organization root aliases block that Organization before any Git action", async () => {
  const root = await createLaunchpadGitFixture();
  tempRoots.push(root);
  const companyPath = join(root, "organizations", "OmegaCo_GEN3", "company.gen3.json");
  const company = await Bun.file(companyPath).json();
  company.company.repository = "git@github.com:OmegaCo/OmegaCo_GEN3.git";
  company.company.git_url = "git@github.com:ForeignCo/Shadow_GEN3.git";
  company.company.default_branch = "main";
  company.default_branch = "develop";
  await Bun.write(companyPath, `${JSON.stringify(company, null, 2)}\n`);

  const inventory = await buildGitInventory({ companiesRoot: root });
  const omegaIssues = inventory.inventory_issues.filter((issue) => issue.organization === "OmegaCo");

  expect(inventory.repos.some((repo) => repo.organization === "OmegaCo")).toBe(false);
  expect(inventory.repos.some((repo) => repo.key === "BetaCo::deals")).toBe(true);
  expect(omegaIssues.map((issue) => issue.code).sort()).toEqual([
    "organization_root_branch_conflict",
    "organization_root_remote_conflict",
  ]);
  expect(omegaIssues.every((issue) => issue.scope === "organization")).toBe(true);
});

test("malformed canonical root aliases and non-main branch fail closed for one Organization", async () => {
  const root = await createLaunchpadGitFixture();
  tempRoots.push(root);
  const companyPath = join(root, "organizations", "OmegaCo_GEN3", "company.gen3.json");
  const company = await Bun.file(companyPath).json();
  company.company.repository = { owner: "OmegaCo" };
  company.company.git_url = "git@github.com:OmegaCo/OmegaCo_GEN3.git";
  company.company.default_branch = "develop";
  company.default_branch = "develop";
  await Bun.write(companyPath, `${JSON.stringify(company, null, 2)}\n`);

  const inventory = await buildGitInventory({ companiesRoot: root });
  const omegaIssues = inventory.inventory_issues.filter((issue) => issue.organization === "OmegaCo");

  expect(inventory.repos.some((repo) => repo.organization === "OmegaCo")).toBe(false);
  expect(inventory.repos.some((repo) => repo.key === "BetaCo::deals")).toBe(true);
  expect(omegaIssues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
    "organization_root_remote_alias_invalid",
    "organization_root_branch_invalid",
  ]));
});

test("a foreign Organization root owner is isolated while a healthy Organization remains actionable", async () => {
  const root = await createLaunchpadGitFixture();
  tempRoots.push(root);
  const companyPath = join(root, "organizations", "OmegaCo_GEN3", "company.gen3.json");
  const company = await Bun.file(companyPath).json();
  company.company.repository = "git@github.com:ForeignCo/Shadow_GEN3.git";
  company.company.root_repository = "ForeignCo/Shadow_GEN3";
  company.company.default_branch = "main";
  await Bun.write(companyPath, `${JSON.stringify(company, null, 2)}\n`);

  const inventory = await buildGitInventory({ companiesRoot: root });

  expect(inventory.repos.some((repo) => repo.organization === "OmegaCo")).toBe(false);
  expect(inventory.repos.some((repo) => repo.key === "BetaCo::deals")).toBe(true);
  expect(inventory.inventory_issues).toContainEqual(expect.objectContaining({
    organization: "OmegaCo",
    scope: "organization",
    code: "organization_root_remote_owner_mismatch",
  }));
});

test("scaffold forge binding conflicts isolate root and children before Git inventory actions", async () => {
  const root = await createLaunchpadGitFixture();
  tempRoots.push(root);
  const companyPath = join(root, "organizations", "OmegaCo_GEN3", "company.gen3.json");
  const company = await Bun.file(companyPath).json();
  company.company.repository = "git@github.com:OmegaCo/OmegaCo_GEN3.git";
  company.company.root_repository = "OmegaCo/OmegaCo_GEN3";
  company.company.default_branch = "main";
  company.forge_binding = {
    schema_version: "lazurio.forge-binding.github.v0",
    provider: "github",
    organization: { id: "123", asserted_login: "BoundCo" },
    repository: {
      id: "456",
      asserted_full_name: "BoundCo/BoundCo_GEN3",
      default_branch: "main",
    },
  };
  company.governance = { default_branch: "develop" };
  await Bun.write(companyPath, `${JSON.stringify(company, null, 2)}\n`);

  const inventory = await buildGitInventory({ companiesRoot: root });
  const omegaCodes = inventory.inventory_issues
    .filter((issue) => issue.organization === "OmegaCo")
    .map((issue) => issue.code);

  expect(inventory.repos.some((repo) => repo.organization === "OmegaCo")).toBe(false);
  expect(inventory.repos.some((repo) => repo.key === "BetaCo::deals")).toBe(true);
  expect(omegaCodes).toEqual(expect.arrayContaining([
    "organization_root_remote_conflict",
    "organization_root_owner_conflict",
    "organization_root_branch_conflict",
  ]));
});

test("a foreign governance access authority isolates one Organization before Git inventory actions", async () => {
  const root = await createLaunchpadGitFixture();
  tempRoots.push(root);
  const companyPath = join(root, "organizations", "OmegaCo_GEN3", "company.gen3.json");
  const company = await Bun.file(companyPath).json();
  company.company.repository = "git@github.com:OmegaCo/OmegaCo_GEN3.git";
  company.company.default_branch = "main";
  company.governance = { default_branch: "main", access_authority: "not-github" };
  await Bun.write(companyPath, `${JSON.stringify(company, null, 2)}\n`);

  const inventory = await buildGitInventory({ companiesRoot: root });

  expect(inventory.repos.some((repo) => repo.organization === "OmegaCo")).toBe(false);
  expect(inventory.repos.some((repo) => repo.key === "BetaCo::deals")).toBe(true);
  expect(inventory.inventory_issues).toContainEqual(expect.objectContaining({
    organization: "OmegaCo",
    scope: "organization",
    code: "organization_root_access_authority_invalid",
  }));
});

test("a cross-Organization remote dominates a simultaneous repository rename", async () => {
  const root = await createLaunchpadGitFixture();
  tempRoots.push(root);
  const manifestPath = join(root, "organizations", "OmegaCo_GEN3", "modules.manifest.json");
  const manifest = await Bun.file(manifestPath).json();
  manifest.module_slots[0].slug = "studio";
  manifest.module_slots[0].path = "workspace/old-studio";
  manifest.module_slots[0].git = {
    url: "git@github.com:ForeignCo/new-studio.git",
    branch: "main",
  };
  delete manifest.module_slots[0].repo;
  await Bun.write(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const inventory = await buildGitInventory({ companiesRoot: root });

  expect(inventory.repos.some((repo) => repo.key === "OmegaCo::studio")).toBe(false);
  expect(inventory.repos.some((repo) => repo.key === "OmegaCo::infra")).toBe(true);
  expect(inventory.repos.some((repo) => repo.key === "BetaCo::deals")).toBe(true);
  expect(inventory.inventory_issues).toContainEqual(expect.objectContaining({
    scope: "module_slot",
    code: "slot_remote_owner_mismatch",
    module: "studio",
    next_action: expect.objectContaining({ kind: "agent_review" }),
  }));
  expect(inventory.inventory_issues.some((issue) =>
    issue.module === "studio" && issue.code === "repository_location_mismatch"
  )).toBe(false);
  expect(JSON.stringify(inventory.inventory_issues.filter((issue) => issue.module === "studio")))
    .not.toContain("repair_module_location");
});

test("conflicting remote and branch aliases quarantine one slot without choosing an action authority", async () => {
  const root = await createLaunchpadGitFixture();
  tempRoots.push(root);
  const manifestPath = join(root, "organizations", "OmegaCo_GEN3", "modules.manifest.json");
  const manifest = await Bun.file(manifestPath).json();
  manifest.module_slots[0] = {
    ...manifest.module_slots[0],
    repo: "git@github.com:ForeignCo/studio.git",
    branch: "feature",
    git: { url: "git@github.com:OmegaCo/studio.git", branch: "main" },
  };
  await Bun.write(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const inventory = await buildGitInventory({ companiesRoot: root });
  const conflicts = inventory.inventory_issues.filter((issue) => issue.module === "studio");

  expect(inventory.repos.some((repo) => repo.key === "OmegaCo::studio")).toBe(false);
  expect(inventory.repos.some((repo) => repo.key === "OmegaCo::infra")).toBe(true);
  expect(inventory.repos.some((repo) => repo.key === "BetaCo::deals")).toBe(true);
  expect(conflicts.map((issue) => issue.code).sort()).toEqual([
    "slot_branch_conflict",
    "slot_remote_conflict",
  ]);
  expect(conflicts.every((issue) => issue.next_action?.kind === "agent_review")).toBe(true);
});

test("inventory keeps lowercase module ID separate from a case-preserving repository mount", async () => {
  const root = await createLaunchpadGitFixture();
  tempRoots.push(root);
  const manifestPath = `${root}/organizations/OmegaCo_GEN3/modules.manifest.json`;
  const manifest = await Bun.file(manifestPath).json();
  manifest.module_slots.push({
    slug: "buddy-gen2",
    path: "productionspace/Buddy_GEN2",
    space: "productionspace",
    category: "platform-runtime",
    git: { url: "git@github.com:OmegaCo/Buddy_GEN2.git", branch: "main" },
  });
  await Bun.write(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const inventory = await buildGitInventory({ companiesRoot: root });
  expect(inventory.repos.find((repo) => repo.key === "OmegaCo::buddy-gen2")).toMatchObject({
    module: "buddy-gen2",
    slot_path: "productionspace/Buddy_GEN2",
    repo_path: "organizations/OmegaCo_GEN3/productionspace/Buddy_GEN2",
    repo_kind: "productionspace",
  });
  expect(inventory.repos.some((repo) => repo.key === "OmegaCo::Buddy_GEN2")).toBe(false);
});

test("inventory preserves dotted GitHub repository metadata", async () => {
  const root = await createLaunchpadGitFixture();
  tempRoots.push(root);
  const manifestPath = `${root}/organizations/OmegaCo_GEN3/modules.manifest.json`;
  const manifest = await Bun.file(manifestPath).json();
  manifest.module_slots.push({
    slug: "knowledgebase-v2",
    path: "workspace/Knowledgebase.v2",
    git: { url: "git@github.com:OmegaCo/Knowledgebase.v2.git", branch: "main" },
  });
  await Bun.write(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const inventory = await buildGitInventory({ companiesRoot: root });
  expect(inventory.repos.find((repo) => repo.key === "OmegaCo::knowledgebase-v2")?.remote).toEqual({
    url_kind: "github",
    owner_repo: "OmegaCo/Knowledgebase.v2",
  });
});

test("inventory quarantines one renamed slot without hiding healthy siblings or another Organization", async () => {
  const root = await createLaunchpadGitFixture();
  tempRoots.push(root);
  const manifestPath = `${root}/organizations/OmegaCo_GEN3/modules.manifest.json`;
  const manifest = await Bun.file(manifestPath).json();
  manifest.module_slots.push({
    slug: "website",
    path: "workspace/website",
    git: { url: "git@github.com:OmegaCo/website-v2.git", branch: "main" },
  });
  await Bun.write(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const inventory = await buildGitInventory({ companiesRoot: root });

  expect(inventory.repos.some((repo) => repo.key === "OmegaCo::website")).toBe(false);
  expect(inventory.repos.some((repo) => repo.key === "OmegaCo::studio")).toBe(true);
  expect(inventory.repos.some((repo) => repo.key === "BetaCo::deals")).toBe(true);
  expect(inventory.inventory_issues).toEqual(expect.arrayContaining([
    expect.objectContaining({
      code: "repository_location_mismatch",
      organization: "OmegaCo",
      module: "website",
      path: "workspace/website",
      expected_path: "workspace/website-v2",
      next_action: expect.objectContaining({ kind: "repair_module_location" }),
    }),
  ]));
});

test("inventory detects a stable-slug checkout at its old path and never materializes a duplicate target", async () => {
  const root = await createLaunchpadGitFixture();
  tempRoots.push(root);
  const organizationRoot = join(root, "organizations", "OmegaCo_GEN3");
  const legacyRoot = join(organizationRoot, "workspace", "website");
  await mkdir(legacyRoot, { recursive: true });
  await Bun.write(join(legacyRoot, "lazurio.module.json"), `${JSON.stringify({
    schema_version: "lazurio.module.v1",
    id: "website",
    company: "OmegaCo",
  }, null, 2)}\n`);
  const manifestPath = join(organizationRoot, "modules.manifest.json");
  const manifest = await Bun.file(manifestPath).json();
  manifest.module_slots.push({
    slug: "website",
    path: "workspace/website-v2",
    git: { url: "git@github.com:OmegaCo/website-v2.git", branch: "main" },
  });
  await Bun.write(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const companyPath = join(organizationRoot, "company.gen3.json");
  const company = await Bun.file(companyPath).json();
  company.modules = [{
    slug: "website",
    path: "workspace/website-v2",
    repo: "git@github.com:OmegaCo/website-v2.git",
  }];
  await Bun.write(companyPath, `${JSON.stringify(company, null, 2)}\n`);

  const inventory = await buildGitInventory({ companiesRoot: root });

  expect(inventory.repos.some((repo) => repo.key === "OmegaCo::website")).toBe(false);
  expect(inventory.planned.some((repo) => repo.key === "OmegaCo::website")).toBe(false);
  expect(inventory.repos.some((repo) => repo.key === "OmegaCo::studio")).toBe(true);
  expect(inventory.inventory_issues).toEqual(expect.arrayContaining([
    expect.objectContaining({
      code: "repository_location_mismatch",
      module: "website",
      path: "workspace/website",
      expected_path: "workspace/website-v2",
      next_action: expect.objectContaining({ kind: "repair_module_location" }),
    }),
  ]));
});

test("inventory treats a case-only checkout path as one repairable module mismatch", async () => {
  const root = await createLaunchpadGitFixture();
  tempRoots.push(root);
  const organizationRoot = join(root, "organizations", "OmegaCo_GEN3");
  const observedRoot = join(organizationRoot, "workspace", "Website");
  await mkdir(observedRoot, { recursive: true });
  await Bun.write(join(observedRoot, "lazurio.module.json"), `${JSON.stringify({
    schema_version: "lazurio.module.v1",
    id: "website",
    company: "OmegaCo",
  }, null, 2)}\n`);
  const manifestPath = join(organizationRoot, "modules.manifest.json");
  const manifest = await Bun.file(manifestPath).json();
  manifest.module_slots.push({
    slug: "website",
    path: "workspace/website",
    git: { url: "git@github.com:OmegaCo/website.git", branch: "main" },
  });
  await Bun.write(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const inventory = await buildGitInventory({ companiesRoot: root });
  const issues = inventory.inventory_issues.filter((issue) => issue.module === "website");

  expect(inventory.repos.some((repo) => repo.key === "OmegaCo::website")).toBe(false);
  expect(inventory.repos.some((repo) => repo.key === "OmegaCo::studio")).toBe(true);
  expect(issues).toEqual([
    expect.objectContaining({
      code: "repository_location_mismatch",
      path: "workspace/Website",
      expected_path: "workspace/website",
      next_action: expect.objectContaining({ kind: "repair_module_location" }),
    }),
  ]);
});

test("inventory persistently quarantines a stable-slug Git suspect with an unverifiable marker", async () => {
  const root = await createLaunchpadGitFixture();
  tempRoots.push(root);
  const organizationRoot = join(root, "organizations", "OmegaCo_GEN3");
  const legacyRoot = join(organizationRoot, "workspace", "website");
  await mkdir(join(legacyRoot, ".git"), { recursive: true });
  const manifestPath = join(organizationRoot, "modules.manifest.json");
  const manifest = await Bun.file(manifestPath).json();
  manifest.module_slots.push({
    slug: "website",
    path: "workspace/website-v2",
    git: { url: "git@github.com:OmegaCo/website-v2.git", branch: "main" },
  });
  await Bun.write(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const first = await buildGitInventory({ companiesRoot: root });
  const second = await buildGitInventory({ companiesRoot: root });
  for (const inventory of [first, second]) {
    expect(inventory.repos.some((repo) => repo.key === "OmegaCo::website")).toBe(false);
    expect(inventory.planned.some((repo) => repo.key === "OmegaCo::website")).toBe(false);
    expect(inventory.inventory_issues.filter((issue) => issue.module === "website")).toEqual([
      expect.objectContaining({
        code: "repository_transition_unverified",
        path: "workspace/website",
        expected_path: "workspace/website-v2",
        next_action: expect.objectContaining({
          kind: "repair_module_location",
          prompt: expect.stringContaining("marker_missing"),
        }),
      }),
    ]);
  }
});

test("inventory keeps an exact canonical markerless checkout updateable so Sync can publish its marker", async () => {
  const root = await createLaunchpadGitFixture();
  tempRoots.push(root);
  const checkout = join(root, "organizations", "OmegaCo_GEN3", "workspace", "studio");
  await initGitRepo(checkout);
  await rm(join(checkout, "lazurio.module.json"));
  runGit(["add", "-u"], checkout);
  runGit(["commit", "-m", "legacy checkout without Module marker"], checkout);

  const inventory = await buildGitInventory({ companiesRoot: root });

  expect(inventory.repos).toContainEqual(expect.objectContaining({
    key: "OmegaCo::studio",
    absolute_path: checkout,
  }));
  expect(inventory.inventory_issues.some((issue) => issue.module === "studio")).toBe(false);
});

test("inventory quarantines exact markerless checkouts whose Git metadata can redirect outside the Module", async () => {
  for (const metadataKind of ["file", "symlink"]) {
    const root = await createLaunchpadGitFixture();
    tempRoots.push(root);
    const checkout = join(root, "organizations", "OmegaCo_GEN3", "workspace", "studio");
    await initGitRepo(checkout);
    await rm(join(checkout, "lazurio.module.json"));
    const metadataPath = join(checkout, ".git");

    if (metadataKind === "file") {
      await rm(metadataPath, { recursive: true });
      await writeFile(metadataPath, "gitdir: ../../../../outside-module-git\n");
    } else {
      const externalMetadata = join(root, "outside-module-git");
      await rename(metadataPath, externalMetadata);
      await symlink(
        externalMetadata,
        metadataPath,
        process.platform === "win32" ? "junction" : "dir",
      );
    }

    const inventory = await buildGitInventory({ companiesRoot: root });

    expect(inventory.repos.some((repo) => repo.key === "OmegaCo::studio")).toBe(false);
    expect(inventory.repos.some((repo) => repo.key === "OmegaCo::infra")).toBe(true);
    expect(inventory.repos.some((repo) => repo.key === "BetaCo::deals")).toBe(true);
    expect(inventory.inventory_issues).toContainEqual(expect.objectContaining({
      code: "repository_transition_unverified",
      module: "studio",
      path: "workspace/studio",
      expected_path: "workspace/studio",
    }));
  }
});

test("inventory lets ambiguity dominate a repairable manifest mismatch", async () => {
  const root = await createLaunchpadGitFixture();
  tempRoots.push(root);
  const organizationRoot = join(root, "organizations", "OmegaCo_GEN3");
  for (const basename of ["website", "website-v2"]) {
    const checkout = join(organizationRoot, "workspace", basename);
    await mkdir(checkout, { recursive: true });
    await Bun.write(join(checkout, "lazurio.module.json"), `${JSON.stringify({
      schema_version: "lazurio.module.v1",
      id: "website",
      company: "OmegaCo",
    }, null, 2)}\n`);
  }
  const manifestPath = join(organizationRoot, "modules.manifest.json");
  const manifest = await Bun.file(manifestPath).json();
  manifest.module_slots.push({
    slug: "website",
    path: "workspace/website",
    git: { url: "git@github.com:OmegaCo/website-v2.git", branch: "main" },
  });
  await Bun.write(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const inventory = await buildGitInventory({ companiesRoot: root });
  const issues = inventory.inventory_issues.filter((issue) => issue.module === "website");

  expect(inventory.repos.some((repo) => repo.key === "OmegaCo::website")).toBe(false);
  expect(inventory.repos.some((repo) => repo.key === "OmegaCo::studio")).toBe(true);
  expect(issues).toEqual([
    expect.objectContaining({
      code: "repository_location_ambiguous",
      expected_path: "workspace/website-v2",
      observed_paths: ["workspace/website", "workspace/website-v2"],
      next_action: expect.objectContaining({
        kind: "agent_review",
        prompt: expect.stringContaining("workspace/website-v2"),
      }),
    }),
  ]);
});

test("inventory excludes only active slots with a bad Team, remote or managed branch", async () => {
  const root = await createLaunchpadGitFixture();
  tempRoots.push(root);
  const organizationRoot = join(root, "organizations", "OmegaCo_GEN3");
  const companyPath = join(organizationRoot, "company.gen3.json");
  const company = await Bun.file(companyPath).json();
  company.teams = [{ slug: "workspace", default: true }];
  await Bun.write(companyPath, `${JSON.stringify(company, null, 2)}\n`);
  const manifestPath = join(organizationRoot, "modules.manifest.json");
  const manifest = await Bun.file(manifestPath).json();
  manifest.module_slots.push(
    {
      slug: "bad-team",
      path: "workspace/bad-team",
      teams: ["missing"],
      git: { url: "git@github.com:OmegaCo/bad-team.git", branch: "main" },
    },
    {
      slug: "no-remote",
      path: "workspace/no-remote",
      teams: ["workspace"],
      status: "active",
    },
    {
      slug: "placeholder-remote",
      path: "workspace/placeholder-remote",
      teams: ["workspace"],
      status: "active",
      git: { url: "git@github.com:<owner>/placeholder-remote.git", branch: "main" },
    },
    {
      slug: "feature-branch",
      path: "workspace/feature-branch",
      teams: ["workspace"],
      git: { url: "git@github.com:OmegaCo/feature-branch.git", branch: "feature" },
    },
    {
      slug: "invalid-remote",
      path: "workspace/invalid-remote",
      teams: ["workspace"],
      git: { url: "https://git.example.test/OmegaCo/invalid-remote.git", branch: "main" },
    },
  );
  await Bun.write(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const inventory = await buildGitInventory({ companiesRoot: root });

  for (const module of ["bad-team", "no-remote", "placeholder-remote", "feature-branch", "invalid-remote"]) {
    expect(inventory.repos.some((repo) => repo.key === `OmegaCo::${module}`)).toBe(false);
    expect(inventory.planned.some((repo) => repo.key === `OmegaCo::${module}`)).toBe(false);
  }
  expect(inventory.repos.some((repo) => repo.key === "OmegaCo::studio")).toBe(true);
  expect(inventory.repos.some((repo) => repo.key === "BetaCo::deals")).toBe(true);
  expect(inventory.inventory_issues).toEqual(expect.arrayContaining([
    expect.objectContaining({
      code: "slot_team_invalid",
      module: "bad-team",
      next_action: expect.objectContaining({ kind: "agent_review" }),
    }),
    expect.objectContaining({ code: "slot_remote_missing", module: "no-remote" }),
    expect.objectContaining({ code: "slot_remote_missing", module: "placeholder-remote" }),
    expect.objectContaining({ code: "slot_branch_invalid", module: "feature-branch" }),
    expect.objectContaining({ code: "slot_remote_invalid", module: "invalid-remote" }),
  ]));
});

test("inventory never authorizes a target occupied by another stable Module identity", async () => {
  const root = await createLaunchpadGitFixture();
  tempRoots.push(root);
  const organizationRoot = join(root, "organizations", "OmegaCo_GEN3");
  const occupied = join(organizationRoot, "workspace", "victim");
  await mkdir(join(occupied, ".git"), { recursive: true });
  await Bun.write(join(occupied, "lazurio.module.json"), `${JSON.stringify({
    schema_version: "lazurio.module.v1",
    id: "other",
    company: "OmegaCo",
  }, null, 2)}\n`);
  const manifestPath = join(organizationRoot, "modules.manifest.json");
  const manifest = await Bun.file(manifestPath).json();
  manifest.module_slots.push(
    {
      slug: "victim",
      path: "workspace/victim",
      git: { url: "git@github.com:OmegaCo/victim.git", branch: "main" },
    },
    {
      slug: "other",
      path: "workspace/other",
      git: { url: "git@github.com:OmegaCo/other.git", branch: "main" },
    },
  );
  await Bun.write(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const inventory = await buildGitInventory({ companiesRoot: root });

  expect(inventory.repos.some((repo) => repo.key === "OmegaCo::victim")).toBe(false);
  expect(inventory.inventory_issues).toContainEqual(expect.objectContaining({
    code: "repository_location_ambiguous",
    module: "victim",
    expected_path: "workspace/victim",
    observed_paths: ["workspace/victim"],
    next_action: expect.objectContaining({ kind: "agent_review" }),
  }));
});

test("inventory keeps a canonical nested repository-db outside every Git action surface", async () => {
  const root = await createLaunchpadGitFixture();
  tempRoots.push(root);
  const manifestPath = `${root}/organizations/OmegaCo_GEN3/modules.manifest.json`;
  const manifest = await Bun.file(manifestPath).json();
  manifest.module_slots.push({
    slug: "studio-data",
    path: "workspace/studio/db",
    materialization: "repository_db_mount",
    source_of_truth: "repository-db:v3",
    git: { url: "git@github.com:OmegaCo/studio-data.git", branch: "v3" },
  });
  await Bun.write(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const inventory = await buildGitInventory({ companiesRoot: root });

  expect(inventory.warnings).toEqual([]);
  expect(inventory.repos.find((repo) => repo.key === "OmegaCo::studio")).toMatchObject({
    repo_kind: "module",
    expected_branch: "main",
  });
  expect(inventory.repos.some((repo) => repo.key === "OmegaCo::studio-data")).toBe(false);
  expect(inventory.planned.some((repo) => repo.key === "OmegaCo::studio-data")).toBe(false);
});

test("inventory fails closed instead of hiding a malformed nested repository-db", async () => {
  const root = await createLaunchpadGitFixture();
  tempRoots.push(root);
  const manifestPath = `${root}/organizations/OmegaCo_GEN3/modules.manifest.json`;
  const manifest = await Bun.file(manifestPath).json();
  manifest.module_slots.push({
    slug: "studio-data",
    path: "workspace/studio/db",
    source_of_truth: "repository-db:v3",
    git: { url: "https://git.example.test/OmegaCo/studio-data.git", branch: "v3" },
  });
  await Bun.write(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const inventory = await buildGitInventory({ companiesRoot: root });

  expect(inventory.repos.some((repo) => repo.key === "OmegaCo::studio-data")).toBe(false);
  expect(inventory.planned.some((repo) => repo.key === "OmegaCo::studio-data")).toBe(false);
  expect(inventory.warnings.some((warning) => warning.includes("platný GitHub remote"))).toBe(true);
});

test("inventory fails closed when two repository mounts resolve to the same logical ID", async () => {
  const root = await createLaunchpadGitFixture();
  tempRoots.push(root);
  const manifestPath = `${root}/organizations/OmegaCo_GEN3/modules.manifest.json`;
  const manifest = await Bun.file(manifestPath).json();
  manifest.module_slots.push(
    {
      slug: "buddy-gen2",
      path: "productionspace/Buddy_GEN2",
      git: { url: "git@github.com:OmegaCo/Buddy_GEN2.git", branch: "main" },
    },
    {
      slug: "buddy-gen2",
      path: "productionspace/BuddyLegacy",
      git: { url: "git@github.com:OmegaCo/BuddyLegacy.git", branch: "main" },
    },
  );
  await Bun.write(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const inventory = await buildGitInventory({ companiesRoot: root });

  expect(inventory.repos.some((repo) => repo.key === "OmegaCo::buddy-gen2")).toBe(false);
  expect(inventory.repos.some((repo) => repo.key === "OmegaCo::studio")).toBe(true);
  expect(inventory.repos.some((repo) => repo.key === "OmegaCo::infra")).toBe(true);
  expect(inventory.repos.some((repo) => repo.key === "BetaCo::deals")).toBe(true);
  expect(inventory.warnings.join("\n")).toContain('repository slug "buddy-gen2"');
  expect(inventory.inventory_issues).toContainEqual(expect.objectContaining({
    code: "slot_collection_ambiguous",
    module: "buddy-gen2",
    next_action: expect.objectContaining({ kind: "agent_review" }),
  }));
});

test("inventory applies cross-file logical identity collisions to the action surface", async () => {
  const root = await createLaunchpadGitFixture();
  tempRoots.push(root);
  const organizationRoot = join(root, "organizations", "OmegaCo_GEN3");
  const manifestPath = join(organizationRoot, "modules.manifest.json");
  const companyPath = join(organizationRoot, "company.gen3.json");
  const manifest = await Bun.file(manifestPath).json();
  const company = await Bun.file(companyPath).json();
  manifest.module_slots.push({
    slug: "shared",
    path: "workspace/shared-manifest",
    repo: "git@github.com:OmegaCo/shared-manifest.git",
    branch: "main",
  });
  company.modules = [{ slug: "shared", path: "workspace/shared-company" }];
  await Bun.write(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  await Bun.write(companyPath, `${JSON.stringify(company, null, 2)}\n`);

  const inventory = await buildGitInventory({ companiesRoot: root });

  expect(inventory.repos.some((repo) => repo.key === "OmegaCo::shared")).toBe(false);
  expect(inventory.repos.some((repo) => repo.key === "OmegaCo::studio")).toBe(true);
  expect(inventory.repos.some((repo) => repo.key === "OmegaCo::infra")).toBe(true);
  expect(inventory.repos.some((repo) => repo.key === "BetaCo::deals")).toBe(true);
  expect(inventory.warnings.join("\n")).toContain('repository slug "shared"');
});

test("inventory reserves the implicit Organization root ID", async () => {
  const root = await createLaunchpadGitFixture();
  tempRoots.push(root);
  const manifestPath = `${root}/organizations/OmegaCo_GEN3/modules.manifest.json`;
  const manifest = await Bun.file(manifestPath).json();
  manifest.module_slots.push({
    slug: "root",
    path: "workspace/root-tools",
    repo: "git@github.com:OmegaCo/root-tools.git",
    branch: "main",
  });
  await Bun.write(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const inventory = await buildGitInventory({ companiesRoot: root });

  expect(inventory.repos.filter((repo) => repo.key === "OmegaCo::root")).toHaveLength(1);
  expect(inventory.repos.some((repo) => repo.slot_path === "workspace/root-tools")).toBe(false);
});

test("inventory odmítne existující root, workspace i productionspace checkout přes symlink nebo Windows junction mimo Organizaci", async () => {
  const root = await createLaunchpadGitFixture();
  tempRoots.push(root);
  const organizationRoot = join(root, "organizations", "OmegaCo_GEN3");
  const manifestPath = join(organizationRoot, "modules.manifest.json");
  const manifest = await Bun.file(manifestPath).json();
  manifest.module_slots.push({
    path: "productionspace/firmware",
    space: "productionspace",
    category: "firmware",
    repo: "git@github.com:OmegaCo/firmware.git",
    branch: "main",
  });
  await Bun.write(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const externalRoot = join(root, "external-repositories");
  await Promise.all([
    mkdir(join(externalRoot, "infra"), { recursive: true }),
    mkdir(join(externalRoot, "studio"), { recursive: true }),
    mkdir(join(externalRoot, "firmware"), { recursive: true }),
    mkdir(join(organizationRoot, "workspace"), { recursive: true }),
    mkdir(join(organizationRoot, "productionspace"), { recursive: true }),
  ]);
  const linkType = process.platform === "win32" ? "junction" : "dir";
  await Promise.all([
    symlink(join(externalRoot, "infra"), join(organizationRoot, "infra"), linkType),
    symlink(join(externalRoot, "studio"), join(organizationRoot, "workspace", "studio"), linkType),
    symlink(join(externalRoot, "firmware"), join(organizationRoot, "productionspace", "firmware"), linkType),
  ]);

  const inventory = await buildGitInventory({ companiesRoot: root });

  expect(inventory.repos.some((repo) => repo.key === "OmegaCo::root")).toBe(true);
  for (const repoKey of ["OmegaCo::infra", "OmegaCo::studio", "OmegaCo::firmware"]) {
    expect(inventory.repos.some((repo) => repo.key === repoKey)).toBe(false);
  }
  expect(inventory.warnings.filter((warning) => warning.includes("symlink/junction"))).toHaveLength(3);
});

test("inventory odmítne Organization mount přes symlink nebo Windows junction mimo Lazurio root", async () => {
  const root = await createLaunchpadGitFixture();
  tempRoots.push(root);
  const organizationRoot = join(root, "organizations", "OmegaCo_GEN3");
  const externalRoot = join(root, "..", `escaped-organization-${process.pid}-${Date.now()}`);
  tempRoots.push(externalRoot);
  await rename(organizationRoot, externalRoot);
  await symlink(
    externalRoot,
    organizationRoot,
    process.platform === "win32" ? "junction" : "dir",
  );

  const inventory = await buildGitInventory({
    companiesRoot: root,
    organizations: [{
      slug: "OmegaCo",
      display_name: "OmegaCo GEN3",
      path: "organizations/OmegaCo_GEN3",
      default_branch: "main",
    }],
  });

  expect(inventory.repos.some((repo) => repo.organization === "OmegaCo")).toBe(false);
  expect(inventory.warnings.join("\n")).toContain(
    "mount vynechán z git inventáře — kanonická cesta se přes symlink/junction dostává mimo Lazurio root",
  );
});

test("inventory odmítne Organization mount aliasovaný přes symlink nebo Windows junction na sourozeneckou Organizaci", async () => {
  const root = await createLaunchpadGitFixture();
  tempRoots.push(root);
  const aliasPath = join(root, "organizations", "AliasCo_GEN3");
  await symlink(
    join(root, "organizations", "BetaCo_GEN3"),
    aliasPath,
    process.platform === "win32" ? "junction" : "dir",
  );

  const inventory = await buildGitInventory({
    companiesRoot: root,
    organizations: [{
      slug: "AliasCo",
      display_name: "AliasCo GEN3",
      path: "organizations/AliasCo_GEN3",
      default_branch: "main",
    }],
  });

  expect(inventory.repos.some((repo) => repo.organization === "AliasCo")).toBe(false);
  expect(inventory.warnings.join("\n")).toContain(
    "organizations/AliasCo_GEN3: mount vynechán z git inventáře",
  );
});

test("reserved Organization root path cannot masquerade as a Team module", async () => {
  const root = await createLaunchpadGitFixture();
  tempRoots.push(root);
  const manifestPath = `${root}/organizations/OmegaCo_GEN3/modules.manifest.json`;
  const manifest = await Bun.file(manifestPath).json();
  manifest.module_slots.push({
    path: "design-system",
    space: "workspace",
    workspace: "brand",
    category: "brand",
    git: { url: "git@github.com:OmegaCo/brand-design-system.git", branch: "main" },
  });
  await Bun.write(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const inventory = await buildGitInventory({ companiesRoot: root });
  expect(
    inventory.repos.some(
      (repo) =>
        repo.organization === "OmegaCo" && repo.slot_path === "design-system",
    ),
  ).toBe(false);
  expect(inventory.warnings.join("\n")).toContain(
    'root slot design-system vynechán z git/worktree inventáře — musí explicitně deklarovat space: "root"',
  );
});

test("Organization kontejnery a descendants rezervovaných root slotů nevstoupí do inventáře", async () => {
  const root = await createLaunchpadGitFixture();
  tempRoots.push(root);
  const manifestPath = `${root}/organizations/OmegaCo_GEN3/modules.manifest.json`;
  const manifest = await Bun.file(manifestPath).json();
  const invalidPaths = [
    "workspace/",
    "modules",
    "productionspace",
    "design-system/theme",
    "infra/state",
    "mission-control/cache",
    "mission-control/db/archive",
    "workspace/deep/repo",
    "workspace\\evil",
  ];
  for (const path of invalidPaths) {
    manifest.module_slots.push({
      path,
      space: "workspace",
      workspace: "workspace",
      category: "invalid-boundary",
      git: { url: `git@github.com:OmegaCo/${path.replaceAll("/", "-")}.git`, branch: "main" },
    });
  }
  await Bun.write(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const inventory = await buildGitInventory({ companiesRoot: root });
  const inventoriedPaths = [
    ...inventory.repos.map((repo) => repo.slot_path),
    ...inventory.planned.map((slot) => slot.slot_path),
  ];
  for (const path of ["workspace", "modules", "productionspace", ...invalidPaths.slice(3)]) {
    expect(inventoriedPaths).not.toContain(path);
  }
  expect(inventory.warnings.join("\n")).toContain(
    "Organization kontejner není repozitářový slot",
  );
  expect(inventory.warnings.join("\n")).toContain(
    "cesta je uvnitř rezervované Organization root boundary",
  );
  expect(inventory.warnings.join("\n")).toContain(
    "cesta není kanonická podporovaná Organization-relative repo boundary",
  );
});

test("productionspace path cannot masquerade as an actionable Team module", async () => {
  const root = await createLaunchpadGitFixture();
  tempRoots.push(root);
  const manifestPath = `${root}/organizations/OmegaCo_GEN3/modules.manifest.json`;
  const manifest = await Bun.file(manifestPath).json();
  manifest.module_slots.push({
    path: "productionspace/firmware",
    space: "workspace",
    category: "firmware",
    git: { url: "git@github.com:OmegaCo/firmware.git", branch: "main" },
  });
  await Bun.write(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const inventory = await buildGitInventory({ companiesRoot: root });
  const slot = inventory.repos.find(
    (repo) =>
      repo.organization === "OmegaCo" &&
      repo.slot_path === "productionspace/firmware",
  );

  expect(slot).toMatchObject({
    space: "productionspace",
    workspace: "productionspace",
    repo_kind: "productionspace",
  });

  manifest.module_slots.push({
    path: "productionspace/",
    space: "workspace",
    category: "boundary",
    git: { url: "git@github.com:OmegaCo/productionspace.git", branch: "main" },
  });
  await Bun.write(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const inventoryWithBoundary = await buildGitInventory({ companiesRoot: root });
  expect(
    inventoryWithBoundary.repos.find(
      (repo) =>
        repo.organization === "OmegaCo" && repo.slot_path === "productionspace",
    ),
  ).toBeUndefined();
  expect(inventoryWithBoundary.warnings.join("\n")).toContain(
    "slot productionspace/ vynechán z git/worktree inventáře — Organization kontejner není repozitářový slot",
  );
});

test("incomplete active root coordinates never enter actionable inventory", async () => {
  const root = await createLaunchpadGitFixture();
  tempRoots.push(root);
  const manifestPath = `${root}/organizations/OmegaCo_GEN3/modules.manifest.json`;
  const manifest = await Bun.file(manifestPath).json();
  manifest.module_slots.push({
    path: "design-system",
    space: "root",
    category: "brand",
    git: {
      url: "git@github.com:OmegaCo/design-system.git",
    },
  });
  await Bun.write(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const inventory = await buildGitInventory({ companiesRoot: root });
  expect(
    inventory.repos.some(
      (repo) =>
        repo.organization === "OmegaCo" && repo.slot_path === "design-system",
    ),
  ).toBe(false);
  expect(
    inventory.planned.some(
      (slot) =>
        slot.organization === "OmegaCo" && slot.slot_path === "design-system",
    ),
  ).toBe(false);
  expect(inventory.warnings.join("\n")).toContain(
    "aktivní root slot musí mít úplné git.url i git.branch",
  );
});

test("root inventory rejects legacy aliases even beside canonical git coordinates", async () => {
  const root = await createLaunchpadGitFixture();
  tempRoots.push(root);
  const manifestPath = `${root}/organizations/OmegaCo_GEN3/modules.manifest.json`;
  const manifest = await Bun.file(manifestPath).json();
  manifest.module_slots.push({
    path: "design-system",
    space: "root",
    category: "brand",
    repo: "git@github.com:WrongOrg/wrong-design-system.git",
    branch: "legacy",
    git: {
      url: "git@github.com:OmegaCo/design-system.git",
      branch: "main",
    },
  });
  await Bun.write(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const inventory = await buildGitInventory({ companiesRoot: root });
  expect(
    inventory.repos.some(
      (repo) =>
        repo.organization === "OmegaCo" && repo.slot_path === "design-system",
    ),
  ).toBe(false);
  expect(inventory.warnings.join("\n")).toContain(
    "root-neplatná pole (repo, branch)",
  );
});

test("template mount (organization_kind=template) je z git inventáře vyloučený (decision 0077)", async () => {
  const root = await createLaunchpadGitFixture();
  tempRoots.push(root);
  const { mkdir, writeFile } = await import("fs/promises");
  const { join } = await import("path");
  const templateRoot = join(root, "organizations", "OrganizationTemplate_GEN3");
  await mkdir(templateRoot, { recursive: true });
  await writeFile(
    join(templateRoot, "company.gen3.json"),
    JSON.stringify({ organization_generation: "gen3", organization_kind: "template", company: { slug: "<VYPLNIT_slug>" } }),
    "utf8",
  );

  const inventory = await buildGitInventory({ companiesRoot: root });

  // Template mount se nesmí stát akčním repozitářem na git/worktree plochách.
  expect(inventory.repos.some((repo) => repo.repo_path.includes("OrganizationTemplate_GEN3"))).toBe(false);
  expect(inventory.repos.some((repo) => repo.organization === "OrganizationTemplate")).toBe(false);
});

test("ne-template mount s placeholder slugem je z git inventáře vynechaný (zrcadlí discovery guard)", async () => {
  const root = await createLaunchpadGitFixture();
  tempRoots.push(root);
  const { mkdir, writeFile } = await import("fs/promises");
  const { join } = await import("path");
  const scaffoldRoot = join(root, "organizations", "ScaffoldOrg_GEN3");
  await mkdir(scaffoldRoot, { recursive: true });
  // Nedokončený scaffold: deklarovaný slug je placeholder a marker template chybí.
  await writeFile(
    join(scaffoldRoot, "company.gen3.json"),
    JSON.stringify({ organization_generation: "gen3", company: { slug: "<VYPLNIT_slug>" } }),
    "utf8",
  );

  const inventory = await buildGitInventory({ companiesRoot: root });

  expect(inventory.repos.some((repo) => repo.repo_path.includes("ScaffoldOrg_GEN3"))).toBe(false);
  expect(inventory.repos.some((repo) => repo.organization === "ScaffoldOrg")).toBe(false);
});

test("mount bez povinné GEN3 struktury je z git inventáře vynechaný s warningem (stejný gate jako discovery)", async () => {
  const root = await createLaunchpadGitFixture();
  tempRoots.push(root);
  const { mkdir, writeFile } = await import("fs/promises");
  const { join } = await import("path");
  const brokenRoot = join(root, "organizations", "BrokenOrg_GEN3");
  await mkdir(brokenRoot, { recursive: true });
  // Validní marker, ale chybí modules.manifest.json, manual i company/colleagues.
  await writeFile(
    join(brokenRoot, "company.gen3.json"),
    JSON.stringify({ organization_generation: "gen3", company: { slug: "BrokenOrg" } }),
    "utf8",
  );

  const inventory = await buildGitInventory({ companiesRoot: root });

  expect(inventory.repos.some((repo) => repo.organization === "BrokenOrg")).toBe(false);
  expect(inventory.warnings.some((warning) => warning.includes("BrokenOrg_GEN3") && warning.includes("chybí povinná GEN3 struktura"))).toBe(true);

  // Gate platí i pro explicitně předaný organizations argument (discovery výstup) —
  // explicitní vstup nesmí obejít strukturální validaci přítomného mountu.
  const explicitInventory = await buildGitInventory({
    companiesRoot: root,
    organizations: [
      { slug: "BrokenOrg", display_name: "Broken Org", path: "organizations/BrokenOrg_GEN3", default_branch: "main" },
    ],
  });
  expect(explicitInventory.repos.some((repo) => repo.organization === "BrokenOrg")).toBe(false);
  expect(explicitInventory.warnings.some((warning) => warning.includes("chybí povinná GEN3 struktura"))).toBe(true);
});

test("git action inventory rejects traversal and symlink module paths that escape an Organization", async () => {
  const root = await createLaunchpadGitFixture();
  tempRoots.push(root);
  const betaRoot = join(root, "organizations", "BetaCo_GEN3");
  const omegaTarget = join(root, "organizations", "OmegaCo_GEN3", "workspace", "studio");
  await mkdir(join(betaRoot, "workspace"), { recursive: true });
  await symlink(omegaTarget, join(betaRoot, "workspace", "foreign-link"));
  const manifestPath = join(betaRoot, "modules.manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.module_slots.push(
    { slug: "shared", path: "../OmegaCo_GEN3/workspace/studio", git: { url: "git@github.com:OmegaCo/studio.git", branch: "main" } },
    { slug: "shared", path: "workspace/foreign-link", git: { url: "git@github.com:OmegaCo/studio.git", branch: "main" } },
  );
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  const inventory = await buildGitInventory({ companiesRoot: root });

  expect(inventory.repos.some((repo) =>
    repo.organization === "BetaCo" && repo.repo_kind !== "organization_root"
  )).toBe(false);
  expect(inventory.repos.some((repo) => repo.key === "OmegaCo::studio")).toBe(true);
  expect(inventory.warnings.filter((warning) => warning.includes("uniká mimo Organization root"))).toHaveLength(2);
  expect(inventory.inventory_issues).toEqual(expect.arrayContaining([
    expect.objectContaining({
      scope: "organization",
      code: "organization_module_mount_boundary_invalid",
      organization: "BetaCo",
    }),
  ]));
  expect(inventory.inventory_issues.some((issue) =>
    issue.organization === "BetaCo" && issue.code === "slot_collection_ambiguous"
  )).toBe(false);
});

test("inventory includes Organization roots and warns about missing mounts instead of crashing", async () => {
  const root = await createLaunchpadGitFixture();
  tempRoots.push(root);

  const inventory = await buildGitInventory({
    companiesRoot: root,
    organizations: [
      { slug: "MissingOrg", display_name: "Missing Org", path: "organizations/MissingOrg_GEN3", default_branch: "main" },
    ],
  });

  expect(inventory.repos).toContainEqual(
    expect.objectContaining({
      key: "MissingOrg::root",
      organization: "MissingOrg",
      repo_kind: "organization_root",
      repo_path: "organizations/MissingOrg_GEN3",
      expected_branch: "main",
    }),
  );
  expect(inventory.warnings.some((warning) => warning.includes("MissingOrg_GEN3"))).toBe(true);
});
