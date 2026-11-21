import { expect, test } from "bun:test";

import {
  checkOrganizationActivation,
  renderHumanOrganizationActivation,
} from "./organization-activation-lib.mjs";
import {
  organizationLegacyProjectionHash,
  projectLegacyOrganizationManifest,
} from "./core/organization-activation-lib.mjs";

test("--check provider adapter uses read-only GitHub calls and reports absent root", () => {
  const calls = [];
  const report = checkOrganizationActivation({
    githubOrganizationId: "314957563",
    platform: "win32",
    environment: {
      SystemRoot: "C:\\Windows",
      USERPROFILE: "C:\\Users\\Example",
      GH_DEBUG: "api",
    },
    resolveGitHubCli: ({ platform }) => {
      expect(platform).toBe("win32");
      return "C:\\Program Files\\GitHub CLI\\gh.exe";
    },
    runGitHubCli: fixtureRunner({ calls, root: "absent", appSelection: "all" }),
  });

  expect(report).toMatchObject({
    execution: { status: "ok" },
    outcome: "needs_activation",
    reasons: ["root_repository_absent"],
    next_action: { kind: "run_activation" },
  });
  expect(report.observations.github).toEqual({
    principal: { id: "16311043", login: "example-owner" },
    organization: {
      id: "314957563",
      login: "Example",
      viewer_is_owner: true,
      viewer_can_create_repositories: true,
    },
  });
  expect(calls.length).toBeGreaterThan(0);
  for (const call of calls) {
    expect(call.executable).toBe("C:\\Program Files\\GitHub CLI\\gh.exe");
    expect(["api", "auth"]).toContain(call.args[0]);
    expect(call.args).not.toContain("--method");
    expect(call.args).not.toContain("--input");
    expect(call.args).not.toContain("-X");
    expect(call.environment.GH_DEBUG).toBeUndefined();
    expect(call.environment.GH_HOST).toBe("github.com");
    const query = call.args.find((arg) => arg.startsWith("query="));
    if (query) expect(query).not.toContain("mutation");
  }
});

test("supported legacy root becomes active when selected App access is observable", () => {
  const report = checkOrganizationActivation({
    githubOrganizationId: "314957563",
    resolveGitHubCli: () => "/usr/bin/gh",
    runGitHubCli: fixtureRunner({ root: "legacy", appSelection: "selected", selectedAccess: "included" }),
  });

  expect(report).toMatchObject({
    outcome: "active",
    reasons: ["root_supported_legacy"],
    observations: {
      github_app: { repository_selection: "selected", root_access: "included" },
      root_repository: { resolver: { status: "supported", format: "legacy" } },
    },
  });
});

test("standard gh OAuth limitation stays an explicit selected-scope action", () => {
  const report = checkOrganizationActivation({
    githubOrganizationId: "314957563",
    resolveGitHubCli: () => "/usr/bin/gh",
    runGitHubCli: fixtureRunner({ root: "legacy", appSelection: "selected", selectedAccess: "unobservable" }),
  });

  expect(report).toMatchObject({
    execution: { status: "ok" },
    outcome: "action_required",
    reasons: ["github_app_root_access_unverified"],
    next_action: { kind: "verify_root_repository_access" },
  });
  expect(renderHumanOrganizationActivation(report)).toContain("selected");
});

test("Builder activation check stops at the owner boundary without probing private root or App", () => {
  const calls = [];
  const report = checkOrganizationActivation({
    githubOrganizationId: "314957563",
    resolveGitHubCli: () => "/usr/bin/gh",
    runGitHubCli: fixtureRunner({
      calls,
      root: "legacy",
      appSelection: "all",
      viewerIsOwner: false,
    }),
  });

  expect(report).toMatchObject({
    execution: { status: "ok" },
    outcome: "action_required",
    reasons: ["github_organization_owner_required"],
    next_action: { kind: "request_organization_owner" },
    observations: {
      github: { organization: { viewer_is_owner: false } },
      github_app: { status: "unobservable" },
      root_repository: { presence: "unobservable" },
    },
  });
  const endpoints = calls.map((call) => call.args[1]).filter(Boolean);
  expect(endpoints.some((endpoint) => endpoint.startsWith("repos/Example/"))).toBe(false);
  expect(endpoints.some((endpoint) => endpoint.startsWith("orgs/Example/repos?"))).toBe(false);
  expect(endpoints).not.toContain("orgs/Example/installations?per_page=100&page=1");
});

