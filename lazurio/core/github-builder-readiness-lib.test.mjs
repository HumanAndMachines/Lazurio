import { expect, test } from "bun:test";

import {
  ORGANIZATION_INSTALL_ROLES,
  githubRoleReadinessUnavailable,
  isValidGitHubRoleReadiness,
  observeGitHubRoleReadiness,
} from "./github-builder-readiness-lib.mjs";
import { hostedInstallSlotScope } from "../organization-install-lib.mjs";
import { createHostedWorkspaceConfiguration } from "../runtime/hosted-app-url-lib.mjs";

const organization = Object.freeze({ id: "314957563", login: "ExampleOrganization" });
const rootRepository = Object.freeze({
  id: "42424242",
  full_name: "ExampleOrganization/ExampleOrganization_GEN3",
});
const account = Object.freeze({ id: 51515151, login: "builder-account" });

test("Builder readiness is GitHub's effective WRITE, not Team membership or Team grants", () => {
  const calls = [];
  const resource = resourceFixture();
  // Team declarations and bindings are manifest metadata, never a gate input.
  delete resource.teams[0].forge_binding;
  const report = observeGitHubRoleReadiness({
    role: "builder",
    provider: providerFixture({ permission: "write", calls }),
    organization,
    rootRepository,
    resource,
  });

  expect(report.status).toBe("ready");
  expect(report.blockers).toEqual([]);
  expect(report.account).toEqual({ id: String(account.id), login: account.login });
  expect(report.repositories).toEqual([
    { full_name: "ExampleOrganization/ExampleOrganization_GEN3", repository_id: rootRepository.id, effective_permission: "write", team_grants: [] },
    { full_name: "ExampleOrganization/knowledgebase", repository_id: "71717171", effective_permission: "write", team_grants: [] },
  ]);
  // Report v0 keeps its shape with truthful values: nothing Team-related is observed.
  expect(report.organization_membership).toBeNull();
  expect(report.teams).toEqual([]);
  expect(calls).toEqual([
    "user",
    "repos/ExampleOrganization/ExampleOrganization_GEN3",
    "repos/ExampleOrganization/knowledgebase",
  ]);
  expect(isValidGitHubRoleReadiness(report)).toBe(true);
});

test("Builder readiness rejects effective READ on any covered repository", () => {
  const report = observeGitHubRoleReadiness({
    role: "builder",
    provider: providerFixture({ permission: "read" }),
    organization,
    rootRepository,
    resource: resourceFixture(),
  });

  expect(report.status).toBe("blocked");
  expect(report.blockers.filter((item) => item.reason === "repository_write_missing")).toHaveLength(2);
  expect(report.repositories.every((repository) => repository.effective_permission === "read")).toBe(true);
});

test("Builder readiness accepts MAINTAIN and ADMIN as WRITE or higher", () => {
  for (const permission of ["maintain", "admin"]) {
    const report = observeGitHubRoleReadiness({
      role: "builder",
      provider: providerFixture({ permission }),
      organization,
      rootRepository,
      resource: resourceFixture(),
    });
    expect(report.status).toBe("ready");
  }
});

test("Builder readiness fails closed when the signed-in account cannot be observed", () => {
  const report = observeGitHubRoleReadiness({
    role: "builder",
    provider: providerFixture({ permission: "write", failures: { account: 401 } }),
    organization,
    rootRepository,
    resource: resourceFixture(),
  });

  expect(report.status).toBe("blocked");
  expect(report.account).toBeNull();
  expect(report.blockers).toContainEqual(expect.objectContaining({ reason: "authenticated_account_unavailable" }));
});

test("Builder readiness reports a repository provider failure without inventing missing WRITE", () => {
  const report = observeGitHubRoleReadiness({
    role: "builder",
    provider: providerFixture({ permission: "write", failures: { repository: 403 } }),
    organization,
    rootRepository,
    resource: resourceFixture(),
  });

  expect(report.status).toBe("blocked");
  expect(report.repositories.every((item) => item.effective_permission === "unavailable")).toBe(true);
  expect(report.blockers.some((item) => item.reason === "repository_write_missing")).toBe(false);
  expect(report.blockers.some((item) => item.reason === "provider_observation_failed")).toBe(true);
});

