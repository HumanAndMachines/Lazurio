import { existsSync } from "node:fs";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

import {
  addGeneratedEntry,
  gitText,
  readGitTree,
  readJsonBlob,
  scanArtifactEntries,
  selectSourceEntries,
  sortedEntries,
} from "./build-lib.mjs";
import {
  installExitCode,
  isValidLazurioInstallReport,
} from "../lazurio/core/install-core-lib.mjs";
import { bunVersionFromPackageManager } from "../lazurio/core/toolchain-lib.mjs";

const CONTRACT_PATH = "distribution/npm-package-contract.v1.json";
const packageVersionPattern = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;

export async function buildLazurioNpmPackage({
  cwd = process.cwd(),
  packageVersion,
  outputRoot = "dist/npm",
  bunExecutable = process.execPath,
  runProcess = runProcessSync,
} = {}) {
  const repositoryRoot = gitText(cwd, ["rev-parse", "--show-toplevel"]);
  const sourceCommit = gitText(repositoryRoot, ["rev-parse", "HEAD"]);
  if (!/^[0-9a-f]{40,64}$/u.test(sourceCommit)) {
    throw new Error("npm package build requires an exact Git object id");
  }
  const status = gitText(repositoryRoot, [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
  ]);
  if (status !== "") throw new Error("npm package build requires a clean source checkout");

  const tree = readGitTree(repositoryRoot, sourceCommit);
  const contract = readJsonBlob(repositoryRoot, tree, CONTRACT_PATH);
  const sourcePackage = readJsonBlob(repositoryRoot, tree, "package.json");
  validateContract(contract);
  const requiredBunVersion = bunVersionFromPackageManager(sourcePackage.packageManager);
  const version = packageVersion ?? `0.0.0-dev.${sourceCommit.slice(0, 12)}`;
  if (!packageVersionPattern.test(version)) throw new Error(`invalid npm package version ${version}`);
  const commitEpoch = Number(gitText(repositoryRoot, ["show", "-s", "--format=%ct", sourceCommit]));
  if (!Number.isSafeInteger(commitEpoch) || commitEpoch < 0) {
    throw new Error("npm package source commit timestamp is invalid");
  }

  const entries = selectSourceEntries(repositoryRoot, tree, contract);
  addGeneratedEntry(
    entries,
    "package.json",
    packageJson({ contract, version, sourceCommit, commitEpoch, requiredBunVersion }),
    "0644",
  );
  const scan = scanArtifactEntries(entries, {
    forbiddenPathSegments: contract.forbidden_path_segments,
    forbiddenTerms: [repositoryRoot],
  });
  if (!scan.ok) throw new Error(`npm package privacy scan failed: ${scan.failures.slice(0, 5).join("; ")}`);
  assertPackageShape(entries, contract);

  const destinationRoot = resolve(repositoryRoot, outputRoot);
  const stagingRoot = join(destinationRoot, `lazurio-${version}-${sourceCommit.slice(0, 12)}`);
  if (existsSync(stagingRoot)) throw new Error(`npm package staging already exists: ${stagingRoot}`);
  await mkdir(stagingRoot, { recursive: true });
  for (const [path, entry] of sortedEntries(entries)) {
    const destination = join(stagingRoot, ...path.split("/"));
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, entry.bytes, { mode: Number.parseInt(entry.mode, 8) });
    await chmod(destination, Number.parseInt(entry.mode, 8));
  }

  const pack = runProcess(bunExecutable, [
    "x",
    `${contract.packer.name}@${contract.packer.version}`,
    "pack",
    stagingRoot,
    "--json",
    "--ignore-scripts",
    "--pack-destination",
    destinationRoot,
  ], { cwd: repositoryRoot });
  if (pack.status !== 0) {
    throw new Error(`npm pack failed: ${(pack.stderr || pack.stdout || "unknown failure").trim()}`);
  }
  const descriptor = parsePackDescriptor(pack.stdout);
  const archivePath = join(destinationRoot, descriptor.filename);
  if (!existsSync(archivePath)) throw new Error(`npm pack did not create ${archivePath}`);
  const expectedPaths = [...entries.keys()].sort();
  const observedPaths = descriptor.files.map((file) => file.path).sort();
  if (JSON.stringify(observedPaths) !== JSON.stringify(expectedPaths)) {
    throw new Error(`npm pack file inventory differs: expected ${expectedPaths.length}, observed ${observedPaths.length}`);
  }

  return Object.freeze({
    schema_version: "lazurio.cli.npm-package-evidence.v1",
    package: Object.freeze({
      name: descriptor.name,
      version: descriptor.version,
      filename: descriptor.filename,
      integrity: descriptor.integrity,
      shasum: descriptor.shasum,
      size: descriptor.size,
      unpacked_size: descriptor.unpackedSize,
      file_count: descriptor.entryCount,
      files: Object.freeze(descriptor.files.map((file) => Object.freeze({
        path: file.path,
        size: file.size,
        mode: file.mode,
      }))),
    }),
    source: Object.freeze({
      repository: contract.source_repository,
      commit: sourceCommit,
      commit_epoch: commitEpoch,
    }),
    packer: Object.freeze({ ...contract.packer }),
    paths: Object.freeze({ staging_root: stagingRoot, archive: archivePath }),
  });
}

