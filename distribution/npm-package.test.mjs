import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { packageEvidenceForParity } from "./npm-package-lib.mjs";

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
  expect(JSON.stringify(contract)).not.toMatch(/darwin|linux|windows|x64|arm64/u);
});

test("parity evidence excludes runner paths and keeps npm integrity authority", () => {
  const evidence = {
    schema_version: "lazurio.cli.npm-package-evidence.v1",
    package: { name: "lazurio", version: "1.0.0", integrity: "sha512-test" },
    source: { repository: "HumanAndMachines/Lazurio", commit: "a".repeat(40) },
    packer: { name: "npm", version: "11.17.0" },
    paths: { archive: "/machine-specific/path" },
  };
  expect(packageEvidenceForParity(evidence)).toEqual({
    schema_version: evidence.schema_version,
    package: evidence.package,
    source: evidence.source,
    packer: evidence.packer,
  });
});
