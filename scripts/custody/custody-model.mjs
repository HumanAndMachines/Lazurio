// Where local secret custody lives (manual/security/local-secret-custody.md).
// One definition shared by the custody helper (custody-shape.mjs) and the
// agent print guard (custody-guard.mjs):
//
// - ~/.config/lazurio/credentials/** and ~/.config/lazurio/custody/**:
//   machine-wide operator custody (credential maps and what they point to);
// - **/private/secrets/**: Organization and colleague custody;
// - **/personalspace/<owner>/secrets/**: the owner's custody.
//
// Public key material inside custody (*.pub, known_hosts files) is not a
// secret and may be read. The model never reads a file; it only compares
// paths and, for symlinks and directory probes, asks the filesystem whether a
// path exists or where it points.
import { existsSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export const MACHINE_CUSTODY_DIRS = Object.freeze([
  join(".config", "lazurio", "credentials"),
  join(".config", "lazurio", "custody"),
]);

const PUBLIC_MATERIAL = /(\.pub$|known[-_]?hosts)/iu;

export function createCustodyModel({
  home = homedir(),
  lazurioRoot = resolve(import.meta.dir, "..", ".."),
  caseInsensitive = process.platform === "darwin" || process.platform === "win32",
  pathExists = existsSync,
  realPath = realpathSync,
  listDirectory = (path) => readdirSync(path),
  expandGlob = null,
} = {}) {
  const fold = (path) => (caseInsensitive ? path.toLowerCase() : path);
  const machineRoots = MACHINE_CUSTODY_DIRS.map((dir) => resolve(home, dir));
  let repositoryCustodyCache = null;

  function isWithin(root, path) {
    const a = fold(root);
    const b = fold(path);
    return b === a || b.startsWith(a.endsWith(sep) ? a : a + sep);
  }

  // The custody root that lexically contains `path`, or null.
  function lexicalRoot(path) {
    for (const root of machineRoots) if (isWithin(root, path)) return root;
    const parts = path.split(sep);
    const folded = parts.map(fold);
    for (let index = 1; index < parts.length; index += 1) {
      if (folded[index - 1] === "private" && folded[index] === "secrets") {
        return parts.slice(0, index + 1).join(sep) || sep;
      }
      if (index >= 2 && folded[index - 2] === "personalspace" && folded[index] === "secrets") {
        return parts.slice(0, index + 1).join(sep) || sep;
      }
    }
    return null;
  }

  function existingRealPath(path) {
    // Resolve symlinks of the longest existing prefix; the rest stays lexical.
    let probe = path;
    const tail = [];
    for (let guard = 0; guard < 64; guard += 1) {
      try {
        if (pathExists(probe)) return tail.length === 0 ? realPath(probe) : join(realPath(probe), ...tail);
      } catch {
        return path;
      }
      const parent = dirname(probe);
      if (parent === probe) return path;
      tail.unshift(basename(probe));
      probe = parent;
    }
    return path;
  }

  // Absolute path of the custody root holding `path`, or null. `path` must be
  // absolute. Public key material is never custody.
  function custodyRootOf(path) {
    if (!isAbsolute(path)) return null;
    const normalized = resolve(path);
    if (PUBLIC_MATERIAL.test(basename(normalized))) return null;
    const lexical = lexicalRoot(normalized);
    if (lexical) return lexical;
    const real = existingRealPath(normalized);
    return real === normalized ? null : lexicalRoot(real);
  }

  function isCustodyPath(path) {
    return custodyRootOf(path) !== null;
  }

  // Repository-embedded custody directories under the Lazurio root (the
  // documented layouts), discovered once per process.
  function repositoryCustodyDirs() {
    if (repositoryCustodyCache) return repositoryCustodyCache;
    const found = [];
    const list = (path) => {
      try {
        return listDirectory(path);
      } catch {
        return [];
      }
    };
    const consider = (path) => {
      try {
        if (pathExists(path)) found.push(path);
      } catch {
        // An unreadable candidate is simply not found.
      }
    };
    const organizations = join(lazurioRoot, "organizations");
    for (const organization of list(organizations)) {
      const root = join(organizations, organization);
      consider(join(root, "private", "secrets"));
      consider(join(root, "infra", "private", "secrets"));
      const colleagues = join(root, "company", "colleagues");
      for (const colleague of list(colleagues)) consider(join(colleagues, colleague, "private", "secrets"));
    }
    const personalspace = join(lazurioRoot, "personalspace");
    for (const owner of list(personalspace)) consider(join(personalspace, owner, "secrets"));
    repositoryCustodyCache = found;
    return found;
  }

  // Whether a recursive search of `directory` can reach custody content.
  // `skipsHidden`: the tool skips dot directories unless told otherwise (rg).
  // `respectsGitignore`: the tool skips ignored paths; repository-embedded
  // custody is always Git-ignored, so only machine custody remains reachable.
  function directoryReachesCustody(directory, { skipsHidden = false, respectsGitignore = false } = {}) {
    if (!isAbsolute(directory)) return false;
    const dir = resolve(directory);
    if (isCustodyPath(dir)) return true;
    const reachable = (target) => {
      if (!isWithin(dir, target)) return false;
      if (!skipsHidden) return true;
      return !relative(dir, target).split(sep).some((part) => part.startsWith("."));
    };
    if (machineRoots.some(reachable)) return true;
    const exists = (path) => {
      try {
        return pathExists(path);
      } catch {
        return false;
      }
    };
    // A search started at an ignored `private/` directory still descends into
    // its `secrets/`; ignore rules protect custody only from a parent.
    if (fold(basename(dir)) === "private" && exists(join(dir, "secrets"))) return true;
    if (respectsGitignore) return false;
    if (exists(join(dir, "private", "secrets"))) return true;
    if (fold(basename(dirname(dir))) === "personalspace" && exists(join(dir, "secrets"))) return true;
    return repositoryCustodyDirs().some(reachable);
  }

  function exists(path) {
    try {
      return pathExists(path);
    } catch {
      return false;
    }
  }

  // What a shell glob expands to right now (absolute paths), or null when it
  // cannot be told cheaply (recursive `**`, too many matches, no Bun.Glob).
  function expand(base, pattern) {
    if (expandGlob) return expandGlob(base, pattern);
    const wild = pattern.split("/").filter((segment) => /[*?[]/u.test(segment)).length;
    if (pattern.includes("**") || wild > 2 || typeof globalThis.Bun?.Glob !== "function") return null;
    try {
      const matches = [];
      const options = { cwd: base, onlyFiles: false, absolute: true, dot: false, followSymlinks: false };
      for (const match of new globalThis.Bun.Glob(pattern).scanSync(options)) {
        matches.push(match);
        if (matches.length > 256) return null;
      }
      return matches;
    } catch {
      return null;
    }
  }

  return Object.freeze({
    home,
    lazurioRoot,
    machineRoots,
    custodyRootOf,
    isCustodyPath,
    directoryReachesCustody,
    exists,
    expand,
    fold,
  });
}

// Text that names a custody location: used for code strings (python -c,
// node -e, heredoc scripts) where paths may be assembled from parts.
const SEP = String.raw`[\s"'\x60/,+(){}\[\]]*`;
const CUSTODY_TEXT = new RegExp(
  [
    String.raw`\.config${SEP}lazurio${SEP}(?:credentials|custody)\b`,
    String.raw`\bprivate${SEP}secrets\b`,
    String.raw`\bpersonalspace${SEP}[^\s"'\x60/,]+${SEP}secrets\b`,
  ].join("|"),
  "iu",
);

export function textNamesCustody(text) {
  return typeof text === "string" && CUSTODY_TEXT.test(text);
}
