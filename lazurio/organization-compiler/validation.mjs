import { readFile } from "fs/promises";
import { posix, win32 } from "path";
import { fileURLToPath } from "url";
import { validateAgainstSchema } from "../runtime/json-schema-mini.mjs";
import { isCanonicalOrganizationRepositorySlotPath, isNestedOrganizationRepositoryDbSlotPath, isOrganizationRepositoryDbSlot, organizationSlotRepositoryMountIssue, organizationSlotRepositoryAliasIssues, organizationSlotRepositoryRemote, organizationSlotRepositoryBranch } from "../core/organization-slot-scope-lib.mjs";
import {
  githubRepositoryCoordinateIdentity,
  githubRepositoryUrlIdentity,
} from "./repository-identity.mjs";

const defaultSchemaRoot = fileURLToPath(new URL("../schemas/", import.meta.url));
const validatorCache = new Map();
const schemaDocumentValidatorCache = new WeakMap();
export const organizationRootSlotPaths = new Set([
  "design-system",
  "infra",
  "mission-control",
  "mission-control/db",
]);
export const organizationNestedRepoSlotPaths = organizationRootSlotPaths;
const organizationRootLayerPaths = new Set([
  "design-system",
  "infra",
  "mission-control",
]);
const canonicalOrganizationRootLayerKinds = new Map([
  ["design-system", "design-system"],
  ["infra", "infra"],
  ["mission-control", "mission-control"],
]);

export function organizationModuleSlotScope(path) {
  if (organizationRootSlotPaths.has(path)) return "root";
  if (typeof path === "string" && path.startsWith("productionspace/")) {
    return "productionspace";
  }
  return "workspace";
}

export async function validateOrganizationDocuments({
  companyConfig,
  modulesManifest = null,
  schemaRoot = defaultSchemaRoot,
  schemaDocuments = null,
  repositoryObservation = null,
} = {}) {
  const validators = schemaDocuments === null
    ? await loadValidators(schemaRoot)
    : loadSchemaDocumentValidators(schemaDocuments);
  const failures = [];
  const warnings = [];

  collectSchemaFailures(failures, "company.gen3.json", validators.company, companyConfig);
  if (modulesManifest) {
    collectSchemaFailures(failures, "modules.manifest.json", validators.modulesManifest, modulesManifest);
  } else {
    failures.push("modules.manifest.json: chybí canonical root deskriptor Organizace");
  }

  if (companyConfig && modulesManifest) {
    collectSemanticFailures({
      companyConfig,
      modulesManifest,
      failures,
      warnings,
      repositoryObservation,
    });
  }

  return {
    valid: failures.length === 0,
    failures,
    warnings: [...new Set(warnings)],
  };
}

function collectSchemaFailures(target, label, validate, value) {
  if (validate(value)) return;
  for (const error of validate.errors ?? []) {
    const path = error.instancePath || "/";
    target.push(`${label}${path}: ${error.message}`);
  }
}