for (const membershipStatus of [403, 404]) {
  test(`unobservable membership HTTP ${membershipStatus} never becomes non-ownership`, () => {
    const calls = [];
    const report = checkOrganizationActivation({
      githubOrganizationId: "314957563",
      resolveGitHubCli: () => "/usr/bin/gh",
      runGitHubCli: fixtureRunner({
        calls,
        root: "legacy",
        appSelection: "all",
        membershipStatus,
      }),
    });

    expect(report).toMatchObject({
      execution: {
        status: "error",
        error: { code: "github_access_denied", retryable: false },
      },
      next_action: { kind: "refresh_github_permissions" },
    });
    expect(report).not.toHaveProperty("outcome");
    expect(report).not.toHaveProperty("observations");
    const endpoints = calls.map((call) => call.args[1]).filter(Boolean);
    expect(endpoints.some((endpoint) => endpoint.startsWith("repos/Example/"))).toBe(false);
    expect(endpoints.some((endpoint) => endpoint.startsWith("orgs/Example/repos?"))).toBe(false);
    expect(endpoints).not.toContain("orgs/Example/installations?per_page=100&page=1");
  });
}

test("GitHub App lookup follows installation pagination", () => {
  const calls = [];
  const report = checkOrganizationActivation({
    githubOrganizationId: "314957563",
    resolveGitHubCli: () => "/usr/bin/gh",
    runGitHubCli: fixtureRunner({
      calls,
      root: "legacy",
      appSelection: "all",
      appInstallationPage: 2,
    }),
  });

  expect(report).toMatchObject({
    execution: { status: "ok" },
    outcome: "active",
    observations: {
      github_app: { status: "installed", repository_selection: "all" },
    },
  });
  expect(calls.map((call) => call.args[1])).toContain(
    "orgs/Example/installations?per_page=100&page=2",
  );
});

test("later-page App lookup failure stays a retryable technical error", () => {
  const report = checkOrganizationActivation({
    githubOrganizationId: "314957563",
    resolveGitHubCli: () => "/usr/bin/gh",
    runGitHubCli: fixtureRunner({
      root: "legacy",
      appSelection: "all",
      appInstallationPage: 3,
      appInstallationFailurePage: 2,
    }),
  });

  expect(report).toMatchObject({
    execution: {
      status: "error",
      error: { code: "github_transport_failed", retryable: true },
    },
    next_action: { kind: "retry" },
  });
  expect(report).not.toHaveProperty("outcome");
  expect(report).not.toHaveProperty("observations");
});

test("transport failure returns an error envelope without an outcome", () => {
  const report = checkOrganizationActivation({
    githubOrganizationId: "314957563",
    resolveGitHubCli: () => "/usr/bin/gh",
    runGitHubCli: ({ args }) => args[0] === "auth"
      ? { status: 0, stdout: "", stderr: "" }
      : { status: 1, stdout: "", stderr: "offline" },
  });

  expect(report).toMatchObject({
    execution: {
      status: "error",
      error: { code: "github_transport_failed", retryable: true },
    },
    next_action: { kind: "retry" },
  });
  expect(report).not.toHaveProperty("outcome");
  expect(renderHumanOrganizationActivation(report)).toContain("technická chyba");
});

