import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import {
  buildLaunchpadAppsResponse,
  buildLaunchpadDoctorReport,
} from "../../lazurio/runtime/diagnostics-lib.mjs";
import { buildGitInventory } from "../../lazurio/runtime/git-inventory-lib.mjs";
import { runLazurioUpdate } from "../../lazurio/runtime/lazurio-update-lib.mjs";
import { buildMissionControlPlanIndex } from "../../lazurio/runtime/mission-control-plan-lib.mjs";
import { buildWorktreeIndex } from "../../lazurio/runtime/worktree-lib.mjs";
import { buildLazurioContext } from "../../lazurio/lib.mjs";
import { collectAgentsInstanceTargets } from "../../scripts/check-organization-agents-instance.mjs";
import { readOrganizationRoot } from "../../lazurio/core/organization-root-reader-lib.mjs";
import { createPackageApp, initGitRepo, writeJson } from "./git-fixture-helpers.test.mjs";

// Kontrakt DEV-6694 (hostující Modul) na syntetických Organizacích: HostOrg
// hostuje Knowledgebase a Mission Control Organizace HomeOrg ve
// workspace/HomeOrg_GEN3/ vedle vlastní Knowledgebase a Mission Controlu.
const tempRoots = [];

afterAll(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
});

const ORGANIZATION_PATH = "organizations/HostOrg_GEN3";

function hostSlots() {
  return [
    {
      path: "workspace/knowledgebase",
      category: "knowledge",
      default_access: "expected",
      required_roles: ["*"],
      teams: ["workspace"],
      git: { url: "git@github.com:HostOrg/knowledgebase.git", branch: "main" },
    },
    {
      path: "mission-control",
      space: "root",
      category: "planning",
      default_access: "expected",
      required_roles: ["*"],
      materialization: "doctor_managed_nested_repo",
      git: { url: "git@github.com:HostOrg/mission-control.git", branch: "main" },
    },
    {
      path: "mission-control/db",
      slug: "mission-control-data",
      space: "root",
      category: "planning-data",
      default_access: "expected",
      required_roles: ["*"],
      source_of_truth: "repository-db:v3",
      materialization: "repository_db_mount",
      git: { url: "git@github.com:HostOrg/mission-control-data.git", branch: "v3" },
    },
  ];
}

function guestSlots() {
  return [
    {
      path: "workspace/HomeOrg_GEN3/knowledgebase",
      slug: "knowledgebase",
      home_organization: "HomeOrg",
      category: "knowledge",
      default_access: "expected",
      required_roles: ["*"],
      source_of_truth: "git-native",
      teams: ["workspace"],
      status: "active",
      git: { url: "git@github.com:HomeOrg/knowledgebase.git", branch: "main" },
    },
    {
      path: "workspace/HomeOrg_GEN3/mission-control",
      slug: "mission-control",
      home_organization: "HomeOrg",
      category: "planning",
      default_access: "expected",
      required_roles: ["*"],
      source_of_truth: "git-native",
      teams: ["workspace"],
      status: "active",
      git: { url: "git@github.com:HomeOrg/mission-control.git", branch: "main" },
    },
    {
      path: "workspace/HomeOrg_GEN3/mission-control/db",
      slug: "mission-control-data",
      home_organization: "HomeOrg",
      category: "planning-data",
      default_access: "expected",
      required_roles: ["*"],
      source_of_truth: "repository-db:v3",
      teams: ["workspace"],
      status: "active",
      materialization: "repository_db_mount",
      repository_db: {
        repo: "HomeOrg/mission-control-data",
        url: "git@github.com:HomeOrg/mission-control-data.git",
        branch: "v3",
        config: "repository-db.yaml",
        data_root: "data/mission-control",
        profile: "repository-db-v3",
        app_writable_path_policy: "repository_db_publish_only",
      },
      git: { url: "git@github.com:HomeOrg/mission-control-data.git", branch: "v3" },
    },
  ];
}

