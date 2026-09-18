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

// Migration-only code lives in dedicated migrations folders (root AGENTS.md)
// and is deleted with the migration; it is the one place allowed to write the
// legacy compatibility projection.
const migrationFolders = ["lazurio/migrations/organization-manifest/"];

// Every consumer whose behaviour depends on which manifest formats this
// Machine cohort supports. All of them read the one Core gate; none keeps its
// own list. Adding or removing a gated consumer is a reviewed change here.
const readerGateConsumers = [
  ".agents/skills/worktree-development-discipline/scripts/worktree-inventory.mjs",
  ".claude/skills/worktree-development-discipline/scripts/worktree-inventory.mjs",
  "launchpad/src/workspace-parity-runner.mjs",
  "lazurio/migrations/organization-manifest/organization-manifest-migration.mjs",
  "lazurio/module-port-lib.mjs",
  "lazurio/module-setup-lib.mjs",
  "lazurio/organization-activation-lib.mjs",
  "lazurio/organization-install-lib.mjs",
  "lazurio/runtime/lazurio-update-lib.mjs",
  "lazurio/runtime/module-location-repair-lib.mjs",
  "scripts/worktree-create.mjs",
];

// State lists that are not a cohort support gate and already include `current`:
// they ask a format-independent question, so the gate cannot strand them.
const resourceReadableStateConsumers = new Set([
  // Repository-db install runs after the root passed the gate and only asks
  // "does this state carry exactly one normalized resource?".
  "lazurio/organization-install-lib.mjs",
  // The compiler asks "is the canonical manifest the consistent authority?"
  // (`transition` or `current`) to pick its input document.
  "lazurio/organization-compiler/compiler-core.mjs",
  "lazurio/organization-compiler/index.mjs",
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
    if (
      path.endsWith(".test.mjs")
      || compatibilityReaders.has(path)
      || compatibilityWriters.has(path)
      || migrationFolders.some((folder) => path.startsWith(folder))
    ) continue;
    const source = await readFile(absolutePath, "utf8");
    const directRead = /(?:Bun\.file|readFile(?:Sync)?|readJson|existsSync|access|stat|lstat)\s*\([^)]{0,240}company\.gen3\.json/su;
    if (directRead.test(source)) violations.push(path);
  }
  expect(violations).toEqual([]);
});

test("no active source hard-codes a manifest state allowlist next to the Core reader gate", async () => {
  // ORGANIZATION_ACTIVATABLE_MANIFEST_FORMATS is the one reader/update gate
  // (decision 0145). A second literal list of supported states would stay
  // closed — or open — independently of it, so `--finalize` could delete the
  // legacy projection while that consumer still refuses a `current` root.
  const gateOwner = "lazurio/core/organization-activation-lib.mjs";
  const sourceFiles = await collectSourceFiles(root, [".agents", ".claude", "launchpad", "lazurio", "scripts"]);
  const stateAllowlist = /\[\s*(?:"(?:legacy|transition|current)"\s*,\s*)+"(?:legacy|transition|current)"\s*,?\s*\]\s*\.includes\(/gu;
  const violations = [];
  const gatedConsumers = [];
  for (const absolutePath of sourceFiles) {
    const path = relative(root, absolutePath).replaceAll("\\", "/");
    if (path.endsWith(".test.mjs") || path === gateOwner) continue;
    const source = await readFile(absolutePath, "utf8");
    if (source.includes("ORGANIZATION_ACTIVATABLE_MANIFEST_FORMATS")) gatedConsumers.push(path);
    if (migrationFolders.some((folder) => path.startsWith(folder))) continue;
    for (const [literal] of source.matchAll(stateAllowlist)) {
      // An exempt list must already admit `current`; otherwise it is a gate.
      if (!resourceReadableStateConsumers.has(path) || !literal.includes('"current"')) {
        violations.push(`${path}: ${literal}`);
      }
    }
  }
  expect(violations).toEqual([]);
  expect(gatedConsumers.sort()).toEqual([...readerGateConsumers].sort());
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