test("missing gh login is an authentication action, not a transport retry", () => {
  const report = checkOrganizationActivation({
    githubOrganizationId: "314957563",
    resolveGitHubCli: () => "/usr/bin/gh",
    runGitHubCli: ({ args }) => args[0] === "auth"
      ? { status: 1, stdout: "", stderr: "not logged in" }
      : (() => { throw new Error("API must not run before auth succeeds"); })(),
  });

  expect(report).toMatchObject({
    execution: {
      status: "error",
      error: { code: "github_auth_required", retryable: false },
    },
    next_action: { kind: "authenticate_github" },
  });
  expect(report).not.toHaveProperty("outcome");
});

test("HTTP status from gh stderr still classifies an absent repository", () => {
  const base = fixtureRunner({ root: "absent", appSelection: "all" });
  const report = checkOrganizationActivation({
    githubOrganizationId: "314957563",
    resolveGitHubCli: () => "/usr/bin/gh",
    runGitHubCli: (call) => call.args[1] === "repos/Example/Example_GEN3"
      ? { status: 1, stdout: "", stderr: "gh: Not Found (HTTP 404)" }
      : base(call),
  });

  expect(report).toMatchObject({
    execution: { status: "ok" },
    outcome: "needs_activation",
    reasons: ["root_repository_absent"],
  });
});

test("present malformed canonical manifest blocks a legacy active result", () => {
  const report = checkOrganizationActivation({
    githubOrganizationId: "314957563",
    resolveGitHubCli: () => "/usr/bin/gh",
    runGitHubCli: fixtureRunner({
      root: "legacy",
      appSelection: "all",
      malformedCanonical: true,
    }),
  });

  expect(report).toMatchObject({
    execution: { status: "ok" },
    outcome: "action_required",
    reasons: ["root_manifest_unsupported"],
    observations: {
      root_repository: {
        resolver: { status: "unsupported", reason: "canonical_resolver_unavailable" },
      },
    },
  });
});

test("unbound legacy root stays active after its parity-valid migration to transition", () => {
  const modules = {
    organization_generation: "gen3",
    company: "Example",
    github_org: "Example",
    module_slots: [],
  };
  const canonical = {
    schema_version: "lazurio.organization.v1",
    kind: "organization",
    organization: {
      slug: "Example",
      display_name: "Example",
      forge_binding: { forge: "github", locator: "Example", binding_state: "unverified" },
      metadata: {},
    },
    root_repository: null,
    manifests: { modules: "modules.manifest.json" },
    extensions: { legacy: {} },
    compatibility: {
      legacy_projection: {
        path: "company.gen3.json",
        algorithm: "sha256-canonical-json-v1",
        sha256: `sha256:${"0".repeat(64)}`,
      },
    },
  };
  canonical.compatibility.legacy_projection.sha256 = organizationLegacyProjectionHash(canonical, modules);
  const company = projectLegacyOrganizationManifest(canonical, modules);
  const check = (rootDocuments) => checkOrganizationActivation({
    githubOrganizationId: "314957563",
    resolveGitHubCli: () => "/usr/bin/gh",
    runGitHubCli: fixtureRunner({ root: "legacy", appSelection: "all", rootDocuments }),
  });

  expect(check({ company, modules, canonical: null })).toMatchObject({
    outcome: "active",
    reasons: ["root_supported_legacy"],
  });
  expect(check({ company, modules, canonical })).toMatchObject({
    outcome: "active",
    reasons: ["root_supported_transition"],
    observations: {
      root_repository: {
        resolver: { status: "supported", format: "transition", reason: "transition_identity_pair_supported" },
      },
    },
  });
  const renamed = structuredClone(canonical);
  renamed.organization.forge_binding.locator = "Foreign";
  const renamedModules = { ...modules, github_org: "Foreign" };
  renamed.compatibility.legacy_projection.sha256 = organizationLegacyProjectionHash(renamed, renamedModules);
  expect(check({
    company: projectLegacyOrganizationManifest(renamed, renamedModules),
    modules: renamedModules,
    canonical: renamed,
  })).toMatchObject({
    outcome: "action_required",
    reasons: ["root_manifest_unsupported"],
  });
});

