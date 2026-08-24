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
  await mkdir(join(root, "launchpad"));

  const first = await acquireServerStartupLock({ workspaceRoot: root, instanceId: "first" });
  let secondAcquired = false;
  const secondPromise = acquireServerStartupLock({ workspaceRoot: root, instanceId: "second" })
    .then((lock) => {
      secondAcquired = true;
      return lock;
    });

  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(secondAcquired).toBe(false);
  expect(first.path).toContain(join("launchpad", ".local"));

  await first.release();
  const second = await secondPromise;
  expect(secondAcquired).toBe(true);
  await second.release();
});

test("Server startup lock refuses a symlinked locator directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "lazurio-server-startup-lock-symlink-"));
  const external = await mkdtemp(join(tmpdir(), "lazurio-server-startup-lock-external-"));
  roots.push(root, external);
  await mkdir(join(root, "launchpad"));
  await symlink(external, join(root, "launchpad", ".local"));

  await expect(acquireServerStartupLock({
    workspaceRoot: root,
    instanceId: "unsafe",
  })).rejects.toThrow("must be a physical directory");
});