async function createGuestFixture({ extraSlots = [], slots = null } = {}) {
  const root = await mkdtemp(join(tmpdir(), "lazurio-guest-modules-"));
  tempRoots.push(root);
  for (const directory of ["launchpad", "guide", "manual", "organizations"]) {
    await mkdir(join(root, directory), { recursive: true });
  }
  await writeJson(join(root, "launchpad.gen3.json"), {
    workspace_generation: "gen3",
    launchpad_root: { slug: "test-root", display_name: "Test Root", root_role: "launchpad-root" },
  });
  const organizationRoot = join(root, ORGANIZATION_PATH);
  await mkdir(join(organizationRoot, "manual"), { recursive: true });
  await mkdir(join(organizationRoot, "company", "colleagues"), { recursive: true });
  await writeJson(join(organizationRoot, "company.gen3.json"), {
    organization_generation: "gen3",
    company: { slug: "HostOrg", display_name: "HostOrg", github_org: "HostOrg" },
    workspaces: [{ slug: "workspace", display_name: "HostOrg Workspace", default: true }],
    teams: [{ slug: "workspace", display_name: "HostOrg Workspace", default: true }],
    layers: [{ path: "mission-control", kind: "root-docs", ownership: "manual" }],
  });
  await writeJson(join(organizationRoot, "modules.manifest.json"), {
    organization_generation: "gen3",
    company: "HostOrg",
    github_org: "HostOrg",
    module_slots: slots ?? [...hostSlots(), ...guestSlots(), ...extraSlots],
  });
  for (const file of ["TODO.tasks.json", "DONE.tasks.json", "ISSUES.open.json"]) {
    await writeJson(join(organizationRoot, file), {});
  }
  // Hostující složka je běžný adresář hostitele jen s README.md a AGENTS.md.
  await mkdir(join(organizationRoot, "workspace", "HomeOrg_GEN3"), { recursive: true });
  await writeFile(join(organizationRoot, "workspace", "HomeOrg_GEN3", "README.md"), "# HomeOrg\n");
  await writeFile(join(organizationRoot, "workspace", "HomeOrg_GEN3", "AGENTS.md"), "# HomeOrg\n");
  return { root, organizationRoot };
}

// Materializovaný hostující checkout nese marker a App domovské Organizace.
async function materializeGuestCheckouts(organizationRoot) {
  await initGitRepo(join(organizationRoot, "workspace", "knowledgebase"));
  const guestKnowledgebase = join(organizationRoot, "workspace", "HomeOrg_GEN3", "knowledgebase");
  await initGitRepo(guestKnowledgebase);
  await writeJson(join(guestKnowledgebase, "lazurio.module.json"), {
    schema_version: "lazurio.module.v1",
    id: "knowledgebase",
    company: "HomeOrg",
  });
  const guestMissionControl = join(organizationRoot, "workspace", "HomeOrg_GEN3", "mission-control");
  await initGitRepo(guestMissionControl);
  await writeJson(join(guestMissionControl, "lazurio.module.json"), {
    schema_version: "lazurio.module.v1",
    id: "mission-control",
    company: "HomeOrg",
  });
  await createPackageApp({
    root: guestMissionControl,
    packagePath: "app",
    app: {
      id: "homeorg-mission-control",
      title: "Mission Control",
      company: "HomeOrg",
      module: "mission-control",
      port: 5293,
    },
  });
}

function hostOrganization(response) {
  return response.organizations.find((organization) => organization.slug === "HostOrg");
}

