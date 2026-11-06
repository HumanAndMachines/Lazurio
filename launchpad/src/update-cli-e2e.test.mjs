import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

import { moduleBunRoot } from "../../lazurio/runtime/bun-runtime-lib.mjs";
import { runIsolatedLazurioUpdate } from "../../lazurio/runtime/lazurio-update-runner-lib.mjs";
import {
  commitRemoteModule,
  commitRemoteRoot,
  createLazurioUpdateFixture,
} from "../../tests/lazurio-update-fixture.mjs";

const cleanup = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

// A home of the fixture's own: a computer's update reads its runtime cache
// under the home (`~/.local/share/lazurio/runtimes`), never this machine's.
async function fixtureEnvironment(fixture) {
  if (fixture.environment) return fixture.environment;
  const home = join(fixture.sandbox, "home");
  await mkdir(home, { recursive: true });
  fixture.environment = { ...process.env, HOME: home, USERPROFILE: home, LOCALAPPDATA: join(home, "AppData", "Local") };
  return fixture.environment;
}

// Files the root's remote main gains, for the update to fast-forward to.
async function commitRemoteRootFiles(fixture, files) {
  for (const [path, value] of Object.entries(files)) {
    await mkdir(dirname(join(fixture.contributor, path)), { recursive: true });
    await writeFile(join(fixture.contributor, path), `${JSON.stringify(value, null, 2)}\n`);
  }
  for (const args of [["add", ...Object.keys(files)], ["commit", "-m", "remote root files"], ["push", "origin", "main"]]) {
    const result = spawnSync("git", args, {
      cwd: fixture.contributor,
      encoding: "utf8",
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    if (result.status !== 0) throw new Error(result.stderr || result.error?.message);
  }
}

test("isolated CLI runtime fast-forwards mutable root and rerun is idempotent", async () => {
  const fixture = await createLazurioUpdateFixture();
  cleanup.push(fixture.sandbox);
  await commitRemoteRoot(fixture);
  const environment = await fixtureEnvironment(fixture);

  const first = await runIsolatedLazurioUpdate({ rootPath: fixture.working, environment });
  expect(first).toMatchObject({ state: "updated", ok: true });
  const second = await runIsolatedLazurioUpdate({ rootPath: fixture.working, environment });
  expect(second).toMatchObject({ state: "current", ok: true });
});

test("isolated CLI runtime carries schema assets into post-update app discovery", async () => {
  const fixture = await createLazurioUpdateFixture({ withModule: true });
  cleanup.push(fixture.sandbox);
  await commitRemoteModule(fixture);

  const report = await runIsolatedLazurioUpdate({ rootPath: fixture.working, environment: await fixtureEnvironment(fixture) });

  expect(report.ok).toBe(true);
  expect(report.results.find((result) => result.repo_key === "FixtureOrg::sample"))
    .toMatchObject({ state: "updated", reason: "checkout_updated", actions: ["fast_forward"] });
  expect(report.results.some((result) => result.reason === "dependency_inventory_unavailable")).toBe(false);
});

test("isolated CLI runtime ignores ambient Git transport rewrites when materializing a missing module", async () => {
  const fixture = await createLazurioUpdateFixture({
    withModule: true,
    moduleMaterialized: false,
  });
  cleanup.push(fixture.sandbox);

  const report = await runIsolatedLazurioUpdate({
    rootPath: fixture.working,
    environment: fixture.environment,
  });

  expect(report).toMatchObject({ ok: false, state: "blocked" });
  expect(report.results.find((result) => result.repo_key === "FixtureOrg::sample"))
    .toMatchObject({
      state: "blocked",
      reason: "materialization_source_unavailable",
      actions: [],
    });
  expect(existsSync(fixture.moduleWorking)).toBe(false);
});

test("isolated runtime accepts one internal Organization scope without a second updater", async () => {
  const fixture = await createLazurioUpdateFixture({ withModule: true });
  cleanup.push(fixture.sandbox);
  const report = await runIsolatedLazurioUpdate({
    rootPath: fixture.working,
    organizations: [{
      slug: "FixtureOrg",
      display_name: "Fixture Organization",
      path: "organizations/FixtureOrg_GEN3",
      status: "active",
      default_branch: "main",
    }],
    environment: await fixtureEnvironment(fixture),
  });

  expect(report).toMatchObject({ state: "current", ok: true });
  expect(report.results.some((result) => result.repo_key === "FixtureOrg::root")).toBe(true);
  expect(report.results.every((result) => (
    result.organization === null || result.organization === "FixtureOrg"
  ))).toBe(true);
});

test("isolated runtime forwards the explicit restricted slot policy and defaults to defer", async () => {
  const fixture = await createLazurioUpdateFixture();
  cleanup.push(fixture.sandbox);
  const environment = await fixtureEnvironment(fixture);
  const scoped = await runIsolatedLazurioUpdate({ rootPath: fixture.working, restrictedSlotPolicy: "exclude", environment });
  expect(scoped).toMatchObject({ state: "current", ok: true, restricted_slot_policy: "exclude" });
  const generic = await runIsolatedLazurioUpdate({ rootPath: fixture.working, environment });
  expect(generic).toMatchObject({ state: "current", ok: true, restricted_slot_policy: "defer" });
  await expect(runIsolatedLazurioUpdate({ rootPath: fixture.working, restrictedSlotPolicy: "everything", environment }))
    .rejects.toThrow(/restrictedSlotPolicy/);
});

test("bun update entrypoint and lazurio update expose the same report contract", async () => {
  const fixture = await createLazurioUpdateFixture();
  cleanup.push(fixture.sandbox);
  const environment = await fixtureEnvironment(fixture);
  const launchpadEntry = join(import.meta.dirname, "update-cli.mjs");
  const lazurioEntry = join(import.meta.dirname, "..", "..", "lazurio", "cli.mjs");

  const launchpad = spawnSync(process.execPath, [launchpadEntry, "--json", "--root", fixture.working], {
    cwd: fixture.working,
    encoding: "utf8",
    env: environment,
  });
  const lazurio = spawnSync(process.execPath, [lazurioEntry, "update", "--json", "--root", fixture.working], {
    cwd: fixture.working,
    encoding: "utf8",
    env: environment,
  });
  expect(launchpad.status).toBe(0);
  expect(lazurio.status).toBe(0);
  const first = JSON.parse(launchpad.stdout);
  const second = JSON.parse(lazurio.stdout);
  expect(first.schema_version).toBe("lazurio.update.v1");
  expect(second.schema_version).toBe(first.schema_version);
  expect(["current", "updated", "blocked"]).toContain(first.state);
  expect(second.state).toBe("current");
});

test("the isolated runtime of a computer fetches ahead the Bun the synced root pins and reports its runtime cache, which it leaves as it was", async () => {
  const fixture = await createLazurioUpdateFixture();
  cleanup.push(fixture.sandbox);
  // The root's CLI pin and default arrive with the sync: the Bun this test
  // runs on, so nothing is downloaded.
  await commitRemoteRootFiles(fixture, {
    "lazurio/package.json": { name: "@lazurio/runtime", private: true, packageManager: `bun@${Bun.version}` },
    "lazurio/toolchain.json": {
      schema_version: "lazurio.toolchain.v1",
      tools: {
        bun: { default: Bun.version, minimum: Bun.version },
        node: { minimum: "22.12.0" },
        uv: { default: "0.11.6" },
        gh: { minimum: "2.57.0" },
        git: { minimum: "2.31.0" },
      },
    },
  });
  const environment = await fixtureEnvironment(fixture);

  const report = await runIsolatedLazurioUpdate({ rootPath: fixture.working, environment });

  expect(report).toMatchObject({ ok: true, state: "updated" });
  expect(report.tools.bun.pins).toEqual([
    { version: Bun.version, cli_pin: true, default: true, apps: 0, state: "user" },
  ]);
  const cacheRoot = moduleBunRoot(environment.HOME, { env: environment });
  expect(report.tools.bun.prune_report).toEqual({
    mode: "report_only",
    cache_root: cacheRoot,
    state: "absent",
    versions: [],
    would_free_bytes: 0,
  });
  // Neither the user's Bun nor the report wrote anything there.
  expect(existsSync(dirname(dirname(cacheRoot)))).toBe(false);
});
