import { lstatSync, readFileSync } from "node:fs";
import { relative, resolve, sep } from "node:path";

import { scanArtifactEntries } from "./build-lib.mjs";
import {
  installExitCode,
  isValidLazurioInstallReport,
} from "../lazurio/core/install-core-lib.mjs";
import { bunVersionFromPackageManager } from "../lazurio/core/toolchain-lib.mjs";

export const LAZURIO_NPM_PACKAGE = "@lazurio/runtime";
export const LAZURIO_PACKAGE_DIRECTORY = "lazurio";

const packageVersionPattern = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const productionReferencePattern = /(?:\b(?:import|export)\s+(?:[^;"']*?\sfrom\s+)?|\bimport\s*\(|\bnew\s+URL\s*\()\s*["'](\.\.?\/[^"']+)["']/gu;
const forbiddenPathSegments = [
  ".git",
  ".worktrees",
  "node_modules",
  ".cache",
  "drafts",
  "private",
  "secrets",
  "logs",
  "testdata",
];

export function isValidNpmPackageVersion(version) {
  return typeof version === "string" && packageVersionPattern.test(version);
}

export function validateLazurioPackageManifest(manifest) {
  if (manifest?.name !== LAZURIO_NPM_PACKAGE) throw new Error(`npm package name must be ${LAZURIO_NPM_PACKAGE}`);
  if (!isValidNpmPackageVersion(manifest.version)) throw new Error("npm package version must be valid SemVer");
  if (manifest.license !== "FSL-1.1-ALv2") throw new Error("npm package license must use the canonical FSL-1.1-ALv2 SPDX identifier");
  if (manifest.private === true) throw new Error("publishable npm package must not be private");
  if (manifest.type !== "module" || manifest.bin?.lazurio !== "cli.mjs") {
    throw new Error("npm package must expose the single lazurio bin from cli.mjs");
  }
  if (Object.keys(manifest.bin ?? {}).length !== 1) throw new Error("npm package must expose exactly one bin");
  const bunVersion = bunVersionFromPackageManager(manifest.packageManager);
  if (manifest.engines?.bun !== bunVersion) {
    throw new Error("npm package engines.bun must equal its exact packageManager Bun version");
  }
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
    throw new Error("npm package files must be the single tracked packlist authority");
  }
  if (Object.keys(manifest.scripts ?? {}).length > 0) {
    throw new Error("npm package lifecycle scripts are forbidden until a reviewed build boundary exists");
  }
  if (
    manifest.publishConfig?.access !== "public"
    || manifest.publishConfig?.tag !== "next"
    || manifest.publishConfig?.provenance !== true
  ) {
    throw new Error("npm package publishConfig must require public next releases with provenance");
  }
  if (
    manifest.repository?.url !== "git+https://github.com/HumanAndMachines/Lazurio.git"
    || manifest.repository?.directory !== LAZURIO_PACKAGE_DIRECTORY
    || manifest.lazurio?.schema_version !== "lazurio.cli.package.v1"
    || manifest.lazurio?.source?.repository !== "HumanAndMachines/Lazurio"
    || Object.keys(manifest.lazurio.source).length !== 1
  ) {
    throw new Error("npm package repository and Lazurio package metadata are incomplete");
  }
  return Object.freeze({ bunVersion, version: manifest.version });
}

export function parseNpmPackDescriptor(stdout) {
  let value;
  try {
    value = JSON.parse(stdout);
  } catch (error) {
    throw new Error(`npm pack did not return JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const descriptor = Array.isArray(value) ? value[0] : null;
  if (
    !descriptor
    || descriptor.name !== LAZURIO_NPM_PACKAGE
    || !isValidNpmPackageVersion(descriptor.version)
    || typeof descriptor.filename !== "string"
    || !Array.isArray(descriptor.files)
    || descriptor.files.length === 0
  ) {
    throw new Error("npm pack returned an incomplete @lazurio/runtime descriptor");
  }
  return descriptor;
}

export function inspectNpmPacklist({ packageRoot, repositoryRoot, descriptor }) {
  const canonicalPackageRoot = resolve(packageRoot);
  const entries = new Map();
  for (const file of descriptor.files) {
    const path = String(file?.path ?? "").split("\\").join("/");
    if (path === "" || path.startsWith("/") || path.split("/").includes("..")) {
      throw new Error(`npm pack returned an unsafe path: ${JSON.stringify(path)}`);
    }
    const absolutePath = resolve(canonicalPackageRoot, ...path.split("/"));
    if (!isInside(canonicalPackageRoot, absolutePath)) {
      throw new Error(`npm pack path escaped the package root: ${path}`);
    }
    const stat = lstatSync(absolutePath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`npm pack entry must be a physical file: ${path}`);
    }
    if (/\.test\.(?:js|mjs|ts)$/u.test(path)) throw new Error(`npm pack contains a test: ${path}`);
    entries.set(path, {
      bytes: readFileSync(absolutePath),
      mode: (stat.mode & 0o777).toString(8).padStart(4, "0"),
    });
  }
  for (const requiredPath of ["LICENSE.md", "README.md", "cli.mjs", "package.json"]) {
    if (!entries.has(requiredPath)) throw new Error(`npm pack is missing required package file: ${requiredPath}`);
  }
  const canonicalLicense = readFileSync(resolve(repositoryRoot, "LICENSE.md"));
  if (!entries.get("LICENSE.md").bytes.equals(canonicalLicense)) {
    throw new Error("npm package LICENSE.md must exactly match the repository license");
  }
  const scan = scanArtifactEntries(entries, {
    forbiddenPathSegments,
    forbiddenTerms: [resolve(repositoryRoot), canonicalPackageRoot],
  });
  if (!scan.ok) throw new Error(`npm package privacy scan failed: ${scan.failures.slice(0, 5).join("; ")}`);
  assertProductionClosure({ packageRoot: canonicalPackageRoot, entries });
  return Object.freeze({ fileCount: entries.size });
}

export function assertProductionClosure({ packageRoot, entries }) {
  for (const [path, entry] of entries) {
    if (!path.endsWith(".mjs")) continue;
    const source = entry.bytes.toString("utf8");
    for (const match of source.matchAll(productionReferencePattern)) {
      const target = resolve(packageRoot, ...path.split("/").slice(0, -1), match[1]);
      if (!isInside(packageRoot, target)) {
        throw new Error(`${path} references production content outside @lazurio/runtime: ${match[1]}`);
      }
      const targetPath = relative(packageRoot, target).split(sep).join("/");
      if (!entries.has(targetPath)) {
        throw new Error(`${path} references unpacked production content: ${targetPath}`);
      }
    }
  }
}

export function assertCanonicalInstallBoundary({ report, exitStatus, canonicalRoot }) {
  if (!isValidLazurioInstallReport(report)) {
    throw new Error("installed lazurio install returned an invalid report");
  }
  if (exitStatus !== installExitCode(report)) {
    throw new Error(
      `installed lazurio install exit ${exitStatus} does not match report status ${report.status}`,
    );
  }
  if (
    typeof canonicalRoot !== "string"
    || canonicalRoot === ""
    || report.root.selected !== true
    || report.root.path !== canonicalRoot
  ) {
    throw new Error(`installed package did not use the canonical home Root: ${JSON.stringify(report)}`);
  }
}

function isInside(root, target) {
  const path = relative(resolve(root), resolve(target));
  return path === "" || (!path.startsWith("..") && !path.startsWith(sep));
}
