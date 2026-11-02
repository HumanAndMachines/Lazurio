// Synthetic fixture: a Knowledgebase-style App's runtime listener reader,
// written for this test (no customer code). It reads the App's listener and
// hosted application origin the way a static Astro or Vite App does under the
// Lazurio Module Standard: the lease from ../../../lazurio.module.json and the
// runtime declaration from ../package.json at import time, then host, port and
// external origin from the variables the Launchpad passes. The lease owns the
// listener: every host/port pair the Launchpad passes, the keyed and the
// generic one, must be complete and equal to the lease, or the reader refuses
// the environment. runtime-lib.test.mjs copies it into a temporary module tree
// for the App under test.
import { readFileSync } from "node:fs";

const loopbackHosts = new Set(["127.0.0.1", "localhost", "::1"]);
const dnsHostname = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export const EXTERNAL_ORIGIN_VARIABLE = "LAZURIO_RUNTIME_LISTENER_APP_EXTERNAL_ORIGIN";

const manifest = JSON.parse(
  readFileSync(new URL("../../../lazurio.module.json", import.meta.url), "utf8"),
);
const appPackage = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

function leaseOf(moduleManifest, runtime) {
  const leases = Array.isArray(moduleManifest?.port_leases) ? moduleManifest.port_leases : [];
  const wanted = runtime?.lease ?? leases[0]?.id;
  const lease = leases.find((entry) => entry?.id === wanted);
  if (!lease) throw new Error(`lazurio.module.json has no port lease ${wanted ?? "(none)"}`);
  return { host: lease.host, port: lease.port };
}

export const moduleListener = leaseOf(manifest, appPackage?.lazurio?.runtime);

function checkPair(host, rawPort, source) {
  if (host === undefined && rawPort === undefined) return;
  if (host === undefined || rawPort === undefined) {
    throw new Error(`${source} must give both a host and a port`);
  }
  const port = Number(rawPort);
  if (!loopbackHosts.has(host) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${source} must name a loopback host and a TCP port`);
  }
  if (host !== moduleListener.host || port !== moduleListener.port) {
    throw new Error(
      `${source} gives ${host}:${port}, but the module's lease is ${moduleListener.host}:${moduleListener.port}`,
    );
  }
}

export function resolveExternalOrigin(env = process.env) {
  const value = env[EXTERNAL_ORIGIN_VARIABLE];
  if (value === undefined || value === "") return null;
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.origin !== value ||
    url.username !== "" ||
    url.password !== "" ||
    !dnsHostname.test(url.hostname)
  ) {
    throw new Error(`${EXTERNAL_ORIGIN_VARIABLE} must be an exact https origin`);
  }
  return value;
}

export function resolveModuleListener(env = process.env) {
  checkPair(env.LAZURIO_RUNTIME_LISTENER_APP_HOST, env.LAZURIO_RUNTIME_LISTENER_APP_PORT, "LAZURIO_RUNTIME_LISTENER_APP_*");
  checkPair(env.LAZURIO_RUNTIME_HOST, env.LAZURIO_RUNTIME_PORT, "LAZURIO_RUNTIME_*");
  const externalOrigin = resolveExternalOrigin(env);
  return externalOrigin === null ? { ...moduleListener } : { ...moduleListener, externalOrigin };
}

function allowedHostsOf(listener) {
  return listener?.externalOrigin ? [new URL(listener.externalOrigin).hostname] : [];
}

export function withExternalOrigin(viteConfig = {}, listener) {
  const allowedHosts = allowedHostsOf(listener);
  return {
    ...viteConfig,
    server: { ...viteConfig.server, allowedHosts },
    preview: { ...viteConfig.preview, allowedHosts },
  };
}

export function withModuleListener(config = {}, env = process.env) {
  const listener = resolveModuleListener(env);
  const withOrigin = withExternalOrigin(config, listener);
  return {
    ...withOrigin,
    server: { ...withOrigin.server, host: listener.host, port: listener.port, strictPort: true },
    preview: { ...withOrigin.preview, host: listener.host, port: listener.port, strictPort: true },
  };
}
