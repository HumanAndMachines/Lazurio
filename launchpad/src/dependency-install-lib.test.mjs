import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

test("failed clean repair restores the previous dependency tree", async () => {
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
    rollback_ok: true,
    removed_node_modules: true,
    runtime_tree_usable: true,
  });
  expect(await readFile(join(packageRoot, "node_modules", "previous.txt"), "utf8")).toBe("previous\n");
  expect(existsSync(join(packageRoot, "node_modules", "partial.txt"))).toBe(false);
  expect(existsSync(join(packageRoot, ".lazurio-node_modules-recovery"))).toBe(false);
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

test("clean retry recovers a quarantined tree left by an interrupted repair", async () => {
  const root = await packageFixture();
  const packageRoot = join(root, "app");
  await mkdir(join(packageRoot, ".lazurio-node_modules-recovery"), { recursive: true });
  await materializeDependency(packageRoot, "fixture", ".lazurio-node_modules-recovery");
  await writeFile(join(packageRoot, ".lazurio-node_modules-recovery", "previous.txt"), "previous\n");

  const result = await refreshFrozenBunDependencies({
    cwd: packageRoot,
    boundaryRoot: root,
    command: [process.execPath, "fixture-install"],
    spawnProcess(_command, options) {
      return Bun.spawn([
        process.execPath,
        "-e",
        fixtureDependencyInstallScript("await Bun.write('node_modules/fresh.txt', 'fresh\\n')"),
      ], options);
    },
  });

  expect(result).toMatchObject({ ok: true, refresh_strategy: "clean_repair" });
  expect(existsSync(join(packageRoot, ".lazurio-node_modules-recovery"))).toBe(false);
  expect(existsSync(join(packageRoot, "node_modules", "previous.txt"))).toBe(false);
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

test("clean repair rejects package authority drift and restores the original dependency tree", async () => {
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
    rollback_ok: true,
    runtime_tree_usable: false,
  });
  expect(await readFile(join(packageRoot, "node_modules", "previous.txt"), "utf8")).toBe("previous\n");
  expect(JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")).dependencies).toEqual({});
});

test("clean repair rejects lockfile drift and restores the original dependency tree", async () => {
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
    rollback_ok: true,
    runtime_tree_usable: false,
  });
  expect(await readFile(join(packageRoot, "node_modules", "previous.txt"), "utf8")).toBe("previous\n");
});

test("clean repair fails closed when package authority drifts after final cleanup", async () => {
  const root = await packageFixture();
  const packageRoot = join(root, "app");
  await materializeDependency(packageRoot, "fixture");
  await writeFile(join(packageRoot, "node_modules", "previous.txt"), "previous\n");
  let cleanupCompleted = false;

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
      cleanupCompleted = !existsSync(join(packageRoot, ".lazurio-node_modules-recovery"));
      await writeFile(join(packageRoot, "package.json"), JSON.stringify({
        name: "fixture",
        private: true,
        dependencies: {},
      }));
    },
  });

  expect(cleanupCompleted).toBe(true);
  expect(result).toMatchObject({
    ok: false,
    reason: "dependency_authority_changed",
    rollback_ok: null,
    runtime_tree_usable: false,
  });
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
    rollback_ok: null,
    runtime_tree_usable: false,
  });
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

test("successful exit with a missing required package is incomplete and clean mode rolls back", async () => {
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
    rollback_ok: true,
    runtime_tree_usable: true,
    missing_required_dependencies: ["fixture"],
  });
  expect(await readFile(join(packageRoot, "node_modules", "previous.txt"), "utf8")).toBe("previous\n");
  expect(existsSync(join(packageRoot, ".lazurio-node_modules-recovery"))).toBe(false);
});

test("successful clean repair with malformed package metadata rolls back", async () => {
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
    rollback_ok: true,
    runtime_tree_usable: true,
  });
  expect(await readFile(join(packageRoot, "node_modules", "previous.txt"), "utf8")).toBe("previous\n");
});

test("successful clean repair with alias-key metadata rolls back", async () => {
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
    rollback_ok: true,
    runtime_tree_usable: true,
    missing_required_dependencies: ["alias"],
  });
  expect(JSON.parse(await readFile(join(packageRoot, "node_modules", "alias", "package.json"), "utf8"))).toMatchObject({
    name: "real-package",
  });
  expect(await readFile(join(packageRoot, "node_modules", "previous.txt"), "utf8")).toBe("previous\n");
});

test("pending recovery reports a complete current tree as usable without discarding quarantine", async () => {
  const root = await packageFixture();
  const packageRoot = join(root, "app");
  await materializeDependency(packageRoot, "fixture");
  await mkdir(join(packageRoot, ".lazurio-node_modules-recovery"), { recursive: true });

  const result = await runFrozenBunInstall({
    cwd: packageRoot,
    boundaryRoot: root,
    mode: "ensure",
    command: [process.execPath, "-e", "process.exit(0)"],
  });

  expect(result).toMatchObject({
    ok: false,
    reason: "node_modules_recovery_pending",
    runtime_tree_usable: true,
  });
  expect(existsSync(join(packageRoot, ".lazurio-node_modules-recovery"))).toBe(true);
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
    rollback_ok: true,
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
