import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { validateAgainstSchema } from "../runtime/json-schema-mini.mjs";
import schema from "../cli-provenance.v1.schema.json";
import {
  buildLazurioCliProvenance,
  isValidLazurioCliProvenance,
  normalizeComparableCliPath,
  normalizeGitHubRepository,
  trustedGitCandidates,
  trustedGitHubCliCandidates,
  trustedNodeCandidates,
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
  });
  // Git remains the authority for clean/dirty. A linked checkout may inherit
  // platform line-ending policy, but it must still be classified as source.
  expect(typeof result.source.dirty).toBe("boolean");
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
    version: "0.2.0-candidate.7",
    source: {
      repository: "HumanAndMachines/Lazurio",
      commit: "a".repeat(40),
      dirty: null,
    },
    artifact: {
      id: "lazurio-resident-workspace-0.2.0-candidate.7-darwin-arm64",
      profile: "workspace",
      build_channel: "candidate",
      target: "darwin-arm64",
      payload_digest: "b".repeat(64),
    },
  });
  expectValid(result);
});

test("package provenance uses the tracked package identity without inventing offline Git provenance", () => {
  const root = temporaryDirectory("package");
  writeFileSync(join(root, "package.json"), `${JSON.stringify({
    name: "@lazurio/runtime",
    version: "0.0.0-dev.abc123",
    lazurio: {
      schema_version: "lazurio.cli.package.v1",
      source: {
        repository: "HumanAndMachines/Lazurio",
      },
    },
  }, null, 2)}\n`);

  const result = buildLazurioCliProvenance({ root });
  expect(result).toEqual({
    schema_version: "lazurio.cli.provenance.v1",
    product: "lazurio-cli",
    status: "resolved",
    reason: "package_manifest_resolved",
    root_kind: "package",
    root_path: realpathSync.native(resolve(root)),
    verification: "package",
    version: "0.0.0-dev.abc123",
    source: {
      repository: "HumanAndMachines/Lazurio",
      commit: null,
      dirty: null,
    },
    artifact: null,
  });
  expectValid(result);
});

