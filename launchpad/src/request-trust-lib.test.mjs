import { expect, test } from "bun:test";
import { createRequestTrustPolicy } from "./request-trust-lib.mjs";

const backendUrl = new URL("http://127.0.0.1:4174/api/sync");

function request(headers = {}) {
  return new Request(backendUrl, { method: "POST", headers });
}

function readRequest(headers = {}) {
  return new Request(backendUrl, { method: "GET", headers });
}

test("local trust accepts loopback same-origin requests and rejects foreign origins", async () => {
  const trust = createRequestTrustPolicy();
  expect(await trust.evaluateWorkspaceRequest(request(), backendUrl)).toEqual({
    trusted: true,
    reason: "trusted_local",
  });
  expect(await trust.isTrustedWorkspaceRequest(request(), backendUrl)).toBe(true);
  expect(await trust.isTrustedWorkspaceRequest(request({
    origin: backendUrl.origin,
    "sec-fetch-site": "same-origin",
  }), backendUrl)).toBe(true);
  expect(await trust.isTrustedWorkspaceRequest(request({
    origin: "https://evil.invalid",
    "sec-fetch-site": "cross-site",
  }), backendUrl)).toBe(false);
  expect(await trust.evaluateWorkspaceRequest(request({
    origin: "https://evil.invalid",
    "sec-fetch-site": "cross-site",
  }), backendUrl)).toEqual({
    trusted: false,
    reason: "local_request_rejected",
  });
});

test("hosted trust revalidates only the exact Team-scoped signed OAuth session", async () => {
  const externalOrigin = "https://launchpad.management.iotorlazurio.lazurio.io";
  const authCheckUrl = "https://auth.management.iotorlazurio.lazurio.io/oauth2/auth";
  const authCookieName = "__Secure-lazurio-management-workspace";
  const authCalls = [];
  const trust = createRequestTrustPolicy({
    profile: "hosted",
    hostedExternalOrigin: externalOrigin,
    hostedAuthCheckUrl: authCheckUrl,
    hostedAuthCookieName: authCookieName,
    fetchImpl: async (url, init) => {
      authCalls.push({ url, init });
      if (init.headers.cookie !== `${authCookieName}=valid-session`) {
        return new Response(null, { status: 401 });
      }
      return new Response(null, {
        status: 202,
        // A generic OIDC consumer exposes opaque `sub` here. Launchpad does
        // not reinterpret it as a GitHub login or a second access decision.
        headers: { "x-auth-request-user": "issuer-subject:001" },
      });
    },
  });
  const headers = {
    cookie: `launchpad-theme=dark; ${authCookieName}=valid-session; analytics-id=private`,
    origin: externalOrigin,
    "sec-fetch-site": "same-origin",
    // A local process can forge this historical gateway header. Its malformed
    // value must be ignored when the exact Team-scoped session is valid.
    "x-lazurio-github-login": "not/a-github-login",
  };

  expect(await trust.isTrustedWorkspaceRequest(request(headers), backendUrl)).toBe(true);
  expect(authCalls).toHaveLength(1);
  expect(await trust.evaluateWorkspaceRequest(request(headers), backendUrl)).toEqual({
    trusted: true,
    reason: "trusted_hosted",
  });
  expect(authCalls).toHaveLength(2);
  expect(authCalls[0].url).toBe(authCheckUrl);
  expect(authCalls[0].init.redirect).toBe("manual");
  expect(authCalls[0].init.headers.cookie).toBe(`${authCookieName}=valid-session`);

  expect(await trust.evaluateWorkspaceRequest(readRequest({
    cookie: `${authCookieName}=valid-session`,
    "sec-fetch-site": "same-origin",
  }), backendUrl)).toEqual({
    trusted: true,
    reason: "trusted_hosted",
  });
  expect(await trust.isTrustedWorkspaceRequest(readRequest({
    ...headers,
    origin: "https://evil.invalid",
  }), backendUrl)).toBe(false);
  expect(await trust.isTrustedWorkspaceRequest(readRequest({
    cookie: `${authCookieName}=valid-session`,
    "sec-fetch-site": "cross-site",
    "sec-fetch-mode": "cors",
  }), backendUrl)).toBe(false);

  expect(await trust.isTrustedWorkspaceRequest(request(), backendUrl)).toBe(false);
  expect(await trust.isTrustedWorkspaceRequest(request({
    origin: backendUrl.origin,
    "sec-fetch-site": "same-origin",
  }), backendUrl)).toBe(false);
  expect(await trust.isTrustedWorkspaceRequest(request({ ...headers, origin: "https://evil.invalid" }), backendUrl)).toBe(false);
  expect(await trust.isTrustedWorkspaceRequest(request({ ...headers, "sec-fetch-site": "cross-site" }), backendUrl)).toBe(false);
  expect(await trust.isTrustedWorkspaceRequest(request({ ...headers, cookie: "" }), backendUrl)).toBe(false);
  expect(await trust.isTrustedWorkspaceRequest(request({
    ...headers,
    cookie: `${authCookieName}=`,
  }), backendUrl)).toBe(false);
  expect(await trust.isTrustedWorkspaceRequest(request({
    ...headers,
    cookie: `${authCookieName}-lookalike=valid-session`,
  }), backendUrl)).toBe(false);
  expect(await trust.isTrustedWorkspaceRequest(request({
    ...headers,
    cookie: `${authCookieName}=valid-session; ${authCookieName}=duplicate`,
  }), backendUrl)).toBe(false);
  expect(await trust.isTrustedWorkspaceRequest(request({
    ...headers,
    cookie: `${authCookieName}=forged`,
  }), backendUrl)).toBe(false);
  expect(await trust.evaluateWorkspaceRequest(request({
    ...headers,
    cookie: `${authCookieName}=forged`,
  }), backendUrl)).toEqual({
    trusted: false,
    reason: "hosted_auth_rejected",
  });
  expect(await trust.evaluateWorkspaceRequest(request({
    ...headers,
    cookie: `unrelated=value`,
  }), backendUrl)).toEqual({
    trusted: false,
    reason: "hosted_auth_cookie_missing",
  });
});

