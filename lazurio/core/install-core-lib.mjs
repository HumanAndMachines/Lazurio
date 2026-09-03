import { spawnSync } from "node:child_process";
import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, posix, resolve, win32 } from "node:path";

import {
  buildLazurioCliProvenance,
  LAZURIO_SOURCE_REPOSITORY,
  resolveTrustedGitExecutable,
  resolveTrustedGitHubCliExecutable,
  resolveTrustedNodeExecutable,
  sanitizedGitEnvironment,
  trustedGitCandidates,
  trustedGitHubCliCandidates,
  trustedNodeCandidates,
} from "./cli-provenance-lib.mjs";
import {
  classifyBunRuntime,
  classifyNodeRuntime,
  executablePathsMatch,
  nodeVersionFromOutput,
  readRequiredBunVersion,
  readRequiredNodeVersionRange,
  resolveExecutableOnPath,
} from "./toolchain-lib.mjs";

export const LAZURIO_INSTALL_REPORT_SCHEMA = "lazurio.install.report.v1";
export const INSTALL_MODE = "report";
export const INSTALL_STEP_IDS = Object.freeze([
  "platform",
  "bun",
  "git",
  "github_cli",
  "node",
  "github_auth",
  "root",
]);
export const INSTALL_STEP_STATUSES = Object.freeze([
  "completed",
  "skipped",
  "action_required",
  "failed",
]);

const supportedPlatforms = new Set(["darwin", "linux", "win32"]);
const supportedArchitectures = new Set(["x64", "arm64"]);
const ignoredEmptyRootEntries = new Set([".DS_Store", "Thumbs.db", "desktop.ini"]);
const rootLayouts = new Set([
  "missing",
  "empty",
  "source_root",
  "generated_root",
  "incomplete_generated_root",
  "personalspace",
  "unrecognized",
  "unsafe",
]);
const reasonsByStep = Object.freeze({
  platform: new Set(["platform_supported", "platform_unsupported", "probe_failed"]),
  bun: new Set([
    "bun_runtime_current",
    "bun_runtime_mismatch",
    "bun_runtime_unavailable",
    "bun_runtime_not_on_path",
    "bun_path_identity_mismatch",
    "bun_path_unusable",
    "probe_failed",
  ]),
  git: new Set([
    "git_available",
    "git_missing",
    "git_not_on_path",
    "git_path_identity_mismatch",
    "git_unusable",
    "probe_failed",
  ]),
  github_cli: new Set([
    "github_cli_available",
    "github_cli_missing",
    "github_cli_not_on_path",
    "github_cli_path_identity_mismatch",
    "github_cli_unusable",
    "probe_failed",
  ]),
  node: new Set([
    "node_runtime_compatible",
    "node_runtime_incompatible",
    "node_runtime_missing",
    "node_runtime_not_on_path",
    "node_path_identity_mismatch",
    "node_runtime_unusable",
    "probe_failed",
  ]),
  github_auth: new Set(["github_authenticated", "github_login_required", "github_ssh_protocol_required", "github_cli_unavailable", "probe_failed"]),
  root: new Set([
    "root_creation_required",
    "source_root_ready",
    "source_root_unverified",
    "generated_root_ready",
    "development_source_missing",
    "personalspace_root_not_supported",
    "root_unrecognized",
    "root_path_unsafe",
    "root_probe_failed",
    "probe_failed",
  ]),
});

