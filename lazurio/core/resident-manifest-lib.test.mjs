import { expect, test } from "bun:test";

import {
  normalizeResidentPath,
  validateResidentManifest,
} from "./resident-manifest-lib.mjs";

test("Resident path normalization remains fail-closed in Core", () => {
  expect(normalizeResidentPath("lazurio/cli.mjs")).toBe("lazurio/cli.mjs");
  for (const path of ["", "../secret", "a/../secret", "/absolute", "a\\windows"]) {
    expect(() => normalizeResidentPath(path)).toThrow();
  }
});

test("complete Resident validator rejects partial identity-only manifests", () => {
  expect(validateResidentManifest({
    schema_version: "lazurio.resident.manifest.v1",
    artifact_id: "lazurio-resident-workspace-0.2.0-nightly.7-darwin-arm64",
    artifact_version: "0.2.0-nightly.7",
    channel: "nightly",
    profile: "workspace",
    target: { os: "darwin", arch: "arm64" },
    source: { repository: "HumanAndMachines/Lazurio", commit: "a".repeat(40) },
    payload: { digest: "b".repeat(64) },
  })).toEqual(expect.arrayContaining([
    "invalid role_overlays",
    "invalid build_contract",
    "invalid compatibility contract",
    "invalid source provenance",
    "invalid Hermes dependency pin",
    "invalid GBrain dependency pin",
    "invalid Resident toolchain pin",
    "invalid mutable_mounts",
    "invalid payload inventory",
  ]));
});
