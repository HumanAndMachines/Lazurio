import { expect, test } from "bun:test";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

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

// The single reader-readiness contract (decision 0145) lives in one Core owner
// file: the shipped format list, `isOrganizationRootSupported` (may this cohort
// operate on the resolved root?) and `isOrganizationForgeIdentityVerified`
// (the immutable-identity proof it demands for a canonical-only `current`).
const readerGateOwner = "lazurio/core/organization-activation-lib.mjs";
const readerGateConstant = "ORGANIZATION_ACTIVATABLE_MANIFEST_FORMATS";

// Positive contract: every consumer whose behaviour depends on the supported
// manifest formats, with the exact Core symbols it must import from the owner
// file AND call. The migrator is a consumer like any other. Adding or removing
// a gated consumer is a reviewed change to this table.
const readerGateConsumers = {
  // Mutation-safety checks, update target check and `--finalize`.
  ".agents/skills/worktree-development-discipline/scripts/worktree-inventory.mjs": ["isOrganizationRootSupported"],
  ".claude/skills/worktree-development-discipline/scripts/worktree-inventory.mjs": ["isOrganizationRootSupported"],
  "launchpad/src/workspace-parity-runner.mjs": ["isOrganizationRootSupported"],
  "lazurio/module-port-lib.mjs": ["isOrganizationRootSupported"],
  "lazurio/module-setup-lib.mjs": ["isOrganizationRootSupported"],
  "lazurio/runtime/module-location-repair-lib.mjs": ["isOrganizationRootSupported"],
  "scripts/worktree-create.mjs": ["isOrganizationRootSupported"],
  "lazurio/runtime/lazurio-update-lib.mjs": ["isOrganizationRootSupported", "isOrganizationForgeIdentityVerified"],
  "lazurio/migrations/organization-manifest/organization-manifest-migration.mjs": [
    "isOrganizationRootSupported",
    "isOrganizationForgeIdentityVerified",
  ],
  // Activation and install decide through the Core resolver's `activation`
  // (which applies the same identity proof inside the owner file); install
  // additionally demands the proof in every format.
  "lazurio/organization-activation-lib.mjs": ["resolveOrganizationRootDocuments"],
  "lazurio/organization-install-lib.mjs": [
    "resolveOrganizationRootDocuments",
    "isOrganizationRootSupported",
    "isOrganizationForgeIdentityVerified",
  ],
};

// Only these consumers may name the shipped list at all, and only as the
// default of their `activationFormats` injection seam — never to decide.
const readerGateSeamOwners = new Set([
  "lazurio/migrations/organization-manifest/organization-manifest-migration.mjs",
  "lazurio/organization-activation-lib.mjs",
  "lazurio/organization-install-lib.mjs",
  "lazurio/runtime/lazurio-update-lib.mjs",
]);

const gateSymbols = ["isOrganizationRootSupported", "isOrganizationForgeIdentityVerified", readerGateConstant];
const manifestStateNames = ["legacy", "transition", "projection_drift", "conflict", "current", "missing"];

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

test("every gated consumer imports and calls the shared Core predicate; nothing else decides by manifest state", async () => {
  const sourceFiles = await collectSourceFiles(root, [".agents", ".claude", "launchpad", "lazurio", "scripts"]);
  const findings = [];
  const gateImporters = [];
  for (const absolutePath of sourceFiles) {
    const path = relative(root, absolutePath).replaceAll("\\", "/");
    // Tests inject cohorts; the owner file is the one place that may decide.
    // Nothing else is exempt — in particular not the migrations folder.
    if (path.endsWith(".test.mjs") || path === readerGateOwner) continue;
    const source = await readFile(absolutePath, "utf8");
    const imported = importedFromReaderGateOwner(source, absolutePath);
    if (gateSymbols.some((symbol) => imported.has(symbol))) gateImporters.push(path);

    for (const symbol of readerGateConsumers[path] ?? []) {
      if (!imported.has(symbol)) findings.push(`${path}: must import ${symbol} from ${readerGateOwner}`);
      else if (!callsSymbol(source, symbol)) findings.push(`${path}: imports ${symbol} but never calls it`);
    }
    for (const violation of readerGateConstantViolations(source)) {
      findings.push(`${path}: ${violation}`);
    }
    if (source.includes(readerGateConstant) && !readerGateSeamOwners.has(path)) {
      findings.push(`${path}: only declared seam owners may name ${readerGateConstant}`);
    }
    for (const violation of manifestStateLiteralViolations(source)) findings.push(`${path}: ${violation}`);
  }
  expect(findings).toEqual([]);
  // The declared table is complete: every importer of a gate symbol is listed,
  // and every listed consumer exists and really imports one.
  expect(gateImporters.sort()).toEqual(Object.keys(readerGateConsumers).sort());
  for (const path of Object.keys(readerGateConsumers)) {
    expect(sourceFiles.map((file) => relative(root, file).replaceAll("\\", "/")), path).toContain(path);
  }
});

