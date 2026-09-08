import { afterAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile, lstat, readFile, readdir, symlink, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { initGitRepo } from "../launchpad/src/git-fixture-helpers.test.mjs";
import { runGit, runGitInPinnedTemporaryChild } from "./runtime/git-lib.mjs";
import { runLazurioUpdate } from "./runtime/lazurio-update-lib.mjs";
import { createOrganizationScaffold } from "./core/organization-scaffold-lib.mjs";
import { CANONICAL_GIT_FETCH_REFSPEC } from "./core/git-materialization-lib.mjs";
import {
  installOrganization,
  observeOrganizationInstallSource,
  organizationInstallExitCode,
} from "./organization-install-lib.mjs";

const roots = [];
const ids = Object.freeze({ organization: "314957563", repository: "42424242" });
const login = "ExampleOrganization";
const fullName = `${login}/${login}_GEN3`;
const fakeHttpsRemote = `https://github.com/${fullName}.git`;
const fakeSshRemote = `git@github.com:${fullName}.git`;
const fakeDataRemote = `git@github.com:${login}/mission-control-data.git`;

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

test("provider resolves a human login to immutable root identity using read-only GitHub calls", () => {
  const calls = [];
  const documents = scaffoldDocuments();
  const source = observeOrganizationInstallSource({
    githubLogin: login,
    platform: "win32",
    environment: { SystemRoot: "C:\\Windows", USERPROFILE: "C:\\Users\\Example" },
    resolveGitHubCli: () => "C:\\Program Files\\GitHub CLI\\gh.exe",
    runGitHubCli: providerFixture({ calls, documents }),
  });

  expect(source).toMatchObject({
    ok: true,
    organization: { id: ids.organization, login },
    repository: {
      id: ids.repository,
      full_name: fullName,
      private: false,
      clone_url: fakeHttpsRemote,
      ssh_url: fakeSshRemote,
      read_url: fakeHttpsRemote,
    },
  });
  expect(calls.length).toBe(6);
  for (const call of calls) {
    expect(["api", "auth"]).toContain(call.args[0]);
    expect(call.args).not.toContain("--method");
    expect(call.args).not.toContain("--input");
    expect(call.args).not.toContain("-X");
  }
});

test("private Organization install keeps SSH while public read-only install uses HTTPS", () => {
  const documents = scaffoldDocuments();
  const source = observeOrganizationInstallSource({
    githubLogin: login,
    resolveGitHubCli: () => "/usr/bin/gh",
    runGitHubCli: providerFixture({ calls: [], documents, privateRepository: true }),
  });

  expect(source).toMatchObject({
    ok: true,
    repository: {
      private: true,
      clone_url: fakeHttpsRemote,
      ssh_url: fakeSshRemote,
      read_url: fakeSshRemote,
    },
  });
});

test("provider observation verifies the expected immutable Organization before reading its root", () => {
  const calls = [];
  const source = observeOrganizationInstallSource({
    githubLogin: login,
    expectedOrganizationId: "99999999",
    resolveGitHubCli: () => "/usr/bin/gh",
    runGitHubCli: providerFixture({ calls, documents: scaffoldDocuments() }),
  });

  expect(source).toMatchObject({ ok: false, code: "organization_identity_mismatch" });
  expect(calls.filter((call) => call.args[0] === "api").map((call) => call.args[1])).toEqual([
    `orgs/${login}`,
  ]);
});

test("immutable Organization expectation blocks a renamed or reused login before materialization", async () => {
  const fixture = await organizationRemoteFixture();
  let materialized = false;
  let updated = false;
  const source = sourceObservation();
  const report = await installOrganization({
    rootPath: fixture.root,
    githubLogin: login,
    expectedOrganizationId: ids.organization,
    deps: {
      observe: async () => ({
        ...source,
        organization: { ...source.organization, id: "99999999" },
      }),
      runPinnedChild: async () => {
        materialized = true;
        throw new Error("must not materialize");
      },
      runUpdate: async () => {
        updated = true;
        return updateReport("current");
      },
    },
  });

  expect(report).toMatchObject({
    state: "blocked",
    target: { reason: "organization_identity_mismatch" },
  });
  expect(materialized).toBe(false);
  expect(updated).toBe(false);
  expect(existsSync(join(fixture.root, "organizations", `${login}_GEN3`))).toBe(false);
});

test("Organization install requires an already prepared real Lazurio Root before provider access", async () => {
  const root = await mkdtemp(join(tmpdir(), "lazurio-organization-root-not-ready-"));
  roots.push(root);
  let observed = false;
  const report = await installOrganization({
    rootPath: root,
    githubLogin: login,
    deps: {
      observe: async () => {
        observed = true;
        return sourceObservation();
      },
    },
  });

  expect(report).toMatchObject({
    state: "blocked",
    target: { reason: "lazurio_root_not_ready" },
  });
  expect(observed).toBe(false);
});

test("case-folded Organization mount blocks before clone on every host", async () => {
  const fixture = await organizationRemoteFixture();
  let updateCalled = false;
  const report = await installOrganization({
    rootPath: fixture.root,
    githubLogin: login,
    deps: {
      observe: async () => sourceObservation(),
      readDirectory: async () => ["exampleorganization_gen3"],
      runUpdate: async () => {
        updateCalled = true;
        return updateReport("current");
      },
    },
  });

  expect(report).toMatchObject({
    state: "blocked",
    target: { reason: "materialization_target_case_collision" },
  });
  expect(updateCalled).toBe(false);
});

test("missing Organization root converges once and a second install is a no-op", async () => {
  const fixture = await organizationRemoteFixture();
  const updates = [];
  const source = sourceObservation();
  const deps = {
    observe: async () => source,
    reobserve: async () => ({ ok: true }),
    runGit: translatedGitRunner(fixture.remote),
    runPinnedChild: translatedPinnedGitRunner(fixture.remote),
    runUpdate: async ({ organizations }) => {
      updates.push(organizations);
      return updateReport("current");
    },
  };

  const first = await installOrganization({
    rootPath: fixture.root,
    githubLogin: login,
    deps,
  });
  const second = await installOrganization({
    rootPath: fixture.root,
    githubLogin: login,
    deps,
  });

  expect(first).toMatchObject({
    state: "updated",
    ok: true,
    access: { authority: "github", role: null, status: "not_requested" },
    target: { state: "updated", reason: "root_materialized" },
  });
  expect(second).toMatchObject({
    state: "current",
    ok: true,
    target: { state: "current", reason: "root_current" },
  });
  expect(organizationInstallExitCode(first)).toBe(0);
  expect(organizationInstallExitCode(second)).toBe(0);
  expect(updates).toHaveLength(2);
  expect(updates[0]).toEqual([{
    slug: "lazurio-example-organization",
    display_name: "Lazurio Example Organization",
    path: `organizations/${login}_GEN3`,
    status: "active",
    default_branch: "main",
    repository: fakeHttpsRemote,
  }]);
  expect(existsSync(join(fixture.root, "organizations", `${login}_GEN3`, "company.gen3.json"))).toBe(true);
});

test("explicit Organization install materializes an active repository-db mount once", async () => {
  const fixture = await organizationRepositoryDbFixture();
  const source = sourceObservation({ documents: fixture.documents });
  const remoteMap = new Map([
    [fakeHttpsRemote, fixture.remote],
    [fakeDataRemote, fixture.dataRemote],
  ]);
  const deps = {
    observe: async () => source,
    reobserve: async () => ({ ok: true }),
    runGit: translatedGitRunner(fixture.remote, remoteMap),
    runPinnedChild: translatedPinnedGitRunner(fixture.remote, remoteMap),
    runUpdate: async () => {
      await ensureRepositoryDbParentCheckout(fixture);
      return updateReport("current");
    },
  };

  const first = await installOrganization({ rootPath: fixture.root, githubLogin: login, deps });
  const second = await installOrganization({ rootPath: fixture.root, githubLogin: login, deps });
  const dataPath = join(fixture.root, "organizations", `${login}_GEN3`, "mission-control", "db");

  expect(first).toMatchObject({ state: "updated", ok: true });
  expect(first.convergence.results).toContainEqual(expect.objectContaining({
    state: "updated",
    reason: "repository_db_materialized",
    path: `organizations/${login}_GEN3/mission-control/db`,
  }));
  expect(second).toMatchObject({ state: "current", ok: true });
  expect(second.convergence.results).toContainEqual(expect.objectContaining({
    state: "current",
    reason: "repository_db_current",
  }));
  expect(existsSync(join(dataPath, "repository-db.yaml"))).toBe(true);
  expect((await runGit(["branch", "--show-current"], { cwd: dataPath })).stdout).toBe("v3");
  expect((await runGit(["remote", "get-url", "origin"], { cwd: dataPath })).stdout).toBe(fakeDataRemote);
  expect((await runGit(
    ["config", "--local", "--get-all", "remote.origin.fetch"],
    { cwd: dataPath },
  )).stdout).toBe(CANONICAL_GIT_FETCH_REFSPEC);
});

test("declared Mission Control never reports successful install without its active repository-db mount", async () => {
  const scenarios = [
    {
      options: { includeRepositoryDb: false },
      reason: "repository_db_required_missing",
    },
    {
      options: { repositoryDbStatus: "inactive" },
      reason: "repository_db_not_active",
    },
    {
      options: { repositoryDbMaterialization: "doctor_managed_nested_repo" },
      reason: "repository_db_materialization_invalid",
    },
  ];

  for (const scenario of scenarios) {
    const fixture = await organizationRepositoryDbFixture(scenario.options);
    const source = sourceObservation({ documents: fixture.documents });
    const report = await installOrganization({
      rootPath: fixture.root,
      githubLogin: login,
      deps: {
        observe: async () => source,
        reobserve: async () => ({ ok: true }),
        runGit: translatedGitRunner(fixture.remote),
        runPinnedChild: translatedPinnedGitRunner(fixture.remote),
        runUpdate: async () => updateReport("current"),
      },
    });

    expect(report).toMatchObject({ state: "blocked", ok: false });
    expect(report.convergence.results).toContainEqual(expect.objectContaining({
      state: "blocked",
      reason: scenario.reason,
    }));
    expect(existsSync(join(fixture.root, "organizations", `${login}_GEN3`, "mission-control", "db"))).toBe(false);
  }
});

test("Organization-level ignore cannot authorize a repository-db clone into a non-repository parent", async () => {
  const fixture = await organizationRepositoryDbFixture();
  const source = sourceObservation({ documents: fixture.documents });
  const remoteMap = new Map([
    [fakeHttpsRemote, fixture.remote],
    [fakeDataRemote, fixture.dataRemote],
  ]);
  const dataPath = join(fixture.root, "organizations", `${login}_GEN3`, "mission-control", "db");
  const report = await installOrganization({
    rootPath: fixture.root,
    githubLogin: login,
    deps: {
      observe: async () => source,
      reobserve: async () => ({ ok: true }),
      runGit: translatedGitRunner(fixture.remote, remoteMap),
      runPinnedChild: translatedPinnedGitRunner(fixture.remote, remoteMap),
      runUpdate: async () => {
        await mkdir(dirname(dataPath), { recursive: true });
        return updateReport("current");
      },
    },
  });

  expect(report).toMatchObject({ state: "blocked", ok: false });
  expect(report.convergence.results).toContainEqual(expect.objectContaining({
    state: "blocked",
    reason: "repository_db_parent_not_repository",
  }));
  expect(existsSync(dataPath)).toBe(false);
});

test("existing dirty repository-db checkout stays untouched and blocks reinstall", async () => {
  const fixture = await organizationRepositoryDbFixture();
  const source = sourceObservation({ documents: fixture.documents });
  const remoteMap = new Map([
    [fakeHttpsRemote, fixture.remote],
    [fakeDataRemote, fixture.dataRemote],
  ]);
  const deps = {
    observe: async () => source,
    reobserve: async () => ({ ok: true }),
    runGit: translatedGitRunner(fixture.remote, remoteMap),
    runPinnedChild: translatedPinnedGitRunner(fixture.remote, remoteMap),
    runUpdate: async () => {
      await ensureRepositoryDbParentCheckout(fixture);
      return updateReport("current");
    },
  };
  const first = await installOrganization({ rootPath: fixture.root, githubLogin: login, deps });
  expect(first.ok).toBe(true);
  const dataPath = join(fixture.root, "organizations", `${login}_GEN3`, "mission-control", "db");
  const draftPath = join(dataPath, "local-draft.txt");
  await writeFile(draftPath, "keep\n");

  const second = await installOrganization({ rootPath: fixture.root, githubLogin: login, deps });

  expect(second).toMatchObject({ state: "blocked", ok: false });
  expect(second.convergence.results).toContainEqual(expect.objectContaining({
    state: "blocked",
    reason: "repository_db_identity_mismatch",
  }));
  expect(await Bun.file(draftPath).text()).toBe("keep\n");
});

test("provider identity change after clone leaves no final Organization target", async () => {
  const fixture = await organizationRemoteFixture();
  let updateCalled = false;
  const report = await installOrganization({
    rootPath: fixture.root,
    githubLogin: login,
    deps: {
      observe: async () => sourceObservation(),
      reobserve: async () => ({
        ok: false,
        code: "provider_identity_changed",
        message: "renamed",
      }),
      runGit: translatedGitRunner(fixture.remote),
      runPinnedChild: translatedPinnedGitRunner(fixture.remote),
      runUpdate: async () => {
        updateCalled = true;
        return updateReport("current");
      },
    },
  });

  expect(report).toMatchObject({
    state: "blocked",
    target: { state: "blocked", reason: "provider_identity_changed" },
  });
  expect(updateCalled).toBe(false);
  expect(existsSync(join(fixture.root, "organizations", `${login}_GEN3`))).toBe(false);
});

test("foreign staged Forge binding never reaches the Organization target", async () => {
  const fixture = await organizationRemoteFixture({ repositoryId: "52525252" });
  let reobserved = false;
  const report = await installOrganization({
    rootPath: fixture.root,
    githubLogin: login,
    deps: {
      observe: async () => sourceObservation(),
      reobserve: async () => {
        reobserved = true;
        return { ok: true };
      },
      runGit: translatedGitRunner(fixture.remote),
      runPinnedChild: translatedPinnedGitRunner(fixture.remote),
      runUpdate: async () => updateReport("current"),
    },
  });

  expect(report).toMatchObject({
    state: "blocked",
    target: { reason: "root_manifest_identity_mismatch" },
  });
  expect(reobserved).toBe(false);
  expect(existsSync(join(fixture.root, "organizations", `${login}_GEN3`))).toBe(false);
});

test("dirty existing root fails closed before scoped update", async () => {
  const fixture = await organizationRemoteFixture();
  const deps = {
    observe: async () => sourceObservation(),
    reobserve: async () => ({ ok: true }),
    runGit: translatedGitRunner(fixture.remote),
    runPinnedChild: translatedPinnedGitRunner(fixture.remote),
    runUpdate: async () => updateReport("current"),
  };
  const first = await installOrganization({ rootPath: fixture.root, githubLogin: login, deps });
  expect(first.ok).toBe(true);
  const target = join(fixture.root, "organizations", `${login}_GEN3`);
  await writeFile(join(target, "local-draft.txt"), "keep\n");
  let updateCalled = false;

  const second = await installOrganization({
    rootPath: fixture.root,
    githubLogin: login,
    deps: {
      ...deps,
      runUpdate: async () => {
        updateCalled = true;
        return updateReport("current");
      },
    },
  });

  expect(second).toMatchObject({
    state: "blocked",
    target: { state: "blocked", reason: "root_local_changes" },
  });
  expect(updateCalled).toBe(false);
  expect(await Bun.file(join(target, "local-draft.txt")).text()).toBe("keep\n");
});

test("CLI exposes install without weakening activation flags", () => {
  const help = Bun.spawnSync([process.execPath, "lazurio/cli.mjs", "--help"], {
    cwd: join(import.meta.dirname, ".."),
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(help.exitCode).toBe(0);
  expect(help.stdout.toString()).toContain("lazurio organization install <github-login> [--role builder|steward] [--json]");
  expect(help.stdout.toString()).not.toContain("lazurio organization install <github-login> [--role builder|steward] [--json] [--root");

  const invalid = Bun.spawnSync([
    process.execPath,
    "lazurio/cli.mjs",
    "organization",
    "install",
    login,
    "--check",
  ], {
    cwd: join(import.meta.dirname, ".."),
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(invalid.exitCode).toBe(2);
  expect(invalid.stderr.toString()).toContain("přijímá GitHub login, ne --check");

  const alternateRoot = Bun.spawnSync([
    process.execPath,
    "lazurio/cli.mjs",
    "organization",
    "install",
    login,
    "--root",
    join(tmpdir(), "alternate-root"),
  ], {
    cwd: join(import.meta.dirname, ".."),
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(alternateRoot.exitCode).toBe(2);
  expect(alternateRoot.stderr.toString()).toContain("vždy používá kanonický Lazurio Root v home");

  const invalidRole = Bun.spawnSync([
    process.execPath,
    "lazurio/cli.mjs",
    "organization",
    "install",
    login,
    "--role",
    "admin",
  ], {
    cwd: join(import.meta.dirname, ".."),
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(invalidRole.exitCode).toBe(2);
  expect(invalidRole.stderr.toString()).toContain("--role podporuje pouze hodnoty builder a steward");
});

test("Builder role blocks before materialization when provider observation did not prove readiness", async () => {
  const fixture = await organizationRemoteFixture();
  let materialized = false;
  const report = await installOrganization({
    rootPath: fixture.root,
    githubLogin: login,
    role: "builder",
    deps: {
      observe: async () => sourceObservation(),
      runPinnedChild: async () => {
        materialized = true;
        throw new Error("must not materialize");
      },
    },
  });

  expect(report).toMatchObject({
    state: "blocked",
    access: { authority: "github", role: "builder", status: "blocked" },
    scope: { role: "builder", restricted_slots: "exclude" },
    target: { reason: "builder_access_not_ready" },
  });
  expect(materialized).toBe(false);
  expect(existsSync(join(fixture.root, "organizations", `${login}_GEN3`))).toBe(false);
});

test("Steward role blocks before materialization when provider observation did not prove readiness", async () => {
  const fixture = await organizationRemoteFixture();
  let materialized = false;
  const report = await installOrganization({
    rootPath: fixture.root,
    githubLogin: login,
    role: "steward",
    deps: {
      observe: async () => sourceObservation(),
      runPinnedChild: async () => {
        materialized = true;
        throw new Error("must not materialize");
      },
    },
  });

  expect(report).toMatchObject({
    state: "blocked",
    access: { authority: "github", role: "steward", status: "blocked" },
    scope: { role: "steward", restricted_slots: "exclude" },
    target: { reason: "steward_access_not_ready" },
  });
  expect(materialized).toBe(false);
  expect(existsSync(join(fixture.root, "organizations", `${login}_GEN3`))).toBe(false);
});

test("Steward install converges ordinary apps and the Mission Control data mount without touching the restricted root slot", async () => {
  const fixture = await restrictedScopeFixture();
  const infraKey = "lazurio-example-organization::infra";
  const first = await installOrganization({
    rootPath: fixture.root,
    githubLogin: login,
    role: "steward",
    deps: fixture.deps,
  });

  expect(first, JSON.stringify(first)).toMatchObject({
    state: "updated",
    ok: true,
    access: { role: "steward", status: "ready" },
    scope: { role: "steward", restricted_slots: "exclude" },
    target: { state: "updated", reason: "root_materialized" },
  });
  expect(first.convergence.restricted_slot_policy).toBe("exclude");
  expect(first.convergence.results).toContainEqual(expect.objectContaining({
    repo_key: infraKey,
    state: "current",
    reason: "excluded_by_role_scope",
    materialization_scope: "excluded_by_role_scope",
  }));
  expect(first.convergence.results).toContainEqual(expect.objectContaining({
    repo_key: "lazurio-example-organization::mission-control",
    state: "updated",
    reason: "organization_repository_materialized",
  }));
  expect(first.convergence.results).toContainEqual(expect.objectContaining({
    repo_key: "lazurio-example-organization::knowledgebase",
    state: "updated",
    reason: "module_materialized",
  }));
  expect(first.convergence.results).toContainEqual(expect.objectContaining({
    state: "updated",
    reason: "repository_db_materialized",
    path: `organizations/${login}_GEN3/mission-control/db`,
  }));
  expect(fixture.materialized).not.toContain(infraKey);
  expect(fixture.materialized).toEqual(expect.arrayContaining([
    "lazurio-example-organization::mission-control",
    "lazurio-example-organization::knowledgebase",
  ]));
  expect(existsSync(join(fixture.organizationRoot, "infra"))).toBe(false);
  expect(existsSync(join(fixture.organizationRoot, "mission-control", "db", "repository-db.yaml"))).toBe(true);
  expectNoProviderOperation(fixture, "infra");

  const materializedBeforeRerun = fixture.materialized.length;
  const second = await installOrganization({
    rootPath: fixture.root,
    githubLogin: login,
    role: "steward",
    deps: fixture.deps,
  });
  expect(second, JSON.stringify(second)).toMatchObject({ state: "current", ok: true });
  expect(second.convergence.results).toContainEqual(expect.objectContaining({
    repo_key: infraKey,
    reason: "excluded_by_role_scope",
  }));
  expect(second.convergence.results).toContainEqual(expect.objectContaining({ reason: "repository_db_current" }));
  expect(fixture.materialized).toHaveLength(materializedBeforeRerun);
  expectNoProviderOperation(fixture, "infra");
  expect(organizationInstallExitCode(first)).toBe(0);
  expect(organizationInstallExitCode(second)).toBe(0);
});

test("generic update after a Steward install defers the absent restricted slot but keeps updating a mounted one", async () => {
  const fixture = await restrictedScopeFixture();
  const infraKey = "lazurio-example-organization::infra";
  await installOrganization({ rootPath: fixture.root, githubLogin: login, role: "steward", deps: fixture.deps });

  const deferred = await fixture.runUpdate({ rootPath: fixture.root });
  expect(deferred, JSON.stringify(deferred)).toMatchObject({ state: "current", ok: true, restricted_slot_policy: "defer" });
  expect(deferred.results).toContainEqual(expect.objectContaining({
    repo_key: infraKey,
    state: "current",
    reason: "restricted_not_materialized",
    materialization_scope: "restricted_deferred",
  }));
  expect(fixture.materialized).not.toContain(infraKey);
  expect(fixture.updated).not.toContain(infraKey);
  expectNoProviderOperation(fixture, "infra");

  await initGitRepo(join(fixture.organizationRoot, "infra"));
  const mounted = await fixture.runUpdate({ rootPath: fixture.root });
  expect(mounted, JSON.stringify(mounted)).toMatchObject({ state: "current", ok: true });
  expect(fixture.updated).toContain(infraKey);
  expect(mounted.results.some((result) => result.repo_key === infraKey && result.reason === "restricted_not_materialized")).toBe(false);
  expect(fixture.materialized).not.toContain(infraKey);
});

test("Admin install without a role still materializes the restricted root slot", async () => {
  const fixture = await restrictedScopeFixture();
  const infraKey = "lazurio-example-organization::infra";
  const report = await installOrganization({ rootPath: fixture.root, githubLogin: login, deps: fixture.deps });

  expect(report, JSON.stringify(report)).toMatchObject({
    state: "updated",
    ok: true,
    access: { role: null, status: "not_requested" },
    scope: { role: null, restricted_slots: "include" },
  });
  expect(report.convergence.restricted_slot_policy).toBe("include");
  expect(report.convergence.results).toContainEqual(expect.objectContaining({
    repo_key: infraKey,
    state: "updated",
    reason: "organization_repository_materialized",
  }));
  expect(fixture.materialized).toContain(infraKey);
  expect(existsSync(join(fixture.organizationRoot, "infra"))).toBe(true);
  expect(JSON.stringify(report)).not.toContain("excluded_by_role_scope");
});

test("Builder install shares the restricted exclusion semantics of the Steward scope", async () => {
  const fixture = await restrictedScopeFixture({ role: "builder" });
  const report = await installOrganization({ rootPath: fixture.root, githubLogin: login, role: "builder", deps: fixture.deps });

  expect(report, JSON.stringify(report)).toMatchObject({
    state: "updated",
    ok: true,
    scope: { role: "builder", restricted_slots: "exclude" },
  });
  expect(report.convergence.results).toContainEqual(expect.objectContaining({
    repo_key: "lazurio-example-organization::infra",
    reason: "excluded_by_role_scope",
  }));
  expect(fixture.materialized).not.toContain("lazurio-example-organization::infra");
  expectNoProviderOperation(fixture, "infra");
});

test("restricted Mission Control excludes its repository-db descendant from a Steward install without any provider operation", async () => {
  const fixture = await restrictedScopeFixture({ missionControlAccess: "restricted" });
  const report = await installOrganization({ rootPath: fixture.root, githubLogin: login, role: "steward", deps: fixture.deps });

  expect(report, JSON.stringify(report)).toMatchObject({ state: "updated", ok: true });
  expect(report.convergence.results).toContainEqual(expect.objectContaining({
    repo_key: "lazurio-example-organization::mission-control",
    reason: "excluded_by_role_scope",
  }));
  expect(report.convergence.results).toContainEqual(expect.objectContaining({
    path: `organizations/${login}_GEN3/mission-control/db`,
    state: "current",
    reason: "excluded_by_role_scope",
  }));
  expect(report.convergence.results.some((result) => result.reason === "repository_db_materialized")).toBe(false);
  expect(fixture.materialized).toEqual(["lazurio-example-organization::knowledgebase"]);
  expect(existsSync(join(fixture.organizationRoot, "mission-control"))).toBe(false);
  expectNoProviderOperation(fixture, "mission-control");
  expect(fixture.gitCalls.some((call) => call.args.includes(fakeDataRemote))).toBe(false);

  const admin = await installOrganization({ rootPath: fixture.root, githubLogin: login, deps: fixture.deps });
  expect(admin, JSON.stringify(admin)).toMatchObject({ state: "updated", ok: true, scope: { role: null, restricted_slots: "include" } });
  expect(admin.convergence.results).toContainEqual(expect.objectContaining({ reason: "repository_db_materialized" }));
});

test("unknown slot access classification fails safe for every install scope", async () => {
  for (const role of ["steward", null]) {
    const fixture = await restrictedScopeFixture({ infraAccess: "secret" });
    const report = await installOrganization({ rootPath: fixture.root, githubLogin: login, role, deps: fixture.deps });
    expect(report, JSON.stringify(report)).toMatchObject({ state: "blocked", ok: false });
    expect(report.convergence.results).toContainEqual(expect.objectContaining({
      repo_key: "lazurio-example-organization::infra",
      state: "blocked",
      reason: "access_classification_unknown",
    }));
    expect(fixture.materialized).not.toContain("lazurio-example-organization::infra");
    expectNoProviderOperation(fixture, "infra");
  }
});

function roleReadiness(role) {
  return {
    authority: "github",
    role,
    status: "ready",
    account: { id: "51515151", login: `${role}-account` },
    organization_membership: { state: "active", role: "member" },
    teams: [],
    repositories: [],
    blockers: [],
  };
}

// Organization s běžnými sloty, Mission Control app/data hranicí a restricted
// root slotem `infra`. Install používá skutečný update reconciler nad reálným
// inventářem; Git i materializace jsou špehované, takže test dokáže, že se nad
// vyloučeným slotem nespustila žádná provider operace.
async function restrictedScopeFixture({
  role = "steward",
  infraAccess = "restricted",
  missionControlAccess = "expected",
} = {}) {
  const fixture = await organizationRepositoryDbFixture();
  const documents = fixture.documents;
  const missionControl = documents.modules.module_slots.find((slot) => slot.path === "mission-control");
  missionControl.default_access = missionControlAccess;
  missionControl.required_roles = ["organization-admin"];
  documents.company.layers.push({ path: "infra", kind: "root-docs", ownership: "manual" });
  documents.modules.module_slots.push(
    {
      path: "infra",
      slug: "infra",
      space: "root",
      status: "active",
      default_access: infraAccess,
      required_roles: ["organization-admin"],
      materialization: "doctor_managed_nested_repo",
      git: { url: `git@github.com:${login}/infra.git`, branch: "main" },
    },
    {
      path: "workspace/knowledgebase",
      slug: "knowledgebase",
      status: "active",
      default_access: "expected",
      required_roles: ["*"],
      teams: ["workspace"],
      git: { url: `git@github.com:${login}/knowledgebase.git`, branch: "main" },
    },
  );
  await writeFile(join(fixture.source, "company.gen3.json"), `${JSON.stringify(documents.company, null, 2)}\n`);
  await writeFile(join(fixture.source, "modules.manifest.json"), `${JSON.stringify(documents.modules, null, 2)}\n`);
  await runGit(["add", "company.gen3.json", "modules.manifest.json"], { cwd: fixture.source });
  await runGit(["commit", "-m", "Declare restricted scope fixture"], { cwd: fixture.source });
  await runGit(["push", "origin", "main"], { cwd: fixture.source });

  const organizationRoot = join(fixture.root, "organizations", `${login}_GEN3`);
  const remoteMap = new Map([
    [fakeHttpsRemote, fixture.remote],
    [fakeDataRemote, fixture.dataRemote],
  ]);
  const gitCalls = [];
  const materialized = [];
  const updated = [];
  const spy = (runner) => async (args, options) => {
    gitCalls.push({ args, cwd: options?.cwd ?? null });
    return runner(args, options);
  };
  const identity = (item) => ({
    repo_key: item.key,
    repo_kind: item.repo_kind,
    organization: item.organization ?? null,
    module: item.module ?? null,
    path: item.repo_path ?? item.absolute_path,
  });
  const runUpdate = async ({ rootPath, organizations = null, restrictedSlotPolicy = "defer" }) => runLazurioUpdate({
    rootPath,
    organizations,
    restrictedSlotPolicy,
    runtimeRoot: join(fixture.root, "..", "runtime"),
    deps: {
      acquireLock: async () => ({ release: async () => {} }),
      updateRepo: async (item) => {
        updated.push(item.key);
        return { ...identity(item), state: "current", reason: "already_current", message: "current" };
      },
      materializeRepo: async ({ repo }) => {
        materialized.push(repo.key);
        gitCalls.push({ args: ["clone", repo.repo], cwd: repo.absolute_path });
        if (repo.module === "mission-control") await ensureRepositoryDbParentCheckout(fixture);
        else await initGitRepo(repo.absolute_path);
        return { ok: true, outcome: "materialized", head: "a".repeat(40) };
      },
      discoverApps: async () => ({ apps: [], failures: [] }),
    },
  });
  const deps = {
    observe: async ({ role: requestedRole }) => ({
      ...sourceObservation({ documents }),
      ...(requestedRole ? { access: roleReadiness(requestedRole) } : {}),
    }),
    reobserve: async () => ({ ok: true }),
    runGit: spy(translatedGitRunner(fixture.remote, remoteMap)),
    runPinnedChild: spy(translatedPinnedGitRunner(fixture.remote, remoteMap)),
    runUpdate,
  };
  return { ...fixture, organizationRoot, deps, runUpdate, gitCalls, materialized, updated, role };
}

function expectNoProviderOperation(fixture, slotPath) {
  const slotRoot = join(fixture.organizationRoot, slotPath);
  const offending = fixture.gitCalls.filter((call) => (
    (typeof call.cwd === "string" && (call.cwd === slotRoot || call.cwd.startsWith(`${slotRoot}/`)))
    || call.args.some((arg) => typeof arg === "string" && arg.includes(`/${slotPath}.git`))
  ));
  expect(offending).toEqual([]);
}

function sourceObservation({ documents = scaffoldDocuments() } = {}) {
  return {
    ok: true,
    organization: { id: ids.organization, login, label: "GitHub Organization" },
    repository: {
      id: ids.repository,
      name: `${login}_GEN3`,
      full_name: fullName,
      default_branch: "main",
      private: false,
      clone_url: fakeHttpsRemote,
      ssh_url: fakeSshRemote,
      read_url: fakeHttpsRemote,
    },
    documents,
  };
}

function scaffoldDocuments() {
  const scaffold = createOrganizationScaffold({
    organization: {
      id: ids.organization,
      login,
      slug: "lazurio-example-organization",
      displayName: "Lazurio Example Organization",
    },
    repository: {
      id: ids.repository,
      name: `${login}_GEN3`,
      fullName,
      defaultBranch: "main",
    },
  });
  const files = new Map(scaffold.files.map((file) => [file.path, file.content]));
  return {
    company: JSON.parse(files.get("company.gen3.json")),
    modules: JSON.parse(files.get("modules.manifest.json")),
    canonical: null,
  };
}

async function organizationRemoteFixture({ repositoryId = ids.repository } = {}) {
  const root = await mkdtemp(join(tmpdir(), "lazurio-organization-install-"));
  roots.push(root);
  await mkdir(join(root, "organizations"), { recursive: true });
  const source = join(root, "source");
  const remote = join(root, "remote.git");
  await initGitRepo(source, { remotePath: remote });
  const scaffold = createOrganizationScaffold({
    organization: {
      id: ids.organization,
      login,
      slug: "lazurio-example-organization",
      displayName: "Lazurio Example Organization",
    },
    repository: {
      id: repositoryId,
      name: `${login}_GEN3`,
      fullName,
      defaultBranch: "main",
    },
  });
  for (const file of scaffold.files) {
    const path = join(source, file.path);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, file.content);
  }
  await runGit(["add", "--all"], { cwd: source });
  await runGit(["commit", "-m", "Add Organization scaffold"], { cwd: source });
  await runGit(["push", "origin", "main"], { cwd: source });
  return { root, remote, source };
}

async function organizationRepositoryDbFixture({
  includeRepositoryDb = true,
  repositoryDbStatus = "active",
  repositoryDbMaterialization = "repository_db_mount",
} = {}) {
  const fixture = await organizationRemoteFixture();
  const documents = scaffoldDocuments();
  documents.company.layers ??= [];
  documents.company.layers.push({ path: "mission-control", kind: "root-docs", ownership: "manual" });
  documents.modules.module_slots.push({
    path: "mission-control",
    slug: "mission-control",
    source_of_truth: "git-native",
    space: "root",
    status: "active",
    materialization: "doctor_managed_nested_repo",
    git: { url: `git@github.com:${login}/mission-control.git`, branch: "main" },
  });
  if (includeRepositoryDb) {
    documents.modules.module_slots.push({
      path: "mission-control/db",
      slug: "mission-control-data",
      source_of_truth: "repository-db:v3",
      space: "root",
      status: repositoryDbStatus,
      materialization: repositoryDbMaterialization,
      git: { url: fakeDataRemote, branch: "v3" },
    });
  }
  await writeFile(join(fixture.source, "company.gen3.json"), `${JSON.stringify(documents.company, null, 2)}\n`);
  await writeFile(join(fixture.source, "modules.manifest.json"), `${JSON.stringify(documents.modules, null, 2)}\n`);
  await runGit(["add", "company.gen3.json", "modules.manifest.json"], { cwd: fixture.source });
  await runGit(["commit", "-m", "Declare repository-db fixture"], { cwd: fixture.source });
  await runGit(["push", "origin", "main"], { cwd: fixture.source });

  const dataSource = join(fixture.root, "data-source");
  const dataRemote = join(fixture.root, "data-remote.git");
  await initGitRepo(dataSource, { remotePath: dataRemote });
  await runGit(["switch", "-c", "v3"], { cwd: dataSource });
  await writeFile(join(dataSource, "repository-db.yaml"), "schema_version: repository-db.config.v1\n");
  await runGit(["add", "repository-db.yaml"], { cwd: dataSource });
  await runGit(["commit", "-m", "Add repository-db fixture"], { cwd: dataSource });
  await runGit(["push", "origin", "v3"], { cwd: dataSource });
  return { ...fixture, documents, dataRemote };
}

async function ensureRepositoryDbParentCheckout(fixture) {
  const parentPath = join(fixture.root, "organizations", `${login}_GEN3`, "mission-control");
  if (existsSync(join(parentPath, ".git"))) return parentPath;
  const parentRemote = join(fixture.root, "mission-control-remote.git");
  await initGitRepo(parentPath, { remotePath: parentRemote });
  await writeFile(join(parentPath, ".gitignore"), "db/\n");
  await runGit(["add", ".gitignore"], { cwd: parentPath });
  await runGit(["commit", "-m", "Ignore repository-db checkout"], { cwd: parentPath });
  await runGit(["push", "origin", "main"], { cwd: parentPath });
  return parentPath;
}

function translatedGitRunner(localRemote, remoteMap = new Map([[fakeHttpsRemote, localRemote]])) {
  return async (args, options) => {
    const declaredRemote = args.find((arg) => remoteMap.has(arg)) ?? null;
    const translated = args.map((arg) => remoteMap.get(arg) ?? arg);
    const result = await runGit(translated, options);
    if (args.includes("clone") && result.ok && declaredRemote) {
      const staging = args.at(-1);
      const setRemote = await runGit(["remote", "set-url", "origin", declaredRemote], { cwd: staging });
      if (!setRemote.ok) return setRemote;
    }
    return result;
  };
}

function translatedPinnedGitRunner(localRemote, remoteMap = new Map([[fakeHttpsRemote, localRemote]])) {
  return async (args, options) => {
    const declaredRemote = args.find((arg) => remoteMap.has(arg)) ?? null;
    const translated = args.map((arg) => remoteMap.get(arg) ?? arg);
    const result = await runGitInPinnedTemporaryChild(translated, options);
    if (args.includes("clone") && result.ok && declaredRemote) {
      const staging = join(options.cwd, result.child_name);
      const setRemote = await runGit(["remote", "set-url", "origin", declaredRemote], { cwd: staging });
      if (!setRemote.ok) return setRemote;
    }
    return result;
  };
}

function updateReport(state) {
  return {
    schema_version: "lazurio.update.v1",
    state,
    ok: state !== "blocked",
    run_id: "fixture",
    generated_at: "2026-08-26T00:00:00.000Z",
    root: "/fixture",
    results: [],
    warnings: [],
    next_action: null,
  };
}

function providerFixture({ calls, documents, privateRepository = false }) {
  const encoded = (value) => Buffer.from(`${JSON.stringify(value)}\n`).toString("base64");
  return (call) => {
    calls.push(call);
    if (call.args[0] === "auth") return { status: 0, stdout: "", stderr: "" };
    const endpoint = call.args[1];
    if (endpoint === `orgs/${login}`) return ok({ id: Number(ids.organization), login });
    if (endpoint === `repos/${fullName}`) {
      return ok({
        id: Number(ids.repository),
        name: `${login}_GEN3`,
        full_name: fullName,
        default_branch: "main",
        private: privateRepository,
        clone_url: fakeHttpsRemote,
        ssh_url: fakeSshRemote,
        owner: { id: Number(ids.organization), login },
      });
    }
    if (endpoint === `repos/${fullName}/contents/company.gen3.json?ref=main`) {
      return ok({ encoding: "base64", content: encoded(documents.company) });
    }
    if (endpoint === `repos/${fullName}/contents/modules.manifest.json?ref=main`) {
      return ok({ encoding: "base64", content: encoded(documents.modules) });
    }
    if (endpoint === `repos/${fullName}/contents/lazurio.organization.json?ref=main`) {
      return { status: 1, stdout: "", stderr: "gh: Not Found (HTTP 404)" };
    }
    throw new Error(`unexpected provider call ${call.args.join(" ")}`);
  };
}

function ok(value) {
  return { status: 0, stdout: JSON.stringify(value), stderr: "" };
}


async function dbFirstFixture() {
  const fixture = await organizationRepositoryDbFixture();
  const parentRemote = join(fixture.root, "app-remote.git");
  const appSource = join(fixture.root, "app-source");
  await initGitRepo(appSource, { remotePath: parentRemote });
  await writeFile(join(appSource, ".gitignore"), "db/\n");
  await mkdir(join(appSource, "app"));
  await writeFile(join(appSource, "app/main.mjs"), "app code\n");
  await runGit(["add", "."], { cwd: appSource });
  await runGit(["commit", "-m", "App fixture"], { cwd: appSource });
  await runGit(["push", "origin", "main"], { cwd: appSource });
  const organizationRoot = join(fixture.root, "organizations", `${login}_GEN3`);
  expect((await runGit(["clone", "--branch", "main", fixture.remote, organizationRoot], { cwd: fixture.root })).ok).toBe(true);
  await runGit(["remote", "set-url", "origin", fakeHttpsRemote], { cwd: organizationRoot });
  const parent = join(organizationRoot, "mission-control");
  const db = join(parent, "db");
  await mkdir(parent);
  await runGit(["clone", "--branch", "v3", fixture.dataRemote, db], { cwd: fixture.root });
  await runGit(["remote", "set-url", "origin", fakeDataRemote], { cwd: db });
  const remotes = new Map([[fakeHttpsRemote, fixture.remote], [fakeDataRemote, fixture.dataRemote], [`git@github.com:${login}/mission-control.git`, parentRemote]]);
  const deps = {
    observe: async () => sourceObservation({ documents: fixture.documents }), reobserve: async () => ({ ok: true }),
    runGit: translatedGitRunner(fixture.remote, remotes), runPinnedChild: translatedPinnedGitRunner(fixture.remote, remotes),
    runUpdate: async () => existsSync(join(parent, ".git")) ? updateReport("current") : {
      ...updateReport("blocked"), results: [{ state: "blocked", reason: "managed_checkout_not_repository", repo_key: `${login}::mission-control`, repo_kind: "root_repo", module: "mission-control", path: `organizations/${login}_GEN3/mission-control` }],
    },
  };
  return { ...fixture, deps, parent, db, appSource };
}
const macRecoveryTest = process.platform === "darwin" ? test : test.skip;
macRecoveryTest("db-first Organization install preserves canonical data and converges idempotently", async () => {
  const fixture = await dbFirstFixture();
  const before = await lstat(fixture.db);
  const head = (await runGit(["rev-parse", "HEAD"], { cwd: fixture.db })).stdout;
  const contents = await readFile(join(fixture.db, "repository-db.yaml"), "utf8");
  const first = await installOrganization({ rootPath: fixture.root, githubLogin: login, deps: fixture.deps });
  expect(first, JSON.stringify(first)).toMatchObject({ state: "updated", ok: true });
  expect(first.convergence.results).toContainEqual(expect.objectContaining({ reason: "repository_parent_recovered" }));
  expect(await readFile(join(fixture.parent, "app/main.mjs"), "utf8")).toBe("app code\n");
  expect((await lstat(fixture.db)).ino).toBe(before.ino);
  expect((await runGit(["rev-parse", "HEAD"], { cwd: fixture.db })).stdout).toBe(head);
  expect(await readFile(join(fixture.db, "repository-db.yaml"), "utf8")).toBe(contents);
  expect((await runGit(["remote", "get-url", "origin"], { cwd: fixture.db })).stdout).toBe(fakeDataRemote);
  expect((await runGit(["branch", "--show-current"], { cwd: fixture.db })).stdout).toBe("v3");
  expect(await installOrganization({ rootPath: fixture.root, githubLogin: login, deps: fixture.deps })).toMatchObject({ state: "current", ok: true });
});
for (const fault of ["dirty", "foreign", "branch", "unknown", "symlink", "tracked-db", "not-ignored"]) macRecoveryTest(`db-first recovery rejects ${fault} without app publication`, async () => {
  const fixture = await dbFirstFixture();
  if (fault === "symlink") { await rename(fixture.db, join(fixture.root, "db-original")); await symlink(join(fixture.root, "db-original"), fixture.db); }
  if (fault === "dirty") await writeFile(join(fixture.db, "local-note"), "keep");
  if (fault === "foreign") await runGit(["remote", "set-url", "origin", "git@github.com:Other/data.git"], { cwd: fixture.db });
  if (fault === "branch") await runGit(["checkout", "-b", "local-work"], { cwd: fixture.db });
  if (fault === "unknown") await writeFile(join(fixture.parent, "local-note"), "keep");
  if (fault === "tracked-db" || fault === "not-ignored") {
    await writeFile(join(fixture.appSource, ".gitignore"), "");
    if (fault === "tracked-db") { await mkdir(join(fixture.appSource, "db")); await writeFile(join(fixture.appSource, "db/foreign"), "never publish"); }
    await runGit(["add", "."], { cwd: fixture.appSource });
    await runGit(["commit", "-m", "Fault fixture"], { cwd: fixture.appSource });
    await runGit(["push", "origin", "main"], { cwd: fixture.appSource });
  }
  const before = await lstat(fixture.db);
  const head = (await runGit(["rev-parse", "HEAD"], { cwd: fixture.db })).stdout;
  const report = await installOrganization({ rootPath: fixture.root, githubLogin: login, deps: fixture.deps });
  expect(report).toMatchObject({ state: "blocked", ok: false });
  expect(report.target.state).toBe("current");
  expect(report.convergence.results).toContainEqual(expect.objectContaining({ reason: fault === "symlink" ? "repository_db_target_unsafe" : fault === "unknown" ? "repository_parent_recovery_content_unknown" : ["tracked-db", "not-ignored"].includes(fault) ? "repository_parent_db_preservation_failed" : "repository_db_identity_mismatch" }));
  expect(existsSync(join(fixture.parent, ".git"))).toBe(false);
  expect(existsSync(join(fixture.parent, "app"))).toBe(false);
  expect((await lstat(fixture.db)).ino).toBe(before.ino);
  expect((await runGit(["rev-parse", "HEAD"], { cwd: fixture.db })).stdout).toBe(head);
});
