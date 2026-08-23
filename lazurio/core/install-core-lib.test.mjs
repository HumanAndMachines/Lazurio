import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { validateAgainstSchema } from "../../launchpad/src/json-schema-mini.mjs";
import schema from "../install-report.v0.schema.json";
import {
  INSTALL_STEP_IDS,
  inspectLazurioInstallation,
  installExitCode,
  installReasonCodes,
  isValidLazurioInstallReport,
} from "./install-core-lib.mjs";
import { resolveTrustedGitExecutable } from "./cli-provenance-lib.mjs";

const tempRoots = [];

afterAll(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
});

test("Install Core returns one deterministic locale-neutral report", () => {
  const report = fixtureReport();

  expect(report).toEqual(fixtureReport());
  expect(report.steps.map((step) => step.id)).toEqual(INSTALL_STEP_IDS);
  expect(report.status).toBe("action_required");
  expect(report.steps.find((step) => step.id === "github_auth")).toEqual({
    id: "github_auth",
    status: "skipped",
    reason: "github_cli_unavailable",
  });
  expect(report.summary).toEqual({
    status: "action_required",
    counts: { completed: 3, skipped: 1, action_required: 2, failed: 0 },
  });
  expect(isValidLazurioInstallReport(report)).toBe(true);
  expect(validateAgainstSchema(report, schema, "install")).toEqual([]);
  expect(installExitCode(report)).toBe(1);
  expect(JSON.stringify(report)).not.toContain("CANARY_STDERR");
  expect(JSON.stringify(report)).not.toContain("CANARY_STDOUT");
});

test("public schema pins the same ordered steps and reason-code vocabulary", () => {
  expect(schema.properties.steps.prefixItems.map((entry) => entry.properties.id.const)).toEqual(
    INSTALL_STEP_IDS,
  );
  expect(schema.properties.steps.items.properties.reason.enum.toSorted()).toEqual(
    installReasonCodes(),
  );
});

test("independent probes continue after a bounded failure", () => {
  const invoked = [];
  const report = inspectLazurioInstallation({
    root: null,
    platform: "linux",
    architecture: "x64",
    bunVersion: "1.3.14",
    resolveGit: () => {
      throw new Error("CANARY_GIT_FAILURE");
    },
    resolveGitHubCli: () => "/trusted/bin/gh",
    runCommand: ({ executable, args }) => {
      invoked.push([executable, ...args].join(" "));
      if (executable === "/trusted/bin/gh" && args[0] === "--version") return { status: 0 };
      return { status: 1, stdout: "CANARY_STDOUT", stderr: "CANARY_STDERR" };
    },
  });

  expect(report.status).toBe("failed");
  expect(report.steps.find((step) => step.id === "git")).toMatchObject({
    status: "failed",
    reason: "probe_failed",
  });
  expect(report.steps.find((step) => step.id === "github_cli").status).toBe("completed");
  expect(report.steps.find((step) => step.id === "github_auth").reason).toBe("github_login_required");
  expect(invoked).toEqual([
    "/trusted/bin/gh --version",
    "/trusted/bin/gh auth status --hostname github.com",
  ]);
  expect(installExitCode(report)).toBe(2);
  expect(JSON.stringify(report)).not.toContain("CANARY");
});

test("supported complete fixture exits zero with all probes completed", () => {
  const commands = [];
  const report = inspectLazurioInstallation({
    root: "/fixture/root",
    platform: "win32",
    architecture: "x64",
    bunVersion: "1.3.14",
    resolveGit: () => "C:\\Program Files\\Git\\cmd\\git.exe",
    resolveGitHubCli: () => "C:\\Program Files\\GitHub CLI\\gh.exe",
    environment: { SystemRoot: "C:\\Windows" },
    runCommand: ({ executable, cwd }) => {
      commands.push({ executable, cwd });
      return { status: 0 };
    },
    inspectRoot: () => ({
      path: "C:\\Lazurio",
      layout: "generated_root",
      status: "completed",
      reason: "generated_root_ready",
    }),
  });

  expect(report.status).toBe("completed");
  expect(report.summary.counts).toEqual({
    completed: 6,
    skipped: 0,
    action_required: 0,
    failed: 0,
  });
  expect(installExitCode(report)).toBe(0);
  expect(isValidLazurioInstallReport(report)).toBe(true);
  expect(commands).toEqual([
    { executable: "C:\\Program Files\\Git\\cmd\\git.exe", cwd: "C:\\Windows\\System32" },
    { executable: "C:\\Program Files\\GitHub CLI\\gh.exe", cwd: "C:\\Windows\\System32" },
    { executable: "C:\\Program Files\\GitHub CLI\\gh.exe", cwd: "C:\\Windows\\System32" },
  ]);
});

test("GitHub probes never execute an ambient PATH shadow", () => {
  const executables = [];
  const report = inspectLazurioInstallation({
    root: null,
    platform: "linux",
    environment: { PATH: "/tmp/untrusted-shadow" },
    resolveGit: () => "/usr/bin/git",
    resolveGitHubCli: () => "/usr/bin/gh",
    runCommand: ({ executable }) => {
      executables.push(executable);
      return { status: 0 };
    },
  });

  expect(report.steps.find((step) => step.id === "github_cli")).toMatchObject({
    status: "completed",
    reason: "github_cli_available",
  });
  expect(executables).toEqual(["/usr/bin/git", "/usr/bin/gh", "/usr/bin/gh"]);
  expect(executables).not.toContain("gh");
});

