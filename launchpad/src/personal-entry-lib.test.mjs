import { test, expect } from "bun:test";
import { createPersonalEntryPolicy, selectPersonalSessionCookies } from "./personal-entry-lib.mjs";

const projection = {
  schema_version: "auth.personal-vm-consumer.v1", projectionVersion: `personal-v1-${"a".repeat(64)}`,
  issuer: "https://issuer.example.invalid/realms/workspace", clientId: "personal-fixture",
  externalOrigin: "https://personal.example.invalid", resource: "https://personal.example.invalid/",
  redirectUri: "https://personal.example.invalid/oauth2/callback", ownerGithubId: "1001",
};
const rp = "http://127.0.0.1:4180/oauth2/auth";
const backend = new URL("http://127.0.0.1:4174/api/personalspace");
const config = { projection, clientSecret: "synthetic-introspection-secret", authCheckUrl: rp, cookieName: "__Host-personal", now: () => 1100000 };
const response = () => Response.json({ active: true, iss: projection.issuer, aud: projection.resource,
  client_id: projection.clientId, sub: "subject", iat: 1000, exp: 1300, "https://lazurio.ai/github-id": "1001" });

test("uses only RP response token and owner proof, not client identity headers", async () => {
  const calls = [];
  const policy = createPersonalEntryPolicy({ ...config, fetchImpl: async (url, options) => {
    calls.push(url);
    if (url === rp) {
      expect(options.headers).toEqual({ cookie: "__Host-personal=session" });
      return new Response(null, { status: 202, headers: { "x-auth-request-access-token": "server-token" } });
    }
    expect(options.body.get("token")).toBe("server-token");
    return response();
  } });
  const request = new Request(backend, { headers: { cookie: "unrelated=ignored; __Host-personal=session",
    "x-auth-request-access-token": "browser-forgery", "x-auth-request-user": "admin" } });
  expect((await policy.evaluate(request, backend)).trusted).toBe(true);
  expect(calls).toHaveLength(2);
});

test("mutations keep exact origin and Fetch Metadata while owner navigation can return from login", async () => {
  let calls = 0;
  const policy = createPersonalEntryPolicy({ ...config, fetchImpl: async (url) => {
    calls++;
    return url === rp ? new Response(null, { status: 202, headers: { "x-auth-request-access-token": "server-token" } }) : response();
  } });
  for (const headers of [{}, { origin: projection.externalOrigin }, { origin: "https://foreign.invalid", "sec-fetch-site": "same-origin" }]) {
    expect((await policy.evaluate(new Request(backend, { method: "POST", headers: { ...headers, cookie: "__Host-personal=session" } }), backend)).trusted).toBe(false);
  }
  expect(calls).toBe(0);
  expect((await policy.evaluate(new Request(backend, { method: "POST", headers: {
    origin: projection.externalOrigin, "sec-fetch-site": "same-origin", cookie: "__Host-personal=session",
  } }), backend)).trusted).toBe(true);
  expect((await policy.evaluate(new Request(backend, { headers: {
    "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate", cookie: "__Host-personal=session",
  } }), backend)).trusted).toBe(true);
  expect((await policy.evaluate(new Request(backend, { headers: {
    "sec-fetch-site": "cross-site", "sec-fetch-mode": "cors", cookie: "__Host-personal=session",
  } }), backend)).trusted).toBe(false);
});

test("rejects missing, duplicate, mixed or noncontiguous RP cookies and preserves valid chunks", () => {
  for (const header of [null, "", "__Host-personal=", "__Host-personal=a; __Host-personal=b",
    "__Host-personal=a; __Host-personal_0=b", "__Host-personal_1=b", "__Host-personal_0=a; __Host-personal_2=c",
    "__Host-personal_extra=x", "__Host-personal=a b", "x".repeat(17000)]) {
    expect(selectPersonalSessionCookies(header, "__Host-personal")).toBeNull();
  }
  expect(selectPersonalSessionCookies("other=x; __Host-personal_1=b; __Host-personal_0=a", "__Host-personal"))
    .toBe("__Host-personal_0=a; __Host-personal_1=b");
});

test("cannot expose token-emitting auth endpoint off loopback or accept failed RP as owner", async () => {
  for (const authCheckUrl of ["https://personal.example.invalid/oauth2/auth", "http://localhost:4180/oauth2/auth",
    "http://127.0.0.1:4180/oauth2/auth?forward=yes", "http://127.0.0.1:4180/not-auth"]) {
    expect(() => createPersonalEntryPolicy({ ...config, authCheckUrl })).toThrow();
  }
  for (const rpResponse of [new Response(null, { status: 401 }), new Response(null, { status: 202 })]) {
    const policy = createPersonalEntryPolicy({ ...config, fetchImpl: async () => rpResponse });
    expect((await policy.evaluate(new Request(backend, { headers: { cookie: "__Host-personal=session" } }), backend)).trusted).toBe(false);
  }
});
