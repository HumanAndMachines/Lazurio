import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep, win32 } from "node:path";

export const LAZURIO_SERVER_IDENTITY_SCHEMA = "lazurio.server.identity.v1";
export const LAZURIO_SERVER_PRODUCT = "lazurio-launchpad-server";
export const LEGACY_LAUNCHPAD_IDENTITY_SCHEMA = "companiesascode.launchpad.identity.v1";

const sha256Pattern = /^[a-f0-9]{64}$/;
const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const generationDirectories = ["launchpad/src", "lazurio/core"];
const generationTreeDirectories = ["launchpad/public"];
const generationFiles = [
  "launchpad/package.json",
  "scripts/worktree-create-lib.mjs",
  "scripts/worktree-create-lock.mjs",
];

export function resolveCanonicalServerRoot(selectedRoot) {
  if (typeof selectedRoot !== "string" || selectedRoot === "") {
    throw new TypeError("Server root resolution requires a selected root path.");
  }
  const root = realpathSync.native(resolve(selectedRoot));
  const markerPath = join(root, ".git");
  if (!existsSync(markerPath)) return root;

  const marker = lstatSync(markerPath);
  if (marker.isSymbolicLink()) {
    throw new Error("Lazurio Root Git marker must not be a symlink.");
  }
  if (marker.isDirectory()) return root;
  if (!marker.isFile()) throw new Error("Lazurio Root Git marker has an unsupported type.");

  const gitDirectory = parseGitDirectoryPointer(readFileSync(markerPath, "utf8"), root);
  const commonDirectoryPointer = join(gitDirectory, "commondir");
  // A primary checkout with a separate Git directory also uses a .git file,
  // but has no worktree commondir marker and is already the canonical Root.
  if (!existsSync(commonDirectoryPointer)) return root;

  const commonDirectory = realpathSync.native(resolveGitPointer(
    gitDirectory,
    readSingleGitPath(commonDirectoryPointer, "worktree commondir"),
  ));
  const directPrimaryRoot = resolvePrimaryRootBesideCommonDirectory(commonDirectory);
  if (directPrimaryRoot) return directPrimaryRoot;
  const primaryRoot = resolveNestedPrimaryRoot({ linkedRoot: root, commonDirectory });
  if (primaryRoot) return primaryRoot;
  throw new Error(
    "Linked Lazurio worktree canonical main Root cannot be verified inside its Lazurio worktree hierarchy.",
  );
}

function resolvePrimaryRootBesideCommonDirectory(commonDirectory) {
  if (basename(commonDirectory) !== ".git") return null;
  const primaryRoot = realpathSync.native(dirname(commonDirectory));
  const markerPath = join(primaryRoot, ".git");
  if (!existsSync(markerPath)) return null;
  const marker = lstatSync(markerPath);
  return marker.isDirectory()
    && !marker.isSymbolicLink()
    && realpathSync.native(markerPath) === commonDirectory
    ? primaryRoot
    : null;
}

function resolveNestedPrimaryRoot({ linkedRoot, commonDirectory }) {
  // Lazurio worktrees are nested under their owning checkout. This lets us
  // verify the owner without asking Git to invent a filesystem Root: walk only
  // ancestors and accept the first .git marker that resolves to the exact same
  // common directory. It works for both an in-tree .git directory and a
  // supported --separate-git-dir primary checkout.
  let candidate = dirname(linkedRoot);
  while (candidate !== dirname(candidate)) {
    const markerPath = join(candidate, ".git");
    if (existsSync(markerPath)) {
      try {
        const marker = lstatSync(markerPath);
        const candidateGitDirectory = marker.isDirectory()
          ? realpathSync.native(markerPath)
          : marker.isFile() && !marker.isSymbolicLink()
            ? parseGitDirectoryPointer(readFileSync(markerPath, "utf8"), candidate)
            : null;
        if (candidateGitDirectory === commonDirectory) {
          return realpathSync.native(candidate);
        }
      } catch {
        // An unrelated or malformed ancestor marker is not authority for this
        // linked worktree; keep looking for the exact common-directory owner.
      }
    }
    candidate = dirname(candidate);
  }
  return null;
}

export function computeServerRootId(canonicalRoot, platform = process.platform) {
  if (typeof canonicalRoot !== "string" || canonicalRoot === "") {
    throw new TypeError("Server root identity requires a canonical root path.");
  }
  const identityPath = platform === "win32"
    ? normalizeWindowsIdentityPath(canonicalRoot)
    : canonicalRoot;
  return createHash("sha256").update(identityPath).digest("hex");
}

