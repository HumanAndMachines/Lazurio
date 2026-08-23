#!/usr/bin/env bun

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

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
console.log(`ok - npm package parity: ${runners.join(", ")} share ${baseline.package.integrity}`);

function canonicalPackageEvidence(value) {
  if (value?.schema_version !== "lazurio.cli.npm-package-evidence.v1") {
    throw new Error("unsupported npm package evidence");
  }
  if (!value.package || !value.source || !value.packer) {
    throw new Error("npm package evidence is incomplete");
  }
  for (const result of Object.values(value.smoke ?? {})) {
    if (result !== "passed") throw new Error("npm package smoke evidence is not green");
  }
  return {
    schema_version: value.schema_version,
    package: value.package,
    source: value.source,
    packer: value.packer,
  };
}
