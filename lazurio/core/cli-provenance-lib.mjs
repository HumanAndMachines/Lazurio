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

export const LAZURIO_CLI_PROVENANCE_SCHEMA = "lazurio.cli.provenance.v1";
export const LAZURIO_CLI_PRODUCT = "lazurio-cli";

const commitPattern = /^[0-9a-f]{40,64}$/u;
const digestPattern = /^[0-9a-f]{64}$/u;
const repositoryPattern = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,38}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/u;
const versionPattern = /^[A-Za-z0-9][A-Za-z0-9.+-]*$/u;
const residentChannels = new Set(["nightly", "candidate", "stable"]);

export function buildLazurioCliProvenance({
  root,
  platform = process.platform,
  environment = process.env,
  gitExecutable,
  runGit = runGitSync,
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
  return unresolved(canonicalRoot, "metadata_missing");
}

export function isValidLazurioCliProvenance(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (value.schema_version !== LAZURIO_CLI_PROVENANCE_SCHEMA) return false;
  if (value.product !== LAZURIO_CLI_PRODUCT) return false;
  if (typeof value.root_path !== "string" || !isAbsolute(value.root_path)) return false;
  if (!new Set(["source", "resident", "unknown", "conflict"]).has(value.root_kind)) return false;
  if (!new Set(["resolved", "unrecognized", "conflict"]).has(value.status)) return false;
  if (typeof value.reason !== "string" || value.reason === "") return false;
  if (!new Set(["git", "manifest", "none"]).has(value.verification)) return false;
  if (value.status === "resolved") {
    if (typeof value.version !== "string" || !versionPattern.test(value.version)) return false;
    if (!new Set(["development", ...residentChannels]).has(value.channel)) return false;
    if (!validSource(value.source)) return false;
    if (value.root_kind === "source") {
      return value.channel === "development"
        && value.verification === "git"
        && typeof value.source.dirty === "boolean"
        && value.artifact === null;
    }
    if (value.root_kind === "resident") {
      return residentChannels.has(value.channel)
        && value.verification === "manifest"
        && value.source.dirty === null
        && validArtifact(value.artifact);
    }
    return false;
  }
  return value.version === null
    && value.channel === null
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

export function trustedGitCandidates(platform = process.platform, environment = process.env) {
  if (platform === "darwin") {
    return ["/usr/bin/git", "/opt/homebrew/bin/git", "/usr/local/bin/git"];
  }
  if (platform === "linux") {
    return ["/usr/bin/git", "/bin/git", "/usr/local/bin/git"];
  }
  if (platform !== "win32") return [];
  const localAppData = environment.LOCALAPPDATA;
  return [
    "C:\\Program Files\\Git\\cmd\\git.exe",
    "C:\\Program Files\\Git\\bin\\git.exe",
    "C:\\Program Files (x86)\\Git\\cmd\\git.exe",
    "C:\\Program Files (x86)\\Git\\bin\\git.exe",
    ...(typeof localAppData === "string" && win32.isAbsolute(localAppData)
      ? [
          win32.join(localAppData, "Programs", "Git", "cmd", "git.exe"),
          win32.join(localAppData, "Programs", "Git", "bin", "git.exe"),
        ]
      : []),
  ];
}

export function resolveTrustedGitExecutable({
  platform = process.platform,
  environment = process.env,
} = {}) {
  for (const candidate of trustedGitCandidates(platform, environment)) {
    try {
      const canonicalPath = realpathSync.native(candidate);
      if (isAbsolute(canonicalPath) && statSync(canonicalPath).isFile()) return canonicalPath;
    } catch {
      // Only fixed, system-owned candidates are considered.
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
    channel: "development",
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
    channel: manifest.channel,
    version: manifest.artifact_version,
    source: {
      repository: manifest.source.repository,
      commit: manifest.source.commit,
      dirty: null,
    },
    artifact: {
      id: manifest.artifact_id,
      profile: manifest.profile,
      target: `${manifest.target.os}-${manifest.target.arch}`,
      payload_digest: manifest.payload.digest,
    },
  });
}

function validResidentManifestProvenance(manifest) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) return false;
  if (manifest.schema_version !== "lazurio.resident.manifest.v1") return false;
  if (!versionPattern.test(manifest.artifact_version ?? "")) return false;
  if (!residentChannels.has(manifest.channel)) return false;
  if (typeof manifest.profile !== "string" || !/^[a-z][a-z0-9-]*$/u.test(manifest.profile)) return false;
  if (!new Set(["linux", "darwin", "windows"]).has(manifest.target?.os)) return false;
  if (!new Set(["x64", "arm64"]).has(manifest.target?.arch)) return false;
  if (!repositoryPattern.test(manifest.source?.repository ?? "")) return false;
  if (!commitPattern.test(manifest.source?.commit ?? "")) return false;
  if (!digestPattern.test(manifest.payload?.digest ?? "")) return false;
  const expectedId = `lazurio-resident-${manifest.profile}-${manifest.artifact_version}-${manifest.target.os}-${manifest.target.arch}`;
  return manifest.artifact_id === expectedId;
}

function validSource(source) {
  return Boolean(
    source
    && typeof source === "object"
    && !Array.isArray(source)
    && (source.repository === null || repositoryPattern.test(source.repository))
    && commitPattern.test(source.commit ?? "")
    && (typeof source.dirty === "boolean" || source.dirty === null),
  );
}

function validArtifact(artifact) {
  return Boolean(
    artifact
    && typeof artifact === "object"
    && !Array.isArray(artifact)
    && typeof artifact.id === "string"
    && typeof artifact.profile === "string"
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

function runGitSync({ executable, cwd, args, environment }) {
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

function sanitizedGitEnvironment(environment) {
  const result = {};
  for (const key of ["PATH", "TMPDIR", "TEMP", "TMP", "SystemRoot", "ComSpec", "PATHEXT"]) {
    if (typeof environment[key] === "string") result[key] = environment[key];
  }
  result.LC_ALL = "C";
  result.GIT_TERMINAL_PROMPT = "0";
  result.GIT_OPTIONAL_LOCKS = "0";
  result.GIT_PAGER = "cat";
  result.GIT_CONFIG_NOSYSTEM = "1";
  result.GIT_CONFIG_GLOBAL = process.platform === "win32" ? "NUL" : "/dev/null";
  result.GIT_CONFIG_COUNT = "0";
  return result;
}

function safeLstat(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return null;
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
  channel = null,
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
    channel,
    version,
    source: source ? Object.freeze(source) : null,
    artifact: artifact ? Object.freeze(artifact) : null,
  });
}
