import { describe, expect, test } from "bun:test";

import { createSessionAwareFetch } from "../public/session-aware-fetch.js";

describe("hosted session-aware fetch", () => {
  test("keeps ordinary API responses and forces manual redirect handling", async () => {
    const calls = [];
    const response = { ok: false, status: 401, type: "basic" };
    const fetchImpl = async (...args) => {
      calls.push(args);
      return response;
    };
    const recoveries = [];
    const request = createSessionAwareFetch({
      fetchImpl,
      recoverSession: () => recoveries.push("reload"),
    });

    expect(await request("/api/apps", { redirect: "follow", cache: "no-store" })).toBe(response);
    expect(calls).toEqual([["/api/apps", { redirect: "manual", cache: "no-store" }]]);
    expect(recoveries).toEqual([]);
  });

  test("turns an opaque API redirect into exactly one top-level session recovery", async () => {
    const recoveries = [];
    const request = createSessionAwareFetch({
      fetchImpl: async () => ({ type: "opaqueredirect" }),
      recoverSession: () => recoveries.push("reload"),
    });

    for (const path of ["/api/apps", "/api/personalspace"]) {
      await expect(request(path)).rejects.toMatchObject({
        code: "hosted_session_expired",
      });
    }
    expect(recoveries).toEqual(["reload"]);
  });

  test("does not misclassify a network failure as an expired session", async () => {
    const networkError = new TypeError("offline");
    const recoveries = [];
    const request = createSessionAwareFetch({
      fetchImpl: async () => {
        throw networkError;
      },
      recoverSession: () => recoveries.push("reload"),
    });

    await expect(request("/api/apps")).rejects.toBe(networkError);
    expect(recoveries).toEqual([]);
  });
});
