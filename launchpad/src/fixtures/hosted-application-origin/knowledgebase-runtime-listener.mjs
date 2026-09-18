// Verbatim fixture copy of ConceptLineLazurio/knowledgebase
// app/v2/scripts/runtime-listener.mjs at main commit 7cee5ff (the deployed
// Knowledgebase reader of the hosted application origin). Not imported from
// this path: the reader loads ../../../lazurio.module.json and ../package.json
// at import time, so runtime-lib.test.mjs copies it into a temporary module
// tree with a manifest for the App under test. Keep byte-identical below this
// header; refresh from the consumer repository when it changes.
import { readFileSync } from "node:fs";
import { isIP } from "node:net";

const loopbackHosts = new Set(["127.0.0.1", "localhost", "::1"]);

export const EXTERNAL_ORIGIN_VARIABLE = "LAZURIO_RUNTIME_LISTENER_APP_EXTERNAL_ORIGIN";
const dnsHostnamePattern =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

export function resolvePortLease(manifest, leaseId) {
  const candidate = manifest.port_leases?.find((lease) => lease.id === leaseId);
  if (
    manifest.schema_version !== "lazurio.module.v1" ||
    typeof manifest.company !== "string" ||
    manifest.company.length === 0 ||
    typeof manifest.id !== "string" ||
    manifest.id.length === 0 ||
    typeof leaseId !== "string" ||
    leaseId.length === 0 ||
    !candidate ||
    !loopbackHosts.has(candidate.host) ||
    !Number.isInteger(candidate.port) ||
    candidate.port < 1024 ||
    candidate.port > 65535
  ) {
    throw new Error(`lazurio.module.json must declare a valid ${leaseId} listener lease.`);
  }
  return Object.freeze({ host: candidate.host, port: candidate.port });
}

export function resolveModuleLease(manifest, runtime) {
  if (
    typeof runtime.company !== "string" ||
    runtime.company.length === 0 ||
    typeof runtime.module !== "string" ||
    runtime.module.length === 0 ||
    manifest.company !== runtime.company ||
    manifest.id !== runtime.module
  ) {
    throw new Error("lazurio.module.json must match the app runtime.");
  }
  return resolvePortLease(manifest, "main");
}

const manifest = JSON.parse(
  readFileSync(new URL("../../../lazurio.module.json", import.meta.url), "utf8"),
);
const appPackage = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);

export const moduleListener = resolveModuleLease(
  manifest,
  appPackage.lazurio?.runtime ?? {},
);

function validatePair(host, rawPort, source) {
  if (host === undefined && rawPort === undefined) return;
  if (!host || !rawPort) {
    throw new Error(`${source} must provide both host and port.`);
  }
  if (host !== moduleListener.host || Number(rawPort) !== moduleListener.port) {
    throw new Error(
      `${source} listener ${host}:${rawPort} does not match the module-owned lease ${moduleListener.host}:${moduleListener.port}.`,
    );
  }
}

function isLoopbackHostname(hostname) {
  return (
    loopbackHosts.has(hostname) ||
    hostname.endsWith(".localhost") ||
    /^127(?:\.\d{1,3}){3}$/.test(hostname)
  );
}

// Hosted profile (decision 0146): the Launchpad hands the entrypoint listener
// its public origin, e.g. https://knowledgebase.<vm>.<organization>.lazurio.io.
// The local profile leaves the variable unset; the bind address never changes.
export function resolveExternalOrigin(env = process.env) {
  const rawValue = env[EXTERNAL_ORIGIN_VARIABLE];
  if (rawValue === undefined) return null;
  const candidate = String(rawValue).trim();
  let url;
  try {
    url = new URL(candidate);
  } catch {
    throw new Error(
      `${EXTERNAL_ORIGIN_VARIABLE} must be an absolute https origin such as https://knowledgebase.<vm>.<organization>.lazurio.io.`,
    );
  }
  if (
    url.protocol !== "https:" ||
    url.port !== "" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    (candidate !== url.origin && candidate !== `${url.origin}/`)
  ) {
    throw new Error(
      `${EXTERNAL_ORIGIN_VARIABLE} must be a clean https origin without port, credentials, path, query, fragment or uppercase host.`,
    );
  }
  if (
    isIP(url.hostname.replace(/^\[|\]$/g, "")) !== 0 ||
    !dnsHostnamePattern.test(url.hostname) ||
    isLoopbackHostname(url.hostname)
  ) {
    throw new Error(
      `${EXTERNAL_ORIGIN_VARIABLE} must use a public lowercase DNS hostname, not an IP literal or loopback host.`,
    );
  }
  return url.origin;
}

export function resolveModuleListener(env = process.env) {
  validatePair(
    env.LAZURIO_RUNTIME_HOST,
    env.LAZURIO_RUNTIME_PORT,
    "Lazurio runtime",
  );
  validatePair(
    env.LAZURIO_RUNTIME_LISTENER_APP_HOST,
    env.LAZURIO_RUNTIME_LISTENER_APP_PORT,
    "Lazurio app listener",
  );
  return Object.freeze({
    ...moduleListener,
    externalOrigin: resolveExternalOrigin(env),
  });
}

// Vite only answers requests whose Host header it trusts. Behind the hosted
// gateway that header is the external hostname, so it must be the sole
// allowed host; without an external origin the Vite config stays untouched.
export function withExternalOrigin(viteConfig = {}, listener) {
  if (!listener?.externalOrigin) return viteConfig;
  const allowedHosts = [new URL(listener.externalOrigin).hostname];
  return {
    ...viteConfig,
    server: { ...(viteConfig.server ?? {}), allowedHosts },
    preview: { ...(viteConfig.preview ?? {}), allowedHosts },
  };
}

export function withModuleListener(config = {}, env = process.env) {
  const listener = resolveModuleListener(env);
  return withExternalOrigin(
    {
      ...config,
      server: {
        ...(config.server ?? {}),
        host: listener.host,
        port: listener.port,
        strictPort: true,
      },
      preview: {
        ...(config.preview ?? {}),
        host: listener.host,
        port: listener.port,
        strictPort: true,
      },
    },
    listener,
  );
}