export function inspectLazurioInstallation({
  root = null,
  platform = process.platform,
  architecture = process.arch,
  bunVersion = process.versions.bun ?? null,
  bunExecutable = process.execPath,
  requiredBunVersion = readRequiredBunVersion(),
  requiredNodeVersionRange = readRequiredNodeVersionRange(),
  environment = process.env,
  homeDirectory = homedir(),
  resolveGit = resolveTrustedGitExecutable,
  resolveGitHubCli = resolveTrustedGitHubCliExecutable,
  resolveNode = resolveTrustedNodeExecutable,
  gitCandidatePaths = trustedGitCandidates,
  githubCliCandidatePaths = trustedGitHubCliCandidates,
  nodeCandidatePaths = trustedNodeCandidates,
  resolvePathCommand = resolveExecutableOnPath,
  sameExecutable = executablePathsMatch,
  runCommand = runCommandSync,
  inspectRoot = inspectRootLayout,
} = {}) {
  const steps = [];
  const commandCwd = trustedCommandCwd(platform, environment);

  steps.push(boundedProbe("platform", () => (
    supportedPlatforms.has(platform) && supportedArchitectures.has(architecture)
      ? completed("platform_supported")
      : actionRequired("platform_unsupported")
  )));

  const bunRuntime = classifyBunRuntime({
    currentVersion: bunVersion,
    requiredVersion: requiredBunVersion,
  });
  steps.push(boundedProbe("bun", () => {
    if (bunRuntime.status === "current") {
      const pathExecutable = resolvePathCommand("bun", { environment, platform, cwd: commandCwd });
      if (!pathExecutable) return actionRequired("bun_runtime_not_on_path");
      if (!sameExecutable(pathExecutable, bunExecutable, { platform })) {
        return actionRequired("bun_path_identity_mismatch");
      }
      const result = runCommand({
        executable: pathExecutable,
        args: ["--version"],
        environment,
        cwd: commandCwd,
      });
      const observedVersion = result?.stdout?.trim() || bunVersion;
      return result?.status === 0 && observedVersion === requiredBunVersion
        ? completed("bun_runtime_current")
        : failed("bun_path_unusable");
    }
    if (bunRuntime.status === "mismatch") return actionRequired("bun_runtime_mismatch");
    return failed("bun_runtime_unavailable");
  }));

  let gitExecutable = null;
  steps.push(boundedProbe("git", () => {
    const trustedExecutable = resolveGit({ platform, environment, homeDirectory });
    const pathExecutable = resolvePathCommand("git", { environment, platform, cwd: commandCwd });
    if (!pathExecutable) {
      return actionRequired(trustedExecutable ? "git_not_on_path" : "git_missing");
    }
    const candidates = gitCandidatePaths(platform, { homeDirectory, environment });
    if (!matchesTrustedExecutable(pathExecutable, trustedExecutable, candidates, sameExecutable, platform)) {
      return actionRequired("git_path_identity_mismatch");
    }
    gitExecutable = pathExecutable;
    return commandSucceeded(runCommand, pathExecutable, ["--version"], environment, commandCwd)
      ? completed("git_available")
      : failed("git_unusable");
  }));

  let githubCliExecutable = null;
  steps.push(boundedProbe("github_cli", () => {
    const trustedExecutable = resolveGitHubCli({ platform, environment, homeDirectory });
    const pathExecutable = resolvePathCommand("gh", { environment, platform, cwd: commandCwd });
    if (!pathExecutable) {
      githubCliExecutable = null;
      return actionRequired(trustedExecutable ? "github_cli_not_on_path" : "github_cli_missing");
    }
    const candidates = githubCliCandidatePaths(platform, { homeDirectory, environment });
    if (!matchesTrustedExecutable(pathExecutable, trustedExecutable, candidates, sameExecutable, platform)) {
      githubCliExecutable = null;
      return actionRequired("github_cli_path_identity_mismatch");
    }
    const result = runCommand({
      executable: pathExecutable,
      args: ["--version"],
      environment,
      cwd: commandCwd,
    });
    if (result?.status !== 0) {
      githubCliExecutable = null;
      return failed("github_cli_unusable");
    }
    githubCliExecutable = pathExecutable;
    return completed("github_cli_available");
  }));

  let nodeRuntime = Object.freeze({
    status: "unavailable",
    current_version: null,
    required_range: requiredNodeVersionRange,
  });
  steps.push(boundedProbe("node", () => {
    const trustedExecutable = resolveNode({ platform, environment, homeDirectory });
    const pathExecutable = resolvePathCommand("node", { environment, platform, cwd: commandCwd });
    if (!pathExecutable) {
      return actionRequired(trustedExecutable ? "node_runtime_not_on_path" : "node_runtime_missing");
    }
    const candidates = nodeCandidatePaths(platform, { homeDirectory, environment });
    if (!matchesTrustedExecutable(pathExecutable, trustedExecutable, candidates, sameExecutable, platform)) {
      return actionRequired("node_path_identity_mismatch");
    }
    const result = runCommand({
      executable: pathExecutable,
      args: ["--version"],
      environment,
      cwd: commandCwd,
    });
    const currentVersion = result?.status === 0 ? nodeVersionFromOutput(result.stdout) : null;
    if (!currentVersion) {
      nodeRuntime = Object.freeze({
        status: "unusable",
        current_version: null,
        required_range: requiredNodeVersionRange,
      });
      return failed("node_runtime_unusable");
    }
    nodeRuntime = classifyNodeRuntime({
      currentVersion,
      requiredRange: requiredNodeVersionRange,
    });
    return nodeRuntime.status === "compatible"
      ? completed("node_runtime_compatible")
      : actionRequired("node_runtime_incompatible");
  }));

  steps.push(boundedProbe("github_auth", () => {
    if (!githubCliExecutable) return skipped("github_cli_unavailable");
    if (!commandSucceeded(
      runCommand,
      githubCliExecutable,
      ["auth", "status", "--hostname", "github.com"],
      environment,
      commandCwd,
    )) {
      return actionRequired("github_login_required");
    }
    const protocol = runCommand({
      executable: githubCliExecutable,
      args: ["config", "get", "git_protocol", "--host", "github.com"],
      environment,
      cwd: commandCwd,
    });
    return protocol?.status === 0 && protocol.stdout?.trim().toLowerCase() === "ssh"
      ? completed("github_authenticated")
      : actionRequired("github_ssh_protocol_required");
  }));

  const effectiveRoot = root ?? canonicalLazurioRoot({
    platform,
    homeDirectory,
  });
  const rootObservation = boundedRootProbe(effectiveRoot, inspectRoot, {
    platform,
    environment,
    homeDirectory,
    gitExecutable,
  });
  steps.push(rootObservation.step);

  const summary = summarizeSteps(steps);
  const report = {
    schema_version: LAZURIO_INSTALL_REPORT_SCHEMA,
    mode: INSTALL_MODE,
    status: summary.status,
    machine: {
      platform,
      architecture,
      bun: bunRuntime,
      node: nodeRuntime,
    },
    root: rootObservation.root,
    steps,
    summary,
  };
  if (!isValidLazurioInstallReport(report)) {
    throw new Error("Install Core produced an invalid report.");
  }
  return report;
}

