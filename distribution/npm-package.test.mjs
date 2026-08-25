import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  assertRootlessInstallBoundary,
  packageContentForParity,
  packageEvidenceForReport,
} from "./npm-package-lib.mjs";
import { inspectLazurioInstallation, installExitCode } from "../lazurio/core/install-core-lib.mjs";

const repositoryRoot = resolve(import.meta.dirname, "..");

test("source package remains private while generated package contract is platform-neutral", () => {
  const sourcePackage = JSON.parse(readFileSync(resolve(repositoryRoot, "package.json"), "utf8"));
  const contract = JSON.parse(readFileSync(resolve(import.meta.dirname, "npm-package-contract.v1.json"), "utf8"));
  expect(sourcePackage).toMatchObject({ name: "lazurio", private: true });
  expect(sourcePackage.version).toBeUndefined();
  expect(contract).toMatchObject({
    schema_version: "lazurio.cli.npm-package-contract.v1",
    package_name: "lazurio",
    source_repository: "HumanAndMachines/Lazurio",
    packer: { name: "npm" },
  });
  expect(contract.source_includes).toEqual(expect.arrayContaining([
    "lazurio/module-port-lib.mjs",
    "lazurio/module-setup-lib.mjs",
    "lazurio/organization-activation-lib.mjs",
    "lazurio/organization-activation-report.v0.schema.json",
  ]));
  expect(contract.required_paths).toEqual(expect.arrayContaining([
    "lazurio/module-port-lib.mjs",
    "lazurio/module-setup-lib.mjs",
    "lazurio/organization-activation-lib.mjs",
    "lazurio/organization-activation-report.v0.schema.json",
  ]));
  expect(JSON.stringify(contract)).not.toMatch(/darwin|linux|windows|x64|arm64/u);
});

test("package evidence separates deterministic content from npm tarball transport", () => {
  const evidence = {
    schema_version: "lazurio.cli.npm-package-evidence.v1",
    package: {
      name: "lazurio",
      version: "1.0.0",
      filename: "lazurio-1.0.0.tgz",
      integrity: "sha512-test",
      shasum: "a".repeat(40),
      size: 100,
      unpacked_size: 200,
      file_count: 1,
      files: [{ path: "package.json", size: 200, mode: 420 }],
    },
    source: { repository: "HumanAndMachines/Lazurio", commit: "a".repeat(40) },
    packer: { name: "npm", version: "11.17.0" },
    paths: { archive: "/machine-specific/path" },
  };
  const report = packageEvidenceForReport(evidence);
  expect(report).toEqual({
    schema_version: evidence.schema_version,
    package: {
      name: evidence.package.name,
      version: evidence.package.version,
      filename: evidence.package.filename,
      unpacked_size: evidence.package.unpacked_size,
      file_count: evidence.package.file_count,
      files: evidence.package.files,
    },
    transport: {
      integrity: evidence.package.integrity,
      shasum: evidence.package.shasum,
      size: evidence.package.size,
    },
    source: evidence.source,
    packer: evidence.packer,
  });
  expect(packageContentForParity(report)).toEqual({
    schema_version: report.schema_version,
    package: {
      ...report.package,
      files: [{ path: "package.json", size: 200 }],
    },
    source: report.source,
    packer: report.packer,
  });
});

test("content parity ignores OS-specific npm archive encoding and stat mode", () => {
  const content = {
    schema_version: "lazurio.cli.npm-package-evidence.v1",
    package: {
      name: "lazurio",
      version: "1.0.0",
      filename: "lazurio-1.0.0.tgz",
      unpacked_size: 200,
      file_count: 1,
      files: [{ path: "package.json", size: 200, mode: 420 }],
    },
    source: { repository: "HumanAndMachines/Lazurio", commit: "a".repeat(40) },
    packer: { name: "npm", version: "11.17.0" },
  };
  const linux = { ...content, transport: { integrity: "sha512-linux", shasum: "a".repeat(40), size: 100 } };
  const windows = {
    ...content,
    package: {
      ...content.package,
      files: [{ path: "package.json", size: 200, mode: 493 }],
    },
    transport: { integrity: "sha512-windows", shasum: "b".repeat(40), size: 101 },
  };
  expect(packageContentForParity(linux)).toEqual(packageContentForParity(windows));
});

test("package smoke keeps Root selection deterministic across host prerequisite states", () => {
  const actionRequired = inspectLazurioInstallation({
    root: null,
    platform: "linux",
    architecture: "x64",
    bunVersion: "1.3.14",
    resolveGit: () => null,
    resolveGitHubCli: () => null,
  });
  const failedHostProbe = inspectLazurioInstallation({
    root: null,
    platform: "win32",
    architecture: "x64",
    bunVersion: "1.3.14",
    resolveGit: () => "C:\\Program Files\\Git\\cmd\\git.exe",
    resolveGitHubCli: () => "C:\\Program Files\\GitHub CLI\\gh.exe",
    runCommand: ({ executable }) => ({
      status: executable.endsWith("gh.exe") ? 1 : 0,
    }),
  });

  expect(actionRequired.status).toBe("action_required");
  expect(failedHostProbe.status).toBe("failed");
  expect(() => assertRootlessInstallBoundary({
    report: actionRequired,
    exitStatus: installExitCode(actionRequired),
  })).not.toThrow();
  expect(() => assertRootlessInstallBoundary({
    report: failedHostProbe,
    exitStatus: installExitCode(failedHostProbe),
  })).not.toThrow();
  expect(() => assertRootlessInstallBoundary({
    report: failedHostProbe,
    exitStatus: 1,
  })).toThrow("does not match report status failed");
});

test("package smoke rejects a selected Root", () => {
  const report = inspectLazurioInstallation({
    root: "/fixture/root",
    platform: "linux",
    architecture: "x64",
    bunVersion: "1.3.14",
    resolveGit: () => null,
    resolveGitHubCli: () => null,
    inspectRoot: () => ({
      path: "/fixture/root",
      layout: "generated_root",
      status: "completed",
      reason: "generated_root_ready",
    }),
  });

  expect(() => assertRootlessInstallBoundary({
    report,
    exitStatus: installExitCode(report),
  })).toThrow("did not require an explicit Root");
});
