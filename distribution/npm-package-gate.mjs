#!/usr/bin/env bun

import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

import {
  LAZURIO_PACKAGE_DIRECTORY,
  assertCanonicalInstallBoundary,
  inspectNpmPacklist,
  parseNpmPackDescriptor,
  validateLazurioPackageManifest,
} from "./npm-package-lib.mjs";
import { canonicalLazurioRoot } from "../lazurio/core/install-core-lib.mjs";
import {
  commitRemoteModule,
  createLazurioUpdateFixture,
} from "../tests/lazurio-update-fixture.mjs";

if (Bun.argv.length > 2) throw new Error("usage: npm-package-gate.mjs");
const repositoryRoot = resolve(import.meta.dirname, "..");
const packageRoot = join(repositoryRoot, LAZURIO_PACKAGE_DIRECTORY);
const sourcePackage = JSON.parse(readFileSync(join(repositoryRoot, "package.json"), "utf8"));
if (sourcePackage.private !== true || !sourcePackage.workspaces?.includes(LAZURIO_PACKAGE_DIRECTORY)) {
  throw new Error("source package.json must remain a private workspace root");
}
const packageManifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
validateLazurioPackageManifest(packageManifest);

const temporaryRoot = await mkdtemp(join(tmpdir(), "lazurio-npm-package-gate-"));
try {
  const dryRun = run("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd: packageRoot,
    environment: process.env,
  });
  if (dryRun.status !== 0) throw new Error(`npm pack --dry-run failed: ${failure(dryRun)}`);
  const dryRunDescriptor = parseNpmPackDescriptor(dryRun.stdout);
  const packlist = inspectNpmPacklist({
    packageRoot,
    repositoryRoot,
    descriptor: dryRunDescriptor,
  });
  const packed = run("npm", [
    "pack",
    "--json",
    "--ignore-scripts",
    "--pack-destination",
    temporaryRoot,
  ], {
    cwd: packageRoot,
    environment: process.env,
  });
  if (packed.status !== 0) throw new Error(`npm pack failed: ${failure(packed)}`);
  const descriptor = parseNpmPackDescriptor(packed.stdout);
  const archivePath = join(temporaryRoot, descriptor.filename);
  if (!existsSync(archivePath)) throw new Error(`npm pack did not create ${archivePath}`);
  await assertUpdaterBundle(packageRoot);
  const smoke = await smokeInstalledArchive({
    archivePath,
    packageVersion: descriptor.version,
  });
  console.log(JSON.stringify({
    schema_version: "lazurio.cli.npm-package-gate.v1",
    package: {
      name: descriptor.name,
      version: descriptor.version,
      file_count: packlist.fileCount,
    },
    smoke,
    runner: {
      os: process.platform,
      arch: process.arch,
      bun_version: Bun.version,
    },
  }, null, 2));
} finally {
  await rm(temporaryRoot, {
    recursive: true,
    force: true,
    maxRetries: 3,
    retryDelay: 100,
  });
}

async function assertUpdaterBundle(packageRoot) {
  const entrypoint = join(packageRoot, "runtime", "lazurio-update-runtime.mjs");
  const build = await Bun.build({
    entrypoints: [entrypoint],
    target: "bun",
    format: "esm",
    minify: false,
    sourcemap: "none",
  });
  if (!build.success || build.outputs.length !== 1) {
    throw new Error(
      build.logs.map((entry) => entry.message).join("\n")
      || "packaged updater source closure cannot be bundled",
    );
  }
}

