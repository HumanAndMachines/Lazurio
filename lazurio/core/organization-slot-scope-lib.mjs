import { posix } from "node:path";

import { isValidOrganizationForgeBinding } from "./organization-scaffold-lib.mjs";

const organizationSlotScopes = new Set(["root", "workspace", "productionspace"]);
const protectedOrganizationSlotAccessModes = new Set([
  "private",
  "restricted",
  "role_based",
]);
const organizationRootSlotPaths = new Set([
  "design-system",
  "infra",
  "mission-control",
  "mission-control/db",
]);
const organizationDiagnosticsOnlySlotPaths = new Set([
  "mission-control/db",
]);
const organizationSlotUiExposures = new Set(["module", "diagnostics-only"]);
const organizationRepositoryDbSourceOfTruthPattern =
  /^repository-db:[a-z0-9]+(?:[._-][a-z0-9]+)*$/;

function canonicalRepositoryMountBasenamePattern() {
  return "[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9_-])?";
}

export function isNestedOrganizationRepositoryDbSlotPath(path) {
  if (
    typeof path !== "string"
    || path.includes("\\")
    || path.includes("\0")
  ) {
    return false;
  }
  const normalizedPath = normalizeOrganizationSlotPath(path);
  if (normalizedPath === null || path !== normalizedPath) return false;
  return new RegExp(
    `^(?:workspace|modules)/${canonicalRepositoryMountBasenamePattern()}/db$`,
  ).test(normalizedPath);
}

export function isOrganizationRepositoryDbSlot(slot, normalizedPath = null) {
  const path = normalizeOrganizationSlotPath(normalizedPath ?? slot?.path);
  const sourceOfTruth = typeof slot?.source_of_truth === "string"
    ? slot.source_of_truth.trim().toLowerCase()
    : "";
  return isNestedOrganizationRepositoryDbSlotPath(path)
    && organizationRepositoryDbSourceOfTruthPattern.test(sourceOfTruth);
}

export function isOrganizationRootSlotPath(path) {
  const normalizedPath = normalizeOrganizationSlotPath(path);
  return normalizedPath !== null && organizationRootSlotPaths.has(normalizedPath);
}

export function isOrganizationRootSlotDescendantPath(path) {
  const normalizedPath = normalizeOrganizationSlotPath(path);
  if (normalizedPath === null || organizationRootSlotPaths.has(normalizedPath)) return false;
  return [...organizationRootSlotPaths].some((rootPath) =>
    normalizedPath.startsWith(`${rootPath}/`),
  );
}

export function isOrganizationSlotContainerPath(path) {
  const normalizedPath = normalizeOrganizationSlotPath(path);
  return (
    normalizedPath === "workspace"
    || normalizedPath === "modules"
    || normalizedPath === "productionspace"
  );
}

export function isCanonicalOrganizationRepositorySlotPath(path) {
  if (
    typeof path !== "string"
    || path.includes("\\")
    || path.includes("\0")
  ) {
    return false;
  }
  const normalizedPath = normalizeOrganizationSlotPath(path);
  if (normalizedPath === null || path !== normalizedPath) return false;
  return (
    organizationRootSlotPaths.has(normalizedPath)
    || isNestedOrganizationRepositoryDbSlotPath(normalizedPath)
    // Fyzický basename mountu přesně zachovává jméno repozitáře včetně
    // case, `_` a `.`; oddělené stabilní ID vrací helper níže (decision 0125).
    || new RegExp(
      `^(?:workspace|modules|productionspace)/${canonicalRepositoryMountBasenamePattern()}$`,
    ).test(normalizedPath)
  );
}

