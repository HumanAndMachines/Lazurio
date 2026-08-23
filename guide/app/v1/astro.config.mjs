import { readFileSync } from "node:fs";
import { defineConfig } from "astro/config";
import node from "@astrojs/node";
import tailwindcss from "@tailwindcss/vite";

const moduleManifest = JSON.parse(
  readFileSync(new URL("../../lazurio.module.json", import.meta.url), "utf8"),
);
const mainLease = moduleManifest.port_leases?.find((lease) => lease.id === "main");
if (
  !mainLease ||
  typeof mainLease.host !== "string" ||
  !Number.isInteger(mainLease.port)
) {
  throw new Error("guide/lazurio.module.json must declare a valid main lease");
}

function validateInjectedListener(prefix) {
  const host = process.env[`${prefix}_HOST`];
  const port = process.env[`${prefix}_PORT`];
  if (host === undefined && port === undefined) return;
  if (host === undefined || port === undefined) {
    throw new Error(`${prefix}_HOST and ${prefix}_PORT must be supplied together`);
  }
  if (host !== mainLease.host || Number(port) !== mainLease.port) {
    throw new Error(`${prefix} listener must exactly match guide/lazurio.module.json`);
  }
}

validateInjectedListener("LAZURIO_RUNTIME");
validateInjectedListener("LAZURIO_RUNTIME_LISTENER_WEB");

// Interaktivní průvodce Lazuriem. SSR mód zachovává
// GEN2 guide pattern; content je obecný root-level onboarding. Runtime scripts
// načte tracked lease i při přímém startu a případnou Launchpad injekci přijme
// jen tehdy, když přesně odpovídá témuž manifestu.
export default defineConfig({
  output: "server",
  adapter: node({ mode: "standalone" }),
  server: {
    host: mainLease.host,
    port: mainLease.port,
  },
  vite: {
    plugins: [tailwindcss()],
    server: {
      host: mainLease.host,
      port: mainLease.port,
      strictPort: true,
      fs: {
        // Sourozenecký ../content/ a root-level manuály vyžadují přístup mimo app/.
        allow: [".."],
      },
      watch: {
        ignored: ["!../content/**"],
      },
    },
    preview: {
      host: mainLease.host,
      port: mainLease.port,
      strictPort: true,
    },
  },
});
