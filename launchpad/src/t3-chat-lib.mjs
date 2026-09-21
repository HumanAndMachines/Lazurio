import { execFile } from "node:child_process";
import { isAbsolute } from "node:path";

// Chat opens the Machine's own T3 Code for a browser the gateway already
// admitted. Launchpad runs as the same Machine user as T3, so it mints a
// one-time pairing token locally and hands it over in the URL fragment.
// Whoever holds a shell on the Machine can mint the same token; this route
// only shortens the path for people who passed the gateway.

const pairingTtl = "60s";
const pairingLabel = "launchpad-chat";
const pairingTimeoutMs = 15_000;
const credentialPattern = /^[A-Za-z0-9_-]{8,128}$/;

export class T3ChatError extends Error {}

export function t3ChatConfigurationFromEnvironment(env = {}) {
  const rawUrl = String(env.LAZURIO_T3CODE_URL ?? "").trim();
  const rawCommand = String(env.LAZURIO_T3CODE_PAIRING_COMMAND ?? "").trim();
  if (!rawUrl && !rawCommand) return null;
  if (!rawUrl || !rawCommand) {
    throw new Error("LAZURIO_T3CODE_URL and LAZURIO_T3CODE_PAIRING_COMMAND must be set together.");
  }
  return { url: normalizeT3Url(rawUrl), command: normalizePairingCommand(rawCommand) };
}

function normalizeT3Url(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("LAZURIO_T3CODE_URL must be an absolute URL.");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash
    || !url.pathname.endsWith("/") || url.href !== value) {
    throw new Error("LAZURIO_T3CODE_URL must be a clean HTTPS URL ending with a slash.");
  }
  return url.href;
}

function normalizePairingCommand(value) {
  let command;
  try {
    command = JSON.parse(value);
  } catch {
    throw new Error("LAZURIO_T3CODE_PAIRING_COMMAND must be a JSON array.");
  }
  if (!Array.isArray(command) || command.length < 2
    || !command.every((part) => typeof part === "string" && part.length > 0 && !part.includes("\0"))
    || !isAbsolute(command[0]) || !isAbsolute(command[1])) {
    throw new Error("LAZURIO_T3CODE_PAIRING_COMMAND must start with an absolute program and script.");
  }
  return Object.freeze([...command]);
}

export function t3PairUrl(t3Url, credential) {
  const url = new URL("pair", t3Url);
  url.hash = new URLSearchParams([["token", credential]]).toString();
  return url.href;
}

function runCommand(program, args, { timeoutMs }) {
  return new Promise((resolve, reject) => {
    execFile(program, args, { timeout: timeoutMs, maxBuffer: 64 * 1024, env: process.env }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

export async function issueT3ChatUrl(configuration, { run = runCommand, timeoutMs = pairingTimeoutMs } = {}) {
  const [program, ...prefix] = configuration.command;
  let output;
  try {
    output = await run(program, [...prefix, "--ttl", pairingTtl, "--label", pairingLabel, "--json"], { timeoutMs });
  } catch {
    // The CLI output can hold the credential; never surface it.
    throw new T3ChatError("t3_pairing_failed");
  }
  let credential;
  try {
    credential = JSON.parse(String(output)).credential;
  } catch {
    throw new T3ChatError("t3_pairing_unreadable");
  }
  if (typeof credential !== "string" || !credentialPattern.test(credential)) {
    throw new T3ChatError("t3_pairing_unreadable");
  }
  return t3PairUrl(configuration.url, credential);
}
