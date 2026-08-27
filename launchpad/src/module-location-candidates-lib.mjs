import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";

import {
  normalizeOrganizationSlotPath,
  organizationSlotRepositoryId,
} from "../../lazurio/core/organization-slot-scope-lib.mjs";

export const MODULE_MOUNT_CONTAINERS = Object.freeze(["workspace", "modules"]);
const UNKNOWN_MODULE_DECLARATION_OWNER = "__lazurio_unknown_module_owner__";

export function organizationModuleDeclarationClaims(slots) {
  return (Array.isArray(slots) ? slots : []).flatMap((slot) => {
    const path = normalizeOrganizationSlotPath(slot?.path);
    const pathParts = path?.split("/") ?? [];
    if (
      !path
      || pathParts.length !== 2
      || !MODULE_MOUNT_CONTAINERS.includes(pathParts[0].toLowerCase())
    ) return [];
    const module = organizationSlotRepositoryId(slot, path);
    // Safe non-canonical spellings and invalid/missing stable IDs still reserve
    // their normalized physical path. They cannot authorize a Module action,
    // but dropping them would let another slot claim or relocate their local
    // checkout. Callers reject traversal and boundary escapes before using
    // these conservative reservations.
    return [{
      path,
      module: module ?? UNKNOWN_MODULE_DECLARATION_OWNER,
    }];
  });
}

// Jediný scan kontrakt pro discovery, Git inventory i repair CLI. Kandidátem
// je pouze přímý, běžný adresář s explicitní shodnou module identity; symlink,
// junction, nečitelný marker ani odhad z názvu složky autoritu nevytváří.
export async function findOrganizationModuleCheckoutCandidates({
  organizationRoot,
  organizationSlug,
  moduleSlug,
}) {
  const inventory = await inspectOrganizationModuleCheckoutCandidates({
    organizationRoot,
    organizationSlug,
    moduleSlug,
  });
  return inventory.verified;
}