function fixtureRunner({
  calls = [],
  root,
  appSelection,
  viewerIsOwner = true,
  appInstallationPage = 1,
  appInstallationFailurePage = null,
  membershipStatus = null,
  selectedAccess = "included",
  malformedCanonical = false,
  rootDocuments = null,
  gen4 = null,
  otherRepositories = [],
}) {
  return (call) => {
    calls.push(call);
    if (call.args[0] === "auth") return { status: 0, stdout: "", stderr: "" };
    const endpoint = call.args[1];
    if (endpoint === "user") return ok({ id: 16311043, login: "example-owner" });
    if (endpoint === "organizations/314957563") return ok({ id: 314957563, login: "Example" });
    if (endpoint === "graphql") {
      return ok({
        data: {
          viewer: { databaseId: 16311043, login: "example-owner" },
          organization: {
            databaseId: 314957563,
            login: "Example",
            viewerCanAdminister: viewerIsOwner,
            viewerCanCreateRepositories: viewerIsOwner,
          },
        },
      });
    }
    if (endpoint === "user/memberships/orgs/Example") {
      if (membershipStatus !== null) return httpError(membershipStatus);
      return ok({
        state: "active",
        role: viewerIsOwner ? "admin" : "member",
        organization: { id: 314957563, login: "Example" },
      });
    }
    // The GEN4 candidate (LZD-0041 G1): absent unless a test declares it.
    if (endpoint === "repos/Example/Example_GEN4") {
      if (gen4 === null) return httpError(404);
      return ok({
        id: gen4.id ?? 52525252,
        name: gen4.name ?? "Example_GEN4",
        full_name: `Example/${gen4.name ?? "Example_GEN4"}`,
        default_branch: "main",
        permissions: { admin: true, push: true },
      });
    }
    if (endpoint === "repos/Example/Example_GEN4/commits?per_page=1") {
      return gen4?.empty ? httpError(409) : ok([{ sha: "b".repeat(40) }]);
    }
    if (endpoint?.startsWith("repos/Example/Example_GEN4/contents/")) {
      const path = ["company.gen3.json", "modules.manifest.json", "lazurio.organization.json"]
        .find((candidate) => endpoint.includes(`contents/${candidate}`));
      const document = {
        "company.gen3.json": gen4.documents.company,
        "modules.manifest.json": gen4.documents.modules,
        "lazurio.organization.json": gen4.documents.canonical,
      }[path];
      return document === null || document === undefined ? httpError(404) : content(document);
    }
    if (endpoint === "repos/Example/Example_GEN3") {
      if (root === "absent") return httpError(404);
      if (root === "redirect_gen4") {
        return ok({
          id: 52525252,
          name: "Example_GEN4",
          full_name: "Example/Example_GEN4",
          default_branch: "main",
          permissions: { admin: true, push: true },
        });
      }
      return ok({
        id: 42424242,
        name: "Example_GEN3",
        full_name: "Example/Example_GEN3",
        default_branch: "main",
        permissions: { admin: true, push: true },
      });
    }
    if (endpoint === "orgs/Example/repos?type=all&per_page=100&page=1") {
      return ok(otherRepositories.map((name) => ({ name })));
    }
    if (endpoint === "repos/Example/Example_GEN3/commits?per_page=1") {
      return root === "empty" ? httpError(409) : ok([{ sha: "a".repeat(40) }]);
    }
    if (rootDocuments !== null) {
      const path = ["company.gen3.json", "modules.manifest.json", "lazurio.organization.json"]
        .find((candidate) => endpoint?.includes(`contents/${candidate}`));
      const document = {
        "company.gen3.json": rootDocuments.company,
        "modules.manifest.json": rootDocuments.modules,
        "lazurio.organization.json": rootDocuments.canonical,
      }[path];
      if (path) return document === null ? httpError(404) : content(document);
    }
    if (endpoint?.includes("contents/company.gen3.json")) {
      return content({
        organization_generation: "gen3",
        organization_kind: "organization",
        company: {
          slug: "Example",
          github_org: "Example",
          root_repository: "Example/Example_GEN3",
        },
      });
    }
    if (endpoint?.includes("contents/modules.manifest.json")) {
      return content({
        organization_generation: "gen3",
        company: "Example",
        github_org: "Example",
        module_slots: [],
      });
    }
    if (endpoint?.includes("contents/lazurio.organization.json")) {
      return malformedCanonical
        ? ok({ encoding: "base64", content: Buffer.from("{broken", "utf8").toString("base64") })
        : httpError(404);
    }
    const installationPage = endpoint?.match(/^orgs\/Example\/installations\?per_page=100&page=(\d+)$/u);
    if (installationPage) {
      const page = Number.parseInt(installationPage[1], 10);
      if (page === appInstallationFailurePage) return httpError(403);
      if (page < appInstallationPage) {
        return ok({
          total_count: 100 * appInstallationPage,
          installations: Array.from({ length: 100 }, (_, index) => ({
            id: page * 1000 + index,
            app_slug: `unrelated-app-${page}-${index}`,
            repository_selection: "all",
            target_id: 314957563,
            target_type: "Organization",
          })),
        });
      }
      return ok({
        total_count: (appInstallationPage - 1) * 100 + 1,
        installations: [{
          id: 155781771,
          app_slug: "lazurio-for-github",
          repository_selection: appSelection,
          target_id: 314957563,
          target_type: "Organization",
        }],
      });
    }
    if (endpoint === "user/installations/155781771/repositories?per_page=100&page=1") {
      if (selectedAccess === "unobservable") return httpError(403);
      return ok({ repositories: selectedAccess === "included" ? [{ id: 42424242 }, { id: 52525252 }] : [] });
    }
    throw new Error(`Unexpected fixture call: ${call.args.join(" ")}`);
  };
}

