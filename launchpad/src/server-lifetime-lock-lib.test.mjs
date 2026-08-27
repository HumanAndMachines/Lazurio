import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  acquireServerLifetimeLock,
  acquireServerStartupLock,
  serverLifetimeProcessIdentity,
} from "./server-lifetime-lock-lib.mjs";

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

test("a recreated Linux process can recover a lifetime lease left by the same PID", async () => {
  const root = await mkdtemp(join(tmpdir(), "lazurio-server-lifetime-pid-reuse-"));
  roots.push(root);
  const stateDirectory = join(root, "state");
  let identity = "linux:boot:pid:34:start:100";
  const resolveProcessIdentity = async () => identity;

  const crashed = await acquireServerLifetimeLock({
    stateDirectory,
    instanceId: "crashed-container",
    pid: 34,
    resolveProcessIdentity,
  });
  identity = "linux:boot:pid:34:start:200";
  const recovered = await acquireServerLifetimeLock({
    stateDirectory,
    instanceId: "replacement-container",
    pid: 34,
    resolveProcessIdentity,
  });

  expect(recovered.owner.process_identity).toBe(identity);
  expect(await crashed.release()).toBe(false);
  await recovered.release();
});

test("Linux lifetime identity includes boot and process start time without spawning", async () => {
  const reads = [];
  const identity = await serverLifetimeProcessIdentity(34, {
    platform: "linux",
    readFileFn: async (path) => {
      reads.push(path);
      if (path.endsWith("/stat")) {
        return "34 (Lazurio Launchp) S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 424242 20 21";
      }
      return "12345678-1234-4abc-8def-1234567890ab\n";
    },
  });

  expect(identity).toBe("linux:12345678-1234-4abc-8def-1234567890ab:pid:34:start:424242");
  expect(reads).toEqual([
    "/proc/34/stat",
    "/proc/sys/kernel/random/boot_id",
  ]);
});

test("Linux metadata uncertainty keeps a live rich lifetime lease fail-closed", async () => {
  const root = await mkdtemp(join(tmpdir(), "lazurio-server-lifetime-proc-failure-"));
  roots.push(root);
  const stateDirectory = join(root, "state");
  const richIdentity = "linux:boot:pid:self:start:100";
  const live = await acquireServerLifetimeLock({
    stateDirectory,
    instanceId: "live-owner",
    resolveProcessIdentity: async () => richIdentity,
  });

  let identityLookups = 0;
  await expect(acquireServerLifetimeLock({
    stateDirectory,
    instanceId: "contender",
    resolveProcessIdentity: async () => {
      identityLookups += 1;
      return identityLookups === 1 ? "linux:boot:pid:self:start:200" : null;
    },
    timeoutMs: 20,
  })).rejects.toMatchObject({ code: "LAZURIO_SERVER_LIFETIME_LOCKED" });

  expect(await live.release()).toBe(true);
});

test("Linux identity lookup never degrades to a PID-only identity", async () => {
  let signalled = false;
  const identity = await serverLifetimeProcessIdentity(34, {
    platform: "linux",
    readFileFn: async () => {
      const error = new Error("temporarily restricted");
      error.code = "EACCES";
      throw error;
    },
    signalProcess: () => { signalled = true; },
  });

  expect(identity).toBeNull();
  expect(signalled).toBe(false);
});

test("the short startup lease serializes locator recovery with Server replacement", async () => {
  const root = await mkdtemp(join(tmpdir(), "lazurio-server-startup-lock-"));
  roots.push(root);
  const stateDirectory = join(root, "state");

  const recovery = await acquireServerStartupLock({ stateDirectory, instanceId: "recovery" });
  let replacementAcquired = false;
  const replacementPromise = acquireServerStartupLock({ stateDirectory, instanceId: "replacement" })
    .then((lock) => {
      replacementAcquired = true;
      return lock;
    });

  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(replacementAcquired).toBe(false);
  await recovery.release();

  const replacement = await replacementPromise;
  expect(replacementAcquired).toBe(true);
  await replacement.release();
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
