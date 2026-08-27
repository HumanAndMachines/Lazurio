import { existsSync } from "fs";
import { readFile, readdir } from "fs/promises";
import { basename, dirname, join } from "path";
import {
  declaredOrganizationTeamSlugs,
  organizationManifestIdentityIssues,
  organizationModuleSlotScopedContractIssues,
  organizationMountStructureIssues,
  organizationRelativePathIssue,
  organizationSlotBoundaryIssueIsFatal,
} from "./discovery-lib.mjs";
import {
  githubRepositoryCoordinate,
  isCanonicalOrganizationRepositorySlotPath,
  isOrganizationRepositoryDbSlot,
  isOrganizationRootSlotDescendantPath,
  isOrganizationSlotContainerPath,
  normalizeOrganizationSlotPath,
  organizationRootRepositoryAliasIssues,
  organizationRootRepositoryBranch,
  organizationRootRepositoryRemote,
  organizationRepositorySlotCollectionConflicts,
  organizationSlotRepositoryBranch,
  organizationSlotRepositoryId,
  organizationSlotRepositoryMountIssue,
  organizationSlotRepositoryRemote,
  organizationSlotScope,
  organizationSlotWorkspace,
} from "../core/organization-slot-scope-lib.mjs";
import {
  inspectCanonicalPathBoundary,
  isSamePath,
} from "../core/path-boundary-lib.mjs";
import {
  buildOrganizationAgentReviewAction,
  buildModuleLocationRepairAction,
  buildModuleSlotAgentReviewAction,
  buildRepositoryLocationIssue,
  buildSlotPathAgentReviewAction,
} from "../core/module-location-repair-contract-lib.mjs";
import {
  classifyOrganizationModuleCheckoutLocation,
  inspectOrganizationModuleCheckoutCandidates,
  organizationModuleDeclarationClaims,
} from "./module-location-candidates-lib.mjs";

