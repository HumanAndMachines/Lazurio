import { test, expect } from "bun:test";
import { createPersonalResourceVerifier, validatePersonalResourceProjection } from "./personal-resource-trust-lib.mjs";

const projection = {
  schema_version: "auth.personal-vm-consumer.v1", projectionVersion: `personal-v1-${"a".repeat(64)}`,
  issuer: "https://issuer.example.invalid/realms/workspace", clientId: "personal-fixture",
  externalOrigin: "https://personal.example.invalid", resource: "https://personal.example.invalid/",
  redirectUri: "https://personal.example.invalid/oauth2/callback", ownerGithubId: "1001",
};
const proof = {
  active: true, iss: projection.issuer, aud: projection.resource, client_id: projection.clientId,
  sub: "native-subject", iat: 1000, exp: 1300, "https://lazurio.ai/github-id": "1001",
};
const secret = "synthetic-introspection-secret";
const verifier = (fetchImpl) => createPersonalResourceVerifier({ projection, clientSecret: secret, now: () => 1100000, fetchImpl });

test("authenticates each introspection to the exact resource without retaining an earlier allow", async () => {
  let calls = 0;
  const auth = verifier(async (url, options) => {
    expect(url).toBe(`${projection.issuer}/protocol/openid-connect/token/introspect`);
    expect(options.redirect).toBe("manual");
    const basic = Buffer.from(options.headers.authorization.slice(6), "base64").toString();
    expect(basic).toBe(`https%3A%2F%2Fpersonal.example.invalid%2F:${secret}`);
    expect(options.body.get("token")).toBe("synthetic-token");
    calls++;
    return Response.json(calls === 1 ? proof : { ...proof, "https://lazurio.ai/github-id": "1002" });
  });
  expect(await auth.verify("synthetic-token")).toEqual({ trusted: true, reason: "trusted_personal_owner" });
  expect((await auth.verify("synthetic-token")).trusted).toBe(false);
  expect(calls).toBe(2);
});

test("denies foreign, missing, expired and privilege-shaped assertions", async () => {
  for (const change of [
    { active: false }, { active: "true" }, { iss: "https://foreign.example.invalid" },
    { aud: [projection.resource, "https://foreign.example.invalid/"] }, { aud: [] },
    { aud: "https://foreign.example.invalid/" }, { client_id: "foreign" }, { azp: "foreign" },
    { sub: "" }, { sub: 123 }, { exp: 1100 }, { exp: 1700 }, { iat: 1140 }, { iat: -1 },
    { exp: "1300" }, { "https://lazurio.ai/github-id": 1001 },
    { "https://lazurio.ai/github-id": undefined, groups: ["admin"], roles: ["owner"] },
    { "https://lazurio.ai/github-id": "1002", groups: ["admin"], roles: ["owner"] },
  ]) {
    expect((await verifier(async () => Response.json({ ...proof, ...change })).verify("synthetic-token")).trusted).toBe(false);
  }
  expect((await verifier(async () => Response.json({ ...proof, aud: [projection.resource] })).verify("synthetic-token")).trusted).toBe(true);
});

test("provider failure, redirect, malformed and oversized replies fail closed", async () => {
  for (const response of [
    () => new Response(null, { status: 302, headers: { location: "https://foreign.example.invalid" } }),
    () => new Response(null, { status: 503 }),
    () => new Response(JSON.stringify(proof), { headers: { "content-type": "text/html" } }),
    () => new Response("{", { headers: { "content-type": "application/json" } }),
    () => Response.json(null),
    () => new Response(" ".repeat(17000), { headers: { "content-type": "application/json" } }),
    () => { throw new Error("fixture provider outage"); },
  ]) expect((await verifier(async () => response()).verify("synthetic-token")).trusted).toBe(false);
});

test("invalid input cannot send a credential or token to another endpoint", async () => {
  let calls = 0;
  const auth = verifier(async () => { calls++; return Response.json(proof); });
  for (const token of [null, "", "has newline\n", "x".repeat(17000)]) expect((await auth.verify(token)).trusted).toBe(false);
  expect(calls).toBe(0);
  for (const changed of [
    { ownerGithubId: "01001" }, { ownerGithubId: "9007199254740992" }, { ownerGithubId: 1001 },
    { organizationId: 123 }, { issuer: "http://issuer.example.invalid/realms/workspace" },
    { issuer: "https://issuer.example.invalid/realms/workspace?redirect=foreign" },
    { externalOrigin: "https://personal.example.invalid/path" }, { resource: "https://foreign.example.invalid/" },
    { redirectUri: "https://foreign.example.invalid/oauth2/callback" },
  ]) expect(() => validatePersonalResourceProjection({ ...projection, ...changed })).toThrow();
});