export function canonicalLazurioRoot({
  platform = process.platform,
  homeDirectory = homedir(),
} = {}) {
  const pathApi = platform === "win32" ? win32 : posix;
  if (
    typeof homeDirectory !== "string"
    || homeDirectory === ""
    || homeDirectory.includes("\n")
    || homeDirectory.includes("\r")
    || !pathApi.isAbsolute(homeDirectory)
  ) {
    throw new Error("Lazurio canonical Root requires an absolute machine home directory.");
  }
  return pathApi.join(pathApi.normalize(homeDirectory), "Lazurio");
}

export function isValidLazurioInstallReport(value) {
  if (!plainObject(value)) return false;
  if (value.schema_version !== LAZURIO_INSTALL_REPORT_SCHEMA || value.mode !== INSTALL_MODE) return false;
  if (!new Set(["completed", "action_required", "failed"]).has(value.status)) return false;
  if (!plainObject(value.machine)) return false;
  if (typeof value.machine.platform !== "string" || value.machine.platform === "") return false;
  if (typeof value.machine.architecture !== "string" || value.machine.architecture === "") return false;
  if (!validBunRuntime(value.machine.bun)) return false;
  if (!validNodeRuntime(value.machine.node)) return false;
  if (!validRoot(value.root)) return false;
  if (!Array.isArray(value.steps) || value.steps.length !== INSTALL_STEP_IDS.length) return false;
  for (let index = 0; index < INSTALL_STEP_IDS.length; index += 1) {
    const step = value.steps[index];
    const expectedId = INSTALL_STEP_IDS[index];
    if (!plainObject(step) || step.id !== expectedId) return false;
    if (!INSTALL_STEP_STATUSES.includes(step.status)) return false;
    if (!reasonsByStep[expectedId].has(step.reason)) return false;
    if (Object.keys(step).sort().join(",") !== "id,reason,status") return false;
  }
  if (!validSummary(value.summary, value.steps)) return false;
  return value.status === value.summary.status;
}

