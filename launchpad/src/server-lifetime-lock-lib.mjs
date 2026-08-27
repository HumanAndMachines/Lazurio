import { existsSync, lstatSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { acquireModuleRuntimeLock } from "../../lazurio/runtime/module-runtime-lock-lib.mjs";

export async function acquireServerLifetimeLock({
  stateDirectory,
  instanceId,
  pid = process.pid,
  resolveProcessIdentity = serverLifetimeProcessIdentity,
  timeoutMs = 2_000,
}) {
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  assertPhysicalDirectory(stateDirectory, "Lazurio Server state directory");

  try {
    return await acquireModuleRuntimeLock({
      root: stateDirectory,
      key: "server-lifetime",
      instanceId,
      pid,
      timeoutMs,
      // The Server holds this lock for its whole process lifetime. Linux hosted
      // workspaces persist this record across container recreation, where the
      // same namespace PID can immediately belong to a different process.
      // /proc supplies a spawn-free boot + process-start identity so that reuse
      // cannot wedge the next container. Other platforms retain the deliberately
      // fail-closed PID proof until they have an equally local identity source.
      resolveProcessIdentity,
    });
  } catch (error) {
    if (error?.code !== "LAZURIO_MODULE_RUNTIME_LOCK_TIMEOUT") throw error;
    const conflict = new Error(
      "Jiný Lazurio Server stále drží per-user lifetime lease. Pokud chybí locator, ukonči starý Server a spusť příkaz znovu.",
      { cause: error },
    );
    conflict.code = "LAZURIO_SERVER_LIFETIME_LOCKED";
    throw conflict;
  }
}

export async function acquireServerStartupLock({ stateDirectory, instanceId }) {
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  assertPhysicalDirectory(stateDirectory, "Lazurio Server state directory");

  try {
    return await acquireModuleRuntimeLock({
      root: stateDirectory,
      key: "server-startup",
      instanceId,
      timeoutMs: 30_000,
      // All launchers hold this short lease from locator read through reuse,
      // replacement or ready-locator publication. The same fail-closed PID
      // proof as the lifetime lease is enough for crash recovery.
      resolveProcessIdentity: serverLifetimeProcessIdentity,
    });
  } catch (error) {
    if (error?.code !== "LAZURIO_MODULE_RUNTIME_LOCK_TIMEOUT") throw error;
    const conflict = new Error(
      "Jiný Lazurio launcher stále dokončuje reuse nebo replacement Serveru. Spusť příkaz znovu.",
      { cause: error },
    );
    conflict.code = "LAZURIO_SERVER_STARTUP_LOCKED";
    throw conflict;
  }
}

export async function serverLifetimeProcessIdentity(pid, {
  platform = process.platform,
  readFileFn = readFile,
  signalProcess = (candidatePid) => process.kill(candidatePid, 0),
} = {}) {
  if (platform === "linux") {
    try {
      const [stat, bootId] = await Promise.all([
        readFileFn(`/proc/${pid}/stat`, "utf8"),
        readFileFn("/proc/sys/kernel/random/boot_id", "utf8"),
      ]);
      const startTicks = linuxProcessStartTicks(stat, pid);
      const normalizedBootId = bootId.trim().toLowerCase();
      if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(normalizedBootId)) {
        throw new Error("Linux boot identity is invalid");
      }
      return `linux:${normalizedBootId}:pid:${pid}:start:${startTicks}`;
    } catch (error) {
      // Any incomplete Linux identity is unknown, never a different identity.
      // The lock owner check then falls back to PID liveness and stays closed;
      // a first acquisition fails because it cannot publish unverifiable owner
      // metadata. Returning the older `pid:` format here would make a transient
      // /proc failure look like PID reuse and could quarantine a live rich lock.
      return null;
    }
  }

  try {
    signalProcess(pid);
    return `pid:${pid}`;
  } catch (error) {
    if (error?.code === "ESRCH") return null;
    if (error?.code === "EPERM") return `pid:${pid}`;
    throw error;
  }
}

function linuxProcessStartTicks(stat, pid) {
  const prefix = `${pid} (`;
  const commandEnd = stat.lastIndexOf(") ");
  if (!stat.startsWith(prefix) || commandEnd < prefix.length) {
    throw new Error("Linux process stat identity is invalid");
  }
  // The suffix begins at field 3 (`state`); process start time is field 22.
  const suffix = stat.slice(commandEnd + 2).trim().split(/\s+/u);
  const startTicks = suffix[19];
  if (!/^[0-9]+$/u.test(startTicks ?? "")) {
    throw new Error("Linux process start time is invalid");
  }
  return startTicks;
}

function assertPhysicalDirectory(path, label) {
  if (!existsSync(path)) throw new Error(`${label} does not exist: ${path}`);
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a physical directory: ${path}`);
  }
}
