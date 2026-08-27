import { lstatSync } from "node:fs";
import { resolve } from "node:path";

import { launchpadEntryHash } from "./runtime/deep-link-lib.mjs";
import { launchLazurioLaunchpadServer } from "./runtime/server-launcher-lib.mjs";

export const LAZURIO_LAUNCHPAD_RUNTIME_UNAVAILABLE = "LAZURIO_LAUNCHPAD_RUNTIME_UNAVAILABLE";

export class LaunchpadRuntimeUnavailableError extends Error {
  constructor(serverPath) {
    super(`${LAZURIO_LAUNCHPAD_RUNTIME_UNAVAILABLE}: Launchpad Server není součástí tohoto CLI code originu (${serverPath}).`);
    this.name = "LaunchpadRuntimeUnavailableError";
    this.code = LAZURIO_LAUNCHPAD_RUNTIME_UNAVAILABLE;
    this.serverPath = serverPath;
  }
}

export function buildLaunchpadServeInvocation({
  root,
  organization = null,
  personalspace = false,
  codeRoot = resolve(import.meta.dirname, ".."),
} = {}) {
  if (typeof root !== "string" || root === "") {
    throw new TypeError("Lazurio Launchpad serve requires a Root path.");
  }
  if (organization !== null && personalspace) {
    throw new TypeError("Launchpad serve accepts either Organization or Personalspace, not both.");
  }
  launchpadEntryHash({ organization, personalspace });
  const args = ["--reuse", "--root", root, "--agent-entry"];
  if (organization !== null) args.push("--organization", organization);
  if (personalspace) args.push("--personalspace");
  return {
    serverPath: resolve(codeRoot, "launchpad/src/server.mjs"),
    args,
    cwd: root,
  };
}

export async function runLaunchpadServe({
  root,
  organization = null,
  personalspace = false,
  codeRoot,
  launchServer = launchLazurioLaunchpadServer,
  inspectServerPath = isPhysicalServerFile,
} = {}) {
  const invocation = buildLaunchpadServeInvocation({
    root,
    organization,
    personalspace,
    codeRoot,
  });
  if (!inspectServerPath(invocation.serverPath)) {
    throw new LaunchpadRuntimeUnavailableError(invocation.serverPath);
  }
  return launchServer(invocation);
}

function isPhysicalServerFile(path) {
  try {
    const stat = lstatSync(path);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}
