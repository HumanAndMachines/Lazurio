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