export function organizationSlotRepositoryId(slot, normalizedPath = null) {
  const path = normalizeOrganizationSlotPath(normalizedPath ?? slot?.path);
  if (!path || !isCanonicalOrganizationRepositorySlotPath(path)) return null;
  const declared = slot?.slug;
  if (isNestedOrganizationRepositoryDbSlotPath(path) && declared === undefined) return null;
  const candidate = declared === undefined ? posix.basename(path) : declared;
  if (typeof candidate !== "string" || candidate.trim() !== candidate) return null;
  // `root` už vlastní implicitní Organization root záznam v Git inventáři.
  if (candidate === "root") return null;
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(candidate) ? candidate : null;
}

export function githubRepositoryCoordinate(remote) {
  if (typeof remote !== "string" || remote.trim() !== remote || remote === "") return null;
  const prefixed = remote.match(
    /^(?:git@github\.com:|ssh:\/\/(?:git@)?github\.com\/|https?:\/\/github\.com\/|git:\/\/github\.com\/)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/?$/i,
  );
  const shorthand = remote.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
  const match = prefixed ?? shorthand;
  if (!match) return null;
  const repository = match[2].endsWith(".git") ? match[2].slice(0, -4) : match[2];
  if (repository === "") return null;
  return {
    owner: match[1],
    repository,
    ownerRepo: `${match[1]}/${repository}`,
  };
}

// The Organization root has carried canonical fields under `company` plus
// older aliases during GEN3 rollout. Git actions may use the canonical value
// only after every populated alias agrees on the same repository/branch.
// This mirrors the slot-level rule below and prevents a validator from
// approving one source while Sync acts on another.
export function organizationRootRepositoryRemote(companyConfig) {
  if (hasInvalidRootRepositoryAuthority(companyConfig)) return null;
  return selectRepositoryRemote(rootRemoteAliasEntries(companyConfig));
}

export function organizationRootRepositoryBranch(companyConfig) {
  if (hasInvalidRootRepositoryAuthority(companyConfig)) return null;
  return selectRepositoryBranch(rootBranchAliasEntries(companyConfig));
}