test("real Root probe distinguishes missing, legacy and generated layouts", async () => {
  const parent = await trackedTempRoot("lazurio-install-root-");
  const missing = join(parent, "missing");
  const legacy = join(parent, "legacy");
  const generated = join(parent, "generated");
  const finderEmpty = join(parent, "finder-empty");
  const ambiguous = join(parent, "ambiguous");
  const invalidManifest = join(parent, "invalid-manifest");
  const staleSource = join(parent, "stale-source");
  await mkdir(join(legacy, ".git"), { recursive: true });
  await writeLaunchpadManifest(legacy);
  await mkdir(join(generated, "development", "Lazurio", ".git"), { recursive: true });
  await writeLaunchpadManifest(generated);
  await mkdir(finderEmpty, { recursive: true });
  await writeFile(join(finderEmpty, ".DS_Store"), "finder metadata", "utf8");
  await mkdir(join(ambiguous, "development", "Lazurio", ".git"), { recursive: true });
  await writeLaunchpadManifest(ambiguous);
  await writeFile(join(ambiguous, "personal.gen3.json"), "{}\n", "utf8");
  await mkdir(join(invalidManifest, "development", "Lazurio", ".git"), { recursive: true });
  await writeFile(join(invalidManifest, "launchpad.gen3.json"), "{}\n", "utf8");
  await mkdir(join(staleSource, "development", "Lazurio", ".git"), { recursive: true });
  await writeLaunchpadManifest(staleSource);

  expect(rootStep(missing)).toMatchObject({
    status: "action_required",
    reason: "root_creation_required",
  });
  expect(rootStep(legacy)).toMatchObject({
    status: "action_required",
    reason: "legacy_git_root_detected",
  });
  expect(rootStep(generated)).toMatchObject({
    status: "completed",
    reason: "generated_root_ready",
  });
  expect(rootStep(finderEmpty)).toMatchObject({
    status: "action_required",
    reason: "root_creation_required",
  });
  expect(rootStep(ambiguous)).toMatchObject({
    status: "action_required",
    reason: "root_unrecognized",
  });
  expect(rootStep(invalidManifest)).toMatchObject({
    status: "action_required",
    reason: "root_unrecognized",
  });
  expect(rootStep(staleSource, { gitCheckoutReady: false })).toMatchObject({
    status: "action_required",
    reason: "development_source_missing",
  });
});

test("ambient Git repository overrides cannot validate a bogus development checkout", async () => {
  const parent = await trackedTempRoot("lazurio-install-git-environment-");
  const ambientRepository = join(parent, "ambient-repository");
  const generated = join(parent, "generated");
  const sourceRoot = join(generated, "development", "Lazurio");
  const gitExecutable = resolveTrustedGitExecutable();
  expect(gitExecutable).not.toBeNull();

  await mkdir(ambientRepository, { recursive: true });
  const init = spawnSync(gitExecutable, ["init"], {
    cwd: ambientRepository,
    encoding: "utf8",
    env: environmentWithoutGitOverrides(),
    shell: false,
    windowsHide: true,
  });
  expect(init.status, init.stderr).toBe(0);

  await mkdir(sourceRoot, { recursive: true });
  await writeFile(join(sourceRoot, ".git"), "not a git directory\n", "utf8");
  await writeLaunchpadManifest(generated);
  const observedGitEnvironments = [];
  const poisonedEnvironment = {
    ...environmentWithoutGitOverrides(),
    GIT_DIR: join(ambientRepository, ".git"),
  };
  const report = inspectLazurioInstallation({
    root: generated,
    environment: poisonedEnvironment,
    resolveGit: () => gitExecutable,
    resolveGitHubCli: () => null,
    runCommand: ({ executable, args, environment, cwd }) => {
      if (args.includes("rev-parse")) observedGitEnvironments.push(environment);
      return spawnSync(executable, args, {
        cwd,
        encoding: "utf8",
        env: environment,
        shell: false,
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 10_000,
        windowsHide: true,
      });
    },
  });

  expect(report.steps.find((step) => step.id === "root")).toMatchObject({
    status: "action_required",
    reason: "development_source_missing",
  });
  expect(observedGitEnvironments).toHaveLength(1);
  expect(observedGitEnvironments[0].GIT_DIR).toBeUndefined();
});

function fixtureReport() {
  return inspectLazurioInstallation({
    root: null,
    platform: "darwin",
    architecture: "arm64",
    bunVersion: "1.3.14",
    resolveGit: () => "/usr/bin/git",
    resolveGitHubCli: () => null,
    runCommand: () => ({ status: 0, stdout: "CANARY_STDOUT", stderr: "CANARY_STDERR" }),
  });
}

function rootStep(root, { gitCheckoutReady = true } = {}) {
  return inspectLazurioInstallation({
    root,
    resolveGit: () => "/usr/bin/git",
    resolveGitHubCli: () => "/usr/bin/gh",
    runCommand: ({ executable, args }) => {
      if (executable === "/usr/bin/git" && args[0] === "-C") {
        return {
          status: gitCheckoutReady ? 0 : 1,
          stdout: gitCheckoutReady ? `${args[1]}\n` : "",
        };
      }
      return { status: 0 };
    },
  }).steps.find((step) => step.id === "root");
}

async function writeLaunchpadManifest(root) {
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "launchpad.gen3.json"), `${JSON.stringify({
    workspace_generation: "gen3",
    organization_mountpoint: "organizations",
    personalspace_mountpoint: "personalspace",
    launchpad_root: { root_role: "launchpad-root" },
  }, null, 2)}\n`, "utf8");
}

async function trackedTempRoot(prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

function environmentWithoutGitOverrides() {
  return Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
  );
}
