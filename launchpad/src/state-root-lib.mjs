import { existsSync, mkdirSync, realpathSync } from "fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "path";

export function resolveLaunchpadStateRoot({
  configuredStateRoot,
  hosted,
  runtimeRoot,
  workspaceRoot,
  fallbackRoot,
}) {
  if (configuredStateRoot === undefined || configuredStateRoot === "") {
    if (hosted) {
      throw new Error("LAZURIO_LAUNCHPAD_STATE_ROOT is required for the hosted Workspace profile.");
    }
    return fallbackRoot;
  }
  if (!isAbsolute(configuredStateRoot)) {
    throw new Error("LAZURIO_LAUNCHPAD_STATE_ROOT must be an absolute path.");
  }

  const protectedRoots = [runtimeRoot, workspaceRoot].map(canonicalizePotentialPath);
  const candidate = canonicalizePotentialPath(configuredStateRoot);
  rejectProtectedOverlap({ candidate, protectedRoots });

  // Runtime writes need the directory anyway. Creating it only after the
  // nearest-existing-ancestor check lets us resolve symlink aliases without
  // first writing through one into the immutable runtime or mutable checkout.
  mkdirSync(candidate, { recursive: true, mode: 0o700 });
  const canonicalStateRoot = realpathSync(candidate);
  rejectProtectedOverlap({ candidate: canonicalStateRoot, protectedRoots });
  return canonicalStateRoot;
}

function canonicalizePotentialPath(path) {
  let existingAncestor = resolve(path);
  const suffix = [];
  while (!existsSync(existingAncestor)) {
    const parent = dirname(existingAncestor);
    if (parent === existingAncestor) break;
    suffix.unshift(basename(existingAncestor));
    existingAncestor = parent;
  }
  const canonicalAncestor = realpathSync(existingAncestor);
  return resolve(canonicalAncestor, ...suffix);
}

function rejectProtectedOverlap({ candidate, protectedRoots }) {
  if (protectedRoots.some((protectedRoot) => pathsOverlap(protectedRoot, candidate))) {
    throw new Error("LAZURIO_LAUNCHPAD_STATE_ROOT must not overlap the immutable runtime or mutable Workspace root.");
  }
}

function pathsOverlap(left, right) {
  return pathContains(left, right) || pathContains(right, left);
}

function pathContains(parent, candidate) {
  const relativePath = relative(resolve(parent), resolve(candidate));
  return relativePath === ""
    || (relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath));
}