export function organizationRootRepositoryAliasIssues(companyConfig) {
  const issues = [];
  if (hasInvalidActiveForgeBinding(companyConfig)) {
    issues.push({
      code: "organization_root_forge_binding_invalid",
      detail: "má neplatný forge_binding; provider, immutable Organization/repository ID, asserted GitHub locator a main musí odpovídat scaffold kontraktu, jinak Git akce nemají bezpečnou autoritu",
    });
  }
  const governanceIssue = activeGovernanceIssue(companyConfig);
  if (governanceIssue) issues.push(governanceIssue);
  const remoteAliases = rootRemoteAliasEntries(companyConfig);
  const invalidRemoteAliases = invalidAliasNames(remoteAliases);
  if (invalidRemoteAliases.length > 0) {
    issues.push({
      code: "organization_root_remote_alias_invalid",
      detail: `má explicitní Organization root repository alias s neplatnou hodnotou (${invalidRemoteAliases.join(", ")}); alias musí být přesný neprázdný string a Sync nesmí spadnout na jiné pole`,
    });
  }
  const validRemoteAliases = validAliasEntries(remoteAliases);
  const remoteIdentities = new Set(validRemoteAliases.map(([, value]) => {
    const coordinate = githubRepositoryCoordinate(value);
    return coordinate
      ? `github:${coordinate.ownerRepo.toLowerCase()}`
      : `raw:${value}`;
  }));
  if (remoteIdentities.size > 1) {
    issues.push({
      code: "organization_root_remote_conflict",
      detail: `deklaruje rozdílné Organization root repository aliasy (${validRemoteAliases.map(([name]) => name).join(", ")}); před Git akcí musí ukazovat na stejný GitHub owner/repo`,
    });
  }
  const selectedRemote = selectRepositoryRemote(remoteAliases);
  const selectedCoordinate = githubRepositoryCoordinate(selectedRemote);
  const githubOrg = exactNonEmptyString(companyConfig?.company?.github_org);
  const forgeLogin = validActiveForgeBinding(companyConfig)
    ? companyConfig.forge_binding.organization.asserted_login
    : null;
  if (githubOrg && forgeLogin && githubOrg.toLowerCase() !== forgeLogin.toLowerCase()) {
    issues.push({
      code: "organization_root_owner_conflict",
      detail: `company.github_org "${githubOrg}" odporuje forge_binding.organization.asserted_login "${forgeLogin}"; immutable binding a lokátor musí před Git akcí souhlasit`,
    });
  }
  const expectedOwner = forgeLogin ?? githubOrg;
  if (
    selectedCoordinate
    && expectedOwner
    && selectedCoordinate.owner.toLowerCase() !== expectedOwner.toLowerCase()
  ) {
    issues.push({
      code: "organization_root_remote_owner_mismatch",
      detail: `Organization root remote vlastní GitHub owner "${selectedCoordinate.owner}", ale Organization autorita deklaruje "${expectedOwner}"; cizí Organization source nesmí autorizovat root ani child Git akce`,
    });
  }

  const branchAliases = rootBranchAliasEntries(companyConfig);
  const invalidBranchAliases = invalidAliasNames(branchAliases);
  if (invalidBranchAliases.length > 0) {
    issues.push({
      code: "organization_root_branch_alias_invalid",
      detail: `má explicitní Organization root branch alias s neplatnou hodnotou (${invalidBranchAliases.join(", ")}); alias musí být přesný neprázdný string a Sync nesmí spadnout na jiné pole`,
    });
  }
  const validBranchAliases = validAliasEntries(branchAliases);
  if (new Set(validBranchAliases.map(([, value]) => value)).size > 1) {
    issues.push({
      code: "organization_root_branch_conflict",
      detail: `deklaruje rozdílné Organization root branch aliasy (${validBranchAliases.map(([name]) => name).join(", ")}); Sync nesmí vybírat autoritu podle pořadí polí`,
    });
  }
  const selectedBranch = selectRepositoryBranch(branchAliases);
  if (selectedBranch !== null && selectedBranch !== "main") {
    issues.push({
      code: "organization_root_branch_invalid",
      detail: `Organization root deklaruje branch "${selectedBranch}", ale spravovaný Organization source musí používat main`,
    });
  }
  return issues;
}

// Workspace slot manifests have carried three remote spellings and two branch
// spellings during incremental GEN3 migration. Every action surface must read
// the same value, otherwise validation can approve one remote while Sync or a
// repair command acts on another. `git.*` is the canonical spelling; legacy
// aliases remain readable only when they agree.
export function organizationSlotRepositoryRemote(slot, normalizedPath = null) {
  const path = normalizeOrganizationSlotPath(normalizedPath ?? slot?.path);
  return selectRepositoryRemote(slotRemoteAliasEntries(slot, path));
}

export function organizationSlotRepositoryBranch(slot, normalizedPath = null) {
  const path = normalizeOrganizationSlotPath(normalizedPath ?? slot?.path);
  return selectRepositoryBranch(slotBranchAliasEntries(slot, path));
}

