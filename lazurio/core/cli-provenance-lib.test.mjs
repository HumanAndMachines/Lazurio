import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { validateAgainstSchema } from "../../launchpad/src/json-schema-mini.mjs";
import schema from "../cli-provenance.v1.schema.json";
import {
  buildLazurioCliProvenance,
  isValidLazurioCliProvenance,
  normalizeComparableCliPath,
  trustedGitCandidates,
} from "./cli-provenance-lib.mjs";

const cleanup = [];

afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

test("source provenance comes directly from clean and dirty Git state", () => {
  const root = gitFixture("source");
  git(root, ["remote", "add", "origin", "git@github.com:HumanAndMachines/Lazurio.git"]);

  const clean = buildLazurioCliProvenance({ root });
  expect(clean).toMatchObject({
    schema_version: "lazurio.cli.provenance.v1",
    status: "resolved",
    root_kind: "source",
    verification: "git",
    channel: "development",
    source: {
      repository: "HumanAndMachines/Lazurio",
      dirty: false,
    },
    artifact: null,
  });
  expect(clean.version).toBe(`0.0.0-development.${clean.source.commit.slice(0, 12)}`);
  expectValid(clean);

  writeFileSync(join(root, "tracked.txt"), "changed\n", "utf8");
  expect(buildLazurioCliProvenance({ root }).source.dirty).toBe(true);
  git(root, ["checkout", "--", "tracked.txt"]);
  writeFileSync(join(root, "untracked.txt"), "draft\n", "utf8");
  expect(buildLazurioCliProvenance({ root }).source.dirty).toBe(true);
});

test("linked worktree is valid development provenance but never a fake Resident", () => {
  const repository = gitFixture("repository");
  const worktree = join(repository, "..", "linked worktree Ž");
  git(repository, ["worktree", "add", "-b", "agent/provenance-test", worktree]);
  cleanup.push(worktree);

  const result = buildLazurioCliProvenance({ root: worktree });
  expect(result).toMatchObject({
    status: "resolved",
    root_kind: "source",
    channel: "development",
    source: { dirty: false },
  });
  expectValid(result);
});

test("Resident provenance reads immutable manifest metadata without claiming payload verification", () => {
  const root = temporaryDirectory("resident");
  const manifest = residentManifest();
  writeFileSync(join(root, "lazurio.resident.json"), `${JSON.stringify(manifest, null, 2)}\n`);

  const result = buildLazurioCliProvenance({ root });
  expect(result).toEqual({
    schema_version: "lazurio.cli.provenance.v1",
    product: "lazurio-cli",
    status: "resolved",
    reason: "resident_manifest_resolved",
    root_kind: "resident",
    root_path: realpathSync.native(resolve(root)),
    verification: "manifest",
    channel: "nightly",
    version: "0.2.0-nightly.7",
    source: {
      repository: "HumanAndMachines/Lazurio",
      commit: "a".repeat(40),
      dirty: null,
    },
    artifact: {
      id: "lazurio-resident-workspace-0.2.0-nightly.7-darwin-arm64",
      profile: "workspace",
      target: "darwin-arm64",
      payload_digest: "b".repeat(64),
    },
  });
  expectValid(result);
});

test("classifier fails closed for conflicts, invalid manifests and directory-only roots", () => {
  const conflict = temporaryDirectory("conflict");
  mkdirSync(join(conflict, ".git"));
  writeFileSync(join(conflict, "lazurio.resident.json"), `${JSON.stringify(residentManifest())}\n`);
  expect(buildLazurioCliProvenance({ root: conflict })).toMatchObject({
    status: "conflict",
    root_kind: "conflict",
    reason: "source_and_resident_metadata",
  });

  const invalid = temporaryDirectory("invalid-resident");
  writeFileSync(join(invalid, "lazurio.resident.json"), "{not-json\n");
  expect(buildLazurioCliProvenance({ root: invalid })).toMatchObject({
    status: "unrecognized",
    root_kind: "resident",
    reason: "resident_manifest_invalid_json",
  });

  const directoryOnly = temporaryDirectory("directory-only");
  const unknown = buildLazurioCliProvenance({ root: directoryOnly });
  expect(unknown).toMatchObject({
    status: "unrecognized",
    root_kind: "unknown",
    reason: "metadata_missing",
    version: null,
  });
  expectValid(unknown);
});

test("source marker reports missing Git as structured unrecognized state", () => {
  const root = gitFixture("git-unavailable");
  const result = buildLazurioCliProvenance({ root, gitExecutable: null });
  expect(result).toMatchObject({
    status: "unrecognized",
    root_kind: "source",
    reason: "git_unavailable",
    verification: "none",
  });
  expectValid(result);
});

test("GitHub repository normalization never echoes a credential-bearing origin", () => {
  const root = gitFixture("credential-origin");
  git(root, ["remote", "add", "origin", "https://secret@example.invalid/private/repo.git"]);
  const result = buildLazurioCliProvenance({ root });
  expect(result.status).toBe("resolved");
  expect(result.source.repository).toBeNull();
  expect(JSON.stringify(result)).not.toContain("secret");
  expectValid(result);
});

test("portable Windows paths and per-user Git candidates are deterministic", () => {
  expect(normalizeComparableCliPath("C:\\Users\\Matous\\Lazurio\\", "win32"))
    .toBe(normalizeComparableCliPath("c:/users/matous/lazurio", "win32"));
  expect(normalizeComparableCliPath("\\\\?\\C:\\Users\\Matous\\Lazurio", "win32"))
    .toBe(normalizeComparableCliPath("c:\\users\\matous\\lazurio", "win32"));
  expect(trustedGitCandidates("win32", { LOCALAPPDATA: "C:\\Users\\Matous\\AppData\\Local" }))
    .toContain("C:\\Users\\Matous\\AppData\\Local\\Programs\\Git\\cmd\\git.exe");
  expect(trustedGitCandidates("win32", { LOCALAPPDATA: "relative" }))
    .not.toContain("relative\\Programs\\Git\\cmd\\git.exe");
});

function expectValid(value) {
  expect(isValidLazurioCliProvenance(value)).toBe(true);
  expect(validateAgainstSchema(value, schema, "provenance")).toEqual([]);
}

function temporaryDirectory(label) {
  const path = mkdtempSync(join(tmpdir(), `lazurio-provenance-${label}-`));
  cleanup.push(path);
  return path;
}

function gitFixture(label) {
  const root = temporaryDirectory(label);
  git(root, ["init"]);
  git(root, ["config", "user.name", "Lazurio Test"]);
  git(root, ["config", "user.email", "lazurio-test@example.invalid"]);
  writeFileSync(join(root, "tracked.txt"), "initial\n", "utf8");
  git(root, ["add", "tracked.txt"]);
  git(root, ["commit", "-m", "fixture"]);
  return root;
}

function git(root, args) {
  const result = spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    shell: false,
    windowsHide: true,
  });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
}

function residentManifest() {
  return {
    schema_version: "lazurio.resident.manifest.v1",
    artifact_id: "lazurio-resident-workspace-0.2.0-nightly.7-darwin-arm64",
    artifact_version: "0.2.0-nightly.7",
    channel: "nightly",
    profile: "workspace",
    target: { os: "darwin", arch: "arm64" },
    source: { repository: "HumanAndMachines/Lazurio", commit: "a".repeat(40) },
    payload: { digest: "b".repeat(64) },
  };
}
