import { afterAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runGit, safeGitRemoteEnv } from "../../launchpad/src/git-lib.mjs";
import { initGitRepo } from "../../launchpad/src/git-fixture-helpers.test.mjs";
import { materializeGitCheckout } from "./git-materialization-lib.mjs";

const roots = [];

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

test("one Core primitive publishes an Organization root only after owner verification", async () => {
  const fixture = await fixtureRemote();
  const target = join(fixture.root, "organizations", "ExampleOrganization_GEN3");
  let verifiedPath = null;

  const result = await materializeGitCheckout({
    mode: "organization-root",
    boundaryRoot: fixture.root,
    targetPath: target,
    remote: fixture.remote,
    branch: "main",
    run: runGit,
    remoteEnvironment: safeGitRemoteEnv(),
    verifyStaged: async ({ path }) => {
      verifiedPath = path;
      return { ok: true };
    },
  });

  expect(result).toMatchObject({ ok: true, outcome: "materialized", mode: "organization-root" });
  expect(verifiedPath).not.toBe(target);
  expect(existsSync(join(target, "README.md"))).toBe(true);
});

test("failed staged identity verification never publishes the target", async () => {
  const fixture = await fixtureRemote();
  const target = join(fixture.root, "organizations", "ForeignOrganization_GEN3");

  const result = await materializeGitCheckout({
    mode: "organization-root",
    boundaryRoot: fixture.root,
    targetPath: target,
    remote: fixture.remote,
    branch: "main",
    run: runGit,
    remoteEnvironment: safeGitRemoteEnv(),
    verifyStaged: async () => ({
      ok: false,
      code: "root_manifest_identity_mismatch",
      message: "foreign root",
    }),
  });

  expect(result).toMatchObject({
    ok: false,
    code: "root_manifest_identity_mismatch",
  });
  expect(await readdir(join(fixture.root, "organizations"))).toEqual([]);
});

test("case-folded sibling blocks publication on case-sensitive hosts too", async () => {
  const fixture = await fixtureRemote();
  await mkdir(join(fixture.root, "organizations", "exampleorganization_gen3"));
  const target = join(fixture.root, "organizations", "ExampleOrganization_GEN3");

  const result = await materializeGitCheckout({
    mode: "organization-root",
    boundaryRoot: fixture.root,
    targetPath: target,
    remote: fixture.remote,
    branch: "main",
    run: runGit,
    remoteEnvironment: safeGitRemoteEnv(),
    deps: {
      // macOS commonly resolves the differently-cased sibling from lstat;
      // inject the case-sensitive-host observation so the explicit folded
      // directory scan remains deterministic on every CI OS.
      pathEntry: async (path) => path === target ? null : lstat(path),
    },
  });

  expect(result).toMatchObject({
    ok: false,
    code: "materialization_target_case_collision",
  });
  expect(await readdir(join(fixture.root, "organizations"))).toEqual(["exampleorganization_gen3"]);
});

async function fixtureRemote() {
  const root = await mkdtemp(join(tmpdir(), "lazurio-core-materialization-"));
  roots.push(root);
  const source = join(root, "source");
  const remote = join(root, "remote.git");
  await mkdir(join(root, "organizations"), { recursive: true });
  await initGitRepo(source, { remotePath: remote });
  return { root, remote };
}