function collectSemanticFailures({
  companyConfig,
  modulesManifest,
  failures,
  warnings,
  repositoryObservation,
}) {
  const company = companyConfig.company ?? {};
  validateTemplateSyncContract({
    companyConfig,
    company,
    failures,
    repositoryObservation,
  });
  if (companyConfig.organization_kind !== "template") {
    validateOrganizationRootRepositoryContract({
      company,
      failures,
      repositoryObservation,
    });
  }
  validateOwnershipPatternContract({
    ownership: companyConfig.governance?.file_ownership,
    failures,
    warnings,
  });
  const manifestCompany = modulesManifest.company;
  if (manifestCompany !== company.slug) {
    failures.push(
      `modules.manifest.json/company: ${JSON.stringify(manifestCompany)} neodpovídá canonical company.slug ${JSON.stringify(company.slug)}`,
    );
  }
  if (modulesManifest.github_org !== company.github_org) {
    failures.push("modules.manifest.json/github_org: neodpovídá company.gen3.json company.github_org");
  }

  const canonicalTeamEntries = Array.isArray(companyConfig.teams) ? companyConfig.teams : [];
  const legacyTeamEntries = Array.isArray(companyConfig.workspaces) ? companyConfig.workspaces : [];
  collectDuplicates(
    canonicalTeamEntries.map((team) => team.slug),
    (slug) => failures.push(`company.gen3.json/teams: duplicitní slug ${slug}`),
  );
  collectDuplicates(
    legacyTeamEntries.map((team) => team.slug),
    (slug) => failures.push(`company.gen3.json/workspaces: duplicitní slug ${slug}`),
  );
  const teamBySlug = new Map(legacyTeamEntries.map((team) => [team.slug, team]));
  for (const team of canonicalTeamEntries) teamBySlug.set(team.slug, team);
  const teamEntries = [...teamBySlug.values()];
  const teamSlugs = new Set(teamEntries.map((team) => team.slug));
  if (teamEntries.length === 0) teamSlugs.add("workspace");
  const defaultTeams = teamEntries.filter((team) => team.default === true);
  const defaultTeam = defaultTeams[0]?.slug ?? "workspace";

  if (teamSlugs.has("productionspace")) {
    failures.push("company.gen3.json/teams: productionspace je rezervovaný slug");
  }
  if (teamEntries.length > 0 && defaultTeams.length !== 1) {
    failures.push("company.gen3.json/teams: právě jeden Team musí mít default: true");
  }

  const companyModules = Array.isArray(companyConfig.modules) ? companyConfig.modules : [];
  const manifestSlots = Array.isArray(modulesManifest.module_slots) ? modulesManifest.module_slots : [];
  const companyByPath = new Map();
  const manifestByPath = new Map();
  const companyPathByPortableKey = new Map();
  const manifestPathByPortableKey = new Map();

  collectDuplicates(
    companyModules
      .map((module) => module.slug)
      .filter((slug) => typeof slug === "string"),
    (slug) => failures.push(`company.gen3.json/modules: duplicitní slug ${slug}`),
  );
  collectDuplicates(
    manifestSlots
      .map((slot) => {
        if (typeof slot.slug === "string") return slot.slug;
        const fallbackSlug = legacySlotSlugFromPath(slot.path);
        return fallbackSlug !== null && /^[a-z0-9][a-z0-9-]*$/.test(fallbackSlug)
          ? fallbackSlug
          : null;
      })
      .filter((slug) => typeof slug === "string"),
    (slug) => failures.push(`modules.manifest.json/module_slots: duplicitní slug ${slug}`),
  );

  for (const item of [...companyModules, ...manifestSlots]) {
    if (!isCanonicalOrganizationRepositorySlotPath(item.path)) failures.push(`Invalid module path: ${item.path}`);
    if (isNestedOrganizationRepositoryDbSlotPath(item.path)) {
      const mountIssue = organizationSlotRepositoryMountIssue(item);
      if (mountIssue) failures.push(`${item.path}: ${mountIssue}`);
      for (const issue of organizationSlotRepositoryAliasIssues(item)) failures.push(`${item.path}: ${issue.detail ?? issue}`);
      const parentPath = item.path.slice(0, -3);
      const parent = manifestSlots.find(slot => slot.path === parentPath);
      if (!isOrganizationRepositoryDbSlot(item) || !item.slug || !parent || parent.status === "planned_slot" || !organizationSlotRepositoryRemote(parent) || !organizationSlotRepositoryBranch(parent)) {
        failures.push(`Repository-db child requires explicit slug, repository-db namespace and active parent: ${item.path}`);
      }
    }
  }
  for (const module of companyModules) {
    if (companyByPath.has(module.path)) {
      failures.push(`company.gen3.json/modules: duplicitní path ${module.path}`);
      continue;
    }
    const portablePathKey = portablePathIdentity(module.path);
    if (portablePathKey !== null && companyPathByPortableKey.has(portablePathKey)) {
      failures.push(
        `company.gen3.json/modules: path ${module.path} koliduje po case-foldingu s ${companyPathByPortableKey.get(portablePathKey)}`,
      );
      continue;
    }
    companyByPath.set(module.path, module);
    if (portablePathKey !== null) {
      companyPathByPortableKey.set(portablePathKey, module.path);
    }
    if (module.path?.startsWith("modules/")) {
      warnings.push(`company.gen3.json/modules: ${module.path} používá deprecated GEN2 path`);
    }
    if (module.app_manifest !== undefined || module.app_manifests !== undefined) {
      warnings.push(
        `company.gen3.json/modules: ${module.path} drží deprecated app manifest registry; canonical je package.json#companyascode.app`,
      );
    }
    validateTeamOwnership({
      label: `company.gen3.json/modules/${module.slug}`,
      item: module,
      teamSlugs,
      defaultTeam,
      failures,
    });
  }

  for (const slot of manifestSlots) {
    if (manifestByPath.has(slot.path)) {
      failures.push(`modules.manifest.json/module_slots: duplicitní path ${slot.path}`);
      continue;
    }
    const portablePathKey = portablePathIdentity(slot.path);
    if (portablePathKey !== null && manifestPathByPortableKey.has(portablePathKey)) {
      failures.push(
        `modules.manifest.json/module_slots: path ${slot.path} koliduje po case-foldingu s ${manifestPathByPortableKey.get(portablePathKey)}`,
      );
      continue;
    }
    manifestByPath.set(slot.path, slot);
    if (portablePathKey !== null) {
      manifestPathByPortableKey.set(portablePathKey, slot.path);
    }
    const fallbackSlug = legacySlotSlugFromPath(slot.path);
    const companyModule = companyByPath.get(slot.path);
    const caseConflictingCompanyPath = portablePathKey === null
      ? null
      : companyPathByPortableKey.get(portablePathKey);
    const hasCaseOnlyCompanyPathConflict =
      caseConflictingCompanyPath !== null &&
      caseConflictingCompanyPath !== undefined &&
      caseConflictingCompanyPath !== slot.path;
    if (
      slot.slug === undefined &&
      !hasCaseOnlyCompanyPathConflict &&
      (fallbackSlug === null ||
        !/^[a-z0-9][a-z0-9-]*$/.test(fallbackSlug) ||
        (companyModule && companyModule.slug !== fallbackSlug))
    ) {
      failures.push(
        `modules.manifest.json/module_slots/${slot.path}: slug je povinný, protože stabilní identita nejde bezpečně odvodit z basename cesty`,
      );
    }
    if (
      slot.path === "mission-control/db" &&
      slot.slug !== undefined &&
      slot.slug !== "mission-control-data"
    ) {
      failures.push(
        "modules.manifest.json/module_slots/mission-control/db: slug musí být mission-control-data",
      );
    }
    if (slot.path?.startsWith("modules/")) {
      warnings.push(`modules.manifest.json/module_slots: ${slot.path} používá deprecated GEN2 path`);
    }
    if (slot.launchpad_port !== undefined) {
      warnings.push(
        `modules.manifest.json/module_slots: ${slot.path} drží deprecated launchpad_port; canonical je package.json#companyascode.app.port`,
      );
    }
    if (organizationRootSlotPaths.has(slot.path)) {
      validateRootSlotOwnership({
        label: `modules.manifest.json/module_slots/${slot.path}`,
        item: slot,
        failures,
      });
    } else {
      validateTeamOwnership({
        label: `modules.manifest.json/module_slots/${slot.path}`,
        item: slot,
        teamSlugs,
        defaultTeam,
        failures,
      });
    }
  }

  validateRootLayerSlotDeclarations({
    companyConfig,
    manifestByPath,
    failures,
  });
  validateMissionControlSlotPair({ manifestByPath, failures });
  validateMissionControlTaskSources({
    companyConfig,
    manifestByPath,
    failures,
  });

  for (const [path, module] of companyByPath) {
    const slot = manifestByPath.get(path);
    if (!slot) {
      const portablePathKey = portablePathIdentity(path);
      const caseConflictingPath = portablePathKey === null
        ? null
        : manifestPathByPortableKey.get(portablePathKey);
      if (caseConflictingPath) {
        failures.push(
          `Module path se mezi company a manifestem liší pouze velikostí písmen: company=${path}, manifest=${caseConflictingPath}`,
        );
      } else {
        failures.push(`modules.manifest.json/module_slots: chybí deklarace pro company modul ${path}`);
      }
      continue;
    }
    if (!path.startsWith("productionspace/")) {
      const moduleTeams = normalizedTeamMemberships(module, defaultTeam);
      const slotTeams = normalizedTeamMemberships(slot, defaultTeam);
      if (!arraysEqual(moduleTeams, slotTeams)) {
        failures.push(
          `Team deklarace ${path} se rozchází: company=${JSON.stringify(moduleTeams)}, manifest=${JSON.stringify(slotTeams)}`,
        );
      }
    }
    compareModuleContract({
      path,
      module,
      slot,
      failures,
    });
  }

  for (const path of manifestByPath.keys()) {
    const slot = manifestByPath.get(path);
    if (organizationRootSlotPaths.has(path) || slot.status === "planned_slot") continue;
    if (!companyByPath.has(path)) {
      const portablePathKey = portablePathIdentity(path);
      if (portablePathKey !== null && companyPathByPortableKey.has(portablePathKey)) {
        continue;
      }
      failures.push(`company.gen3.json/modules: chybí deklarace pro manifest slot ${path}`);
    }
  }
}

