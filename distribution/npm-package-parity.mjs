#!/usr/bin/env bun

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { packageContentForParity } from "./npm-package-lib.mjs";

const paths = Bun.argv.slice(2).map((path) => resolve(path));
if (paths.length < 2) throw new Error("npm package parity requires at least two evidence files");
const evidence = await Promise.all(paths.map(async (path) => ({
  path,
  value: JSON.parse(await readFile(path, "utf8")),
})));
const baseline = canonicalPackageEvidence(evidence[0].value);
for (const candidate of evidence.slice(1)) {
  const observed = canonicalPackageEvidence(candidate.value);
  if (JSON.stringify(observed) !== JSON.stringify(baseline)) {
    throw new Error(`npm package evidence differs across runners: ${evidence[0].path} vs ${candidate.path}`);
  }
}
const runners = evidence.map(({ value }) => `${value.runner?.os}-${value.runner?.arch}`).sort();
console.log(
  `ok - npm package content parity: ${runners.join(", ")} share ${baseline.source.commit}, `
  + `${baseline.package.file_count} files and ${baseline.package.unpacked_size} unpacked bytes`,
);

function canonicalPackageEvidence(value) {
  if (value?.schema_version !== "lazurio.cli.npm-package-evidence.v1") {
    throw new Error("unsupported npm package evidence");
  }
  if (!value.package || !value.transport || !value.source || !value.packer) {
    throw new Error("npm package evidence is incomplete");
  }
  for (const result of Object.values(value.smoke ?? {})) {
    if (result !== "passed") throw new Error("npm package smoke evidence is not green");
  }
  // npm owns each archive's integrity. npm pack does not promise byte-identical
  // gzip/tar output or stat-derived mode reporting across operating systems, so
  // transport fields and observed modes remain in the audit evidence but are
  // not a cross-OS content identity. The exact Git object already owns source
  // modes; parity adds deterministic generated metadata and npm's unpacked
  // path/size inventory.
  return packageContentForParity(value);
}
