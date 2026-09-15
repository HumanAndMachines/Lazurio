import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { inventoryLazurioModules } from "./lazurio-module-inventory.mjs";

const roots = [];
const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
afterAll(async () => Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))));

async function writeJson(path, value) {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

test("inventory separates Modules, empty Apps and nested repository-db slots", async () => {
  const root = await mkdtemp(join(tmpdir(), "lazurio-module-inventory-"));
  roots.push(root);
  const organization = join(root, "organizations", "Example_GEN3");
  await mkdir(join(organization, "workspace", "website", ".git"), { recursive: true });
  await mkdir(join(organization, "workspace", "notes", ".git"), { recursive: true });
  await mkdir(join(organization, "workspace", "warehouse-data", ".git"), { recursive: true });
  await writeJson(join(organization, "company.gen3.json"), {
    organization_generation: "gen3",
    company: { slug: "Example", display_name: "Example", github_org: "Example" },
  });
  await writeJson(join(organization, "modules.manifest.json"), {
    organization_generation: "gen3",
    company: "Example",
    github_org: "Example",
    module_slots: [
      { slug: "website", path: "workspace/website", git: { url: "git@github.com:Example/website.git", branch: "main" } },
      { slug: "notes", path: "workspace/notes", git: { url: "git@github.com:Example/notes.git", branch: "main" } },
      { slug: "website-data", path: "workspace/website/db", git: { url: "git@github.com:Example/website-data.git", branch: "v3" }, materialization: "repository_db_mount", source_of_truth: "repository-db:v3" },
      { slug: "future", path: "workspace/future", status: "planned_slot", source_of_truth: "planned_slot" },
      { slug: "firmware", path: "productionspace/firmware", git: { url: "git@github.com:Example/firmware.git", branch: "0.12.11-dev" } },
      { slug: "infra", path: "infra", git: { url: "git@github.com:Example/infra.git", branch: "main" } },
    ],
  });
  await writeJson(join(organization, "workspace", "website", "app", "v2", "package.json"), {
    scripts: { dev: "astro dev --port 5289" },
  });
  await writeJson(join(organization, "workspace", "notes", "lazurio.module.json"), {
    schema_version: "lazurio.module.v1",
    id: "notes",
    company: "Example",
    tcp_port_policy: { mode: "none" },
    port_leases: [],
    apps: [],
  });

  const inventory = await inventoryLazurioModules(root);
  expect(inventory.summary).toMatchObject({
    selected_organizations: 1,
    declared_modules: 2,
    materialized_modules: 2,
    missing_module_contracts: 1,
    explicit_contracts: 1,
    modules_without_apps: 1,
    runnable_undeclared_packages: 1,
    excluded_slots: 4,
  });
  const website = inventory.modules.find((module) => module.module === "website");
  expect(website).toMatchObject({
    repository: "git@github.com:Example/website.git",
    github_repository: "Example/website",
    status: "active",
    access: "ordinary",
    declaration_source: "Organization resource#repository_inventory",
  });
  expect(website.proposal).toMatchObject({
    apps: ["app/v2/package.json"],
    default_app: "app/v2/package.json",
    port_candidates: [5289],
  });
  expect(inventory.excluded.map((slot) => slot.reason).sort()).toEqual([
    "nested-db",
    "not-workspace-module",
    "planned-slot",
    "productionspace",
  ]);
});

test("inventory deterministically emits every active restricted repository from normalized manifest bindings", async () => {
  const root = await mkdtemp(join(tmpdir(), "lazurio-access-inventory-"));
  roots.push(root);
  const organization = join(root, "organizations", "Example_GEN3");
  await mkdir(organization, { recursive: true });
  await writeJson(join(organization, "company.gen3.json"), {
    organization_generation: "gen3",
    company: { slug: "Example", display_name: "Example", github_org: "Example" },
  });
  await writeJson(join(organization, "modules.manifest.json"), {
    organization_generation: "gen3",
    company: "Example",
    github_org: "Example",
    module_slots: [
      { slug: "infra", path: "infra", status: "active", default_access: "restricted", git: { url: "git@github.com:Example/infra.git", branch: "main" } },
      { slug: "audit", path: "productionspace/audit", status: "active", default_access: "private", repository: "https://github.com/Example/audit.git", branch: "main" },
      { slug: "future-secret", path: "productionspace/future-secret", status: "planned_slot", default_access: "restricted", source_of_truth: "planned_slot" },
      { slug: "website", path: "workspace/website", status: "active", default_access: "expected", git: { url: "Example/website", branch: "main" } },
    ],
  });

  const inventory = await inventoryLazurioModules(root, { organization: "Example" });
  expect(inventory.summary.selected_organizations).toBe(1);
  const records = [...inventory.modules, ...inventory.excluded];
  expect(records
    .filter((slot) => slot.status === "active" && slot.access === "restricted")
    .map(({ path, github_repository }) => ({ path, github_repository })))
    .toEqual([
      { path: "infra", github_repository: "Example/infra" },
      { path: "productionspace/audit", github_repository: "Example/audit" },
    ]);
  expect(records.find((slot) => slot.path === "productionspace/future-secret")).toMatchObject({
    status: "planned_slot",
    access: "restricted",
    repository: null,
    github_repository: null,
  });
});

test.skipIf(!Bun.which("jq"))(
  "documented restricted inventory gate rejects malformed status while excluding a planned slot",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "lazurio-access-status-gate-"));
    roots.push(root);
    const organization = join(root, "organizations", "Example_GEN3");
    await mkdir(organization, { recursive: true });
    await writeJson(join(organization, "company.gen3.json"), {
      organization_generation: "gen3",
      company: { slug: "Example", display_name: "Example", github_org: "Example" },
    });
    const manifestPath = join(organization, "modules.manifest.json");
    const manifest = {
      organization_generation: "gen3",
      company: "Example",
      github_org: "Example",
      module_slots: [
        { slug: "infra", path: "infra", status: "unexpected_status", default_access: "restricted", git: { url: "git@github.com:Example/infra.git", branch: "main" } },
        { slug: "future-secret", path: "productionspace/future-secret", status: "planned_slot", default_access: "restricted", source_of_truth: "planned_slot" },
      ],
    };
    await writeJson(manifestPath, manifest);

    const manual = (await readFile(
      join(repoRoot, "manual", "first-client-organization-rollout.md"),
      "utf8",
    )).replace(/\r\n/g, "\n");
    const commandMarker = 'jq -ce --arg expected_owner "<exact-github-org-login>" \'\n';
    const programStart = manual.indexOf(commandMarker);
    const programEnd = manual.indexOf("\n# Pro každý exact .repository", programStart);
    expect(programStart).toBeGreaterThan(-1);
    expect(programEnd).toBeGreaterThan(programStart);
    const jqProgram = manual
      .slice(programStart + commandMarker.length, programEnd)
      .trimEnd()
      .replace(/'$/, "");
    const runGate = (inventory) => spawnSync(
      Bun.which("jq"),
      ["-ce", "--arg", "expected_owner", "Example", jqProgram],
      { input: JSON.stringify(inventory), encoding: "utf8" },
    );

    for (const malformedStatus of ["unexpected_status", 17, { state: "active" }, "planned"]) {
      manifest.module_slots[0].status = malformedStatus;
      await writeJson(manifestPath, manifest);
      const malformedInventory = await inventoryLazurioModules(root, { organization: "Example" });
      expect([...malformedInventory.modules, ...malformedInventory.excluded]
        .find((slot) => slot.path === "infra")?.status).toBe("unknown");
      const malformedGate = runGate(malformedInventory);
      expect(malformedGate.status).not.toBe(0);
      expect(malformedGate.stderr).toContain("slot has unknown status");
    }

    manifest.module_slots[0].status = "active";
    await writeJson(manifestPath, manifest);
    const validInventory = await inventoryLazurioModules(root, { organization: "Example" });
    const validGate = runGate(validInventory);
    expect(validGate.status).toBe(0);
    expect(JSON.parse(validGate.stdout)).toEqual([
      { path: "infra", repository: "Example/infra" },
    ]);
    expect(validGate.stdout).not.toContain("future-secret");
  },
);

test("exact Organization selector stays fail-closed when no Organization matches", async () => {
  const root = await mkdtemp(join(tmpdir(), "lazurio-access-inventory-missing-"));
  roots.push(root);
  await mkdir(join(root, "organizations"), { recursive: true });

  const inventory = await inventoryLazurioModules(root, { organization: "Missing" });
  expect(inventory.summary.selected_organizations).toBe(0);
  expect([...inventory.modules, ...inventory.excluded]).toEqual([]);
});

test("inventory does not revive the legacy compatibility projection as a shadow repository registry", async () => {
  const root = await mkdtemp(join(tmpdir(), "lazurio-module-inventory-legacy-"));
  roots.push(root);
  const organization = join(root, "organizations", "Legacy_GEN3");
  await mkdir(join(organization, "workspace", "website", ".git"), { recursive: true });
  await writeJson(join(organization, "company.gen3.json"), {
    organization_generation: "gen3",
    company: { slug: "Legacy", display_name: "Legacy", github_org: "Legacy" },
    modules: [
      { slug: "website", path: "workspace/website", repo: "git@github.com:Legacy/website.git" },
    ],
  });

  await expect(inventoryLazurioModules(root)).rejects.toThrow("modules_manifest_missing");
});