function ok(value) {
  return { status: 0, stdout: JSON.stringify(value), stderr: "" };
}

function httpError(status) {
  return {
    status: 1,
    stdout: JSON.stringify({ message: "fixture", status: String(status) }),
    stderr: `HTTP ${status}`,
  };
}

function content(value) {
  return ok({
    encoding: "base64",
    content: Buffer.from(`${JSON.stringify(value)}\n`, "utf8").toString("base64"),
  });
}

// LZD-0041 G1: the root is `<login>_GEN4` or `<login>_GEN3`, chosen by its own
// declaration, never by the suffix; with both declared, GEN4 wins.
function exampleModules() {
  return { organization_generation: "gen3", company: "Example", github_org: "Example", module_slots: [] };
}

// A clean GEN4 root: canonical manifest and modules only, no compatibility
// block, no company.gen3.json.
function cleanCanonical(locator) {
  return {
    schema_version: "lazurio.organization.v1",
    kind: "organization",
    organization: {
      slug: "Example",
      display_name: "Example",
      forge_binding: { forge: "github", locator: "Example", binding_state: "unverified" },
      metadata: {},
    },
    root_repository: { forge: "github", locator, default_branch: "main", binding_state: "unverified" },
    manifests: { modules: "modules.manifest.json" },
    extensions: { legacy: {} },
  };
}

function legacyDeclaring(locator) {
  return {
    organization_generation: "gen3",
    organization_kind: "organization",
    company: { slug: "Example", github_org: "Example", root_repository: locator },
  };
}

function activationWith(options) {
  return checkOrganizationActivation({
    githubOrganizationId: "314957563",
    resolveGitHubCli: () => "/usr/bin/gh",
    runGitHubCli: fixtureRunner({ appSelection: "all", ...options }),
  });
}

test("G1: an Organization with only a clean GEN4 root activates it as current", () => {
  const report = activationWith({
    root: "absent",
    gen4: { documents: { company: null, modules: exampleModules(), canonical: cleanCanonical("Example/Example_GEN4") } },
  });
  expect(report).toMatchObject({
    outcome: "active",
    reasons: ["root_supported_current"],
    observations: {
      root_repository: {
        presence: "present",
        name: "Example_GEN4",
        full_name: "Example/Example_GEN4",
        id: "52525252",
        resolver: { status: "supported", format: "current", reason: "current_identity_pair_supported" },
      },
    },
  });
});