test("hosted trust configuration fails closed", () => {
  expect(() => createRequestTrustPolicy({ profile: "hosted" })).toThrow("required");
  expect(() => createRequestTrustPolicy({
    profile: "hosted",
    hostedExternalOrigin: "http://launchpad.example.test",
    hostedAuthCheckUrl: "https://auth.example.test/oauth2/auth",
  })).toThrow("clean HTTPS origin");
  expect(() => createRequestTrustPolicy({
    profile: "hosted",
    hostedExternalOrigin: "https://127.0.0.1:4174",
    hostedAuthCheckUrl: "https://auth.example.test/oauth2/auth",
  })).toThrow("loopback");
  expect(() => createRequestTrustPolicy({
    profile: "hosted",
    hostedExternalOrigin: "https://launchpad.example.test",
  })).toThrow("AUTH_CHECK_URL is required");
  expect(() => createRequestTrustPolicy({
    profile: "hosted",
    hostedExternalOrigin: "https://launchpad.example.test",
    hostedAuthCheckUrl: "http://127.0.0.1:4180/oauth2/auth",
  })).toThrow("clean HTTPS");
  expect(() => createRequestTrustPolicy({
    profile: "hosted",
    hostedExternalOrigin: "https://launchpad.example.test",
    hostedAuthCheckUrl: "https://launchpad.example.test/launchpad/api/auth",
  })).toThrow("clean HTTPS");
  expect(() => createRequestTrustPolicy({
    profile: "hosted",
    hostedExternalOrigin: "https://launchpad.example.test",
    hostedAuthCheckUrl: "https://auth.example.test/oauth2/auth",
  })).toThrow("AUTH_COOKIE_NAME is required");
  expect(() => createRequestTrustPolicy({
    profile: "hosted",
    hostedExternalOrigin: "https://launchpad.example.test",
    hostedAuthCheckUrl: "https://auth.example.test/oauth2/auth",
    hostedAuthCookieName: "invalid cookie name",
  })).toThrow("one exact HTTP cookie name");
  expect(() => createRequestTrustPolicy({
    profile: "local",
    hostedExternalOrigin: "https://launchpad.example.test",
  })).toThrow("only in the hosted");
  expect(() => createRequestTrustPolicy({
    profile: "local",
    hostedAuthCheckUrl: "https://auth.example.test/oauth2/auth",
  })).toThrow("only in the hosted");
  expect(() => createRequestTrustPolicy({
    profile: "local",
    hostedAuthCookieName: "__Secure-lazurio-example-workspace",
  })).toThrow("only in the hosted");
});


test("native shared-origin workspace still revalidates its exact session", async () => {
  const origin = "https://builder.exampleco.lazurio.io";
  const cookie = "__Host-lazurio-workspace";
  const calls = [];
  const trust = createRequestTrustPolicy({
    profile: "hosted", hostedExternalOrigin: origin,
    hostedAuthCheckUrl: `${origin}/oauth2/auth`, hostedAuthCookieName: cookie,
    fetchImpl: async (url, init) => {
      calls.push({url, init});
      return new Response(null, {status: init.headers.cookie === `${cookie}=valid` ? 202 : 401});
    },
  });
  const headers = {origin, "sec-fetch-site": "same-origin", cookie: `${cookie}=valid; unrelated=excluded`};
  expect(await trust.isTrustedWorkspaceRequest(request(headers), backendUrl)).toBe(true);
  expect(calls[0].url).toBe(`${origin}/oauth2/auth`);
  expect(calls[0].init.headers.cookie).toBe(`${cookie}=valid`);
  expect(calls[0].init.redirect).toBe("manual");
  expect(await trust.isTrustedWorkspaceRequest(request({...headers, cookie: `${cookie}=invalid`}), backendUrl)).toBe(false);
  expect(await trust.isTrustedWorkspaceRequest(request({...headers, cookie: ""}), backendUrl)).toBe(false);
  expect(await trust.isTrustedWorkspaceRequest(request({...headers, origin: "https://foreign.invalid"}), backendUrl)).toBe(false);
});
