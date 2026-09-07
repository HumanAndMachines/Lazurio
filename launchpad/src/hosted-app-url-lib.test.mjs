import { expect, test } from "bun:test";
import {
  HostedAppUrlError,
  createHostedWorkspaceConfiguration,
  hostedLifecycleConfigurationId,
  projectHostedAppUrl,
  projectHostedRuntimePayload,
  requireHostedAppUrl,
  selectHostedWorkspaceApps,
  validateHostedWorkspaceBindings,
} from "./hosted-app-url-lib.mjs";

const configuration = createHostedWorkspaceConfiguration({
  profile: "hosted",
  organizationSlug: "ExampleOrg",
  teamId: "builders",
  domain: "workspace.example.test",
});

test("local workspace keeps loopback URLs and has no lifecycle configuration identity", () => {
  const local = createHostedWorkspaceConfiguration();
  const app = workspaceApp();
  expect(local).toMatchObject({ profile: "local", source: "local-loopback" });
  expect(hostedLifecycleConfigurationId(local)).toBeNull();
  expect(projectHostedAppUrl(app, local)).toBe(app);
  expect(projectHostedRuntimePayload({ url: "http://127.0.0.1:4310/" }, app, local))
    .toEqual({ url: "http://127.0.0.1:4310/" });
  expect(requireHostedAppUrl(app, local)).toBeNull();
});

test("hosted workspace identity is three validated scalars rather than a service catalog", () => {
  expect(configuration).toEqual({
    profile: "hosted",
    organization_slug: "ExampleOrg",
    team_id: "builders",
    domain: "workspace.example.test",
    source: "workspace-identity",
  });
  expect(hostedLifecycleConfigurationId(configuration)).toMatch(/^[a-f0-9]{64}$/);
  expect(hostedLifecycleConfigurationId(createHostedWorkspaceConfiguration({
    profile: "hosted",
    organizationSlug: "ExampleOrg",
    teamId: "builders",
    domain: "other.example.test",
  }))).not.toBe(hostedLifecycleConfigurationId(configuration));

  expect(() => createHostedWorkspaceConfiguration({ profile: "hosted" }))
    .toThrow("LAZURIO_ORGANIZATION_SLUG");
  expect(() => createHostedWorkspaceConfiguration({
    profile: "hosted",
    organizationSlug: "ExampleOrg",
    teamId: "Builders",
    domain: "workspace.example.test",
  })).toThrow("LAZURIO_TEAM_ID");
  expect(() => createHostedWorkspaceConfiguration({
    profile: "hosted",
    organizationSlug: "ExampleOrg",
    teamId: "builders",
    domain: "https://workspace.example.test",
  })).toThrow("LAZURIO_HOSTED_DOMAIN");
});

test("hosted workspace binding fails closed for a different Organization or Team", () => {
  const inventory = {
    organizations: [{
      slug: "ExampleOrg",
      teams: [{ slug: "builders" }],
    }],
  };
  expect(validateHostedWorkspaceBindings(configuration, inventory)).toBe(configuration);
  expect(() => validateHostedWorkspaceBindings(
    createHostedWorkspaceConfiguration({
      profile: "hosted",
      organizationSlug: "OtherOrg",
      teamId: "builders",
      domain: "workspace.example.test",
    }),
    inventory,
  )).toThrow("OtherOrg is not mounted");
  expect(() => validateHostedWorkspaceBindings(
    createHostedWorkspaceConfiguration({
      profile: "hosted",
      organizationSlug: "ExampleOrg",
      teamId: "other",
      domain: "workspace.example.test",
    }),
    inventory,
  )).toThrow("Team other");
});

test("all Team modules derive one default App from discovery and isolate invalid modules", () => {
  const dashboard = workspaceApp({
    id: "example-dashboard",
    module: "dashboard",
    module_apps: { open_target_app_id: "example-dashboard" },
  });
  const worker = workspaceApp({
    id: "example-worker",
    module: "dashboard",
    module_apps: { open_target_app_id: "example-dashboard" },
  });
  const knowledgebase = workspaceApp({
    id: "example-kb",
    module: "knowledgebase",
    module_apps: { open_target_app_id: "example-kb" },
  });
  const invalid = workspaceApp({
    id: "invalid-manifest:workspace/broken/package.json",
    module: "broken",
    module_apps: { open_target_app_id: null },
  });
  const result = selectHostedWorkspaceApps(configuration, {
    apps: [
      dashboard,
      worker,
      knowledgebase,
      invalid,
      workspaceApp({ id: "other-team", module: "other", teams: ["other"] }),
      workspaceApp({ id: "root-tool", module: "root-tool", space: "root", teams: [] }),
      workspaceApp({ id: "other-org", company: "OtherOrg", module: "foreign" }),
    ],
  });

  expect(result.apps.map((app) => app.id)).toEqual(["example-dashboard", "example-kb"]);
  expect(result.skipped).toEqual([{
    module: "broken",
    failure_kind: "hosted_module_open_target_missing",
  }]);
});