export function organizationSlotRepositoryAliasIssues(slot, normalizedPath = null) {
  const path = normalizeOrganizationSlotPath(normalizedPath ?? slot?.path);
  if (!path || isOrganizationRootSlotPath(path)) return [];
  const issues = [];
  const remoteAliases = slotRemoteAliasEntries(slot, path);
  const invalidRemoteAliases = invalidAliasNames(remoteAliases);
  if (invalidRemoteAliases.length > 0) {
    issues.push({
      code: "slot_remote_alias_invalid",
      detail: `má explicitní repository remote alias s neplatnou hodnotou (${invalidRemoteAliases.join(", ")}); alias musí být přesný neprázdný string a Git akce nesmí spadnout na jiné pole`,
    });
  }
  const validRemoteAliases = validAliasEntries(remoteAliases);
  const remoteIdentities = new Set(validRemoteAliases.map(([, value]) => {
    const coordinate = githubRepositoryCoordinate(value);
    return coordinate
      ? `github:${coordinate.ownerRepo.toLowerCase()}`
      : `raw:${value}`;
  }));
  if (remoteIdentities.size > 1) {
    issues.push({
      code: "slot_remote_conflict",
      detail: `deklaruje rozdílné repository remote aliasy (${validRemoteAliases.map(([name]) => name).join(", ")}); před Git akcí musí ukazovat na stejný GitHub owner/repo`,
    });
  }

  const branchAliases = slotBranchAliasEntries(slot, path);
  const invalidBranchAliases = invalidAliasNames(branchAliases);
  if (invalidBranchAliases.length > 0) {
    issues.push({
      code: "slot_branch_alias_invalid",
      detail: `má explicitní branch alias s neplatnou hodnotou (${invalidBranchAliases.join(", ")}); alias musí být přesný neprázdný string a Git akce nesmí spadnout na jiné pole`,
    });
  }
  const validBranchAliases = validAliasEntries(branchAliases);
  if (new Set(validBranchAliases.map(([, value]) => value)).size > 1) {
    issues.push({
      code: "slot_branch_conflict",
      detail: `deklaruje rozdílné branch aliasy (${validBranchAliases.map(([name]) => name).join(", ")}); Sync ani oprava nesmí vybírat autoritu podle pořadí polí`,
    });
  }
  return issues;
}

export function organizationSlotRepositoryMountIssue(slot, normalizedPath = null) {
  const path = normalizeOrganizationSlotPath(normalizedPath ?? slot?.path);
  if (!path || isOrganizationRootSlotPath(path)) return null;
  if (
    isNestedOrganizationRepositoryDbSlotPath(path)
    && !isOrganizationRepositoryDbSlot(slot, path)
  ) {
    return "nested workspace/<module>/db je povolené jen pro source_of_truth repository-db:<version>";
  }
  const remote = organizationSlotRepositoryRemote(slot, path);
  const coordinate = githubRepositoryCoordinate(remote);
  if (isNestedOrganizationRepositoryDbSlotPath(path)) {
    if (!coordinate) {
      return "repository-db slot musí deklarovat konkrétní platný GitHub remote v git.url/repo/repository";
    }
    if (coordinate.repository === slot?.slug) return null;
    return `repository-db slug ${JSON.stringify(slot?.slug ?? null)} neodpovídá přesnému názvu GitHub repozitáře ${JSON.stringify(coordinate.repository)}`;
  }
  if (!coordinate) return null;
  const mountBasename = posix.basename(path);
  if (mountBasename === coordinate.repository) return null;
  return `repository mount basename ${JSON.stringify(mountBasename)} neodpovídá přesnému názvu GitHub repozitáře ${JSON.stringify(coordinate.repository)}`;
}

// Jedna Organization nesmí dvě fyzické repo boundary promítnout do stejného
// logického ID ani deklarovat dvě cesty, které se na case-insensitive hostu
// sloučí. Kontrola je záměrně jen nad jedním deklarativním seznamem; manifest a
// company config smějí stejný slot paralelně popisovat během migrace.
export function organizationRepositorySlotCollectionIssues(
  slots,
  { allowEquivalentDuplicates = false } = {},
) {
  return organizationRepositorySlotCollectionConflicts(slots, { allowEquivalentDuplicates })
    .map((conflict) => conflict.detail);
}