export async function buildGitInventory({ companiesRoot, organizations = null } = {}) {
  if (!companiesRoot) throw new Error("buildGitInventory requires companiesRoot");
  // Scan-first (decision 0042): default seznam Organizací je sken namountovaných
  // organizations/*/company.gen3.json, ne registry v launchpad.gen3.json. Explicitní
  // `organizations` (např. z discovery výstupu nebo z testu) má přednost.
  const repos = [];
  const planned = [];
  const warnings = [];
  const inventoryIssues = [];
  const orgs = organizations ?? (await discoverMountedOrganizations(companiesRoot, warnings));
  let realCompaniesRoot = null;

  for (const organization of orgs) {
    const normalized = normalizeOrganization(organization);
    if (!normalized) continue;
    const organizationRoot = join(companiesRoot, normalized.path);
    let realOrganizationRoot = null;
    let companyConfig = null;
    // Strukturální gate platí i pro explicitně předané organizations (např.
    // discovery výstup): přítomný mount, který app discovery hard-failuje, se
    // nesmí objevit jako akční repo. Chybějící mount si nechává původní chování
    // (root repo záznam + warning) — nepřítomnost není rozbitá hranice.
    if (existsSync(organizationRoot)) {
      const organizationMountRoot = dirname(organizationRoot);
      const mountBoundary = await inspectCanonicalPathBoundary({
        rootPath: companiesRoot,
        rootRealPath: realCompaniesRoot,
        targetPath: organizationMountRoot,
      });
      realCompaniesRoot = mountBoundary.rootRealPath;
      const rootBoundary = mountBoundary.ok
        ? await inspectCanonicalPathBoundary({
            rootPath: organizationMountRoot,
            rootRealPath: mountBoundary.targetRealPath,
            targetPath: organizationRoot,
          })
        : { ok: false, targetRealPath: null };
      const expectedRealOrganizationRoot = mountBoundary.targetRealPath
        ? join(mountBoundary.targetRealPath, basename(organizationRoot))
        : null;
      if (
        !rootBoundary.ok
        || !expectedRealOrganizationRoot
        || !isSamePath(expectedRealOrganizationRoot, rootBoundary.targetRealPath)
      ) {
        recordInventoryIssue({
          inventoryIssues,
          warnings,
          organization: normalized,
          code: "organization_mount_boundary_invalid",
          message: `${normalized.path}: mount vynechán z git inventáře — kanonická cesta se přes symlink/junction dostává mimo Lazurio root nebo ji nejde bezpečně ověřit`,
        });
        continue;
      }
      realOrganizationRoot = rootBoundary.targetRealPath;
      const structureIssues = organizationMountStructureIssues({
        organizationRoot,
        label: normalized.path,
      });
      if (structureIssues.length > 0) {
        recordInventoryIssue({
          inventoryIssues,
          warnings,
          organization: normalized,
          code: "organization_structure_invalid",
          message: `${normalized.path}: mount vynechán z git inventáře — chybí povinná GEN3 struktura (${structureIssues.join("; ")})`,
        });
        continue;
      }
      try {
        companyConfig = await readJson(join(organizationRoot, "company.gen3.json"));
      } catch (error) {
        recordInventoryIssue({
          inventoryIssues,
          warnings,
          organization: normalized,
          code: "organization_config_unreadable",
          message: `${normalized.path}: company.gen3.json nejde přečíst; Organization root ani child Git akce nejsou bezpečné — ${error.message}`,
        });
        continue;
      }
      const rootAliasIssues = organizationRootRepositoryAliasIssues(companyConfig);
      if (rootAliasIssues.length > 0) {
        for (const issue of rootAliasIssues) {
          recordInventoryIssue({
            inventoryIssues,
            warnings,
            organization: normalized,
            code: issue.code,
            message: `${normalized.path}: company.gen3.json ${issue.detail}; Organization root ani child Git akce byly zastavené`,
          });
        }
        continue;
      }
      normalized.repository = organizationRootRepositoryRemote(companyConfig);
      normalized.git_url = null;
      normalized.default_branch = organizationRootRepositoryBranch(companyConfig) ?? "main";
    }
    addOrganizationRootRepo(repos, normalized, companiesRoot);
    if (!existsSync(organizationRoot)) {
      recordInventoryIssue({
        inventoryIssues,
        warnings,
        organization: normalized,
        code: "organization_mount_missing",
        message: `${normalized.path}: organization mount chybí`,
      });
      continue;
    }
    const manifest = await readOrganizationModuleManifest(organizationRoot);
    if (!manifest) {
      recordInventoryIssue({
        inventoryIssues,
        warnings,
        organization: normalized,
        code: "organization_manifest_unreadable",
        message: `${normalized.path}: modules.manifest.json chybí nebo nejde přečíst`,
      });
      continue;
    }
    const manifestSlots = Array.isArray(manifest.module_slots) ? manifest.module_slots : [];
    const identity = organizationManifestIdentityIssues({
      companyConfig,
      manifest,
      label: normalized.path,
    });
    warnings.push(...identity.warnings);
    if (identity.fatalIssues.length > 0) {
      for (const message of identity.fatalIssues) {
        recordInventoryIssue({
          inventoryIssues,
          warnings,
          organization: normalized,
          code: "organization_identity_invalid",
          message: `${message}; child repozitáře byly vynechány z Git akcí`,
        });
      }
      continue;
    }
    const companyModules = Array.isArray(companyConfig?.modules) ? companyConfig.modules : [];
    const declaredModuleClaims = organizationModuleDeclarationClaims([
      ...manifestSlots,
      ...companyModules,
    ]);
    const teamSlugs = declaredOrganizationTeamSlugs(companyConfig);
    const githubOrg = companyConfig?.company?.github_org ?? manifest?.github_org ?? null;
    const unsafeSlotBoundaries = [];
    for (const { slots, source } of [
      { slots: manifestSlots, source: "modules.manifest.json module_slots" },
      { slots: companyModules, source: "company.gen3.json modules" },
    ]) {
      for (const [index, slot] of slots.entries()) {
        const issue = organizationRelativePathIssue({ organizationRoot, path: slot?.path });
        if (!organizationSlotBoundaryIssueIsFatal({ path: slot?.path, issue })) continue;
        unsafeSlotBoundaries.push({ source, index, issue });
      }
    }
    if (unsafeSlotBoundaries.length > 0) {
      for (const { source, index, issue } of unsafeSlotBoundaries) {
        recordInventoryIssue({
          inventoryIssues,
          warnings,
          organization: normalized,
          code: "organization_module_mount_boundary_invalid",
          message: `${normalized.path}: ${source}[${index}].path ${issue}; Organization child Git akce byly zastavené`,
        });
      }
      continue;
    }
    const ambiguousSlots = new Set();
    for (const { conflicts, source } of [
      {
        conflicts: organizationRepositorySlotCollectionConflicts(manifestSlots),
        source: "modules.manifest.json module_slots",
      },
      {
        conflicts: organizationRepositorySlotCollectionConflicts(companyModules),
        source: "company.gen3.json modules",
      },
      {
        conflicts: organizationRepositorySlotCollectionConflicts(
          [...manifestSlots, ...companyModules],
          { allowEquivalentDuplicates: true },
        ),
        source: "modules.manifest.json + company.gen3.json",
      },
    ]) {
      for (const conflict of conflicts) {
        for (const slot of conflict.slots) {
          ambiguousSlots.add(slot);
          recordInventoryIssue({
            inventoryIssues,
            warnings,
            organization: normalized,
            code: "slot_collection_ambiguous",
            message: `${normalized.path}: ${source} má nejednoznačnou repo projekci — ${conflict.detail}; izolovaný slot nevstoupí do Git akcí`,
            slot,
          });
        }
      }
    }
    const candidateInspectionCache = new Map();
    const inspectSlotCandidates = async (rawSlot) => {
      const identity = moduleCandidateIdentity(rawSlot);
      if (!identity) return null;
      if (!candidateInspectionCache.has(identity.module)) {
        candidateInspectionCache.set(identity.module, inspectOrganizationModuleCheckoutCandidates({
          organizationRoot,
          organizationSlug: normalized.slug,
          moduleSlug: identity.module,
        }));
      }
      return {
        ...identity,
        inspection: await candidateInspectionCache.get(identity.module),
      };
    };
    const candidateProbeSlot = manifestSlots.find((slot) =>
      !ambiguousSlots.has(slot) && moduleCandidateIdentity(slot)
    );
    if (candidateProbeSlot) {
      const probe = await inspectSlotCandidates(candidateProbeSlot);
      if (probe.inspection.boundary_errors.length > 0) {
        for (const boundaryError of probe.inspection.boundary_errors) {
          recordInventoryIssue({
            inventoryIssues,
            warnings,
            organization: normalized,
            code: "organization_module_mount_boundary_invalid",
            message: `${normalized.path}: module mount kandidáty nelze bezpečně inventarizovat — ${boundaryError.message}`,
          });
        }
        continue;
      }
    }
    for (const rawSlot of manifestSlots) {
      if (ambiguousSlots.has(rawSlot)) continue;
      const containmentIssue = organizationRelativePathIssue({
        organizationRoot,
        path: rawSlot?.path,
      });
      const pathBoundaryIssue = slotPathBoundaryInventoryIssue(rawSlot);
      const candidateContext = await inspectSlotCandidates(rawSlot);
      const expectedLocationPath = candidateContext
        ? repositoryExpectedModulePath(rawSlot, candidateContext.path)
        : null;
      const location = candidateContext
        ? await classifyOrganizationModuleCheckoutLocation({
            organizationRoot,
            expectedPath: expectedLocationPath,
            inspection: candidateContext.inspection,
            moduleSlug: candidateContext.module,
            declaredModuleClaims,
          })
        : null;
      const slot = normalizeModuleSlot(rawSlot, normalized);
      if (slot) {
        const scopedContractIssues = organizationModuleSlotScopedContractIssues({
          slot: rawSlot,
          teamSlugs,
          githubOrg,
          checkRemote: true,
          materialized: existsSync(join(organizationRoot, slot.path)),
        });
        if (scopedContractIssues.length > 0) {
          for (const issue of scopedContractIssues) {
            recordScopedSlotInventoryIssue({
              inventoryIssues,
              warnings,
              organization: normalized,
              slot,
              code: issue.code,
              detail: issue.detail,
            });
          }
          continue;
        }
      }
      if (pathBoundaryIssue) {
        const message = `${normalized.path}: slot ${String(rawSlot?.path ?? "<missing>")} vynechán z git/worktree inventáře — ${pathBoundaryIssue}${
          containmentIssue ? `; module_slots[].path ${containmentIssue}` : ""
        }`;
        if (pathBoundaryIssue.startsWith("repository mount basename ") && !containmentIssue) {
          const issue = locationIssueFromClassification({
            classification: location,
            organization: normalized,
            module: candidateContext?.module,
            expectedPath: expectedLocationPath,
            fallbackPath: candidateContext?.path,
            fallbackMessage: message,
            sources: ["modules.manifest.json#module_slots"],
          });
          warnings.push(issue.message);
          inventoryIssues.push(issue);
        } else {
          recordInventoryIssue({
            inventoryIssues,
            warnings,
            organization: normalized,
            code: "slot_contract_invalid",
            message,
            slot: rawSlot,
          });
        }
        continue;
      }
      if (containmentIssue) {
        const caseOnlyLocationMismatch = location?.status === "mismatch"
          && isLeafOnlyCaseDrift(expectedLocationPath, location.found_path);
        if (caseOnlyLocationMismatch) {
          const issue = locationIssueFromClassification({
            classification: location,
            organization: normalized,
            module: candidateContext.module,
            expectedPath: expectedLocationPath,
            fallbackPath: candidateContext.path,
            fallbackMessage: `${normalized.path}: module ${candidateContext.module} má case-only checkout ${location.found_path}, ale manifest očekává ${expectedLocationPath}`,
            sources: ["lazurio.module.json"],
          });
          warnings.push(issue.message);
          inventoryIssues.push(issue);
          continue;
        }
        recordInventoryIssue({
          inventoryIssues,
          warnings,
          organization: normalized,
          code: "slot_path_boundary_invalid",
          message: `${normalized.path}: module_slots[].path ${containmentIssue}; slot vynechán z akčního Git inventáře`,
          slot: rawSlot,
        });
        continue;
      }
      if (!slot) continue;
      const rootInventoryIssue = rootSlotInventoryIssue(rawSlot, slot);
      if (rootInventoryIssue) {
        recordInventoryIssue({
          inventoryIssues,
          warnings,
          organization: normalized,
          code: "root_slot_contract_invalid",
          message: `${normalized.path}: root slot ${slot.path} vynechán z git/worktree inventáře — ${rootInventoryIssue}`,
          slot: rawSlot,
        });
        continue;
      }
      // Module-owned repository-db checkout je deklarativní/read-only resource,
      // ne obecný Git action target. Nezařazujeme jej do repos ani planned,
      // takže update, commit/push ani worktree surfaces nad ním nevzniknou.
      if (isOrganizationRepositoryDbSlot(rawSlot, slot.path)) continue;
      const observedLocationIssue = await observedModuleLocationIssue({
        organization: normalized,
        slot,
        classification: location,
      });
      if (observedLocationIssue) {
        warnings.push(observedLocationIssue.message);
        inventoryIssues.push(observedLocationIssue);
        continue;
      }
      if (!slot.repo) {
        planned.push(slotRecord({ organization: normalized, slot, companiesRoot }));
        continue;
      }
      const absoluteSlotPath = join(organizationRoot, slot.path);
      if (existsSync(absoluteSlotPath)) {
        const slotBoundary = await inspectCanonicalPathBoundary({
          rootPath: organizationRoot,
          rootRealPath: realOrganizationRoot,
          targetPath: absoluteSlotPath,
        });
        realOrganizationRoot = slotBoundary.rootRealPath;
        if (!slotBoundary.ok) {
          recordInventoryIssue({
            inventoryIssues,
            warnings,
            organization: normalized,
            code: "slot_mount_boundary_invalid",
            message: `${normalized.path}: slot ${slot.path} vynechán z git/worktree inventáře — existující checkout se přes symlink/junction dostává mimo root Organizace nebo jeho kanonickou cestu nejde bezpečně ověřit`,
            slot: rawSlot,
          });
          continue;
        }
      }
      repos.push(repoRecord({ organization: normalized, slot, companiesRoot }));
    }
  }

  return {
    schema_version: "companiesascode.launchpad.git_inventory.v1",
    generated_at: new Date().toISOString(),
    repos,
    planned,
    warnings,
    inventory_issues: deduplicateInventoryIssues(inventoryIssues),
  };
}

