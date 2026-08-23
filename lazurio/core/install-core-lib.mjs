import { spawnSync } from "node:child_process";
import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { join, resolve, win32 } from "node:path";

import {
  buildLazurioCliProvenance,
  LAZURIO_SOURCE_REPOSITORY,
  resolveTrustedGitExecutable,
  resolveTrustedGitHubCliExecutable,
  sanitizedGitEnvironment,
} from "./cli-provenance-lib.mjs";

export const LAZURIO_INSTALL_REPORT_SCHEMA = "lazurio.install.report.v0";
export const INSTALL_MODE = "report";
export const INSTALL_STEP_IDS = Object.freeze([
  "platform",
  "bun",
  "git",
  "github_cli",
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
  "not_selected",
  "missing",
  "empty",
  "legacy_git_root",
  "generated_root",
  "incomplete_generated_root",
  "personalspace",
  "unrecognized",
  "unsafe",
]);
const reasonsByStep = Object.freeze({
  platform: new Set(["platform_supported", "platform_unsupported", "probe_failed"]),
  bun: new Set(["bun_runtime_available", "bun_runtime_unavailable", "probe_failed"]),
  git: new Set(["git_available", "git_missing", "git_unusable", "probe_failed"]),
  github_cli: new Set(["github_cli_available", "github_cli_missing", "github_cli_unusable", "probe_failed"]),
  github_auth: new Set(["github_authenticated", "github_login_required", "github_cli_unavailable", "probe_failed"]),
  root: new Set([
    "root_selection_required",
    "root_creation_required",
    "legacy_git_root_detected",
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
  environment = process.env,
  resolveGit = resolveTrustedGitExecutable,
  resolveGitHubCli = resolveTrustedGitHubCliExecutable,
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

  steps.push(boundedProbe("bun", () => (
    typeof bunVersion === "string" && bunVersion.length > 0
      ? completed("bun_runtime_available")
      : failed("bun_runtime_unavailable")
  )));

  let gitExecutable = null;
  steps.push(boundedProbe("git", () => {
    gitExecutable = resolveGit({ platform, environment });
    if (!gitExecutable) return actionRequired("git_missing");
    return commandSucceeded(runCommand, gitExecutable, ["--version"], environment, commandCwd)
      ? completed("git_available")
      : failed("git_unusable");
  }));

  let githubCliExecutable = null;
  steps.push(boundedProbe("github_cli", () => {
    githubCliExecutable = resolveGitHubCli({ platform, environment });
    if (!githubCliExecutable) return actionRequired("github_cli_missing");
    const result = runCommand({
      executable: githubCliExecutable,
      args: ["--version"],
      environment,
      cwd: commandCwd,
    });
    if (result?.status !== 0) return failed("github_cli_unusable");
    return completed("github_cli_available");
  }));

  steps.push(boundedProbe("github_auth", () => {
    if (!githubCliExecutable) return skipped("github_cli_unavailable");
    return commandSucceeded(
      runCommand,
      githubCliExecutable,
      ["auth", "status", "--hostname", "github.com"],
      environment,
      commandCwd,
    )
      ? completed("github_authenticated")
      : actionRequired("github_login_required");
  }));

  const rootObservation = boundedRootProbe(root, inspectRoot, {
    platform,
    environment,
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

export function isValidLazurioInstallReport(value) {
  if (!plainObject(value)) return false;
  if (value.schema_version !== LAZURIO_INSTALL_REPORT_SCHEMA || value.mode !== INSTALL_MODE) return false;
  if (!new Set(["completed", "action_required", "failed"]).has(value.status)) return false;
  if (!plainObject(value.machine)) return false;
  if (typeof value.machine.platform !== "string" || value.machine.platform === "") return false;
  if (typeof value.machine.architecture !== "string" || value.machine.architecture === "") return false;
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

function boundedRootProbe(root, inspectRoot, context) {
  if (root === null) {
    return {
      step: { id: "root", status: "action_required", reason: "root_selection_required" },
      root: { selected: false, path: null, layout: "not_selected" },
    };
  }
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
    return rootResult(canonicalRoot, "legacy_git_root", "action_required", "legacy_git_root_detected");
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
  if (root.selected) {
    return typeof root.path === "string" && root.path !== "" && root.layout !== "not_selected";
  }
  return root.path === null && root.layout === "not_selected";
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
    && provenance.source.repository?.toLowerCase()
    === LAZURIO_SOURCE_REPOSITORY.toLowerCase()
    && validLazurioSourceTree(sourceRoot, gitExecutable, environment, platform);
}

function validLazurioSourceTree(sourceRoot, gitExecutable, environment, platform) {
  const gitEnvironment = sanitizedGitEnvironment(environment, platform);
  const packageResult = runCommandSync({
    executable: gitExecutable,
    args: ["show", "HEAD:package.json"],
    environment: gitEnvironment,
    cwd: sourceRoot,
  });
  if (packageResult.status !== 0) return false;

  let manifest;
  try {
    manifest = JSON.parse(packageResult.stdout);
  } catch {
    return false;
  }
  if (
    !plainObject(manifest)
    || manifest.name !== "lazurio"
    || !plainObject(manifest.bin)
    || manifest.bin.lazurio !== "lazurio/cli.mjs"
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
