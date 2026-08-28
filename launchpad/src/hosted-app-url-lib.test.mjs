import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import {
  HostedAppUrlError,
  createHostedAppUrlAdapter,
  hostedLifecycleConfigurationId,
  parseHostedAppUrlsJson,
  parseTeamServiceCatalogJson,
  projectHostedAppUrl,
  projectHostedRuntimePayload,
  requireHostedAppUrl,
  validateTeamServiceCatalogBindings,
} from "./hosted-app-url-lib.mjs";
import { validateAgainstSchema } from "../../lazurio/runtime/json-schema-mini.mjs";

const appId = "iotor-knowledgebase-v2";
const externalOrigin = "https://knowledgebase.management.example.test/";
const catalogSchema = JSON.parse(await readFile(
  new URL("../../lazurio/schemas/lazurio-team-service-catalog.schema.json", import.meta.url),
  "utf8",
));

test("local profile preserves loopback navigation and health", () => {
  const adapter = createHostedAppUrlAdapter({
    profile: "local",
    expectedTeamId: "technical",
    serviceCatalogJson: "malformed input is ignored outside hosted profile",
  });
  const app = localApp();
  expect(projectHostedAppUrl(app, adapter)).toBe(app);
  expect(projectHostedRuntimePayload({ url: app.url, runtime: app.runtime }, app, adapter))
    .toEqual({ url: app.url, runtime: app.runtime });
  expect(requireHostedAppUrl(localApp(), adapter)).toBeNull();
});

test("hosted profile projects the exact HTTPS Team catalog origin without changing internal health", () => {
  const adapter = createHostedAppUrlAdapter({
    profile: "hosted",
    expectedTeamId: "iotor-builders",
    serviceCatalogJson: teamCatalogJson(),
  });
  const projected = projectHostedAppUrl(localApp(), adapter);
  expect(projected.url).toBe(externalOrigin);
  expect(projected.health_url).toBe("http://127.0.0.1:5744/health");
  expect(projected.runtime.url).toBe(externalOrigin);
  expect(projected.runtime.health_url).toBe("http://127.0.0.1:5744/health");
  expect(requireHostedAppUrl(localApp(), adapter)).toBe(externalOrigin);
});

test("hosted profile projects nested restart and switch lifecycle URLs", () => {
  const adapter = createHostedAppUrlAdapter({
    profile: "hosted",
    expectedTeamId: "iotor-builders",
    serviceCatalogJson: teamCatalogJson(),
  });
  const loopback = "http://127.0.0.1:5744";
  const projected = projectHostedRuntimePayload({
    action: "restart",
    start: { runtime: { url: loopback, health_url: `${loopback}/health` } },
    started: { url: loopback, runtime: { url: loopback } },
  }, localApp(), adapter);
  expect(projected.start.runtime.url).toBe(externalOrigin);
  expect(projected.start.runtime.health_url).toBe(`${loopback}/health`);
  expect(projected.started.url).toBe(externalOrigin);
  expect(projected.started.runtime.url).toBe(externalOrigin);
  expect(JSON.stringify(projected)).not.toContain('"url":"http://127.0.0.1');

  const projectedError = projectHostedRuntimePayload({
    error: "app_start_failed",
    runtime: { status: "unhealthy", url: loopback, health_url: `${loopback}/health` },
  }, localApp(), adapter);
  expect(projectedError.runtime.url).toBe(externalOrigin);
  expect(projectedError.runtime.health_url).toBe(`${loopback}/health`);
});

test("hosted profile fails closed for missing mapping and never returns loopback", () => {
  const adapter = createHostedAppUrlAdapter({ profile: "hosted", expectedTeamId: "iotor-builders" });
  const projected = projectHostedRuntimePayload({
    url: "http://127.0.0.1:5744",
    runtime: { url: "http://127.0.0.1:5744", health_url: "http://127.0.0.1:5744/health" },
  }, localApp(), adapter);
  expect(projected.url).toBeNull();
  expect(projected.runtime.url).toBeNull();
  expect(projected.runtime.health_url).toBe("http://127.0.0.1:5744/health");
  expect(() => requireHostedAppUrl(localApp(), adapter)).toThrow(HostedAppUrlError);
  expect(() => requireHostedAppUrl(localApp(), adapter)).toThrow("will not expose loopback navigation");
});