// Structured counterpart for fail-soft consumers. Each conflict carries the
// exact implicated declaration objects, allowing Launchpad and update to
// quarantine only that slot group while preserving healthy siblings.
export function organizationRepositorySlotCollectionConflicts(
  slots,
  { allowEquivalentDuplicates = false } = {},
) {
  const conflicts = [];
  const paths = new Map();
  const ids = new Map();
  for (const slot of Array.isArray(slots) ? slots : []) {
    if (!slot || typeof slot.path !== "string") continue;
    const path = normalizeOrganizationSlotPath(slot.path);
    if (!path || !isCanonicalOrganizationRepositorySlotPath(slot.path)) continue;
    const foldedPath = path.toLowerCase();
    const id = organizationSlotRepositoryId(slot, path);
    const previousPath = paths.get(foldedPath);
    if (previousPath) {
      const equivalent = previousPath.path === path && previousPath.id === id;
      if (!(allowEquivalentDuplicates && equivalent)) {
        conflicts.push({
          code: previousPath.path === path
            ? previousPath.id === id
              ? "duplicate_path"
              : "path_identity_conflict"
            : "path_case_collision",
          detail: previousPath.path === path
            ? previousPath.id === id
              ? `repo cesta ${JSON.stringify(path)} je deklarovaná vícekrát`
              : `repo cesta ${JSON.stringify(path)} nese rozdílné repository slugs ${JSON.stringify(previousPath.id)} a ${JSON.stringify(id)}`
            : `repo cesty ${JSON.stringify(previousPath.path)} a ${JSON.stringify(path)} se liší jen velikostí písmen`,
          slots: [previousPath.slot, slot],
        });
      }
    } else {
      paths.set(foldedPath, { path, id, slot });
    }

    if (id === null) continue;
    const previousIdPath = ids.get(id);
    if (previousIdPath) {
      if (!(allowEquivalentDuplicates && previousIdPath.path === path)) {
        conflicts.push({
          code: "repository_id_collision",
          detail: `repository slug ${JSON.stringify(id)} používají zároveň ${JSON.stringify(previousIdPath.path)} a ${JSON.stringify(path)}`,
          slots: [previousIdPath.slot, slot],
        });
      }
    } else {
      ids.set(id, { path, slot });
    }
  }
  for (const slot of Array.isArray(slots) ? slots : []) {
    const path = normalizeOrganizationSlotPath(slot?.path);
    if (!isNestedOrganizationRepositoryDbSlotPath(path)) continue;
    const parentPath = path.split("/").slice(0, -1).join("/");
    const declaredParent = paths.get(parentPath.toLowerCase());
    if (!declaredParent || declaredParent.path !== parentPath) {
      conflicts.push({
        code: "repository_db_parent_missing",
        detail: `repository-db slot ${JSON.stringify(path)} nemá deklarovaný parent Workspace Modul ${JSON.stringify(parentPath)}`,
        slots: [slot],
      });
    }
  }
  return conflicts;
}

export function organizationSlotPathScope(path) {
  const normalizedPath = normalizeOrganizationSlotPath(path);
  if (
    isOrganizationRootSlotPath(normalizedPath)
    || isOrganizationRootSlotDescendantPath(normalizedPath)
  ) {
    return "root";
  }
  if (
    normalizedPath === "productionspace" ||
    normalizedPath?.startsWith("productionspace/")
  ) {
    return "productionspace";
  }
  if (
    isOrganizationSlotContainerPath(normalizedPath) ||
    normalizedPath?.startsWith("workspace/") ||
    normalizedPath?.startsWith("modules/")
  ) {
    return "workspace";
  }
  return null;
}

export function organizationSlotScope(slot, normalizedPath = null) {
  const path = normalizeOrganizationSlotPath(normalizedPath ?? slot?.path);
  // Fyzická path boundary má přednost před konfliktním deklarovaným `space`.
  // Doctor konflikt současně hlásí jako blokátor, ale read model nesmí ani
  // mezitím zpřístupnit productionspace/root repo jako akční Team modul.
  const pathScope = organizationSlotPathScope(path);
  if (pathScope) return pathScope;
  if (organizationSlotScopes.has(slot?.space)) return slot.space;
  return "workspace";
}

export function organizationSlotWorkspace(slot, normalizedPath = null) {
  const path = normalizeOrganizationSlotPath(normalizedPath ?? slot?.path);
  const space = organizationSlotScope(slot, path);
  if (space === "root") return null;
  if (space === "productionspace") return "productionspace";
  return organizationSlotTeams(slot, path)[0] ?? "workspace";
}

