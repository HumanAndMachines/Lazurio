import { afterAll, expect, test } from "bun:test";
import { tmpdir } from "os";
import { join } from "path";
import { mkdir, mkdtemp, rm, symlink } from "fs/promises";
import { realpathSync } from "fs";
import { resolveLaunchpadStateRoot } from "./state-root-lib.mjs";

const tempRoots = [];

afterAll(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "launchpad-state-root-"));
  tempRoots.push(root);
  const runtimeRoot = join(root, "runtime");
  const workspaceRoot = join(root, "workspace");
  await mkdir(runtimeRoot);
  await mkdir(workspaceRoot);
  return { root, runtimeRoot, workspaceRoot };
}

test("hosted state root is required and must be absolute", async () => {
  const { root, runtimeRoot, workspaceRoot } = await fixture();
  expect(() => resolveLaunchpadStateRoot({
    hosted: true,
    runtimeRoot,
    workspaceRoot,
    fallbackRoot: root,
  })).toThrow("is required");
  expect(() => resolveLaunchpadStateRoot({
    configuredStateRoot: "relative/state",
    hosted: true,
    runtimeRoot,
    workspaceRoot,
    fallbackRoot: root,
  })).toThrow("absolute path");
});

test("hosted state root is created outside protected roots and returned canonically", async () => {
  const { root, runtimeRoot, workspaceRoot } = await fixture();
  const configuredStateRoot = join(root, "state", "launchpad");
  expect(resolveLaunchpadStateRoot({
    configuredStateRoot,
    hosted: true,
    runtimeRoot,
    workspaceRoot,
    fallbackRoot: root,
  })).toBe(realpathSync(configuredStateRoot));
});

test("symlink aliases into runtime and Workspace roots fail closed", async () => {
  const { root, runtimeRoot, workspaceRoot } = await fixture();
  for (const [name, target] of [["runtime-alias", runtimeRoot], ["workspace-alias", workspaceRoot]]) {
    const alias = join(root, name);
    await symlink(target, alias, process.platform === "win32" ? "junction" : "dir");
    expect(() => resolveLaunchpadStateRoot({
      configuredStateRoot: join(alias, "state"),
      hosted: true,
      runtimeRoot,
      workspaceRoot,
      fallbackRoot: root,
    })).toThrow("must not overlap");
  }
});

test("local profile without explicit state root keeps its fallback", async () => {
  const { root, runtimeRoot, workspaceRoot } = await fixture();
  expect(resolveLaunchpadStateRoot({
    hosted: false,
    runtimeRoot,
    workspaceRoot,
    fallbackRoot: root,
  })).toBe(root);
});
