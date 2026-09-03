import { githubRepositoryCoordinate } from "./organization-slot-scope-lib.mjs";

export const GITHUB_TEAM_FORGE_BINDING_SCHEMA = "lazurio.team-forge-binding.github.v0";

const positiveIdPattern = /^[1-9][0-9]{0,19}$/u;
const githubLoginPattern = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/u;
const githubTeamSlugPattern = /^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/u;

export function githubBuilderReadinessNotRequested() {
  return freeze({
    authority: "github",
    role: null,
    status: "not_requested",
    account: null,
    organization_membership: null,
    teams: [],
    repositories: [],
    blockers: [],
  });
}

export function githubBuilderReadinessUnavailable(reason, message) {
  return freeze({
    authority: "github",
    role: "builder",
    status: "blocked",
    account: null,
    organization_membership: null,
    teams: [],
    repositories: [],
    blockers: [blocker(
      reason ?? "provider_observation_failed",
      message ?? "Builder access nešlo ověřit čerstvými GitHub provider daty.",
    )],
  });
}

export function observeGitHubBuilderReadiness({
  provider,
  organization,
  rootRepository,
  resource,
} = {}) {
  if (!provider?.json || !organization?.id || !organization?.login || !rootRepository?.full_name) {
    throw new TypeError("Builder readiness requires a GitHub provider and verified Organization identity.");
  }

  const plan = builderAccessPlan({ organization, rootRepository, resource });
  const blockers = [...plan.blockers];
  const account = observeAccount(provider, blockers);
  const organizationMembership = account
    ? observeOrganizationMembership(provider, organization, account, blockers)
    : null;
  const teamObservations = plan.teams.map((team) => (
    observeTeam(provider, organization, account, team, blockers)
  ));
  const teamByInternalSlug = new Map(teamObservations.map((team) => [team.internal_slug, team]));
  const repositories = plan.repositories.map((repository) => (
    observeRepository(provider, organization, repository, teamByInternalSlug, blockers)
  ));

  return freeze({
    authority: "github",
    role: "builder",
    status: blockers.length === 0 ? "ready" : "blocked",
    account,
    organization_membership: organizationMembership,
    teams: teamObservations,
    repositories,
    blockers,
  });
}

export function isValidGitHubBuilderReadiness(value) {
  if (
    !isRecord(value)
    || value.authority !== "github"
    || ![null, "builder"].includes(value.role)
    || !["not_requested", "ready", "blocked"].includes(value.status)
    || !Array.isArray(value.teams)
    || !Array.isArray(value.repositories)
    || !Array.isArray(value.blockers)
  ) return false;
  if (value.status === "not_requested") {
    return value.role === null
      && value.account === null
      && value.organization_membership === null
      && value.teams.length === 0
      && value.repositories.length === 0
      && value.blockers.length === 0;
  }
  return value.role === "builder"
    && (value.account === null || validIdentity(value.account))
    && (value.organization_membership === null || isRecord(value.organization_membership))
    && (value.status === "ready") === (value.blockers.length === 0);
}

