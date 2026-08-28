import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";

import { resolveOrganizationRootDocuments } from "./organization-activation-lib.mjs";

export const ORGANIZATION_DOCUMENT_PATHS = Object.freeze({
  canonical: "lazurio.organization.json",
  legacy_projection: "company.gen3.json",
  modules: "modules.manifest.json",
});

export function normalizeOrganizationDocumentJson(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value
    : { invalid: true };
}

/**
 * The only local-filesystem adapter for Organization root documents. It owns
 * filenames and JSON decoding, then delegates every state/resource decision
 * to resolveOrganizationRootDocuments.
 */
export function readOrganizationRoot({ organizationRoot, ...expectations }) {
  const boundaryIssue = organizationRootBoundaryIssue(organizationRoot);
  if (boundaryIssue) {
    return resolveOrganizationRootDocuments({
      ...expectations,
      canonicalManifest: null,
      companyManifest: null,
      modulesManifest: null,
      documentIssues: [boundaryIssue],
    });
  }
  const issues = [];
  const canonicalManifest = readOptionalJson({
    organizationRoot,
    relativePath: ORGANIZATION_DOCUMENT_PATHS.canonical,
    issueCode: "canonical_manifest_unreadable",
    issues,
  });
  const companyManifest = readOptionalJson({
    organizationRoot,
    relativePath: ORGANIZATION_DOCUMENT_PATHS.legacy_projection,
    issueCode: "legacy_projection_unreadable",
    issues,
  });
  const modulesManifest = readOptionalJson({
    organizationRoot,
    relativePath: ORGANIZATION_DOCUMENT_PATHS.modules,
    issueCode: "modules_manifest_unreadable",
    issues,
  });

  return resolveOrganizationRootDocuments({
    ...expectations,
    canonicalManifest,
    companyManifest,
    modulesManifest,
    documentIssues: issues,
  });
}

function readOptionalJson({ organizationRoot, relativePath, issueCode, issues }) {
  const path = join(organizationRoot, relativePath);
  try {
    const entry = lstatSync(path);
    if (!entry.isFile() || entry.isSymbolicLink()) throw new Error("not a regular file");
    return normalizeOrganizationDocumentJson(JSON.parse(readRegularFileNoFollow(path, entry)));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    issues.push(issueCode);
    return { invalid: true };
  }
}

function organizationRootBoundaryIssue(organizationRoot) {
  try {
    const entry = lstatSync(organizationRoot);
    return entry.isDirectory() && !entry.isSymbolicLink()
      ? null
      : "organization_root_boundary_invalid";
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    return "organization_root_unreadable";
  }
}

function readRegularFileNoFollow(path, expectedEntry) {
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  const descriptor = openSync(path, constants.O_RDONLY | noFollow);
  try {
    const openedEntry = fstatSync(descriptor);
    if (!openedEntry.isFile() || !sameFilesystemEntry(expectedEntry, openedEntry)) {
      throw new Error("file changed while opening");
    }
    return readFileSync(descriptor, "utf8");
  } finally {
    closeSync(descriptor);
  }
}

function sameFilesystemEntry(expected, opened) {
  // POSIX dev+ino binds the bytes to the lstat boundary check. Some Windows
  // filesystems report ino=0, where O_NOFOLLOW (when present) plus file type
  // remains the strongest portable guarantee available to this adapter.
  if (expected.ino !== 0 && opened.ino !== 0) {
    return expected.dev === opened.dev && expected.ino === opened.ino;
  }
  return expected.isFile() && opened.isFile();
}
