import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, readFile, readdir, readlink } from "node:fs/promises";
import { basename, join, posix } from "node:path";
import {
  normalizeResidentPath,
  RESIDENT_MANIFEST_PATH,
  validateResidentManifest,
} from "#lazurio-core/resident-manifest";

export {
  normalizeResidentPath,
  RESIDENT_MANIFEST_PATH,
  validateResidentManifest,
};

export async function verifyArtifactTree(artifactRoot, {
  expectedProfile,
  expectedTarget,
} = {}) {
  const failures = [];
  const checks = [];
  const check = (id, ok, detail) => {
    checks.push({ id, status: ok ? "pass" : "fail", detail });
    if (!ok) failures.push(`${id}: ${detail}`);
  };

  let manifest;
  try {
    const manifestPath = join(artifactRoot, RESIDENT_MANIFEST_PATH);
    const stat = await lstat(manifestPath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error("manifest is not a regular file");
    }
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    check("manifest-readable", true, "resident manifest is a regular JSON file");
  } catch (error) {
    check(
      "manifest-readable",
      false,
      `manifest cannot be read: ${error instanceof Error ? error.message : String(error)}`,
    );
    return { ok: false, failures, checks, manifest: null };
  }

  try {
    const gbrain = JSON.parse(
      await readFile(join(artifactRoot, "resident", "dependencies", "gbrain.json"), "utf8"),
    );
    check(
      "gbrain-pin",
      gbrain?.repository === manifest.dependencies.gbrain.repository
        && gbrain?.version === manifest.dependencies.gbrain.version
        && gbrain?.commit === manifest.dependencies.gbrain.commit
        && gbrain?.lock_sha256 === manifest.dependencies.gbrain.lock_sha256
        && gbrain?.runtime?.engine === manifest.dependencies.gbrain.engine
        && gbrain?.runtime?.transport === manifest.dependencies.gbrain.transport
        && gbrain?.compatibility?.independent_self_update_allowed === false,
      "exact fork commit, lock digest and local stdio PGLite mode match the artifact manifest",
    );
    const toolchain = JSON.parse(
      await readFile(join(artifactRoot, "resident", "dependencies", "toolchain.json"), "utf8"),
    );
    check(
      "toolchain-pin",
      toolchain?.tools?.bun?.version === manifest.dependencies.toolchain.bun
        && toolchain?.tools?.uv?.version === manifest.dependencies.toolchain.uv,
      "exact Bun and uv versions match the artifact manifest",
    );
  } catch (error) {
    check(
      "gbrain-pin",
      false,
      `GBrain or toolchain pin cannot be read: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const shapeFailures = validateResidentManifest(manifest);
  check(
    "manifest-shape",
    shapeFailures.length === 0,
    shapeFailures.length === 0
      ? "lazurio.resident.manifest.v1 contract is valid"
      : shapeFailures.join("; "),
  );
  if (shapeFailures.length > 0) {
    return { ok: false, failures, checks, manifest };
  }

  if (expectedProfile !== undefined) {
    check(
      "profile-compatibility",
      manifest.profile === expectedProfile,
      `expected ${expectedProfile}; artifact ${manifest.profile}`,
    );
  }
  if (expectedTarget !== undefined) {
    const declaredTarget = `${manifest.target.os}-${manifest.target.arch}`;
    check(
      "platform-compatibility",
      declaredTarget === expectedTarget,
      `running ${expectedTarget}; artifact ${declaredTarget}`,
    );
  }

  const expectedFiles = new Set([RESIDENT_MANIFEST_PATH]);
  const expectedDirectories = new Set(["."]);
  for (const file of manifest.payload.files) {
    expectedFiles.add(file.path);
    let parent = posix.dirname(file.path);
    while (parent !== ".") {
      expectedDirectories.add(parent);
      parent = posix.dirname(parent);
    }
    const path = join(artifactRoot, ...file.path.split("/"));
    try {
      const stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        check(`payload:${file.path}`, false, "not a regular immutable file");
        continue;
      }
      const bytes = await readFile(path);
      const contentMatches = bytes.length === file.size && sha256(bytes) === file.sha256;
      const modeMatches = process.platform === "win32"
        || (stat.mode & 0o777) === Number.parseInt(file.mode, 8);
      check(
        `payload:${file.path}`,
        contentMatches && modeMatches,
        contentMatches && modeMatches
          ? "size, sha256 and mode match"
          : "size, sha256 or mode mismatch",
      );
    } catch {
      check(`payload:${file.path}`, false, "missing immutable payload file");
    }
  }

  const scan = await scanArtifactTree(
    artifactRoot,
    new Set(manifest.mutable_mounts),
    expectedFiles,
    expectedDirectories,
  );
  for (const failure of scan.failures) check(`filesystem:${failure.path}`, false, failure.detail);
  if (scan.failures.length === 0) {
    check("filesystem-layout", true, "no unexpected immutable entries or Git metadata");
  }

  const payloadDigest = digestInventory(manifest.payload.files);
  check(
    "payload-inventory",
    payloadDigest === manifest.payload.digest,
    payloadDigest === manifest.payload.digest ? "inventory digest matches" : "inventory digest mismatch",
  );
  const agents = manifest.payload.files
    .map((file) => file.path)
    .filter((path) => basename(path) === "AGENTS.md");
  check(
    "profile-boundary",
    agents.length === 1 && agents[0] === "AGENTS.md",
    "exactly one root AGENTS.md must exist",
  );
  if (manifest.profile === "buddy") {
    const buddyPayload = new Set(manifest.payload.files.map((file) => file.path));
    const bridgeRequired = [
      "bridge/run.ts",
      "resident/buddy-service-lib.mjs",
      "resident/buddy-service.mjs",
      "resident/buddy-rollout-lib.mjs",
      "resident/buddy-rollout.mjs",
      "resident/services/buddy-bridge.service.template",
      "resident/services/hermes-lazurio-root.conf.template",
    ];
    const bridgeComplete = bridgeRequired.every((path) => buddyPayload.has(path));
    check(
      "buddy-bridge-contract",
      bridgeComplete && manifest.role_overlays.length === 0,
      bridgeComplete && manifest.role_overlays.length === 0
        ? "Buddy bridge entrypoint and service template are immutable payload with no role overlay"
        : "Buddy bridge payload is incomplete or carries a forbidden role overlay",
    );
  }
  if (["buddy", "ai-colleague"].includes(manifest.profile)) {
    const managedPayload = new Set(manifest.payload.files.map((file) => file.path));
    const managedRequired = [
      "bridge/run.ts",
      "resident/controller-lib.mjs",
      "resident/controller.mjs",
      "resident/updater-lib.mjs",
      "resident/updater.mjs",
    ];
    const managedComplete = managedRequired.every((path) => managedPayload.has(path));
    check(
      "managed-resident-controller",
      managedComplete && manifest.role_overlays.length === 0,
      managedComplete && manifest.role_overlays.length === 0
        ? "Managed Resident controller and binding worker are immutable payload with no role overlay"
        : "Managed Resident controller payload is incomplete or carries a forbidden role overlay",
    );
  }

  try {
    const profile = JSON.parse(
      await readFile(join(artifactRoot, "resident", "profile.json"), "utf8"),
    );
    check(
      "profile-id",
      profile?.schema_version === "lazurio.resident.profile.v1"
        && profile?.id === manifest.profile,
      `profile descriptor must match ${manifest.profile}`,
    );
  } catch (error) {
    check(
      "profile-id",
      false,
      `profile descriptor cannot be read: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  try {
    const hermes = JSON.parse(
      await readFile(join(artifactRoot, "resident", "dependencies", "hermes.json"), "utf8"),
    );
    check(
      "hermes-pin",
      hermes?.repository === manifest.dependencies.hermes.repository
        && hermes?.release_tag === manifest.dependencies.hermes.release_tag
        && hermes?.commit === manifest.dependencies.hermes.commit
        && hermes?.lock_sha256 === manifest.dependencies.hermes.lock_sha256
        && hermes?.compatibility?.independent_self_update_allowed === false,
      "exact fork release, commit and lock digest match the artifact manifest",
    );
  } catch (error) {
    check(
      "hermes-pin",
      false,
      `Hermes pin cannot be read: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return { ok: failures.length === 0, failures, checks, manifest };
}

export function digestInventory(files) {
  const digest = createHash("sha256");
  for (const file of files) {
    digest.update(file.path);
    digest.update("\0");
    digest.update(file.mode);
    digest.update("\0");
    digest.update(String(file.size));
    digest.update("\0");
    digest.update(file.sha256);
    digest.update("\n");
  }
  return digest.digest("hex");
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function scanArtifactTree(root, mutableMounts, expectedFiles, expectedDirectories) {
  const failures = [];
  const visit = async (directory, prefix = "") => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const path = join(directory, entry.name);
      if (!prefix && mutableMounts.has(entry.name)) {
        if (!entry.isDirectory() && !entry.isSymbolicLink()) {
          failures.push({ path: relativePath, detail: "mutable mount must be a directory or symbolic link" });
        } else if (entry.isSymbolicLink()) {
          const target = await readlink(path);
          const expected = posix.join("..", "..", "state", entry.name);
          if (target !== expected) {
            failures.push({ path: relativePath, detail: `mutable mount link must target ${expected}` });
          }
        }
        continue;
      }
      if (entry.name === ".git") {
        failures.push({ path: relativePath, detail: "Git metadata is forbidden" });
        continue;
      }
      if (entry.isSymbolicLink()) {
        failures.push({ path: relativePath, detail: "symbolic link is allowed only for a declared top-level mutable mount" });
      } else if (entry.isDirectory()) {
        if (!expectedDirectories.has(relativePath)) {
          failures.push({ path: relativePath, detail: "unexpected immutable directory" });
        }
        await visit(path, relativePath);
      } else if (entry.isFile()) {
        if (!expectedFiles.has(relativePath)) {
          failures.push({ path: relativePath, detail: "unexpected immutable file" });
        }
      } else {
        failures.push({ path: relativePath, detail: "unsupported filesystem entry" });
      }
    }
  };
  if (!existsSync(root)) {
    failures.push({ path: ".", detail: "artifact root does not exist" });
    return { failures };
  }
  await visit(root);
  for (const path of expectedFiles) {
    if (!existsSync(join(root, ...path.split("/")))) {
      failures.push({ path, detail: "manifest entry is absent" });
    }
  }
  return { failures };
}
