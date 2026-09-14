import { expect, test } from "bun:test";

import {
  GITHUB_TEAM_FORGE_BINDING_SCHEMA,
  ORGANIZATION_INSTALL_ROLES,
  githubRoleReadinessUnavailable,
  isValidGitHubRoleReadiness,
  observeGitHubRoleReadiness,
} from "./github-builder-readiness-lib.mjs";

const organization = Object.freeze({ id: "314957563", login: "ExampleOrganization" });
const rootRepository = Object.freeze({
  id: "42424242",
  full_name: "ExampleOrganization/ExampleOrganization_GEN3",
});
const account = Object.freeze({ id: 51515151, login: "builder-account" });

test("Builder readiness distinguishes active Organization membership from missing Team membership", () => {
  const provider = providerFixture({ teamMembership: "missing", permission: "write" });
  const report = observeGitHubRoleReadiness({
    role: "builder",
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
  const report = observeGitHubRoleReadiness({
    role: "builder",
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
  const report = observeGitHubRoleReadiness({
    role: "builder",
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
  const report = observeGitHubRoleReadiness({
    role: "builder",
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
  const report = observeGitHubRoleReadiness({
    role: "builder",
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
  const report = observeGitHubRoleReadiness({
    role: "builder",
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
  const missing = observeGitHubRoleReadiness({
    role: "builder",
    provider: providerFixture({ teamMembership: "missing", permission: "write" }),
    organization,
    rootRepository,
    resource: resourceFixture(),
  });
  const unavailable = observeGitHubRoleReadiness({
    role: "builder",
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
  const report = observeGitHubRoleReadiness({
    role: "builder",
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
  const repositoryUnavailable = observeGitHubRoleReadiness({
    role: "builder",
    provider: providerFixture({
      teamMembership: "active",
      permission: "write",
      failures: { repository: 403 },
    }),
    organization,
    rootRepository,
    resource: resourceFixture(),
  });
  const grantsUnavailable = observeGitHubRoleReadiness({
    role: "builder",
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

  const grantMissing = observeGitHubRoleReadiness({
    role: "builder",
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
  extraRepositories = {},
}) {
  const repositories = new Map([
    [rootRepository.full_name, { id: Number(rootRepository.id), name: "ExampleOrganization_GEN3" }],
    ["ExampleOrganization/knowledgebase", { id: 71717171, name: "knowledgebase" }],
    ...Object.entries(extraRepositories),
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

test("Steward readiness reuses the Builder gate over Steward-scoped ordinary repositories and never reads restricted slots", () => {
  const calls = [];
  const resource = resourceFixture();
  resource.repository_inventory.push({
    path: "workspace/steward-desk",
    slug: "steward-desk",
    status: "active",
    default_access: "role_based",
    required_roles: ["steward"],
    teams: ["workspace"],
    git: { url: "git@github.com:ExampleOrganization/steward-desk.git", branch: "main" },
  });
  const report = observeGitHubRoleReadiness({
    role: "steward",
    provider: providerFixture({
      teamMembership: "active",
      permission: "write",
      calls,
      extraRepositories: { "ExampleOrganization/steward-desk": { id: 81818181, name: "steward-desk" } },
    }),
    organization,
    rootRepository,
    resource,
  });

  expect(ORGANIZATION_INSTALL_ROLES).toEqual(["builder", "steward"]);
  expect(report.role).toBe("steward");
  expect(report.status).toBe("ready");
  expect(report.repositories.map((repository) => repository.full_name)).toEqual([
    "ExampleOrganization/ExampleOrganization_GEN3",
    "ExampleOrganization/knowledgebase",
    "ExampleOrganization/steward-desk",
  ]);
  expect(calls.some((endpoint) => endpoint.includes("/infra"))).toBe(false);
  expect(calls.some((endpoint) => endpoint.includes("/admin-only"))).toBe(false);
  expect(isValidGitHubRoleReadiness(report)).toBe(true);
  expect(isValidGitHubRoleReadiness({ ...report, role: "admin" })).toBe(false);
  expect(githubRoleReadinessUnavailable("steward", "github_auth_required", "login")).toMatchObject({
    role: "steward",
    status: "blocked",
    blockers: [{ reason: "github_auth_required" }],
  });
  expect(() => observeGitHubRoleReadiness({ role: "admin", provider: providerFixture({ teamMembership: "active", permission: "write" }), organization, rootRepository, resource })).toThrow(/builder, steward/);
});

test("role readiness never reads a repository whose access declaration is malformed", () => {
  const calls = [];
  const resource = resourceFixture();
  resource.repository_inventory.push({
    path: "workspace/typo",
    slug: "typo",
    status: "active",
    default_access: "Expected",
    required_roles: ["*"],
    teams: ["workspace"],
    git: { url: "git@github.com:ExampleOrganization/typo.git", branch: "main" },
  });
  const report = observeGitHubRoleReadiness({
    role: "builder",
    provider: providerFixture({ teamMembership: "active", permission: "write", calls }),
    organization,
    rootRepository,
    resource,
  });
  expect(report.status).toBe("ready");
  expect(calls.some((endpoint) => endpoint.includes("/typo"))).toBe(false);
});

test("role readiness never reads an ordinary repository declared below a restricted or malformed slot", () => {
  const calls = [];
  const resource = resourceFixture();
  resource.repository_inventory.push(
    {
      path: "mission-control",
      slug: "mission-control",
      status: "active",
      default_access: "restricted",
      required_roles: ["organization-admin"],
      git: { url: "git@github.com:ExampleOrganization/mission-control.git", branch: "main" },
    },
    {
      path: "mission-control/db",
      slug: "mission-control-data",
      status: "active",
      required_roles: ["*"],
      materialization: "repository_db_mount",
      git: { url: "git@github.com:ExampleOrganization/mission-control-data.git", branch: "main" },
    },
    {
      path: "typo-parent",
      slug: "typo-parent",
      status: "active",
      default_access: "expected",
      required_roles: "organization-admin",
      git: { url: "git@github.com:ExampleOrganization/typo-parent.git", branch: "main" },
    },
    {
      path: "typo-parent/child",
      slug: "typo-child",
      status: "active",
      default_access: "expected",
      required_roles: ["*"],
      git: { url: "git@github.com:ExampleOrganization/typo-child.git", branch: "main" },
    },
  );
  const report = observeGitHubRoleReadiness({
    role: "steward",
    provider: providerFixture({ teamMembership: "active", permission: "write", calls }),
    organization,
    rootRepository,
    resource,
  });
  expect(report.status).toBe("ready");
  expect(report.repositories.map((repository) => repository.full_name)).toEqual([
    "ExampleOrganization/ExampleOrganization_GEN3",
    "ExampleOrganization/knowledgebase",
  ]);
  expect(calls.filter((endpoint) => /mission-control|typo/u.test(endpoint))).toEqual([]);
});

test("Steward readiness proves membership and effective capability without any business Team forge binding", () => {
  const calls = [];
  const resource = resourceFixture();
  // Logické business Teamy bez immutable provider vazby: Builder gate je
  // vyžaduje, Steward gate ne.
  delete resource.teams[0].forge_binding;
  resource.teams.push({ slug: "sales", display_name: "Sales" });
  resource.repository_inventory[0].teams = ["workspace", "sales"];
  const ready = observeGitHubRoleReadiness({
    role: "steward",
    provider: providerFixture({ teamMembership: "missing", permission: "maintain", calls }),
    organization,
    rootRepository,
    resource,
  });

  expect(ready.status).toBe("ready");
  expect(ready.blockers).toEqual([]);
  expect(ready.teams).toEqual([]);
  expect(ready.organization_membership).toEqual({ state: "active", role: "member" });
  expect(ready.repositories).toEqual([
    expect.objectContaining({ full_name: "ExampleOrganization/ExampleOrganization_GEN3", effective_permission: "maintain", team_grants: [] }),
    expect.objectContaining({ full_name: "ExampleOrganization/knowledgebase", effective_permission: "maintain", team_grants: [] }),
  ]);
  expect(calls.some((endpoint) => endpoint.includes("/teams/"))).toBe(false);
  expect(calls.some((endpoint) => endpoint.includes("/infra") || endpoint.includes("/admin-only"))).toBe(false);

  const builder = observeGitHubRoleReadiness({
    role: "builder",
    provider: providerFixture({ teamMembership: "active", permission: "maintain" }),
    organization,
    rootRepository,
    resource,
  });
  expect(builder.status).toBe("blocked");
  expect(builder.blockers.map((item) => item.reason)).toContain("team_forge_binding_missing");
});

test("Steward readiness still fails closed on READ, inactive membership and provider failures", () => {
  const resource = resourceFixture();
  delete resource.teams[0].forge_binding;
  const read = observeGitHubRoleReadiness({
    role: "steward",
    provider: providerFixture({ teamMembership: "active", permission: "read" }),
    organization,
    rootRepository,
    resource,
  });
  expect(read.status).toBe("blocked");
  expect(read.blockers.map((item) => item.reason)).toEqual(["repository_write_missing", "repository_write_missing"]);

  const inactive = observeGitHubRoleReadiness({
    role: "steward",
    provider: providerFixture({ teamMembership: "active", permission: "write", failures: { organizationMembership: 404 } }),
    organization,
    rootRepository,
    resource,
  });
  expect(inactive.status).toBe("blocked");
  expect(inactive.blockers.map((item) => item.reason)).toContain("organization_membership_missing");

  const unavailable = observeGitHubRoleReadiness({
    role: "steward",
    provider: providerFixture({ teamMembership: "active", permission: "write", failures: { repository: 503 } }),
    organization,
    rootRepository,
    resource,
  });
  expect(unavailable.status).toBe("blocked");
  expect(unavailable.blockers.map((item) => item.reason)).toContain("provider_observation_failed");
});
