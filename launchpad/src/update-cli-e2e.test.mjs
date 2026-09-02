import { afterEach, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

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

test("isolated CLI runtime fast-forwards mutable root and rerun is idempotent", async () => {
  const fixture = await createLazurioUpdateFixture();
  cleanup.push(fixture.sandbox);
  await commitRemoteRoot(fixture);

  const first = await runIsolatedLazurioUpdate({ rootPath: fixture.working });
  expect(first).toMatchObject({ state: "updated", ok: true });
  const second = await runIsolatedLazurioUpdate({ rootPath: fixture.working });
  expect(second).toMatchObject({ state: "current", ok: true });
});

test("isolated CLI runtime carries schema assets into post-update app discovery", async () => {
  const fixture = await createLazurioUpdateFixture({ withModule: true });
  cleanup.push(fixture.sandbox);
  await commitRemoteModule(fixture);

  const report = await runIsolatedLazurioUpdate({ rootPath: fixture.working });

  expect(report.ok).toBe(true);
  expect(report.results.find((result) => result.repo_key === "FixtureOrg::sample"))
    .toMatchObject({ state: "updated", reason: "checkout_updated", actions: ["fast_forward"] });
  expect(report.results.some((result) => result.reason === "dependency_inventory_unavailable")).toBe(false);
});

test("isolated CLI runtime routes pinned child modes when materializing a missing module", async () => {
  const fixture = await createLazurioUpdateFixture({
    withModule: true,
    moduleMaterialized: false,
  });
  cleanup.push(fixture.sandbox);

  const report = await runIsolatedLazurioUpdate({
    rootPath: fixture.working,
    environment: fixture.environment,
  });

  expect(report).toMatchObject({ ok: true, state: "updated" });
  expect(report.results.find((result) => result.repo_key === "FixtureOrg::sample"))
    .toMatchObject({ state: "updated", reason: "module_materialized", actions: ["materialize"] });
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
  });

  expect(report).toMatchObject({ state: "current", ok: true });
  expect(report.results.some((result) => result.repo_key === "FixtureOrg::root")).toBe(true);
  expect(report.results.every((result) => (
    result.organization === null || result.organization === "FixtureOrg"
  ))).toBe(true);
});

test("bun update entrypoint and lazurio update expose the same report contract", async () => {
  const fixture = await createLazurioUpdateFixture();
  cleanup.push(fixture.sandbox);
  const launchpadEntry = join(import.meta.dirname, "update-cli.mjs");
  const lazurioEntry = join(import.meta.dirname, "..", "..", "lazurio", "cli.mjs");

  const launchpad = spawnSync(process.execPath, [launchpadEntry, "--json", "--root", fixture.working], {
    cwd: fixture.working,
    encoding: "utf8",
  });
  const lazurio = spawnSync(process.execPath, [lazurioEntry, "update", "--json", "--root", fixture.working], {
    cwd: fixture.working,
    encoding: "utf8",
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
