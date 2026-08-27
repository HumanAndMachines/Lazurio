import { resolve } from "node:path";

import { launchLazurioLaunchpadServer } from "../launchpad/src/server-launcher-lib.mjs";

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
} = {}) {
  const invocation = buildLaunchpadServeInvocation({
    root,
    organization,
    personalspace,
    codeRoot,
  });
  return launchServer(invocation);
}
