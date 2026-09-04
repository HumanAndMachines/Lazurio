import { spawnSync } from "node:child_process";
import { resolveExecutableOnPath } from "./toolchain-lib.mjs";

export const DEVELOPER_TOOL_UPDATE_POLICY = "principal_consent_required";

const stableVersionPattern = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u;

export const DEVELOPER_TOOL_DEFINITIONS = Object.freeze([
  Object.freeze({
    id: "git",
    title: "Git",
    executable: "git",
    required: true,
    version_args: ["--version"],
    version_pattern: /git version (\d+\.\d+\.\d+)/u,
    release_source: Object.freeze({
      kind: "github_tags",
      api_url: "https://api.github.com/repos/git/git/tags?per_page=20",
      project_url: "https://github.com/git/git",
    }),
  }),
  Object.freeze({
    id: "github_cli",
    title: "GitHub CLI",
    executable: "gh",
    required: true,
    version_args: ["--version"],
    version_pattern: /gh version (\d+\.\d+\.\d+)/u,
    release_source: Object.freeze({
      kind: "github_latest_release",
      api_url: "https://api.github.com/repos/cli/cli/releases/latest",
      project_url: "https://github.com/cli/cli/releases",
    }),
  }),
  Object.freeze({
    id: "codex",
    title: "Codex CLI",
    executable: "codex",
    required: true,
    version_args: ["--version"],
    version_pattern: /codex-cli (\d+\.\d+\.\d+)/u,
    release_source: Object.freeze({
      kind: "github_latest_release",
      api_url: "https://api.github.com/repos/openai/codex/releases/latest",
      project_url: "https://github.com/openai/codex/releases",
    }),
  }),
  Object.freeze({
    id: "claude",
    title: "Claude Code",
    executable: "claude",
    required: false,
    version_args: ["--version"],
    version_pattern: /(?:^|\s)(\d+\.\d+\.\d+)(?:\s|$)/u,
    release_source: Object.freeze({
      kind: "github_latest_release",
      api_url: "https://api.github.com/repos/anthropics/claude-code/releases/latest",
      project_url: "https://github.com/anthropics/claude-code/releases",
    }),
  }),
]);

export async function inspectDeveloperToolUpdates({
  definitions = DEVELOPER_TOOL_DEFINITIONS,
  resolveExecutable = resolveEffectiveExecutable,
  runCommand = runVersionCommand,
  fetchRelease = fetchOfficialRelease,
} = {}) {
  const installed = definitions.map((definition) => inspectInstalledVersion({
    definition,
    resolveExecutable,
    runCommand,
  }));

  return Promise.all(installed.map(async (observation) => {
    if (observation.status === "not_available" || observation.status === "probe_failed") {
      return observation;
    }
    let release;
    try {
      release = await fetchRelease(observation.release_source);
    } catch (error) {
      return Object.freeze({
        ...observation,
        status: "currency_unknown",
        reason: releaseLookupReason(error),
        latest_version: null,
        release_url: null,
      });
    }
    const comparison = compareStableVersions(observation.current_version, release.version);
    return Object.freeze({
      ...observation,
      status: comparison < 0 ? "update_available" : "current",
      reason: comparison < 0 ? "newer_official_release" : "official_release_not_newer",
      latest_version: release.version,
      release_url: release.url,
    });
  }));
}

export function compareStableVersions(left, right) {
  const leftParts = stableVersionParts(left);
  const rightParts = stableVersionParts(right);
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] !== rightParts[index]) return leftParts[index] - rightParts[index];
  }
  return 0;
}

export function latestStableTag(tags) {
  const versions = (Array.isArray(tags) ? tags : [])
    .map((entry) => versionFromTag(entry?.name))
    .filter(Boolean)
    .sort((left, right) => compareStableVersions(right, left));
  if (versions.length === 0) throw toolUpdateError("release_response_invalid");
  return versions[0];
}

function inspectInstalledVersion({ definition, resolveExecutable, runCommand }) {
  const executable = resolveExecutable(definition.executable);
  if (!executable) {
    return Object.freeze({
      id: definition.id,
      title: definition.title,
      required: definition.required,
      update_policy: DEVELOPER_TOOL_UPDATE_POLICY,
      status: "not_available",
      reason: "executable_not_found_on_path",
      current_version: null,
      latest_version: null,
      release_url: null,
      release_source: definition.release_source,
    });
  }
  const result = runCommand(executable, definition.version_args);
  const version = result?.status === 0
    ? definition.version_pattern.exec(String(result.stdout ?? ""))?.[1] ?? null
    : null;
  if (!version || !stableVersionPattern.test(version)) {
    return Object.freeze({
      id: definition.id,
      title: definition.title,
      required: definition.required,
      update_policy: DEVELOPER_TOOL_UPDATE_POLICY,
      status: "probe_failed",
      reason: "installed_version_unresolved",
      current_version: null,
      latest_version: null,
      release_url: null,
      release_source: definition.release_source,
    });
  }
  return Object.freeze({
    id: definition.id,
    title: definition.title,
    required: definition.required,
    update_policy: DEVELOPER_TOOL_UPDATE_POLICY,
    status: "installed",
    reason: "installed_version_resolved",
    current_version: version,
    latest_version: null,
    release_url: null,
    release_source: definition.release_source,
  });
}

function resolveEffectiveExecutable(name) {
  return resolveExecutableOnPath(name);
}

function runVersionCommand(executable, args) {
  return spawnSync(executable, args, {
    encoding: "utf8",
    timeout: 5_000,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function fetchOfficialRelease(source, { fetchImpl = fetch, timeoutMs = 5_000 } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetchImpl(source.api_url, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "lazurio-tool-update-diagnostics",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      signal: controller.signal,
    });
  } catch (error) {
    if (error?.name === "AbortError") throw toolUpdateError("release_lookup_timeout");
    throw toolUpdateError("release_lookup_unavailable");
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) throw toolUpdateError(`release_lookup_http_${response.status}`);
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw toolUpdateError("release_response_invalid");
  }
  if (source.kind === "github_tags") {
    const version = latestStableTag(payload);
    return Object.freeze({ version, url: `${source.project_url}/releases/tag/v${version}` });
  }
  const version = versionFromTag(payload?.tag_name);
  if (!version) throw toolUpdateError("release_response_invalid");
  const url = typeof payload?.html_url === "string" && payload.html_url.startsWith("https://")
    ? payload.html_url
    : source.project_url;
  return Object.freeze({ version, url });
}

function versionFromTag(tag) {
  if (typeof tag !== "string") return null;
  const match = /(?:^|[-v])(\d+\.\d+\.\d+)$/u.exec(tag);
  return match && stableVersionPattern.test(match[1]) ? match[1] : null;
}

function stableVersionParts(version) {
  if (!stableVersionPattern.test(version ?? "")) {
    throw new TypeError(`Expected a stable three-part version, got '${version ?? ""}'.`);
  }
  return version.split(".").map(Number);
}

function toolUpdateError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function releaseLookupReason(error) {
  return typeof error?.code === "string" && error.code !== ""
    ? error.code
    : "release_lookup_failed";
}
