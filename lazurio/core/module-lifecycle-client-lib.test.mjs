import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { validateAgainstSchema } from "../runtime/json-schema-mini.mjs";

import {
  MODULE_LIFECYCLE_REPORT_SCHEMA,
  moduleLifecycleExitCode,
  parseModuleSelector,
  runModuleLifecycle,
} from "./module-lifecycle-client-lib.mjs";

const origin = "http://127.0.0.1:4174";
const reportSchema = await Bun.file(join(import.meta.dirname, "..", "module-lifecycle-report.v1.schema.json")).json();
const identity = Object.freeze({
  schema_version: "lazurio.server.identity.v1",
  product: "lazurio-launchpad-server",
  root_id: "1".repeat(64),
  control_root_id: "2".repeat(64),
  install_generation: "3".repeat(64),
  instance_id: "11111111-1111-4111-8111-111111111111",
  pid: 1234,
  started_at: "2026-08-26T08:00:00.000Z",
  request_trust_profile: "local",
});
const locator = Object.freeze({
  schema_version: "lazurio.server.locator.v1",
  origin,
  root_id: identity.root_id,
  control_root_id: identity.control_root_id,
  install_generation: identity.install_generation,
  instance_id: identity.instance_id,
  written_at: "2026-08-26T08:00:01.000Z",
});

describe("Core-owned Module lifecycle client", () => {
  test("one status snapshot exposes only explicit Module Apps without guessing a default", async () => {
    const requests = [];
    const report = await runModuleLifecycle({
      action: "status",
      readLocator: async () => locator,
      fetchFn: fixtureFetch({ requests }),
    });

    expect(report.schema_version).toBe(MODULE_LIFECYCLE_REPORT_SCHEMA);
    expect(validateAgainstSchema(report, reportSchema, "report")).toEqual([]);
    expect(report.status).toBe("current");
    expect(report.apps.map((app) => app.app_id)).toEqual([
      "example-organization-website-v2",
      "example-organization-website-v3",
    ]);
    expect(report.apps.find((app) => app.app_id === "example-organization-website-v2")?.port).toBe(24711);
    expect(requests.map((request) => request.pathname)).toEqual([
      "/api/lazurio/server-identity",
      "/api/apps",
    ]);
    expect(moduleLifecycleExitCode(report)).toBe(0);
  });

  test("selected status uses only the Core-projected default App", async () => {
    const report = await runModuleLifecycle({
      action: "status",
      selector: "ExampleOrganization/website",
      readLocator: async () => locator,
      fetchFn: fixtureFetch(),
    });

    expect(report.status).toBe("current");
    expect(report.app.app_id).toBe("example-organization-website-v2");
    expect(report.app.default).toBe(true);
  });

  test("missing or ambiguous default fails closed instead of selecting by order", async () => {
    const report = await runModuleLifecycle({
      action: "status",
      selector: "ExampleOrganization/website",
      readLocator: async () => locator,
      fetchFn: fixtureFetch({ defaultAppIds: [] }),
    });

    expect(report.status).toBe("action_required");
    expect(validateAgainstSchema(report, reportSchema, "report")).toEqual([]);
    expect(report.reason).toBe("module_default_app_unavailable");
    expect(report.apps).toHaveLength(2);
    expect(moduleLifecycleExitCode(report)).toBe(3);
  });

  test("explicit package selects the exact App and proxies one action", async () => {
    const requests = [];
    const report = await runModuleLifecycle({
      action: "open",
      selector: "ExampleOrganization/website",
      appPackage: "app/v3/package.json",
      readLocator: async () => locator,
      fetchFn: fixtureFetch({ requests }),
    });

    expect(report.status).toBe("completed");
    expect(validateAgainstSchema(report, reportSchema, "report")).toEqual([]);
    expect(report.app.app_id).toBe("example-organization-website-v3");
    expect(report.result).toEqual({ action: "open", url: "http://127.0.0.1:24711" });
    expect(requests.at(-1)).toEqual({
      pathname: "/api/apps/example-organization-website-v3/open",
      method: "POST",
      body: {},
    });
  });

  test("cross-Organization takeover stays blocked without exact confirmation", async () => {
    const requests = [];
    const report = await runModuleLifecycle({
      action: "open",
      selector: "ExampleOrganization/website",
      readLocator: async () => locator,
      fetchFn: fixtureFetch({ requests, takeoverRequired: true }),
    });

    expect(report.status).toBe("action_required");
    expect(validateAgainstSchema(report, reportSchema, "report")).toEqual([]);
    expect(report.reason).toBe("cross_organization_takeover_confirmation_required");
    expect(report.result.replace_app_id).toBe("other-organization-portal-v1");
    expect(requests.at(-1).body).toEqual({});
    expect(moduleLifecycleExitCode(report)).toBe(3);
  });

  test("exact confirmation is forwarded without inventing replacement identity", async () => {
    const requests = [];
    const report = await runModuleLifecycle({
      action: "start",
      selector: "ExampleOrganization/website",
      confirmReplaceAppId: "other-organization-portal-v1",
      readLocator: async () => locator,
      fetchFn: fixtureFetch({ requests, takeoverRequired: true }),
    });

    expect(report.status).toBe("completed");
    expect(validateAgainstSchema(report, reportSchema, "report")).toEqual([]);
    expect(requests.at(-1).body).toEqual({
      confirmed: true,
      replace_app_id: "other-organization-portal-v1",
    });
  });

  test("missing Server and mismatched identity are distinct fail-closed states", async () => {
    const missing = await runModuleLifecycle({
      action: "status",
      readLocator: async () => null,
      fetchFn: () => {
        throw new Error("must not fetch");
      },
    });
    expect(missing.reason).toBe("server_unavailable");
    expect(validateAgainstSchema(missing, reportSchema, "report")).toEqual([]);
    expect(missing.server.state).toBe("unavailable");

    const mismatch = await runModuleLifecycle({
      action: "status",
      readLocator: async () => locator,
      fetchFn: fixtureFetch({ identityOverride: { ...identity, instance_id: "22222222-2222-4222-8222-222222222222" } }),
    });
    expect(mismatch.reason).toBe("server_identity_mismatch");
    expect(validateAgainstSchema(mismatch, reportSchema, "report")).toEqual([]);
    expect(mismatch.server.state).toBe("unavailable");
  });

  test("hosted lifecycle stays on its authenticated surface instead of forging browser trust", async () => {
    const requests = [];
    const report = await runModuleLifecycle({
      action: "open",
      selector: "ExampleOrganization/website",
      readLocator: async () => locator,
      fetchFn: fixtureFetch({
        requests,
        identityOverride: { ...identity, request_trust_profile: "hosted" },
      }),
    });

    expect(report.status).toBe("action_required");
    expect(report.reason).toBe("hosted_lifecycle_requires_authenticated_surface");
    expect(report.server.request_trust_profile).toBe("hosted");
    expect(validateAgainstSchema(report, reportSchema, "report")).toEqual([]);
    expect(requests.map((request) => request.pathname)).toEqual([
      "/api/lazurio/server-identity",
    ]);
  });

  test("legacy identity defers mutation trust to the authoritative Server", async () => {
    const requests = [];
    const { request_trust_profile: _omitted, ...legacyIdentity } = identity;
    const report = await runModuleLifecycle({
      action: "open",
      selector: "ExampleOrganization/website",
      readLocator: async () => locator,
      fetchFn: fixtureFetch({ requests, identityOverride: legacyIdentity }),
    });

    expect(report.status).toBe("completed");
    expect(report.server.request_trust_profile).toBe("unknown");
    expect(validateAgainstSchema(report, reportSchema, "report")).toEqual([]);
    expect(requests.map((request) => request.pathname)).toEqual([
      "/api/lazurio/server-identity",
      "/api/apps",
      "/api/apps/example-organization-website-v2/open",
    ]);
  });

  test("selectors and package paths reject traversal or ambient URL shapes", () => {
    expect(() => parseModuleSelector("ExampleOrganization/website")).not.toThrow();
    expect(() => parseModuleSelector("ExampleOrganization/../website")).toThrow();
    expect(() => parseModuleSelector("https://example.com/x")).toThrow();
    expect(runModuleLifecycle({
      action: "status",
      selector: "ExampleOrganization/website",
      appPackage: "../package.json",
    })).rejects.toThrow("bezpečná relativní POSIX cesta");
  });
});