const organizationTemplateRepositoryIdentity =
  "templatesrozjedeme-ai/OrganizationTemplate_GEN3";

function normalizeObservedRepositoryIdentity(value) {
  return githubRepositoryCoordinateIdentity(value);
}

export function repositoryObservationAuthorizesTemplateWrite(
  repositoryObservation,
) {
  return (
    repositoryObservation?.immutableTemplateIdentityVerified === true &&
    repositoryObservation?.status === "valid" &&
    normalizeObservedRepositoryIdentity(repositoryObservation.identity) ===
      organizationTemplateRepositoryIdentity &&
    repositoryObservation.remoteContract?.originRoutingReady === true &&
    repositoryObservation.remoteContract?.templateRemoteState ===
      "missing" &&
    Array.isArray(
      repositoryObservation.remoteContract?.templateRepositoryRemoteNames,
    ) &&
    repositoryObservation.remoteContract.templateRepositoryRemoteNames
      .length === 1 &&
    repositoryObservation.remoteContract.templateRepositoryRemoteNames[0] ===
      "origin" &&
    repositoryObservation.remoteContract?.allRemoteUrlsSafeGithub === true
  );
}

function observedCheckoutBasename(repositoryObservation) {
  const checkoutRoot = repositoryObservation?.checkoutRoot;
  const checkoutPlatform = repositoryObservation?.checkoutPlatform;
  if (
    typeof checkoutRoot !== "string" ||
    (checkoutPlatform !== "win32" &&
      checkoutPlatform !== "aix" &&
      checkoutPlatform !== "darwin" &&
      checkoutPlatform !== "freebsd" &&
      checkoutPlatform !== "linux" &&
      checkoutPlatform !== "openbsd" &&
      checkoutPlatform !== "sunos")
  ) {
    return null;
  }
  const pathApi = checkoutPlatform === "win32" ? win32 : posix;
  if (
    !pathApi.isAbsolute(checkoutRoot) ||
    /[\0\r\n]/u.test(checkoutRoot)
  ) {
    return null;
  }
  const basename = pathApi.basename(checkoutRoot);
  return basename === "" ? null : basename;
}

