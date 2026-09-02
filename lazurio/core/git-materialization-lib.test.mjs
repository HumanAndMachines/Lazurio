import { afterAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import {
  appendFile,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  runGit,
  runGitInPinnedTemporaryChild,
  safeGitRemoteEnv,
} from "../runtime/git-lib.mjs";
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
    runPinnedChild: runGitInPinnedTemporaryChild,
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

test("post-clone repository fsmonitor cannot execute during materialization verification", async () => {
  const fixture = await fixtureRemote();
  const target = join(fixture.root, "organizations", "FsmonitorSafe_GEN3");
  const marker = join(fixture.root, "fsmonitor-invoked.txt");
  const hook = join(fixture.root, process.platform === "win32" ? "fsmonitor.cmd" : "fsmonitor.sh");
  const hookBody = process.platform === "win32"
    ? `@echo off\r\n> "${marker}" echo invoked\r\necho {}\r\n`
    : `#!/bin/sh\nprintf invoked > "${marker}"\nprintf '{}\\n'\n`;
  await writeFile(hook, hookBody);
  if (process.platform !== "win32") await chmod(hook, 0o755);

  let injection = null;
  const observedArgs = [];
  const runWithInjectedLocalConfig = async (args, options) => {
    observedArgs.push(args);
    if (options.cwd?.includes(".lazurio-materialize-")) {
      injection ??= appendFile(
        join(options.cwd, ".git", "config"),
        `\n[core]\n\tfsmonitor = ${JSON.stringify(hook.replaceAll("\\", "/"))}\n`,
      );
      await injection;
    }
    return runGit(args, options);
  };

  const result = await materializeGitCheckout({
    mode: "organization-root",
    boundaryRoot: fixture.root,
    targetPath: target,
    remote: fixture.remote,
    branch: "main",
    run: runWithInjectedLocalConfig,
    runPinnedChild: runGitInPinnedTemporaryChild,
    remoteEnvironment: safeGitRemoteEnv(),
  });

  expect(result).toMatchObject({ ok: true, outcome: "materialized" });
  expect(injection).not.toBeNull();
  expect(existsSync(marker)).toBe(false);
  expect(observedArgs.every((args) => (
    args.includes("core.fsmonitor=false")
    && args.includes("core.useBuiltinFSMonitor=false")
    && args.some((arg) => arg.startsWith("core.hooksPath="))
  ))).toBe(true);

  const unsafeControl = await runGit(["status", "--porcelain=v1"], { cwd: target });
  expect(unsafeControl.ok).toBe(true);
  expect(existsSync(marker)).toBe(true);
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
    runPinnedChild: runGitInPinnedTemporaryChild,
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
    runPinnedChild: runGitInPinnedTemporaryChild,
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

test("pinned publication rejects a parent replaced after staged verification", async () => {
  const fixture = await fixtureRemote();
  const organizations = join(fixture.root, "organizations");
  const displaced = join(fixture.root, "organizations-displaced");
  const outside = join(fixture.root, "outside");
  const target = join(organizations, "ExampleOrganization_GEN3");
  await mkdir(outside);

  const result = await materializeGitCheckout({
    mode: "organization-root",
    boundaryRoot: fixture.root,
    targetPath: target,
    remote: fixture.remote,
    branch: "main",
    run: runGit,
    runPinnedChild: runGitInPinnedTemporaryChild,
    remoteEnvironment: safeGitRemoteEnv(),
    deps: {
      beforePublish: async ({ stagingName }) => {
        await mkdir(join(outside, stagingName));
        await Bun.write(join(outside, stagingName, "keep.txt"), "keep\n");
        await rename(organizations, displaced);
        await symlink(outside, organizations, process.platform === "win32" ? "junction" : "dir");
      },
    },
  });

  expect(result).toMatchObject({
    ok: false,
    code: "materialization_path_forbidden",
  });
  expect(existsSync(join(outside, "ExampleOrganization_GEN3"))).toBe(false);
  const outsideStaging = (await readdir(outside)).find((entry) => entry.includes(".lazurio-materialize-"));
  expect(outsideStaging).toBeTruthy();
  expect(await Bun.file(join(outside, outsideStaging, "keep.txt")).text()).toBe("keep\n");
  expect(existsSync(join(displaced, "ExampleOrganization_GEN3"))).toBe(false);
});

test("pinned staging and clone reject a parent replaced at the pre-clone race", async () => {
  const fixture = await fixtureRemote();
  const organizations = join(fixture.root, "organizations");
  const displaced = join(fixture.root, "organizations-displaced-before-staging");
  const outside = join(fixture.root, "outside-before-staging");
  const target = join(organizations, "ExampleOrganization_GEN3");
  await mkdir(outside);

  const result = await materializeGitCheckout({
    mode: "organization-root",
    boundaryRoot: fixture.root,
    targetPath: target,
    remote: fixture.remote,
    branch: "main",
    run: runGit,
    runPinnedChild: runGitInPinnedTemporaryChild,
    remoteEnvironment: safeGitRemoteEnv(),
    deps: {
      beforeStage: async () => {
        await rename(organizations, displaced);
        await symlink(outside, organizations, process.platform === "win32" ? "junction" : "dir");
      },
    },
  });

  expect(result).toMatchObject({
    ok: false,
    code: "materialization_path_forbidden",
  });
  expect(await readdir(outside)).toEqual([]);
  expect(existsSync(join(displaced, "ExampleOrganization_GEN3"))).toBe(false);
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