function builderAccessPlan({ organization, rootRepository, resource }) {
  const blockers = [];
  const teamDefinitions = Array.isArray(resource?.teams) ? resource.teams : [];
  const defaultTeams = teamDefinitions.filter((team) => team?.default === true);
  const fallbackWorkspace = teamDefinitions.filter((team) => team?.slug === "workspace");
  const defaultTeam = defaultTeams.length === 1
    ? defaultTeams[0]
    : defaultTeams.length === 0 && fallbackWorkspace.length === 1
      ? fallbackWorkspace[0]
      : null;
  if (!defaultTeam) {
    blockers.push(blocker(
      "default_team_ambiguous",
      "Organization manifest musí deklarovat právě jeden výchozí Team pro Builder root přístup.",
    ));
  }

  const repositories = new Map();
  addRepositoryPlan(repositories, blockers, {
    fullName: rootRepository.full_name,
    expectedId: rootRepository.id,
    teamSlugs: defaultTeam ? [defaultTeam.slug] : [],
    organization,
  });

  for (const slot of resource?.repository_inventory ?? []) {
    if (!isBuilderRepositorySlot(slot)) continue;
    const coordinate = githubRepositoryCoordinate(slot?.git?.url ?? slot?.repository ?? slot?.git_url);
    if (!coordinate || coordinate.owner.toLowerCase() !== organization.login.toLowerCase()) {
      blockers.push(blocker(
        "repository_binding_invalid",
        "Aktivní Builder repository slot nemá bezpečnou GitHub souřadnici v této Organizaci.",
        { repository: typeof slot?.slug === "string" ? slot.slug : null },
      ));
      continue;
    }
    const teamSlugs = Array.isArray(slot?.teams) && slot.teams.length > 0
      ? [...new Set(slot.teams)]
      : defaultTeam
        ? [defaultTeam.slug]
        : [];
    addRepositoryPlan(repositories, blockers, {
      fullName: coordinate.ownerRepo,
      expectedId: null,
      teamSlugs,
      organization,
    });
  }

  const referencedTeamSlugs = new Set(
    [...repositories.values()].flatMap((repository) => repository.team_slugs),
  );
  const teams = [...referencedTeamSlugs]
    .sort(compareText)
    .map((internalSlug) => {
      const definitions = teamDefinitions.filter((team) => team?.slug === internalSlug);
      const definition = definitions.length === 1 ? definitions[0] : null;
      if (!definition) {
        blockers.push(blocker(
          "team_definition_missing",
          `Interní Team '${internalSlug}' nemá právě jednu manifestovou definici.`,
          { team: internalSlug },
        ));
      }
      const binding = validTeamForgeBinding(definition?.forge_binding)
        ? definition.forge_binding
        : null;
      if (!binding) {
        blockers.push(blocker(
          "team_forge_binding_missing",
          `Team '${internalSlug}' nemá ověřenou vazbu na neměnné GitHub Team ID.`,
          { team: internalSlug },
        ));
      }
      return {
        internal_slug: internalSlug,
        github_team_id: binding?.team?.id ?? null,
        github_team_slug: binding?.team?.asserted_slug ?? null,
      };
    });

  return {
    teams,
    repositories: [...repositories.values()].sort((left, right) => compareText(left.full_name, right.full_name)),
    blockers,
  };
}

function isBuilderRepositorySlot(slot) {
  if (slot?.status !== "active") return false;
  if (slot?.default_access === "restricted") return false;
  const requiredRoles = Array.isArray(slot?.required_roles) ? slot.required_roles : [];
  return requiredRoles.length === 0
    || requiredRoles.includes("*")
    || requiredRoles.includes("builder");
}

function addRepositoryPlan(repositories, blockers, {
  fullName,
  expectedId,
  teamSlugs,
  organization,
}) {
  const coordinate = githubRepositoryCoordinate(fullName);
  if (!coordinate || coordinate.owner.toLowerCase() !== organization.login.toLowerCase()) {
    blockers.push(blocker(
      "repository_binding_invalid",
      "Builder repository nepatří do ověřené GitHub Organization.",
      { repository: fullName ?? null },
    ));
    return;
  }
  const key = coordinate.ownerRepo.toLowerCase();
  const existing = repositories.get(key);
  const mergedTeams = [...new Set([...(existing?.team_slugs ?? []), ...teamSlugs])].sort(compareText);
  repositories.set(key, {
    full_name: existing?.full_name ?? coordinate.ownerRepo,
    expected_id: existing?.expected_id ?? expectedId,
    team_slugs: mergedTeams,
  });
}

function observeAccount(provider, blockers) {
  const response = provider.json(["api", "user"]);
  const account = providerIdentity(response.value);
  if (!response.ok || !account) {
    blockers.push(blocker(
      "authenticated_account_unavailable",
      "GitHub provider nevrátil ověřitelný právě přihlášený účet.",
    ));
    return null;
  }
  return account;
}

function observeOrganizationMembership(provider, organization, account, blockers) {
  const response = provider.json([
    "api",
    `orgs/${organization.login}/memberships/${account.login}`,
  ]);
  const state = response.ok && response.value?.state === "active" ? "active" : "missing";
  if (state !== "active") {
    blockers.push(blocker(
      "organization_membership_missing",
      `Účet '${account.login}' nemá aktivní členství v GitHub Organization '${organization.login}'.`,
    ));
  }
  return {
    state,
    role: response.ok && typeof response.value?.role === "string" ? response.value.role : null,
  };
}