test("a valid guest pair beside the host's own KB and MC is accepted, listed read-only and never executed", async () => {
  const { root, organizationRoot } = await createGuestFixture();
  await materializeGuestCheckouts(organizationRoot);

  const response = await buildLaunchpadAppsResponse({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    runtimeManager: { appsWithRuntime: async (apps) => apps },
    includeGit: false,
  });
  const organization = hostOrganization(response);
  const payload = JSON.stringify(response);

  // Žádná App, invalid App ani failure z hostujícího checkoutu; jeho marker
  // (company HomeOrg) se s hostitelem neporovnává.
  expect(response.apps.some((app) => app.package_path.includes("HomeOrg_GEN3"))).toBe(false);
  expect((response.invalid_apps ?? []).some((app) => app.package_path.includes("HomeOrg_GEN3"))).toBe(false);
  expect(response.failures.join("\n")).not.toContain("HomeOrg_GEN3");
  expect(response.warnings.join("\n")).not.toContain("HomeOrg_GEN3");
  expect(payload).not.toContain("slot_remote_owner_mismatch");
  expect(payload).not.toContain("slot_path_noncanonical");
  expect(payload).not.toContain("marker_company_mismatch");

  // Hostující Modul není dlaždice ani Organization modul, je jen read-only.
  const tilePaths = [
    ...organization.organization_modules,
    ...organization.workspaces.flatMap((team) => team.modules),
  ].map((slot) => slot.path);
  expect(tilePaths).toContain("workspace/knowledgebase");
  expect(tilePaths.some((path) => path.includes("HomeOrg_GEN3"))).toBe(false);
  expect(organization.guest_modules.map((slot) => [slot.path, slot.slug, slot.home_organization, slot.guest]))
    .toEqual([
      ["workspace/HomeOrg_GEN3/knowledgebase", "HomeOrg/knowledgebase", "HomeOrg", true],
      ["workspace/HomeOrg_GEN3/mission-control", "HomeOrg/mission-control", "HomeOrg", true],
      ["workspace/HomeOrg_GEN3/mission-control/db", "HomeOrg/mission-control-data", "HomeOrg", true],
    ]);
  expect(organization.guest_modules.find((slot) => slot.path.endsWith("/knowledgebase")))
    .toMatchObject({ status: "available", readiness: { severity: "ok" } });
  // Chybějící hostující data mount je jen informace, nikdy blocker.
  expect(organization.guest_modules.find((slot) => slot.path.endsWith("/db")))
    .toMatchObject({
      status: "missing_access",
      ui_exposure: "diagnostics-only",
      readiness: { severity: "neutral", reason: "guest_module_absent" },
    });
  expect(organization.space_readiness.blocking_slots.some((slot) => String(slot.path).includes("HomeOrg_GEN3")))
    .toBe(false);

  const report = await buildLaunchpadDoctorReport({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    runtimeManager: { appsWithRuntime: async (apps) => apps },
  });
  const declarations = report.checks.find((check) => check.id === "launchpad.workspace_declarations");
  const details = declarations.details.join("\n");
  expect(details).toContain(
    `info: ${ORGANIZATION_PATH}/workspace/HomeOrg_GEN3/knowledgebase: hostující Modul Organizace HomeOrg (available)`,
  );
  expect(details.split("\n").filter((line) => line.startsWith("blocker:") && line.includes("HomeOrg_GEN3")))
    .toEqual([]);
});

test("git inventory clones guests as namespaced Workspace slots and keeps the host's own identities", async () => {
  const { root, organizationRoot } = await createGuestFixture();
  await materializeGuestCheckouts(organizationRoot);

  const inventory = await buildGitInventory({ companiesRoot: root });
  const repos = new Map(inventory.repos.map((repo) => [repo.key, repo]));

  expect(repos.get("HostOrg::knowledgebase")).toMatchObject({
    repo_kind: "module",
    slot_path: "workspace/knowledgebase",
  });
  expect(repos.get("HostOrg::knowledgebase").guest).toBeUndefined();
  expect(repos.get("HostOrg::HomeOrg/knowledgebase")).toMatchObject({
    repo_kind: "module",
    module: "HomeOrg/knowledgebase",
    slot_path: "workspace/HomeOrg_GEN3/knowledgebase",
    repo: "git@github.com:HomeOrg/knowledgebase.git",
    expected_branch: "main",
    home_organization: "HomeOrg",
    guest: true,
  });
  expect(repos.get("HostOrg::HomeOrg/mission-control")).toMatchObject({
    slot_path: "workspace/HomeOrg_GEN3/mission-control",
    guest: true,
  });
  // Repository-db potomek není obecný Git action target, ani hostující.
  expect([...repos.values()].some((repo) => repo.slot_path === "workspace/HomeOrg_GEN3/mission-control/db"))
    .toBe(false);
  expect(inventory.inventory_issues).toEqual([]);
});

