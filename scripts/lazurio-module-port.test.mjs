import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { platformTestTimeout } from "../launchpad/src/test-platform-setup.mjs";
import { moduleRuntimeLockIdentityTimeoutMs } from "../lazurio/runtime/module-runtime-lock-lib.mjs";
import { allocateModulePort } from "./lazurio-module-port.mjs";

const roots = [];
afterAll(async () => Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))));

test("creator allocates once from the tracked Organization pool", async () => {
  const root = await mkdtemp(join(tmpdir(), "lazurio-port-creator-"));
  roots.push(root);
  const existingRoot = join(root, "organizations", "Acme", "workspace", "alpha");
  const targetRoot = join(root, "organizations", "Acme", "workspace", "beta");
  const guideRoot = join(root, "guide");
  await mkdir(existingRoot, { recursive: true });
  await mkdir(targetRoot, { recursive: true });
  await mkdir(guideRoot, { recursive: true });
  await writeFile(join(root, "organizations", "Acme", "modules.manifest.json"), JSON.stringify({
    organization_generation: "gen3",
    company: "Acme",
    github_org: "Acme",
    module_slots: [
      { path: "workspace/alpha", slug: "alpha" },
      { path: "workspace/beta", slug: "beta" },
    ],
  }));
  await writeFile(join(root, "organizations", "Acme", "company.gen3.json"), JSON.stringify({
    organization_generation: "gen3",
    company: { slug: "Acme", display_name: "Acme", github_org: "Acme" },
    module_port_pool: { start: 24000, end: 24099 },
    modules: [{ path: "workspace/company-only", slug: "company-only" }],
  }));
  const companyOnlyRoot = join(root, "organizations", "Acme", "workspace", "company-only");
  await mkdir(companyOnlyRoot, { recursive: true });
  await writeFile(join(companyOnlyRoot, "lazurio.module.json"), JSON.stringify({
    schema_version: "lazurio.module.v1",
    id: "company-only",
    company: "Acme",
    tcp_port_policy: { mode: "single" },
    port_leases: [{ id: "main", host: "127.0.0.1", port: 24002 }],
  }));
  await writeFile(join(existingRoot, "lazurio.module.json"), JSON.stringify({
    schema_version: "lazurio.module.v1",
    id: "alpha",
    company: "Acme",
    tcp_port_policy: { mode: "single" },
    port_leases: [{ id: "main", host: "127.0.0.1", port: 24001 }],
  }));
  await writeFile(join(guideRoot, "lazurio.module.json"), JSON.stringify({
    schema_version: "lazurio.module.v1",
    id: "guide",
    company: "Lazurio",
    tcp_port_policy: { mode: "single" },
    port_leases: [{ id: "main", host: "127.0.0.1", port: 24003 }],
  }));
  const staleWorktreeRoot = join(root, "organizations", "Acme", ".worktrees", "workspace", "stale", "DEV-old");
  const personalRoot = join(root, "personalspace", "owner_GEN3", "workspace", "private");
  const noncanonicalRoot = join(existingRoot, "app", "v1");
  await mkdir(staleWorktreeRoot, { recursive: true });
  await mkdir(personalRoot, { recursive: true });
  await mkdir(noncanonicalRoot, { recursive: true });
  for (const [path, id] of [[staleWorktreeRoot, "stale"], [personalRoot, "private"], [noncanonicalRoot, "fixture"]]) {
    await writeFile(join(path, "lazurio.module.json"), JSON.stringify({
      schema_version: "lazurio.module.v1",
      id,
      company: "Acme",
      tcp_port_policy: { mode: "single" },
      port_leases: [{ id: "main", host: "127.0.0.1", port: 24002 }],
    }));
  }

  const result = await allocateModulePort({
    lazurioRoot: root,
    moduleRoot: targetRoot,
    company: "Acme",
    module: "beta",
  });
  expect(result.manifest.port_leases[0].port).toBe(24000);
  await expect(allocateModulePort({
    lazurioRoot: root,
    moduleRoot: targetRoot,
    company: "Acme",
    module: "beta",
  })).rejects.toThrow("už existuje");

  const worktreeTarget = join(root, "organizations", "Acme", ".worktrees", "workspace", "gamma", "DEV-2");
  await mkdir(worktreeTarget, { recursive: true });
  await expect(allocateModulePort({
    lazurioRoot: root,
    moduleRoot: worktreeTarget,
    company: "Acme",
    module: "gamma",
  })).rejects.toThrow("nesmí alokovat lease do worktree");
}, platformTestTimeout(5_000) + moduleRuntimeLockIdentityTimeoutMs()); // fixture budget plus one platform identity lookup

