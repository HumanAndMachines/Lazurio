import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildServerIdentity } from "./server-identity-lib.mjs";
import {
  buildServerLocator,
  readServerLocator,
  readServerLocatorIfPresent,
  serverLocatorPath,
  validateServerLocator,
  writeServerLocator,
} from "./server-locator-lib.mjs";

const roots = [];

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

test("server locator publishes the exact active loopback origin atomically", async () => {
  const root = await temporaryRoot();
  await mkdir(join(root, "launchpad"));
  const identity = fixtureIdentity();

  const published = await writeServerLocator({
    workspaceRoot: root,
    origin: "http://127.0.0.1:4175",
    identity,
  });

  expect(published.path).toBe(serverLocatorPath(root));
  expect(await readServerLocator({ workspaceRoot: root })).toEqual(published.locator);
  expect(JSON.parse(await readFile(published.path, "utf8"))).toMatchObject({
    schema_version: "lazurio.server.locator.v1",
    origin: "http://127.0.0.1:4175",
    root_id: identity.root_id,
    instance_id: identity.instance_id,
  });
});

test("optional locator read distinguishes a clean first start from invalid state", async () => {
  const root = await temporaryRoot();
  await mkdir(join(root, "launchpad"));
  expect(await readServerLocatorIfPresent({ workspaceRoot: root })).toBeNull();

  await mkdir(join(root, "launchpad", ".local"));
  await writeFile(serverLocatorPath(root), "{ malformed", "utf8");
  await expect(readServerLocatorIfPresent({ workspaceRoot: root })).rejects.toThrow(
    "cannot be read",
  );
});

test("server locator rejects ambient URLs and unknown fields", () => {
  const locator = buildServerLocator({
    origin: "http://localhost:4174",
    identity: fixtureIdentity(),
  });
  expect(() => buildServerLocator({
    origin: "https://launchpad.example.com",
    identity: fixtureIdentity(),
  })).toThrow("clean loopback HTTP origin");
  expect(validateServerLocator({ ...locator, token: "must-not-persist" })).toContain("unknown property: token");
});

test("server locator refuses to write through a symlinked local directory", async () => {
  const root = await temporaryRoot();
  const external = await temporaryRoot();
  await mkdir(join(root, "launchpad"));
  await symlink(external, join(root, "launchpad", ".local"));

  await expect(writeServerLocator({
    workspaceRoot: root,
    origin: "http://127.0.0.1:4174",
    identity: fixtureIdentity(),
  })).rejects.toThrow("must be a physical directory");
});

function fixtureIdentity() {
  return buildServerIdentity({
    rootId: "1".repeat(64),
    installGeneration: "2".repeat(64),
    instanceId: "2a6db6d3-ad60-42b7-b6a8-e522ac838284",
    pid: 1234,
    startedAt: "2026-08-23T12:00:00.000Z",
  });
}

async function temporaryRoot() {
  const root = await mkdtemp(join(tmpdir(), "lazurio-server-locator-"));
  roots.push(root);
  return root;
}
