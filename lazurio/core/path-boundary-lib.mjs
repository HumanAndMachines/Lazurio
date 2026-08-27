import { lstat, open, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

// Lexikální prefix nestačí pro kanonické (realpath) boundary kontroly a na
// Windows selhává i prosté porovnání řetězců kvůli case-insensitive cestám.
// `relative` používá platformní path semantics, odmítne jiný drive/UNC root a
// funguje shodně pro POSIX symlinky i Windows junctiony po jejich rozbalení.
export function isPathDescendant(parent, candidate) {
  const relativePath = relative(resolve(parent), resolve(candidate));
  return (
    relativePath !== ""
    && relativePath !== ".."
    && !relativePath.startsWith(`..${sep}`)
    && !isAbsolute(relativePath)
  );
}

export function isPathSameOrDescendant(parent, candidate) {
  return (
    isSamePath(parent, candidate)
    || isPathDescendant(parent, candidate)
  );
}

export function isSamePath(left, right) {
  return relative(resolve(left), resolve(right)) === "";
}

// Ověří lexical i kanonickou hranici. Pro budoucí write target lze povolit
// neexistující leaf: pak se rozbalí nejbližší existující parent, takže
// symlink/junction v kterémkoli mezikroku nemůže odvést mkdir/write mimo root.
// `lstat` záměrně rozpozná i rozbitý symlink; takový target nesmí projít jako
// obyčejná neexistující cesta, protože následný write by odkaz mohl následovat.
export async function inspectCanonicalPathBoundary({
  rootPath,
  rootRealPath = null,
  targetPath,
  allowMissingTarget = false,
  allowTargetEqual = false,
}) {
  const absoluteRoot = resolve(rootPath);
  const absoluteTarget = resolve(targetPath);
  const lexicalInside = allowTargetEqual
    ? isPathSameOrDescendant(absoluteRoot, absoluteTarget)
    : isPathDescendant(absoluteRoot, absoluteTarget);
  if (!lexicalInside) {
    return {
      ok: false,
      rootRealPath,
      targetRealPath: null,
      checkedPath: null,
    };
  }

  try {
    const resolvedRoot = rootRealPath ?? await realpath(absoluteRoot);
    const targetStat = await lstatOrNull(absoluteTarget);
    if (targetStat) {
      const targetRealPath = await realpath(absoluteTarget);
      const canonicalInside = allowTargetEqual
        ? isPathSameOrDescendant(resolvedRoot, targetRealPath)
        : isPathDescendant(resolvedRoot, targetRealPath);
      return {
        ok: canonicalInside,
        rootRealPath: resolvedRoot,
        targetRealPath,
        checkedPath: absoluteTarget,
      };
    }
    if (!allowMissingTarget) {
      return {
        ok: false,
        rootRealPath: resolvedRoot,
        targetRealPath: null,
        checkedPath: null,
      };
    }

    const existingParent = await nearestExistingParent(absoluteTarget);
    if (!existingParent) {
      return {
        ok: false,
        rootRealPath: resolvedRoot,
        targetRealPath: null,
        checkedPath: null,
      };
    }
    const parentRealPath = await realpath(existingParent);
    return {
      ok: isPathSameOrDescendant(resolvedRoot, parentRealPath),
      rootRealPath: resolvedRoot,
      targetRealPath: null,
      checkedPath: existingParent,
    };
  } catch {
    return {
      ok: false,
      rootRealPath,
      targetRealPath: null,
      checkedPath: null,
    };
  }
}

// Read authority-bearing JSON only after both its lexical path and its
// canonical target have been proven to remain inside the selected owner. The
// returned canonical paths let callers keep deriving subsequent reads from the
// same verified boundary instead of silently re-authorizing a replaced
// symlink/junction through a new lexical root.
export async function readJsonWithinCanonicalBoundary({
  rootPath,
  rootRealPath = null,
  targetPath,
  label = "JSON soubor",
}) {
  const file = await readFileWithinCanonicalBoundary({
    rootPath,
    rootRealPath,
    targetPath,
    label,
    encoding: "utf8",
  });
  return {
    ...file,
    value: JSON.parse(file.value),
  };
}

export async function readFileWithinCanonicalBoundary({
  rootPath,
  rootRealPath = null,
  targetPath,
  label = "soubor",
  encoding = null,
}) {
  // This lstat is only error classification, never authorization. It preserves
  // ENOENT/EACCES/EIO for callers while every trusted path decision below is
  // still canonical and repeated after opening the file.
  await lstat(targetPath);
  const boundary = await inspectCanonicalPathBoundary({
    rootPath,
    rootRealPath,
    targetPath,
  });
  if (!boundary.ok || !boundary.targetRealPath) {
    throw canonicalReadError(`${label} odkazuje mimo vybraný checkout.`, "LAZURIO_PATH_BOUNDARY_INVALID");
  }
  const handle = await open(boundary.targetRealPath, "r");
  try {
    const openedEntry = await handle.stat();
    if (!openedEntry.isFile()) {
      throw canonicalReadError(`${label} není běžný soubor.`, "LAZURIO_PATH_ENTRY_TYPE_INVALID");
    }

    // Čti ze stejného file descriptoru, který jsme ověřili. Druhá boundary a
    // inode kontrola zavře výměnu leafu nebo parent symlinku mezi realpath a
    // open; následná výměna cesty už otevřený descriptor nepřesměruje.
    const rechecked = await inspectCanonicalPathBoundary({
      rootPath,
      rootRealPath: boundary.rootRealPath,
      targetPath,
    });
    if (
      !rechecked.ok
      || !rechecked.targetRealPath
      || !isSamePath(boundary.targetRealPath, rechecked.targetRealPath)
    ) {
      throw canonicalReadError(
        `${label} změnil canonical cíl během bezpečného čtení.`,
        "LAZURIO_PATH_AUTHORITY_CHANGED",
      );
    }
    const currentEntry = await stat(rechecked.targetRealPath);
    if (openedEntry.dev !== currentEntry.dev || openedEntry.ino !== currentEntry.ino) {
      throw canonicalReadError(`${label} byl vyměněn během bezpečného čtení.`, "LAZURIO_PATH_AUTHORITY_CHANGED");
    }
    return {
      value: encoding
        ? await handle.readFile({ encoding })
        : await handle.readFile(),
      rootRealPath: boundary.rootRealPath,
      targetRealPath: boundary.targetRealPath,
    };
  } finally {
    await handle.close();
  }
}

function canonicalReadError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

// Directory consumers cannot pin subsequent traversal to one file descriptor
// portably, so they prove a stable canonical target twice and compare the
// directory identity across the check/use window. `beforeIdentityRecheck` is
// a deterministic race-injection seam for boundary tests; production callers
// leave it unset.
export async function inspectDirectoryWithinCanonicalBoundary({
  rootPath,
  rootRealPath = null,
  targetPath,
  allowTargetEqual = false,
  beforeIdentityRecheck = null,
}) {
  const boundary = await inspectCanonicalPathBoundary({
    rootPath,
    rootRealPath,
    targetPath,
    allowTargetEqual,
  });
  if (!boundary.ok || !boundary.targetRealPath) return boundary;
  try {
    const initialEntry = await stat(boundary.targetRealPath);
    if (!initialEntry.isDirectory()) return { ...boundary, ok: false };
    if (beforeIdentityRecheck) await beforeIdentityRecheck();
    const rechecked = await inspectCanonicalPathBoundary({
      rootPath,
      rootRealPath: boundary.rootRealPath,
      targetPath,
      allowTargetEqual,
    });
    if (
      !rechecked.ok
      || !rechecked.targetRealPath
      || !isSamePath(boundary.targetRealPath, rechecked.targetRealPath)
    ) {
      return { ...rechecked, ok: false };
    }
    const currentEntry = await stat(rechecked.targetRealPath);
    if (
      !currentEntry.isDirectory()
      || initialEntry.dev !== currentEntry.dev
      || initialEntry.ino !== currentEntry.ino
    ) {
      return { ...rechecked, ok: false };
    }
    return rechecked;
  } catch {
    return {
      ok: false,
      rootRealPath: boundary.rootRealPath,
      targetRealPath: null,
      checkedPath: null,
    };
  }
}

async function nearestExistingParent(path) {
  let candidate = dirname(path);
  while (true) {
    if (await lstatOrNull(candidate)) return candidate;
    const parent = dirname(candidate);
    if (parent === candidate) return null;
    candidate = parent;
  }
}

async function lstatOrNull(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}