async function observedModuleLocationIssue({ organization, slot, classification }) {
  if (
    !(slot.path.startsWith("workspace/") || slot.path.startsWith("modules/"))
    || !classification
    || ["healthy", "vacant"].includes(classification.status)
    || exactCanonicalMarkerlessCheckoutCanUpdate({ slot, classification })
  ) return null;
  return locationIssueFromClassification({
    classification,
    organization,
    module: slot.module,
    expectedPath: slot.path,
    fallbackPath: slot.path,
    fallbackMessage: `${organization.path}: module ${slot.module} má neplatné nebo nejednoznačné lokální umístění`,
    sources: ["lazurio.module.json"],
  });
}

// A missing Module marker cannot authorize relocation or app execution, but
// the exact declared mount is still safe to inspect through the ordinary Git
// update gates. Keeping it in inventory lets Sync fast-forward to a reviewed
// commit that publishes the marker instead of permanently wedging the checkout.
// Any path mismatch, ambiguity, boundary issue or non-missing marker failure
// remains quarantined and cannot create a duplicate clone.
function exactCanonicalMarkerlessCheckoutCanUpdate({ slot, classification }) {
  const exactCandidate = classification.unverified?.find((candidate) =>
    candidate.relative_path === slot.path
  ) ?? null;
  return classification.status === "unverified"
    && classification.reason === "marker_missing"
    && classification.target_occupied === true
    && classification.found_path === slot.path
    && classification.observed_paths?.length === 1
    && classification.observed_paths[0] === slot.path
    // A regular primary-checkout .git directory is the only metadata boundary
    // this compatibility lane may update. A .git file can redirect to a linked
    // worktree and a symlink/junction can redirect outside the Organization;
    // both remain slot-local quarantine evidence instead of Git action input.
    && exactCandidate?.reason === "marker_missing"
    && exactCandidate.git_metadata_kind === "directory";
}

