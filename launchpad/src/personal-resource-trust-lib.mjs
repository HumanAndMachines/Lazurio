// Resource authentication only: the stock RP still owns login and sessions.
// The server calls this with the RP's server-held access token, never an
// identity header, an ID token, or a browser-supplied introspection reply.
const claim = "https://lazurio.ai/github-id";
const projectionKeys = ["schema_version", "projectionVersion", "issuer", "clientId", "resource", "externalOrigin", "redirectUri", "ownerGithubId"];
const maxResponseBytes = 16 * 1024;

export function validatePersonalResourceProjection(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).sort().join("\0") !== [...projectionKeys].sort().join("\0")
    || value.schema_version !== "auth.personal-vm-consumer.v1"
    || !/^personal-v1-[a-f0-9]{64}$/.test(value.projectionVersion ?? "")
    || !/^personal-[a-z0-9][a-z0-9-]{0,80}$/.test(value.clientId ?? "")
    || typeof value.ownerGithubId !== "string" || !/^[1-9][0-9]{0,15}$/.test(value.ownerGithubId)
    || BigInt(value.ownerGithubId) > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("Invalid personal resource projection.");
  }
  const external = httpsUrl(value.externalOrigin);
  const issuer = httpsUrl(value.issuer);
  if (external.origin !== value.externalOrigin
    || issuer.href !== value.issuer || issuer.pathname.endsWith("/")
    || !/^\/realms\/[A-Za-z0-9_-]+$/.test(issuer.pathname)
    || value.resource !== `${external.origin}/`
    || value.redirectUri !== `${external.origin}/oauth2/callback`) {
    throw new Error("Personal resource projection has inconsistent endpoints.");
  }
  return Object.freeze({ ...value });
}

function httpsUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error("Personal entry requires an exact HTTPS URL."); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error("Personal entry requires an exact HTTPS URL.");
  }
  return url;
}

export function createPersonalResourceVerifier({ projection, clientSecret, fetchImpl = globalThis.fetch, now = Date.now }) {
  const config = validatePersonalResourceProjection(projection);
  if (typeof clientSecret !== "string" || clientSecret.length < 16 || clientSecret.length > 4096
    || /[\x00-\x20\x7f]/.test(clientSecret) || typeof fetchImpl !== "function" || typeof now !== "function") {
    throw new Error("Personal resource introspection requires server credentials.");
  }
  // RFC 6749 client_secret_basic form-encodes each component before Base64.
  const form = (value) => new URLSearchParams({ v: value }).toString().slice(2);
  const credential = Buffer.from(`${form(config.resource)}:${form(clientSecret)}`).toString("base64");
  const endpoint = `${config.issuer}/protocol/openid-connect/token/introspect`;
  const denied = (reason) => Object.freeze({ trusted: false, reason });

  return Object.freeze({
    async verify(accessToken) {
      if (typeof accessToken !== "string" || accessToken.length < 1 || accessToken.length > 16 * 1024
        || /[\x00-\x20\x7f]/.test(accessToken)) return denied("personal_token_missing_or_invalid");
      try {
        const response = await fetchImpl(endpoint, {
          method: "POST", redirect: "manual", signal: AbortSignal.timeout(2000),
          headers: { authorization: `Basic ${credential}`, "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
          body: new URLSearchParams({ token: accessToken, token_type_hint: "access_token" }),
        });
        if (response.status !== 200 || !/^application\/json(?:\s*;|$)/i.test(response.headers.get("content-type") ?? "")) {
          await response.body?.cancel();
          return denied("personal_introspection_rejected");
        }
        const proof = await boundedJson(response);
        const time = Math.floor(now() / 1000);
        const audiences = typeof proof?.aud === "string" ? [proof.aud] : proof?.aud;
        if (!proof || proof.active !== true || proof.iss !== config.issuer
          || !Array.isArray(audiences) || audiences.length !== 1 || audiences[0] !== config.resource
          || proof.client_id !== config.clientId || (proof.azp !== undefined && proof.azp !== config.clientId)
          || typeof proof.sub !== "string" || !proof.sub || proof.sub.length > 255
          || !Number.isSafeInteger(proof.iat) || !Number.isSafeInteger(proof.exp)
          || proof.iat < 0 || proof.iat > time + 30 || proof.exp <= time
          || proof.exp <= proof.iat || proof.exp - proof.iat > 300
          || proof[claim] !== config.ownerGithubId) return denied("personal_owner_or_token_rejected");
        // No token, secret or provider payload is returned to a route handler.
        return Object.freeze({ trusted: true, reason: "trusted_personal_owner" });
      } catch {
        return denied("personal_introspection_unavailable");
      }
    },
  });
}

async function boundedJson(response) {
  if (Number(response.headers.get("content-length")) > maxResponseBytes) {
    await response.body?.cancel(); throw new Error("Oversized introspection response");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Missing introspection response");
  let size = 0;
  const chunks = [];
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.length;
      if (size > maxResponseBytes) throw new Error("Oversized introspection response");
      chunks.push(next.value);
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
