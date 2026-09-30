import { ModuleKitError, viteServerOptions, viteShutdownPlugin } from "@lazurio/module-kit";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const LISTENER = "{{listener_id}}";

// Host and port come only from the Launchpad listener (Lazurio Module Standard
// 4.2). `vite build` has no listener, so it is read only when serving; without
// the listener environment the App does not start (exit 2).
function listenerServer(): ReturnType<typeof viteServerOptions> {
  try {
    return viteServerOptions(LISTENER);
  } catch (error) {
    if (!(error instanceof ModuleKitError)) throw error;
    console.error(`Start through Lazurio lifecycle: ${error.message}`);
    process.exit(2);
  }
}

export default defineConfig(({ command }) => {
  const server = command === "serve" ? listenerServer() : null;
  // Vite's own SIGTERM handler exits with 128 + signal once close() settles,
  // before viteShutdownPlugin exits 0; a requested stop is a clean exit
  // (standard 4.4). Remove once module-kit sets it (Lazurio/module-kit#2).
  if (server)
    process.once("SIGTERM", () => {
      process.exitCode = 0;
    });
  return {
    plugins: [react(), viteShutdownPlugin()],
    // No .env* files on the start path (standard 4.3).
    envDir: false,
    ...(server ? { server, preview: server } : {}),
  };
});
