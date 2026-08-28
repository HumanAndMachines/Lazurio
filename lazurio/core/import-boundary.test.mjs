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

test("slot classification has one physical owner consumed through package runtime", async () => {
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
  expect(consumers.some((importer) => importer.startsWith("lazurio/runtime/"))).toBe(true);
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
    "launchpad/src/worktree-actions-lib.mjs",
    "lazurio/core/git-materialization-lib.mjs",
    "lazurio/organization-install-lib.mjs",
    "lazurio/runtime/dependency-install-lib.mjs",
    "lazurio/runtime/diagnostics-lib.mjs",
    "lazurio/runtime/discovery-lib.mjs",
    "lazurio/runtime/git-inventory-lib.mjs",
    "lazurio/runtime/git-lib.mjs",
    "lazurio/runtime/git-materialization-lib.mjs",
    "lazurio/runtime/mission-control-plan-lib.mjs",
    "lazurio/runtime/module-location-repair-lib.mjs",
    "lazurio/runtime/personalspace-lib.mjs",
    "lazurio/runtime/runtime-lib.mjs",
    "lazurio/runtime/worktree-lib.mjs",
  ]);
});

test("Git checkout publication has one physical Core owner", async () => {
  const moduleName = "git-materialization-lib.mjs";
  expect(existsSync(join(coreRoot, moduleName))).toBe(true);

  const runtimeAdapter = await readFile(
    join(repositoryRoot, "lazurio", "runtime", moduleName),
    "utf8",
  );
  expect(runtimeAdapter).toContain("../core/git-materialization-lib.mjs");
  expect(runtimeAdapter).not.toContain('"clone"');
  expect(runtimeAdapter).not.toContain("makeTempDirectory");
});

test("GitHub repository JSON decoding has one Core owner shared by activation and install", async () => {
  const moduleName = "github-provider-lib.mjs";
  const imports = await repositoryImports([
    join(repositoryRoot, "lazurio"),
  ]);
  const consumers = imports
    .filter(({ target }) => target === join(coreRoot, moduleName))
    .map(({ importer }) => importer)
    .filter((importer) => [
      "lazurio/organization-activation-lib.mjs",
      "lazurio/organization-install-lib.mjs",
    ].includes(importer))
    .sort();

  expect(consumers).toEqual([
    "lazurio/organization-activation-lib.mjs",
    "lazurio/organization-install-lib.mjs",
  ]);
  for (const consumer of consumers) {
    const source = await readFile(join(repositoryRoot, consumer), "utf8");
    expect(source).toContain("readGitHubRepositoryJsonDocument");
    expect(source).not.toContain('response.value?.encoding !== "base64"');
  }
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
    "lazurio/module-setup-lib.mjs",
    "lazurio/runtime/discovery-lib.mjs",
    "lazurio/runtime/personalspace-lib.mjs",
    "lazurio/runtime/runtime-lib.mjs",
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
    "lazurio/module-port-lib.mjs",
    "lazurio/module-setup-lib.mjs",
    "lazurio/runtime/diagnostics-lib.mjs",
    "lazurio/runtime/discovery-lib.mjs",
    "lazurio/runtime/personalspace-lib.mjs",
    "lazurio/runtime/runtime-lib.mjs",
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
    "lazurio/core/organization-activation-lib.mjs",
    "lazurio/module-port-lib.mjs",
    "lazurio/module-setup-lib.mjs",
    "lazurio/runtime/discovery-lib.mjs",
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

test("Launchpad entry primitives have one package owner and one-way consumers", async () => {
  const runtimeRoot = join(repositoryRoot, "lazurio", "runtime");
  for (const moduleName of [
    "deep-link-lib.mjs",
    "launchpad-identity-lib.mjs",
    "server-launcher-lib.mjs",
  ]) {
    expect(existsSync(join(runtimeRoot, moduleName))).toBe(true);
  }
  expect(existsSync(join(repositoryRoot, "launchpad", "public", "deep-link.js"))).toBe(false);
  expect(existsSync(join(repositoryRoot, "launchpad", "src", "launchpad-identity-lib.mjs"))).toBe(false);
  expect(existsSync(join(repositoryRoot, "launchpad", "src", "server-launcher-lib.mjs"))).toBe(false);

  const [server, launcher, cliServe, browser] = await Promise.all([
    readFile(join(repositoryRoot, "launchpad", "src", "server.mjs"), "utf8"),
    readFile(join(repositoryRoot, "launchpad", "src", "server-launcher.mjs"), "utf8"),
    readFile(join(repositoryRoot, "lazurio", "launchpad-serve-lib.mjs"), "utf8"),
    readFile(join(repositoryRoot, "launchpad", "public", "app.js"), "utf8"),
  ]);
  expect(server).toContain("../../lazurio/runtime/deep-link-lib.mjs");
  expect(server).toContain("../../lazurio/runtime/launchpad-identity-lib.mjs");
  expect(launcher).toContain("../../lazurio/runtime/server-launcher-lib.mjs");
  expect(cliServe).toContain("./runtime/deep-link-lib.mjs");
  expect(cliServe).toContain("./runtime/server-launcher-lib.mjs");
  expect(browser).toContain('/lazurio-runtime/deep-link-lib.mjs');
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
