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

test("Builder readiness reports a Team provider failure without inventing an identity mismatch", () => {
  const report = observeGitHubBuilderReadiness({
    provider: providerFixture({
      teamMembership: "active",
      permission: "write",
      failures: { teamIdentity: 403 },
    }),
    organization,
    rootRepository,
    resource: resourceFixture(),
  });

  expect(report.status).toBe("blocked");
  expect(report.teams).toContainEqual(expect.objectContaining({
    internal_slug: "workspace",
    identity: "unavailable",
    membership: "not_evaluated",
  }));
  expect(report.blockers).toContainEqual(expect.objectContaining({
    reason: "provider_observation_failed",
    team: "workspace",
  }));
  expect(report.blockers.some((item) => item.reason === "team_identity_mismatch")).toBe(false);
});

test("Builder readiness keeps verified Team identity mismatch distinct from provider failure", () => {
  const report = observeGitHubBuilderReadiness({
    provider: providerFixture({
      teamMembership: "active",
      permission: "write",
      teamId: 99999999,
    }),
    organization,
    rootRepository,
    resource: resourceFixture(),
  });

  expect(report.teams).toContainEqual(expect.objectContaining({
    internal_slug: "workspace",
    identity: "mismatch",
  }));
  expect(report.blockers).toContainEqual(expect.objectContaining({
    reason: "team_identity_mismatch",
    team: "workspace",
  }));
  expect(report.blockers.some((item) => item.reason === "provider_observation_failed")).toBe(false);
});

test("Builder readiness distinguishes missing Team membership from an unavailable observation", () => {
  const missing = observeGitHubBuilderReadiness({
    provider: providerFixture({ teamMembership: "missing", permission: "write" }),
    organization,
    rootRepository,
    resource: resourceFixture(),
  });
  const unavailable = observeGitHubBuilderReadiness({
    provider: providerFixture({
      teamMembership: "active",
      permission: "write",
      failures: { teamMembership: 403 },
    }),
    organization,
    rootRepository,
    resource: resourceFixture(),
  });

  expect(missing.teams[0].membership).toBe("missing");
  expect(missing.blockers.some((item) => item.reason === "team_membership_missing")).toBe(true);
  expect(unavailable.teams[0].membership).toBe("unavailable");
  expect(unavailable.blockers.some((item) => item.reason === "provider_observation_failed")).toBe(true);
  expect(unavailable.blockers.some((item) => item.reason === "team_membership_missing")).toBe(false);
});

test("Builder readiness reports unavailable Organization membership without inventing a missing membership", () => {
  const report = observeGitHubBuilderReadiness({
    provider: providerFixture({
      teamMembership: "active",
      permission: "write",
      failures: { organizationMembership: 403 },
    }),
    organization,
    rootRepository,
    resource: resourceFixture(),
  });

  expect(report.organization_membership).toEqual({ state: "unavailable", role: null });
  expect(report.blockers.some((item) => item.reason === "provider_observation_failed")).toBe(true);
  expect(report.blockers.some((item) => item.reason === "organization_membership_missing")).toBe(false);
});

test("Builder readiness distinguishes repository and Team grant provider failures from missing WRITE", () => {
  const repositoryUnavailable = observeGitHubBuilderReadiness({
    provider: providerFixture({
      teamMembership: "active",
      permission: "write",
      failures: { repository: 403 },
    }),
    organization,
    rootRepository,
    resource: resourceFixture(),
  });
  const grantsUnavailable = observeGitHubBuilderReadiness({
    provider: providerFixture({
      teamMembership: "active",
      permission: "write",
      failures: { teamRepositories: 403 },
    }),
    organization,
    rootRepository,
    resource: resourceFixture(),
  });

  expect(repositoryUnavailable.repositories.every((item) => (
    item.effective_permission === "unavailable"
  ))).toBe(true);
  expect(repositoryUnavailable.blockers.some((item) => item.reason === "repository_write_missing")).toBe(false);
  expect(repositoryUnavailable.blockers.some((item) => item.reason === "provider_observation_failed")).toBe(true);
  expect(grantsUnavailable.repositories.every((item) => (
    item.team_grants.every((grant) => grant.permission === "unavailable")
  ))).toBe(true);
  expect(grantsUnavailable.blockers.some((item) => item.reason === "team_repository_write_missing")).toBe(false);
  expect(grantsUnavailable.blockers.some((item) => item.reason === "provider_observation_failed")).toBe(true);

  const grantMissing = observeGitHubBuilderReadiness({
    provider: providerFixture({
      teamMembership: "active",
      permission: "write",
      missingTeamRepository: "ExampleOrganization/knowledgebase",
    }),
    organization,
    rootRepository,
    resource: resourceFixture(),
  });
  expect(grantMissing.blockers).toContainEqual(expect.objectContaining({
    reason: "team_repository_write_missing",
    repository: "ExampleOrganization/knowledgebase",
  }));
  expect(grantMissing.blockers.some((item) => item.reason === "provider_observation_failed")).toBe(false);
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

function providerFixture({
  teamMembership,
  permission,
  calls = [],
  failures = {},
  teamId = 61616161,
  missingTeamRepository = null,
}) {
  const repositories = new Map([
    [rootRepository.full_name, { id: Number(rootRepository.id), name: "ExampleOrganization_GEN3" }],
    ["ExampleOrganization/knowledgebase", { id: 71717171, name: "knowledgebase" }],
  ]);
  return {
    json(args) {
      const endpoint = args.at(-1);
      calls.push(endpoint);
      if (endpoint === "user") return ok(account);
      if (endpoint === `orgs/${organization.login}/memberships/${account.login}`) {
        if (failures.organizationMembership) return failed(failures.organizationMembership);
        return ok({ state: "active", role: "member" });
      }
      if (endpoint === `orgs/${organization.login}/teams/builders`) {
        if (failures.teamIdentity) return failed(failures.teamIdentity);
        return ok({ id: teamId, slug: "builders" });
      }
      if (endpoint === `orgs/${organization.login}/teams/builders/memberships/${account.login}`) {
        if (failures.teamMembership) return failed(failures.teamMembership);
        return teamMembership === "active"
          ? ok({ state: "active", role: "member" })
          : { ok: false, httpStatus: 404, value: null };
      }
      if (endpoint === `orgs/${organization.login}/teams/builders/repos?per_page=100`) {
        if (failures.teamRepositories) return failed(failures.teamRepositories);
        return ok([
          [...repositories.entries()]
            .filter(([fullName]) => fullName !== missingTeamRepository)
            .map(([fullName, repository]) => ({
              ...repository,
              full_name: fullName,
              owner: { id: Number(organization.id), login: organization.login },
              permissions: permissions(permission),
              role_name: permission,
            })),
        ]);
      }
      for (const [fullName, repository] of repositories) {
        if (endpoint === `repos/${fullName}`) {
          if (failures.repository) return failed(failures.repository);
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

function failed(httpStatus) {
  return { ok: false, httpStatus, value: null };
}