export function computeServerInstallGeneration(codeRoot) {
  if (typeof codeRoot !== "string" || codeRoot === "") {
    throw new TypeError("Server install generation requires a code root.");
  }

  const root = resolve(codeRoot);
  const residentManifestPath = join(root, "lazurio.resident.json");
  try {
    const manifest = JSON.parse(readFileSync(residentManifestPath, "utf8"));
    const digest = manifest?.payload?.digest;
    if (manifest?.schema_version === "lazurio.resident.manifest.v1" && isSha256(digest)) {
      return digest;
    }
    throw new Error("Installed Lazurio runtime manifest has no valid payload digest.");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const normalizedInputs = serverInstallGenerationInputPaths(root).map((path) => ({
    absolute: join(root, ...path.split("/")),
    relative: path,
  }));

  const hash = createHash("sha256");
  for (const input of normalizedInputs) {
    const stat = lstatSync(input.absolute);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`Server generation input is not a physical file: ${input.relative}`);
    }
    const bytes = readFileSync(input.absolute);
    hash.update(input.relative);
    hash.update("\0");
    hash.update(String(bytes.length));
    hash.update("\0");
    hash.update(bytes);
    hash.update("\0");
  }
  return hash.digest("hex");
}

export function serverInstallGenerationInputPaths(codeRoot) {
  if (typeof codeRoot !== "string" || codeRoot === "") {
    throw new TypeError("Server install generation requires a code root.");
  }

  const root = resolve(codeRoot);
  const inputs = [];
  for (const directory of generationDirectories) {
    const absoluteDirectory = join(root, directory);
    const directoryStat = lstatSync(absoluteDirectory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
      throw new Error(`Server generation input is not a physical directory: ${directory}`);
    }
    for (const entry of readdirSync(absoluteDirectory, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".mjs") || entry.name.endsWith(".test.mjs")) continue;
      inputs.push(join(absoluteDirectory, entry.name));
    }
  }
  for (const directory of generationTreeDirectories) {
    collectGenerationTreeFiles({ root, directory, inputs });
  }
  for (const file of generationFiles) inputs.push(join(root, file));

  const normalizedInputs = inputs
    .map((path) => relative(root, path).split(sep).join("/"))
    .sort();
  if (normalizedInputs.length === 0) throw new Error("Server install generation has no source inputs.");
  return normalizedInputs;
}

function collectGenerationTreeFiles({ root, directory, inputs }) {
  const absoluteDirectory = join(root, directory);
  const directoryStat = lstatSync(absoluteDirectory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    throw new Error(`Server generation input is not a physical directory: ${directory}`);
  }
  for (const entry of readdirSync(absoluteDirectory, { withFileTypes: true })) {
    const relativePath = join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`Server generation input must not be a symlink: ${relativePath}`);
    }
    if (entry.isDirectory()) {
      collectGenerationTreeFiles({ root, directory: relativePath, inputs });
      continue;
    }
    if (entry.isFile()) inputs.push(join(root, relativePath));
  }
}

export function buildServerIdentity({
  rootId,
  controlRootId,
  installGeneration,
  instanceId,
  pid,
  startedAt,
  requestTrustProfile = "local",
}) {
  const identity = {
    schema_version: LAZURIO_SERVER_IDENTITY_SCHEMA,
    product: LAZURIO_SERVER_PRODUCT,
    root_id: rootId,
    control_root_id: controlRootId,
    install_generation: installGeneration,
    instance_id: instanceId,
    pid,
    started_at: startedAt,
    request_trust_profile: requestTrustProfile,
  };
  if (!isValidServerIdentity(identity)) {
    throw new TypeError("Cannot build an invalid Lazurio Server identity.");
  }
  return Object.freeze(identity);
}