test("canonical catalog is the only authority and compatibility map is only a fallback seam", () => {
  const compatibility = JSON.stringify({ [appId]: externalOrigin });
  expect(createHostedAppUrlAdapter({
    profile: "hosted",
    expectedTeamId: "iotor-builders",
    compatibilityUrlsJson: compatibility,
  }))
    .toMatchObject({ profile: "hosted", source: "compatibility-injected-map" });
  expect(() => createHostedAppUrlAdapter({
    profile: "hosted",
    expectedTeamId: "iotor-builders",
    serviceCatalogJson: teamCatalogJson(),
    compatibilityUrlsJson: compatibility,
  })).toThrow("one URL authority");
});

test("hosted adapter binds the catalog to the expected Team and discovered module lease", () => {
  expect(() => createHostedAppUrlAdapter({
    profile: "hosted",
    serviceCatalogJson: teamCatalogJson(),
  })).toThrow("LAZURIO_TEAM_ID is required");
  expect(() => createHostedAppUrlAdapter({
    profile: "hosted",
    expectedTeamId: "iotor builders",
    serviceCatalogJson: teamCatalogJson(),
  })).toThrow("LAZURIO_TEAM_ID is required");
  expect(() => createHostedAppUrlAdapter({
    profile: "hosted",
    expectedTeamId: "wrong-team",
    serviceCatalogJson: teamCatalogJson(),
  })).toThrow("expected wrong-team");

  const adapter = createHostedAppUrlAdapter({
    profile: "hosted",
    expectedTeamId: "iotor-builders",
    serviceCatalogJson: teamCatalogJson({ module_lease_key: "iotor/deals" }),
  });
  expect(() => requireHostedAppUrl(localApp(), adapter)).toThrow("claims iotor/deals");
  expect(projectHostedAppUrl(localApp(), adapter)).toMatchObject({
    url: null,
    hosted_url_error: "hosted_app_lease_mismatch",
  });
});

test("hosted catalog and compatibility input reject malformed or non-HTTPS origins", () => {
  for (const mutate of [
    () => "not-json",
    () => JSON.stringify({}),
    () => teamCatalogJson({ external_origin: "http://module.team.example.test/" }),
    () => teamCatalogJson({ external_origin: "https://user:secret@example.test/" }),
    () => teamCatalogJson({ external_origin: "https://example.test/path" }),
    () => teamCatalogJson({ external_origin: "https://example.test/?secret=1" }),
    () => teamCatalogJson({ module_lease_key: "missing-slash" }),
  ]) {
    expect(() => parseTeamServiceCatalogJson(mutate())).toThrow();
  }
  expect(() => parseHostedAppUrlsJson(JSON.stringify({ [appId]: "http://legacy.example.test/" }))).toThrow();
  for (const loopback of [
    "https://127.0.0.1/",
    "https://127.1/",
    "https://localhost/",
    "https://localhost./",
    "https://LOCALHOST/",
    "https://App.LOCALHOST/",
    "https://module.localhost./",
    "https://[::1]/",
    "https://[::ffff:127.0.0.1]/",
  ]) {
    expect(() => parseHostedAppUrlsJson(JSON.stringify({ [appId]: loopback }))).toThrow("loopback");
  }
});

