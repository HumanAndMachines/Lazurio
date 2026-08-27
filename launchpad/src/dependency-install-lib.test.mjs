import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  frozenBunInstallCommand,
  refreshFrozenBunDependencies,
  runFrozenBunInstall,
} from "../../lazurio/runtime/dependency-install-lib.mjs";

const cleanup = [];

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
        "await Bun.write('node_modules/installed.txt', 'new\\n')",
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
            "await Bun.write('node_modules/fresh.txt', 'fresh\\n')",
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
  await writeFile(join(packageRoot, ".lazurio-node_modules-recovery", "previous.txt"), "previous\n");

  const result = await refreshFrozenBunDependencies({
    cwd: packageRoot,
    boundaryRoot: root,
    command: [process.execPath, "fixture-install"],
    spawnProcess(_command, options) {
      return Bun.spawn([
        process.execPath,
        "-e",
        "await Bun.write('node_modules/fresh.txt', 'fresh\\n')",
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

async function packageFixture() {
  const root = await mkdtemp(join(tmpdir(), "lazurio-dependency-install-"));
  cleanup.push(root);
  const packageRoot = join(root, "app");
  await mkdir(packageRoot, { recursive: true });
  await writeFile(join(packageRoot, "package.json"), JSON.stringify({
    name: "fixture",
    private: true,
    dependencies: { fixture: "1.0.0" },
  }));
  await writeFile(join(packageRoot, "bun.lock"), "# fixture\n");
  return root;
}
