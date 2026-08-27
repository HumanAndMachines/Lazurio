import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LAZURIO_SERVER_IDENTITY_SCHEMA,
  LAZURIO_SERVER_PRODUCT,
  buildServerIdentity,
  classifyServerIdentity,
  computeServerInstallGeneration,
  computeServerRootId,
  isValidServerIdentity,
  resolveCanonicalServerRoot,
  serverInstallGenerationInputPaths,
} from "./server-identity-lib.mjs";

const tempRoots = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("server identity separates root, install generation, and process instance", () => {
  const rootId = computeServerRootId("/canonical/example-root");
  const installGeneration = "a".repeat(64);
  const instanceId = randomUUID();
  const identity = buildServerIdentity({
    rootId,
    controlRootId: rootId,
    installGeneration,
    instanceId,
    pid: 42,
    startedAt: "2026-08-18T19:00:00.000Z",
    requestTrustProfile: "local",
  });

  expect(identity).toEqual({
    schema_version: LAZURIO_SERVER_IDENTITY_SCHEMA,
    product: LAZURIO_SERVER_PRODUCT,
    root_id: rootId,
    control_root_id: rootId,
    install_generation: installGeneration,
    instance_id: instanceId,
    pid: 42,
    started_at: "2026-08-18T19:00:00.000Z",
    request_trust_profile: "local",
  });
  expect(isValidServerIdentity(identity)).toBe(true);
  expect(Object.isFrozen(identity)).toBe(true);
  expect(() => buildServerIdentity({ ...identity, rootId: "not-a-hash" })).toThrow();
  expect(() => buildServerIdentity({
    rootId,
    controlRootId: rootId,
    installGeneration,
    instanceId,
    pid: 42,
    startedAt: "2026-08-18T19:00:00.000Z",
    requestTrustProfile: "foreign",
  })).toThrow();
});

test("Windows root identity normalizes equivalent casing, separators and namespace prefixes", () => {
  const expected = computeServerRootId("C:\\Users\\Builder\\Lazurio", "win32");
  expect(computeServerRootId("c:/users/builder/lazurio/", "win32")).toBe(expected);
  expect(computeServerRootId("\\\\?\\C:\\USERS\\BUILDER\\LAZURIO", "win32")).toBe(expected);

  const unc = computeServerRootId("\\\\server\\share\\Lazurio", "win32");
  expect(computeServerRootId("\\\\?\\UNC\\SERVER\\SHARE\\LAZURIO\\", "win32")).toBe(unc);
});

test("linked worktree resolves to the verified canonical main Root", async () => {
  const primaryRoot = await mkdtemp(join(tmpdir(), "lazurio-primary-root-"));
  const linkedRoot = await mkdtemp(join(tmpdir(), "lazurio-linked-root-"));
  tempRoots.push(primaryRoot, linkedRoot);
  const commonDirectory = join(primaryRoot, ".git");
  const worktreeGitDirectory = join(commonDirectory, "worktrees", "feature");
  await mkdir(worktreeGitDirectory, { recursive: true });
  await writeFile(join(linkedRoot, ".git"), `gitdir: ${worktreeGitDirectory}\n`);
  await writeFile(join(worktreeGitDirectory, "commondir"), "../..\n");

  const canonicalPrimaryRoot = await realpath(primaryRoot);
  expect(resolveCanonicalServerRoot(linkedRoot)).toBe(canonicalPrimaryRoot);
  expect(resolveCanonicalServerRoot(primaryRoot)).toBe(canonicalPrimaryRoot);
});