function locationIssueFromClassification({
  classification,
  organization,
  module,
  expectedPath,
  fallbackPath,
  fallbackMessage,
  sources,
}) {
  const status = classification?.status ?? "mismatch";
  const observedPaths = classification?.observed_paths?.length > 0
    ? classification.observed_paths
    : [fallbackPath].filter(Boolean);
  const foundPath = classification?.found_path ?? observedPaths[0] ?? fallbackPath ?? expectedPath;
  if (status === "ambiguous" || status === "boundary_invalid") {
    const message = status === "boundary_invalid"
      ? `${organization.path}: module ${module} vynechán z git inventáře — kandidátní mount boundary nelze bezpečně ověřit`
      : `${organization.path}: module ${module} vynechán z git inventáře — více checkoutů nebo obsazený cíl znemožňuje bezpečně vybrat cestu (${observedPaths.join(", ")})`;
    return {
      schema_version: "lazurio.organization_issue.v1",
      severity: "blocking",
      scope: status === "boundary_invalid" ? "organization" : "module_slot",
      status: "quarantined",
      code: status === "boundary_invalid"
        ? "organization_module_mount_boundary_invalid"
        : "repository_location_ambiguous",
      organization: organization.slug,
      organization_path: organization.path,
      module: status === "boundary_invalid" ? null : module,
      path: foundPath,
      expected_path: expectedPath,
      observed_paths: observedPaths,
      message,
      sources,
      next_action: status === "boundary_invalid"
        ? buildOrganizationAgentReviewAction({
            organization: organization.slug,
            reason: "organization_module_mount_boundary_invalid",
            path: organization.path,
            detail: message,
          })
        : buildModuleSlotAgentReviewAction({
            organization: organization.slug,
            module,
            reason: "repository_location_ambiguous",
            path: observedPaths.join(", "),
            detail: `${message}; očekávaná cesta: ${expectedPath}`,
          }),
    };
  }
  if (status === "unverified") {
    const reason = classification?.reason ?? "checkout_unverified";
    const message = `${organization.path}: module ${module} vynechán z git inventáře — checkout ${foundPath} nelze autorizovat (${reason}); cílový clone ${expectedPath} nevznikne`;
    return {
      schema_version: "lazurio.organization_issue.v1",
      severity: "blocking",
      scope: "module_slot",
      status: "quarantined",
      code: "repository_transition_unverified",
      organization: organization.slug,
      organization_path: organization.path,
      module,
      path: foundPath,
      expected_path: expectedPath,
      observed_paths: observedPaths,
      message,
      sources,
      next_action: buildModuleLocationRepairAction({
        organization: organization.slug,
        module,
        reason: `repository_transition_unverified:${reason}`,
        foundPath,
        expectedPath,
        detail: message,
      }),
    };
  }
  const message = status === "mismatch" && classification?.found_path
    ? `${organization.path}: module ${module} vynechán z git inventáře — checkout je v ${foundPath}, ale manifest očekává ${expectedPath}`
    : fallbackMessage;
  return buildRepositoryLocationIssue({
    organization: organization.slug,
    organizationPath: organization.path,
    module,
    path: foundPath,
    expectedPath,
    message,
    sources,
    repairable: Boolean(module && expectedPath),
  });
}