test("a guest copy of a Module never enters the host's port inventory or allocation (DEV-6694)", async () => {
  const root = await mkdtemp(join(tmpdir(), "lazurio-port-guest-"));
  roots.push(root);
  const homeOrganization = join(root, "organizations", "HomeOrg_GEN3");
  const hostOrganization = join(root, "organizations", "HostOrg_GEN3");
  const writeOrganization = async (organizationRoot, slug, pool, slots) => {
    await mkdir(organizationRoot, { recursive: true });
    await writeFile(join(organizationRoot, "modules.manifest.json"), JSON.stringify({
      organization_generation: "gen3",
      company: slug,
      github_org: slug,
      module_slots: slots,
    }));
    await writeFile(join(organizationRoot, "company.gen3.json"), JSON.stringify({
      organization_generation: "gen3",
      company: { slug, display_name: slug, github_org: slug },
      module_port_pool: pool,
      modules: [],
    }));
  };
  const writeModule = async (moduleRoot, company, id, port) => {
    await mkdir(moduleRoot, { recursive: true });
    await writeFile(join(moduleRoot, "lazurio.module.json"), JSON.stringify({
      schema_version: "lazurio.module.v1",
      id,
      company,
      tcp_port_policy: { mode: "single" },
      port_leases: [{ id: "main", host: "127.0.0.1", port }],
    }));
  };
  await writeOrganization(homeOrganization, "HomeOrg", { start: 25000, end: 25099 }, [
    { path: "workspace/mission-control", slug: "mission-control", git: { url: "git@github.com:HomeOrg/mission-control.git", branch: "main" } },
  ]);
  await writeOrganization(hostOrganization, "HostOrg", { start: 26000, end: 26099 }, [
    { path: "workspace/alpha", slug: "alpha", git: { url: "git@github.com:HostOrg/alpha.git", branch: "main" } },
    { path: "workspace/beta", slug: "beta", git: { url: "git@github.com:HostOrg/beta.git", branch: "main" } },
    {
      path: "workspace/HomeOrg_GEN3/mission-control",
      slug: "mission-control",
      home_organization: "HomeOrg",
      git: { url: "git@github.com:HomeOrg/mission-control.git", branch: "main" },
    },
  ]);
  // The home Organization's own checkout and the host's guest copy carry the same manifest.
  await writeModule(join(homeOrganization, "workspace", "mission-control"), "HomeOrg", "mission-control", 25001);
  await writeModule(join(hostOrganization, "workspace", "HomeOrg_GEN3", "mission-control"), "HomeOrg", "mission-control", 25001);
  await writeModule(join(hostOrganization, "workspace", "alpha"), "HostOrg", "alpha", 26001);
  await mkdir(join(hostOrganization, "workspace", "beta"), { recursive: true });

  const result = await allocateModulePort({
    lazurioRoot: root,
    moduleRoot: join(hostOrganization, "workspace", "beta"),
    company: "HostOrg",
    module: "beta",
  });
  expect(result.manifest.port_leases[0].port).toBe(26000);

  // The guest copy is no allocation target of the host.
  await rm(join(hostOrganization, "workspace", "HomeOrg_GEN3", "mission-control", "lazurio.module.json"));
  await expect(allocateModulePort({
    lazurioRoot: root,
    moduleRoot: join(hostOrganization, "workspace", "HomeOrg_GEN3", "mission-control"),
    company: "HostOrg",
    module: "mission-control",
  })).rejects.toThrow("není modul deklarovaný");
}, platformTestTimeout(15_000));
