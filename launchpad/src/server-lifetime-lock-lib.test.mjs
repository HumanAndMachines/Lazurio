import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { acquireServerLifetimeLock } from "./server-lifetime-lock-lib.mjs";

const roots = [];

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

test("the per-user Server lifetime lease stays exclusive until its owner releases it", async () => {
  const root = await mkdtemp(join(tmpdir(), "lazurio-server-lifetime-lock-"));
  roots.push(root);
  const stateDirectory = join(root, "state");

  const first = await acquireServerLifetimeLock({ stateDirectory, instanceId: "first" });
  let secondAcquired = false;
  const secondPromise = acquireServerLifetimeLock({ stateDirectory, instanceId: "second" })
    .then((lock) => {
      secondAcquired = true;
      return lock;
    });

  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(secondAcquired).toBe(false);
  expect(first.path).toContain(stateDirectory);

  await first.release();
  const second = await secondPromise;
  expect(secondAcquired).toBe(true);
  await second.release();
});

test("Server lifetime lease refuses a symlinked locator directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "lazurio-server-lifetime-lock-symlink-"));
  const external = await mkdtemp(join(tmpdir(), "lazurio-server-lifetime-lock-external-"));
  roots.push(root, external);
  const stateDirectory = join(root, "state");
  await symlink(external, stateDirectory);

  await expect(acquireServerLifetimeLock({
    stateDirectory,
    instanceId: "unsafe",
  })).rejects.toThrow("must be a physical directory");
});