test("nested linked worktree resolves a primary Root with a separate Git directory", async () => {
  const primaryRoot = await mkdtemp(join(tmpdir(), "lazurio-separate-git-primary-"));
  const commonDirectory = await mkdtemp(join(tmpdir(), "lazurio-separate-git-common-"));
  const linkedRoot = join(primaryRoot, ".worktrees", "root", "feature");
  const worktreeGitDirectory = join(commonDirectory, "worktrees", "feature");
  tempRoots.push(primaryRoot, commonDirectory);
  await mkdir(linkedRoot, { recursive: true });
  await mkdir(worktreeGitDirectory, { recursive: true });
  await writeFile(join(primaryRoot, ".git"), `gitdir: ${commonDirectory}\n`);
  await writeFile(join(linkedRoot, ".git"), `gitdir: ${worktreeGitDirectory}\n`);
  await writeFile(join(worktreeGitDirectory, "commondir"), "../..\n");

  const canonicalPrimaryRoot = await realpath(primaryRoot);
  expect(resolveCanonicalServerRoot(primaryRoot)).toBe(canonicalPrimaryRoot);
  expect(resolveCanonicalServerRoot(linkedRoot)).toBe(canonicalPrimaryRoot);
});

test("directory-only Root remains canonical without inventing Git ownership", async () => {
  const root = await mkdtemp(join(tmpdir(), "lazurio-directory-root-"));
  tempRoots.push(root);
  expect(resolveCanonicalServerRoot(root)).toBe(await realpath(root));
});

test("install generation hashes one deterministic cross-platform source set", async () => {
  const root = await sourceFixture();
  const initial = computeServerInstallGeneration(root);
  expect(initial).toMatch(/^[a-f0-9]{64}$/);
  expect(computeServerInstallGeneration(root)).toBe(initial);

  await writeFile(join(root, "launchpad", "src", "server.test.mjs"), "ignored test change\n");
  expect(computeServerInstallGeneration(root)).toBe(initial);

  await writeFile(join(root, "launchpad", "public", "app.js"), "export const ui = 2;\n");
  expect(computeServerInstallGeneration(root)).not.toBe(initial);

  await writeFile(join(root, "lazurio", "core", "contract.mjs"), "export const value = 2;\n");
  expect(computeServerInstallGeneration(root)).not.toBe(initial);

  const coreChanged = computeServerInstallGeneration(root);
  await writeFile(join(root, "lazurio", "runtime", "runtime.mjs"), "export const runtime = 2;\n");
  expect(computeServerInstallGeneration(root)).not.toBe(coreChanged);

  const runtimeChanged = computeServerInstallGeneration(root);
  await writeFile(join(root, "lazurio", "schemas", "runtime.json"), "{\"version\":2}\n");
  expect(computeServerInstallGeneration(root)).not.toBe(runtimeChanged);

  const schemaChanged = computeServerInstallGeneration(root);
  await writeFile(join(root, "scripts", "worktree-create-lib.mjs"), "export const create = 2;\n");
  expect(computeServerInstallGeneration(root)).not.toBe(schemaChanged);
  expect(serverInstallGenerationInputPaths(root)).toEqual([
    "launchpad/package.json",
    "launchpad/public/app.js",
    "launchpad/src/server.mjs",
    "lazurio/core/contract.mjs",
    "lazurio/runtime/runtime.mjs",
    "lazurio/schemas/runtime.json",
    "scripts/worktree-create-lib.mjs",
    "scripts/worktree-create-lock.mjs",
  ]);
});

test("installed runtime generation comes from the immutable artifact digest", async () => {
  const root = await mkdtemp(join(tmpdir(), "lazurio-runtime-generation-"));
  tempRoots.push(root);
  const digest = "d".repeat(64);
  await writeFile(join(root, "lazurio.resident.json"), JSON.stringify({
    schema_version: "lazurio.resident.manifest.v1",
    payload: { digest },
  }));
  expect(computeServerInstallGeneration(root)).toBe(digest);
});