test("G1: only GEN3 behaves exactly as before and never probes past the two candidates", () => {
  const calls = [];
  const report = activationWith({ calls, root: "legacy" });
  expect(report).toMatchObject({
    outcome: "active",
    reasons: ["root_supported_legacy"],
    observations: { root_repository: { name: "Example_GEN3", full_name: "Example/Example_GEN3", id: "42424242" } },
  });
  const repositoryProbes = calls.map((call) => call.args[1]).filter((endpoint) => /^repos\/Example\/[^/]+$/u.test(endpoint ?? ""));
  expect(repositoryProbes).toEqual(["repos/Example/Example_GEN4", "repos/Example/Example_GEN3"]);
});

test("G1: a GEN4 copy whose data still declare GEN3 leaves GEN3 the root", () => {
  const report = activationWith({
    root: "legacy",
    gen4: { documents: { company: legacyDeclaring("Example/Example_GEN3"), modules: exampleModules(), canonical: null } },
  });
  expect(report.observations.root_repository).toMatchObject({ full_name: "Example/Example_GEN3", id: "42424242" });
  expect(report.outcome).toBe("active");
});

test("G1: when both repositories declare themselves the root, GEN4 wins", () => {
  const report = activationWith({
    root: "legacy",
    rootDocuments: { company: legacyDeclaring("Example/Example_GEN3"), modules: exampleModules(), canonical: null },
    gen4: { documents: { company: null, modules: exampleModules(), canonical: cleanCanonical("Example/Example_GEN4") } },
  });
  expect(report).toMatchObject({
    outcome: "active",
    reasons: ["root_supported_current"],
    observations: { root_repository: { full_name: "Example/Example_GEN4", id: "52525252", candidate_count: 0 } },
  });
});

test("G1: a freshly created empty GEN4 never displaces a working GEN3", () => {
  const report = activationWith({ root: "legacy", gen4: { empty: true } });
  expect(report).toMatchObject({
    outcome: "active",
    observations: { root_repository: { full_name: "Example/Example_GEN3" } },
  });
});

test("G1: both repositories present and neither declaring itself fails closed as a root conflict", () => {
  const undeclared = { organization_generation: "gen3", organization_kind: "organization", company: { slug: "Example", github_org: "Example" } };
  const report = activationWith({
    root: "legacy",
    rootDocuments: { company: undeclared, modules: exampleModules(), canonical: null },
    gen4: { documents: { company: undeclared, modules: exampleModules(), canonical: null } },
  });
  expect(report).toMatchObject({
    outcome: "action_required",
    reasons: ["root_repository_conflict"],
    next_action: { kind: "inspect_existing_repository" },
    observations: { root_repository: { candidate_count: 1, resolver: { reason: "canonical_root_candidate_conflict" } } },
  });
});

test("G1: GitHub's rename redirect from GEN3 to GEN4 is the GEN4 candidate, not a conflict", () => {
  const report = activationWith({
    root: "redirect_gen4",
    gen4: { documents: { company: null, modules: exampleModules(), canonical: cleanCanonical("Example/Example_GEN4") } },
  });
  expect(report).toMatchObject({
    outcome: "active",
    observations: { root_repository: { full_name: "Example/Example_GEN4", candidate_count: 0 } },
  });
});

test("G1: without either own candidate, a foreign _GEN4 or _GEN3 repository stays a root conflict", () => {
  for (const name of ["Other_GEN4", "Other_GEN3"]) {
    expect(activationWith({ root: "absent", otherRepositories: [name] })).toMatchObject({
      outcome: "action_required",
      reasons: ["root_repository_conflict"],
    });
  }
  expect(activationWith({ root: "absent", otherRepositories: ["Example_GEN4", "Example_GEN3", "website"] })).toMatchObject({
    outcome: "needs_activation",
    reasons: ["root_repository_absent"],
  });
});
