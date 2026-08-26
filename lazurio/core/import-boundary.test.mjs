import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { builtinModules } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";
import { serverInstallGenerationInputPaths } from "./server-identity-lib.mjs";

const coreRoot = import.meta.dirname;
const repositoryRoot = resolve(coreRoot, "..", "..");
const transpilers = new Map();
const standardLibrarySpecifiers = new Set([
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
  "bun",
  "bun:test",
]);

test("Core imports only platform libraries and other Core modules", async () => {
  const findings = [];
  for (const path of (await moduleFiles(coreRoot)).filter((entry) => !entry.includes(".test."))) {
    const source = await readFile(path, "utf8");
    for (const { path: specifier } of scanImports(source, path)) {
      if (!specifier.startsWith(".")) {
        if (!standardLibrarySpecifiers.has(specifier) && !specifier.startsWith("bun:")) {
          findings.push(`${relative(coreRoot, path)} imports non-platform package ${specifier}`);
        }
        continue;
      }
      const target = resolve(dirname(path), specifier);
      if (!isInside(coreRoot, target)) {
        findings.push(`${relative(coreRoot, path)} imports ${specifier} outside Core`);
      }
    }
  }
  expect(findings).toEqual([]);
});

test("complete Resident manifest validation has one Core source owner", async () => {
  const moduleName = "resident-manifest-lib.mjs";
  expect(existsSync(join(coreRoot, moduleName))).toBe(true);
  const integritySource = await readFile(
    join(repositoryRoot, "distribution", "runtime", "integrity.mjs"),
    "utf8",
  );
  expect(integritySource).toContain('from "#lazurio-core/resident-manifest"');
  expect(integritySource).not.toContain("function validateResidentManifest");
});

test("slot classification has one physical owner shared by CLI and Launchpad", async () => {
  const moduleName = "organization-slot-scope-lib.mjs";
  expect(existsSync(join(coreRoot, moduleName))).toBe(true);
  expect(existsSync(join(repositoryRoot, "launchpad", "src", moduleName))).toBe(false);

  const imports = await repositoryImports([
    join(repositoryRoot, "lazurio"),
    join(repositoryRoot, "launchpad", "src"),
    join(repositoryRoot, "scripts"),
  ]);
  const consumers = imports
    .filter(({ target }) => target === join(coreRoot, moduleName))
    .map(({ importer }) => importer);

  expect(consumers.some((importer) => importer.startsWith("lazurio/"))).toBe(true);
  expect(consumers.some((importer) => importer.startsWith("launchpad/src/"))).toBe(true);
});

test("canonical path containment has one physical Core owner", async () => {
  const moduleName = "path-boundary-lib.mjs";
  expect(existsSync(join(coreRoot, moduleName))).toBe(true);
  expect(existsSync(join(repositoryRoot, "launchpad", "src", moduleName))).toBe(false);

  const imports = await repositoryImports([
    join(repositoryRoot, "lazurio"),
    join(repositoryRoot, "launchpad", "src"),
    join(repositoryRoot, "scripts"),
  ]);
  const consumers = imports
    .filter(({ target }) => target === join(coreRoot, moduleName))
    .map(({ importer }) => importer)
    .sort();

  expect(consumers).toEqual([
    "launchpad/src/git-inventory-lib.mjs",
    "launchpad/src/git-lib.mjs",
    "launchpad/src/git-materialization-lib.mjs",
    "launchpad/src/mission-control-plan-lib.mjs",
    "launchpad/src/module-location-repair-lib.mjs",
    "launchpad/src/worktree-actions-lib.mjs",
    "launchpad/src/worktree-lib.mjs",
    "lazurio/core/git-materialization-lib.mjs",
    "lazurio/organization-install-lib.mjs",
  ]);
});

test("Git checkout publication has one physical Core owner", async () => {
  const moduleName = "git-materialization-lib.mjs";
  expect(existsSync(join(coreRoot, moduleName))).toBe(true);

  const launchpadAdapter = await readFile(
    join(repositoryRoot, "launchpad", "src", moduleName),
    "utf8",
  );
  expect(launchpadAdapter).toContain("../../lazurio/core/git-materialization-lib.mjs");
  expect(launchpadAdapter).not.toContain('"clone"');
  expect(launchpadAdapter).not.toContain("makeTempDirectory");
});

test("runtime declaration validation has one physical Core owner", async () => {
  const moduleName = "runtime-contract-lib.mjs";
  expect(existsSync(join(coreRoot, moduleName))).toBe(true);
  expect(existsSync(join(repositoryRoot, "launchpad", "src", moduleName))).toBe(false);

  const imports = await repositoryImports([
    join(repositoryRoot, "lazurio"),
    join(repositoryRoot, "launchpad", "src"),
    join(repositoryRoot, "scripts"),
  ]);
  const consumers = imports
    .filter(({ target }) => target === join(coreRoot, moduleName))
    .map(({ importer }) => importer)
    .sort();

  expect(consumers).toEqual([
    "launchpad/src/discovery-lib.mjs",
    "launchpad/src/personalspace-lib.mjs",
    "launchpad/src/runtime-lib.mjs",
    "lazurio/module-setup-lib.mjs",
  ]);
});

