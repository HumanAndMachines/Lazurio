import { spawnSync } from "node:child_process";
import {
  lstatSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import {
  isAbsolute,
  join,
  resolve,
  win32,
} from "node:path";
import {
  RESIDENT_CHANNELS,
  validateResidentManifest,
} from "./resident-manifest-lib.mjs";

export const LAZURIO_CLI_PROVENANCE_SCHEMA = "lazurio.cli.provenance.v1";
export const LAZURIO_CLI_PRODUCT = "lazurio-cli";
export const LAZURIO_SOURCE_REPOSITORY = "HumanAndMachines/Lazurio";

const commitPattern = /^[0-9a-f]{40,64}$/u;
const digestPattern = /^[0-9a-f]{64}$/u;
const repositoryPattern = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,38}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/u;
const versionPattern = /^[A-Za-z0-9][A-Za-z0-9.+-]*$/u;
const residentBuildChannels = new Set(RESIDENT_CHANNELS);
const packageMetadataSchema = "lazurio.cli.package.v1";

export function buildLazurioCliProvenance({
  root,
  platform = process.platform,
  environment = process.env,
  gitExecutable,
  runGit = runTrustedGitCommandSync,
} = {}) {
  if (typeof root !== "string" || root === "" || root.includes("\n") || root.includes("\r")) {
    throw new TypeError("CLI provenance requires a valid root path without newlines.");
  }

  let canonicalRoot;
  try {
    canonicalRoot = realpathSync.native(resolve(root));
    const rootStat = statSync(canonicalRoot);
    if (!rootStat.isDirectory()) return unresolved(resolve(root), "root_not_directory");
  } catch {
    return unresolved(resolve(root), "root_missing");
  }

  const gitMarker = safeLstat(join(canonicalRoot, ".git"));
  const residentMarker = safeLstat(join(canonicalRoot, "lazurio.resident.json"));
  if (gitMarker && residentMarker) {
    return provenance({
      rootPath: canonicalRoot,
      rootKind: "conflict",
      status: "conflict",
      reason: "source_and_resident_metadata",
    });
  }
  if (residentMarker) return residentProvenance(canonicalRoot, residentMarker);
  if (gitMarker) {
    return sourceProvenance({
      root: canonicalRoot,
      marker: gitMarker,
      platform,
      environment,
      gitExecutable,
      runGit,
    });
  }
  const packageMarker = safeLstat(join(canonicalRoot, "package.json"));
  if (packageMarker) return packageProvenance(canonicalRoot, packageMarker);
  return unresolved(canonicalRoot, "metadata_missing");
}

export function isValidLazurioCliProvenance(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (value.schema_version !== LAZURIO_CLI_PROVENANCE_SCHEMA) return false;
  if (value.product !== LAZURIO_CLI_PRODUCT) return false;
  if (typeof value.root_path !== "string" || !isAbsolute(value.root_path)) return false;
  if (!new Set(["source", "resident", "package", "unknown", "conflict"]).has(value.root_kind)) return false;
  if (!new Set(["resolved", "unrecognized", "conflict"]).has(value.status)) return false;
  if (typeof value.reason !== "string" || value.reason === "") return false;
  if (!new Set(["git", "manifest", "package", "none"]).has(value.verification)) return false;
  if (value.status === "resolved") {
    if (typeof value.version !== "string" || !versionPattern.test(value.version)) return false;
    if (!validSource(value.source)) return false;
    if (value.root_kind === "source") {
      return value.verification === "git"
        && typeof value.source.dirty === "boolean"
        && value.artifact === null;
    }
    if (value.root_kind === "resident") {
      return value.verification === "manifest"
        && value.source.dirty === null
        && validArtifact(value.artifact);
    }
    if (value.root_kind === "package") {
      return value.verification === "package"
        && value.source.dirty === null
        && Number.isSafeInteger(value.source.commit_epoch)
        && value.source.commit_epoch >= 0
        && value.artifact === null;
    }
    return false;
  }
  return value.version === null
    && value.source === null
    && value.artifact === null
    && value.verification === "none";
}

export function normalizeComparableCliPath(path, platform = process.platform) {
  if (typeof path !== "string" || path === "") return "";
  if (platform === "win32") {
    let normalized = win32.normalize(path).replace(/[\\/]+$/u, "");
    if (normalized.toLowerCase().startsWith("\\\\?\\unc\\")) {
      normalized = `\\\\${normalized.slice(8)}`;
    } else if (normalized.startsWith("\\\\?\\")) {
      normalized = normalized.slice(4);
    }
    return normalized.toLowerCase();
  }
  return resolve(path).replace(/[\\/]+$/u, "");
}