function fixtureFetch({
  requests = [],
  identityOverride = identity,
  defaultAppIds = ["example-organization-website-v2"],
  takeoverRequired = false,
} = {}) {
  return async (input, options = {}) => {
    const url = new URL(input);
    let body = null;
    if (typeof options.body === "string") body = JSON.parse(options.body);
    requests.push({ pathname: url.pathname, method: options.method ?? "GET", ...(body === null ? {} : { body }) });
    if (url.pathname === "/api/lazurio/server-identity") return Response.json(identityOverride);
    if (url.pathname === "/api/apps") {
      return Response.json({ apps: fixtureApps(defaultAppIds) });
    }
    if (/^\/api\/apps\/example-organization-website-v[23]\/(?:start|open|stop)$/u.test(url.pathname)) {
      if (takeoverRequired && body?.replace_app_id !== "other-organization-portal-v1") {
        return Response.json({
          error: "cross_organization_takeover_confirmation_required",
          message: "Replacement confirmation required.",
          failure_kind: "cross_organization_takeover_confirmation_required",
          replace_app_id: "other-organization-portal-v1",
          replace_organization: "OtherOrganization",
        }, { status: 409 });
      }
      const action = url.pathname.split("/").at(-1);
      return Response.json({ action, url: "http://127.0.0.1:24711" });
    }
    return Response.json({ error: "not_found" }, { status: 404 });
  };
}

function fixtureApps(defaultAppIds) {
  const app = (version, explicit = true) => ({
    id: `example-organization-website-${version}`,
    title: `Website ${version}`,
    company: "ExampleOrganization",
    module: "website",
    host: "127.0.0.1",
    port: 24711,
    url: "http://127.0.0.1:24711",
    module_app: {
      package: `app/${version}/package.json`,
      declared: explicit,
      default: defaultAppIds.includes(`example-organization-website-${version}`),
      state: explicit ? "explicit" : "legacy-missing",
    },
    dependencies: { state: "ready", can_start: true, message: "ready" },
    runtime: { status: "stopped", owner: "none", controllable: false, pid: null, url: null },
    shared_port_owners: [{
      app_id: "other-organization-portal-v1",
      company: "OtherOrganization",
      host: "127.0.0.1",
      port: 24711,
    }],
  });
  return [app("v3"), app("v2"), app("v1", false)];
}
