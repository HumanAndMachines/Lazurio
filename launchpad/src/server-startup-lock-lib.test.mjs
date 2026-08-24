import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { acquireServerStartupLock } from "./server-startup-lock-lib.mjs";

const roots = [];

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

test("same-root Server startups serialize locator discovery, binding, and publication", async () => {
  const root = await mkdtemp(join(tmpdir(), "lazurio-server-startup-lock-"));
  roots.push(root);
  const stateDirectory = join(root, "state");

  const first = await acquireServerStartupLock({ stateDirectory, instanceId: "first" });
  let secondAcquired = false;
  const secondPromise = acquireServerStartupLock({ stateDirectory, instanceId: "second" })
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

test("Server startup lock refuses a symlinked locator directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "lazurio-server-startup-lock-symlink-"));
  const external = await mkdtemp(join(tmpdir(), "lazurio-server-startup-lock-external-"));
  roots.push(root, external);
  const stateDirectory = join(root, "state");
  await symlink(external, stateDirectory);

  await expect(acquireServerStartupLock({
    stateDirectory,
    instanceId: "unsafe",
  })).rejects.toThrow("must be a physical directory");
});
