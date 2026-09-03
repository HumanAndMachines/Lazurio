import { expect, test } from "bun:test";

import {
  GITHUB_TEAM_FORGE_BINDING_SCHEMA,
  observeGitHubBuilderReadiness,
} from "./github-builder-readiness-lib.mjs";

const organization = Object.freeze({ id: "314957563", login: "ExampleOrganization" });
const rootRepository = Object.freeze({
  id: "42424242",
  full_name: "ExampleOrganization/ExampleOrganization_GEN3",
});
const account = Object.freeze({ id: 51515151, login: "builder-account" });

test("Builder readiness distinguishes active Organization membership from missing Team membership", () => {
  const provider = providerFixture({ teamMembership: "missing", permission: "write" });
  const report = observeGitHubBuilderReadiness({
    provider,
    organization,
    rootRepository,
    resource: resourceFixture(),
  });

  expect(report.status).toBe("blocked");
  expect(report.organization_membership).toEqual({ state: "active", role: "member" });
  expect(report.teams).toContainEqual(expect.objectContaining({
    internal_slug: "workspace",
    github_team_slug: "builders",
    identity: "verified",
    membership: "missing",
  }));
  expect(report.blockers).toContainEqual(expect.objectContaining({
    reason: "team_membership_missing",
    team: "workspace",
  }));
});

test("Builder readiness rejects READ even when Team membership is active", () => {
  const report = observeGitHubBuilderReadiness({
    provider: providerFixture({ teamMembership: "active", permission: "read" }),
    organization,
    rootRepository,
    resource: resourceFixture(),
  });

  expect(report.status).toBe("blocked");
  expect(report.blockers.filter((item) => item.reason === "repository_write_missing")).toHaveLength(2);
  expect(report.blockers.filter((item) => item.reason === "team_repository_write_missing")).toHaveLength(2);
  expect(report.repositories.every((repository) => repository.effective_permission === "read")).toBe(true);
});

test("Builder readiness accepts Team and effective WRITE on active Builder repositories only", () => {
  const calls = [];
  const report = observeGitHubBuilderReadiness({
    provider: providerFixture({ teamMembership: "active", permission: "write", calls }),
    organization,
    rootRepository,
    resource: resourceFixture(),
  });

  expect(report.status).toBe("ready");
  expect(report.blockers).toEqual([]);
  expect(report.repositories.map((repository) => repository.full_name)).toEqual([
    "ExampleOrganization/ExampleOrganization_GEN3",
    "ExampleOrganization/knowledgebase",
  ]);
  expect(calls.some((endpoint) => endpoint.includes("/infra"))).toBe(false);
  expect(calls.some((endpoint) => endpoint.includes("/admin-only"))).toBe(false);
  expect(report.repositories.every((repository) => (
    repository.effective_permission === "write"
    && repository.team_grants.every((grant) => grant.permission === "write")
  ))).toBe(true);
});

test("Builder readiness fails closed when an internal Team lacks immutable GitHub binding", () => {
  const calls = [];
  const resource = resourceFixture();
  delete resource.teams[0].forge_binding;
  const report = observeGitHubBuilderReadiness({
    provider: providerFixture({ teamMembership: "active", permission: "write", calls }),
    organization,
    rootRepository,
    resource,
  });

  expect(report.status).toBe("blocked");
  expect(report.blockers).toContainEqual(expect.objectContaining({
    reason: "team_forge_binding_missing",
    team: "workspace",
  }));
  expect(calls.some((endpoint) => endpoint.includes("/teams/"))).toBe(false);
});

function resourceFixture() {
  return {
    teams: [{
      slug: "workspace",
      display_name: "Builders",
      default: true,
      forge_binding: {
        schema_version: GITHUB_TEAM_FORGE_BINDING_SCHEMA,
        provider: "github",
        team: { id: "61616161", asserted_slug: "builders" },
      },
    }],
    repository_inventory: [
      {
        path: "workspace/knowledgebase",
        slug: "knowledgebase",
        status: "active",
        default_access: "expected",
        required_roles: ["*"],
        teams: ["workspace"],
        git: { url: "git@github.com:ExampleOrganization/knowledgebase.git", branch: "main" },
      },
      {
        path: "infra",
        slug: "infra",
        status: "planned_slot",
        default_access: "restricted",
        required_roles: ["organization-admin"],
      },
      {
        path: "workspace/admin-only",
        slug: "admin-only",
        status: "active",
        default_access: "restricted",
        required_roles: ["organization-admin"],
        teams: ["workspace"],
        git: { url: "git@github.com:ExampleOrganization/admin-only.git", branch: "main" },
      },
    ],
  };
}

function providerFixture({ teamMembership, permission, calls = [] }) {
  const repositories = new Map([
    [rootRepository.full_name, { id: Number(rootRepository.id), name: "ExampleOrganization_GEN3" }],
    ["ExampleOrganization/knowledgebase", { id: 71717171, name: "knowledgebase" }],
  ]);
  return {
    json(args) {
      const endpoint = args[1];
      calls.push(endpoint);
      if (endpoint === "user") return ok(account);
      if (endpoint === `orgs/${organization.login}/memberships/${account.login}`) {
        return ok({ state: "active", role: "member" });
      }
      if (endpoint === `orgs/${organization.login}/teams/builders`) {
        return ok({ id: 61616161, slug: "builders" });
      }
      if (endpoint === `orgs/${organization.login}/teams/builders/memberships/${account.login}`) {
        return teamMembership === "active"
          ? ok({ state: "active", role: "member" })
          : { ok: false, httpStatus: 404, value: null };
      }
      for (const [fullName, repository] of repositories) {
        if (endpoint === `repos/${fullName}`) {
          return ok({
            ...repository,
            full_name: fullName,
            owner: { id: Number(organization.id), login: organization.login },
            permissions: permissions(permission),
          });
        }
        if (endpoint === `orgs/${organization.login}/teams/builders/repos/${fullName}`) {
          return ok({
            ...repository,
            full_name: fullName,
            owner: { id: Number(organization.id), login: organization.login },
            permissions: permissions(permission),
          });
        }
      }
      throw new Error(`Unexpected provider endpoint: ${endpoint}`);
    },
  };
}

function permissions(permission) {
  return {
    admin: permission === "admin",
    maintain: permission === "maintain",
    push: ["write", "maintain", "admin"].includes(permission),
    triage: permission === "triage",
    pull: permission !== "none",
  };
}

function ok(value) {
  return { ok: true, httpStatus: 200, value };
}