function sameCheckoutBasename(
  observed,
  declared,
  checkoutPlatform,
) {
  return checkoutPlatform === "win32"
    ? observed.toLowerCase() === declared.toLowerCase()
    : observed === declared;
}

function validateTemplateSyncContract({
  companyConfig,
  company,
  failures,
  repositoryObservation,
}) {
  const roleDeclared = Object.hasOwn(
    companyConfig,
    "template_sync_role",
  );
  const role = companyConfig.template_sync_role ?? "consumer";
  const authorization = companyConfig.template_sync_authorization;
  if (companyConfig.organization_kind === "template") {
    if (roleDeclared) {
      failures.push(
        "company.gen3.json/template_sync_role: organization_kind=template nesmí deklarovat Organization consumer/source roli",
      );
    }
    if (authorization !== undefined) {
      failures.push(
        "company.gen3.json/template_sync_authorization: organization_kind=template nesmí deklarovat Organization source autorizaci",
      );
    }
    return;
  }
  if (role === "source") {
    failures.push("template_sync_role=source requires the separate template publisher; this compiler does not carry Organization-specific source authorization");
  } else if (authorization !== undefined) {
    failures.push(
      "company.gen3.json/template_sync_authorization: smí být přítomná pouze pro template_sync_role=source",
    );
  }
  if (role === "consumer" && repositoryObservation?.status !== "offline") {
    if (
      repositoryObservation?.status !== "valid" &&
      repositoryObservation?.status !== "absent"
    ) {
      failures.push(
        "company.gen3.json/template_sync_role: consumer Organizace vyžaduje důvěryhodné pozorování checkoutu; bez něj je povolený pouze explicitní offline dry-run",
      );
    } else if (
      repositoryObservation.remoteContract?.templateRemoteState !==
      "ready"
    ) {
      failures.push(
        "company.gen3.json/template_sync_role: consumer checkout vyžaduje přesný fetch-only OrganizationTemplate remote s OS-native push sinkem",
      );
    }
  }
}

export function organizationRepositoryContractFailures(
  companyConfig,
  { repositoryObservation = null } = {},
) {
  const failures = [];
  const company = companyConfig?.company ?? {};
  validateTemplateSyncContract({
    companyConfig,
    company,
    failures,
    repositoryObservation,
  });
  if (companyConfig?.organization_kind !== "template") {
    validateOrganizationRootRepositoryContract({
      company,
      failures,
      repositoryObservation,
    });
  }
  return failures;
}

