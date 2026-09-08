import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOrganization, writeJson, runGit } from "./git-fixture-helpers.test.mjs";
import { createLazurioUpdateFixture, commitRemoteModule } from "../../tests/lazurio-update-fixture.mjs";
import { createHostedWorkspaceConfiguration } from "../../lazurio/runtime/hosted-app-url-lib.mjs";
import { runLazurioUpdate } from "../../lazurio/runtime/lazurio-update-lib.mjs";
import { runIsolatedLazurioUpdate } from "../../lazurio/runtime/lazurio-update-runner-lib.mjs";

const fixtures = [];
afterEach(async () => {
  for (const path of fixtures.splice(0)) await rm(path, { recursive: true, force: true });
});

test("Hosted Team Sync excludes absent and mounted sibling-Team modules using the real inventory", async () => {
  const root = await mkdtemp(join(tmpdir(), "hosted-team-update-"));
  fixtures.push(root);
  const orgPath = "organizations/WorkspaceTestOrg_GEN3";
  const orgRoot = join(root, orgPath);
  const slot = (slug, teams) => ({
    slug, path: `workspace/${slug}`, teams, default_access: "role_based",
    git: { url: `git@github.com:WorkspaceTestOrg/${slug}.git`, branch: "main" },
  });
  await createOrganization({ root, orgPath, slug: "WorkspaceTestOrg", moduleSlots: [
    slot("team-notes", ["sales"]),
    slot("shared-handbook", ["sales", "knowledge"]),
    { ...slot("legacy-sales", undefined), workspace: "sales" },
    slot("other-team-absent", ["knowledge"]),
    slot("other-team-mounted", ["knowledge"]),
  ] });
  const heldPath = join(orgRoot, "workspace/other-team-mounted");
  await mkdir(heldPath, { recursive: true });
  await writeFile(join(heldPath, "keep.txt"), "existing team data\n");
  await writeJson(join(heldPath, "lazurio.module.json"), {
    schema_version: "lazurio.module.v1", id: "other-team-mounted", company: "WorkspaceTestOrg",
    apps: [],
  });
  const hostedWorkspace = createHostedWorkspaceConfiguration({
    profile: "hosted", organizationSlug: "WorkspaceTestOrg", teamId: "sales",
    domain: "workspace-test-org.example.test",
  });
  const calls = [];
  const deps = {
    acquireLock: async () => ({ release: async () => {} }),
    discoverApps: async () => ({ apps: [], organizations: [], warnings: [] }),
    updateRepo: async (repo) => {
      calls.push(["update", repo.module]);
      return { repo_key: repo.key, repo_kind: repo.repo_kind, organization: repo.organization,
        module: repo.module, path: repo.repo_path, state: "current", reason: "already_current" };
    },
    materializeRepo: async ({ repo }) => {
      calls.push(["materialize", repo.module]);
      await mkdir(repo.absolute_path, { recursive: true });
      await writeJson(join(repo.absolute_path, "lazurio.module.json"), {
        schema_version: "lazurio.module.v1", id: repo.module, company: "WorkspaceTestOrg", apps: [],
      });
      return { ok: true, outcome: "materialized", head: "a".repeat(40) };
    },
  };
  const first = await runLazurioUpdate({ rootPath: root, hostedWorkspace, deps });
  expect(first.ok).toBe(true);
  expect(calls.filter(([operation]) => operation === "materialize")).toEqual([
    ["materialize", "legacy-sales"], ["materialize", "shared-handbook"], ["materialize", "team-notes"],
  ]);
  expect(calls.some(([, module]) => module.startsWith("other-team"))).toBe(false);
  expect(existsSync(join(orgRoot, "workspace/other-team-absent"))).toBe(false);
  expect(await readFile(join(heldPath, "keep.txt"), "utf8")).toBe("existing team data\n");
  calls.length = 0;
  const second = await runLazurioUpdate({ rootPath: root, hostedWorkspace, deps });
  expect(second.ok).toBe(true);
  expect(calls.some(([operation]) => operation === "materialize")).toBe(false);
  expect(calls.some(([, module]) => module.startsWith("other-team"))).toBe(false);
  calls.length = 0;
  const unknown = await runLazurioUpdate({ rootPath: root,
    hostedWorkspace: { ...hostedWorkspace, team_id: "undeclared-team" }, deps });
  expect(unknown.ok).toBe(false);
  expect(calls).toEqual([["update", "root"]]);
  calls.length = 0;
  const inaccessible = await runLazurioUpdate({ rootPath: root, hostedWorkspace, deps: {
    ...deps,
    updateRepo: async (repo) => repo.module === "team-notes"
      ? { repo_key: repo.key, repo_kind: repo.repo_kind, organization: repo.organization,
          module: repo.module, path: repo.repo_path, state: "blocked", reason: "github_unavailable" }
      : deps.updateRepo(repo),
  } });
  expect(inaccessible.ok).toBe(false);
  expect(inaccessible.results.find((item) => item.module === "team-notes")?.reason).toBe("github_unavailable");
  expect(calls.some(([, module]) => module.startsWith("other-team"))).toBe(false);
  calls.length = 0;
  const companyPath = join(orgRoot, "company.gen3.json");
  const company = JSON.parse(await readFile(companyPath, "utf8"));
  const revoked = await runLazurioUpdate({ rootPath: root, hostedWorkspace, deps: {
    ...deps,
    updateRepo: async (repo) => {
      const result = await deps.updateRepo(repo);
      if (repo.repo_kind === "organization_root") {
        await writeJson(companyPath, { ...company, teams: company.teams.filter((team) => team.slug !== "sales") });
      }
      return result;
    },
  } });
  expect(revoked.ok).toBe(false);
  expect(calls.every(([, module]) => module === "root")).toBe(true);
  await writeJson(companyPath, company);
  calls.length = 0;
  const local = await runLazurioUpdate({ rootPath: root, deps });
  expect(local.ok).toBe(true);
  expect(calls).toContainEqual(["materialize", "other-team-absent"]);
  expect(calls).toContainEqual(["update", "other-team-mounted"]);
});