test("invalid guest declarations quarantine only the implicated slot", async () => {
  const [knowledgebase, missionControl, data] = guestSlots();
  const { root } = await createGuestFixture({
    slots: [
      ...hostSlots(),
      // home_organization != remote owner
      {
        ...knowledgebase,
        git: { url: "git@github.com:ThirdOrg/knowledgebase.git", branch: "main" },
      },
      // home_organization == host
      {
        ...missionControl,
        path: "workspace/HostOrg_GEN3/mission-control",
        home_organization: "HostOrg",
        git: { url: "git@github.com:HostOrg/mission-control.git", branch: "main" },
      },
      // wrong middle segment
      {
        ...knowledgebase,
        slug: "notes",
        path: "workspace/OtherOrg_GEN3/notes",
        git: { url: "git@github.com:HomeOrg/notes.git", branch: "main" },
      },
      // guest db child without its guest parent
      data,
      // foreign remote without home_organization: today's behaviour
      {
        path: "workspace/handbook",
        category: "knowledge",
        default_access: "expected",
        required_roles: ["*"],
        git: { url: "git@github.com:HomeOrg/handbook.git", branch: "main" },
      },
    ],
  });

  const inventory = await buildGitInventory({ companiesRoot: root });
  const issueByPath = new Map(inventory.inventory_issues.map((issue) => [issue.path, issue]));
  expect(inventory.repos.some((repo) => repo.key === "HostOrg::knowledgebase")).toBe(true);
  expect(issueByPath.get("workspace/HomeOrg_GEN3/knowledgebase")).toMatchObject({
    scope: "module_slot",
    code: "slot_remote_owner_mismatch",
  });
  expect(issueByPath.get("workspace/HostOrg_GEN3/mission-control")).toMatchObject({
    scope: "module_slot",
    code: "slot_home_organization_is_host",
  });
  expect(issueByPath.get("workspace/OtherOrg_GEN3/notes")).toMatchObject({
    scope: "module_slot",
    code: "slot_guest_path_invalid",
  });
  expect(issueByPath.get("workspace/HomeOrg_GEN3/mission-control/db")).toMatchObject({
    scope: "module_slot",
    code: "slot_collection_ambiguous",
  });
  expect(issueByPath.get("workspace/HomeOrg_GEN3/mission-control/db").message).toContain("nemá deklarovaný parent");
  expect(issueByPath.get("workspace/handbook")).toMatchObject({
    scope: "module_slot",
    code: "slot_remote_owner_mismatch",
  });
  expect(issueByPath.get("workspace/handbook").message).toContain("hostující slot workspace/HomeOrg_GEN3/handbook");
  expect(inventory.repos.some((repo) => String(repo.slot_path).includes("_GEN3"))).toBe(false);
  expect(inventory.repos.some((repo) => repo.slot_path === "workspace/handbook")).toBe(false);

  const response = await buildLaunchpadAppsResponse({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    runtimeManager: { appsWithRuntime: async (apps) => apps },
    includeGit: false,
  });
  const organization = hostOrganization(response);
  // Hostitel běží dál: Organization zůstává v read modelu a jen dotčené sloty
  // jsou izolované.
  expect(organization).toBeDefined();
  expect(organization.guest_modules.every((slot) => slot.status === "quarantined")).toBe(true);
  const blockers = new Map(organization.space_readiness.blocking_slots.map((slot) => [slot.path, slot.reason]));
  expect(blockers.get("workspace/HomeOrg_GEN3/knowledgebase")).toBe("slot_remote_owner_mismatch");
  expect(blockers.get("workspace/HostOrg_GEN3/mission-control")).toBe("slot_home_organization_is_host");
  expect(blockers.get("workspace/OtherOrg_GEN3/notes")).toBe("slot_guest_path_invalid");
  expect(blockers.get("workspace/handbook")).toBe("slot_remote_owner_mismatch");
});

