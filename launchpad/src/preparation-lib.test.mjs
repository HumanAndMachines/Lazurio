import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareApplication } from "../../lazurio/runtime/preparation-lib.mjs";
import { supportsFileSymlinks } from "../../scripts/test-platform-capabilities.mjs";
const roots = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const linkTest = await supportsFileSymlinks() ? test : test.skip;

for (const invalid of ["traversal", "script", "uv"]) {
  test(`preparation rejects ${invalid} before invoking scripts`, async () => {
    const root = await mkdtemp(join(tmpdir(), "lazurio-preparation-")); roots.push(root);
    await mkdir(join(root, "app/v1"), { recursive: true });
    const packagePath = join(root, "app/v1/package.json");
    const declaration = { schema_version: "lazurio.preparation.v1", owner_package: "app/v1/package.json", check_script: "check:prepared" };
    if (invalid === "traversal") declaration.owner_package = "../outside/package.json";
    if (invalid === "script") declaration.check_script = "postinstall";
    if (invalid === "uv") { declaration.runtime = "uv"; declaration.uv_version = "0.10.0"; }
    await writeFile(packagePath, JSON.stringify({ lazurio: { preparation: declaration }, scripts: { [declaration.check_script]: "echo bad" } }));
    let spawned = false;
    const result = await prepareApplication({ checkoutRoot: root, packagePath, spawnProcess: () => { spawned = true; throw new Error("must not spawn"); } });
    expect(result.ok).toBe(false); expect(spawned).toBe(false);
  });
}

linkTest("a preparation owner symlink cannot execute a package outside the selected checkout", async () => {
  const root = await mkdtemp(join(tmpdir(), "lazurio-preparation-boundary-")); roots.push(root);
  const outside = await mkdtemp(join(tmpdir(), "lazurio-preparation-outside-")); roots.push(outside);
  await mkdir(join(root, "app/v1"), { recursive: true });
  const packagePath = join(root, "app/v1/package.json");
  await writeFile(packagePath, JSON.stringify({ lazurio: { preparation: { schema_version: "lazurio.preparation.v1", owner_package: "app/owner/package.json", check_script: "check:prepared" } } }));
  await writeFile(join(outside, "package.json"), JSON.stringify({ scripts: { "check:prepared": "echo outside" } }));
  await symlink(outside, join(root, "app/owner"), "dir");
  let spawned = false;
  const result = await prepareApplication({ checkoutRoot: root, packagePath, spawnProcess: () => { spawned = true; throw new Error("must not spawn"); } });
  expect(result.ok).toBe(false); expect(spawned).toBe(false);
});