function validateContract(contract) {
  if (contract?.schema_version !== "lazurio.cli.npm-package-contract.v1") {
    throw new Error("unsupported npm package contract");
  }
  if (contract.package_name !== "lazurio") throw new Error("npm package name must be lazurio");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(contract.source_repository ?? "")) {
    throw new Error("npm package source repository is invalid");
  }
  if (contract.packer?.name !== "npm" || !/^\d+\.\d+\.\d+$/u.test(contract.packer.version ?? "")) {
    throw new Error("npm package contract must pin an exact npm packer version");
  }
  if (!/^\d+\.\d+\.\d+$/u.test(contract.minimum_bun_version ?? "")) {
    throw new Error("npm package contract must pin a minimum Bun version");
  }
  for (const key of ["source_includes", "required_paths", "forbidden_path_segments"]) {
    if (!Array.isArray(contract[key]) || contract[key].length === 0) {
      throw new Error(`npm package contract ${key} must be a non-empty array`);
    }
  }
}

function packageJson({ contract, version, sourceCommit, commitEpoch, requiredBunVersion }) {
  return `${JSON.stringify({
    name: contract.package_name,
    version,
    description: "Local-first workspace for people and AI collaborators",
    license: "SEE LICENSE IN LICENSE.md",
    type: "module",
    packageManager: `bun@${requiredBunVersion}`,
    bin: { lazurio: "lazurio/cli.mjs" },
    imports: {
      "#lazurio-core/resident-manifest": "./lazurio/core/resident-manifest-lib.mjs",
    },
    files: [
      "LICENSE.md",
      "README.md",
      "lazurio",
      "launchpad/schemas",
      "launchpad/src",
      "manual/module-setup.md",
      "manual/module-lifecycle.md",
    ],
    engines: { bun: `>=${contract.minimum_bun_version}` },
    repository: {
      type: "git",
      url: `git+https://github.com/${contract.source_repository}.git`,
    },
    bugs: { url: `https://github.com/${contract.source_repository}/issues` },
    homepage: `https://github.com/${contract.source_repository}#readme`,
    lazurio: {
      schema_version: "lazurio.cli.package.v1",
      source: {
        repository: contract.source_repository,
        commit: sourceCommit,
        commit_epoch: commitEpoch,
      },
    },
  }, null, 2)}\n`;
}

function assertPackageShape(entries, contract) {
  for (const path of contract.required_paths) {
    if (!entries.has(path)) throw new Error(`npm package required path is missing: ${path}`);
  }
  for (const path of entries.keys()) {
    if (path === "lazurio.resident.json") throw new Error("npm package must not contain a Resident manifest");
    if (/\.test\.(?:js|mjs|ts)$/u.test(path)) throw new Error(`npm package contains a test: ${path}`);
  }
}

function parsePackDescriptor(stdout) {
  let value;
  try {
    value = JSON.parse(stdout);
  } catch (error) {
    throw new Error(`npm pack did not return JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const descriptor = Array.isArray(value) ? value[0] : null;
  if (
    !descriptor
    || descriptor.name !== "lazurio"
    || !packageVersionPattern.test(descriptor.version ?? "")
    || typeof descriptor.filename !== "string"
    || !/^sha512-[A-Za-z0-9+/]+={0,2}$/u.test(descriptor.integrity ?? "")
    || !/^[0-9a-f]{40}$/u.test(descriptor.shasum ?? "")
    || !Array.isArray(descriptor.files)
  ) {
    throw new Error("npm pack returned an incomplete descriptor");
  }
  return descriptor;
}

function runProcessSync(command, args, { cwd }) {
  const result = spawnSync(command, args, {
    cwd,
    env: process.env,
    encoding: "utf8",
    shell: false,
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
  return {
    status: result.status,
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? result.error?.message ?? ""),
  };
}

export function packageEvidenceForReport(evidence) {
  return {
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
  };
}

export function packageContentForParity(evidence) {
  return {
    schema_version: evidence.schema_version,
    package: {
      ...evidence.package,
      files: evidence.package.files.map(({ path, size }) => ({ path, size })),
    },
    source: evidence.source,
    packer: evidence.packer,
  };
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
