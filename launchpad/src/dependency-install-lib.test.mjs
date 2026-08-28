import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import {
  frozenBunInstallCommand,
  inspectRequiredDependencies,
  refreshFrozenBunDependencies,
  runFrozenBunInstall,
} from "../../lazurio/runtime/dependency-install-lib.mjs";

const cleanup = [];

function fixtureDependencyInstallScript(extra = "") {
  return [
    'const { mkdir } = await import("node:fs/promises")',
    'await mkdir("node_modules/fixture", { recursive: true })',
    'await Bun.write("node_modules/fixture/package.json", JSON.stringify({ name: "fixture", version: "1.0.0" }))',
    extra,
  ].filter(Boolean).join("; ");
}

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

test("clean repair removes only the exact derived node_modules before a frozen install", async () => {
  const root = await packageFixture();
  const packageRoot = join(root, "app");
  await mkdir(join(packageRoot, "node_modules", "broken"), { recursive: true });
  await writeFile(join(packageRoot, "node_modules", "broken", "marker"), "old\n");
  await writeFile(join(packageRoot, ".env"), "SECRET=kept\n");
  let observedClean = false;

  const result = await runFrozenBunInstall({
    cwd: packageRoot,
    boundaryRoot: root,
    mode: "clean",
    command: [process.execPath, "fixture-install"],
    spawnProcess(command, options) {
      observedClean = !existsSync(join(packageRoot, "node_modules"));
      return Bun.spawn([
        process.execPath,
        "-e",
        fixtureDependencyInstallScript("await Bun.write('node_modules/installed.txt', 'new\\n')"),
      ], options);
    },
  });

  expect(result).toMatchObject({ ok: true, mode: "clean", removed_node_modules: true });
  expect(observedClean).toBe(true);
  expect(await readFile(join(packageRoot, "node_modules", "installed.txt"), "utf8")).toBe("new\n");
  expect(await readFile(join(packageRoot, ".env"), "utf8")).toBe("SECRET=kept\n");
});

test("ensure mode never deletes the existing dependency tree", async () => {
  const root = await packageFixture();
  const packageRoot = join(root, "app");
  await mkdir(join(packageRoot, "node_modules"), { recursive: true });
  await materializeDependency(packageRoot, "fixture");
  await writeFile(join(packageRoot, "node_modules", "marker"), "kept\n");

  const result = await runFrozenBunInstall({
    cwd: packageRoot,
    boundaryRoot: root,
    mode: "ensure",
    command: [process.execPath, "-e", "process.exit(0)"],
  });

  expect(result).toMatchObject({ ok: true, mode: "ensure", removed_node_modules: false });
  expect(await readFile(join(packageRoot, "node_modules", "marker"), "utf8")).toBe("kept\n");
});

test("clean repair refuses a symlinked node_modules boundary", async () => {
  const root = await packageFixture();
  const packageRoot = join(root, "app");
  const foreign = join(root, "foreign");
  await mkdir(foreign);
  await writeFile(join(foreign, "keep"), "safe\n");
  await mkdir(join(foreign, "fixture"));
  await writeFile(join(foreign, "fixture", "package.json"), JSON.stringify({ name: "fixture", version: "1.0.0" }));
  await symlink(foreign, join(packageRoot, "node_modules"), "dir");

  const result = await runFrozenBunInstall({
    cwd: packageRoot,
    boundaryRoot: root,
    mode: "clean",
    command: [process.execPath, "-e", "process.exit(0)"],
  });

  expect(result).toMatchObject({ ok: false, reason: "node_modules_boundary_invalid" });
  expect(result.runtime_tree_usable).toBe(true);
  expect(await readFile(join(foreign, "keep"), "utf8")).toBe("safe\n");
});

test("failed clean repair removes both the stale and partial dependency trees", async () => {
  const root = await packageFixture();
  const packageRoot = join(root, "app");
  await mkdir(join(packageRoot, "node_modules"), { recursive: true });
  await materializeDependency(packageRoot, "fixture");
  await writeFile(join(packageRoot, "node_modules", "previous.txt"), "previous\n");

  const result = await runFrozenBunInstall({
    cwd: packageRoot,
    boundaryRoot: root,
    mode: "clean",
    command: [process.execPath, "fixture-install"],
    spawnProcess(_command, options) {
      return Bun.spawn([
        process.execPath,
        "-e",
        "await Bun.write('node_modules/partial.txt', 'partial\\n'); process.exit(7)",
      ], options);
    },
  });

  expect(result).toMatchObject({
    ok: false,
    reason: "dependency_install_failed",
    removed_node_modules: true,
    runtime_tree_usable: false,
  });
  expect(existsSync(join(packageRoot, "node_modules"))).toBe(false);
  expect(existsSync(join(packageRoot, "node_modules", "partial.txt"))).toBe(false);
  expect(existsSync(join(packageRoot, ".lazurio-node_modules-recovery"))).toBe(false);
});

test("failed clean repair never follows a replacement node_modules link during cleanup", async () => {
  const root = await packageFixture();
  const packageRoot = join(root, "app");
  const foreign = join(root, "foreign-dependencies");
  await mkdir(join(foreign, "fixture"), { recursive: true });
  await writeFile(join(foreign, "keep.txt"), "safe\n");
  await writeFile(
    join(foreign, "fixture", "package.json"),
    JSON.stringify({ name: "fixture", version: "1.0.0" }),
  );

  const result = await runFrozenBunInstall({
    cwd: packageRoot,
    boundaryRoot: root,
    mode: "clean",
    command: [process.execPath, "fixture-install"],
    env: {
      ...process.env,
      LAZURIO_TEST_FOREIGN_DEPENDENCIES: foreign,
    },
    spawnProcess(_command, options) {
      return Bun.spawn([
        process.execPath,
        "-e",
        [
          'const { symlink } = await import("node:fs/promises")',
          'await symlink(process.env.LAZURIO_TEST_FOREIGN_DEPENDENCIES, "node_modules", process.platform === "win32" ? "junction" : "dir")',
          "process.exit(7)",
        ].join("; "),
      ], options);
    },
  });

  expect(result).toMatchObject({
    ok: false,
    reason: "node_modules_cleanup_failed",
    runtime_tree_usable: false,
  });
  expect(result.detail).toContain("node_modules není běžná složka");
  expect(await readFile(join(foreign, "keep.txt"), "utf8")).toBe("safe\n");
  expect(existsSync(join(packageRoot, "node_modules"))).toBe(true);
});