test("two guests of the same home Organization and slug collide; other homes do not", async () => {
  const [knowledgebase] = guestSlots();
  const { root } = await createGuestFixture({
    extraSlots: [
      { ...knowledgebase, path: "workspace/HomeOrg_GEN3/knowledgebase-mirror" },
      {
        ...knowledgebase,
        path: "workspace/ThirdOrg_GEN3/knowledgebase",
        home_organization: "ThirdOrg",
        git: { url: "git@github.com:ThirdOrg/knowledgebase.git", branch: "main" },
      },
    ],
  });
  const inventory = await buildGitInventory({ companiesRoot: root });
  const ambiguous = inventory.inventory_issues
    .filter((issue) => issue.code === "slot_collection_ambiguous")
    .map((issue) => issue.path)
    .sort();
  expect(ambiguous).toEqual([
    "workspace/HomeOrg_GEN3/knowledgebase",
    "workspace/HomeOrg_GEN3/knowledgebase-mirror",
  ]);
  const keys = inventory.repos.map((repo) => repo.key);
  expect(keys).toContain("HostOrg::knowledgebase");
  expect(keys).toContain("HostOrg::ThirdOrg/knowledgebase");
});

test("lazurio update materializes an absent guest with the user's own access and keeps a denial slot-local", async () => {
  const { root, organizationRoot } = await createGuestFixture();
  await initGitRepo(join(organizationRoot, "workspace", "knowledgebase"));
  const materialized = [];
  const updated = [];

  const report = await runLazurioUpdate({
    rootPath: root,
    runtimeRoot: join(root, "..", "runtime"),
    organizations: [{ slug: "HostOrg", path: ORGANIZATION_PATH }],
    deps: {
      runId: "guest-modules",
      acquireLock: async () => ({ release: async () => {} }),
      buildInventory: (options) => buildGitInventory({ ...options, companiesRoot: root }),
      updateRepo: async (repo) => {
        updated.push(repo.key);
        return {
          repo_key: repo.key,
          organization: repo.organization,
          module: repo.module,
          repo_kind: repo.repo_kind,
          repo_path: repo.repo_path,
          state: "current",
          reason: "already_current",
          message: "current",
        };
      },
      materializeRepo: async ({ repo }) => {
        materialized.push(repo.key);
        return repo.key === "HostOrg::HomeOrg/mission-control"
          ? {
              ok: false,
              outcome: "missing_access",
              code: "materialization_source_unavailable",
              message: "HomeOrg/mission-control není pro tohoto uživatele dostupný.",
            }
          : { ok: true, outcome: "materialized", head: "a".repeat(40) };
      },
      discoverApps: async () => ({ apps: [], failures: [] }),
    },
  });

  const byKey = (key) => report.results.find((result) => result.repo_key === key);
  expect(materialized).toContain("HostOrg::HomeOrg/knowledgebase");
  expect(materialized).toContain("HostOrg::HomeOrg/mission-control");
  expect(byKey("HostOrg::HomeOrg/knowledgebase")).toMatchObject({ state: "updated", reason: "module_materialized" });
  expect(byKey("HostOrg::HomeOrg/mission-control")).toMatchObject({
    state: "blocked",
    reason: "materialization_source_unavailable",
    next_action: { kind: "github_access" },
  });
  expect(updated).toContain("HostOrg::knowledgebase");
  expect(byKey("HostOrg::knowledgebase")).toMatchObject({ state: "current" });
});