// Discovery consumers also need a persistent, read-only signal for a direct
// Git directory that plausibly belongs to the selected stable Module but whose
// marker cannot authorize it. Otherwise a missing/broken/company-drift marker
// disappears from inventory and a later Sync can mistake the slot for an empty
// clone destination. Suspects are never promoted to verified candidates and
// never authorize a filesystem mutation.
export async function inspectOrganizationModuleCheckoutCandidates({
  organizationRoot,
  organizationSlug,
  moduleSlug,
  lstatPath = lstat,
}) {
  const verified = [];
  const unverified = [];
  const foreignVerified = [];
  const boundaryErrors = [];
  const organizationStat = await lstatPath(organizationRoot).catch(() => null);
  const realOrganizationRoot = organizationStat?.isDirectory() && !organizationStat.isSymbolicLink()
    ? await realpath(organizationRoot).catch(() => null)
    : null;
  if (!realOrganizationRoot) {
    return {
      verified,
      unverified,
      foreign_verified: foreignVerified,
      boundary_errors: [{
        container: null,
        path: organizationRoot,
        code: "organization_boundary_invalid",
        message: "Organization root musí být existující běžný adresář bez symlinku/junction.",
      }],
    };
  }
  for (const container of MODULE_MOUNT_CONTAINERS) {
    const containerPath = join(organizationRoot, container);
    let containerStat;
    try {
      containerStat = await lstatPath(containerPath);
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      boundaryErrors.push({
        container,
        path: containerPath,
        code: "container_unreadable",
        message: `Mount container ${containerPath} nejde bezpečně ověřit.`,
      });
      continue;
    }
    if (!containerStat.isDirectory() || containerStat.isSymbolicLink()) {
      boundaryErrors.push({
        container,
        path: containerPath,
        code: "container_boundary_invalid",
        message: `Mount container ${containerPath} musí být běžný adresář bez symlinku/junction.`,
      });
      continue;
    }
    const realContainer = await realpath(containerPath).catch(() => null);
    const canonicalRelative = realContainer
      ? relative(realOrganizationRoot, realContainer)
      : null;
    if (
      !canonicalRelative
      || canonicalRelative.startsWith("..")
      || isAbsolute(canonicalRelative)
    ) {
      boundaryErrors.push({
        container,
        path: containerPath,
        code: "container_boundary_invalid",
        message: `Kanonická cesta mount containeru ${containerPath} musí zůstat uvnitř Organization rootu.`,
      });
      continue;
    }
    let entries;
    try {
      entries = await readdir(containerPath, { withFileTypes: true });
    } catch {
      boundaryErrors.push({
        container,
        path: containerPath,
        code: "container_unreadable",
        message: `Mount container ${containerPath} nejde bezpečně načíst.`,
      });
      continue;
    }
    for (const entry of entries) {
      const path = join(containerPath, entry.name);
      const relativePath = `${container}/${entry.name}`;
      if (entry.isSymbolicLink()) {
        // An exact stable-slug alias is evidence that local data already
        // occupies the pre-cutover identity. Never traverse or authorize it,
        // but keep it as a persistent suspect so Sync cannot clone beside it.
        if (entry.name === moduleSlug) {
          unverified.push({
            path,
            relative_path: relativePath,
            marker_path: join(path, "lazurio.module.json"),
            reason: "checkout_symlink",
            marker_id: null,
            marker_company: null,
            git_metadata_kind: "unknown",
          });
        }
        continue;
      }
      if (!entry.isDirectory()) continue;
      const markerPath = join(path, "lazurio.module.json");
      let gitMetadata = null;
      let gitMetadataIssue = null;
      try {
        gitMetadata = await lstatPath(join(path, ".git"));
      } catch (error) {
        if (error?.code !== "ENOENT") gitMetadataIssue = "git_metadata_unreadable";
      }
      let markerSource = null;
      let marker = null;
      let markerIssue = "marker_missing";
      try {
        const markerStat = await lstatPath(markerPath);
        // Module identity is an authority input for a filesystem mutation.
        // Following a symlink/junction here could make an unrelated checkout
        // impersonate the selected Module.
        if (!markerStat.isFile() || markerStat.isSymbolicLink()) {
          markerIssue = markerStat.isSymbolicLink() ? "marker_symlink" : "marker_not_regular";
        } else {
          markerSource = await readFile(markerPath, "utf8");
          marker = JSON.parse(markerSource);
          markerIssue = marker?.schema_version !== "lazurio.module.v1"
            ? "marker_schema_mismatch"
            : marker?.id !== moduleSlug
              ? "marker_id_mismatch"
              : marker?.company !== organizationSlug
                ? "marker_company_mismatch"
                : null;
        }
      } catch (error) {
        markerIssue = markerSource !== null
          ? "marker_invalid_json"
          : error?.code === "ENOENT"
            ? "marker_missing"
            : "marker_unreadable";
      }
      if (!markerIssue) {
        verified.push({
          path,
          relative_path: relativePath,
          marker_path: markerPath,
          marker_source: markerSource,
        });
        continue;
      }

      const authoritativeOtherModule = marker?.schema_version === "lazurio.module.v1"
        && marker?.company === organizationSlug
        && typeof marker?.id === "string"
        && marker.id !== moduleSlug;
      if (authoritativeOtherModule) {
        foreignVerified.push({
          path,
          relative_path: relativePath,
          marker_path: markerPath,
          marker_id: marker.id,
          marker_company: marker.company,
        });
        continue;
      }
      const stableSlugDirectory = entry.name === moduleSlug && !authoritativeOtherModule;
      const stableMarkerWithCompanyDrift = marker?.id === moduleSlug
        && marker?.company !== organizationSlug;
      if (!gitMetadata && !gitMetadataIssue) continue;
      unverified.push({
        path,
        relative_path: relativePath,
        marker_path: markerPath,
        reason: gitMetadataIssue ?? markerIssue,
        identity_hint: stableSlugDirectory
          ? "stable_slug"
          : stableMarkerWithCompanyDrift
            ? "marker_id"
            : "unassigned_git_checkout",
        marker_id: typeof marker?.id === "string" ? marker.id : null,
        marker_company: typeof marker?.company === "string" ? marker.company : null,
        git_metadata_kind: !gitMetadata
          ? "unreadable"
          : gitMetadata.isSymbolicLink()
          ? "symlink"
          : gitMetadata.isDirectory()
            ? "directory"
            : gitMetadata.isFile()
              ? "file"
              : "other",
      });
    }
  }
  const byRelativePath = (left, right) => left.relative_path.localeCompare(right.relative_path);
  return {
    verified: verified.sort(byRelativePath),
    unverified: unverified.sort(byRelativePath),
    foreign_verified: foreignVerified.sort(byRelativePath),
    boundary_errors: boundaryErrors,
  };
}

