import { buildLaunchpadAppsResponse } from "../../lazurio/runtime/diagnostics-lib.mjs";

// Lifecycle hint after Team authentication, never an access decision.
// Caddy retains Fetch Metadata and Sec-WebSocket-Key on its bodyless check;
// it removes Connection/Upgrade, so those cannot identify reconnects here.
export function hostedRequestMayStartApp(headers) {
  if (headers.has("sec-websocket-key")) return false;
  const mode = headers.get("sec-fetch-mode");
  return !mode || mode === "navigate";
}

// Fresh Team placement/manifest inventory, without probing every application.
// The caller still validates bindings and the selected module's runtime under
// its lease lock. No settled authorization or readiness snapshot is cached.
export async function readHostedWorkspaceInventory({
  companiesRoot, rootSourceRoot = companiesRoot, launchpadRoot, configuration,
}) {
  if (configuration?.profile !== "hosted") throw new Error("Hosted inventory requires a hosted Workspace.");
  return buildLaunchpadAppsResponse({
    companiesRoot, rootSourceRoot, launchpadRoot,
    organization: configuration.organization_slug,
    activeTeamId: configuration.team_id,
    includeGit: false,
    runtimeManager: { appsWithRuntime: async (apps) => apps },
  });
}
