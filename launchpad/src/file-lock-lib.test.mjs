import { expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireFileLock, FileLockError } from "../../lazurio/runtime/file-lock-lib.mjs";

// One kernel `flock` on one regular file, the exclusion the runtime cache of
// the Bun versions Apps pin shares with LazurioPlatform on the same machine
// (decision 0171, addendum of 2026-10-24). Qualified on macOS and Linux only.
const posixTest = test.skipIf(!["darwin", "linux"].includes(process.platform));
const libraryPath = join(import.meta.dir, "..", "..", "lazurio", "runtime", "file-lock-lib.mjs");

async function scope(run) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "lazurio-file-lock-")));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

posixTest("one holder at a time; a contender gets a bounded, typed busy", () =>
  scope(async (root) => {
    const path = join(root, "coordination.lock");
    const first = await acquireFileLock(path, { timeoutMs: 0 });
    const started = performance.now();
    const refused = await acquireFileLock(path, { timeoutMs: 150, pollMs: 10 }).catch((error) => error);
    expect(refused).toBeInstanceOf(FileLockError);
    expect(refused.reason).toBe("busy");
    const waited = performance.now() - started;
    expect(waited).toBeGreaterThanOrEqual(140);
    expect(waited).toBeLessThan(2_000);
    await first.release();
    // Releasing twice is harmless and never closes someone else's descriptor.
    await first.release();
    const second = await acquireFileLock(path, { timeoutMs: 0 });
    await second.release();
  }));

posixTest("a waiter acquires as soon as the holder releases", () =>
  scope(async (root) => {
    const path = join(root, "coordination.lock");
    const first = await acquireFileLock(path, { timeoutMs: 0 });
    let acquired = false;
    const waiter = acquireFileLock(path, { timeoutMs: 5_000, pollMs: 5 }).then((lock) => {
      acquired = true;
      return lock;
    });
    await Bun.sleep(60);
    expect(acquired).toBe(false);
    await first.release();
    const lock = await waiter;
    expect(acquired).toBe(true);
    await lock.release();
  }));

posixTest("the kernel releases the lock of a killed holder; the lock file is never removed and holds nothing", () =>
  scope(async (root) => {
    const path = join(root, "coordination.lock");
    const child = Bun.spawn(
      [
        process.execPath,
        "-e",
        `import { acquireFileLock } from ${JSON.stringify(libraryPath)};
         await acquireFileLock(${JSON.stringify(path)}, { timeoutMs: 0 });
         console.log("held");
         await new Promise(() => {});`,
      ],
      { env: {}, stdout: "pipe", stderr: "ignore" },
    );
    try {
      const reader = child.stdout.getReader();
      let output = "";
      while (!output.includes("held")) {
        const chunk = await reader.read();
        if (chunk.done) break;
        output += new TextDecoder().decode(chunk.value);
      }
      expect(output).toContain("held");
      await expect(acquireFileLock(path, { timeoutMs: 50, pollMs: 10 })).rejects.toBeInstanceOf(FileLockError);
    } finally {
      // No shutdown code of the holder runs at all.
      child.kill("SIGKILL");
      await child.exited;
    }
    const next = await acquireFileLock(path, { timeoutMs: 2_000, pollMs: 10 });
    // No owner record: one empty regular file, never a directory or a PID.
    expect(await readdir(root)).toEqual(["coordination.lock"]);
    expect((await readFile(path)).byteLength).toBe(0);
    await next.release();
    expect(await readdir(root)).toEqual(["coordination.lock"]);
  }));

posixTest("a lock held only by its handle survives garbage collection", () =>
  scope(async (root) => {
    const path = join(root, "coordination.lock");
    // The returned object is dropped on purpose; the descriptor must stay open.
    await acquireFileLock(path, { timeoutMs: 0 });
    Bun.gc(true);
    await Bun.sleep(20);
    Bun.gc(true);
    await expect(acquireFileLock(path, { timeoutMs: 50, pollMs: 10 })).rejects.toMatchObject({ reason: "busy" });
  }));

posixTest("symlinks, unsupported filesystems and unbounded waits are refused", () =>
  scope(async (root) => {
    const path = join(root, "coordination.lock");
    await symlink(join(root, "elsewhere"), path);
    await expect(acquireFileLock(path, { timeoutMs: 0 })).rejects.toThrow();
    expect(await readdir(root)).toEqual(["coordination.lock"]);
    const plain = join(root, "plain.lock");
    // A filesystem without flock can never become free: no waiting, no `busy`.
    let attempts = 0;
    await expect(acquireFileLock(plain, {
      timeoutMs: 60_000,
      tryLock: () => {
        attempts += 1;
        return "unsupported";
      },
    })).rejects.toMatchObject({ reason: "unsupported" });
    expect(attempts).toBe(1);
    for (const timeoutMs of [-1, 1.5, Number.POSITIVE_INFINITY, 3_600_001]) {
      await expect(acquireFileLock(plain, { timeoutMs })).rejects.toThrow("Bounded");
    }
  }));