function validBunRuntime(value) {
  if (!plainObject(value)) return false;
  if (!new Set(["current", "mismatch", "unavailable"]).has(value.status)) return false;
  if (!/^\d+\.\d+\.\d+$/u.test(value.required_version ?? "")) return false;
  if (value.status === "unavailable") return value.current_version === null;
  if (!/^\d+\.\d+\.\d+$/u.test(value.current_version ?? "")) return false;
  return value.status === (value.current_version === value.required_version ? "current" : "mismatch");
}

function validNodeRuntime(value) {
  if (!plainObject(value)) return false;
  if (!new Set(["compatible", "incompatible", "unavailable", "unusable"]).has(value.status)) return false;
  if (!/^>=(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u.test(value.required_range ?? "")) {
    return false;
  }
  if (value.status === "unavailable" || value.status === "unusable") {
    return value.current_version === null;
  }
  const classified = classifyNodeRuntime({
    currentVersion: value.current_version,
    requiredRange: value.required_range,
  });
  return classified.status === value.status;
}

export function installExitCode(report) {
  if (!isValidLazurioInstallReport(report)) return 2;
  if (report.status === "completed") return 0;
  if (report.status === "action_required") return 1;
  return 2;
}

export function installReasonCodes() {
  return Object.freeze([...new Set(Object.values(reasonsByStep).flatMap((reasons) => [...reasons]))].sort());
}

function boundedProbe(id, probe) {
  try {
    return { id, ...probe() };
  } catch {
    return { id, status: "failed", reason: "probe_failed" };
  }
}

function matchesTrustedExecutable(pathExecutable, trustedExecutable, candidates, sameExecutable, platform) {
  return (
    (trustedExecutable && sameExecutable(pathExecutable, trustedExecutable, { platform }))
    || candidates.some((candidate) => sameExecutable(pathExecutable, candidate, { platform }))
  );
}

function boundedRootProbe(root, inspectRoot, context) {
  try {
    const observation = inspectRoot(root, context);
    return {
      step: { id: "root", status: observation.status, reason: observation.reason },
      root: {
        selected: true,
        path: observation.path,
        layout: observation.layout,
      },
    };
  } catch {
    return {
      step: { id: "root", status: "failed", reason: "root_probe_failed" },
      root: { selected: true, path: resolve(root), layout: "unsafe" },
    };
  }
}

function inspectRootLayout(rawRoot, {
  platform = process.platform,
  environment = process.env,
  homeDirectory = homedir(),
  gitExecutable = null,
} = {}) {
  const selectedPath = resolve(rawRoot);
  let marker;
  try {
    marker = lstatSync(selectedPath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return rootResult(selectedPath, "missing", "action_required", "root_creation_required");
    }
    throw error;
  }
  if (marker.isSymbolicLink() || !marker.isDirectory()) {
    return rootResult(selectedPath, "unsafe", "failed", "root_path_unsafe");
  }

  const canonicalRoot = realpathSync.native(selectedPath);
  const entries = new Set(
    readdirSync(canonicalRoot).filter((name) => !ignoredEmptyRootEntries.has(name)),
  );
  if (entries.size === 0) {
    return rootResult(canonicalRoot, "empty", "action_required", "root_creation_required");
  }
  const hasLaunchpadManifest = entries.has("launchpad.gen3.json");
  const hasPersonalspaceManifest = entries.has("personal.gen3.json");
  if (hasLaunchpadManifest && hasPersonalspaceManifest) {
    return rootResult(canonicalRoot, "unrecognized", "action_required", "root_unrecognized");
  }
  if (hasPersonalspaceManifest) {
    return rootResult(canonicalRoot, "personalspace", "action_required", "personalspace_root_not_supported");
  }
  if (!hasLaunchpadManifest || !validLaunchpadRootMarker(join(canonicalRoot, "launchpad.gen3.json"))) {
    return rootResult(canonicalRoot, "unrecognized", "action_required", "root_unrecognized");
  }
  if (entries.has(".git")) {
    if (!safeEntry(join(canonicalRoot, ".git"))) {
      return rootResult(canonicalRoot, "unsafe", "failed", "root_path_unsafe");
    }
    if (!isDirectChildOfHome(canonicalRoot, homeDirectory, platform)) {
      return rootResult(canonicalRoot, "source_root", "action_required", "source_root_unverified");
    }
    if (!validGitCheckout({
      sourceRoot: canonicalRoot,
      platform,
      environment,
      gitExecutable,
    })) {
      return rootResult(canonicalRoot, "source_root", "action_required", "source_root_unverified");
    }
    return rootResult(canonicalRoot, "source_root", "completed", "source_root_ready");
  }

  const developmentRoot = join(canonicalRoot, "development");
  const sourceRoot = join(developmentRoot, "Lazurio");
  if (
    !safeDirectory(developmentRoot)
    || !safeDirectory(sourceRoot)
    || !safeEntry(join(sourceRoot, ".git"))
    || !validGitCheckout({
      sourceRoot,
      platform,
      environment,
      gitExecutable,
    })
  ) {
    return rootResult(
      canonicalRoot,
      "incomplete_generated_root",
      "action_required",
      "development_source_missing",
    );
  }
  return rootResult(canonicalRoot, "generated_root", "completed", "generated_root_ready");
}

function isDirectChildOfHome(root, homeDirectory, platform) {
  let canonicalHome;
  try {
    canonicalHome = realpathSync.native(homeDirectory);
  } catch {
    return false;
  }
  const parent = dirname(root);
  return platform === "win32"
    ? win32.normalize(parent).toLowerCase() === win32.normalize(canonicalHome).toLowerCase()
    : posix.normalize(parent) === posix.normalize(canonicalHome);
}

function summarizeSteps(steps) {
  const counts = Object.fromEntries(INSTALL_STEP_STATUSES.map((status) => [status, 0]));
  for (const step of steps) counts[step.status] += 1;
  const status = counts.failed > 0
    ? "failed"
    : counts.action_required > 0
      ? "action_required"
      : "completed";
  return { status, counts };
}

function validSummary(summary, steps) {
  if (!plainObject(summary) || !plainObject(summary.counts)) return false;
  if (!new Set(["completed", "action_required", "failed"]).has(summary.status)) return false;
  const expected = summarizeSteps(steps);
  return summary.status === expected.status
    && INSTALL_STEP_STATUSES.every((status) => summary.counts[status] === expected.counts[status])
    && Object.keys(summary.counts).sort().join(",") === [...INSTALL_STEP_STATUSES].sort().join(",");
}

function validRoot(root) {
  if (!plainObject(root) || typeof root.selected !== "boolean" || !rootLayouts.has(root.layout)) return false;
  return root.selected === true && typeof root.path === "string" && root.path !== "";
}

function rootResult(path, layout, status, reason) {
  return { path, layout, status, reason };
}

function safeDirectory(path) {
  try {
    const entry = lstatSync(path);
    return entry.isDirectory() && !entry.isSymbolicLink();
  } catch {
    return false;
  }
}

function safeEntry(path) {
  try {
    const entry = lstatSync(path);
    return !entry.isSymbolicLink() && (entry.isDirectory() || entry.isFile());
  } catch {
    return false;
  }
}

function validLaunchpadRootMarker(path) {
  try {
    const entry = lstatSync(path);
    if (!entry.isFile() || entry.isSymbolicLink()) return false;
    const manifest = JSON.parse(readFileSync(path, "utf8"));
    return plainObject(manifest)
      && manifest.workspace_generation === "gen3"
      && validMountpoint(manifest.organization_mountpoint)
      && validMountpoint(manifest.personalspace_mountpoint)
      && plainObject(manifest.launchpad_root)
      && manifest.launchpad_root.root_role === "launchpad-root";
  } catch {
    return false;
  }
}

function validMountpoint(value) {
  return typeof value === "string"
    && /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value);
}

