import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  packageContentForParity,
  packageEvidenceForReport,
} from "./npm-package-lib.mjs";

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
    "lazurio/organization-activation-lib.mjs",
    "lazurio/organization-activation-report.v0.schema.json",
  ]));
  expect(contract.required_paths).toEqual(expect.arrayContaining([
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
