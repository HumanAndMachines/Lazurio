import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  HostedAppUrlError,
  createHostedWorkspaceConfiguration,
  hostedApplicationOrigin,
  hostedLifecycleConfigurationId,
  hostedWorkspaceConfigurationFromEnvironment,
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
  machine: "builder",
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

test("hosted workspace identity is four validated scalars rather than a service catalog", () => {
  expect(configuration).toEqual({
    profile: "hosted",
    scope: "organization",
    owner: null,
    personalspace: null,
    organization_slug: "ExampleOrg",
    team_id: "builders",
    domain: "workspace.example.test",
    machine: "builder",
    source: "workspace-identity",
  });
  expect(hostedLifecycleConfigurationId(configuration)).toMatch(/^[a-f0-9]{64}$/);
  expect(hostedLifecycleConfigurationId(createHostedWorkspaceConfiguration({
    profile: "hosted",
    organizationSlug: "ExampleOrg",
    teamId: "builders",
    domain: "other.example.test",
    machine: "builder",
  }))).not.toBe(hostedLifecycleConfigurationId(configuration));
  expect(hostedLifecycleConfigurationId(createHostedWorkspaceConfiguration({
    profile: "hosted",
    organizationSlug: "ExampleOrg",
    teamId: "builders",
    domain: "workspace.example.test",
    machine: "other-vm",
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
    machine: "builder",
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
      machine: "builder",
    }),
    inventory,
  )).toThrow("OtherOrg is not mounted");
  expect(() => validateHostedWorkspaceBindings(
    createHostedWorkspaceConfiguration({
      profile: "hosted",
      organizationSlug: "ExampleOrg",
      teamId: "other",
      domain: "workspace.example.test",
      machine: "builder",
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

test("the Machine label comes from LAZURIO_HOSTED_MACHINE or the Launchpad origin and fails closed", () => {
  const identity = { profile: "hosted", organizationSlug: "ExampleOrg", teamId: "builders", domain: "workspace.example.test" };
  const derived = createHostedWorkspaceConfiguration({
    ...identity, launchpadExternalOrigin: "https://launchpad.blue-team.workspace.example.test",
  });
  expect(derived.machine).toBe("blue-team");
  expect(createHostedWorkspaceConfiguration({
    ...identity, machine: "builder", launchpadExternalOrigin: "https://launchpad.builder.workspace.example.test/",
  }).machine).toBe("builder");
  expect(hostedLifecycleConfigurationId(derived)).not.toBe(hostedLifecycleConfigurationId(configuration));

  expect(() => createHostedWorkspaceConfiguration(identity)).toThrow("LAZURIO_HOSTED_MACHINE");
  for (const machine of ["Builder", "blue--team", "-vm", "vm_1", "a".repeat(33)]) {
    expect(() => createHostedWorkspaceConfiguration({ ...identity, machine })).toThrow("LAZURIO_HOSTED_MACHINE");
  }
  for (const launchpadExternalOrigin of [
    "http://launchpad.builder.workspace.example.test",
    "https://launchpad.builder.other.example.test",
    "https://launchpad.workspace.example.test",
    "https://builder.workspace.example.test",
    "https://launchpad.builder.workspace.example.test/launchpad/",
    "https://launchpad.builder.workspace.example.test:8443",
    "https://launchpad.a--b.workspace.example.test",
    "https://launchpad.sales.example.test",
    "not a url",
  ]) {
    expect(() => createHostedWorkspaceConfiguration({ ...identity, launchpadExternalOrigin }))
      .toThrow("LAZURIO_LAUNCHPAD_EXTERNAL_ORIGIN");
  }
  expect(() => createHostedWorkspaceConfiguration({
    ...identity, machine: "builder", launchpadExternalOrigin: "https://launchpad.other-vm.workspace.example.test",
  })).toThrow("does not match");
});

test("Mission Control opens at its own application hostname on the Machine", () => {
  const app = workspaceApp({ id: "example-mc", module: "mission-control", module_apps: { open_target_app_id: "example-mc" } });
  const expected = "https://mission-control.builder.workspace.example.test/";
  expect(projectHostedAppUrl(app, configuration).url).toBe(expected);
  expect(projectHostedAppUrl(app, createHostedWorkspaceConfiguration({
    profile: "hosted", organizationSlug: "ExampleOrg", teamId: "builders", domain: "workspace.example.test",
    launchpadExternalOrigin: "https://launchpad.builder.workspace.example.test",
  })).url).toBe(expected);
  expect(requireHostedAppUrl(app, configuration)).toBe(expected);
});

test("reserved and malformed application labels never receive a hosted hostname", () => {
  for (const module of ["api", "oauth2", "well-known", "launchpad", "Knowledge", "a--b", "x".repeat(64)]) {
    const app = workspaceApp({ module });
    expect(projectHostedAppUrl(app, configuration)).toMatchObject({ url: null, hosted_url_error: "hosted_app_url_unavailable" });
    expect(selectHostedWorkspaceApps(configuration, { apps: [app] })).toEqual({
      apps: [],
      skipped: [{ module, failure_kind: "hosted_module_dns_label_invalid" }],
    });
  }
});

test("hosted URLs are derived from module, Machine and domain for every runtime payload", () => {
  const app = workspaceApp();
  const expected = "https://knowledgebase.builder.workspace.example.test/";
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
  const url = "https://planning.builder.workspace.example.test/";
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
  expect(requireHostedAppUrl(app, configuration)).toBe("https://planning.builder.workspace.example.test/");
});

test("Organization-section Workspace default retains the original Team constraint", () => {
  const app = declaredOrganizationApp();
  Object.assign(app.module_apps.declaration, { space: "workspace", teams: ["builders"], path: "workspace/planning" });
  app.module_catalog_path = "workspace/planning";
  app.module_apps.contract_path = "organizations/ExampleOrg/workspace/planning/lazurio.module.json";
  expect(projectHostedAppUrl(app, configuration).url).toBe("https://planning.builder.workspace.example.test/");
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
  for (const override of [
    { domain: "https://invalid.test" }, { team_id: "../other" }, { organization_slug: "" },
    { machine: null }, { machine: "Builder" }, { machine: "a".repeat(33) },
  ]) {
    const invalid = { ...configuration, ...override };
    expect(projectHostedAppUrl(declaredOrganizationApp(), invalid).url).toBeNull();
    expect(selectHostedWorkspaceApps(invalid, { apps: [declaredOrganizationApp()] }).apps).toEqual([]);
  }
});

// Personal scope (decisions 0153/0154/0155): one hosted Machine per human
// Principal. Its DNS/Machine slug is frozen at creation; the Personalspace is
// bound by its exact folder, never by comparing the slug with the login.
const personalEnvironment = Object.freeze({
  LAZURIO_WORKSPACE_PROFILE: "hosted",
  LAZURIO_HOSTED_SCOPE: "personal",
  LAZURIO_HOSTED_OWNER: "immakermatty",
  LAZURIO_HOSTED_PERSONALSPACE: "ImMakerMatty_GEN3",
  LAZURIO_HOSTED_DOMAIN: "lazurio.io",
  LAZURIO_HOSTED_MACHINE: "immakermatty",
  LAZURIO_LAUNCHPAD_EXTERNAL_ORIGIN: "https://launchpad.immakermatty.lazurio.io",
});
const personal = hostedWorkspaceConfigurationFromEnvironment(personalEnvironment);

function personalApp(overrides = {}) {
  return {
    id: "personal--ImMakerMatty_GEN3--journal",
    app_id: "journal",
    company: "ImMakerMatty",
    module: "journal",
    personal: true,
    surface_scope: "private",
    space: "ImMakerMatty_GEN3",
    space_mount_path: "personalspace/ImMakerMatty_GEN3",
    space_owner: "ImMakerMatty",
    module_app: { declared: true, default: true, state: "explicit", package: "package.json" },
    module_contract: { schema_version: "lazurio.module.v1", id: "journal", company: "ImMakerMatty" },
    runtime_contract: { schema_version: "lazurio.runtime.v1" },
    ...overrides,
  };
}

function personalSpace(overrides = {}) {
  return {
    owner: "ImMakerMatty",
    dir_name: "ImMakerMatty_GEN3",
    mount_path: "personalspace/ImMakerMatty_GEN3",
    is_owner_primary: true,
    config_valid: true,
    ...overrides,
  };
}

test("personal scope parses the owner-named Machine and its exact Personalspace folder", () => {
  expect(personal).toEqual({
    profile: "hosted",
    scope: "personal",
    owner: "immakermatty",
    personalspace: "ImMakerMatty_GEN3",
    organization_slug: null,
    team_id: null,
    domain: "lazurio.io",
    machine: "immakermatty",
    source: "workspace-identity",
  });
  // The Machine label may come from the Launchpad origin alone.
  const { LAZURIO_HOSTED_MACHINE: _machine, ...originOnly } = personalEnvironment;
  expect(hostedWorkspaceConfigurationFromEnvironment(originOnly)).toEqual(personal);
  expect(hostedWorkspaceConfigurationFromEnvironment({
    ...personalEnvironment, LAZURIO_HOSTED_SCOPE: "Personal",
  })).toEqual(personal);
});

test("personal scope fails closed on missing owner/folder, foreign Machine, other domain or Organization env", () => {
  const { LAZURIO_HOSTED_OWNER: _owner, ...withoutOwner } = personalEnvironment;
  expect(() => hostedWorkspaceConfigurationFromEnvironment(withoutOwner)).toThrow("LAZURIO_HOSTED_OWNER is required");
  expect(() => hostedWorkspaceConfigurationFromEnvironment({
    ...personalEnvironment, LAZURIO_HOSTED_OWNER: "ImMakerMatty",
  })).toThrow("LAZURIO_HOSTED_OWNER");
  expect(() => hostedWorkspaceConfigurationFromEnvironment({
    ...personalEnvironment, LAZURIO_HOSTED_OWNER: "a".repeat(33),
  })).toThrow("LAZURIO_HOSTED_OWNER");
  const { LAZURIO_HOSTED_PERSONALSPACE: _folder, ...withoutFolder } = personalEnvironment;
  expect(() => hostedWorkspaceConfigurationFromEnvironment(withoutFolder))
    .toThrow("LAZURIO_HOSTED_PERSONALSPACE is required");
  for (const folder of ["ImMakerMatty", "../ImMakerMatty_GEN3", "personalspace/ImMakerMatty_GEN3",
    "ImMakerMatty_GEN3/", "Im.Maker_GEN3", "_GEN3", "ImMakerMatty\\x_GEN3"]) {
    expect(() => hostedWorkspaceConfigurationFromEnvironment({
      ...personalEnvironment, LAZURIO_HOSTED_PERSONALSPACE: folder,
    })).toThrow("LAZURIO_HOSTED_PERSONALSPACE");
  }
  for (const domain of ["example.test", "LAZURIO.io", "lazurio.io.", "dev.lazurio.io"]) {
    expect(() => hostedWorkspaceConfigurationFromEnvironment({
      ...personalEnvironment,
      LAZURIO_HOSTED_DOMAIN: domain,
      LAZURIO_LAUNCHPAD_EXTERNAL_ORIGIN: "",
    })).toThrow("LAZURIO_HOSTED_DOMAIN must be exactly lazurio.io");
  }
  expect(() => hostedWorkspaceConfigurationFromEnvironment({
    ...personalEnvironment,
    LAZURIO_HOSTED_MACHINE: "other",
    LAZURIO_LAUNCHPAD_EXTERNAL_ORIGIN: "https://launchpad.other.lazurio.io",
  })).toThrow("must be named after its owner immakermatty");
  expect(() => hostedWorkspaceConfigurationFromEnvironment({
    ...personalEnvironment, LAZURIO_HOSTED_MACHINE: "other",
  })).toThrow("does not match");
  expect(() => hostedWorkspaceConfigurationFromEnvironment({
    ...personalEnvironment, LAZURIO_ORGANIZATION_SLUG: "ExampleOrg",
  })).toThrow("LAZURIO_ORGANIZATION_SLUG must not be set for LAZURIO_HOSTED_SCOPE=personal");
  expect(() => hostedWorkspaceConfigurationFromEnvironment({
    ...personalEnvironment, LAZURIO_TEAM_ID: "builders",
  })).toThrow("LAZURIO_TEAM_ID must not be set");
  expect(() => hostedWorkspaceConfigurationFromEnvironment({
    ...personalEnvironment, LAZURIO_HOSTED_SCOPE: "team",
  })).toThrow("LAZURIO_HOSTED_SCOPE must be organization or personal");
  // Personal identity never widens the Organization scope either.
  const organizationScope = {
    profile: "hosted", organizationSlug: "ExampleOrg",
    teamId: "builders", domain: "workspace.example.test", machine: "builder",
  };
  expect(() => createHostedWorkspaceConfiguration({ ...organizationScope, owner: "immakermatty" }))
    .toThrow("LAZURIO_HOSTED_OWNER is valid only with LAZURIO_HOSTED_SCOPE=personal");
  expect(() => createHostedWorkspaceConfiguration({ ...organizationScope, personalspace: "ImMakerMatty_GEN3" }))
    .toThrow("LAZURIO_HOSTED_PERSONALSPACE is valid only with LAZURIO_HOSTED_SCOPE=personal");
});

test("Organization scope keeps its lifecycle identity byte-for-byte; personal scope has its own", () => {
  const legacyInput = JSON.stringify({
    organization_slug: "ExampleOrg",
    team_id: "builders",
    domain: "workspace.example.test",
    machine: "builder",
    routing: "application-hostname-v1",
  });
  expect(hostedLifecycleConfigurationId(configuration))
    .toBe(createHash("sha256").update(legacyInput).digest("hex"));
  expect(hostedLifecycleConfigurationId(personal)).toMatch(/^[a-f0-9]{64}$/);
  expect(hostedLifecycleConfigurationId(personal)).not.toBe(hostedLifecycleConfigurationId(configuration));
  expect(hostedLifecycleConfigurationId(hostedWorkspaceConfigurationFromEnvironment({
    ...personalEnvironment, LAZURIO_HOSTED_PERSONALSPACE: "RenamedLogin_GEN3",
  }))).not.toBe(hostedLifecycleConfigurationId(personal));
});

test("personal Apps open at <app>.<owner>.lazurio.io and Organization Apps never do", () => {
  const app = personalApp();
  const url = "https://journal.immakermatty.lazurio.io/";
  expect(hostedApplicationOrigin(app, personal)).toBe("https://journal.immakermatty.lazurio.io");
  expect(requireHostedAppUrl(app, personal)).toBe(url);
  expect(projectHostedAppUrl({ ...app, url: "http://127.0.0.1:4310/" }, personal)).toMatchObject({
    url, hosted_url_source: "workspace-identity",
  });
  expect(hostedApplicationOrigin(workspaceApp(), personal)).toBeNull();
  expect(hostedApplicationOrigin(declaredOrganizationApp(), personal)).toBeNull();
  expect(() => requireHostedAppUrl(workspaceApp(), personal)).toThrow(HostedAppUrlError);
  // An App of another Personalspace folder or with a reserved label gets nothing.
  expect(hostedApplicationOrigin(personalApp({ space_owner: "annavesela", space: "annavesela_GEN3" }), personal))
    .toBeNull();
  expect(hostedApplicationOrigin(personalApp({ module: "launchpad" }), personal)).toBeNull();
  // And the Organization scope never serves a personal App.
  expect(hostedApplicationOrigin(personalApp(), configuration)).toBeNull();
});

test("personal selection takes one declared default per Personalspace Module and excludes Organization Apps", () => {
  const journal = personalApp();
  const journalWorker = personalApp({
    id: "personal--ImMakerMatty_GEN3--journal-worker",
    module_app: { declared: true, default: false, state: "explicit", package: "worker/package.json" },
  });
  const notes = personalApp({
    id: "personal--ImMakerMatty_GEN3--notes",
    module: "notes",
    module_contract: { schema_version: "lazurio.module.v1", id: "notes", company: "ImMakerMatty" },
  });
  const legacy = personalApp({
    id: "personal--ImMakerMatty_GEN3--legacy",
    module: "legacy",
    module_app: null,
    module_contract: null,
    runtime_contract: { schema_version: null, legacy: true },
  });
  const result = selectHostedWorkspaceApps(personal, {
    apps: [
      journal,
      journalWorker,
      notes,
      legacy,
      workspaceApp(),
      declaredOrganizationApp(),
      personalApp({ id: "personal--other", space_owner: "annavesela", space: "annavesela_GEN3" }),
    ],
    organizations: [{ slug: "ExampleOrg", module_declarations: [] }],
  });
  expect(result.apps.map((app) => app.id)).toEqual([journal.id, notes.id]);
  expect(result.skipped).toEqual([{ module: "legacy", failure_kind: "hosted_module_open_target_missing" }]);
  expect(selectHostedWorkspaceApps(configuration, { apps: [journal, notes] })).toEqual({ apps: [], skipped: [] });
});

test("personal binding is the exact configured folder, independent of a renamed GitHub login", () => {
  expect(validateHostedWorkspaceBindings(personal, { spaces: [personalSpace()] })).toBe(personal);
  // The frozen slug immakermatty survives a rename to NewLogin: the explicit
  // folder binds, and the slug is never compared with owner.github_username.
  const renamed = hostedWorkspaceConfigurationFromEnvironment({
    ...personalEnvironment, LAZURIO_HOSTED_PERSONALSPACE: "NewLogin_GEN3",
  });
  const renamedSpace = personalSpace({ owner: "NewLogin", dir_name: "NewLogin_GEN3", mount_path: "personalspace/NewLogin_GEN3" });
  expect(validateHostedWorkspaceBindings(renamed, { spaces: [renamedSpace] })).toBe(renamed);
  const renamedApp = personalApp({ space: "NewLogin_GEN3", space_owner: "NewLogin", company: "NewLogin" });
  expect(requireHostedAppUrl(renamedApp, renamed)).toBe("https://journal.immakermatty.lazurio.io/");
  // Wrong or missing folder fails, even when the login would match the slug.
  expect(() => validateHostedWorkspaceBindings(personal, { spaces: [] }))
    .toThrow("Personalspace personalspace/ImMakerMatty_GEN3 (LAZURIO_HOSTED_PERSONALSPACE) is not mounted");
  expect(() => validateHostedWorkspaceBindings(personal, { spaces: [renamedSpace] })).toThrow("is not mounted");
  expect(() => validateHostedWorkspaceBindings(personal, {
    spaces: [personalSpace({ owner: "immakermatty", dir_name: "immakermatty_GEN3" })],
  })).toThrow("is not mounted");
  expect(() => validateHostedWorkspaceBindings(personal, {
    organizations: [{ slug: "ExampleOrg", teams: [{ slug: "builders" }] }],
  })).toThrow("is not mounted");
  expect(() => validateHostedWorkspaceBindings(personal, {
    spaces: [personalSpace({ config_valid: false })],
  })).toThrow("invalid personal.gen3.json");
});