test("the reader gate guard is fail-closed against equivalent allowlist syntaxes", () => {
  const flagged = [
    'if (!["legacy", "transition"].includes(resolution.state)) fail();',
    "if (!['legacy', 'transition'].includes(resolution.state)) fail();",
    'const ok = new Set(["legacy", "transition"]).has(state);',
    'const SUPPORTED = Object.freeze([\n  "legacy",\n  "transition",\n  "current",\n]);',
    'const supported = new Set();\nsupported.add("legacy");\nsupported.add("transition");',
    'switch (resolution.state) {\n  case "legacy":\n  case "transition":\n    return true;\n  default:\n    return false;\n}',
    'const ok = state === "legacy" || state === "transition";',
    'if (resolution.state !== "legacy" && resolution.state !== "transition") fail();',
    'const ok = { legacy: true, transition: true }[state] === true;',
    'const ok = /^(legacy|transition)$/u.test(state);',
    'const ok = "legacy transition".split(" ").includes(state);',
  ];
  for (const source of flagged) expect(manifestStateLiteralViolations(source), source).not.toEqual([]);

  const allowed = [
    'if (before.state === "legacy") migrate();\nif (before.state === "transition") {\n  noop();\n}',
    'if (resolution.state === "missing") continue;',
    'export const ORGANIZATION_INSTALL_STATES = Object.freeze(["current", "updated", "blocked"]);',
    '// legacy → transition → current is described in a comment only',
    'if (!isOrganizationRootSupported(resolution)) fail();',
  ];
  for (const source of allowed) expect(manifestStateLiteralViolations(source), source).toEqual([]);

  // The shipped list may only be a seam default, never a decision.
  const constantMisuse = [
    `if (!${readerGateConstant}.includes(resolution.state)) fail();`,
    `const formats = new Set(${readerGateConstant});`,
    `const formats = [...${readerGateConstant}, "current"];`,
    `const [first] = ${readerGateConstant};`,
  ];
  for (const source of constantMisuse) expect(readerGateConstantViolations(source), source).not.toEqual([]);
  expect(readerGateConstantViolations(
    `import {\n  ${readerGateConstant},\n} from "./core/organization-activation-lib.mjs";\n`
      + `export function run({ activationFormats = ${readerGateConstant} } = {}) {}\n`
      + `const formats = context.deps?.activationFormats ?? ${readerGateConstant};\n`,
  )).toEqual([]);

  // Positive contract helpers: an aliased or merely imported predicate fails.
  const ownerImport = 'import { isOrganizationRootSupported } from "./organization-activation-lib.mjs";\n';
  const fromOwner = join(root, "lazurio/core/example-consumer.mjs");
  expect(importedFromReaderGateOwner(ownerImport, fromOwner).has("isOrganizationRootSupported")).toBe(true);
  expect(importedFromReaderGateOwner(
    'import { isOrganizationRootSupported } from "./some-other-lib.mjs";\n',
    fromOwner,
  ).has("isOrganizationRootSupported")).toBe(false);
  expect(callsSymbol(ownerImport, "isOrganizationRootSupported")).toBe(false);
  expect(callsSymbol(`${ownerImport}if (!isOrganizationRootSupported(resolution)) fail();`, "isOrganizationRootSupported")).toBe(true);
});

// Names imported (un-aliased) from the Core owner file, resolved by path.
function importedFromReaderGateOwner(source, absolutePath) {
  const names = new Set();
  for (const [, specifiers, target] of source.matchAll(/import\s*\{([^}]*)\}\s*from\s*["']([^"']+)["']/gu)) {
    if (!target.startsWith(".")) continue;
    if (resolve(dirname(absolutePath), target) !== join(root, readerGateOwner)) continue;
    for (const specifier of specifiers.split(",")) {
      const name = specifier.trim();
      if (name && !/\sas\s/u.test(name)) names.add(name);
    }
  }
  return names;
}