// Jedna dominance klasifikace pro discovery, Git inventory a update safety:
// boundary > ambiguity > unverified > single mismatch > healthy/vacant. Tím
// se v UI nikdy neztratí nebezpečnější stav pod dříve nalezeným repairable
// mismatch a další Sync nemůže zapomenout checkout s rozbitým markerem.
export async function classifyOrganizationModuleCheckoutLocation({
  organizationRoot,
  expectedPath,
  inspection,
  moduleSlug = null,
  declaredModuleClaims = [],
}) {
  if (!inspection || !Array.isArray(inspection.verified) || !Array.isArray(inspection.unverified)) {
    throw new Error("classifyOrganizationModuleCheckoutLocation requires a candidate inspection");
  }
  const boundaryErrors = Array.isArray(inspection.boundary_errors)
    ? inspection.boundary_errors
    : [];
  const verified = inspection.verified;
  const unverified = inspection.unverified;
  const foreignVerified = Array.isArray(inspection.foreign_verified)
    ? inspection.foreign_verified
    : [];
  const exactVerified = verified.find((candidate) => candidate.relative_path === expectedPath) ?? null;
  const allEvidence = [...verified, ...unverified]
    .sort((left, right) => left.relative_path.localeCompare(right.relative_path));
  if (boundaryErrors.length > 0) {
    return locationClassification("boundary_invalid", {
      expectedPath,
      observedPaths: allEvidence.map((candidate) => candidate.relative_path),
      verified,
      unverified,
      boundaryErrors,
      foreignVerified,
    });
  }

  const expectedAbsolutePath = join(organizationRoot, expectedPath);
  const targetStat = await lstat(expectedAbsolutePath).catch(() => null);
  const exactUnverified = unverified.find((candidate) =>
    candidate.relative_path === expectedPath
  ) ?? null;
  const establishedDirectoryTarget = Boolean(
    targetStat
    && targetStat.isDirectory()
    && !targetStat.isSymbolicLink()
    && !exactUnverified,
  );
  const claimMap = declaredModuleClaimMap(declaredModuleClaims);
  const selectedModule = typeof moduleSlug === "string" && moduleSlug !== ""
    ? moduleSlug
    : null;
  const targetClaims = claimMap.get(portablePathIdentity(expectedPath)) ?? null;
  if (selectedModule && targetClaims && !targetClaims.has(selectedModule)) {
    return locationClassification("ambiguous", {
      expectedPath,
      observedPaths: targetStat ? [expectedPath] : [],
      verified,
      unverified,
      boundaryErrors,
      foreignVerified,
      targetOccupied: Boolean(targetStat),
      reason: `target_declaration_collision:${[...targetClaims].sort().join(",")}`,
    });
  }
  const stronglyAttributedForeignClaims = allEvidence.filter((candidate) => {
    if (candidate.identity_hint === "unassigned_git_checkout") return false;
    const claims = claimMap.get(portablePathIdentity(candidate.relative_path));
    return selectedModule && claims && !claims.has(selectedModule);
  });
  if (stronglyAttributedForeignClaims.length > 0) {
    return locationClassification("ambiguous", {
      expectedPath,
      observedPaths: stronglyAttributedForeignClaims
        .map((candidate) => candidate.relative_path)
        .sort(),
      verified,
      unverified,
      boundaryErrors,
      foreignVerified,
      targetOccupied: Boolean(targetStat),
      reason: "sibling_declaration_collision",
    });
  }
  // A marker-authorized checkout at the exact canonical target is safe to
  // update even when an unrelated legacy Git directory elsewhere in the
  // Organization has no marker. The same holds for an established regular
  // legacy target directory: materialization cannot clone over it and its own
  // app/contract checks decide health. Generic suspects still block every
  // actually vacant or relocated target, so a later Sync/restart cannot clone
  // beside data it can no longer assign. A generic checkout at another exact,
  // unambiguous manifest path belongs to that sibling declaration and must not
  // contaminate a vacant slot; an old rename path is no longer assigned and
  // therefore keeps blocking the new target. Strong slug/marker hints remain
  // ambiguous even beside an established target.
  const unverifiedWithoutAssignedSiblings = unverifiedModuleCheckoutCandidates({
    inspection,
    expectedPath,
    moduleSlug: selectedModule,
    declaredModuleClaims,
  });
  const relevantUnverified = exactVerified || establishedDirectoryTarget
    ? unverified.filter((candidate) => candidate.identity_hint !== "unassigned_git_checkout")
    : unverifiedWithoutAssignedSiblings;
  const evidence = [...verified, ...relevantUnverified]
    .sort((left, right) => left.relative_path.localeCompare(right.relative_path));
  const observedPaths = evidence.map((candidate) => candidate.relative_path);

  const foreignTarget = foreignVerified.find((candidate) => candidate.relative_path === expectedPath) ?? null;
  if (foreignTarget) {
    return locationClassification("ambiguous", {
      expectedPath,
      observedPaths: [expectedPath],
      verified,
      unverified,
      boundaryErrors,
      foreignVerified,
      targetOccupied: true,
      reason: `target_identity_collision:${foreignTarget.marker_id}`,
    });
  }

  const unsafeTargetEntry = Boolean(
    targetStat && (!targetStat.isDirectory() || targetStat.isSymbolicLink()),
  );
  if (unsafeTargetEntry) {
    return locationClassification("ambiguous", {
      expectedPath,
      observedPaths: observedPaths.includes(expectedPath)
        ? observedPaths
        : [...observedPaths, expectedPath].sort(),
      verified,
      unverified,
      boundaryErrors,
      foreignVerified,
      targetOccupied: true,
      reason: "target_boundary_collision",
    });
  }
  const targetMatchesEvidence = targetStat
    ? (await Promise.all(evidence.map((candidate) => samePhysicalEntry(expectedAbsolutePath, candidate.path))))
      .some(Boolean)
    : false;
  const targetCollision = Boolean(targetStat && evidence.length > 0 && !targetMatchesEvidence);

  if (evidence.length > 1 || targetCollision) {
    const collisionPaths = targetCollision && !observedPaths.includes(expectedPath)
      ? [...observedPaths, expectedPath].sort()
      : observedPaths;
    return locationClassification("ambiguous", {
      expectedPath,
      observedPaths: collisionPaths,
      verified,
      unverified,
      boundaryErrors,
      foreignVerified,
      targetOccupied: Boolean(targetStat),
    });
  }
  if (relevantUnverified.length === 1) {
    return locationClassification("unverified", {
      expectedPath,
      observedPaths,
      verified,
      unverified,
      boundaryErrors,
      foreignVerified,
      targetOccupied: Boolean(targetStat),
      reason: relevantUnverified[0].reason,
    });
  }
  if (verified.length === 1) {
    return locationClassification(exactVerified ? "healthy" : "mismatch", {
      expectedPath,
      observedPaths,
      verified,
      unverified,
      boundaryErrors,
      foreignVerified,
      targetOccupied: Boolean(targetStat),
    });
  }
  // Bez markerové ani Git evidence neurčujeme identitu pouhým názvem
  // adresáře. Existující canonical target navíc nemůže být omylem klonován;
  // jeho Git stav ověří následný repo gate. Symlink/boundary stav zachytí
  // Organization path kontrola ještě před touto klasifikací.
  return locationClassification("vacant", {
    expectedPath,
    observedPaths,
    verified,
    unverified,
    boundaryErrors,
    foreignVerified,
    targetOccupied: Boolean(targetStat),
  });
}