test("published Team catalog schema matches runtime origin and identity constraints", () => {
  const valid = JSON.parse(teamCatalogJson());
  expect(validateAgainstSchema(valid, catalogSchema)).toEqual([]);

  for (const external_origin of [
    "http://module.team.example.test/",
    "https://user:secret@example.test/",
    "https://example.test/path",
    "https://example.test/?secret=1",
    "https://localhost./",
    "https://127.0.0.1/",
    "https://127.1/",
    "https://2130706433/",
    "https://[::1]/",
    "https://[::ffff:127.0.0.1]/",
    "https://module.team.example.test:99999/",
  ]) {
    const catalog = JSON.parse(teamCatalogJson({ external_origin }));
    expect(validateAgainstSchema(catalog, catalogSchema).length).toBeGreaterThan(0);
    expect(() => parseTeamServiceCatalogJson(JSON.stringify(catalog))).toThrow();
  }

  const invalidTeam = JSON.parse(teamCatalogJson());
  invalidTeam.team_id = "iotor builders";
  expect(validateAgainstSchema(invalidTeam, catalogSchema).length).toBeGreaterThan(0);
  expect(() => parseTeamServiceCatalogJson(JSON.stringify(invalidTeam))).toThrow("team_id is invalid");

  const duplicateApp = JSON.parse(teamCatalogJson());
  duplicateApp.services.push({ ...duplicateApp.services[0], external_origin: "https://other.example.test/" });
  expect(() => parseTeamServiceCatalogJson(JSON.stringify(duplicateApp))).toThrow("duplicates app_id");

  const uppercaseDns = JSON.parse(teamCatalogJson({ external_origin: "https://Module.Team.Example/" }));
  expect(validateAgainstSchema(uppercaseDns, catalogSchema).length).toBeGreaterThan(0);
  expect(() => parseTeamServiceCatalogJson(JSON.stringify(uppercaseDns))).toThrow("ASCII DNS name");

  const cgnat = JSON.parse(teamCatalogJson({ external_origin: "https://100.64.12.34:443/" }));
  expect(validateAgainstSchema(cgnat, catalogSchema)).toEqual([]);
  expect(parseTeamServiceCatalogJson(JSON.stringify(cgnat)).services.get(appId).external_origin)
    .toBe("https://100.64.12.34/");
});

test("v2 catalog binds one Organization and Team to immutable exact sources", () => {
  const main = parseTeamServiceCatalogJson(teamCatalogV2Json());
  expect(main).toMatchObject({
    schema_version: "lazurio.team_service_catalog.v2",
    organization_slug: "Iotor",
    team_id: "iotor-builders",
    catalog_revision: "2026-08-28T18:00:00Z",
  });
  expect(main.services.get(appId)?.source).toEqual({ type: "main" });

  const worktree = parseTeamServiceCatalogJson(teamCatalogV2Json({
    source: {
      type: "worktree",
      slug: "DEV-6513-hosted-preview",
      mission_control_plan_code: "DEV-6513",
      branch: "agent/DEV-6513-hosted-preview",
    },
  }));
  expect(worktree.services.get(appId)?.source).toEqual({
    type: "worktree",
    slug: "DEV-6513-hosted-preview",
    mission_control_plan_code: "DEV-6513",
    branch: "agent/DEV-6513-hosted-preview",
  });
  expect(validateAgainstSchema(JSON.parse(teamCatalogV2Json()), catalogSchema)).toEqual([]);
});

test("v2 effective configuration has a deterministic lifecycle identity", () => {
  const original = JSON.parse(teamCatalogV2Json());
  const regenerated = { ...original, generated_at: "2026-08-28T19:00:00Z" };
  const revised = { ...regenerated, catalog_revision: "2026-08-28T19:00:00Z" };
  const changedSource = structuredClone(original);
  changedSource.services[0].source = {
    type: "worktree",
    slug: "DEV-6513-hosted-preview",
    mission_control_plan_code: "DEV-6513",
    branch: "agent/DEV-6513-hosted-preview",
  };

  const originalId = hostedLifecycleConfigurationId(parseTeamServiceCatalogJson(JSON.stringify(original)));
  expect(originalId).toMatch(/^[a-f0-9]{64}$/);
  expect(hostedLifecycleConfigurationId(parseTeamServiceCatalogJson(JSON.stringify(regenerated))))
    .toBe(originalId);
  expect(hostedLifecycleConfigurationId(parseTeamServiceCatalogJson(JSON.stringify(revised))))
    .not.toBe(originalId);
  expect(hostedLifecycleConfigurationId(parseTeamServiceCatalogJson(JSON.stringify(changedSource))))
    .not.toBe(originalId);
  expect(hostedLifecycleConfigurationId({ schema_version: null })).toBeNull();
});

