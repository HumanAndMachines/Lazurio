import { constants, openSync, fstatSync, readFileSync, closeSync } from "node:fs";
import { isAbsolute } from "node:path";
import { createHash } from "node:crypto";
import { createPersonalResourceVerifier, validatePersonalResourceProjection } from "./personal-resource-trust-lib.mjs";

export function loadPersonalEntryConfiguration(env = process.env) {
  const profile = env.LAZURIO_LAUNCHPAD_ENTRY_PROFILE;
  const projectionFile = env.LAZURIO_LAUNCHPAD_PERSONAL_PROJECTION_FILE;
  const secretFile = env.LAZURIO_LAUNCHPAD_PERSONAL_SECRET_FILE;
  if (!profile && !projectionFile && !secretFile) return null;
  if (process.platform === "win32") throw new Error("Hosted personal entry requires POSIX custody permissions.");
  if (profile !== "personal" || (env.LAZURIO_WORKSPACE_PROFILE && env.LAZURIO_WORKSPACE_PROFILE !== "local")) {
    throw new Error("Personal Launchpad entry requires its own profile, without an Organization Workspace profile.");
  }
  const projection = validatePersonalResourceProjection(JSON.parse(readPrivateFile(projectionFile, false)));
  const clientSecret = readPrivateFile(secretFile, true).replace(/\r?\n$/, "");
  return Object.freeze({ projection, clientSecret });
}

function readPrivateFile(path, secret) {
  if (typeof path !== "string" || !isAbsolute(path)) throw new Error("Personal entry configuration requires absolute custody paths.");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 16384 || (stat.mode & (secret ? 0o077 : 0o022))) {
      throw new Error("Personal entry custody file must be bounded and protected from other writers.");
    }
    return readFileSync(fd, "utf8");
  } finally { closeSync(fd); }
}

export function createPersonalEntryPolicy({ projection, clientSecret, authCheckUrl, cookieName, fetchImpl = globalThis.fetch, now = Date.now }) {
  const owner = createPersonalResourceVerifier({ projection, clientSecret, fetchImpl, now });
  const url = new URL(authCheckUrl);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || url.pathname !== "/oauth2/auth"
    || url.username || url.password || url.search || url.hash || url.href !== authCheckUrl) {
    throw new Error("Personal RP token endpoint must be an exact loopback HTTP /oauth2/auth URL.");
  }
  if (typeof cookieName !== "string" || !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]{1,256}$/.test(cookieName)) {
    throw new Error("Personal entry requires one exact RP cookie name.");
  }
  const denied = (reason) => Object.freeze({ trusted: false, reason });
  return Object.freeze({
    async evaluate(request, backendUrl) {
      if (!["127.0.0.1", "localhost"].includes(backendUrl.hostname)) return denied("personal_backend_not_loopback");
      const origin = request.headers.get("origin");
      const fetchSite = request.headers.get("sec-fetch-site");
      const safeRead = ["GET", "HEAD"].includes(request.method);
      if (!safeRead && (origin !== projection.externalOrigin || fetchSite !== "same-origin")) {
        return denied("personal_mutation_origin_rejected");
      }
      if (safeRead && (origin && origin !== projection.externalOrigin
        || fetchSite === "cross-site" && request.headers.get("sec-fetch-mode") !== "navigate")) {
        return denied("personal_read_origin_rejected");
      }
      const cookie = selectPersonalSessionCookies(request.headers.get("cookie"), cookieName);
      if (!cookie) return denied("personal_session_missing_or_invalid");
      try {
        const response = await fetchImpl(authCheckUrl, {
          method: "GET", redirect: "manual", headers: { cookie }, signal: AbortSignal.timeout(2000),
        });
        const accessToken = response.headers.get("x-auth-request-access-token");
        await response.body?.cancel();
        if (response.status < 200 || response.status >= 300) return denied("personal_rp_rejected");
        return await owner.verify(accessToken);
      } catch {
        return denied("personal_rp_unavailable");
      }
    },
  });
}

export function selectPersonalSessionCookies(header, name) {
  if (typeof header !== "string" || Buffer.byteLength(header) > 16384) return null;
  const selected = new Map();
  for (const pair of header.split(";")) {
    const split = pair.indexOf("=");
    if (split < 1) continue;
    const key = pair.slice(0, split).trim(), value = pair.slice(split + 1).trim();
    if (key !== name && !key.startsWith(`${name}_`)) continue;
    if (!value || /[\x00-\x20\x7f]/.test(value) || selected.has(key)) return null;
    selected.set(key, value);
  }
  if (selected.has(name)) return selected.size === 1 ? `${name}=${selected.get(name)}` : null;
  if (!selected.size || selected.size > 4) return null;
  const chunks = [];
  for (let i = 0; i < selected.size; i++) {
    const key = `${name}_${i}`;
    if (!selected.has(key)) return null;
    chunks.push(`${key}=${selected.get(key)}`);
  }
  return chunks.join("; ");
}

export function personalEntryConfigurationId(entry, env = process.env) {
  return createHash("sha256").update(JSON.stringify({
    projection: entry.projection,
    authCheckUrl: env.LAZURIO_LAUNCHPAD_AUTH_CHECK_URL,
    cookieName: env.LAZURIO_LAUNCHPAD_AUTH_COOKIE_NAME,
  })).digest("hex");
}