test("isolated CLI update returns a blocked JSON report for incomplete hosted identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "hosted-update-invalid-"));
  fixtures.push(root);
  const report = await runIsolatedLazurioUpdate({ rootPath: root, environment: {
    ...process.env, LAZURIO_WORKSPACE_PROFILE: "hosted",
    LAZURIO_ORGANIZATION_SLUG: "WorkspaceTestOrg", LAZURIO_TEAM_ID: "",
    LAZURIO_HOSTED_DOMAIN: "workspace-test-org.example.test",
  } });
  expect(report.ok).toBe(false);
  expect(report.results).toHaveLength(1);
  expect(report.results[0].reason).toBe("workspace_configuration_invalid");
});

test("real isolated CLI honors a partial Team after a real Organization fetch and stays idempotent", async () => {
  const fixture = await createLazurioUpdateFixture({ withModule: true });
  fixtures.push(fixture.sandbox);
  const seed = join(fixture.sandbox, "organization-seed");
  const companyPath = join(seed, "company.gen3.json");
  const company = JSON.parse(await readFile(companyPath, "utf8"));
  company.teams.push({ slug: "other-team", display_name: "Other Team" });
  await writeJson(companyPath, company);
  const manifestPath = join(seed, "modules.manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  // The canonical default Team is workspace even without any Team field.
  for (const slot of manifest.module_slots) {
    delete slot.teams;
    delete slot.workspace;
    delete slot.workspaces;
  }
  manifest.module_slots.push({ slug: "other-notes", path: "workspace/other-notes",
    teams: ["other-team"], default_access: "role_based",
    git: { url: "git@github.com:FixtureOrg/other-notes.git", branch: "main" },
  });
  await writeJson(manifestPath, manifest);
  runGit(["add", "company.gen3.json", "modules.manifest.json"], seed);
  runGit(["commit", "-m", "declare a separate Team module"], seed);
  runGit(["push", "origin", "main"], seed);
  await commitRemoteModule(fixture);
  const environment = { ...process.env, LAZURIO_WORKSPACE_PROFILE: "hosted",
    LAZURIO_ORGANIZATION_SLUG: "FixtureOrg", LAZURIO_TEAM_ID: "workspace",
    LAZURIO_HOSTED_DOMAIN: "fixture-org.example.test" };
  const first = await runIsolatedLazurioUpdate({ rootPath: fixture.working, environment });
  expect(first.ok).toBe(true);
  expect(first.results.find((result) => result.module === "sample")?.state).toBe("updated");
  expect(first.results.some((result) => result.module === "other-notes")).toBe(false);
  expect(existsSync(join(fixture.organizationWorking, "workspace/other-notes"))).toBe(false);
  const second = await runIsolatedLazurioUpdate({ rootPath: fixture.working, environment });
  expect(second).toMatchObject({ ok: true, state: "current" });
  expect(second.results.some((result) => result.module === "other-notes")).toBe(false);
});

test("hosted reports omit proven out-of-Team slot errors but retain selected-Team errors", async () => {
  const root = await mkdtemp(join(tmpdir(), "hosted-update-report-scope-"));
  fixtures.push(root);
  const orgPath = "organizations/WorkspaceTestOrg_GEN3";
  const invalidSlot = { slug: "invalid-reference", path: "workspace/invalid-reference",
    teams: ["knowledge"], default_access: "role_based",
    git: { url: "git@github.com:WrongOrganization/invalid-reference.git", branch: "main" },
  };
  await createOrganization({ root, orgPath, slug: "WorkspaceTestOrg", moduleSlots: [invalidSlot] });
  const hostedWorkspace = createHostedWorkspaceConfiguration({ profile: "hosted",
    organizationSlug: "WorkspaceTestOrg", teamId: "sales", domain: "workspace.example.test" });
  const calls = [];
  const deps = {
    acquireLock: async () => ({ release: async () => {} }),
    updateRepo: async (repo) => {
      calls.push(repo.module);
      return { repo_key: repo.key, repo_kind: repo.repo_kind, organization: repo.organization,
        module: repo.module, state: "current", reason: "already_current" };
    },
    materializeRepo: async () => { throw new Error("Excluded module may not be materialized"); },
  };
  const outside = await runLazurioUpdate({ rootPath: root, hostedWorkspace, deps });
  expect(outside.ok).toBe(true);
  expect(outside.warnings).toEqual([]);
  expect(calls.every((module) => module === "root")).toBe(true);
  const manifestPath = join(root, orgPath, "modules.manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.module_slots[0].teams = ["sales"];
  await writeJson(manifestPath, manifest);
  const inside = await runLazurioUpdate({ rootPath: root, hostedWorkspace, deps });
  expect(inside.ok).toBe(false);
  expect(inside.results.some((result) => result.module === "invalid-reference" && result.state === "blocked")).toBe(true);
});