function validGitCheckout({
  sourceRoot,
  platform,
  environment,
  gitExecutable,
}) {
  if (!gitExecutable) return false;
  const provenance = buildLazurioCliProvenance({
    root: sourceRoot,
    platform,
    environment: sanitizedGitEnvironment(environment, platform),
    gitExecutable,
  });
  return provenance.status === "resolved"
    && provenance.root_kind === "source"
    && provenance.source.dirty === false
    && provenance.source.repository?.toLowerCase()
    === LAZURIO_SOURCE_REPOSITORY.toLowerCase()
    && validLazurioSourceTree(sourceRoot, gitExecutable, environment, platform);
}

function validLazurioSourceTree(sourceRoot, gitExecutable, environment, platform) {
  const gitEnvironment = sanitizedGitEnvironment(environment, platform);
  const rootPackageResult = runCommandSync({
    executable: gitExecutable,
    args: ["show", "HEAD:package.json"],
    environment: gitEnvironment,
    cwd: sourceRoot,
  });
  if (rootPackageResult.status !== 0) return false;

  const runtimePackageResult = runCommandSync({
    executable: gitExecutable,
    args: ["show", "HEAD:lazurio/package.json"],
    environment: gitEnvironment,
    cwd: sourceRoot,
  });
  if (runtimePackageResult.status !== 0) return false;

  let rootManifest;
  let runtimeManifest;
  try {
    rootManifest = JSON.parse(rootPackageResult.stdout);
    runtimeManifest = JSON.parse(runtimePackageResult.stdout);
  } catch {
    return false;
  }
  if (
    !plainObject(rootManifest)
    || rootManifest.name !== "lazurio"
    || rootManifest.private !== true
    || !Array.isArray(rootManifest.workspaces)
    || !rootManifest.workspaces.includes("lazurio")
    || !plainObject(runtimeManifest)
    || !plainObject(runtimeManifest.bin)
    || runtimeManifest.bin.lazurio !== "cli.mjs"
    || runtimeManifest.repository?.directory !== "lazurio"
  ) {
    return false;
  }

  return ["lazurio/cli.mjs", "launchpad/package.json"].every((path) => (
    commandSucceeded(
      runCommandSync,
      gitExecutable,
      ["cat-file", "-e", `HEAD:${path}`],
      gitEnvironment,
      sourceRoot,
    )
  ));
}

function runCommandSync({ executable, args, environment, cwd }) {
  return spawnSync(executable, args, {
    cwd,
    encoding: "utf8",
    env: environment,
    shell: false,
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 10_000,
    windowsHide: true,
  });
}

function commandSucceeded(runCommand, executable, args, environment, cwd) {
  const result = runCommand({ executable, args, environment, cwd });
  return result?.status === 0;
}

function trustedCommandCwd(platform, environment) {
  if (platform !== "win32") return "/";
  const systemRoot = environment.SystemRoot;
  if (typeof systemRoot === "string" && win32.isAbsolute(systemRoot)) {
    return win32.join(systemRoot, "System32");
  }
  return "C:\\Windows\\System32";
}

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function completed(reason) {
  return { status: "completed", reason };
}

function skipped(reason) {
  return { status: "skipped", reason };
}

function actionRequired(reason) {
  return { status: "action_required", reason };
}

function failed(reason) {
  return { status: "failed", reason };
}