async function smokeInstalledArchive({ archivePath, packageVersion }) {
  const installRoot = join(temporaryRoot, "bun");
  const globalDirectory = join(installRoot, "install", "global");
  const globalBin = join(installRoot, "bin");
  const machineHome = join(temporaryRoot, "home");
  await mkdir(machineHome, { recursive: true });
  const environment = cleanPathEnvironment({
    ...process.env,
    BUN_INSTALL: installRoot,
    BUN_INSTALL_GLOBAL_DIR: globalDirectory,
    BUN_INSTALL_BIN: globalBin,
    HOME: machineHome,
    USERPROFILE: machineHome,
  });
  environment.PATH = `${globalBin}${delimiter}${dirname(process.execPath)}${delimiter}${environment.PATH}`;
  const install = run(process.execPath, ["add", "--global", archivePath], {
    cwd: temporaryRoot,
    environment,
  });
  if (install.status !== 0) throw new Error(`Bun global install failed: ${failure(install)}`);

  const help = runInstalledShim(globalBin, ["--help"], environment);
  if (help.status !== 0 || !help.stdout.includes("Lazurio CLI v0")) {
    throw new Error(`installed lazurio --help failed: ${failure(help)}`);
  }
  const version = runInstalledShim(globalBin, ["--version", "--json"], environment);
  if (version.status !== 0) throw new Error(`installed lazurio --version failed: ${failure(version)}`);
  let provenance;
  try {
    provenance = JSON.parse(version.stdout);
  } catch {
    throw new Error("installed lazurio --version did not return JSON");
  }
  if (
    provenance.status !== "resolved"
    || provenance.root_kind !== "package"
    || provenance.version !== packageVersion
    || provenance.source?.repository !== "HumanAndMachines/Lazurio"
    || provenance.source?.commit !== null
    || provenance.artifact !== null
  ) {
    throw new Error(`installed package provenance mismatch: ${JSON.stringify(provenance)}`);
  }
  const humanVersion = runInstalledShim(globalBin, ["--version"], environment);
  if (
    humanVersion.status !== 0
    || !humanVersion.stdout.includes(`Lazurio CLI ${packageVersion} · package · npm provenance`)
  ) {
    throw new Error(`installed lazurio --version failed: ${failure(humanVersion)}`);
  }
  const installReport = runInstalledShim(globalBin, ["install", "--json"], environment);
  let parsedInstallReport;
  try {
    parsedInstallReport = JSON.parse(installReport.stdout);
  } catch {
    throw new Error("installed lazurio install did not return JSON");
  }
  const canonicalRoot = canonicalLazurioRoot({
    platform: process.platform,
    homeDirectory: machineHome,
  });
  assertCanonicalInstallBoundary({
    report: parsedInstallReport,
    exitStatus: installReport.status,
    canonicalRoot,
  });
  const canonicalContext = runInstalledShim(globalBin, ["context", "--json"], environment);
  if (canonicalContext.status === 0 || canonicalContext.stderr.includes("--root <cesta>")) {
    throw new Error("package-managed Root command must resolve canonical home without requesting a Root selection");
  }
  const canonicalModule = runInstalledShim(
    globalBin,
    ["module", "setup", ".", "--json"],
    environment,
  );
  if (
    canonicalModule.status !== 3
    || canonicalModule.stdout.trim() !== ""
    || canonicalModule.stderr.includes("--root <cesta>")
  ) {
    throw new Error(
      `package-managed module setup must use canonical home without requesting a Root selection: ${failure(canonicalModule)}`,
    );
  }
  const launchpadServe = runInstalledShim(globalBin, ["launchpad", "serve"], environment);
  if (
    launchpadServe.status !== 2
    || launchpadServe.stdout.trim() !== ""
    || !launchpadServe.stderr.includes("LAZURIO_LAUNCHPAD_RUNTIME_UNAVAILABLE")
  ) {
    throw new Error(
      `package-only Launchpad serve must fail before spawn with the stable capability error: ${failure(launchpadServe)}`,
    );
  }
  const organizationInstall = runInstalledShim(
    globalBin,
    ["organization", "install", "ExampleOrganization", "--json"],
    environment,
  );
  let organizationReport;
  try {
    organizationReport = JSON.parse(organizationInstall.stdout);
  } catch {
    throw new Error(`installed lazurio organization install did not return JSON: ${failure(organizationInstall)}`);
  }
  if (
    organizationInstall.status !== 1
    || organizationReport.root !== canonicalRoot
    || organizationReport.target?.reason !== "lazurio_root_not_ready"
  ) {
    throw new Error(
      `package-managed Organization install did not bind to the canonical home Root: ${JSON.stringify(organizationReport)}`,
    );
  }
  await assertInstalledUpdaterRuntime({ globalBin, environment });
  return {
    global_install: "passed",
    installed_shim: "passed",
    help: "passed",
    package_provenance: "passed",
    human_package_version: "passed",
    install_report: "passed",
    operated_root_boundary: "passed",
    module_setup_root_boundary: "passed",
    launchpad_code_origin_boundary: "passed",
    organization_home_root: "passed",
    updater_source_closure: "passed",
    updater_runtime_assets: "passed",
  };
}

async function assertInstalledUpdaterRuntime({ globalBin, environment }) {
  const fixture = await createLazurioUpdateFixture({
    sandboxRoot: join(temporaryRoot, "updater-fixture"),
    withModule: true,
  });
  await commitRemoteModule(fixture);
  const update = runInstalledShim(globalBin, ["update", "--json", "--root", fixture.working], environment);
  let report;
  try {
    report = JSON.parse(update.stdout);
  } catch {
    throw new Error(`installed lazurio update did not return JSON: ${failure(update)}`);
  }
  const moduleResult = report.results?.find((result) => result.repo_key === "FixtureOrg::sample");
  if (
    update.status !== 0
    || report.ok !== true
    || moduleResult?.state !== "updated"
    || moduleResult?.reason !== "checkout_updated"
    || report.results?.some((result) => result.reason === "dependency_inventory_unavailable")
  ) {
    throw new Error(`installed updater runtime asset smoke failed: ${JSON.stringify(report)}`);
  }
}

function cleanPathEnvironment(base) {
  const environment = { ...base };
  let hostPath = "";
  for (const key of Object.keys(environment)) {
    if (key.toLowerCase() === "path") {
      hostPath ||= environment[key] ?? "";
      delete environment[key];
    }
  }
  environment.PATH = String(hostPath)
    .split(delimiter)
    .filter((directory) => directory && !containsLazurioShim(directory))
    .join(delimiter);
  return environment;
}

function containsLazurioShim(directory) {
  return (process.platform === "win32"
    ? ["lazurio.exe", "lazurio.cmd", "lazurio.bat", "lazurio.com"]
    : ["lazurio"])
    .some((name) => existsSync(join(directory.replace(/^"|"$/gu, ""), name)));
}

function runInstalledShim(globalBin, args, environment) {
  if (process.platform === "win32") {
    return run("cmd.exe", ["/d", "/s", "/c", ["lazurio", ...args].join(" ")], {
      cwd: temporaryRoot,
      environment,
    });
  }
  return run(join(globalBin, "lazurio"), args, { cwd: temporaryRoot, environment });
}

function run(command, args, { cwd, environment }) {
  const result = spawnSync(command, args, {
    cwd,
    env: environment,
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

function failure(result) {
  return (result.stderr || result.stdout || `exit ${result.status}`).trim();
}
