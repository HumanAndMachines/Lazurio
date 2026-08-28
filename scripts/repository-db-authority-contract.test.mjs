import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readMissionControlRepositoryDbAuthority } from "./repository-db-authority-contract.mjs";

const cleanup = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("Mission Control repository-db authority", () => {
  test("accepts the canonical repository-db.yaml contract", async () => {
    const root = await fixture();
    await writeFile(join(root, "repository-db.yaml"), canonicalConfig, "utf8");

    expect(readMissionControlRepositoryDbAuthority(root)).toMatchObject({
      markerName: "repository-db.yaml",
      dataRoot: "data/mission-control",
    });
  });

  test("keeps the legacy manifest as an explicit migration seam", async () => {
    const root = await fixture();
    await writeFile(join(root, "repository-db.manifest.json"), `${JSON.stringify({
      schema_version: "companiesascode.repository_db.manifest.v1",
      data_mode: "repository-db",
      data_root: "data/mission-control",
    })}\n`, "utf8");

    expect(readMissionControlRepositoryDbAuthority(root)).toMatchObject({
      markerName: "repository-db.manifest.json",
      dataRoot: "data/mission-control",
    });
  });

  test("fails closed when canonical and legacy authorities coexist", async () => {
    const root = await fixture();
    await writeFile(join(root, "repository-db.yaml"), canonicalConfig, "utf8");
    await writeFile(join(root, "repository-db.manifest.json"), "{}\n", "utf8");

    expect(() => readMissionControlRepositoryDbAuthority(root)).toThrow("coexist");
  });

  test("rejects a symlinked authority marker", async () => {
    const root = await fixture();
    const external = join(root, "external.yaml");
    await writeFile(external, canonicalConfig, "utf8");
    await symlink(external, join(root, "repository-db.yaml"));

    expect(() => readMissionControlRepositoryDbAuthority(root)).toThrow("not a regular file");
  });
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "repository-db-authority-"));
  cleanup.push(root);
  return root;
}

const canonicalConfig = `schema_version: repository-db.config.v1
app: mission-control
schema:
  name: mission-control-data
layout:
  data: data
`;