function moduleCandidateIdentity(slot) {
  if (!slot || typeof slot.path !== "string") return null;
  const path = normalizeOrganizationSlotPath(slot.path);
  if (
    !path
    || !isCanonicalOrganizationRepositorySlotPath(slot.path)
    || !(path.startsWith("workspace/") || path.startsWith("modules/"))
  ) return null;
  const module = organizationSlotRepositoryId(slot, path);
  return module ? { module, path } : null;
}

function repositoryExpectedModulePath(slot, declaredPath) {
  const coordinate = githubRepositoryCoordinate(
    organizationSlotRepositoryRemote(slot, declaredPath),
  );
  if (!coordinate) return declaredPath;
  const container = declaredPath.split("/").slice(0, -1).join("/");
  return `${container}/${coordinate.repository}`;
}

function isLeafOnlyCaseDrift(expectedPath, observedPath) {
  if (typeof expectedPath !== "string" || typeof observedPath !== "string") return false;
  const expected = expectedPath.split("/");
  const observed = observedPath.split("/");
  return expected.length === 2
    && observed.length === 2
    && expected[0] === observed[0]
    && expected[1] !== observed[1]
    && expected[1].toLowerCase() === observed[1].toLowerCase();
}

function recordInventoryIssue({
  inventoryIssues,
  warnings,
  organization,
  code,
  message,
  slot = null,
  nextAction = undefined,
}) {
  warnings.push(message);
  const path = typeof slot?.path === "string" ? normalizeOrganizationSlotPath(slot.path) : null;
  const module = path && isCanonicalOrganizationRepositorySlotPath(slot.path)
    ? organizationSlotRepositoryId(slot, path)
    : null;
  const defaultAction = slot && module
    ? buildModuleSlotAgentReviewAction({
        organization: organization.slug,
        module,
        reason: code,
        path: path ?? slot.path,
        detail: message,
      })
    : slot && (path ?? slot.path)
      ? buildSlotPathAgentReviewAction({
          organization: organization.slug,
          reason: code,
          path: path ?? slot.path,
          detail: message,
        })
      : buildOrganizationAgentReviewAction({
          organization: organization.slug,
          reason: code,
          path: organization.path,
          detail: message,
        });
  inventoryIssues.push({
    schema_version: "lazurio.organization_issue.v1",
    severity: "blocking",
    scope: slot ? "module_slot" : "organization",
    status: "quarantined",
    code,
    organization: organization.slug,
    organization_path: organization.path,
    module,
    path,
    expected_path: null,
    message,
    sources: ["git_inventory"],
    next_action: nextAction === undefined
      ? defaultAction
      : nextAction,
  });
}

