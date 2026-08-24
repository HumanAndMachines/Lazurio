import { existsSync, lstatSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { acquireModuleRuntimeLock } from "./module-runtime-lock-lib.mjs";

export async function acquireServerStartupLock({ stateDirectory, instanceId }) {
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  assertPhysicalDirectory(stateDirectory, "Lazurio Server state directory");

  return acquireModuleRuntimeLock({
    root: stateDirectory,
    key: "server-startup",
    instanceId,
    // Startup holds this lock only across locator discovery, bind and atomic
    // publication. PID liveness is sufficient and deliberately fail-closed:
    // a reused live PID may delay stale recovery, but can never let a second
    // Server through. Unlike Module lifecycle ownership this needs no process
    // start-time proof and therefore no sandbox-sensitive ps/PowerShell spawn.
    resolveProcessIdentity: serverStartupProcessIdentity,
  });
}

async function serverStartupProcessIdentity(pid) {
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
