import { afterAll, expect, test } from "bun:test";
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
    runCommand: ({ executable, args }) => {
      invoked.push([executable, ...args].join(" "));
      if (executable === "gh" && args[0] === "--version") return { status: 0 };
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
  expect(invoked).toEqual(["gh --version", "gh auth status --hostname github.com"]);
  expect(installExitCode(report)).toBe(2);
  expect(JSON.stringify(report)).not.toContain("CANARY");
});

test("supported complete fixture exits zero with all probes completed", () => {
  const commandCwds = [];
  const report = inspectLazurioInstallation({
    root: "/fixture/root",
    platform: "win32",
    architecture: "x64",
    bunVersion: "1.3.14",
    resolveGit: () => "C:\\Program Files\\Git\\cmd\\git.exe",
    environment: { SystemRoot: "C:\\Windows" },
    runCommand: ({ cwd }) => {
      commandCwds.push(cwd);
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
  expect(commandCwds).toEqual([
    "C:\\Windows\\System32",
    "C:\\Windows\\System32",
    "C:\\Windows\\System32",
  ]);
});

test("real Root probe distinguishes missing, legacy and generated layouts", async () => {
  const parent = await trackedTempRoot("lazurio-install-root-");
  const missing = join(parent, "missing");
  const legacy = join(parent, "legacy");
  const generated = join(parent, "generated");
  const finderEmpty = join(parent, "finder-empty");
  await mkdir(join(legacy, ".git"), { recursive: true });
  await writeFile(join(legacy, "launchpad.gen3.json"), "{}\n", "utf8");
  await mkdir(join(generated, "development", "Lazurio", ".git"), { recursive: true });
  await writeFile(join(generated, "launchpad.gen3.json"), "{}\n", "utf8");
  await mkdir(finderEmpty, { recursive: true });
  await writeFile(join(finderEmpty, ".DS_Store"), "finder metadata", "utf8");

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
});

function fixtureReport() {
  return inspectLazurioInstallation({
    root: null,
    platform: "darwin",
    architecture: "arm64",
    bunVersion: "1.3.14",
    resolveGit: () => "/usr/bin/git",
    runCommand: ({ executable }) => executable === "gh"
      ? { status: null, error: { code: "ENOENT" }, stdout: "CANARY_STDOUT", stderr: "CANARY_STDERR" }
      : { status: 0 },
  });
}

function rootStep(root) {
  return inspectLazurioInstallation({
    root,
    resolveGit: () => "/usr/bin/git",
    runCommand: () => ({ status: 0 }),
  }).steps.find((step) => step.id === "root");
}

async function trackedTempRoot(prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}
