import { organizationRootRepositoryNames } from "./organization-root-repository-lib.mjs";

export const ORGANIZATION_FORGE_BINDING_VERSION = "lazurio.forge-binding.github.v0";

export const ORGANIZATION_POSITIVE_GITHUB_ID_PATTERN = /^[1-9][0-9]{0,19}$/u;
export const ORGANIZATION_GITHUB_LOGIN_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/u;

/**
 * Immutable GitHub Organization/repository binding recorded in an Organization
 * root. This module depends only on the leaf root-name module, so the
 * scaffold generator and the manifest resolver can both consume it without an
 * import cycle. The repository is `<login>/<login>_GEN3` or
 * `<login>/<login>_GEN4` (LZD-0041 G1); which one is the root is the binding's
 * own declaration, matched against the live repository by its callers.
 */
export function isValidOrganizationForgeBinding(value, {
  organizationId,
  organizationLogin,
  repositoryId,
  repositoryFullName,
} = {}) {
  if (!isValidForgeBindingShape(value)) return false;
  if (organizationId !== undefined && String(organizationId) !== value.organization.id) return false;
  if (organizationLogin !== undefined && String(organizationLogin).toLowerCase() !== value.organization.asserted_login.toLowerCase()) return false;
  if (repositoryId !== undefined && String(repositoryId) !== value.repository.id) return false;
  if (repositoryFullName !== undefined && String(repositoryFullName).toLowerCase() !== value.repository.asserted_full_name.toLowerCase()) return false;
  return true;
}

export function isValidForgeBindingShape(value) {
  return isRecord(value)
    && value.schema_version === ORGANIZATION_FORGE_BINDING_VERSION
    && value.provider === "github"
    && isRecord(value.organization)
    && typeof value.organization.id === "string"
    && ORGANIZATION_POSITIVE_GITHUB_ID_PATTERN.test(value.organization.id ?? "")
    && typeof value.organization.asserted_login === "string"
    && ORGANIZATION_GITHUB_LOGIN_PATTERN.test(value.organization.asserted_login ?? "")
    && isRecord(value.repository)
    && typeof value.repository.id === "string"
    && ORGANIZATION_POSITIVE_GITHUB_ID_PATTERN.test(value.repository.id ?? "")
    && typeof value.repository.asserted_full_name === "string"
    && organizationRootRepositoryNames(value.organization.asserted_login)
      .some((name) => value.repository.asserted_full_name.toLowerCase() === `${value.organization.asserted_login}/${name}`.toLowerCase())
    && value.repository.default_branch === "main";
}

function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
