import { existsSync, lstatSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { acquireModuleRuntimeLock } from "./module-runtime-lock-lib.mjs";

export async function acquireServerLifetimeLock({ stateDirectory, instanceId }) {
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  assertPhysicalDirectory(stateDirectory, "Lazurio Server state directory");

  try {
    return await acquireModuleRuntimeLock({
      root: stateDirectory,
      key: "server-lifetime",
      instanceId,
      timeoutMs: 2_000,
      // The Server holds this lock for its whole process lifetime. PID liveness
      // is sufficient and deliberately fail-closed: a reused live PID may delay
      // stale recovery, but can never let a second Server through. Unlike Module
      // lifecycle ownership this needs no process start-time proof and therefore
      // no sandbox-sensitive ps/PowerShell spawn.
      resolveProcessIdentity: serverLifetimeProcessIdentity,
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

async function serverLifetimeProcessIdentity(pid) {
  try {
    process.kill(pid, 0);
    return `pid:${pid}`;
  } catch (error) {
    if (error?.code === "ESRCH") return null;
    if (error?.code === "EPERM") return `pid:${pid}`;
    throw error;
  }
}

function assertPhysicalDirectory(path, label) {
  if (!existsSync(path)) throw new Error(`${label} does not exist: ${path}`);
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a physical directory: ${path}`);
  }
}