export function organizationSlotTeams(slot, normalizedPath = null) {
  const path = normalizeOrganizationSlotPath(normalizedPath ?? slot?.path);
  if (organizationSlotScope(slot, path) !== "workspace") return [];
  const declared = Array.isArray(slot?.teams)
    ? slot.teams
    : Array.isArray(slot?.workspaces)
      ? slot.workspaces
      : [slot?.workspace];
  const normalized = declared
    .filter((team) => typeof team === "string" && team.trim() !== "")
    .map((team) => team.trim())
    .filter((team) => team !== "productionspace");
  return normalized.length > 0 ? [...new Set(normalized)] : ["workspace"];
}

export function organizationSlotUiExposure(slot, normalizedPath = null) {
  const path = normalizeOrganizationSlotPath(normalizedPath ?? slot?.path);
  // Nested repository-db je technická databáze parent Modulu. Prezentační
  // override z něj nikdy nesmí udělat druhý Modul ani kartu.
  if (isOrganizationRepositoryDbSlot(slot, path)) return "diagnostics-only";
  const declaredExposure = typeof slot?.ui_exposure === "string"
    ? slot.ui_exposure.trim().toLowerCase()
    : "";
  if (organizationSlotUiExposures.has(declaredExposure)) {
    return declaredExposure;
  }
  const sourceOfTruth = typeof slot?.source_of_truth === "string"
    ? slot.source_of_truth.trim().toLowerCase()
    : "";
  const repositoryDb = sourceOfTruth === "repository-db"
    || sourceOfTruth.startsWith("repository-db:");
  if (
    organizationDiagnosticsOnlySlotPaths.has(path)
    || (repositoryDb && organizationSlotScope(slot, path) === "root")
  ) {
    return "diagnostics-only";
  }
  return "module";
}

export function organizationSlotCatalogPresentation(slot, normalizedPath = null) {
  const description = typeof slot?.description === "string"
    ? slot.description.trim()
    : "";
  return {
    description: description === "" ? null : description,
    ui_exposure: organizationSlotUiExposure(slot, normalizedPath),
  };
}

// Manifest deklaruje inventory a sync intent, nikoli oprávnění aktuálního
// Principála. Chráněný slot se do každodenního Launchpad API promítne až když
// na této mašině existuje jeho checkout (poslední známý offline stav bez TTL).
// `required_roles: ["*"]` je explicitní veřejná deklarace a zůstává viditelná
// i před materializací.
export function organizationSlotProjectsToLocalMachine(
  slot,
  { materialized = slot?.status === "available" } = {},
) {
  if (materialized) return true;
  if (slot?.required_roles?.includes("*")) return true;
  return !protectedOrganizationSlotAccessModes.has(slot?.default_access);
}

export function normalizeOrganizationSlotPath(path) {
  if (typeof path !== "string") return null;
  const normalized = posix.normalize(path.replace(/\\/g, "/"));
  if (normalized === ".") return "";
  return normalized.length > 1 ? normalized.replace(/\/+$/, "") : normalized;
}

function rootRemoteAliasEntries(companyConfig) {
  const company = companyConfig?.company;
  const entries = [
    ["company.repository", company, "repository"],
    ["company.git_url", company, "git_url"],
    ["company.root_repository", company, "root_repository"],
  ];
  if (validActiveForgeBinding(companyConfig)) {
    entries.push([
      "forge_binding.repository.asserted_full_name",
      companyConfig.forge_binding.repository,
      "asserted_full_name",
    ]);
  }
  return presentAliasEntries(entries);
}