export function classifyServerIdentity({ observed = null, legacyObserved = null, expected }) {
  assertExpectedIdentity(expected);

  if (observed !== null && observed !== undefined) {
    if (observed?.product !== LAZURIO_SERVER_PRODUCT) return "unrecognized";
    if (isSha256(observed?.root_id) && observed.root_id !== expected.rootId) return "foreign_root";
    if (observed?.root_id !== expected.rootId) return "unrecognized";
    if (observed?.schema_version !== LAZURIO_SERVER_IDENTITY_SCHEMA) return "protocol_incompatible";
    // The immediately preceding v1 Server did not publish control_root_id.
    // Its exact instance id is still sufficient for the existing guarded
    // shutdown handshake, so treat that verified shape as a replaceable old
    // generation instead of forcing every user to kill it manually once.
    if (isPreControlRootServerIdentity(observed)) return "stale_install";
    if (!isValidServerIdentity(observed)) return "protocol_incompatible";
    if (observed.control_root_id !== expected.controlRootId) return "stale_install";
    if (observed.install_generation !== expected.installGeneration) return "stale_install";
    return "compatible";
  }

  if (legacyObserved !== null && legacyObserved !== undefined) {
    if (legacyObserved?.schema_version !== LEGACY_LAUNCHPAD_IDENTITY_SCHEMA || !isSha256(legacyObserved?.root_id)) {
      return "unrecognized";
    }
    return legacyObserved.root_id === expected.rootId ? "legacy_same_root" : "foreign_root";
  }

  return "unrecognized";
}

function isPreControlRootServerIdentity(identity) {
  return Boolean(
    identity
    && typeof identity === "object"
    && !Array.isArray(identity)
    && !("control_root_id" in identity)
    && identity.schema_version === LAZURIO_SERVER_IDENTITY_SCHEMA
    && identity.product === LAZURIO_SERVER_PRODUCT
    && isSha256(identity.root_id)
    && isSha256(identity.install_generation)
    && typeof identity.instance_id === "string"
    && uuidPattern.test(identity.instance_id)
    && Number.isSafeInteger(identity.pid)
    && identity.pid > 0
    && typeof identity.started_at === "string"
    && Number.isFinite(Date.parse(identity.started_at))
    && (
      identity.request_trust_profile === undefined
      || identity.request_trust_profile === "local"
      || identity.request_trust_profile === "hosted"
    )
  );
}

export function isValidServerIdentity(identity) {
  return Boolean(
    identity
    && typeof identity === "object"
    && !Array.isArray(identity)
    && identity.schema_version === LAZURIO_SERVER_IDENTITY_SCHEMA
    && identity.product === LAZURIO_SERVER_PRODUCT
    && isSha256(identity.root_id)
    && isSha256(identity.control_root_id)
    && isSha256(identity.install_generation)
    && typeof identity.instance_id === "string"
    && uuidPattern.test(identity.instance_id)
    && Number.isSafeInteger(identity.pid)
    && identity.pid > 0
    && typeof identity.started_at === "string"
    && Number.isFinite(Date.parse(identity.started_at))
    && (
      identity.request_trust_profile === undefined
      || identity.request_trust_profile === "local"
      || identity.request_trust_profile === "hosted"
    )
  );
}

function assertExpectedIdentity(expected) {
  if (
    !expected
    || !isSha256(expected.rootId)
    || !isSha256(expected.controlRootId)
    || !isSha256(expected.installGeneration)
  ) {
    throw new TypeError("Server identity classification requires exact operated Root, control Root, and install generations.");
  }
}

function isSha256(value) {
  return typeof value === "string" && sha256Pattern.test(value);
}

function normalizeWindowsIdentityPath(path) {
  let normalized = win32.normalize(path).replace(/[\\/]+$/u, "");
  if (normalized.toLowerCase().startsWith("\\\\?\\unc\\")) {
    normalized = `\\\\${normalized.slice(8)}`;
  } else if (normalized.startsWith("\\\\?\\")) {
    normalized = normalized.slice(4);
  }
  return normalized.toLowerCase();
}

function parseGitDirectoryPointer(source, root) {
  const match = source.match(/^gitdir: ([^\0\r\n]+)\r?\n?$/u);
  if (!match) throw new Error("Lazurio Root .git pointer is malformed.");
  const gitDirectory = realpathSync.native(resolveGitPointer(root, match[1]));
  const stat = lstatSync(gitDirectory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("Lazurio Root .git pointer does not resolve to a physical directory.");
  }
  return gitDirectory;
}

function readSingleGitPath(path, label) {
  const value = readFileSync(path, "utf8");
  if (value.includes("\0") || value.split(/\r?\n/u).filter(Boolean).length !== 1) {
    throw new Error(`Lazurio Root ${label} pointer is malformed.`);
  }
  const normalized = value.trim();
  if (normalized === "") throw new Error(`Lazurio Root ${label} pointer is empty.`);
  return normalized;
}

function resolveGitPointer(base, pointer) {
  return isAbsolute(pointer) || win32.isAbsolute(pointer)
    ? pointer
    : resolve(base, pointer);
}
