import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  assertCanonicalInstallBoundary,
  assertProductionClosure,
  parseNpmPackDescriptor,
  validateLazurioPackageManifest,
} from "./npm-package-lib.mjs";
import { inspectLazurioInstallation, installExitCode } from "../lazurio/core/install-core-lib.mjs";

const repositoryRoot = resolve(import.meta.dirname, "..");

test("private workspace root delegates every publishable field to @lazurio/runtime", () => {
  const sourcePackage = JSON.parse(readFileSync(resolve(repositoryRoot, "package.json"), "utf8"));
  const cliPackage = JSON.parse(readFileSync(resolve(repositoryRoot, "lazurio", "package.json"), "utf8"));
  expect(sourcePackage).toMatchObject({ name: "lazurio", private: true });
  expect(sourcePackage.workspaces).toEqual(expect.arrayContaining(["lazurio", "launchpad"]));
  expect(sourcePackage.packageManager).toBeUndefined();
  expect(sourcePackage.bin).toBeUndefined();
  expect(validateLazurioPackageManifest(cliPackage)).toEqual({
    bunVersion: "1.4.1",
    version: "0.0.0-development",
  });
});

test("npm pack descriptor accepts the scoped package identity", () => {
  expect(parseNpmPackDescriptor(JSON.stringify([{
    name: "@lazurio/runtime",
    version: "0.1.0",
    filename: "lazurio-cli-0.1.0.tgz",
    files: [{ path: "package.json", size: 100, mode: 420 }],
  }]))).toMatchObject({ name: "@lazurio/runtime", version: "0.1.0" });
  expect(() => parseNpmPackDescriptor(JSON.stringify([{
    name: "lazurio",
    version: "0.1.0",
    filename: "lazurio-0.1.0.tgz",
    files: [{ path: "package.json" }],
  }]))).toThrow("incomplete @lazurio/runtime descriptor");
});

test("production closure rejects source imports outside the publishable package", () => {
  expect(() => assertProductionClosure({
    packageRoot: "/fixture/lazurio",
    entries: new Map([
      ["cli.mjs", { bytes: Buffer.from('import "../launchpad/src/runtime-lib.mjs";\n') }],
    ]),
  })).toThrow("outside @lazurio/runtime");
  expect(() => assertProductionClosure({
    packageRoot: "/fixture/lazurio",
    entries: new Map([
      ["cli.mjs", { bytes: Buffer.from('import "./runtime/missing.mjs";\n') }],
    ]),
  })).toThrow("unpacked production content");
  expect(() => assertProductionClosure({
    packageRoot: "/fixture/lazurio",
    entries: new Map([
      ["cli.mjs", { bytes: Buffer.from('import "./runtime/current.mjs";\n') }],
      ["runtime/current.mjs", { bytes: Buffer.from("export const current = true;\n") }],
    ]),
  })).not.toThrow();
});

test("package smoke keeps canonical home Root deterministic across host prerequisite states", () => {
  const actionRequired = inspectLazurioInstallation({
    root: null,
    platform: "linux",
    architecture: "x64",
    bunVersion: "1.4.1",
    environment: { HOME: "/home/example" },
    homeDirectory: "/home/example",
    resolveGit: () => null,
    resolveGitHubCli: () => null,
    inspectRoot: missingRootObservation,
  });
  const failedHostProbe = inspectLazurioInstallation({
    root: null,
    platform: "win32",
    architecture: "x64",
    bunVersion: "1.4.1",
    environment: { USERPROFILE: "C:\\Users\\Example", SystemRoot: "C:\\Windows" },
    homeDirectory: "C:\\Users\\Example",
    resolveGit: () => "C:\\Program Files\\Git\\cmd\\git.exe",
    resolveGitHubCli: () => "C:\\Program Files\\GitHub CLI\\gh.exe",
    resolvePathCommand: (command) => ({
      bun: "C:\\Users\\Example\\.bun\\bin\\bun.exe",
      git: "C:\\Program Files\\Git\\cmd\\git.exe",
      gh: "C:\\Program Files\\GitHub CLI\\gh.exe",
    })[command] ?? null,
    runCommand: ({ executable }) => ({
      status: executable.endsWith("gh.exe") ? 1 : 0,
    }),
    inspectRoot: missingRootObservation,
  });

  expect(actionRequired.status).toBe("action_required");
  expect(failedHostProbe.status).toBe("failed");
  expect(() => assertCanonicalInstallBoundary({
    report: actionRequired,
    exitStatus: installExitCode(actionRequired),
    canonicalRoot: "/home/example/Lazurio",
  })).not.toThrow();
  expect(() => assertCanonicalInstallBoundary({
    report: failedHostProbe,
    exitStatus: installExitCode(failedHostProbe),
    canonicalRoot: "C:\\Users\\Example\\Lazurio",
  })).not.toThrow();
});

test("package smoke rejects a non-canonical Root", () => {
  const report = inspectLazurioInstallation({
    root: "/fixture/root",
    platform: "linux",
    architecture: "x64",
    bunVersion: "1.4.1",
    resolveGit: () => null,
    resolveGitHubCli: () => null,
    inspectRoot: () => ({
      path: "/fixture/root",
      layout: "generated_root",
      status: "completed",
      reason: "generated_root_ready",
    }),
  });

  expect(() => assertCanonicalInstallBoundary({
    report,
    exitStatus: installExitCode(report),
    canonicalRoot: "/home/example/Lazurio",
  })).toThrow("did not use the canonical home Root");
});

function missingRootObservation(path) {
  return {
    path,
    layout: "missing",
    status: "action_required",
    reason: "root_creation_required",
  };
}
