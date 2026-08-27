import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  inspectDirectoryWithinCanonicalBoundary,
  readJsonWithinCanonicalBoundary,
} from "./path-boundary-lib.mjs";

const cleanup = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

test("authority JSON is read from one verified file handle", async () => {
  const root = await mkdtemp(join(tmpdir(), "lazurio-json-authority-"));
  cleanup.push(root);
  const path = join(root, "config.json");
  await writeFile(path, JSON.stringify({ safe: true }));

  expect(await readJsonWithinCanonicalBoundary({
    rootPath: root,
    targetPath: path,
    label: "config.json",
  })).toMatchObject({ value: { safe: true } });
});

test("authority JSON rejects a parent directory junction outside its owner", async () => {
  const root = await mkdtemp(join(tmpdir(), "lazurio-json-boundary-"));
  const foreign = await mkdtemp(join(tmpdir(), "lazurio-json-foreign-"));
  cleanup.push(root, foreign);
  await writeFile(join(foreign, "config.json"), JSON.stringify({ leaked: true }));
  await mkdir(join(root, "nested"), { recursive: true });
  await rm(join(root, "nested"), { recursive: true });
  await symlink(foreign, join(root, "nested"), process.platform === "win32" ? "junction" : "dir");

  await expect(readJsonWithinCanonicalBoundary({
    rootPath: root,
    targetPath: join(root, "nested", "config.json"),
    label: "config.json",
  })).rejects.toThrow("odkazuje mimo vybraný checkout");
});

test("directory identity recheck rejects a junction swapped in after initial inspection", async () => {
  const root = await mkdtemp(join(tmpdir(), "lazurio-directory-authority-"));
  const foreign = await mkdtemp(join(tmpdir(), "lazurio-directory-foreign-"));
  cleanup.push(root, foreign);
  const target = join(root, "node_modules");
  await mkdir(target);

  const boundary = await inspectDirectoryWithinCanonicalBoundary({
    rootPath: root,
    targetPath: target,
    beforeIdentityRecheck: async () => {
      await rm(target, { recursive: true });
      await symlink(foreign, target, process.platform === "win32" ? "junction" : "dir");
    },
  });

  expect(boundary.ok).toBe(false);
});