function validateOrganizationRootRepositoryContract({
  company,
  failures,
  repositoryObservation,
}) {
  const repositoryDeclared = Object.hasOwn(company, "repository");
  const rootRepositoryDeclared = Object.hasOwn(company, "root_repository");
  if (repositoryDeclared !== rootRepositoryDeclared) {
    failures.push(
      "company.gen3.json/company: repository a root_repository musí být deklarované společně, nebo obě vynechané v local-first stavu",
    );
    return;
  }
  if (!repositoryDeclared) {
    if (
      repositoryObservation?.status === "valid" ||
      repositoryObservation?.status === "invalid"
    ) {
      failures.push(
        "company.gen3.json/company: checkout s přítomným nebo nečitelným originem nesmí předstírat local-first stav",
      );
    }
    return;
  }

  const repositoryIdentity = githubRepositoryUrlIdentity(company.repository);
  const rootRepositoryIdentity = githubRepositoryCoordinateIdentity(
    company.root_repository,
  );
  const declaredRootRepositoryBasename = rootRepositoryIdentity
    ? company.root_repository.slice(
        company.root_repository.indexOf("/") + 1,
      )
    : null;
  const observedRepositoryIdentity =
    repositoryObservation?.status === "valid"
      ? normalizeObservedRepositoryIdentity(
          repositoryObservation.identity,
        )
      : null;
  if (
    repositoryIdentity &&
    rootRepositoryIdentity &&
    repositoryIdentity !== rootRepositoryIdentity
  ) {
    failures.push(
      "company.gen3.json/company: repository a root_repository musí označovat stejné GitHub owner/repo",
    );
  }
  if (
    repositoryObservation === null ||
    repositoryObservation?.status === "unavailable"
  ) {
    failures.push(
      "company.gen3.json/company: remote-active deklarace vyžaduje důvěryhodné pozorování checkout rootu a originu",
    );
  } else if (repositoryObservation?.status === "absent") {
    failures.push(
      "company.gen3.json/company: remote-active deklarace vyžaduje přítomný bezpečně čitelný checkout origin",
    );
  } else if (repositoryObservation?.status === "invalid") {
    failures.push(
      "company.gen3.json/company: checkout origin nelze bezpečně přečíst nebo používá nepodporovaný tvar",
    );
  } else if (
    repositoryObservation?.status === "valid" &&
    observedRepositoryIdentity === null
  ) {
    failures.push(
      "company.gen3.json/company: důvěryhodné pozorování checkoutu neobsahuje validní GitHub repository identitu",
    );
  } else if (
    repositoryObservation?.status === "valid" &&
    repositoryIdentity &&
    observedRepositoryIdentity !== repositoryIdentity
  ) {
    failures.push(
      "company.gen3.json/company: checkout origin musí odpovídat deklarované repository identitě",
    );
  } else if (
    repositoryObservation?.status === "valid" &&
    repositoryObservation.remoteContract?.originRoutingReady !== true
  ) {
    failures.push(
      "company.gen3.json/company: remote-active checkout vyžaduje bezpečný origin fetch/push routing a všechen branch push routing na origin včetně branch.main.remote=origin",
    );
  } else if (
    repositoryObservation?.status !== "valid" &&
    repositoryObservation?.status !== "offline"
  ) {
    failures.push(
      "company.gen3.json/company: neznámý stav repository pozorování nesmí obejít checkout identity gate",
    );
  }
  if (
    repositoryObservation?.status === "valid" &&
    declaredRootRepositoryBasename !== null
  ) {
    const checkoutBasename = observedCheckoutBasename(
      repositoryObservation,
    );
    if (checkoutBasename === null) {
      failures.push(
        "company.gen3.json/company: důvěryhodné pozorování checkoutu neobsahuje kanonický fyzický checkout root",
      );
    } else if (
      !sameCheckoutBasename(
        checkoutBasename,
        declaredRootRepositoryBasename,
        repositoryObservation.checkoutPlatform,
      )
    ) {
      failures.push(
        "company.gen3.json/company: basename fyzického checkout rootu musí odpovídat repository komponentě root_repository",
      );
    }
  }
  const githubOrg =
    typeof company.github_org === "string" ? company.github_org.toLowerCase() : "";
  const repositoryOwner = rootRepositoryIdentity?.split("/")[0] ?? "";
  if (repositoryOwner && githubOrg && repositoryOwner !== githubOrg) {
    failures.push(
      "company.gen3.json/company: root_repository owner musí odpovídat company.github_org",
    );
  }
}

const ownershipKinds = ["managed", "derived", "override", "manual"];

function validateOwnershipPatternContract({ ownership, failures, warnings }) {
  if (!ownership || typeof ownership !== "object") return;
  if (!Object.hasOwn(ownership, "derived")) {
    warnings.push(
      "company.gen3.json/governance/file_ownership: chybí derived; legacy GEN3 konfigurace zůstává čitelná pro migraci, ale compiler closeout vyžaduje explicitní derived klasifikaci",
    );
  }

  for (let leftIndex = 0; leftIndex < ownershipKinds.length; leftIndex += 1) {
    const leftKind = ownershipKinds[leftIndex];
    for (let rightIndex = leftIndex + 1; rightIndex < ownershipKinds.length; rightIndex += 1) {
      const rightKind = ownershipKinds[rightIndex];
      const leftPatterns = Array.isArray(ownership[leftKind]) ? ownership[leftKind] : [];
      const rightPatterns = Array.isArray(ownership[rightKind]) ? ownership[rightKind] : [];
      for (const leftPattern of leftPatterns) {
        for (const rightPattern of rightPatterns) {
          if (!ownershipPatternsOverlap(leftPattern, rightPattern)) continue;
          failures.push(
            `company.gen3.json/governance/file_ownership: patterny ${JSON.stringify(leftPattern)} (${leftKind}) a ${JSON.stringify(rightPattern)} (${rightKind}) se překrývají; jedna cesta smí mít právě jednu ownership klasifikaci`,
          );
        }
      }
    }
  }
}

export function ownershipPatternsOverlap(leftPattern, rightPattern) {
  const left = normalizeOwnershipPattern(leftPattern);
  const right = normalizeOwnershipPattern(rightPattern);
  if (!left || !right) return false;
  return pathGlobSegmentsOverlap(left.split("/"), right.split("/"));
}

function normalizeOwnershipPattern(pattern) {
  if (typeof pattern !== "string") return "";
  return pattern.replaceAll("\\", "/").replace(/^\.\/+/, "").replace(/\/+$/, "");
}

