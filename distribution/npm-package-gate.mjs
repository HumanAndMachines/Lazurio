#!/usr/bin/env bun

import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

import {
  buildLazurioNpmPackage,
  packageEvidenceForParity,
} from "./npm-package-lib.mjs";

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
  const smoke = smokeInstalledArchive(build);
  const evidence = {
    ...packageEvidenceForParity(build),
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

function smokeInstalledArchive(build) {
  const installRoot = join(temporaryRoot, "bun");
  const globalDirectory = join(installRoot, "install", "global");
  const globalBin = join(installRoot, "bin");
  const environment = cleanPathEnvironment({
    ...process.env,
    BUN_INSTALL: installRoot,
    BUN_INSTALL_GLOBAL_DIR: globalDirectory,
    BUN_INSTALL_BIN: globalBin,
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
  const rootless = runInstalledShim(globalBin, ["context", "--json"], environment);
  if (rootless.status !== 1 || !rootless.stderr.includes("--root <cesta>")) {
    throw new Error("package-managed Root command must fail closed until --root is explicit");
  }
  return {
    global_install: "passed",
    installed_shim: "passed",
    help: "passed",
    package_provenance: "passed",
    operated_root_boundary: "passed",
    updater_source_closure: "passed",
  };
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