test("v2 catalog rejects duplicate app, lease and origin authorities", () => {
  const first = JSON.parse(teamCatalogV2Json());
  first.services.push({ ...first.services[0] });
  expect(() => parseTeamServiceCatalogJson(JSON.stringify(first))).toThrow("duplicates app_id");

  const duplicateLease = JSON.parse(teamCatalogV2Json());
  duplicateLease.services.push({
    ...duplicateLease.services[0],
    app_id: "iotor-editor-v1",
    external_origin: "https://editor.management.example.test/",
  });
  expect(() => parseTeamServiceCatalogJson(JSON.stringify(duplicateLease))).toThrow("duplicates module_lease_key");

  const duplicateOrigin = JSON.parse(teamCatalogV2Json());
  duplicateOrigin.services.push({
    ...duplicateOrigin.services[0],
    app_id: "iotor-editor-v1",
    module_lease_key: "Iotor/editor",
  });
  expect(() => parseTeamServiceCatalogJson(JSON.stringify(duplicateOrigin))).toThrow("duplicates external_origin");
});

test("v2 catalog rejects non-canonical or under-specified worktree sources", () => {
  for (const source of [
    { type: "worktree", slug: "DEV-6513-preview" },
    { type: "worktree", slug: "../preview", mission_control_plan_code: "DEV-6513", branch: "agent/preview" },
    { type: "worktree", slug: "DEV-6513-preview", mission_control_plan_code: "dev-6513", branch: "agent/preview" },
    { type: "worktree", slug: "DEV-6513-preview", mission_control_plan_code: "DEV-6513", branch: "../main" },
    { type: "main", branch: "main" },
  ]) {
    const candidate = JSON.parse(teamCatalogV2Json({ source }));
    expect(validateAgainstSchema(candidate, catalogSchema).length).toBeGreaterThan(0);
    expect(() => parseTeamServiceCatalogJson(JSON.stringify(candidate))).toThrow("source");
  }
});

test("v2 catalog binding fails closed across Organization, Team and module lease boundaries", () => {
  const adapter = parseTeamServiceCatalogJson(teamCatalogV2Json());
  const organizations = [{ slug: "Iotor", teams: [{ slug: "iotor-builders" }] }];
  const apps = [{ id: appId, company: "Iotor", module: "knowledgebase", teams: ["iotor-builders"] }];
  expect(validateTeamServiceCatalogBindings(adapter, { organizations, apps })).toBe(adapter);
  expect(() => validateTeamServiceCatalogBindings(adapter, { organizations: [], apps })).toThrow("not mounted");
  expect(() => validateTeamServiceCatalogBindings(adapter, {
    organizations: [{ slug: "Iotor", teams: [{ slug: "other" }] }],
    apps,
  })).toThrow("does not belong");
  expect(() => validateTeamServiceCatalogBindings(adapter, {
    organizations,
    apps: [{ ...apps[0], company: "Other" }],
  })).toThrow("belongs to Other");
  expect(() => validateTeamServiceCatalogBindings(adapter, {
    organizations,
    apps: [{ ...apps[0], teams: ["other"] }],
  })).toThrow("not a member");
});

function localApp() {
  return {
    id: appId,
    company: "iotor",
    module: "knowledgebase",
    url: "http://127.0.0.1:5744",
    health_url: "http://127.0.0.1:5744/health",
    runtime: {
      status: "healthy",
      url: "http://127.0.0.1:5744",
      health_url: "http://127.0.0.1:5744/health",
    },
  };
}

function teamCatalogJson(overrides = {}) {
  return JSON.stringify({
    schema_version: "lazurio.team_service_catalog.v1",
    team_id: "iotor-builders",
    generated_at: "2026-08-13T10:00:00Z",
    services: [{
      app_id: appId,
      module_lease_key: "iotor/knowledgebase",
      external_origin: externalOrigin,
      ...overrides,
    }],
  });
}

function teamCatalogV2Json(overrides = {}) {
  return JSON.stringify({
    schema_version: "lazurio.team_service_catalog.v2",
    organization_slug: "Iotor",
    team_id: "iotor-builders",
    catalog_revision: "2026-08-28T18:00:00Z",
    generated_at: "2026-08-28T18:00:00Z",
    services: [{
      app_id: appId,
      module_lease_key: "Iotor/knowledgebase",
      external_origin: externalOrigin,
      source: { type: "main" },
      ...overrides,
    }],
  });
}