function pathGlobSegmentsOverlap(leftSegments, rightSegments) {
  const memo = new Map();
  const visit = (leftIndex, rightIndex) => {
    const key = `${leftIndex}:${rightIndex}`;
    if (memo.has(key)) return memo.get(key);
    // Mark in-progress states false; every recursive branch below advances at
    // least one index, so this is only a defensive cycle guard.
    memo.set(key, false);
    if (leftIndex === leftSegments.length && rightIndex === rightSegments.length) {
      memo.set(key, true);
      return true;
    }

    const left = leftSegments[leftIndex];
    const right = rightSegments[rightIndex];
    let overlaps = false;
    if (left === "**" && right === "**") {
      overlaps =
        visit(leftIndex + 1, rightIndex) ||
        visit(leftIndex, rightIndex + 1);
    } else if (left === "**") {
      overlaps =
        visit(leftIndex + 1, rightIndex) ||
        (rightIndex < rightSegments.length && visit(leftIndex, rightIndex + 1));
    } else if (right === "**") {
      overlaps =
        visit(leftIndex, rightIndex + 1) ||
        (leftIndex < leftSegments.length && visit(leftIndex + 1, rightIndex));
    } else if (left !== undefined && right !== undefined && segmentGlobsOverlap(left, right)) {
      overlaps = visit(leftIndex + 1, rightIndex + 1);
    }
    memo.set(key, overlaps);
    return overlaps;
  };
  return visit(0, 0);
}

function segmentGlobsOverlap(leftSegment, rightSegment) {
  const left = leftSegment.replaceAll("**", "*");
  const right = rightSegment.replaceAll("**", "*");
  const memo = new Map();
  const visit = (leftIndex, rightIndex) => {
    const key = `${leftIndex}:${rightIndex}`;
    if (memo.has(key)) return memo.get(key);
    memo.set(key, false);
    if (leftIndex === left.length && rightIndex === right.length) {
      memo.set(key, true);
      return true;
    }
    const leftChar = left[leftIndex];
    const rightChar = right[rightIndex];
    let overlaps = false;
    if (leftChar === "*" && rightChar === "*") {
      overlaps =
        visit(leftIndex + 1, rightIndex) ||
        visit(leftIndex, rightIndex + 1);
    } else if (leftChar === "*") {
      overlaps =
        visit(leftIndex + 1, rightIndex) ||
        (rightIndex < right.length && visit(leftIndex, rightIndex + 1));
    } else if (rightChar === "*") {
      overlaps =
        visit(leftIndex, rightIndex + 1) ||
        (leftIndex < left.length && visit(leftIndex + 1, rightIndex));
    } else if (leftChar !== undefined && leftChar === rightChar) {
      overlaps = visit(leftIndex + 1, rightIndex + 1);
    }
    memo.set(key, overlaps);
    return overlaps;
  };
  return visit(0, 0);
}

function compareModuleContract({ path, module, slot, failures }) {
  if (slot.slug !== undefined) {
    compareScalarContract({
      path,
      field: "slug",
      companyValue: module.slug,
      manifestValue: slot.slug,
      failures,
    });
  }
  compareScalarContract({ path, field: "category", companyValue: module.category, manifestValue: slot.category, failures });
  compareScalarContract({
    path,
    field: "source_of_truth",
    companyValue: module.source_of_truth,
    manifestValue: slot.source_of_truth,
    failures,
  });
  compareScalarContract({
    path,
    field: "access.default",
    companyValue: module.access?.default,
    manifestValue: slot.default_access,
    failures,
  });

  const companyRoles = normalizeStringSet(module.access?.roles);
  const manifestRoles = normalizeStringSet(slot.required_roles);
  if (!arraysEqual(companyRoles, manifestRoles)) {
    failures.push(
      `Module kontrakt ${path}/access.roles se rozchází: company=${JSON.stringify(companyRoles)}, manifest=${JSON.stringify(manifestRoles)}`,
    );
  }

  const companyRepo = normalizeRepoReference(module.repo);
  const manifestRepo = normalizeRepoReference(slot.git?.url ?? slot.repo ?? slot.repository);
  if (companyRepo !== manifestRepo) {
    failures.push(
      `Module kontrakt ${path}/repo se rozchází: company=${JSON.stringify(module.repo ?? null)}, manifest=${JSON.stringify(slot.git?.url ?? slot.repo ?? slot.repository ?? null)}`,
    );
  }
}

function compareScalarContract({ path, field, companyValue, manifestValue, failures }) {
  if (companyValue !== manifestValue) {
    failures.push(
      `Module kontrakt ${path}/${field} se rozchází: company=${JSON.stringify(companyValue ?? null)}, manifest=${JSON.stringify(manifestValue ?? null)}`,
    );
  }
}