test("refresh retries one failed ensure as a clean repair", async () => {
  const root = await packageFixture();
  const packageRoot = join(root, "app");
  await mkdir(join(packageRoot, "node_modules"), { recursive: true });
  await materializeDependency(packageRoot, "fixture");
  await writeFile(join(packageRoot, "node_modules", "previous.txt"), "previous\n");
  let attempts = 0;

  const result = await refreshFrozenBunDependencies({
    cwd: packageRoot,
    boundaryRoot: root,
    command: [process.execPath, "fixture-install"],
    spawnProcess(_command, options) {
      attempts += 1;
      return attempts === 1
        ? Bun.spawn([process.execPath, "-e", "process.exit(2)"], options)
        : Bun.spawn([
            process.execPath,
            "-e",
            fixtureDependencyInstallScript("await Bun.write('node_modules/fresh.txt', 'fresh\\n')"),
          ], options);
    },
  });

  expect(result).toMatchObject({
    ok: true,
    refresh_strategy: "clean_repair",
    removed_node_modules: true,
    ensure_failure: { reason: "dependency_install_failed", exit_code: 2 },
  });
  expect(attempts).toBe(2);
  expect(existsSync(join(packageRoot, "node_modules", "previous.txt"))).toBe(false);
  expect(await readFile(join(packageRoot, "node_modules", "fresh.txt"), "utf8")).toBe("fresh\n");
});

test("clean retry discards a partial tree left by an interrupted repair", async () => {
  const root = await packageFixture();
  const packageRoot = join(root, "app");
  await mkdir(join(packageRoot, "node_modules"), { recursive: true });
  await writeFile(join(packageRoot, "node_modules", "partial.txt"), "partial\n");
  let attempts = 0;

  const result = await refreshFrozenBunDependencies({
    cwd: packageRoot,
    boundaryRoot: root,
    command: [process.execPath, "fixture-install"],
    spawnProcess(_command, options) {
      attempts += 1;
      return attempts === 1
        ? Bun.spawn([process.execPath, "-e", "process.exit(2)"], options)
        : Bun.spawn([
            process.execPath,
            "-e",
            fixtureDependencyInstallScript("await Bun.write('node_modules/fresh.txt', 'fresh\\n')"),
          ], options);
    },
  });

  expect(result).toMatchObject({ ok: true, refresh_strategy: "clean_repair" });
  expect(attempts).toBe(2);
  expect(existsSync(join(packageRoot, "node_modules", "partial.txt"))).toBe(false);
  expect(await readFile(join(packageRoot, "node_modules", "fresh.txt"), "utf8")).toBe("fresh\n");
});

test("package root must stay inside the owning checkout", async () => {
  const root = await packageFixture();
  const foreign = await packageFixture();
  const result = await runFrozenBunInstall({
    cwd: join(foreign, "app"),
    boundaryRoot: root,
    mode: "clean",
    command: [process.execPath, "-e", "process.exit(0)"],
  });
  expect(result).toMatchObject({ ok: false, reason: "package_root_outside_boundary" });
});

test("package and boundary paths must be explicit absolute paths", async () => {
  const result = await runFrozenBunInstall({
    cwd: "app",
    boundaryRoot: ".",
    mode: "clean",
    command: [process.execPath, "-e", "process.exit(0)"],
  });
  expect(result).toMatchObject({ ok: false, reason: "package_root_invalid" });
});

test("frozen Bun command never authorizes lockfile mutation", () => {
  expect(frozenBunInstallCommand("/runtime/bun")).toEqual([
    "/runtime/bun",
    "install",
    "--frozen-lockfile",
  ]);
});

test("Bun install refuses a packageManager that disagrees with the selected lockfile", async () => {
  const root = await packageFixture({ packageManager: "npm@11.0.0" });
  const packageRoot = join(root, "app");
  let spawnCalls = 0;

  const result = await runFrozenBunInstall({
    cwd: packageRoot,
    boundaryRoot: root,
    mode: "clean",
    command: [process.execPath, "fixture-install"],
    spawnProcess() {
      spawnCalls += 1;
      throw new Error("must not spawn");
    },
  });

  expect(result).toMatchObject({ ok: false, reason: "package_manager_lockfile_mismatch" });
  expect(spawnCalls).toBe(0);
});

test("invalid dependencies shape is rejected before a clean repair mutates node_modules", async () => {
  const root = await packageFixture({ dependencies: ["fixture"] });
  const packageRoot = join(root, "app");
  await mkdir(join(packageRoot, "node_modules"), { recursive: true });
  await writeFile(join(packageRoot, "node_modules", "previous.txt"), "previous\n");
  let spawnCalls = 0;

  const result = await runFrozenBunInstall({
    cwd: packageRoot,
    boundaryRoot: root,
    mode: "clean",
    command: [process.execPath, "fixture-install"],
    spawnProcess() {
      spawnCalls += 1;
      throw new Error("must not spawn");
    },
  });

  expect(result).toMatchObject({ ok: false, reason: "package_json_invalid" });
  expect(spawnCalls).toBe(0);
  expect(await readFile(join(packageRoot, "node_modules", "previous.txt"), "utf8")).toBe("previous\n");
});

test("shared inspection rejects an empty or non-string packageManager", async () => {
  for (const packageManager of ["", { name: "bun" }]) {
    const root = await packageFixture({ packageManager });
    const packageRoot = join(root, "app");
    expect(await inspectRequiredDependencies({
      cwd: packageRoot,
      boundaryRoot: root,
    })).toMatchObject({ ok: false, reason: "package_json_invalid" });
  }
});