export function trustedGitCandidates(platform = process.platform) {
  if (platform === "darwin") {
    return ["/usr/bin/git", "/opt/homebrew/bin/git", "/usr/local/bin/git"];
  }
  if (platform === "linux") {
    return ["/usr/bin/git", "/bin/git", "/usr/local/bin/git"];
  }
  if (platform !== "win32") return [];
  return [
    "C:\\Program Files\\Git\\cmd\\git.exe",
    "C:\\Program Files\\Git\\bin\\git.exe",
    "C:\\Program Files (x86)\\Git\\cmd\\git.exe",
    "C:\\Program Files (x86)\\Git\\bin\\git.exe",
  ];
}

export function trustedGitHubCliCandidates(platform = process.platform) {
  if (platform === "darwin") {
    return ["/opt/homebrew/bin/gh", "/usr/local/bin/gh", "/usr/bin/gh"];
  }
  if (platform === "linux") {
    return ["/usr/bin/gh", "/bin/gh", "/usr/local/bin/gh", "/home/linuxbrew/.linuxbrew/bin/gh"];
  }
  if (platform !== "win32") return [];
  return [
    "C:\\Program Files\\GitHub CLI\\gh.exe",
    "C:\\Program Files (x86)\\GitHub CLI\\gh.exe",
  ];
}

export function resolveTrustedGitExecutable({
  platform = process.platform,
} = {}) {
  return resolveTrustedExecutable(trustedGitCandidates(platform));
}

export function resolveTrustedGitHubCliExecutable({
  platform = process.platform,
} = {}) {
  return resolveTrustedExecutable(trustedGitHubCliCandidates(platform));
}

function resolveTrustedExecutable(candidates) {
  for (const candidate of candidates) {
    try {
      const canonicalPath = realpathSync.native(candidate);
      if (isAbsolute(canonicalPath) && statSync(canonicalPath).isFile()) return canonicalPath;
    } catch {
      // Only fixed installation candidates are considered.
    }
  }
  return null;
}

function sourceProvenance({
  root,
  marker,
  platform,
  environment,
  gitExecutable,
  runGit,
}) {
  if (marker.isSymbolicLink() || (!marker.isDirectory() && !marker.isFile())) {
    return unresolved(root, "source_metadata_unsafe", "source");
  }
  const executable = gitExecutable === undefined
    ? resolveTrustedGitExecutable({ platform, environment })
    : gitExecutable;
  if (!executable) return unresolved(root, "git_unavailable", "source");

  const topLevel = gitText(runGit, executable, root, ["rev-parse", "--show-toplevel"], environment);
  if (!topLevel.ok) return unresolved(root, "git_repository_unreadable", "source");
  if (normalizeComparableCliPath(topLevel.value, platform) !== normalizeComparableCliPath(root, platform)) {
    return unresolved(root, "git_root_mismatch", "source");
  }
  const head = gitText(runGit, executable, root, ["rev-parse", "HEAD"], environment);
  if (!head.ok || !commitPattern.test(head.value)) {
    return unresolved(root, "git_head_unresolved", "source");
  }
  const status = gitText(
    runGit,
    executable,
    root,
    ["status", "--porcelain=v1", "--untracked-files=all", "--ignore-submodules=none"],
    environment,
    { trim: false },
  );
  if (!status.ok) return unresolved(root, "git_status_unresolved", "source");

  const origin = gitText(runGit, executable, root, ["config", "--get", "remote.origin.url"], environment);
  const repository = origin.ok ? normalizeGitHubRepository(origin.value) : null;
  return provenance({
    rootPath: root,
    rootKind: "source",
    status: "resolved",
    reason: "git_head_resolved",
    verification: "git",
    version: `0.0.0-development.${head.value.slice(0, 12)}`,
    source: {
      repository,
      commit: head.value,
      dirty: status.value.length > 0,
    },
  });
}

function residentProvenance(root, marker) {
  if (!marker.isFile() || marker.isSymbolicLink()) {
    return unresolved(root, "resident_manifest_unsafe", "resident");
  }
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(join(root, "lazurio.resident.json"), "utf8"));
  } catch {
    return unresolved(root, "resident_manifest_invalid_json", "resident");
  }
  if (!validResidentManifestProvenance(manifest)) {
    return unresolved(root, "resident_manifest_invalid", "resident");
  }
  return provenance({
    rootPath: root,
    rootKind: "resident",
    status: "resolved",
    reason: "resident_manifest_resolved",
    verification: "manifest",
    version: manifest.artifact_version,
    source: {
      repository: manifest.source.repository,
      commit: manifest.source.commit,
      dirty: null,
    },
    artifact: {
      id: manifest.artifact_id,
      profile: manifest.profile,
      build_channel: manifest.channel,
      target: `${manifest.target.os}-${manifest.target.arch}`,
      payload_digest: manifest.payload.digest,
    },
  });
}