test("classifier never reuses stale, foreign, malformed, or legacy same-root servers", () => {
  const expected = {
    rootId: "1".repeat(64),
    controlRootId: "5".repeat(64),
    installGeneration: "2".repeat(64),
  };
  const compatible = identity({
    root_id: expected.rootId,
    install_generation: expected.installGeneration,
  });

  expect(classifyServerIdentity({ observed: compatible, expected })).toBe("compatible");
  const { control_root_id: _controlRootId, ...preControlRoot } = compatible;
  expect(classifyServerIdentity({ observed: preControlRoot, expected })).toBe("stale_install");
  expect(classifyServerIdentity({
    observed: { ...preControlRoot, instance_id: "not-an-instance-id" },
    expected,
  })).toBe("protocol_incompatible");
  expect(classifyServerIdentity({
    observed: { ...compatible, control_root_id: "6".repeat(64) },
    expected,
  })).toBe("stale_install");
  expect(classifyServerIdentity({
    observed: { ...compatible, install_generation: "3".repeat(64) },
    expected,
  })).toBe("stale_install");
  expect(classifyServerIdentity({
    observed: { ...compatible, root_id: "4".repeat(64) },
    expected,
  })).toBe("foreign_root");
  expect(classifyServerIdentity({
    observed: { ...compatible, schema_version: "lazurio.server.identity.v2" },
    expected,
  })).toBe("protocol_incompatible");
  expect(classifyServerIdentity({
    observed: { ...compatible, instance_id: "invalid" },
    expected,
  })).toBe("protocol_incompatible");
  expect(classifyServerIdentity({
    legacyObserved: {
      schema_version: "companiesascode.launchpad.identity.v1",
      root_id: expected.rootId,
    },
    expected,
  })).toBe("legacy_same_root");
  expect(classifyServerIdentity({
    legacyObserved: {
      schema_version: "companiesascode.launchpad.identity.v1",
      root_id: "4".repeat(64),
    },
    expected,
  })).toBe("foreign_root");
  expect(classifyServerIdentity({ observed: { status: "ok" }, expected })).toBe("unrecognized");
});

async function sourceFixture() {
  const root = await mkdtemp(join(tmpdir(), "lazurio-server-generation-"));
  tempRoots.push(root);
  await mkdir(join(root, "launchpad", "src"), { recursive: true });
  await mkdir(join(root, "launchpad", "public"), { recursive: true });
  await mkdir(join(root, "lazurio", "core"), { recursive: true });
  await mkdir(join(root, "lazurio", "runtime"), { recursive: true });
  await mkdir(join(root, "lazurio", "schemas"), { recursive: true });
  await mkdir(join(root, "scripts"), { recursive: true });
  await writeFile(join(root, "launchpad", "package.json"), '{"name":"launchpad"}\n');
  await writeFile(join(root, "launchpad", "src", "server.mjs"), "export const server = true;\n");
  await writeFile(join(root, "launchpad", "src", "server.test.mjs"), "ignored test\n");
  await writeFile(join(root, "launchpad", "public", "app.js"), "export const ui = 1;\n");
  await writeFile(join(root, "lazurio", "core", "contract.mjs"), "export const value = 1;\n");
  await writeFile(join(root, "lazurio", "runtime", "runtime.mjs"), "export const runtime = 1;\n");
  await writeFile(join(root, "lazurio", "schemas", "runtime.json"), "{\"version\":1}\n");
  await writeFile(join(root, "scripts", "worktree-create-lib.mjs"), "export const create = 1;\n");
  await writeFile(join(root, "scripts", "worktree-create-lock.mjs"), "export const lock = 1;\n");
  return root;
}

function identity(overrides = {}) {
  return {
    schema_version: LAZURIO_SERVER_IDENTITY_SCHEMA,
    product: LAZURIO_SERVER_PRODUCT,
    root_id: "1".repeat(64),
    control_root_id: "5".repeat(64),
    install_generation: "2".repeat(64),
    instance_id: "2a6db6d3-ad60-42b7-b6a8-e522ac838284",
    pid: 42,
    started_at: "2026-08-18T19:00:00.000Z",
    ...overrides,
  };
}
