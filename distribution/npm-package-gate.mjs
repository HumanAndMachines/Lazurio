#!/usr/bin/env bun

import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

import {
  assertCanonicalInstallBoundary,
  buildLazurioNpmPackage,
  packageEvidenceForReport,
} from "./npm-package-lib.mjs";
import { canonicalLazurioRoot } from "../lazurio/core/install-core-lib.mjs";
import {
  commitRemoteModule,
  createLazurioUpdateFixture,
} from "../tests/lazurio-update-fixture.mjs";

const options = parseArgs(Bun.argv.slice(2));
const repositoryRoot = resolve(import.meta.dirname, "..");
const sourcePackage = JSON.parse(readFileSync(join(repositoryRoot, "package.json"), "utf8"));
if (sourcePackage.private !== true) {
  throw new Error("source package.json must remain private; only generated staging is publishable");
}

const temporaryRoot = await mkdtemp(join(tmpdir(), "lazurio-npm-package-gate-"));
try {
  const build = await buildLazurioNpmPackage({
    cwd: repositoryRoot,
    outputRoot: temporaryRoot,
  });
  await assertUpdaterBundle(build.paths.staging_root);
  const smoke = await smokeInstalledArchive(build);
  const evidence = {
    ...packageEvidenceForReport(build),
    smoke,
    runner: {
      os: process.platform,
      arch: process.arch,
      bun_version: Bun.version,
    },
  };
  if (options.evidence) {
    await mkdir(dirname(options.evidence), { recursive: true });
    await writeFile(options.evidence, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  }
  console.log(JSON.stringify(evidence, null, 2));
} finally {
  await rm(temporaryRoot, {
    recursive: true,
    force: true,
    maxRetries: 3,
    retryDelay: 100,
  });
}

function parseArgs(argv) {
  const parsed = { evidence: null };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== "--evidence" || !argv[index + 1]) {
      throw new Error("usage: npm-package-gate.mjs [--evidence <path>]");
    }
    parsed.evidence = resolve(argv[index + 1]);
    index += 1;
  }
  return parsed;
}

async function assertUpdaterBundle(stagingRoot) {
  const entrypoint = join(stagingRoot, "launchpad", "src", "lazurio-update-runtime.mjs");
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

async function smokeInstalledArchive(build) {
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
  const install = run(process.execPath, ["add", "--global", build.paths.archive], {
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
    || provenance.version !== build.package.version
    || provenance.source?.commit !== build.source.commit
    || provenance.artifact !== null
  ) {
    throw new Error(`installed package provenance mismatch: ${JSON.stringify(provenance)}`);
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
  await assertInstalledUpdaterRuntime({ globalBin, environment });
  return {
    global_install: "passed",
    installed_shim: "passed",
    help: "passed",
    package_provenance: "passed",
    install_report: "passed",
    operated_root_boundary: "passed",
    module_setup_root_boundary: "passed",
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