function packageProvenance(root, marker) {
  if (!marker.isFile() || marker.isSymbolicLink()) {
    return unresolved(root, "package_manifest_unsafe", "package");
  }
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  } catch {
    return unresolved(root, "package_manifest_invalid_json", "package");
  }
  if (manifest?.name !== "lazurio" || !("lazurio" in manifest)) {
    return unresolved(root, "metadata_missing");
  }
  const metadata = manifest.lazurio;
  if (
    metadata?.schema_version !== packageMetadataSchema
    || !versionPattern.test(manifest.version ?? "")
    || !validPackageSource(metadata.source)
  ) {
    return unresolved(root, "package_manifest_invalid", "package");
  }
  return provenance({
    rootPath: root,
    rootKind: "package",
    status: "resolved",
    reason: "package_manifest_resolved",
    verification: "package",
    version: manifest.version,
    source: {
      repository: metadata.source.repository,
      commit: metadata.source.commit,
      commit_epoch: metadata.source.commit_epoch,
      dirty: null,
    },
  });
}

function validResidentManifestProvenance(manifest) {
  return validateResidentManifest(manifest).length === 0;
}

function validSource(source) {
  return Boolean(
    source
    && typeof source === "object"
    && !Array.isArray(source)
    && (source.repository === null || repositoryPattern.test(source.repository))
    && commitPattern.test(source.commit ?? "")
    && (
      source.commit_epoch === undefined
      || (Number.isSafeInteger(source.commit_epoch) && source.commit_epoch >= 0)
    )
    && (typeof source.dirty === "boolean" || source.dirty === null),
  );
}

function validPackageSource(source) {
  return Boolean(
    source
    && typeof source === "object"
    && !Array.isArray(source)
    && repositoryPattern.test(source.repository ?? "")
    && commitPattern.test(source.commit ?? "")
    && Number.isSafeInteger(source.commit_epoch)
    && source.commit_epoch >= 0
    && Object.keys(source).every((key) => ["repository", "commit", "commit_epoch"].includes(key)),
  );
}

function validArtifact(artifact) {
  return Boolean(
    artifact
    && typeof artifact === "object"
    && !Array.isArray(artifact)
    && typeof artifact.id === "string"
    && typeof artifact.profile === "string"
    && residentBuildChannels.has(artifact.build_channel)
    && /^(linux|darwin|windows)-(x64|arm64)$/u.test(artifact.target ?? "")
    && digestPattern.test(artifact.payload_digest ?? ""),
  );
}

function normalizeGitHubRepository(value) {
  const trimmed = value.trim();
  const match = trimmed.match(
    /^(?:https?:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9][A-Za-z0-9_.-]{0,38})\/([A-Za-z0-9][A-Za-z0-9_.-]{0,99}?)(?:\.git)?\/?$/u,
  );
  if (!match) return null;
  const repository = `${match[1]}/${match[2]}`;
  return repositoryPattern.test(repository) ? repository : null;
}

function gitText(runGit, executable, cwd, args, environment, { trim = true } = {}) {
  let result;
  try {
    result = runGit({ executable, cwd, args, environment });
  } catch {
    return { ok: false, value: "" };
  }
  if (result?.status !== 0) return { ok: false, value: "" };
  const value = String(result.stdout ?? "");
  return { ok: true, value: trim ? value.trim() : value };
}

export function runTrustedGitCommandSync({ executable, cwd, args, environment }) {
  const result = spawnSync(
    executable,
    [
      "--no-optional-locks",
      "-c",
      "core.hooksPath=",
      "-c",
      "core.fsmonitor=false",
      "-c",
      "protocol.ext.allow=never",
      ...args,
    ],
    {
      cwd,
      env: sanitizedGitEnvironment(environment),
      encoding: "utf8",
      shell: false,
      windowsHide: true,
    },
  );
  return {
    status: result.status,
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? result.error?.message ?? ""),
  };
}

export function sanitizedGitEnvironment(environment, platform = process.platform) {
  const result = {};
  for (const key of ["PATH", "TMPDIR", "TEMP", "TMP", "SystemRoot", "ComSpec", "PATHEXT"]) {
    if (typeof environment[key] === "string") result[key] = environment[key];
  }
  result.LC_ALL = "C";
  result.GIT_TERMINAL_PROMPT = "0";
  result.GIT_OPTIONAL_LOCKS = "0";
  result.GIT_PAGER = "cat";
  result.GIT_CONFIG_NOSYSTEM = "1";
  result.GIT_CONFIG_GLOBAL = platform === "win32" ? "NUL" : "/dev/null";
  result.GIT_CONFIG_COUNT = "0";
  return result;
}

function safeLstat(path) {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

function unresolved(rootPath, reason, rootKind = "unknown") {
  return provenance({
    rootPath,
    rootKind,
    status: "unrecognized",
    reason,
  });
}

function provenance({
  rootPath,
  rootKind,
  status,
  reason,
  verification = "none",
  version = null,
  source = null,
  artifact = null,
}) {
  return Object.freeze({
    schema_version: LAZURIO_CLI_PROVENANCE_SCHEMA,
    product: LAZURIO_CLI_PRODUCT,
    status,
    reason,
    root_kind: rootKind,
    root_path: rootPath,
    verification,
    version,
    source: source ? Object.freeze(source) : null,
    artifact: artifact ? Object.freeze(artifact) : null,
  });
}
