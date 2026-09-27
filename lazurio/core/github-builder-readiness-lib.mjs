import {
  classifyOrganizationSlotAccess,
  githubRepositoryCoordinate,
  normalizeOrganizationSlotPath,
} from "./organization-slot-scope-lib.mjs";

// Role, pro které `lazurio organization install --role` provádí read-only
// readiness gate. Textový název role nic neautorizuje: rozhodují živá GitHub
// práva přihlášeného účtu ověřená tímto gate; manifest určuje jen scope
// repozitářů.
export const ORGANIZATION_INSTALL_ROLES = Object.freeze(["builder", "steward"]);

const positiveIdPattern = /^[1-9][0-9]{0,19}$/u;
const githubLoginPattern = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/u;

export function githubRoleReadinessNotRequested() {
  return freeze({
    authority: "github",
    role: null,
    status: "not_requested",
    account: null,
    repositories: [],
    blockers: [],
  });
}

export function githubRoleReadinessUnavailable(role, reason, message) {
  const normalizedRole = normalizeInstallRole(role);
  return freeze({
    authority: "github",
    role: normalizedRole,
    status: "blocked",
    account: null,
    repositories: [],
    blockers: [blocker(
      reason ?? "provider_observation_failed",
      message ?? `${roleLabel(normalizedRole)} access nešlo ověřit čerstvými GitHub provider daty.`,
    )],
  });
}

// Readiness kontrakt `lazurio organization install --role`: role je připravená,
// když přihlášený účet má efektivní WRITE nebo vyšší oprávnění na každý
// repozitář instalačního scope. Rozhoduje GitHub sám (`GET /repos/{repo}` →
// `permissions` přihlášeného účtu); jakou cestou přístup vznikl — kterýkoli
// Team, přímý collaborator, Organization role — gate nezkoumá a Team
// membership ani Team granty nejsou podmínkou. Scope tvoří kořenové repo
// a aktivní ordinary sloty role, které volající (`slotInInstallScope`) ponechá:
// na hostované Organization Mašině jen repozitáře, které instalace pro její
// Team skutečně materializuje, jinde všechny. Restricted a malformed sloty
// gate nikdy nečte a každá neúspěšná provider observace blokuje.
export function observeGitHubRoleReadiness({
  provider,
  organization,
  rootRepository,
  resource,
  role,
  slotInInstallScope = everySlotInInstallScope,
} = {}) {
  const normalizedRole = normalizeInstallRole(role);
  if (!provider?.json || !organization?.id || !organization?.login || !rootRepository?.full_name) {
    throw new TypeError("Role readiness requires a GitHub provider and verified Organization identity.");
  }
  if (typeof slotInInstallScope !== "function") {
    throw new TypeError("Role readiness slotInInstallScope must be a predicate.");
  }

  const plan = roleRepositoryPlan({ organization, rootRepository, resource, role: normalizedRole, slotInInstallScope });
  const blockers = [...plan.blockers];
  const account = observeAccount(provider, blockers);
  const repositories = plan.repositories.map((repository) => (
    observeRepository(provider, organization, repository, blockers)
  ));

  return freeze({
    authority: "github",
    role: normalizedRole,
    status: blockers.length === 0 ? "ready" : "blocked",
    account,
    repositories,
    blockers,
  });
}

export function isValidGitHubRoleReadiness(value) {
  if (
    !isRecord(value)
    || value.authority !== "github"
    || ![null, ...ORGANIZATION_INSTALL_ROLES].includes(value.role)
    || !["not_requested", "ready", "blocked"].includes(value.status)
    || !Array.isArray(value.repositories)
    || !Array.isArray(value.blockers)
  ) return false;
  if (value.status === "not_requested") {
    return value.role === null
      && value.account === null
      && value.repositories.length === 0
      && value.blockers.length === 0;
  }
  return ORGANIZATION_INSTALL_ROLES.includes(value.role)
    && (value.account === null || validIdentity(value.account))
    && (value.status === "ready") === (value.blockers.length === 0);
}

function everySlotInInstallScope() {
  return true;
}

function roleRepositoryPlan({ organization, rootRepository, resource, role, slotInInstallScope }) {
  const blockers = [];
  const repositories = new Map();
  addRepositoryPlan(repositories, blockers, {
    fullName: rootRepository.full_name,
    expectedId: rootRepository.id,
    organization,
  });

  const inventory = Array.isArray(resource?.repository_inventory) ? resource.repository_inventory : [];
  for (const slot of inventory) {
    if (!isRoleRepositorySlot(slot, role) || isBelowNonOrdinarySlot(slot, inventory)) continue;
    if (!slotInInstallScope(slot, inventory)) continue;
    const coordinate = githubRepositoryCoordinate(slot?.git?.url ?? slot?.repository ?? slot?.git_url);
    if (!coordinate || coordinate.owner.toLowerCase() !== organization.login.toLowerCase()) {
      blockers.push(blocker(
        "repository_binding_invalid",
        `Aktivní ${roleLabel(role)} repository slot nemá bezpečnou GitHub souřadnici v této Organizaci.`,
        { repository: typeof slot?.slug === "string" ? slot.slug : null },
      ));
      continue;
    }
    addRepositoryPlan(repositories, blockers, {
      fullName: coordinate.ownerRepo,
      expectedId: null,
      organization,
    });
  }

  return {
    repositories: [...repositories.values()].sort((left, right) => compareText(left.full_name, right.full_name)),
    blockers,
  };
}