function rootBranchAliasEntries(companyConfig) {
  const company = companyConfig?.company;
  const entries = [
    ["company.default_branch", company, "default_branch"],
    ["default_branch", companyConfig, "default_branch"],
    ["governance.default_branch", companyConfig?.governance, "default_branch"],
  ];
  if (validActiveForgeBinding(companyConfig)) {
    entries.push([
      "forge_binding.repository.default_branch",
      companyConfig.forge_binding.repository,
      "default_branch",
    ]);
  }
  // Existing GEN3 manifests use top-level null as a reviewed legacy absence
  // while governance.default_branch owns the actual value.
  return presentAliasEntries(entries).filter(([name, value]) =>
    !(name === "default_branch" && value === null)
  );
}

function validActiveForgeBinding(companyConfig) {
  return companyConfig?.forge_binding !== null
    && companyConfig?.forge_binding !== undefined
    && isValidOrganizationForgeBinding(companyConfig.forge_binding);
}

function hasInvalidActiveForgeBinding(companyConfig) {
  return companyConfig?.forge_binding !== null
    && companyConfig?.forge_binding !== undefined
    && !isValidOrganizationForgeBinding(companyConfig.forge_binding);
}

function activeGovernanceIssue(companyConfig) {
  const governance = companyConfig?.governance;
  if (governance === null || governance === undefined) return null;
  if (typeof governance !== "object" || Array.isArray(governance)) {
    return {
      code: "organization_root_governance_invalid",
      detail: "má neplatný governance blok; aktivní governance musí být objekt a nesmí vytvářet druhou Git autoritu",
    };
  }
  if (
    Object.hasOwn(governance, "access_authority")
    && governance.access_authority !== "github"
  ) {
    return {
      code: "organization_root_access_authority_invalid",
      detail: "deklaruje governance.access_authority jinou než přesné \"github\"; GitHub je jediná autorita přístupů a root ani child Git akce nesmí pokračovat",
    };
  }
  return null;
}

function hasInvalidRootRepositoryAuthority(companyConfig) {
  return hasInvalidActiveForgeBinding(companyConfig)
    || activeGovernanceIssue(companyConfig) !== null;
}

function slotRemoteAliasEntries(slot, path) {
  const aliases = [["git.url", slot?.git, "url"]];
  if (!isOrganizationRootSlotPath(path)) {
    aliases.push(["repo", slot, "repo"], ["repository", slot, "repository"]);
  }
  return presentAliasEntries(aliases);
}

function slotBranchAliasEntries(slot, path) {
  const aliases = [["git.branch", slot?.git, "branch"]];
  if (!isOrganizationRootSlotPath(path)) aliases.push(["branch", slot, "branch"]);
  return presentAliasEntries(aliases);
}

function presentAliasEntries(specifications) {
  return specifications.flatMap(([name, owner, key]) =>
    owner !== null
      && (typeof owner === "object" || typeof owner === "function")
      && Object.hasOwn(owner, key)
      ? [[name, owner[key]]]
      : []
  );
}

function exactNonEmptyString(value) {
  return typeof value === "string" && value !== "" && value.trim() === value
    ? value
    : null;
}

function validAliasEntries(entries) {
  return entries.flatMap(([name, value]) => {
    const valid = exactNonEmptyString(value);
    return valid === null ? [] : [[name, valid]];
  });
}

function invalidAliasNames(entries) {
  return entries
    .filter(([, value]) => exactNonEmptyString(value) === null)
    .map(([name]) => name);
}

function selectRepositoryRemote(entries) {
  const valid = validAliasEntries(entries);
  if (valid.length !== entries.length) return null;
  const identities = new Set(valid.map(([, value]) => {
    const coordinate = githubRepositoryCoordinate(value);
    return coordinate
      ? `github:${coordinate.ownerRepo.toLowerCase()}`
      : `raw:${value}`;
  }));
  return identities.size <= 1 ? valid[0]?.[1] ?? null : null;
}

function selectRepositoryBranch(entries) {
  const valid = validAliasEntries(entries);
  if (valid.length !== entries.length) return null;
  return new Set(valid.map(([, value]) => value)).size <= 1
    ? valid[0]?.[1] ?? null
    : null;
}