function callsSymbol(source, symbol) {
  return new RegExp(`(?<![\\w$.])${symbol}\\s*\\(`, "u").test(withoutImports(source));
}

// The shipped list is legal only inside an import and as a seam default
// (`activationFormats = X` / `?? X`) that is not further dereferenced.
function readerGateConstantViolations(source) {
  const violations = [];
  const body = withoutImports(withoutComments(source));
  for (const match of body.matchAll(new RegExp(`(.{0,24})\\b${readerGateConstant}\\b(.{0,2})`, "gsu"))) {
    const seamDefault = /(?:activationFormats\s*=|\?\?)\s*$/u.test(match[1]) && !/^\s*[.[(]/u.test(match[2]);
    if (!seamDefault) violations.push(`${readerGateConstant} used outside an activationFormats seam default`);
  }
  return violations;
}

// Any way of grouping manifest state names into a decision outside the owner:
// array/Set literals, incremental sets, switch labels, chained comparisons,
// object lookups, regular expressions and split strings.
function manifestStateLiteralViolations(source) {
  const code = withoutComments(source);
  const states = manifestStateNames.join("|");
  const quoted = new RegExp(`["'\`](${states})["'\`]`, "gu");
  const distinct = (text, pattern = quoted) => new Set([...text.matchAll(pattern)].map((match) => match[1]));
  const violations = [];
  // Supported-format names are the dangerous ones; generic words such as
  // "current"/"missing"/"conflict" alone never form a manifest allowlist.
  const groupsFormats = (names) => names.size >= 2 && ["legacy", "transition"].some((name) => names.has(name));
  // The fuzzy detectors (object keys, strings, regular expressions) only fire
  // on two real format names, so ordinary words and counters stay legal.
  const formatNames = new Set(["legacy", "transition", "current"]);
  const groupsFormatNames = (names) => [...names].filter((name) => formatNames.has(name)).length >= 2;

  for (const [literal] of code.matchAll(/\[[^\[\]]*\]/gu)) {
    if (groupsFormats(distinct(literal))) violations.push(`state list literal ${literal.replace(/\s+/gu, " ")}`);
  }
  if (groupsFormats(distinct(code, new RegExp(`\\.(?:add|set)\\(\\s*["'\`](${states})["'\`]`, "gu")))) {
    violations.push("incremental Set/Map of manifest states");
  }
  if (groupsFormats(distinct(code, new RegExp(`\\bcase\\s+["'\`](${states})["'\`]\\s*:`, "gu")))) {
    violations.push("switch over manifest states");
  }
  const comparison = `[!=]==?\\s*["'\`](?:${states})["'\`]`;
  for (const [chain] of code.matchAll(new RegExp(`${comparison}(?:[^;{}]*?(?:\\|\\||&&)[^;{}]*?${comparison})+`, "gu"))) {
    if (groupsFormats(distinct(chain))) violations.push(`chained state comparison ${chain.replace(/\s+/gu, " ")}`);
  }
  for (const [literal] of code.matchAll(/\{[^{}]*\}/gu)) {
    if (groupsFormatNames(distinct(literal, new RegExp(`(?:^|[{,\\s])["'\`]?(${states})["'\`]?\\s*:`, "gu")))) {
      violations.push(`object lookup keyed by manifest states ${literal.replace(/\s+/gu, " ")}`);
    }
  }
  // A string or regular expression made of nothing but state names and
  // separators: `/^(legacy|transition)$/`, "legacy transition".split(" "), …
  const onlyStates = new RegExp(`^[\\s^$()|,;:?]*(?:${states})(?:[\\s|,;()$]+(?:${states}))+[\\s$)]*$`, "u");
  for (const [, literal] of code.matchAll(/["'`\/]([^"'`\/\n]*)["'`\/]/gu)) {
    if (onlyStates.test(literal) && groupsFormatNames(distinct(literal, new RegExp(`\\b(${states})\\b`, "gu")))) {
      violations.push(`string or regular expression grouping manifest states ${literal}`);
    }
  }
  return violations;
}

function withoutComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/(^|[^:"'`\\])\/\/[^\n]*/gu, "$1");
}

function withoutImports(source) {
  return source.replace(/import\s*(?:\{[^}]*\}|[\w$*\s,]+)\s*from\s*["'][^"']+["'];?/gu, "");
}

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