// Restricted (Admin-only) a malformed sloty gate záměrně vůbec nečte: nad
// nimi neproběhne žádná provider operace. Ordinary slot patří do gate, když
// jeho `required_roles` roli výslovně jmenují, jsou prázdné nebo veřejné `*`.
function isRoleRepositorySlot(slot, role) {
  if (slot?.status !== "active") return false;
  if (classifyOrganizationSlotAccess(slot) !== "ordinary") return false;
  const requiredRoles = Array.isArray(slot?.required_roles) ? slot.required_roles : [];
  return requiredRoles.length === 0
    || requiredRoles.includes("*")
    || requiredRoles.includes(role);
}

// Restricted nebo malformed hranice platí i pro každý slot pod ní (například
// `mission-control/db` pod restricted `mission-control`): updater takového
// potomka role-scoped nematerializuje, takže gate nad ním nesmí číst provider.
function isBelowNonOrdinarySlot(slot, inventory) {
  const path = normalizeOrganizationSlotPath(slot?.path);
  if (!path) return false;
  return inventory.some((candidate) => {
    if (candidate === slot) return false;
    const ancestorPath = normalizeOrganizationSlotPath(candidate?.path);
    if (!ancestorPath || !path.startsWith(`${ancestorPath}/`)) return false;
    return classifyOrganizationSlotAccess(candidate) !== "ordinary";
  });
}

function normalizeInstallRole(role) {
  if (!ORGANIZATION_INSTALL_ROLES.includes(role)) {
    throw new TypeError(`Role readiness supports only ${ORGANIZATION_INSTALL_ROLES.join(", ")}.`);
  }
  return role;
}

function roleLabel(role) {
  return role.charAt(0).toUpperCase() + role.slice(1);
}

function addRepositoryPlan(repositories, blockers, {
  fullName,
  expectedId,
  organization,
}) {
  const coordinate = githubRepositoryCoordinate(fullName);
  if (!coordinate || coordinate.owner.toLowerCase() !== organization.login.toLowerCase()) {
    blockers.push(blocker(
      "repository_binding_invalid",
      "Repository readiness gate nepřijímá repozitář mimo ověřenou GitHub Organization.",
      { repository: fullName ?? null },
    ));
    return;
  }
  const key = coordinate.ownerRepo.toLowerCase();
  const existing = repositories.get(key);
  repositories.set(key, {
    full_name: existing?.full_name ?? coordinate.ownerRepo,
    expected_id: existing?.expected_id ?? expectedId,
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

function observeRepository(provider, organization, repository, blockers) {
  const response = provider.json(["api", `repos/${repository.full_name}`]);
  if (!response.ok) {
    blockers.push(blocker(
      "provider_observation_failed",
      `GitHub provider nedokázal ověřit repozitář '${repository.full_name}' a efektivní oprávnění účtu.`,
      { repository: repository.full_name },
    ));
  }
  const observedId = String(response.value?.id ?? "");
  const identityMatches = response.ok
    && positiveIdPattern.test(observedId)
    && response.value?.full_name?.toLowerCase() === repository.full_name.toLowerCase()
    && response.value?.owner?.login?.toLowerCase() === organization.login.toLowerCase()
    && (repository.expected_id === null || observedId === repository.expected_id);
  const effectivePermission = identityMatches
    ? repositoryPermission(response.value)
    : response.ok
      ? "unknown"
      : "unavailable";
  if (response.ok && !identityMatches) {
    blockers.push(blocker(
      "repository_identity_mismatch",
      `GitHub odpověď neodpovídá deklarované identitě repozitáře '${repository.full_name}'.`,
      { repository: repository.full_name },
    ));
  } else if (identityMatches && !isWritePermission(effectivePermission)) {
    blockers.push(blocker(
      "repository_write_missing",
      `Účet nemá WRITE nebo vyšší oprávnění do '${repository.full_name}' (zjištěno: ${effectivePermission}).`,
      { repository: repository.full_name },
    ));
  }

  return {
    full_name: repository.full_name,
    repository_id: identityMatches ? observedId : null,
    effective_permission: effectivePermission,
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

function providerIdentity(value) {
  const id = String(value?.id ?? "");
  const login = typeof value?.login === "string" ? value.login.trim() : "";
  return positiveIdPattern.test(id) && githubLoginPattern.test(login) ? { id, login } : null;
}

function blocker(reason, message, { repository = null } = {}) {
  return { reason, repository, message };
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