test("package provenance fails closed for invalid Lazurio package metadata", () => {
  const root = temporaryDirectory("invalid-package");
  writeFileSync(join(root, "package.json"), `${JSON.stringify({
    name: "@lazurio/runtime",
    version: "0.0.0-dev.test",
    lazurio: { schema_version: "lazurio.cli.package.v1" },
  })}\n`);
  const result = buildLazurioCliProvenance({ root });
  expect(result).toMatchObject({
    status: "unrecognized",
    root_kind: "package",
    reason: "package_manifest_invalid",
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

  const incomplete = temporaryDirectory("incomplete-resident");
  const incompleteManifest = residentManifest();
  delete incompleteManifest.dependencies;
  writeFileSync(
    join(incomplete, "lazurio.resident.json"),
    `${JSON.stringify(incompleteManifest, null, 2)}\n`,
  );
  expect(buildLazurioCliProvenance({ root: incomplete })).toMatchObject({
    status: "unrecognized",
    root_kind: "resident",
    reason: "resident_manifest_invalid",
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

test("GitHub repository normalization anchors the exact GitHub host", () => {
  expect(normalizeGitHubRepository("git@github.com:HumanAndMachines/Lazurio.git"))
    .toBe("HumanAndMachines/Lazurio");
  expect(normalizeGitHubRepository("https://github.com/HumanAndMachines/Lazurio"))
    .toBe("HumanAndMachines/Lazurio");
  for (const origin of [
    "git@corp-github.com:HumanAndMachines/Lazurio.git",
    "https://mirror-notgithub.com/HumanAndMachines/Lazurio",
    "https://gitlab.example/x/github.com/HumanAndMachines/Lazurio",
    "HumanAndMachines/Lazurio",
  ]) {
    expect(normalizeGitHubRepository(origin)).toBeNull();
  }
});

test("portable Windows paths and trusted executable candidates are deterministic", () => {
  expect(normalizeComparableCliPath("C:\\Users\\Matous\\Lazurio\\", "win32"))
    .toBe(normalizeComparableCliPath("c:/users/matous/lazurio", "win32"));
  expect(normalizeComparableCliPath("\\\\?\\C:\\Users\\Matous\\Lazurio", "win32"))
    .toBe(normalizeComparableCliPath("c:\\users\\matous\\lazurio", "win32"));
  expect(trustedGitCandidates("win32", {
    homeDirectory: "C:\\Users\\Matous",
    environment: {
      PATH: "C:\\Shadow",
      LOCALAPPDATA: "C:\\AttackerControlled",
    },
  })).toEqual([
    "C:\\Program Files\\Git\\cmd\\git.exe",
    "C:\\Program Files\\Git\\bin\\git.exe",
    "C:\\Program Files (x86)\\Git\\cmd\\git.exe",
    "C:\\Program Files (x86)\\Git\\bin\\git.exe",
  ]);
  expect(trustedGitHubCliCandidates("darwin", {
    PATH: "/tmp/shadow",
    homeDirectory: "/Users/fixture",
  })).toEqual([
    "/opt/homebrew/bin/gh",
    "/usr/local/bin/gh",
    "/usr/bin/gh",
    "/Users/fixture/.local/bin/gh",
  ]);
  expect(trustedGitHubCliCandidates("darwin", {
    PATH: "/tmp/shadow",
    homeDirectory: "relative-home",
  })).not.toContain("relative-home/.local/bin/gh");
  expect(trustedGitCandidates("linux", {
    homeDirectory: "/home/fixture",
  })).toContain("/home/fixture/.local/bin/git");
  expect(trustedGitHubCliCandidates("linux", {
    homeDirectory: "/home/fixture",
  })).toContain("/home/fixture/.local/bin/gh");
  expect(trustedNodeCandidates("linux", {
    homeDirectory: "/home/fixture",
  })).toContain("/home/fixture/.local/bin/node");
  expect(trustedGitCandidates("linux", {
    homeDirectory: "relative-home",
  })).not.toContain("relative-home/.local/bin/git");
  expect(trustedGitHubCliCandidates("win32", {
    homeDirectory: "C:\\Users\\Matous",
    environment: {
      PATH: "C:\\Shadow",
      LOCALAPPDATA: "C:\\Users\\Matous\\AppData\\Local",
    },
  })).toEqual([
    "C:\\Program Files\\GitHub CLI\\gh.exe",
    "C:\\Program Files (x86)\\GitHub CLI\\gh.exe",
    "C:\\Users\\Matous\\AppData\\Local\\Programs\\GitHub CLI\\bin\\gh.exe",
    "C:\\Users\\Matous\\AppData\\Local\\Programs\\GitHub CLI\\gh.exe",
  ]);
  expect(trustedNodeCandidates("darwin", {
    homeDirectory: "relative-home",
  })).not.toContain("relative-home/.local/bin/node");
  expect(trustedNodeCandidates("win32", {
    homeDirectory: "C:\\Users\\Matous",
    environment: {
      PATH: "C:\\Users\\Matous\\AppData\\Local\\Programs\\nodejs\\node-v24.20.0-win-x64;C:\\Shadow",
      LOCALAPPDATA: "C:\\Users\\Matous\\AppData\\Local",
    },
  })).toEqual([
    "C:\\Program Files\\nodejs\\node.exe",
    "C:\\Program Files (x86)\\nodejs\\node.exe",
    "C:\\Users\\Matous\\AppData\\Local\\Programs\\nodejs\\node.exe",
    "c:\\users\\matous\\appdata\\local\\programs\\nodejs\\node-v24.20.0-win-x64\\node.exe",
  ]);
  expect(trustedGitCandidates("win32", {
    homeDirectory: "C:\\Users\\Matous",
    environment: { LOCALAPPDATA: "C:\\Users\\Matous\\AppData\\Local" },
  })).toContain("C:\\Users\\Matous\\AppData\\Local\\Programs\\PortableGit\\cmd\\git.exe");
  expect(trustedNodeCandidates("win32", {
    homeDirectory: "C:\\Users\\Matous",
    environment: {
      PATH: "C:\\Tools\\node-v24.20.0-win-x64;C:\\Users\\Matous\\AppData\\Local\\Programs\\nodejs\\custom\\node-v24.20.0-win-x64",
      LOCALAPPDATA: "C:\\Users\\Matous\\AppData\\Local",
    },
  })).not.toContain("C:\\Tools\\node-v24.20.0-win-x64\\node.exe");
});

function expectValid(value) {
  expect(isValidLazurioCliProvenance(value), JSON.stringify(value)).toBe(true);
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
  const dependenciesRoot = resolve(import.meta.dir, "../../distribution/dependencies");
  const hermes = JSON.parse(readFileSync(join(dependenciesRoot, "hermes.json"), "utf8"));
  const gbrain = JSON.parse(readFileSync(join(dependenciesRoot, "gbrain.json"), "utf8"));
  const toolchain = JSON.parse(readFileSync(join(dependenciesRoot, "toolchain.json"), "utf8"));
  return {
    schema_version: "lazurio.resident.manifest.v1",
    artifact_id: "lazurio-resident-workspace-0.2.0-candidate.7-darwin-arm64",
    artifact_version: "0.2.0-candidate.7",
    channel: "candidate",
    profile: "workspace",
    role_overlays: [],
    target: { os: "darwin", arch: "arm64" },
    source: {
      repository: "HumanAndMachines/Lazurio",
      commit: "a".repeat(40),
      commit_epoch: 1_700_000_000,
    },
    build_contract: 1,
    compatibility: { resident_root: 1, rollback_from: [1] },
    dependencies: {
      hermes: {
        repository: hermes.repository,
        release_tag: hermes.release_tag,
        commit: hermes.commit,
        lock_sha256: hermes.lock_sha256,
      },
      gbrain: {
        repository: gbrain.repository,
        release_tag: gbrain.release_tag,
        version: gbrain.version,
        commit: gbrain.commit,
        lock_sha256: gbrain.lock_sha256,
        engine: gbrain.runtime.engine,
        transport: gbrain.runtime.transport,
      },
      toolchain: {
        bun: toolchain.tools.bun.version,
        uv: toolchain.tools.uv.version,
      },
    },
    mutable_mounts: ["organizations", "personalspace"],
    payload: {
      hash_algorithm: "sha256",
      digest: "b".repeat(64),
      manifest_excluded_from_inventory: true,
      files: [{
        path: "package.json",
        mode: "0644",
        size: 2,
        sha256: "c".repeat(64),
      }],
    },
  };
}
