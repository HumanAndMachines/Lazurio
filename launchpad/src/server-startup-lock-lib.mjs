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
  });
}

function assertPhysicalDirectory(path, label) {
  if (!existsSync(path)) throw new Error(`${label} does not exist: ${path}`);
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a physical directory: ${path}`);
  }
}