function normalizeRepoReference(value) {
  if (typeof value !== "string" || value.trim() === "") return null;
  const trimmed = value.trim().replace(/\/+$/, "").replace(/\.git$/i, "");
  const githubMatch = trimmed.match(
    /^(?:git@github\.com:|ssh:\/\/git@github\.com\/|https?:\/\/github\.com\/)([^/]+)\/(.+)$/i,
  );
  if (githubMatch) return `github.com/${githubMatch[1]}/${githubMatch[2]}`.toLowerCase();
  return trimmed;
}

function normalizeStringSet(values) {
  if (!Array.isArray(values)) return [];
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function normalizedTeamMemberships(item, defaultTeam) {
  if (Array.isArray(item.teams) && item.teams.length > 0) {
    return normalizeStringSet(item.teams);
  }
  if (Array.isArray(item.workspaces) && item.workspaces.length > 0) {
    return normalizeStringSet(item.workspaces);
  }
  if (typeof item.workspace === "string" && item.workspace !== "") return [item.workspace];
  return [defaultTeam];
}

function arraysEqual(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function validateTeamOwnership({ label, item, teamSlugs, defaultTeam, failures }) {
  if (item.path?.startsWith("productionspace/")) {
    if (
      item.workspace !== undefined ||
      (Array.isArray(item.workspaces) && item.workspaces.length > 0) ||
      (Array.isArray(item.teams) && item.teams.length > 0)
    ) {
      failures.push(`${label}: productionspace repo nesmí mít Team memberships`);
    }
    return;
  }
  const teams = normalizedTeamMemberships(item, defaultTeam);
  for (const team of teams) {
    if (team === "productionspace") {
      failures.push(`${label}: productionspace je rezervovaný Team slug`);
      continue;
    }
    if (!teamSlugs.has(team)) {
      failures.push(`${label}: Team ${team} není deklarovaný v company.gen3.json teams[]`);
    }
  }
}

function validateRootSlotOwnership({ label, item, failures }) {
  if (
    item.workspace !== undefined ||
    item.workspaces !== undefined ||
    item.teams !== undefined
  ) {
    failures.push(`${label}: Organization root slot nesmí mít Team memberships`);
  }
  const legacyCheckoutFields = ["repo", "repository", "branch"].filter((field) =>
    Object.hasOwn(item, field),
  );
  if (legacyCheckoutFields.length > 0) {
    failures.push(
      `${label}: Organization root slot nesmí deklarovat legacy checkout souřadnice (${legacyCheckoutFields.join(", ")}); používej výhradně git.url a git.branch`,
    );
  }
  if (organizationNestedRepoSlotPaths.has(item.path)) {
    if (item.status === "planned_slot" && item.git !== undefined) {
      failures.push(
        `${label}: planned nested repo nesmí deklarovat git; s checkout souřadnicemi už jde o aktivní nebo missing-access slot`,
      );
    } else if (item.status !== "planned_slot" && !hasCheckoutCoordinates(item)) {
      failures.push(
        `${label}: aktivní nested repo musí mít git.url a git.branch; bez checkout údajů použij status planned_slot`,
      );
    }
  }
  if (
    item.path === "mission-control/db" &&
    item.git?.branch !== undefined &&
    item.git.branch !== "v3"
  ) {
    failures.push(`${label}: Mission Control data repo musí používat větev v3`);
  }
}

function validateRootLayerSlotDeclarations({ companyConfig, manifestByPath, failures }) {
  const layers = Array.isArray(companyConfig.layers) ? companyConfig.layers : [];
  for (const [path, expectedKind] of canonicalOrganizationRootLayerKinds) {
    const matchingLayers = layers.filter((layer) => layer?.path === path);
    if (matchingLayers.length > 1) {
      failures.push(
        `company.gen3.json/layers: root vrstva ${path} musí mít právě jeden záznam; nalezeno ${matchingLayers.length}`,
      );
    }
    for (const layer of matchingLayers) {
      if (layer.kind === expectedKind) continue;
      failures.push(
        `company.gen3.json/layers: root vrstva ${path} musí používat kind ${expectedKind}; nalezeno ${layer.kind}`,
      );
    }
  }

  const layerPaths = new Set(
    layers
      .map((layer) => layer?.path)
      .filter((path) => organizationRootLayerPaths.has(path)),
  );

  for (const path of layerPaths) {
    if (!manifestByPath.has(path)) {
      failures.push(
        `modules.manifest.json/module_slots: root vrstva ${path} z company.gen3.json/layers nemá manifest slot`,
      );
    }
  }

  for (const path of manifestByPath.keys()) {
    if (!organizationRootLayerPaths.has(path) || layerPaths.has(path)) continue;
    failures.push(
      `company.gen3.json/layers: root slot ${path} z modules.manifest.json nemá deklarovanou root vrstvu`,
    );
  }
}

function validateMissionControlSlotPair({ manifestByPath, failures }) {
  const appDeclared = manifestByPath.has("mission-control");
  const dataDeclared = manifestByPath.has("mission-control/db");
  if (appDeclared !== dataDeclared) {
    const missingPath = appDeclared ? "mission-control/db" : "mission-control";
    failures.push(
      `modules.manifest.json/module_slots: Mission Control app/data boundary musí deklarovat oba root sloty; chybí ${missingPath} (během migrace použij status planned_slot)`,
    );
    return;
  }
  if (!appDeclared) return;

  const appSlot = manifestByPath.get("mission-control");
  const dataSlot = manifestByPath.get("mission-control/db");
  const dataIsActive = dataSlot.status !== "planned_slot";
  const appIsActive =
    appSlot.status !== "planned_slot" && hasCheckoutCoordinates(appSlot);
  if (dataIsActive && !appIsActive) {
    failures.push(
      "modules.manifest.json/module_slots: aktivní mission-control/db vyžaduje aktivní parent mission-control s git.url a git.branch; data checkout nesmí být dostupný bez app/code boundary",
    );
  }
}

function validateMissionControlTaskSources({
  companyConfig,
  manifestByPath,
  failures,
}) {
  const dataSlot = manifestByPath.get("mission-control/db");
  if (!dataSlot || dataSlot.status === "planned_slot") return;

  const taskSources = Array.isArray(companyConfig.task_sources)
    ? companyConfig.task_sources
    : [];
  const requiredSources = [
    {
      kind: "todo-tasks-json",
      nestedPath:
        "mission-control/db/data/mission-control/TODO.tasks.json",
      rootPath: "TODO.tasks.json",
    },
    {
      kind: "done-tasks-json",
      nestedPath:
        "mission-control/db/data/mission-control/DONE.tasks.json",
      rootPath: "DONE.tasks.json",
    },
  ];

  for (const { kind, nestedPath, rootPath } of requiredSources) {
    const sourcesOfTruth = taskSources.filter(
      (source) =>
        source?.kind === kind && source.authority === "source-of-truth",
    );
    if (
      sourcesOfTruth.length !== 1 ||
      sourcesOfTruth[0]?.path !== nestedPath
    ) {
      failures.push(
        `company.gen3.json/task_sources: aktivní mission-control/db vyžaduje právě jeden ${kind} source-of-truth na cestě ${nestedPath}`,
      );
    }

    const invalidRootSources = taskSources.filter(
      (source) =>
        source?.kind === kind &&
        source.path === rootPath &&
        source.authority !== "mirror",
    );
    if (invalidRootSources.length > 0) {
      failures.push(
        `company.gen3.json/task_sources: root ${rootPath} smí být při aktivním mission-control/db pouze authority mirror`,
      );
    }
  }
}

function hasCheckoutCoordinates(item) {
  return (
    typeof item.git?.url === "string" &&
    item.git.url.trim() !== "" &&
    typeof item.git?.branch === "string" &&
    item.git.branch.trim() !== ""
  );
}

function collectDuplicates(values, onDuplicate) {
  const seen = new Set();
  for (const value of values) {
    if (seen.has(value)) onDuplicate(value);
    seen.add(value);
  }
}

function portablePathIdentity(value) {
  return typeof value === "string" ? value.toLowerCase() : null;
}

function legacySlotSlugFromPath(value) {
  if (typeof value !== "string") return null;
  if (value === "mission-control/db") return null;
  const segments = value.split("/");
  return segments.at(-1) || null;
}

async function loadValidators(schemaRoot) {
  if (!validatorCache.has(schemaRoot)) {
    validatorCache.set(schemaRoot, buildValidators(schemaRoot));
  }
  return validatorCache.get(schemaRoot);
}

async function buildValidators(schemaRoot) {
  const [companySchema, modulesManifestSchema] = await Promise.all([
    readJson(`${schemaRoot}/company.gen3.schema.json`),
    readJson(`${schemaRoot}/modules.manifest.schema.json`),
  ]);
  return compileValidators({ companySchema, modulesManifestSchema });
}

function loadSchemaDocumentValidators(schemaDocuments) {
  if (
    !schemaDocuments
    || typeof schemaDocuments !== "object"
    || Array.isArray(schemaDocuments)
  ) {
    throw new TypeError("schemaDocuments musí být objekt s company a modulesManifest schématem");
  }
  if (!schemaDocumentValidatorCache.has(schemaDocuments)) {
    schemaDocumentValidatorCache.set(
      schemaDocuments,
      compileValidators({
        companySchema: schemaDocuments.company,
        modulesManifestSchema: schemaDocuments.modulesManifest,
      }),
    );
  }
  return schemaDocumentValidatorCache.get(schemaDocuments);
}

function compileValidators({ companySchema, modulesManifestSchema }) {
  const ajv = { compile(schema) {
    const validate = (value) => {
      validate.errors = validateAgainstSchema(value, schema).map(message => ({ instancePath: "", message }));
      return validate.errors.length === 0;
    };
    return validate;
  } };
  return {
    company: ajv.compile(companySchema),
    modulesManifest: ajv.compile(modulesManifestSchema),
  };
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}