test("clean repair rejects package authority drift and discards the derived tree", async () => {
  const root = await packageFixture();
  const packageRoot = join(root, "app");
  await mkdir(join(packageRoot, "node_modules"), { recursive: true });
  await materializeDependency(packageRoot, "fixture");
  await writeFile(join(packageRoot, "node_modules", "previous.txt"), "previous\n");

  const result = await runFrozenBunInstall({
    cwd: packageRoot,
    boundaryRoot: root,
    mode: "clean",
    command: [process.execPath, "fixture-install"],
    spawnProcess(_command, options) {
      return Bun.spawn([
        process.execPath,
        "-e",
        "await Bun.write('package.json', JSON.stringify({ name: 'fixture', private: true, dependencies: {} })); process.exit(0)",
      ], options);
    },
  });

  expect(result).toMatchObject({
    ok: false,
    reason: "dependency_authority_changed",
    runtime_tree_usable: false,
  });
  expect(existsSync(join(packageRoot, "node_modules"))).toBe(false);
  expect(JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")).dependencies).toEqual({});
});

test("clean repair rejects lockfile drift and discards the derived tree", async () => {
  const root = await packageFixture();
  const packageRoot = join(root, "app");
  await mkdir(join(packageRoot, "node_modules"), { recursive: true });
  await materializeDependency(packageRoot, "fixture");
  await writeFile(join(packageRoot, "node_modules", "previous.txt"), "previous\n");

  const result = await runFrozenBunInstall({
    cwd: packageRoot,
    boundaryRoot: root,
    mode: "clean",
    command: [process.execPath, "fixture-install"],
    spawnProcess(_command, options) {
      return Bun.spawn([
        process.execPath,
        "-e",
        "await Bun.write('bun.lock', '# changed\\n'); process.exit(0)",
      ], options);
    },
  });

  expect(result).toMatchObject({
    ok: false,
    reason: "dependency_authority_changed",
    runtime_tree_usable: false,
  });
  expect(existsSync(join(packageRoot, "node_modules"))).toBe(false);
});

test("clean repair fails closed when package authority drifts before final readback", async () => {
  const root = await packageFixture();
  const packageRoot = join(root, "app");
  await materializeDependency(packageRoot, "fixture");
  await writeFile(join(packageRoot, "node_modules", "previous.txt"), "previous\n");
  const result = await runFrozenBunInstall({
    cwd: packageRoot,
    boundaryRoot: root,
    mode: "clean",
    command: [process.execPath, "fixture-install"],
    spawnProcess(_command, options) {
      return Bun.spawn([
        process.execPath,
        "-e",
        fixtureDependencyInstallScript(),
      ], options);
    },
    async beforeFinalReadback() {
      await writeFile(join(packageRoot, "package.json"), JSON.stringify({
        name: "fixture",
        private: true,
        dependencies: {},
      }));
    },
  });

  expect(result).toMatchObject({
    ok: false,
    reason: "dependency_authority_changed",
    runtime_tree_usable: false,
  });
  expect(existsSync(join(packageRoot, "node_modules"))).toBe(false);
});

test("clean repair rejects a higher-priority Bun lockfile introduced before final readback", async () => {
  const root = await packageFixture({ lockfile: "bun.lockb" });
  const packageRoot = join(root, "app");
  await materializeDependency(packageRoot, "fixture");
  await writeFile(join(packageRoot, "node_modules", "previous.txt"), "previous\n");

  const result = await runFrozenBunInstall({
    cwd: packageRoot,
    boundaryRoot: root,
    mode: "clean",
    command: [process.execPath, "fixture-install"],
    spawnProcess(_command, options) {
      return Bun.spawn([
        process.execPath,
        "-e",
        fixtureDependencyInstallScript(),
      ], options);
    },
    async beforeFinalReadback() {
      await writeFile(join(packageRoot, "bun.lock"), "# newly preferred\n");
    },
  });

  expect(result).toMatchObject({
    ok: false,
    reason: "dependency_authority_changed",
    runtime_tree_usable: false,
  });
  expect(existsSync(join(packageRoot, "node_modules"))).toBe(false);
});

test("refresh never retries authority drift as a newly authorized clean repair", async () => {
  const root = await packageFixture();
  const packageRoot = join(root, "app");
  await mkdir(join(packageRoot, "node_modules"), { recursive: true });
  await materializeDependency(packageRoot, "fixture");
  await writeFile(join(packageRoot, "node_modules", "previous.txt"), "previous\n");
  let spawnCalls = 0;

  const result = await refreshFrozenBunDependencies({
    cwd: packageRoot,
    boundaryRoot: root,
    command: [process.execPath, "fixture-install"],
    spawnProcess(_command, options) {
      spawnCalls += 1;
      return Bun.spawn([
        process.execPath,
        "-e",
        "await Bun.write('package.json', JSON.stringify({ name: 'fixture', private: true, dependencies: {} })); process.exit(0)",
      ], options);
    },
  });

  expect(result).toMatchObject({
    ok: false,
    reason: "dependency_authority_changed",
    refresh_strategy: "ensure_failed",
    runtime_tree_usable: false,
  });
  expect(spawnCalls).toBe(1);
  expect(await readFile(join(packageRoot, "node_modules", "previous.txt"), "utf8")).toBe("previous\n");
});

test("required dependency inspection is scoped, package-metadata based, and ignores optional peers", async () => {
  const root = await packageFixture({
    dependencies: {
      "simple-icons": "1.0.0",
      "@fixture/scoped": "1.0.0",
      "type-only": "1.0.0",
      shared: "1.0.0",
    },
    devDependencies: { "dev-only": "1.0.0" },
    optionalDependencies: { optional: "1.0.0", shared: "1.0.0" },
    peerDependencies: { peer: "1.0.0" },
  });
  const packageRoot = join(root, "app");
  await materializeDependency(packageRoot, "@fixture/scoped");
  await materializeDependency(packageRoot, "type-only");
  await materializeDependency(packageRoot, "dev-only");
  await materializeDependency(packageRoot, "shared");
  await writeFile(join(packageRoot, "node_modules", "type-only", "package.json"), JSON.stringify({
    name: "type-only",
    version: "1.0.0",
    exports: { "./types": "./types.d.ts" },
  }));

  const state = await inspectRequiredDependencies({
    cwd: packageRoot,
    boundaryRoot: root,
    packageJson: JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")),
  });

  expect(state).toMatchObject({
    ok: true,
    required_dependency_count: 5,
    missing_required_dependencies: ["simple-icons"],
  });
  expect(state.required_dependency_names).not.toContain("optional");
  expect(state.required_dependency_names).not.toContain("peer");
});

test("invalid dependency names and symlink escapes are scoped blockers", async () => {
  const invalidRoot = await packageFixture({ dependencies: { "../outside": "1.0.0", "..\\outside": "1.0.0" } });
  const invalidPackageRoot = join(invalidRoot, "app");
  const invalid = await inspectRequiredDependencies({
    cwd: invalidPackageRoot,
    boundaryRoot: invalidRoot,
    packageJson: JSON.parse(await readFile(join(invalidPackageRoot, "package.json"), "utf8")),
  });
  expect(invalid).toMatchObject({ ok: false, reason: "dependency_name_invalid" });

  const root = await packageFixture({ dependencies: { linked: "1.0.0" } });
  const packageRoot = join(root, "app");
  const foreign = await mkdtemp(join(tmpdir(), "lazurio-dependency-foreign-"));
  cleanup.push(foreign);
  await mkdir(join(foreign, "linked"), { recursive: true });
  await writeFile(join(foreign, "linked", "package.json"), JSON.stringify({ name: "linked", version: "1.0.0" }));
  await mkdir(join(packageRoot, "node_modules"), { recursive: true });
  await symlink(join(foreign, "linked"), join(packageRoot, "node_modules", "linked"), process.platform === "win32" ? "junction" : "dir");

  const escaped = await inspectRequiredDependencies({
    cwd: packageRoot,
    boundaryRoot: root,
    packageJson: JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")),
  });
  expect(escaped).toMatchObject({ ok: false, reason: "dependency_tree_boundary_invalid" });
});

test.skipIf(process.platform === "win32")("dependency package metadata may not escape through a file symlink", async () => {
  const root = await packageFixture({ dependencies: { fixture: "1.0.0" } });
  const packageRoot = join(root, "app");
  const foreign = await mkdtemp(join(tmpdir(), "lazurio-dependency-metadata-"));
  cleanup.push(foreign);
  await mkdir(join(packageRoot, "node_modules", "fixture"), { recursive: true });
  await writeFile(join(foreign, "package.json"), JSON.stringify({ name: "fixture", version: "1.0.0" }));
  await symlink(
    join(foreign, "package.json"),
    join(packageRoot, "node_modules", "fixture", "package.json"),
    "file",
  );

  const state = await inspectRequiredDependencies({ cwd: packageRoot, boundaryRoot: root });

  expect(state).toMatchObject({
    ok: false,
    reason: "dependency_tree_boundary_invalid",
    missing_required_dependencies: ["fixture"],
  });
});

test("a package symlink inside the owning checkout remains usable", async () => {
  const root = await packageFixture({ dependencies: { linked: "1.0.0" } });
  const packageRoot = join(root, "app");
  const linkedRoot = join(root, "workspace-packages", "linked");
  await mkdir(linkedRoot, { recursive: true });
  await writeFile(join(linkedRoot, "package.json"), JSON.stringify({ name: "linked", version: "1.0.0" }));
  await mkdir(join(packageRoot, "node_modules"), { recursive: true });
  await symlink(linkedRoot, join(packageRoot, "node_modules", "linked"), process.platform === "win32" ? "junction" : "dir");

  const state = await inspectRequiredDependencies({
    cwd: packageRoot,
    boundaryRoot: root,
    packageJson: JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")),
  });
  expect(state).toMatchObject({ ok: true, missing_required_dependencies: [] });
});

test("a declared link dependency uses the ordinary checkout-scoped metadata contract", async () => {
  const root = await packageFixture({ dependencies: { linked: "link:../workspace-packages/linked" } });
  const packageRoot = join(root, "app");
  const linkedRoot = join(root, "workspace-packages", "linked");
  await mkdir(linkedRoot, { recursive: true });
  await writeFile(join(linkedRoot, "package.json"), JSON.stringify({ name: "linked", version: "1.0.0" }));
  await mkdir(join(packageRoot, "node_modules"), { recursive: true });
  await symlink(linkedRoot, join(packageRoot, "node_modules", "linked"), process.platform === "win32" ? "junction" : "dir");

  expect(await inspectRequiredDependencies({ cwd: packageRoot, boundaryRoot: root })).toMatchObject({
    ok: true,
    missing_required_dependencies: [],
  });
});

test.skipIf(process.platform === "win32")("an exact declared Organization-local file dependency accepts Bun's link-farm layout", async () => {
  const fixture = await organizationFileDependencyFixture();
  await mkdir(fixture.installedRoot, { recursive: true });
  await symlink(join(fixture.targetRoot, "package.json"), join(fixture.installedRoot, "package.json"), "file");
  await symlink(join(fixture.targetRoot, "index.ts"), join(fixture.installedRoot, "index.ts"), "file");

  const state = await inspectRequiredDependencies({
    cwd: fixture.packageRoot,
    boundaryRoot: fixture.checkoutRoot,
    organizationDependencyRoot: fixture.organizationRoot,
  });

  expect(state).toMatchObject({
    ok: true,
    required_dependency_count: 1,
    missing_required_dependencies: [],
  });
});

test.skipIf(process.platform === "win32")("an Organization-local link farm rejects an executable symlink outside its exact target", async () => {
  const fixture = await organizationFileDependencyFixture();
  const foreignRoot = join(fixture.root, "organizations", "OtherCo", "payload");
  await mkdir(foreignRoot, { recursive: true });
  await writeFile(join(foreignRoot, "index.ts"), "export const foreign = true;\n");
  await mkdir(fixture.installedRoot, { recursive: true });
  await symlink(join(fixture.targetRoot, "package.json"), join(fixture.installedRoot, "package.json"), "file");
  await symlink(join(foreignRoot, "index.ts"), join(fixture.installedRoot, "index.ts"), "file");

  expect(await inspectRequiredDependencies({
    cwd: fixture.packageRoot,
    boundaryRoot: fixture.checkoutRoot,
    organizationDependencyRoot: fixture.organizationRoot,
  })).toMatchObject({ ok: false, reason: "dependency_tree_boundary_invalid" });
});

test.skipIf(process.platform === "win32")("a local link-farm leaf swap during readiness is rejected", async () => {
  const fixture = await organizationFileDependencyFixture();
  const foreignRoot = join(fixture.root, "organizations", "OtherCo", "payload");
  await mkdir(foreignRoot, { recursive: true });
  await writeFile(join(foreignRoot, "index.ts"), "export const foreign = true;\n");
  await mkdir(fixture.installedRoot, { recursive: true });
  await symlink(join(fixture.targetRoot, "package.json"), join(fixture.installedRoot, "package.json"), "file");
  await symlink(join(fixture.targetRoot, "index.ts"), join(fixture.installedRoot, "index.ts"), "file");

  const state = await inspectRequiredDependencies({
    cwd: fixture.packageRoot,
    boundaryRoot: fixture.checkoutRoot,
    organizationDependencyRoot: fixture.organizationRoot,
    async beforeLocalDependencyTreeRecheck() {
      await rm(join(fixture.installedRoot, "index.ts"));
      await symlink(join(foreignRoot, "index.ts"), join(fixture.installedRoot, "index.ts"), "file");
    },
  });

  expect(state).toMatchObject({ ok: false, reason: "dependency_authority_changed" });
});

test.skipIf(process.platform === "win32")("a local link-farm directory swap during readiness is rejected", async () => {
  const fixture = await organizationFileDependencyFixture();
  const targetSchemas = join(fixture.targetRoot, "schemas");
  const installedSchemas = join(fixture.installedRoot, "schemas");
  const foreignSchemas = join(fixture.root, "organizations", "OtherCo", "schemas");
  await mkdir(targetSchemas, { recursive: true });
  await mkdir(installedSchemas, { recursive: true });
  await mkdir(foreignSchemas, { recursive: true });
  await writeFile(join(targetSchemas, "value.ts"), "export const local = true;\n");
  await writeFile(join(foreignSchemas, "value.ts"), "export const foreign = true;\n");
  await symlink(join(fixture.targetRoot, "package.json"), join(fixture.installedRoot, "package.json"), "file");
  await symlink(join(targetSchemas, "value.ts"), join(installedSchemas, "value.ts"), "file");

  const state = await inspectRequiredDependencies({
    cwd: fixture.packageRoot,
    boundaryRoot: fixture.checkoutRoot,
    organizationDependencyRoot: fixture.organizationRoot,
    async beforeLocalDependencyTreeRecheck() {
      await rm(installedSchemas, { recursive: true });
      await symlink(foreignSchemas, installedSchemas, "dir");
    },
  });

  expect(state).toMatchObject({ ok: false, reason: "dependency_authority_changed" });
});

test.skipIf(process.platform === "win32")("a declared local package rejects a nested symlink outside its exact target", async () => {
  const fixture = await organizationFileDependencyFixture();
  const foreignRoot = join(fixture.root, "organizations", "OtherCo", "payload");
  await mkdir(foreignRoot, { recursive: true });
  await writeFile(join(foreignRoot, "payload.ts"), "export const foreign = true;\n");
  await symlink(join(foreignRoot, "payload.ts"), join(fixture.targetRoot, "payload.ts"), "file");
  await mkdir(join(fixture.packageRoot, "node_modules", "@workspace-contracts"), { recursive: true });
  await symlink(
    fixture.targetRoot,
    fixture.installedRoot,
    process.platform === "win32" ? "junction" : "dir",
  );

  expect(await inspectRequiredDependencies({
    cwd: fixture.packageRoot,
    boundaryRoot: fixture.checkoutRoot,
    organizationDependencyRoot: fixture.organizationRoot,
  })).toMatchObject({ ok: false, reason: "dependency_tree_boundary_invalid" });
});

test("an exact declared Organization-local file dependency accepts a direct directory link", async () => {
  const fixture = await organizationFileDependencyFixture();
  await mkdir(join(fixture.packageRoot, "node_modules", "@workspace-contracts"), { recursive: true });
  await symlink(
    fixture.targetRoot,
    fixture.installedRoot,
    process.platform === "win32" ? "junction" : "dir",
  );

  expect(await inspectRequiredDependencies({
    cwd: fixture.packageRoot,
    boundaryRoot: fixture.checkoutRoot,
    organizationDependencyRoot: fixture.organizationRoot,
  })).toMatchObject({ ok: true, missing_required_dependencies: [] });
});

test("a file dependency copied inside its owning checkout remains usable", async () => {
  const root = await packageFixture({ dependencies: { "local-schema": "file:./packages/local-schema" } });
  const packageRoot = join(root, "app");
  const targetRoot = join(packageRoot, "packages", "local-schema");
  await mkdir(targetRoot, { recursive: true });
  await writeFile(join(targetRoot, "package.json"), JSON.stringify({ name: "local-schema", version: "1.0.0" }));
  await materializeDependency(packageRoot, "local-schema");

  expect(await inspectRequiredDependencies({ cwd: packageRoot, boundaryRoot: root })).toMatchObject({
    ok: true,
    missing_required_dependencies: [],
  });
});

test("a real Bun frozen install satisfies the shared Organization-local file dependency postcondition", async () => {
  const fixture = await organizationFileDependencyFixture();
  const lockfilePath = join(fixture.packageRoot, "bun.lock");
  await rm(lockfilePath, { force: true });

  const lockfileInstall = Bun.spawn(
    [process.execPath, "install", "--lockfile-only", "--ignore-scripts"],
    {
      cwd: fixture.packageRoot,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
    },
  );
  const [lockfileStdout, lockfileStderr, lockfileExitCode] = await Promise.all([
    new Response(lockfileInstall.stdout).text(),
    new Response(lockfileInstall.stderr).text(),
    lockfileInstall.exited,
  ]);
  expect({
    exit_code: lockfileExitCode,
    stdout: lockfileStdout,
    stderr: lockfileStderr,
  }).toMatchObject({ exit_code: 0 });
  await rm(join(fixture.packageRoot, "node_modules"), { recursive: true, force: true });

  const result = await runFrozenBunInstall({
    cwd: fixture.packageRoot,
    boundaryRoot: fixture.checkoutRoot,
    organizationDependencyRoot: fixture.organizationRoot,
    command: frozenBunInstallCommand(process.execPath),
  });

  expect(result).toMatchObject({
    ok: true,
    exit_code: 0,
    mode: "ensure",
    runtime_tree_usable: true,
    missing_required_dependencies: [],
  });
});

test("a same-Organization package link must match the exact declared file target", async () => {
  const fixture = await organizationFileDependencyFixture();
  const differentTarget = join(fixture.organizationRoot, "launchpad", "contracts", "different");
  await mkdir(differentTarget, { recursive: true });
  await writeFile(join(differentTarget, "package.json"), JSON.stringify({ name: "@rozjedeme-contracts/v1" }));
  await mkdir(join(fixture.packageRoot, "node_modules", "@workspace-contracts"), { recursive: true });
  await symlink(
    differentTarget,
    fixture.installedRoot,
    process.platform === "win32" ? "junction" : "dir",
  );

  expect(await inspectRequiredDependencies({
    cwd: fixture.packageRoot,
    boundaryRoot: fixture.checkoutRoot,
    organizationDependencyRoot: fixture.organizationRoot,
  })).toMatchObject({ ok: false, reason: "dependency_tree_boundary_invalid" });
});

test("a declared file target outside the Organization remains fail-closed", async () => {
  const fixture = await organizationFileDependencyFixture();
  const foreign = await mkdtemp(join(tmpdir(), "lazurio-file-dependency-foreign-"));
  cleanup.push(foreign);
  await writeFile(join(foreign, "package.json"), JSON.stringify({ name: "@rozjedeme-contracts/v1" }));
  await writeFile(join(fixture.packageRoot, "package.json"), JSON.stringify({
    name: "consumer",
    dependencies: {
      "@workspace-contracts/v1": `file:${relative(fixture.packageRoot, foreign)}`,
    },
  }));

  expect(await inspectRequiredDependencies({
    cwd: fixture.packageRoot,
    boundaryRoot: fixture.checkoutRoot,
    organizationDependencyRoot: fixture.organizationRoot,
  })).toMatchObject({ ok: false, reason: "dependency_tree_boundary_invalid" });
});

test("absolute, drive, UNC, URL and missing file targets never become Install candidates", async () => {
  for (const spec of [
    "file:/tmp/foreign",
    "file:C:\\foreign",
    "file://server/share",
    "file:../../../../launchpad/contracts/missing",
  ]) {
    const fixture = await organizationFileDependencyFixture();
    await writeFile(join(fixture.packageRoot, "package.json"), JSON.stringify({
      name: "consumer",
      dependencies: { "@workspace-contracts/v1": spec },
    }));
    const state = await inspectRequiredDependencies({
      cwd: fixture.packageRoot,
      boundaryRoot: fixture.checkoutRoot,
      organizationDependencyRoot: fixture.organizationRoot,
    });
    expect(state.ok).toBe(false);
    expect(["dependency_tree_boundary_invalid", "dependency_tree_inspection_failed"]).toContain(state.reason);
  }
});

test("a worktree-relative file target is never rebound to the main Organization checkout", async () => {
  const fixture = await organizationFileDependencyFixture();
  const worktreeRoot = join(
    fixture.organizationRoot,
    ".worktrees",
    "workspace",
    "consumer",
    "DEV-6439-file-boundary",
  );
  const worktreePackageRoot = join(worktreeRoot, "app", "v2");
  await mkdir(worktreePackageRoot, { recursive: true });
  await writeFile(
    join(worktreePackageRoot, "package.json"),
    await readFile(join(fixture.packageRoot, "package.json"), "utf8"),
  );
  await writeFile(join(worktreePackageRoot, "bun.lock"), "# fixture\n");

  expect(await inspectRequiredDependencies({
    cwd: worktreePackageRoot,
    boundaryRoot: worktreeRoot,
    organizationDependencyRoot: fixture.organizationRoot,
  })).toMatchObject({
    ok: false,
    reason: "dependency_tree_inspection_failed",
  });
});

test.skipIf(process.platform === "win32")("a declared local target package change during readiness inspection is rejected", async () => {
  const fixture = await organizationFileDependencyFixture();
  await mkdir(fixture.installedRoot, { recursive: true });
  await symlink(join(fixture.targetRoot, "package.json"), join(fixture.installedRoot, "package.json"), "file");
  await symlink(join(fixture.targetRoot, "index.ts"), join(fixture.installedRoot, "index.ts"), "file");

  const state = await inspectRequiredDependencies({
    cwd: fixture.packageRoot,
    boundaryRoot: fixture.checkoutRoot,
    organizationDependencyRoot: fixture.organizationRoot,
    async beforeLocalDependencyAuthorityRecheck() {
      await writeFile(join(fixture.targetRoot, "package.json"), JSON.stringify({
        name: "@rozjedeme-contracts/v1",
        changed: true,
      }));
    },
  });

  expect(state).toMatchObject({ ok: false, reason: "dependency_authority_changed" });
});

test.skipIf(process.platform === "win32")("a frozen install pins the declared local target package authority", async () => {
  const fixture = await organizationFileDependencyFixture();
  await mkdir(fixture.installedRoot, { recursive: true });
  await symlink(join(fixture.targetRoot, "package.json"), join(fixture.installedRoot, "package.json"), "file");
  await symlink(join(fixture.targetRoot, "index.ts"), join(fixture.installedRoot, "index.ts"), "file");

  const result = await runFrozenBunInstall({
    cwd: fixture.packageRoot,
    boundaryRoot: fixture.checkoutRoot,
    organizationDependencyRoot: fixture.organizationRoot,
    command: [process.execPath, "fixture-install"],
    spawnProcess(_command, options) {
      return Bun.spawn([
        process.execPath,
        "-e",
        `await Bun.write(${JSON.stringify(join(fixture.targetRoot, "package.json"))}, JSON.stringify({ name: "@rozjedeme-contracts/v1", changed: true }));`,
      ], options);
    },
  });

  expect(result).toMatchObject({
    ok: false,
    reason: "dependency_authority_changed",
    runtime_tree_usable: false,
  });
});

test("package metadata must be parseable and match the declared dependency or npm alias", async () => {
  const root = await packageFixture({
    dependencies: {
      fixture: "1.0.0",
      alias: "npm:real-package@1.0.0",
      "scoped-alias": "npm:@fixture/real-package@1.0.0",
    },
  });
  const packageRoot = join(root, "app");
  await materializeDependency(packageRoot, "fixture");
  await materializeDependency(packageRoot, "alias");
  await materializeDependency(packageRoot, "scoped-alias");
  await writeFile(join(packageRoot, "node_modules", "fixture", "package.json"), "{broken");
  await writeFile(join(packageRoot, "node_modules", "alias", "package.json"), JSON.stringify({
    name: "real-package",
    version: "1.0.0",
  }));
  await writeFile(join(packageRoot, "node_modules", "scoped-alias", "package.json"), JSON.stringify({
    name: "@fixture/real-package",
    version: "1.0.0",
  }));

  const state = await inspectRequiredDependencies({
    cwd: packageRoot,
    boundaryRoot: root,
    packageJson: JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")),
  });

  expect(state).toMatchObject({
    ok: false,
    reason: "dependency_tree_inspection_failed",
    missing_required_dependencies: ["fixture"],
  });

  await materializeDependency(packageRoot, "fixture");
  await writeFile(join(packageRoot, "node_modules", "alias", "package.json"), JSON.stringify({
    name: "alias",
    version: "1.0.0",
  }));
  expect(await inspectRequiredDependencies({ cwd: packageRoot, boundaryRoot: root })).toMatchObject({
    ok: false,
    reason: "dependency_tree_inspection_failed",
    missing_required_dependencies: ["alias"],
  });
});

test("an installed dependency directory without package metadata is invalid, not missing", async () => {
  const root = await packageFixture();
  const packageRoot = join(root, "app");
  await mkdir(join(packageRoot, "node_modules", "fixture"), { recursive: true });

  expect(await inspectRequiredDependencies({ cwd: packageRoot, boundaryRoot: root })).toMatchObject({
    ok: false,
    reason: "dependency_tree_inspection_failed",
    missing_required_dependencies: ["fixture"],
  });
});

test("invalid nearer package metadata never falls through to a valid ancestor dependency", async () => {
  const root = await packageFixture();
  const packageRoot = join(root, "app");
  const consumerRoot = join(packageRoot, "packages", "consumer");
  await mkdir(join(consumerRoot, "node_modules", "fixture"), { recursive: true });
  await writeFile(join(consumerRoot, "package.json"), JSON.stringify({
    name: "consumer",
    private: true,
    dependencies: { fixture: "1.0.0" },
  }));
  await writeFile(join(consumerRoot, "bun.lock"), "# consumer\n");
  await materializeDependency(packageRoot, "fixture");
  await writeFile(join(consumerRoot, "node_modules", "fixture", "package.json"), JSON.stringify({
    name: "different-package",
    version: "1.0.0",
  }));

  const state = await inspectRequiredDependencies({ cwd: consumerRoot, boundaryRoot: root });

  expect(state).toMatchObject({
    ok: false,
    reason: "dependency_tree_inspection_failed",
    missing_required_dependencies: ["fixture"],
  });
  expect(state.detail).toContain("nepoužije jiný ancestor balíček");
});

test("metadata appearing after an ENOENT read cannot reopen ancestor fallback", async () => {
  const root = await packageFixture();
  const packageRoot = join(root, "app");
  const consumerRoot = join(packageRoot, "packages", "consumer");
  const nearerDependencyRoot = join(consumerRoot, "node_modules", "fixture");
  await mkdir(nearerDependencyRoot, { recursive: true });
  await writeFile(join(consumerRoot, "package.json"), JSON.stringify({
    name: "consumer",
    private: true,
    dependencies: { fixture: "1.0.0" },
  }));
  await writeFile(join(consumerRoot, "bun.lock"), "# consumer\n");
  await materializeDependency(packageRoot, "fixture");
  let failureInspectionCalls = 0;

  const state = await inspectRequiredDependencies({
    cwd: consumerRoot,
    boundaryRoot: root,
    async beforeDependencyMetadataFailureInspection({ dependencyName, packagePath }) {
      failureInspectionCalls += 1;
      expect(dependencyName).toBe("fixture");
      await writeFile(packagePath, JSON.stringify({ name: "fixture", version: "1.0.0" }));
    },
  });

  expect(failureInspectionCalls).toBe(1);
  expect(state).toMatchObject({
    ok: false,
    reason: "dependency_tree_inspection_failed",
    missing_required_dependencies: ["fixture"],
  });
  expect(state.detail).toContain("změnil existenci během bezpečného ověření");
});

test("dependency inspection rejects an external node_modules root even without required packages", async () => {
  const root = await packageFixture({ dependencies: {}, peerDependencies: { peer: "1.0.0" } });
  const packageRoot = join(root, "app");
  const foreign = await mkdtemp(join(tmpdir(), "lazurio-node-modules-foreign-"));
  cleanup.push(foreign);
  await symlink(foreign, join(packageRoot, "node_modules"), process.platform === "win32" ? "junction" : "dir");

  const state = await inspectRequiredDependencies({
    cwd: packageRoot,
    boundaryRoot: root,
    packageJson: JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")),
  });

  expect(state).toMatchObject({ ok: false, reason: "dependency_tree_boundary_invalid" });
});

test("a local external node_modules root blocks a safe ancestor dependency", async () => {
  const root = await packageFixture();
  const packageRoot = join(root, "app");
  await materializeDependency(root, "fixture");
  const foreign = await mkdtemp(join(tmpdir(), "lazurio-node-modules-shadow-"));
  cleanup.push(foreign);
  await symlink(foreign, join(packageRoot, "node_modules"), process.platform === "win32" ? "junction" : "dir");

  const state = await inspectRequiredDependencies({
    cwd: packageRoot,
    boundaryRoot: root,
    packageJson: JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")),
  });

  expect(state).toMatchObject({ ok: false, reason: "dependency_tree_boundary_invalid" });
});

test.skipIf(process.platform === "win32")("package.json and Bun lockfile authority may not escape the package root", async () => {
  const packageEscapeRoot = await packageFixture();
  const packageRoot = join(packageEscapeRoot, "app");
  const foreign = await mkdtemp(join(tmpdir(), "lazurio-package-authority-"));
  cleanup.push(foreign);
  await writeFile(join(foreign, "package.json"), JSON.stringify({ dependencies: { fixture: "1.0.0" } }));
  await rm(join(packageRoot, "package.json"));
  await symlink(join(foreign, "package.json"), join(packageRoot, "package.json"), "file");
  expect(await runFrozenBunInstall({
    cwd: packageRoot,
    boundaryRoot: packageEscapeRoot,
    command: [process.execPath, "-e", "process.exit(0)"],
  })).toMatchObject({ ok: false, reason: "dependency_tree_boundary_invalid" });

  const lockEscapeRoot = await packageFixture();
  const lockPackageRoot = join(lockEscapeRoot, "app");
  await writeFile(join(foreign, "bun.lock"), "# foreign\n");
  await rm(join(lockPackageRoot, "bun.lock"));
  await symlink(join(foreign, "bun.lock"), join(lockPackageRoot, "bun.lock"), "file");
  expect(await runFrozenBunInstall({
    cwd: lockPackageRoot,
    boundaryRoot: lockEscapeRoot,
    command: [process.execPath, "-e", "process.exit(0)"],
  })).toMatchObject({ ok: false, reason: "dependency_tree_boundary_invalid" });

  const npmLockRoot = await packageFixture();
  const npmPackageRoot = join(npmLockRoot, "app");
  await writeFile(join(foreign, "package-lock.json"), "{}\n");
  await symlink(join(foreign, "package-lock.json"), join(npmPackageRoot, "package-lock.json"), "file");
  expect(await inspectRequiredDependencies({
    cwd: npmPackageRoot,
    boundaryRoot: npmLockRoot,
    lockfile: "package-lock.json",
  })).toMatchObject({ ok: false, reason: "dependency_tree_boundary_invalid" });
});

test("successful exit with a missing required package is incomplete and leaves no derived tree", async () => {
  const root = await packageFixture();
  const packageRoot = join(root, "app");
  await materializeDependency(packageRoot, "fixture");
  await writeFile(join(packageRoot, "node_modules", "previous.txt"), "previous\n");

  const result = await runFrozenBunInstall({
    cwd: packageRoot,
    boundaryRoot: root,
    mode: "clean",
    command: [process.execPath, "fixture-install"],
    spawnProcess(_command, options) {
      return Bun.spawn([
        process.execPath,
        "-e",
        "await (await import('node:fs/promises')).mkdir('node_modules', { recursive: true }); process.exit(0)",
      ], options);
    },
  });

  expect(result).toMatchObject({
    ok: false,
    reason: "dependency_install_incomplete",
    runtime_tree_usable: false,
    missing_required_dependencies: ["fixture"],
  });
  expect(existsSync(join(packageRoot, "node_modules"))).toBe(false);
  expect(existsSync(join(packageRoot, ".lazurio-node_modules-recovery"))).toBe(false);
});

test("successful clean repair with malformed package metadata discards the derived tree", async () => {
  const root = await packageFixture();
  const packageRoot = join(root, "app");
  await materializeDependency(packageRoot, "fixture");
  await writeFile(join(packageRoot, "node_modules", "previous.txt"), "previous\n");

  const result = await runFrozenBunInstall({
    cwd: packageRoot,
    boundaryRoot: root,
    mode: "clean",
    command: [process.execPath, "fixture-install"],
    spawnProcess(_command, options) {
      return Bun.spawn([
        process.execPath,
        "-e",
        "await (await import('node:fs/promises')).mkdir('node_modules/fixture', { recursive: true }); await Bun.write('node_modules/fixture/package.json', '{broken');",
      ], options);
    },
  });

  expect(result).toMatchObject({
    ok: false,
    reason: "dependency_tree_inspection_failed",
    runtime_tree_usable: false,
  });
  expect(existsSync(join(packageRoot, "node_modules"))).toBe(false);
});

test("successful clean repair with alias-key metadata discards the derived tree", async () => {
  const root = await packageFixture({ dependencies: { alias: "npm:real-package@1.0.0" } });
  const packageRoot = join(root, "app");
  await materializeDependency(packageRoot, "alias");
  await writeFile(join(packageRoot, "node_modules", "alias", "package.json"), JSON.stringify({
    name: "real-package",
    version: "1.0.0",
  }));
  await writeFile(join(packageRoot, "node_modules", "previous.txt"), "previous\n");

  const result = await runFrozenBunInstall({
    cwd: packageRoot,
    boundaryRoot: root,
    mode: "clean",
    command: [process.execPath, "fixture-install"],
    spawnProcess(_command, options) {
      return Bun.spawn([
        process.execPath,
        "-e",
        "await (await import('node:fs/promises')).mkdir('node_modules/alias', { recursive: true }); await Bun.write('node_modules/alias/package.json', JSON.stringify({ name: 'alias' }));",
      ], options);
    },
  });

  expect(result).toMatchObject({
    ok: false,
    reason: "dependency_tree_inspection_failed",
    runtime_tree_usable: false,
    missing_required_dependencies: ["alias"],
  });
  expect(existsSync(join(packageRoot, "node_modules"))).toBe(false);
});

test("incomplete clean install without a previous tree removes the partial result", async () => {
  const root = await packageFixture();
  const packageRoot = join(root, "app");

  const result = await runFrozenBunInstall({
    cwd: packageRoot,
    boundaryRoot: root,
    mode: "clean",
    command: [process.execPath, "fixture-install"],
    spawnProcess(_command, options) {
      return Bun.spawn([
        process.execPath,
        "-e",
        "await (await import('node:fs/promises')).mkdir('node_modules', { recursive: true }); process.exit(0)",
      ], options);
    },
  });

  expect(result).toMatchObject({
    ok: false,
    reason: "dependency_install_incomplete",
    runtime_tree_usable: false,
  });
  expect(existsSync(join(packageRoot, "node_modules"))).toBe(false);
});

async function packageFixture({
  dependencies = { fixture: "1.0.0" },
  devDependencies,
  optionalDependencies,
  peerDependencies,
  packageManager,
  lockfile = "bun.lock",
} = {}) {
  const root = await mkdtemp(join(tmpdir(), "lazurio-dependency-install-"));
  cleanup.push(root);
  const packageRoot = join(root, "app");
  await mkdir(packageRoot, { recursive: true });
  await writeFile(join(packageRoot, "package.json"), JSON.stringify({
    name: "fixture",
    private: true,
    dependencies,
    ...(packageManager !== undefined ? { packageManager } : {}),
    ...(devDependencies ? { devDependencies } : {}),
    ...(optionalDependencies ? { optionalDependencies } : {}),
    ...(peerDependencies ? { peerDependencies } : {}),
  }));
  await writeFile(join(packageRoot, lockfile), "# fixture\n");
  return root;
}

async function materializeDependency(packageRoot, dependencyName, tree = "node_modules") {
  const dependencyRoot = join(packageRoot, tree, ...dependencyName.split("/"));
  await mkdir(dependencyRoot, { recursive: true });
  await writeFile(
    join(dependencyRoot, "package.json"),
    JSON.stringify({ name: dependencyName, version: "1.0.0" }),
  );
}

async function organizationFileDependencyFixture() {
  const root = await mkdtemp(join(tmpdir(), "lazurio-organization-file-dependency-"));
  cleanup.push(root);
  const organizationRoot = join(root, "organizations", "TestCo");
  const checkoutRoot = join(organizationRoot, "workspace", "consumer");
  const packageRoot = join(checkoutRoot, "app", "v2");
  const targetRoot = join(organizationRoot, "launchpad", "contracts", "v1");
  const installedRoot = join(packageRoot, "node_modules", "@workspace-contracts", "v1");
  await mkdir(packageRoot, { recursive: true });
  await mkdir(targetRoot, { recursive: true });
  await writeFile(join(packageRoot, "package.json"), JSON.stringify({
    name: "consumer",
    private: true,
    dependencies: {
      "@workspace-contracts/v1": "file:../../../../launchpad/contracts/v1",
    },
  }));
  await writeFile(join(packageRoot, "bun.lock"), "# fixture\n");
  await writeFile(join(targetRoot, "package.json"), JSON.stringify({
    name: "@rozjedeme-contracts/v1",
    private: true,
  }));
  await writeFile(join(targetRoot, "index.ts"), "export const fixture = true;\n");
  return { root, organizationRoot, checkoutRoot, packageRoot, targetRoot, installedRoot };
}
