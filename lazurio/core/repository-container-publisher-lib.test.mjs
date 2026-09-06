import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile, readdir, lstat, rename, symlink, rm } from "node:fs/promises";
import { openSync, closeSync, constants } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectRepositoryContainer, publishRepositoryContainer, renameExclusive } from "./repository-container-publisher-lib.mjs";

const roots = [];
const macTest = process.platform === "darwin" ? test : test.skip;
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "lazurio-db-parent-")); roots.push(root);
  const stage = join(root, "stage"); const target = join(root, "target");
  await mkdir(join(stage, "app"), { recursive: true });
  await mkdir(join(stage, ".git"));
  await writeFile(join(stage, "app/main.mjs"), "source");
  await writeFile(join(stage, ".git/HEAD"), "ref: refs/heads/main\n");
  await writeFile(join(stage, ".gitignore"), "db/\n");
  await mkdir(join(target, "db"), { recursive: true });
  await writeFile(join(target, "db/data"), "canonical");
  return { root, stage, target, expected: inspectRepositoryContainer(target, "db") };
}
macTest("native exclusive publication keeps db inode and activates Git last", async () => {
  const { stage, target, expected } = await fixture();
  const published = [];
  const result = await publishRepositoryContainer({ stagingPath: stage, targetPath: target, expectedContainer: expected, beforeMove: async ({ name }) => {
    expect((await readdir(target)).includes(".git")).toBe(false);
    published.push(name);
  } });
  expect(result).toEqual({ ok: true });
  expect(published.at(-1)).toBe(".git");
  expect((await lstat(join(target, "db"))).ino).toBe(expected.child.ino);
  expect(await readFile(join(target, "db/data"), "utf8")).toBe("canonical");
  expect(await readFile(join(target, "app/main.mjs"), "utf8")).toBe("source");
  // Retain the empty stage: pathname cleanup could remove a raced replacement.
  expect(await readdir(stage)).toEqual([]);
});
for (const faultIndex of [0, 1, 2]) macTest(`publication failure at step ${faultIndex} rolls back only newly created app entries`, async () => {
  const { stage, target, expected } = await fixture();
  const result = await publishRepositoryContainer({ stagingPath: stage, targetPath: target, expectedContainer: expected, beforeMove: async ({ index }) => {
    if (index === faultIndex) throw new Error("injected");
  } });
  expect(result.ok).toBe(false);
  expect(await readdir(target)).toEqual(["db"]);
  expect((await lstat(join(target, "db"))).ino).toBe(expected.child.ino);
  expect(await readFile(join(target, "db/data"), "utf8")).toBe("canonical");
});
macTest("a concurrent unknown target is preserved and previous published entries roll back", async () => {
  const { stage, target, expected } = await fixture();
  const result = await publishRepositoryContainer({ stagingPath: stage, targetPath: target, expectedContainer: expected, beforeMove: async ({ index }) => {
    if (index === 1) await mkdir(join(target, "app"));
  } });
  expect(result.ok).toBe(false);
  expect((await readdir(target)).sort()).toEqual(["app", "db"]);
  expect(await readdir(join(target, "app"))).toEqual([]);
});
macTest("concurrent edits inside our app directory survive rollback", async () => {
  const { stage, target, expected } = await fixture();
  const result = await publishRepositoryContainer({ stagingPath: stage, targetPath: target, expectedContainer: expected, beforeMove: async ({ name }) => {
    if (name === ".git") await writeFile(join(target, "app/other-person.txt"), "preserve me");
  } });
  expect(result.ok).toBe(false);
  expect(result.preserveStaging).toBe(true);
  expect(await readFile(join(target, "app/other-person.txt"), "utf8")).toBe("preserve me");
  expect((await readdir(target)).includes(".git")).toBe(false);
});
macTest("a target symlink swap cannot redirect writes or rollback", async () => {
  const { root, stage, target, expected } = await fixture();
  const original = join(root, "original"); const outsider = join(root, "outsider");
  await mkdir(outsider);
  const result = await publishRepositoryContainer({ stagingPath: stage, targetPath: target, expectedContainer: expected, beforeMove: async ({ index }) => {
    if (index === 1) { await rename(target, original); await symlink(outsider, target); }
  } });
  expect(result.ok).toBe(false);
  expect(await readdir(outsider)).toEqual([]);
  expect(await readdir(original)).toEqual(["db"]);
  expect((await lstat(join(original, "db"))).ino).toBe(expected.child.ino);
});
test("unsupported recovery platforms fail before touching paths", async () => {
  expect(await publishRepositoryContainer({ platform: "linux" })).toEqual({ ok: false, code: "repository_parent_recovery_platform_unsupported" });
});

macTest("a swapped staging path preserves both pinned recovery and foreign contents", async () => {
  const { root, stage, target, expected } = await fixture();
  const originalStage = join(root, "original-stage");
  const result = await publishRepositoryContainer({ stagingPath: stage, targetPath: target, expectedContainer: expected, beforeMove: async ({ index }) => {
    if (index === 1) {
      await rename(stage, originalStage);
      await mkdir(stage);
      await writeFile(join(stage, "foreign.txt"), "preserve");
    }
  } });
  expect(result.ok).toBe(false);
  expect(result.preserveStaging).toBe(true);
  expect(await readFile(join(stage, "foreign.txt"), "utf8")).toBe("preserve");
  expect(await readFile(join(originalStage, ".gitignore"), "utf8")).toBe("db/\n");
  expect(await readdir(target)).toEqual(["db"]);
  expect((await lstat(join(target, "db"))).ino).toBe(expected.child.ino);
});

macTest("a raced Git activation stays quarantined when the app publication rolls back", async () => {
  const { stage, target, expected } = await fixture();
  const result = await publishRepositoryContainer({ stagingPath: stage, targetPath: target, expectedContainer: expected, afterMove: async ({ name }) => {
    if (name === ".git") await writeFile(join(target, ".git/foreign.txt"), "preserve Git edit");
  } });
  expect(result.ok).toBe(false);
  expect(result.preserveStaging).toBe(true);
  expect(await readdir(target)).toEqual(["db"]);
  expect(await readFile(join(stage, ".git/foreign.txt"), "utf8")).toBe("preserve Git edit");
  expect((await lstat(join(target, "db"))).ino).toBe(expected.child.ino);
});

macTest("the native syscall refuses an already present empty directory without an existence check", async () => {
  const { stage, target } = await fixture();
  await mkdir(join(target, "app"));
  const before = await lstat(join(target, "app"));
  const sourceFd = openSync(stage, constants.O_RDONLY | constants.O_DIRECTORY);
  const targetFd = openSync(target, constants.O_RDONLY | constants.O_DIRECTORY);
  try { expect(() => renameExclusive(sourceFd, "app", targetFd, "app")).toThrow("repository_parent_exclusive_publish_refused"); }
  finally { closeSync(sourceFd); closeSync(targetFd); }
  expect((await lstat(join(target, "app"))).ino).toBe(before.ino);
  expect(await readdir(join(target, "app"))).toEqual([]);
  expect(await readFile(join(stage, "app/main.mjs"), "utf8")).toBe("source");
});
