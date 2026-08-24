import { existsSync, lstatSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import { serverLocatorPath } from "../../lazurio/core/server-locator-lib.mjs";
import { acquireModuleRuntimeLock } from "./module-runtime-lock-lib.mjs";

export async function acquireServerStartupLock({ workspaceRoot, instanceId }) {
  const localDirectory = dirname(serverLocatorPath(workspaceRoot));
  const launchpadDirectory = dirname(localDirectory);
  assertPhysicalDirectory(launchpadDirectory, "Launchpad directory");
  await mkdir(localDirectory, { recursive: true, mode: 0o700 });
  assertPhysicalDirectory(localDirectory, "Launchpad local directory");

  return acquireModuleRuntimeLock({
    root: localDirectory,
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