function recordScopedSlotInventoryIssue({
  inventoryIssues,
  warnings,
  organization,
  slot,
  code,
  detail,
}) {
  const message = `${organization.path}: module ${slot.module} vynechán z Git akcí — ${detail}`;
  warnings.push(message);
  inventoryIssues.push({
    schema_version: "lazurio.organization_issue.v1",
    severity: "blocking",
    scope: "module_slot",
    status: "quarantined",
    code,
    organization: organization.slug,
    organization_path: organization.path,
    module: slot.module,
    path: slot.path,
    expected_path: null,
    message,
    sources: ["modules.manifest.json#module_slots"],
    next_action: buildModuleSlotAgentReviewAction({
      organization: organization.slug,
      module: slot.module,
      reason: code,
      path: slot.path,
      detail: message,
    }),
  });
}

function deduplicateInventoryIssues(issues) {
  const unique = new Map();
  for (const issue of issues) {
    const key = `${issue.organization}\0${issue.module ?? ""}\0${issue.path ?? ""}\0${issue.code}\0${issue.message}`;
    if (!unique.has(key)) unique.set(key, issue);
  }
  return [...unique.values()];
}

export async function readLaunchpadConfig(companiesRoot) {
  const path = join(companiesRoot, "launchpad.gen3.json");
  if (!existsSync(path)) return {};
  return readJson(path);
}

const ignoredMountDirs = new Set([".git", ".worktrees", "node_modules"]);

