import {
  allowedHosts,
  type Listener,
  listener,
  ModuleKitError,
  onShutdown,
  withHealth,
} from "@lazurio/module-kit";
import { HEALTH_PATH, handle, hostAllowed } from "./app.ts";

const LISTENER = "{{listener_id}}";

// Host and port come only from the Launchpad listener (Lazurio Module Standard
// 4.2); without them the App does not start (exit 2).
let app: Listener;
try {
  app = listener(LISTENER);
} catch (error) {
  if (!(error instanceof ModuleKitError)) throw error;
  console.error(`Start through Lazurio lifecycle: ${error.message}`);
  process.exit(2);
}

const hosts = new Set(allowedHosts(LISTENER));
const routes = withHealth(handle, HEALTH_PATH);
const server = Bun.serve({
  hostname: app.host,
  port: app.port,
  fetch(request) {
    if (!hostAllowed(request, hosts)) return new Response("Forbidden host", { status: 403 });
    return routes(request);
  },
});

// SIGTERM from the Launchpad: close every connection and exit 0 (standard 4.4).
onShutdown(() => server.stop(true));