// A markerless Git checkout at another exact manifest path is evidence for
// that declared sibling, not for the selected Module. Unknown paths and all
// stable slug/marker hints remain relevant so Sync and repair stay no-clone.
export function unverifiedModuleCheckoutCandidates({
  inspection,
  expectedPath,
  moduleSlug = null,
  declaredModuleClaims = [],
}) {
  const unverified = Array.isArray(inspection?.unverified) ? inspection.unverified : [];
  const claimMap = declaredModuleClaimMap(declaredModuleClaims);
  return unverified.filter((candidate) =>
    candidate.identity_hint !== "unassigned_git_checkout"
    || candidate.relative_path === expectedPath
    || !claimMap.has(portablePathIdentity(candidate.relative_path))
    || claimMap.get(portablePathIdentity(candidate.relative_path)).has(moduleSlug)
  );
}

function declaredModuleClaimMap(claims) {
  const map = new Map();
  for (const claim of Array.isArray(claims) ? claims : []) {
    if (
      typeof claim?.path !== "string"
      || claim.path === ""
      || typeof claim?.module !== "string"
      || claim.module === ""
    ) continue;
    const pathIdentity = portablePathIdentity(claim.path);
    if (!map.has(pathIdentity)) map.set(pathIdentity, new Set());
    map.get(pathIdentity).add(claim.module);
  }
  return map;
}

function portablePathIdentity(path) {
  return String(path).toLowerCase();
}

function locationClassification(status, {
  expectedPath,
  observedPaths,
  verified,
  unverified,
  boundaryErrors,
  foreignVerified = [],
  targetOccupied = false,
  reason = null,
}) {
  return {
    status,
    expected_path: expectedPath,
    found_path: observedPaths[0] ?? null,
    observed_paths: observedPaths,
    target_occupied: targetOccupied,
    reason,
    verified,
    unverified,
    foreign_verified: foreignVerified,
    boundary_errors: boundaryErrors,
  };
}

async function samePhysicalEntry(left, right) {
  try {
    const [realLeft, realRight] = await Promise.all([realpath(left), realpath(right)]);
    return relative(realLeft, realRight) === "";
  } catch {
    return false;
  }
}