// Scan-first (decision 0042): jediná autorita jsou namountované
// organizations/*/company.gen3.json, ne registry v launchpad.gen3.json. Slug,
// display_name a Git metadata (repository/git_url/default_branch) čteme z
// company.gen3.json. Mount s markerem organization_kind=template je z inventáře
// vyloučený úplně (decision 0077): git inventory krmí /api/git/repos, mission
// control plan indexing a worktree create/publish — template mount se nesmí
// stát akčním repozitářem Organizace na builder surfaces.
export async function discoverMountedOrganizations(companiesRoot, warnings = null) {
  const config = await readLaunchpadConfig(companiesRoot);
  const mountpoint = config.organization_mountpoint ?? "organizations";
  const mountRoot = join(companiesRoot, mountpoint);
  if (!existsSync(mountRoot)) return [];
  const organizations = [];
  const seen = new Set();
  for (const entry of (await readdir(mountRoot, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith(".") || ignoredMountDirs.has(entry.name)) continue;
    const path = `${mountpoint}/${entry.name}`;
    const companyConfigPath = join(companiesRoot, path, "company.gen3.json");
    if (!existsSync(companyConfigPath)) continue;
    let companyConfig;
    try {
      companyConfig = await readJson(companyConfigPath);
    } catch (error) {
      warnings?.push(`${path}: company.gen3.json nejde přečíst; Organization byla vynechána z Git inventáře — ${error.message}`);
      continue;
    }
    // Stejný strojový marker jako discovery-lib (organizationKind): template mount
    // zůstává mimo git/worktree akční plochy.
    if (companyConfig?.organization_kind === "template") continue;
    // Stejný strukturální gate jako app discovery: mount, který tam hard-failuje,
    // nesmí zůstat akční v git/worktree APIs.
    const structureIssues = organizationMountStructureIssues({
      organizationRoot: join(companiesRoot, path),
      label: path,
    });
    if (structureIssues.length > 0) {
      warnings?.push(`${path}: mount vynechán z git inventáře — chybí povinná GEN3 struktura (${structureIssues.join("; ")})`);
      continue;
    }
    const organization = mountedOrganizationFromCompanyConfig({ companyConfig, path, directoryName: entry.name });
    if (!organization || seen.has(organization.slug)) continue;
    organizations.push(organization);
    seen.add(organization.slug);
  }
  return organizations;
}

function mountedOrganizationFromCompanyConfig({ companyConfig, path, directoryName }) {
  const company = companyConfig.company ?? {};
  const directorySlug = directoryName.replace(/_GEN3$/, "");
  const declaredSlug = typeof company.slug === "string" ? company.slug : null;
  // Zrcadlí placeholder guard discovery-lib (autoOrganizationFromCompanyJson):
  // placeholder slug = nedokončený scaffold, nesmí se stát akční Organizací na
  // git/worktree plochách. Fallback na jméno adresáře platí jen pro CHYBĚJÍCÍ slug.
  if (isPlaceholderSlug(declaredSlug ?? directorySlug)) return null;
  const slug = declaredSlug ?? directorySlug;
  return normalizeOrganization({
    slug,
    display_name: nonPlaceholderText(company.display_name) ?? slug,
    path,
    default_branch: organizationRootRepositoryBranch(companyConfig),
    repository: organizationRootRepositoryRemote(companyConfig),
    git_url: company.git_url ?? null,
  });
}

function isPlaceholderSlug(slug) {
  const normalized = String(slug ?? "").trim().toLowerCase();
  return !normalized || normalized.includes("<") || normalized.includes("vyplnit") || normalized === "example";
}

function nonPlaceholderText(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" || trimmed.includes("<") ? null : trimmed;
}

async function readOrganizationModuleManifest(organizationRoot) {
  for (const relativePath of ["modules.manifest.json", "company/scripts/modules.manifest.json"]) {
    const path = join(organizationRoot, relativePath);
    if (!existsSync(path)) continue;
    try {
      return await readJson(path);
    } catch {
      return null;
    }
  }
  return null;
}

function addOrganizationRootRepo(repos, organization, companiesRoot) {
  repos.push({
    key: `${organization.slug}::root`,
    organization: organization.slug,
    organization_display_name: organization.display_name,
    organization_path: organization.path,
    workspace: "root",
    module: "root",
    name: `${organization.display_name} root`,
    repo_kind: "organization_root",
    repo_path: organization.path,
    absolute_path: join(companiesRoot, organization.path),
    expected_branch: organization.default_branch ?? "main",
    repo: organization.repository ?? organization.git_url ?? null,
    remote: sanitizeRemote(organization.repository ?? organization.git_url),
  });
}

function repoRecord({ organization, slot, companiesRoot }) {
  const key = `${organization.slug}::${slot.module}`;
  return {
    ...slotRecord({ organization, slot, companiesRoot }),
    key,
    repo_kind: repoKindForSlot(slot),
    absolute_path: join(companiesRoot, organization.path, slot.path),
    expected_branch:
      slot.space === "root"
        ? slot.branch
        : slot.branch ?? organization.default_branch ?? "main",
    remote: sanitizeRemote(slot.repo),
  };
}

function slotRecord({ organization, slot, companiesRoot }) {
  return {
    key: `${organization.slug}::${slot.module}`,
    organization: organization.slug,
    organization_display_name: organization.display_name,
    organization_path: organization.path,
    space: slot.space,
    workspace: slot.workspace,
    module: slot.module,
    name: slot.name,
    repo_kind: repoKindForSlot(slot),
    repo_path: `${organization.path}/${slot.path}`,
    absolute_path: join(companiesRoot, organization.path, slot.path),
    expected_branch:
      slot.space === "root"
        ? slot.branch
        : slot.branch ?? organization.default_branch ?? "main",
    repo: slot.repo,
    slot_path: slot.path,
    category: slot.category ?? null,
    default_access: slot.default_access ?? null,
    required_roles: slot.required_roles ?? [],
  };
}

function normalizeOrganization(organization) {
  if (!organization || typeof organization !== "object") return null;
  if (organization.status === "planned") return null;
  if (typeof organization.slug !== "string" || typeof organization.path !== "string") return null;
  return {
    ...organization,
    display_name: organization.display_name ?? organization.slug,
    default_branch: organization.default_branch ?? "main",
  };
}

function normalizeModuleSlot(slot, organization) {
  if (!slot || typeof slot !== "object" || typeof slot.path !== "string" || slot.path.trim() === "") return null;
  const path = normalizeOrganizationSlotPath(slot.path);
  if (!path) return null;
  const module = organizationSlotRepositoryId(slot, path);
  if (module === null) return null;
  const space = organizationSlotScope(slot, path);
  const repo = organizationSlotRepositoryRemote(slot, path);
  const branch = organizationSlotRepositoryBranch(slot, path)
    ?? (space === "root" ? null : organization.default_branch ?? "main");
  return {
    path,
    module,
    name: slot.name ?? humanizeSlug(module),
    space,
    workspace: organizationSlotWorkspace(slot, path),
    category: slot.category ?? null,
    default_access: slot.default_access ?? null,
    required_roles: Array.isArray(slot.required_roles) ? slot.required_roles : [],
    status: slot.status ?? null,
    repo,
    branch,
  };
}

function slotPathBoundaryInventoryIssue(slot) {
  if (!slot || typeof slot.path !== "string" || slot.path.trim() === "") {
    return "slot path chybí";
  }
  const normalizedPath = normalizeOrganizationSlotPath(slot.path);
  if (isOrganizationSlotContainerPath(normalizedPath)) {
    return "Organization kontejner není repozitářový slot; použij workspace/<slug>, modules/<slug> nebo productionspace/<slug>";
  }
  if (isOrganizationRootSlotDescendantPath(normalizedPath)) {
    return "cesta je uvnitř rezervované Organization root boundary a není samostatný root slot";
  }
  if (!isCanonicalOrganizationRepositorySlotPath(slot.path)) {
    return "cesta není kanonická podporovaná Organization-relative repo boundary";
  }
  if (organizationSlotRepositoryId(slot, normalizedPath) === null) {
    return "repository mount potřebuje explicitní stabilní lowercase slug";
  }
  const repositoryMountIssue = organizationSlotRepositoryMountIssue(slot, normalizedPath);
  if (repositoryMountIssue) return repositoryMountIssue;
  return null;
}

function rootSlotInventoryIssue(rawSlot, normalizedSlot) {
  if (normalizedSlot.space !== "root") return null;
  if (rawSlot.space !== "root") {
    return 'musí explicitně deklarovat space: "root"';
  }
  const forbiddenFields = [
    "workspace",
    "workspaces",
    "teams",
    "repo",
    "repository",
    "branch",
  ].filter((field) => Object.prototype.hasOwnProperty.call(rawSlot, field));
  if (forbiddenFields.length > 0) {
    return `nesmí deklarovat root-neplatná pole (${forbiddenFields.join(", ")})`;
  }
  if (normalizedSlot.status === "planned_slot") {
    return rawSlot.git === undefined ? null : "planned_slot nesmí deklarovat git";
  }
  if (!normalizedSlot.repo || !normalizedSlot.branch) {
    return "aktivní root slot musí mít úplné git.url i git.branch";
  }
  if (
    normalizedSlot.path === "mission-control/db" &&
    normalizedSlot.branch !== "v3"
  ) {
    return 'mission-control/db musí používat přesnou větev "v3"';
  }
  return null;
}

function repoKindForSlot(slot) {
  if (slot.space === "root") return "root_repo";
  if (slot.space === "productionspace") return "productionspace";
  if (slot.space === "workspace") return "module";
  return "root_repo";
}

function sanitizeRemote(remote) {
  if (!remote || typeof remote !== "string") return null;
  const github = githubRepositoryCoordinate(remote);
  if (github) return { url_kind: "github", owner_repo: github.ownerRepo };
  return { url_kind: "other" };
}

function humanizeSlug(slug) {
  return String(slug ?? "")
    .split(/[-_]/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}
