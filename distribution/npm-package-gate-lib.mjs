import { constants } from "node:fs";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";

import { isValidNpmPackageVersion } from "./npm-package-lib.mjs";

const usage = "usage: npm-package-gate.mjs [--evidence <path>] [--release-version <semver> --archive-dir <new-directory>]";

export function parseNpmPackageGateArgs(argv, { cwd = process.cwd() } = {}) {
  const parsed = {
    evidence: null,
    releaseVersion: null,
    archiveDirectory: null,
  };
  const destinations = new Map([
    ["--evidence", "evidence"],
    ["--release-version", "releaseVersion"],
    ["--archive-dir", "archiveDirectory"],
  ]);
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    const destination = destinations.get(option);
    const value = argv[index + 1];
    if (!destination || !value || value.startsWith("--") || seen.has(option)) {
      throw new Error(usage);
    }
    parsed[destination] = destination === "releaseVersion" ? value : resolve(cwd, value);
    seen.add(option);
    index += 1;
  }
  if (Boolean(parsed.releaseVersion) !== Boolean(parsed.archiveDirectory)) {
    throw new Error(usage);
  }
  if (parsed.releaseVersion && !isValidNpmPackageVersion(parsed.releaseVersion)) {
    throw new Error(`invalid npm package version ${parsed.releaseVersion}`);
  }
  if (parsed.evidence && parsed.archiveDirectory) {
    throw new Error("release candidate evidence is written inside --archive-dir; do not also pass --evidence");
  }
  return Object.freeze(parsed);
}

export async function retainVerifiedNpmPackage({ build, evidence, archiveDirectory }) {
  assertRetentionInput({ build, evidence });
  const targetDirectory = resolve(archiveDirectory);
  await mkdir(dirname(targetDirectory), { recursive: true });
  try {
    await mkdir(targetDirectory);
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw new Error(`release candidate path already exists: ${targetDirectory}`);
    }
    throw error;
  }

  try {
    const archive = join(targetDirectory, build.package.filename);
    const evidencePath = join(
      targetDirectory,
      build.package.filename.replace(/\.tgz$/u, ".evidence.json"),
    );
    await copyFile(build.paths.archive, archive, constants.COPYFILE_EXCL);
    await assertArchiveDigest(archive, build.package);
    await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    return Object.freeze({ directory: targetDirectory, archive, evidence: evidencePath });
  } catch (error) {
    try {
      await rm(targetDirectory, { recursive: true, force: true });
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        `release candidate retention failed and cleanup could not remove ${targetDirectory}`,
      );
    }
    throw error;
  }
}

function assertRetentionInput({ build, evidence }) {
  const filename = build?.package?.filename;
  if (
    typeof filename !== "string"
    || basename(filename) !== filename
    || !filename.endsWith(".tgz")
    || typeof build?.paths?.archive !== "string"
    || evidence?.package?.name !== build.package.name
    || evidence?.package?.version !== build.package.version
    || evidence?.package?.filename !== filename
    || evidence?.transport?.integrity !== build.package.integrity
    || evidence?.transport?.shasum !== build.package.shasum
  ) {
    throw new Error("release candidate retention requires matching verified package evidence");
  }
}

async function assertArchiveDigest(path, packageDescriptor) {
  const bytes = await readFile(path);
  const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
  const shasum = createHash("sha1").update(bytes).digest("hex");
  if (integrity !== packageDescriptor.integrity || shasum !== packageDescriptor.shasum) {
    throw new Error("retained npm archive differs from the verified package bytes");
  }
}