test("Module declaration validation has one physical Core owner", async () => {
  const moduleName = "module-contract-lib.mjs";
  expect(existsSync(join(coreRoot, moduleName))).toBe(true);
  expect(existsSync(join(repositoryRoot, "launchpad", "src", moduleName))).toBe(false);

  const imports = await repositoryImports([
    join(repositoryRoot, "lazurio"),
    join(repositoryRoot, "launchpad", "src"),
    join(repositoryRoot, "scripts"),
  ]);
  const consumers = imports
    .filter(({ target }) => target === join(coreRoot, moduleName))
    .map(({ importer }) => importer)
    .sort();

  expect(consumers).toEqual([
    "launchpad/src/diagnostics-lib.mjs",
    "launchpad/src/discovery-lib.mjs",
    "launchpad/src/personalspace-lib.mjs",
    "launchpad/src/runtime-lib.mjs",
    "lazurio/module-port-lib.mjs",
    "lazurio/module-setup-lib.mjs",
    "scripts/lazurio-module-inventory.mjs",
  ]);
});

test("Organization port allocation policy has one physical Core owner", async () => {
  const moduleName = "organization-port-policy-lib.mjs";
  expect(existsSync(join(coreRoot, moduleName))).toBe(true);
  expect(existsSync(join(repositoryRoot, "launchpad", "src", moduleName))).toBe(false);

  const imports = await repositoryImports([
    join(repositoryRoot, "lazurio"),
    join(repositoryRoot, "launchpad", "src"),
    join(repositoryRoot, "scripts"),
  ]);
  const consumers = imports
    .filter(({ target }) => target === join(coreRoot, moduleName))
    .map(({ importer }) => importer)
    .sort();

  expect(consumers).toEqual([
    "launchpad/src/discovery-lib.mjs",
    "lazurio/module-port-lib.mjs",
    "lazurio/module-setup-lib.mjs",
  ]);
});

test("Module setup orchestration is package-owned and development scripts are thin wrappers", async () => {
  for (const moduleName of ["module-port-lib.mjs", "module-setup-lib.mjs"]) {
    expect(existsSync(join(repositoryRoot, "lazurio", moduleName))).toBe(true);
  }
  for (const scriptName of ["lazurio-module-port.mjs", "lazurio-runtime-migrate.mjs"]) {
    const source = await readFile(join(repositoryRoot, "scripts", scriptName), "utf8");
    expect(source).toContain("../lazurio/");
    expect(source).not.toContain("../lazurio/core/");
    expect(source.split("\n").length).toBeLessThan(20);
  }
});

test("Server identity and install-generation compatibility have one Core owner", async () => {
  const moduleName = "server-identity-lib.mjs";
  expect(existsSync(join(coreRoot, moduleName))).toBe(true);
  expect(existsSync(join(repositoryRoot, "launchpad", "src", moduleName))).toBe(false);

  const imports = await repositoryImports([
    join(repositoryRoot, "lazurio"),
    join(repositoryRoot, "launchpad", "src"),
    join(repositoryRoot, "scripts"),
  ]);
  const consumers = imports
    .filter(({ target }) => target === join(coreRoot, moduleName))
    .map(({ importer }) => importer)
    .sort();

  expect(consumers).toEqual([
    "launchpad/src/server.mjs",
    "lazurio/cli-install-lib.mjs",
    "lazurio/core/module-lifecycle-client-lib.mjs",
  ]);
});

test("Server install generation covers the complete local import closure", async () => {
  const included = new Set(serverInstallGenerationInputPaths(repositoryRoot));
  const pending = [join(repositoryRoot, "launchpad", "src", "server.mjs")];
  const visited = new Set();
  const findings = [];

  while (pending.length > 0) {
    const path = pending.pop();
    if (visited.has(path)) continue;
    visited.add(path);
    const repositoryPath = relative(repositoryRoot, path).split(sep).join("/");
    if (!included.has(repositoryPath)) findings.push(`${repositoryPath} is outside the Server generation`);

    const source = await readFile(path, "utf8");
    for (const { path: specifier } of scanImports(source, path)) {
      if (!specifier.startsWith(".")) continue;
      const target = resolve(dirname(path), specifier);
      if (!isInside(repositoryRoot, target)) {
        findings.push(`${repositoryPath} imports ${specifier} outside the repository`);
        continue;
      }
      pending.push(target);
    }
  }

  expect(findings).toEqual([]);
});

async function repositoryImports(roots) {
  const imports = [];
  for (const root of roots) {
    for (const path of (await moduleFiles(root)).filter((entry) => !entry.includes(".test."))) {
      const source = await readFile(path, "utf8");
      for (const { path: specifier } of scanImports(source, path)) {
        if (!specifier.startsWith(".")) continue;
        imports.push({
          importer: relative(repositoryRoot, path).split(sep).join("/"),
          target: resolve(dirname(path), specifier),
        });
      }
    }
  }
  return imports;
}

function scanImports(source, path) {
  const loader = /\.(?:ts|mts|cts)$/.test(path)
    ? "ts"
    : path.endsWith(".tsx")
      ? "tsx"
      : path.endsWith(".jsx")
        ? "jsx"
        : "js";
  if (!transpilers.has(loader)) transpilers.set(loader, new Bun.Transpiler({ loader }));
  return transpilers.get(loader).scanImports(source.replace(/^#![^\n]*(?:\n|$)/, ""));
}

async function moduleFiles(root) {
  const files = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...await moduleFiles(path));
    else if (entry.isFile() && /\.(?:mjs|cjs|js|mts|cts|ts|jsx|tsx)$/.test(entry.name)) files.push(path);
  }
  return files;
}

function isInside(parent, candidate) {
  const path = relative(parent, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !path.startsWith(sep));
}
