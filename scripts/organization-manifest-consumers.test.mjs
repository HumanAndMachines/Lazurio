import { expect, test } from "bun:test";
import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";

const root = join(import.meta.dirname, "..");
const normalizedConsumers = [
  ".agents/skills/worktree-development-discipline/scripts/worktree-inventory.mjs",
  ".claude/skills/worktree-development-discipline/scripts/worktree-inventory.mjs",
  "launchpad/src/workspace-parity-runner.mjs",
  "lazurio/lib.mjs",
  "lazurio/module-port-lib.mjs",
  "lazurio/module-setup-lib.mjs",
  "lazurio/runtime/diagnostics-lib.mjs",
  "lazurio/runtime/discovery-lib.mjs",
  "lazurio/runtime/doctor-children-lib.mjs",
  "lazurio/runtime/git-inventory-lib.mjs",
  "lazurio/runtime/lazurio-update-lib.mjs",
  "lazurio/runtime/module-location-repair-lib.mjs",
  "lazurio/runtime/runtime-lib.mjs",
  "lazurio/search-lib.mjs",
  "scripts/check-organization-agents-instance.mjs",
  "scripts/lazurio-module-inventory.mjs",
  "scripts/mission-control-trust-smoke.mjs",
  "scripts/worktree-create.mjs",
];

const compatibilityReaders = new Set([
  "lazurio/core/organization-root-reader-lib.mjs",
  "lazurio/organization-activation-lib.mjs",
  "lazurio/organization-install-lib.mjs",
]);

const compatibilityWriters = new Set([
  "lazurio/core/organization-activation-lib.mjs",
  "lazurio/core/organization-scaffold-lib.mjs",
  "scripts/gen2-gen3-sync-inventory.mjs",
]);

test("every Organization consumer imports the single Core filesystem adapter", async () => {
  for (const path of normalizedConsumers) {
    const source = await readFile(join(root, path), "utf8");
    expect(source, path).toContain("organization-root-reader-lib.mjs");
  }
});

test("active source has no unmanaged direct legacy compatibility projection reader", async () => {
  const sourceFiles = await collectSourceFiles(root, [".agents", ".claude", "launchpad", "lazurio", "scripts"]);
  const violations = [];
  for (const absolutePath of sourceFiles) {
    const path = relative(root, absolutePath).replaceAll("\\", "/");
    if (path.endsWith(".test.mjs") || compatibilityReaders.has(path) || compatibilityWriters.has(path)) continue;
    const source = await readFile(absolutePath, "utf8");
    const directRead = /(?:Bun\.file|readFile(?:Sync)?|readJson|existsSync|access|stat|lstat)\s*\([^)]{0,240}company\.gen3\.json/su;
    if (directRead.test(source)) violations.push(path);
  }
  expect(violations).toEqual([]);
});

async function collectSourceFiles(base, directories) {
  const files = [];
  for (const directory of directories) await walk(join(base, directory), files);
  return files;
}

async function walk(directory, files) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await walk(path, files);
    else if (entry.isFile() && path.endsWith(".mjs")) files.push(path);
  }
}
