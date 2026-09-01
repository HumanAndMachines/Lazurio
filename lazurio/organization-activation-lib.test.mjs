import { expect, test } from "bun:test";

import {
  checkOrganizationActivation,
  renderHumanOrganizationActivation,
} from "./organization-activation-lib.mjs";

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

test("Builder activation check stops at the owner boundary without probing App installations", () => {
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
    },
  });
  expect(calls.map((call) => call.args[1]).filter(Boolean)).not.toContain(
    "orgs/Example/installations?per_page=100&page=1",
  );
});

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

function fixtureRunner({
  calls = [],
  root,
  appSelection,
  viewerIsOwner = true,
  appInstallationPage = 1,
  appInstallationFailurePage = null,
  selectedAccess = "included",
  malformedCanonical = false,
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
      return ok({
        state: "active",
        role: viewerIsOwner ? "admin" : "member",
        organization: { id: 314957563, login: "Example" },
      });
    }
    if (endpoint === "repos/Example/Example_GEN3") {
      if (root === "absent") return httpError(404);
      return ok({
        id: 42424242,
        name: "Example_GEN3",
        full_name: "Example/Example_GEN3",
        default_branch: "main",
        permissions: { admin: true, push: true },
      });
    }
    if (endpoint === "orgs/Example/repos?type=all&per_page=100&page=1") return ok([]);
    if (endpoint === "repos/Example/Example_GEN3/commits?per_page=1") {
      return root === "empty" ? httpError(409) : ok([{ sha: "a".repeat(40) }]);
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
      return ok({ repositories: selectedAccess === "included" ? [{ id: 42424242 }] : [] });
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