test("an available Team module without a runnable default App is visible as an isolated failure", () => {
  const result = selectHostedWorkspaceApps(configuration, {
    apps: [],
    organizations: [{
      slug: "ExampleOrg",
      module_declarations: [{
        slug: "empty-module",
        space: "workspace",
        status: "available",
        ui_exposure: "module",
        launchpad_section: null,
        teams: ["builders"],
        apps: { open_target_app_id: null },
      }],
    }],
  });

  expect(result).toEqual({
    apps: [],
    skipped: [{
      module: "empty-module",
      failure_kind: "hosted_module_open_target_missing",
    }],
  });
});

test("hosted URLs are derived from module, Team and domain for every runtime payload", () => {
  const app = workspaceApp();
  const expected = "https://knowledgebase.builders.workspace.example.test/";
  expect(projectHostedAppUrl({
    ...app,
    url: "http://127.0.0.1:4310/",
    runtime: { url: "http://127.0.0.1:4310/" },
  }, configuration)).toMatchObject({
    url: expected,
    hosted_url_source: "workspace-identity",
    runtime: { url: expected },
  });
  expect(projectHostedRuntimePayload({
    url: "http://127.0.0.1:4310/",
    start: { runtime: { url: "http://127.0.0.1:4310/" } },
  }, app, configuration)).toEqual({
    url: expected,
    start: { runtime: { url: expected } },
    hosted_url_source: "workspace-identity",
  });
  expect(requireHostedAppUrl(app, configuration)).toBe(expected);
});

test("hosted projection never leaks loopback for an App outside the active Team boundary", () => {
  const app = workspaceApp({ teams: ["other"] });
  expect(projectHostedAppUrl({
    ...app,
    url: "http://127.0.0.1:4310/",
    runtime: { url: "http://127.0.0.1:4310/" },
  }, configuration)).toMatchObject({
    url: null,
    hosted_url_error: "hosted_app_url_unavailable",
    runtime: { url: null },
  });
  expect(() => requireHostedAppUrl(app, configuration)).toThrow(HostedAppUrlError);
});

function workspaceApp(overrides = {}) {
  return {
    id: "example-kb",
    company: "ExampleOrg",
    module: "knowledgebase",
    space: "workspace",
    teams: ["builders"],
    module_apps: { open_target_app_id: "example-kb" },
    ...overrides,
  };
}

function declaredOrganizationApp() {
  return {
    id: "example-planning", company: "ExampleOrg", module: "planning",
    space: "root", teams: [], organization_path: "organizations/ExampleOrg",
    module_catalog_path: "planning", module_open_target: true,
    module_apps: {
      state: "declared", open_target_app_id: "example-planning",
      open_target_source: "declared-default",
      contract_path: "organizations/ExampleOrg/planning/lazurio.module.json",
      declaration: { path: "planning", space: "root", teams: [], status: "available", ui_exposure: "module" },
    },
    module_app: { declared: true, default: true },
    module_contract: { schema_version: "lazurio.module.v1", id: "planning", company: "ExampleOrg" },
    runtime_contract: { schema_version: "lazurio.runtime.v1" },
  };
}

test("declared available Organization default shares the hosted URL and lifecycle selection", () => {
  const app = declaredOrganizationApp();
  const inventory = { apps: [app], organizations: [{ slug: "ExampleOrg", module_declarations: [{
    ...app.module_apps.declaration, slug: "planning", apps: app.module_apps,
  }] }] };
  expect(selectHostedWorkspaceApps(configuration, inventory)).toEqual({ apps: [app], skipped: [] });
  const url = "https://planning.builders.workspace.example.test/";
  expect(requireHostedAppUrl(app, configuration)).toBe(url);
  expect(projectHostedRuntimePayload({ url: "http://127.0.0.1:1234", start: { url: "http://127.0.0.1:1234" } }, app, configuration))
    .toMatchObject({ url, start: { url } });
});