test("Builder readiness keeps the root repository identity pinned", () => {
  const report = observeGitHubRoleReadiness({
    role: "builder",
    provider: providerFixture({ permission: "write" }),
    organization,
    rootRepository: { ...rootRepository, id: "43434343" },
    resource: resourceFixture(),
  });

  expect(report.status).toBe("blocked");
  expect(report.blockers).toContainEqual(expect.objectContaining({
    reason: "repository_identity_mismatch",
    repository: rootRepository.full_name,
  }));
});

function resourceFixture() {
  return {
    teams: [{
      slug: "workspace",
      display_name: "Builders",
      default: true,
      forge_binding: {
        schema_version: "lazurio.team-forge-binding.github.v0",
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
  permission,
  calls = [],
  failures = {},
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
      if (endpoint === "user") {
        if (failures.account) return failed(failures.account);
        return ok(account);
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
  expect(() => observeGitHubRoleReadiness({ role: "admin", provider: providerFixture({ permission: "write" }), organization, rootRepository, resource })).toThrow(/builder, steward/);
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
    provider: providerFixture({ permission: "write", calls }),
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
    provider: providerFixture({ permission: "write", calls }),
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

// Iotor-like Organization: a shared work Team, a business Team and personal
// Team slots of individual operators. Each hosted work Machine selects its
// operator's slot through LAZURIO_TEAM_ID.
const sharedModuleTeams = ["iotor-team", "management", "tereza", "jakub"];

function teamOrganizationResource() {
  return {
    teams: ["iotor-team", "management", "energo", "tereza", "jakub"]
      .map((slug) => ({ slug, default: slug === "iotor-team" })),
    repository_inventory: [
      moduleSlot("mission-control-app", "workspace/mission-control", sharedModuleTeams),
      repositoryDbSlot("mission-control-data", "workspace/mission-control/db"),
      moduleSlot("knowledgebase", "workspace/knowledgebase", sharedModuleTeams),
      moduleSlot("energo-offers", "workspace/energo-offers", ["energo"]),
      repositoryDbSlot("energo-offers-data", "workspace/energo-offers/db"),
      {
        path: "productionspace/firmware",
        slug: "firmware",
        status: "active",
        git: { url: "git@github.com:ExampleOrganization/firmware.git", branch: "main" },
      },
    ],
  };
}

function moduleSlot(slug, path, teams) {
  return {
    path,
    slug,
    status: "active",
    default_access: "expected",
    required_roles: ["*"],
    teams,
    git: { url: `git@github.com:ExampleOrganization/${slug}.git`, branch: "main" },
  };
}

function repositoryDbSlot(slug, path) {
  return {
    path,
    slug,
    status: "active",
    materialization: "repository_db_mount",
    source_of_truth: "repository-db:v3",
    git: { url: `git@github.com:ExampleOrganization/${slug}.git`, branch: "v3" },
  };
}

function hostedTeamScope(teamId) {
  return hostedInstallSlotScope(createHostedWorkspaceConfiguration({
    profile: "hosted",
    organizationSlug: "example-organization",
    teamId,
    domain: "example.lazurio.io",
    machine: "vm-01",
  }));
}

// GitHub's effective permission of the signed-in account per repository;
// anything unlisted is READ. How it was granted is invisible, as on GitHub.
function effectivePermissionProvider({ writable, calls = [] }) {
  const ids = new Map([[rootRepository.full_name, Number(rootRepository.id)]]);
  return {
    json(args) {
      const endpoint = args.at(-1);
      calls.push(endpoint);
      if (endpoint === "user") return ok(account);
      const fullName = /^repos\/(ExampleOrganization\/[^/]+)$/u.exec(endpoint)?.[1];
      if (!fullName) throw new Error(`Unexpected provider endpoint: ${endpoint}`);
      if (!ids.has(fullName)) ids.set(fullName, 72000000 + ids.size);
      return ok({
        id: ids.get(fullName),
        name: fullName.split("/")[1],
        full_name: fullName,
        owner: { id: Number(organization.id), login: organization.login },
        permissions: permissions(writable.includes(fullName) ? "write" : "read"),
      });
    },
  };
}

const personalMachineRepositories = [
  rootRepository.full_name,
  "ExampleOrganization/knowledgebase",
  "ExampleOrganization/mission-control-app",
  "ExampleOrganization/mission-control-data",
];

test("hosted personal Team Machine is ready with WRITE on exactly the repositories it materializes", () => {
  // The operator holds WRITE through the shared work Team only; membership in
  // the other declared Teams, including other people's personal ones, is
  // neither required nor read.
  const calls = [];
  const report = observeGitHubRoleReadiness({
    role: "builder",
    provider: effectivePermissionProvider({ writable: personalMachineRepositories, calls }),
    organization,
    rootRepository,
    resource: teamOrganizationResource(),
    slotInInstallScope: hostedTeamScope("tereza"),
  });

  expect(report.blockers).toEqual([]);
  expect(report.status).toBe("ready");
  expect(report.repositories.map((repository) => repository.full_name)).toEqual(personalMachineRepositories);
  expect(calls.some((endpoint) => endpoint.includes("/teams/") || endpoint.includes("/memberships/"))).toBe(false);
  expect(calls.some((endpoint) => /energo|firmware/u.test(endpoint))).toBe(false);
});

test("hosted personal Team Machine stays blocked without WRITE on a selected repository", () => {
  const report = observeGitHubRoleReadiness({
    role: "builder",
    provider: effectivePermissionProvider({ writable: [rootRepository.full_name] }),
    organization,
    rootRepository,
    resource: teamOrganizationResource(),
    slotInInstallScope: hostedTeamScope("tereza"),
  });

  expect(report.status).toBe("blocked");
  expect(report.blockers.map((item) => item.repository).sort()).toEqual([
    "ExampleOrganization/knowledgebase",
    "ExampleOrganization/mission-control-app",
    "ExampleOrganization/mission-control-data",
  ]);
  expect(report.blockers.every((item) => item.reason === "repository_write_missing")).toBe(true);
});

test("hosted Team Machine is not blocked by another Team's Modules it does not select", () => {
  const calls = [];
  const report = observeGitHubRoleReadiness({
    role: "builder",
    provider: effectivePermissionProvider({ writable: personalMachineRepositories, calls }),
    organization,
    rootRepository,
    resource: teamOrganizationResource(),
    slotInInstallScope: hostedTeamScope("iotor-team"),
  });

  expect(report.status).toBe("ready");
  expect(calls.some((endpoint) => /energo|firmware/u.test(endpoint))).toBe(false);
});

test("hosted scope never widens past restricted or malformed slots", () => {
  const calls = [];
  const resource = teamOrganizationResource();
  resource.repository_inventory.find((slot) => slot.slug === "knowledgebase").default_access = "restricted";
  resource.repository_inventory.push({
    ...moduleSlot("typo", "workspace/typo", ["tereza"]),
    default_access: "Expected",
  });
  const report = observeGitHubRoleReadiness({
    role: "builder",
    provider: effectivePermissionProvider({ writable: personalMachineRepositories, calls }),
    organization,
    rootRepository,
    resource,
    slotInInstallScope: hostedTeamScope("tereza"),
  });

  expect(report.status).toBe("ready");
  expect(calls.some((endpoint) => /knowledgebase|typo/u.test(endpoint))).toBe(false);
});

test("non-hosted role install keeps the full Organization scope", () => {
  const calls = [];
  const localScope = hostedInstallSlotScope(createHostedWorkspaceConfiguration());
  const report = observeGitHubRoleReadiness({
    role: "builder",
    provider: effectivePermissionProvider({ writable: personalMachineRepositories, calls }),
    organization,
    rootRepository,
    resource: teamOrganizationResource(),
    slotInInstallScope: localScope,
  });

  // Every active ordinary slot, including another Team's Module, its data and
  // productionspace, is still covered and must be writable.
  expect(report.status).toBe("blocked");
  expect(report.blockers.map((item) => item.repository).sort()).toEqual([
    "ExampleOrganization/energo-offers",
    "ExampleOrganization/energo-offers-data",
    "ExampleOrganization/firmware",
  ]);
  // Omitting the predicate is the same full scope.
  const unscoped = observeGitHubRoleReadiness({
    role: "builder",
    provider: effectivePermissionProvider({ writable: personalMachineRepositories }),
    organization,
    rootRepository,
    resource: teamOrganizationResource(),
  });
  expect(unscoped.repositories).toEqual(report.repositories);
});

test("Steward readiness follows the same effective WRITE rule without Team bindings", () => {
  const report = observeGitHubRoleReadiness({
    role: "steward",
    provider: effectivePermissionProvider({ writable: personalMachineRepositories }),
    organization,
    rootRepository,
    resource: teamOrganizationResource(),
    slotInInstallScope: hostedTeamScope("tereza"),
  });

  expect(report.status).toBe("ready");
  expect(report.blockers).toEqual([]);
});
