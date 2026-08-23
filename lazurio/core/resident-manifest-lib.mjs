import { isAbsolute, posix } from "node:path";

export const RESIDENT_MANIFEST_PATH = "lazurio.resident.json";
export const RESIDENT_CHANNELS = Object.freeze(["nightly", "candidate", "stable"]);

const ALLOWED_MUTABLE_MOUNTS = new Set(["organizations", "personalspace"]);

export function validateResidentManifest(manifest) {
  const failures = [];
  if (manifest?.schema_version !== "lazurio.resident.manifest.v1") {
    failures.push("unsupported schema_version");
    return failures;
  }
  const profile = manifest.profile;
  const version = manifest.artifact_version;
  const os = manifest.target?.os;
  const arch = manifest.target?.arch;
  if (typeof profile !== "string" || !/^[a-z][a-z0-9-]*$/u.test(profile)) {
    failures.push("invalid profile");
  }
  if (typeof version !== "string" || !/^[A-Za-z0-9][A-Za-z0-9.+-]*$/u.test(version)) {
    failures.push("invalid artifact_version");
  }
  if (!RESIDENT_CHANNELS.includes(manifest.channel)) failures.push("invalid channel");
  if (!["linux", "darwin", "windows"].includes(os)) failures.push("invalid target OS");
  if (!["x64", "arm64"].includes(arch)) failures.push("invalid target architecture");
  const expectedId = `lazurio-resident-${profile}-${version}-${os}-${arch}`;
  if (manifest.artifact_id !== expectedId || !/^[A-Za-z0-9.+-]+$/u.test(manifest.artifact_id ?? "")) {
    failures.push("artifact_id does not match profile, version and target");
  }
  if (!Array.isArray(manifest.role_overlays)
    || manifest.role_overlays.some((item) => typeof item !== "string" || !/^[a-z][a-z0-9-]*$/u.test(item))
    || new Set(manifest.role_overlays).size !== manifest.role_overlays.length) {
    failures.push("invalid role_overlays");
  }
  if (!Number.isInteger(manifest.build_contract) || manifest.build_contract < 1) {
    failures.push("invalid build_contract");
  }
  if (!Number.isInteger(manifest.compatibility?.resident_root)
    || manifest.compatibility.resident_root < 1
    || !Array.isArray(manifest.compatibility?.rollback_from)
    || manifest.compatibility.rollback_from.some((item) => !Number.isInteger(item) || item < 1)) {
    failures.push("invalid compatibility contract");
  }
  if (typeof manifest.source?.repository !== "string"
    || manifest.source.repository.length === 0
    || !/^[0-9a-f]{40,64}$/u.test(manifest.source?.commit ?? "")
    || !Number.isSafeInteger(manifest.source?.commit_epoch)
    || manifest.source.commit_epoch < 0) {
    failures.push("invalid source provenance");
  }
  const hermes = manifest.dependencies?.hermes;
  if (hermes?.repository !== "Lazurio/hermes-agent"
    || typeof hermes?.release_tag !== "string"
    || hermes.release_tag.length === 0
    || !/^[0-9a-f]{40}$/u.test(hermes?.commit ?? "")
    || !/^[0-9a-f]{64}$/u.test(hermes?.lock_sha256 ?? "")) {
    failures.push("invalid Hermes dependency pin");
  }
  const gbrain = manifest.dependencies?.gbrain;
  if (gbrain?.repository !== "Lazurio/gbrain"
    || gbrain?.release_tag !== null
    || !/^\d+\.\d+\.\d+\.\d+$/u.test(gbrain?.version ?? "")
    || !/^[0-9a-f]{40}$/u.test(gbrain?.commit ?? "")
    || !/^[0-9a-f]{64}$/u.test(gbrain?.lock_sha256 ?? "")
    || gbrain?.engine !== "pglite"
    || gbrain?.transport !== "stdio") {
    failures.push("invalid GBrain dependency pin");
  }
  if (manifest.dependencies?.toolchain?.bun !== "1.3.10"
    || manifest.dependencies?.toolchain?.uv !== "0.11.32") {
    failures.push("invalid Resident toolchain pin");
  }
  if (!Array.isArray(manifest.mutable_mounts)
    || manifest.mutable_mounts.some((item) => !ALLOWED_MUTABLE_MOUNTS.has(item))
    || new Set(manifest.mutable_mounts).size !== manifest.mutable_mounts.length) {
    failures.push("invalid mutable_mounts");
  }
  if (manifest.payload?.hash_algorithm !== "sha256"
    || manifest.payload?.manifest_excluded_from_inventory !== true
    || !/^[0-9a-f]{64}$/u.test(manifest.payload?.digest ?? "")
    || !Array.isArray(manifest.payload?.files)
    || manifest.payload.files.length === 0) {
    failures.push("invalid payload inventory");
    return failures;
  }
  const seen = new Set();
  let previous = null;
  for (const file of manifest.payload.files) {
    let normalized;
    try {
      normalized = normalizeResidentPath(file?.path);
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
      continue;
    }
    if (normalized === RESIDENT_MANIFEST_PATH) failures.push("manifest cannot inventory itself");
    if (manifest.mutable_mounts.some((mount) => normalized === mount || normalized.startsWith(`${mount}/`))) {
      failures.push(`${normalized}: mutable data cannot be immutable payload`);
    }
    if (seen.has(normalized)) failures.push(`${normalized}: duplicate payload path`);
    if (previous !== null && previous.localeCompare(normalized) >= 0) {
      failures.push("payload files are not strictly sorted");
    }
    seen.add(normalized);
    previous = normalized;
    if (!["0644", "0755"].includes(file?.mode)
      || !Number.isSafeInteger(file?.size)
      || file.size < 0
      || !/^[0-9a-f]{64}$/u.test(file?.sha256 ?? "")) {
      failures.push(`${normalized}: invalid payload metadata`);
    }
  }
  return failures;
}

export function normalizeResidentPath(value) {
  if (typeof value !== "string"
    || value === ""
    || isAbsolute(value)
    || value.includes("\\")
    || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`invalid resident path ${String(value)}`);
  }
  const normalized = posix.normalize(value);
  if (normalized !== value
    || normalized === "."
    || normalized === ".."
    || normalized.startsWith("../")
    || value.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error(`resident path escapes or is not canonical: ${value}`);
  }
  return normalized;
}