test("lazurio update fast-forwards a guest but never installs its dependencies or runs its scripts", async () => {
  const { root, organizationRoot } = await createGuestFixture();
  await materializeGuestCheckouts(organizationRoot);
  // A guest Mission Control carries its home Organization's package root and lockfile.
  const guestMissionControl = join(organizationRoot, "workspace", "HomeOrg_GEN3", "mission-control");
  await writeJson(join(guestMissionControl, "package.json"), {
    name: "homeorg-mission-control-root",
    private: true,
    scripts: { postinstall: "echo must-not-run" },
  });
  await writeFile(join(guestMissionControl, "bun.lock"), "{\n  \"lockfileVersion\": 1\n}\n");
  const hostKnowledgebase = join(organizationRoot, "workspace", "knowledgebase");
  await writeJson(join(hostKnowledgebase, "package.json"), { name: "hostorg-knowledgebase-root", private: true });
  await writeFile(join(hostKnowledgebase, "bun.lock"), "{\n  \"lockfileVersion\": 1\n}\n");
  const head = "c".repeat(40);
  const refreshed = [];

  const report = await runLazurioUpdate({
    rootPath: root,
    runtimeRoot: join(root, "..", "runtime"),
    organizations: [{ slug: "HostOrg", path: ORGANIZATION_PATH }],
    deps: {
      runId: "guest-dependencies",
      acquireLock: async () => ({ release: async () => {} }),
      buildInventory: (options) => buildGitInventory({ ...options, companiesRoot: root }),
      updateRepo: async (repo) => {
        const moved = repo.key === "HostOrg::HomeOrg/mission-control" || repo.key === "HostOrg::knowledgebase";
        return {
          repo_key: repo.key,
          organization: repo.organization,
          module: repo.module,
          repo_kind: repo.repo_kind,
          repo_path: repo.repo_path,
          state: moved ? "updated" : "current",
          reason: moved ? "checkout_updated" : "already_current",
          message: "fixture",
          head,
          actions: moved ? ["fast_forward"] : [],
        };
      },
      materializeRepo: async () => ({ ok: true, outcome: "materialized", head }),
      discoverApps: async () => ({ apps: [], failures: [] }),
      refreshPackageDependencies: async ({ cwd }) => {
        refreshed.push(cwd);
        return { ok: true, refresh_strategy: "ensure" };
      },
      inspectLocalRepo: async () => ({ ok: true, branch: "main", dirtyPaths: [], head }),
      runGit: async (args) => args[0] === "rev-parse"
        ? { ok: true, stdout: head, stderr: "", exitCode: 0 }
        : { ok: false, stdout: "", stderr: "unexpected", exitCode: 1 },
    },
  });

  expect(report.results.find((result) => result.repo_key === "HostOrg::HomeOrg/mission-control")).toMatchObject({
    state: "updated",
  });
  expect(refreshed.some((cwd) => cwd.includes(join("workspace", "HomeOrg_GEN3")))).toBe(false);
  // The host's own Module with the same kind of package root is still prepared.
  expect(refreshed.some((cwd) => cwd.endsWith(join("workspace", "knowledgebase")))).toBe(true);
});

test("the host's own KB and MC stay the entrypoints; guests are no worktree or plan authority", async () => {
  const { root, organizationRoot } = await createGuestFixture();
  await materializeGuestCheckouts(organizationRoot);
  const plansPath = ["data", "mission-control", "plans", "2026", "10"];
  const hostPlans = join(organizationRoot, "mission-control", "db", ...plansPath);
  const guestPlans = join(organizationRoot, "workspace", "HomeOrg_GEN3", "mission-control", "db", ...plansPath);
  await mkdir(hostPlans, { recursive: true });
  await mkdir(guestPlans, { recursive: true });
  await writeFile(join(hostPlans, "HOST-1-host-plan.yaml"), "code: HOST-1\ntitle: Host plan\nstatus: in_progress\n");
  await writeFile(join(guestPlans, "HOME-1-home-plan.yaml"), "code: HOME-1\ntitle: Home plan\nstatus: in_progress\n");

  const plans = await buildMissionControlPlanIndex({ companiesRoot: root });
  expect(plans.plans.map((plan) => plan.code)).toEqual(["HOST-1"]);

  const worktrees = await buildWorktreeIndex({ companiesRoot: root });
  expect(worktrees.worktrees.some((worktree) => String(worktree.module).includes("HomeOrg"))).toBe(false);

  const context = await buildLazurioContext({ root, organization: "HostOrg" });
  const organization = context.organizations[0];
  expect(organization.entrypoints.knowledgebase.path).toBe(`${ORGANIZATION_PATH}/workspace/knowledgebase`);
  expect(organization.entrypoints.mission_control.path).toBe(`${ORGANIZATION_PATH}/mission-control`);
  expect(organization.modules.find((module) => module.path.endsWith("HomeOrg_GEN3/knowledgebase"))).toMatchObject({
    slug: "knowledgebase",
    home_organization: "HomeOrg",
    guest: true,
  });

  const resolution = readOrganizationRoot({ organizationRoot });
  const agentsTargets = collectAgentsInstanceTargets(resolution.resource).map((target) => target.relativePath);
  expect(agentsTargets).toContain("workspace/knowledgebase/AGENTS.md");
  expect(agentsTargets.some((path) => path.includes("HomeOrg_GEN3"))).toBe(false);
});