test("adding an Organization default preserves candidate-only Workspace module selection", () => {
  const planning = declaredOrganizationApp();
  const knowledgebase = workspaceApp();
  const inventory = { apps: [planning, knowledgebase], organizations: [{ slug: "ExampleOrg", module_declarations: [{
    ...planning.module_apps.declaration, slug: "planning", apps: planning.module_apps,
  }] }] };
  expect(selectHostedWorkspaceApps(configuration, inventory)).toEqual({ apps: [knowledgebase, planning], skipped: [] });
});

test("Organization repository slot binds by catalog path while lifecycle and DNS use manifest Module ID", () => {
  const app = declaredOrganizationApp();
  const inventory = { apps: [app], organizations: [{ slug: "ExampleOrg", module_declarations: [{
    ...app.module_apps.declaration, slug: "planning-repository", apps: app.module_apps,
  }] }] };
  expect(selectHostedWorkspaceApps(configuration, inventory)).toEqual({ apps: [app], skipped: [] });
  expect(requireHostedAppUrl(app, configuration)).toBe("https://planning.builders.workspace.example.test/");
});

test("Organization-section Workspace default retains the original Team constraint", () => {
  const app = declaredOrganizationApp();
  Object.assign(app.module_apps.declaration, { space: "workspace", teams: ["builders"], path: "workspace/planning" });
  app.module_catalog_path = "workspace/planning";
  app.module_apps.contract_path = "organizations/ExampleOrg/workspace/planning/lazurio.module.json";
  expect(projectHostedAppUrl(app, configuration).url).toBe("https://planning.builders.workspace.example.test/");
  expect(selectHostedWorkspaceApps(configuration, { apps: [app] }).apps).toEqual([app]);
  app.module_apps.declaration.teams = ["other-team"];
  expect(projectHostedAppUrl(app, configuration).url).toBeNull();
  expect(selectHostedWorkspaceApps(configuration, { apps: [app] }).apps).toEqual([]);
});

const rootDenyCases = {
  "foreign Organization": app => { app.company = "OtherOrg"; },
  "productionspace": app => { app.space = "productionspace"; },
  "unavailable checkout": app => { app.module_apps.declaration.status = "missing_access"; },
  "diagnostics-only database": app => { app.module_apps.declaration.ui_exposure = "diagnostics-only"; },
  "undeclared root script": app => { delete app.module_apps.declaration; },
  "ambiguous module": app => { app.module_apps.state = "unresolved-invalid"; },
  "missing default": app => { app.module_apps.open_target_app_id = null; },
  "non-default sibling": app => { app.module_apps.open_target_app_id = "example-other"; },
  "legacy inferred default": app => { app.module_apps.open_target_source = "legacy-single"; },
  "unverified catalog path": app => { app.module_catalog_path = "other"; },
  "missing module contract": app => { delete app.module_contract; },
  "missing runtime contract": app => { delete app.runtime_contract; },
  "unbound contract path": app => { app.module_apps.contract_path = "elsewhere/lazurio.module.json"; },
  "runtime belonging to another module": app => { app.module_contract.id = "other"; },
  "undeclared package": app => { app.module_app.declared = false; },
  "missing default projection": app => { app.module_open_target = false; },
};
for (const [label, mutate] of Object.entries(rootDenyCases)) {
  test(`hosted Organization default denies ${label}`, () => {
    const app = declaredOrganizationApp();
    mutate(app);
    expect(projectHostedAppUrl(app, configuration).url).toBeNull();
    expect(() => requireHostedAppUrl(app, configuration)).toThrow(HostedAppUrlError);
    expect(selectHostedWorkspaceApps(configuration, { apps: [app] }).apps).toEqual([]);
  });
}

test("invalid hosted context never manufactures a root application URL", () => {
  for (const override of [{ domain: "https://invalid.test" }, { team_id: "../other" }, { organization_slug: "" }]) {
    const invalid = { ...configuration, ...override };
    expect(projectHostedAppUrl(declaredOrganizationApp(), invalid).url).toBeNull();
    expect(selectHostedWorkspaceApps(invalid, { apps: [declaredOrganizationApp()] }).apps).toEqual([]);
  }
});