function observeTeam(provider, organization, account, team, blockers) {
  if (!team.github_team_id || !team.github_team_slug) {
    return {
      ...team,
      identity: "not_evaluated",
      membership: "not_evaluated",
    };
  }
  const identityResponse = provider.json([
    "api",
    `orgs/${organization.login}/teams/${team.github_team_slug}`,
  ]);
  const identityMatches = identityResponse.ok
    && String(identityResponse.value?.id ?? "") === team.github_team_id
    && identityResponse.value?.slug === team.github_team_slug;
  if (!identityMatches) {
    blockers.push(blocker(
      "team_identity_mismatch",
      `GitHub Team '${team.github_team_slug}' neodpovídá manifestovému Team ID ${team.github_team_id}.`,
      { team: team.internal_slug },
    ));
    return { ...team, identity: "mismatch", membership: "not_evaluated" };
  }
  if (!account) return { ...team, identity: "verified", membership: "not_evaluated" };
  const membershipResponse = provider.json([
    "api",
    `orgs/${organization.login}/teams/${team.github_team_slug}/memberships/${account.login}`,
  ]);
  const membership = membershipResponse.ok && membershipResponse.value?.state === "active"
    ? "active"
    : "missing";
  if (membership !== "active") {
    blockers.push(blocker(
      "team_membership_missing",
      `Účet '${account.login}' není aktivním členem GitHub Teamu '${team.github_team_slug}'.`,
      { team: team.internal_slug },
    ));
  }
  return { ...team, identity: "verified", membership };
}

function observeRepository(provider, organization, repository, teamByInternalSlug, blockers) {
  const response = provider.json(["api", `repos/${repository.full_name}`]);
  const observedId = String(response.value?.id ?? "");
  const identityMatches = response.ok
    && positiveIdPattern.test(observedId)
    && response.value?.full_name?.toLowerCase() === repository.full_name.toLowerCase()
    && response.value?.owner?.login?.toLowerCase() === organization.login.toLowerCase()
    && (repository.expected_id === null || observedId === repository.expected_id);
  const effectivePermission = identityMatches ? repositoryPermission(response.value) : "unknown";
  if (!identityMatches) {
    blockers.push(blocker(
      "repository_identity_unavailable",
      `Repozitář '${repository.full_name}' nejde na GitHubu bezpečně ověřit.`,
      { repository: repository.full_name },
    ));
  } else if (!isWritePermission(effectivePermission)) {
    blockers.push(blocker(
      "repository_write_missing",
      `Účet nemá WRITE nebo vyšší oprávnění do '${repository.full_name}' (zjištěno: ${effectivePermission}).`,
      { repository: repository.full_name },
    ));
  }

  const teamGrants = repository.team_slugs.map((internalSlug) => {
    const team = teamByInternalSlug.get(internalSlug);
    if (team?.identity !== "verified") {
      return {
        internal_team_slug: internalSlug,
        github_team_slug: team?.github_team_slug ?? null,
        permission: "not_evaluated",
      };
    }
    const grantResponse = provider.json([
      "api",
      `orgs/${organization.login}/teams/${team.github_team_slug}/repos/${repository.full_name}`,
    ]);
    const permission = grantResponse.ok ? repositoryPermission(grantResponse.value) : "none";
    if (!isWritePermission(permission)) {
      blockers.push(blocker(
        "team_repository_write_missing",
        `GitHub Team '${team.github_team_slug}' nemá WRITE nebo vyšší grant do '${repository.full_name}' (zjištěno: ${permission}).`,
        { team: internalSlug, repository: repository.full_name },
      ));
    }
    return {
      internal_team_slug: internalSlug,
      github_team_slug: team.github_team_slug,
      permission,
    };
  });

  return {
    full_name: repository.full_name,
    repository_id: identityMatches ? observedId : null,
    effective_permission: effectivePermission,
    team_grants: teamGrants,
  };
}

function repositoryPermission(value) {
  if (value?.permissions?.admin === true) return "admin";
  if (value?.permissions?.maintain === true) return "maintain";
  if (value?.permissions?.push === true) return "write";
  if (value?.permissions?.triage === true) return "triage";
  if (value?.permissions?.pull === true) return "read";
  return "none";
}

function isWritePermission(permission) {
  return ["write", "maintain", "admin"].includes(permission);
}

function validTeamForgeBinding(value) {
  return isRecord(value)
    && value.schema_version === GITHUB_TEAM_FORGE_BINDING_SCHEMA
    && value.provider === "github"
    && isRecord(value.team)
    && typeof value.team.id === "string"
    && positiveIdPattern.test(value.team.id)
    && typeof value.team.asserted_slug === "string"
    && githubTeamSlugPattern.test(value.team.asserted_slug);
}

function providerIdentity(value) {
  const id = String(value?.id ?? "");
  const login = typeof value?.login === "string" ? value.login.trim() : "";
  return positiveIdPattern.test(id) && githubLoginPattern.test(login) ? { id, login } : null;
}

function blocker(reason, message, { team = null, repository = null } = {}) {
  return { reason, team, repository, message };
}

function validIdentity(value) {
  return isRecord(value)
    && positiveIdPattern.test(value.id ?? "")
    && githubLoginPattern.test(value.login ?? "");
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function compareText(left, right) {
  return left.localeCompare(right, "en");
}

function freeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freeze(child);
  return Object.freeze(value);
}
