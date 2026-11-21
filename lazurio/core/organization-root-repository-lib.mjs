// Organization root repository names and selection (LZD-0041 phase G1).
//
// An Organization's root repository is `<login>_GEN4` or `<login>_GEN3`. The
// suffix only names the candidates; which repository is the root is decided by
// its own declaration, never by the suffix: the canonical manifest names the
// repository in `root_repository.locator` and the Organization login in
// `organization.forge_binding.locator` (a legacy-only root declares the same in
// its company.gen3.json). The local folder name is a separate fact: an
// Environment may keep `organizations/<login>_GEN3` with an origin switched to
// `<login>_GEN4`, or use `organizations/<login>_GEN4` (proposal N2, not
// decided yet), so callers never derive one from the other.
//
// This is a leaf module without Core dependencies so the forge binding,
// scaffold, activation, install and the Launchpad can all consume it.

export const ORGANIZATION_ROOT_REPOSITORY_GENERATIONS = Object.freeze(["GEN4", "GEN3"]);

// Generation the scaffold creates new roots in. It switches to GEN4 only after
// the founding gate of plan LZD-0041 (decision N4); until then new roots keep
// the GEN3 name every deployed reader understands.
export const ORGANIZATION_ROOT_SCAFFOLD_GENERATION = "GEN3";

const suffixPattern = /_(GEN[34])$/u;
const loginPattern = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/u;

/** `<login>_<generation>`; throws on an unknown generation or invalid login. */
export function organizationRootRepositoryName(login, generation) {
  if (!ORGANIZATION_ROOT_REPOSITORY_GENERATIONS.includes(generation)) {
    throw new TypeError(`Unknown Organization root generation '${generation}'.`);
  }
  if (typeof login !== "string" || !loginPattern.test(login)) {
    throw new TypeError("Organization root repository name requires a valid GitHub login.");
  }
  return `${login}_${generation}`;
}

/** Candidate root repository names in preference order (GEN4 first). */
export function organizationRootRepositoryNames(login) {
  return ORGANIZATION_ROOT_REPOSITORY_GENERATIONS.map((generation) => organizationRootRepositoryName(login, generation));
}

/**
 * `{ login, generation }` of a root repository or folder name such as
 * `Example_GEN4`, or null for any other name. The login part keeps its case.
 */
export function parseOrganizationRootRepositoryName(name) {
  if (typeof name !== "string") return null;
  const match = name.match(suffixPattern);
  if (!match) return null;
  const login = name.slice(0, -match[0].length);
  if (!loginPattern.test(login)) return null;
  return { login, generation: match[1] };
}

/** True when `name` is `<login>_GEN3` or `<login>_GEN4` (case-insensitive login). */
export function isOrganizationRootRepositoryName(name, login = undefined) {
  const parsed = parseOrganizationRootRepositoryName(name);
  if (!parsed) return false;
  return login === undefined || parsed.login.toLowerCase() === String(login).toLowerCase();
}

/**
 * The folder or repository name without its generation suffix; any other
 * name is returned unchanged. Folder-name fallbacks (slug of an unreadable
 * root) use it so `X_GEN3` and `X_GEN4` fall back to the same `X`.
 */
export function stripOrganizationRootGeneration(name) {
  const parsed = parseOrganizationRootRepositoryName(name);
  return parsed ? parsed.login : name;
}

/**
 * True when a local root folder may carry the given root repository: the same
 * name, or the same login with the other generation suffix (an Environment
 * that keeps `organizations/X_GEN3` and switches only its origin to `X_GEN4`,
 * or the way back). The comparison of the full names follows `sameName`, so
 * callers keep their platform's case rule.
 */
export function organizationRootFolderMatchesRepository(folderName, repositoryName, {
  sameName = (left, right) => left === right,
} = {}) {
  if (typeof folderName !== "string" || typeof repositoryName !== "string") return false;
  if (sameName(folderName, repositoryName)) return true;
  const folder = parseOrganizationRootRepositoryName(folderName);
  const repository = parseOrganizationRootRepositoryName(repositoryName);
  if (!folder || !repository) return false;
  return sameName(folder.login, repository.login);
}

/**
 * The root locator a root repository's own documents declare, or null when
 * they declare none (a local-first legacy root) or cannot be read as records.
 * The canonical manifest is the authority whenever it is present.
 */
export function declaredOrganizationRootLocator({ canonicalManifest = null, companyManifest = null } = {}) {
  if (isRecord(canonicalManifest)) {
    const login = text(canonicalManifest.organization?.forge_binding?.locator);
    const locator = text(canonicalManifest.root_repository?.locator);
    return login && locator ? { login, locator } : null;
  }
  if (isRecord(companyManifest)) {
    const company = companyManifest.company;
    const login = text(companyManifest.forge_binding?.organization?.asserted_login) || text(company?.github_org);
    const locator = text(companyManifest.forge_binding?.repository?.asserted_full_name)
      || text(company?.root_repository);
    return login && locator ? { login, locator } : null;
  }
  return null;
}

/**
 * True when the documents read from `fullName` declare exactly that repository
 * as the root of the Organization `login`.
 */
export function organizationRootDeclaresItself({ fullName, login, canonicalManifest = null, companyManifest = null }) {
  const declared = declaredOrganizationRootLocator({ canonicalManifest, companyManifest });
  return Boolean(
    declared
    && sameText(declared.login, login)
    && sameText(declared.locator, fullName),
  );
}

/**
 * Picks the root among the observed candidates of one Organization. Each
 * candidate is `{ generation, presence, declares }` with presence `absent`,
 * `empty` or `present` and `declares` true when its own documents name it as
 * the root (organizationRootDeclaresItself).
 *
 * - No candidate exists: `{ status: "absent" }`.
 * - Exactly one exists: that one, as today with a GEN3-only Organization.
 * - Both exist: the one that declares itself; when both do, GEN4. When none
 *   does but exactly one has content, the one with content (a freshly created
 *   empty GEN4 never displaces a working GEN3). Otherwise the choice is not
 *   safe and the result is `{ status: "conflict" }`, which callers fail closed
 *   on.
 */
export function selectOrganizationRootRepository(candidates) {
  const existing = (Array.isArray(candidates) ? candidates : [])
    .filter((candidate) => candidate && candidate.presence !== "absent");
  if (existing.length === 0) return { status: "absent", candidate: null, reason: "root_repository_absent" };
  if (existing.length === 1) return { status: "selected", candidate: existing[0], reason: "single_candidate" };
  const byPreference = (list) => ORGANIZATION_ROOT_REPOSITORY_GENERATIONS
    .map((generation) => list.find((candidate) => candidate.generation === generation))
    .filter(Boolean);
  const declaring = byPreference(existing.filter((candidate) => candidate.presence === "present" && candidate.declares === true));
  if (declaring.length > 0) {
    return {
      status: "selected",
      candidate: declaring[0],
      reason: declaring.length > 1 ? "both_declare_gen4_preferred" : "declared_root",
    };
  }
  const withContent = existing.filter((candidate) => candidate.presence === "present");
  if (withContent.length === 1) return { status: "selected", candidate: withContent[0], reason: "single_candidate_with_content" };
  return { status: "conflict", candidate: null, reason: "canonical_root_candidate_conflict" };
}

function sameText(left, right) {
  return text(left).toLowerCase() === text(right).toLowerCase() && text(left) !== "";
}

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
