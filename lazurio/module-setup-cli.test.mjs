import { afterAll, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  moduleSetupExitCode,
  setupModule,
} from "./module-setup-lib.mjs";
import { validateAgainstSchema } from "../launchpad/src/json-schema-mini.mjs";

const roots = [];
const cliPath = join(import.meta.dirname, "cli.mjs");
const reportSchema = await Bun.file(join(import.meta.dirname, "module-setup-report.v1.schema.json")).json();

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

test("legacy Module converges through dry-run, apply and idempotent rerun", async () => {
  const fixture = await moduleFixture({ module: "legacy" });
  const packagePath = join(fixture.moduleRoot, "package.json");
  await writeJson(packagePath, legacyPackage({ company: "Acme", module: "legacy", port: 23_999 }));

  const dryRun = await setupModule(fixture);
  expect(dryRun).toMatchObject({
    schema_version: "lazurio.module_setup.report.v1",
    status: "actionable",
    reason: "setup_changes_ready",
    module: { company: "Acme", id: "legacy" },
  });
  expect(dryRun.changes.map((change) => change.action)).toEqual(["create", "replace"]);
  expect(dryRun.changes[0].path.endsWith("workspace/legacy/lazurio.module.json")).toBe(true);
  expect(dryRun.changes[1].path.endsWith("workspace/legacy/package.json")).toBe(true);
  expect(validateAgainstSchema(dryRun, reportSchema, "module-setup")).toEqual([]);
  expect(moduleSetupExitCode(dryRun)).toBe(1);

  const applied = await setupModule({ ...fixture, apply: true });
  expect(applied.status).toBe("completed");
  expect(validateAgainstSchema(applied, reportSchema, "module-setup")).toEqual([]);
  expect(moduleSetupExitCode(applied)).toBe(0);
  const manifest = await readJson(join(fixture.moduleRoot, "lazurio.module.json"));
  expect(manifest).toMatchObject({
    id: "legacy",
    company: "Acme",
    port_leases: [{ id: "main", port: 23_999 }],
    apps: ["package.json"],
    default_app: "package.json",
  });
  const packageJson = await readJson(packagePath);
  expect(packageJson.companyascode).toBeUndefined();
  expect(packageJson.lazurio.runtime.listeners).toEqual([
    expect.objectContaining({ lease: "main" }),
  ]);

  const rerun = await setupModule(fixture);
  expect(rerun).toMatchObject({ status: "current", changes: [] });
});

test("interruption after create-only manifest is recoverable by the same setup command", async () => {
  const fixture = await moduleFixture({ module: "interrupted" });
  const packagePath = join(fixture.moduleRoot, "package.json");
  await writeJson(packagePath, legacyPackage({ company: "Acme", module: "interrupted", port: 23_998 }));

  await expect(setupModule({ ...fixture, apply: true, failAfterWrite: 1 })).rejects.toThrow(
    "Injected module setup failure after write 1",
  );
  expect((await readJson(join(fixture.moduleRoot, "lazurio.module.json"))).id).toBe("interrupted");
  expect((await readJson(packagePath)).companyascode.app.port).toBe(23_998);

  const resumed = await setupModule({ ...fixture, apply: true });
  expect(resumed.status).toBe("completed");
  expect((await readJson(packagePath)).companyascode).toBeUndefined();
  expect((await setupModule(fixture)).status).toBe("current");
});

test("new explicit App setup resumes after the manifest was published first", async () => {
  const fixture = await moduleFixture({ module: "new-interrupted" });
  const packagePath = join(fixture.moduleRoot, "package.json");
  await writeJson(packagePath, {
    name: "new-interrupted",
    private: true,
    scripts: { dev: "bun server.mjs" },
  });
  const options = {
    ...fixture,
    appPackage: "package.json",
    appId: "acme-new-interrupted-v1",
    title: "New Interrupted",
    devScript: "dev",
  };

  await expect(setupModule({ ...options, apply: true, failAfterWrite: 1 })).rejects.toThrow(
    "Injected module setup failure after write 1",
  );
  expect((await readJson(join(fixture.moduleRoot, "lazurio.module.json"))).port_leases).toHaveLength(1);
  expect((await readJson(packagePath)).lazurio).toBeUndefined();

  const resumed = await setupModule({ ...options, apply: true });
  expect(resumed.status).toBe("completed");
  expect((await readJson(packagePath)).lazurio.runtime.listeners).toEqual([
    expect.objectContaining({ lease: "main" }),
  ]);
  expect((await setupModule(options)).status).toBe("current");
});

test("new no-app Module gets an explicit zero-listener contract", async () => {
  const fixture = await moduleFixture({ module: "data-only" });
  const dryRun = await setupModule({ ...fixture, noApp: true });
  expect(dryRun).toMatchObject({
    status: "actionable",
  });
  expect(dryRun.changes.map((change) => change.action)).toEqual(["create"]);
  expect(dryRun.changes[0].path.endsWith("lazurio.module.json")).toBe(true);
  const applied = await setupModule({ ...fixture, noApp: true, apply: true });
  expect(applied.status).toBe("completed");
  expect(await readJson(join(fixture.moduleRoot, "lazurio.module.json"))).toEqual({
    schema_version: "lazurio.module.v1",
    id: "data-only",
    company: "Acme",
    tcp_port_policy: { mode: "none" },
    port_leases: [],
    apps: [],
  });
});

test("new App Module allocates from the Organization pool and explicit adoption stays review-visible", async () => {
  const allocated = await moduleFixture({ module: "new-app" });
  await writeJson(join(allocated.moduleRoot, "package.json"), {
    name: "new-app",
    private: true,
    scripts: { dev: "bun server.mjs" },
  });
  const appOptions = {
    ...allocated,
    appPackage: "package.json",
    appId: "acme-new-app-v1",
    title: "New App",
    devScript: "dev",
  };
  const planned = await setupModule(appOptions);
  expect(planned.status).toBe("actionable");
  await setupModule({ ...appOptions, apply: true });
  expect((await readJson(join(allocated.moduleRoot, "lazurio.module.json"))).port_leases[0].port).toBe(24_000);

  const adopted = await moduleFixture({ module: "hotfix" });
  await writeJson(join(adopted.moduleRoot, "package.json"), {
    name: "hotfix",
    private: true,
    scripts: { dev: "bun server.mjs" },
  });
  const adoptPlan = await setupModule({
    ...adopted,
    appPackage: "package.json",
    appId: "acme-hotfix-v1",
    title: "Hotfix",
    devScript: "dev",
    adoptPort: 53_06,
  });
  expect(adoptPlan.operator_assertions[0]).toContain("explicitního --adopt-port");
  expect(adoptPlan.operator_assertions[0]).toContain("5306");
});

test("explicit App setup rewrites its adopted host and port to injected runtime variables", async () => {
  const fixture = await moduleFixture({ module: "portable-app" });
  const packagePath = join(fixture.moduleRoot, "package.json");
  await writeJson(packagePath, {
    name: "portable-app",
    private: true,
    scripts: { dev: "bun server.mjs --host 127.0.0.1 --port 5306" },
  });

  const report = await setupModule({
    ...fixture,
    apply: true,
    appPackage: "package.json",
    appId: "acme-portable-app-v1",
    title: "Portable App",
    devScript: "dev",
    adoptPort: 5306,
  });

  expect(report).toMatchObject({ status: "completed" });
  expect((await readJson(packagePath)).scripts.dev).toBe(
    'bun -e "process.exit(process.env.PORT && process.env.HOST ? 0 : 1)" && bun server.mjs --host "$HOST" --port "$PORT"',
  );
});

test("explicit App setup rejects a different hardcoded port after bounded rewrite", async () => {
  const fixture = await moduleFixture({ module: "drifted-app" });
  const packagePath = join(fixture.moduleRoot, "package.json");
  await writeJson(packagePath, {
    name: "drifted-app",
    private: true,
    scripts: { dev: "bun server.mjs --port 5307" },
  });

  const report = await setupModule({
    ...fixture,
    apply: true,
    appPackage: "package.json",
    appId: "acme-drifted-app-v1",
    title: "Drifted App",
    devScript: "dev",
    adoptPort: 5306,
  });

  expect(report).toMatchObject({ status: "action_required", reason: "app_runtime_port_authority" });
  expect(await Bun.file(join(fixture.moduleRoot, "lazurio.module.json")).exists()).toBe(false);
  expect((await readJson(packagePath)).lazurio).toBeUndefined();
});

test("planned slot blocks before write and CLI exposes stable JSON status and exit code", async () => {
  const fixture = await moduleFixture({ module: "planned", status: "planned_slot" });
  const report = await setupModule({ ...fixture, noApp: true });
  expect(report).toMatchObject({
    status: "action_required",
    reason: "module_slot_planned",
    changes: [],
  });
  expect(validateAgainstSchema(report, reportSchema, "module-setup")).toEqual([]);
  expect(moduleSetupExitCode(report)).toBe(2);

  const cli = Bun.spawnSync([
    process.execPath,
    "run",
    cliPath,
    "module",
    "setup",
    fixture.moduleRoot,
    "--no-app",
    "--json",
    "--root",
    fixture.lazurioRoot,
  ], { cwd: fixture.lazurioRoot, stdout: "pipe", stderr: "pipe" });
  expect(cli.exitCode).toBe(2);
  expect(cli.stderr.toString()).toBe("");
  expect(JSON.parse(cli.stdout.toString())).toMatchObject({
    schema_version: "lazurio.module_setup.report.v1",
    reason: "module_slot_planned",
  });
});

test("duplicate explicit adopted port fails closed without creating either file", async () => {
  const existing = await moduleFixture({ module: "owner" });
  await writeJson(join(existing.moduleRoot, "lazurio.module.json"), {
    schema_version: "lazurio.module.v1",
    id: "owner",
    company: "Acme",
    tcp_port_policy: { mode: "single" },
    port_leases: [{ id: "main", host: "127.0.0.1", port: 24_055 }],
    apps: ["package.json"],
    default_app: "package.json",
  });
  await writeJson(join(existing.moduleRoot, "package.json"), declaredPackage({ company: "Acme", module: "owner" }));

  const target = await addModuleSlot(existing, { module: "duplicate" });
  await writeJson(join(target.moduleRoot, "package.json"), {
    name: "duplicate",
    private: true,
    scripts: { dev: "bun server.mjs" },
  });
  const report = await setupModule({
    ...target,
    appPackage: "package.json",
    appId: "acme-duplicate-v1",
    title: "Duplicate",
    devScript: "dev",
    adoptPort: 24_055,
  });
  expect(report).toMatchObject({ status: "action_required", reason: "module_port_conflict" });
  expect(await readFile(join(target.moduleRoot, "package.json"), "utf8")).not.toContain("lazurio");
  expect(await Bun.file(join(target.moduleRoot, "lazurio.module.json")).exists()).toBe(false);
});

test("App package behind an intermediate symlink or junction cannot escape the Module", async () => {
  const fixture = await moduleFixture({ module: "linked-app" });
  const outside = await mkdtemp(join(tmpdir(), "lazurio-module-setup-outside-"));
  roots.push(outside);
  const outsidePackage = join(outside, "package.json");
  await writeJson(outsidePackage, legacyPackage({ company: "Acme", module: "linked-app", port: 24_012 }));
  await symlink(outside, join(fixture.moduleRoot, "app"), process.platform === "win32" ? "junction" : "dir");
  await writeJson(join(fixture.moduleRoot, "lazurio.module.json"), {
    schema_version: "lazurio.module.v1",
    id: "linked-app",
    company: "Acme",
    tcp_port_policy: { mode: "single" },
    port_leases: [{ id: "main", host: "127.0.0.1", port: 24_012 }],
    apps: ["app/package.json"],
    default_app: "app/package.json",
  });
  const before = await readFile(outsidePackage, "utf8");

  const report = await setupModule({ ...fixture, apply: true });

  expect(report).toMatchObject({ status: "action_required", reason: "app_package_outside_module" });
  expect(report.issues[0].message).toContain("symlink nebo junction");
  expect(await readFile(outsidePackage, "utf8")).toBe(before);
});

test("replacing an App directory after validation cannot redirect atomic publication", async () => {
  const fixture = await moduleFixture({ module: "raced-app" });
  const appRoot = join(fixture.moduleRoot, "app");
  const displacedAppRoot = join(fixture.moduleRoot, "app-before-race");
  const packagePath = join(appRoot, "package.json");
  await mkdir(appRoot);
  await writeJson(packagePath, legacyPackage({ company: "Acme", module: "raced-app", port: 24_016 }));
  await writeJson(join(fixture.moduleRoot, "lazurio.module.json"), {
    schema_version: "lazurio.module.v1",
    id: "raced-app",
    company: "Acme",
    tcp_port_policy: { mode: "single" },
    port_leases: [{ id: "main", host: "127.0.0.1", port: 24_016 }],
    apps: ["app/package.json"],
    default_app: "app/package.json",
  });
  const expectedInside = await readFile(packagePath, "utf8");
  const outside = await mkdtemp(join(tmpdir(), "lazurio-module-setup-raced-outside-"));
  roots.push(outside);
  const outsidePackage = join(outside, "package.json");
  await writeFile(outsidePackage, expectedInside, "utf8");

  let swapped = false;
  const report = await setupModule({
    ...fixture,
    apply: true,
    beforePublish: async ({ action, path }) => {
      if (swapped || action !== "replace" || path !== packagePath) return;
      swapped = true;
      await rename(appRoot, displacedAppRoot);
      await symlink(outside, appRoot, process.platform === "win32" ? "junction" : "dir");
    },
  });

  expect(swapped).toBe(true);
  expect(report).toMatchObject({ status: "action_required", reason: "app_package_outside_module" });
  expect(await readFile(outsidePackage, "utf8")).toBe(expectedInside);
  expect(await readFile(join(displacedAppRoot, "package.json"), "utf8")).toBe(expectedInside);
});

test("a linked Module task worktree inherits ownership without touching the primary checkout", async () => {
  const fixture = await moduleFixture({ module: "linked-worktree" });
  const primaryPackage = join(fixture.moduleRoot, "package.json");
  await writeJson(primaryPackage, legacyPackage({ company: "Acme", module: "linked-worktree", port: 24_013 }));
  await writeJson(join(fixture.moduleRoot, "lazurio.module.json"), {
    schema_version: "lazurio.module.v1",
    id: "linked-worktree",
    company: "Acme",
    tcp_port_policy: { mode: "single" },
    port_leases: [{ id: "main", host: "127.0.0.1", port: 24_013 }],
    apps: ["package.json"],
    default_app: "package.json",
  });
  await writeFile(join(fixture.moduleRoot, ".gitignore"), ".worktrees/\n", "utf8");
  initGitModule(fixture.moduleRoot);
  const worktreesRoot = join(fixture.moduleRoot, ".worktrees", "root");
  const worktreeRoot = join(worktreesRoot, "linked-worktree");
  await mkdir(worktreesRoot, { recursive: true });
  runGit(fixture.moduleRoot, ["worktree", "add", "-b", "codex/module-setup-test", worktreeRoot]);

  const planned = await setupModule({ ...fixture, moduleRoot: worktreeRoot });
  expect(planned).toMatchObject({ status: "actionable", module: { company: "Acme", id: "linked-worktree" } });
  const applied = await setupModule({ ...fixture, moduleRoot: worktreeRoot, apply: true });

  expect(applied.status).toBe("completed");
  expect((await readJson(primaryPackage)).companyascode.app.port).toBe(24_013);
  expect((await readJson(join(worktreeRoot, "package.json"))).companyascode).toBeUndefined();
  expect((await readJson(join(worktreeRoot, "lazurio.module.json"))).port_leases[0].port).toBe(24_013);
});

test("Module setup uses the canonical slot identity helper when slug is omitted", async () => {
  const fixture = await moduleFixture({ module: "path-owned" });
  const manifestPath = join(fixture.organizationRoot, "modules.manifest.json");
  const manifest = await readJson(manifestPath);
  delete manifest.module_slots[0].slug;
  await writeJson(manifestPath, manifest);

  const report = await setupModule({ ...fixture, noApp: true });

  expect(report).toMatchObject({
    status: "actionable",
    module: { company: "Acme", id: "path-owned" },
  });
  expect(report.issues).toEqual([]);
});

test("an unrelated checkout with the same remote URL cannot claim a Module slot", async () => {
  const fixture = await moduleFixture({ module: "foreign-checkout" });
  await writeJson(
    join(fixture.moduleRoot, "package.json"),
    legacyPackage({ company: "Acme", module: "foreign-checkout", port: 24_014 }),
  );
  initGitModule(fixture.moduleRoot);
  const foreignRoot = join(fixture.organizationRoot, ".foreign", "foreign-checkout");
  await mkdir(foreignRoot, { recursive: true });
  await writeJson(
    join(foreignRoot, "package.json"),
    legacyPackage({ company: "Acme", module: "foreign-checkout", port: 24_014 }),
  );
  initGitModule(foreignRoot);
  runGit(foreignRoot, ["remote", "add", "origin", "git@github.com:Acme/foreign-checkout.git"]);

  const report = await setupModule({ ...fixture, moduleRoot: foreignRoot, apply: true });

  expect(report).toMatchObject({ status: "action_required", reason: "module_root_not_linked_to_slot" });
  expect(validateAgainstSchema(report, reportSchema, "module-setup")).toEqual([]);
  expect(await Bun.file(join(foreignRoot, "lazurio.module.json")).exists()).toBe(false);
  expect((await readJson(join(foreignRoot, "package.json"))).companyascode.app.port).toBe(24_014);
});

test("concurrent Module setup serializes on the existing Organization port allocator lock", async () => {
  const first = await moduleFixture({ module: "parallel-one" });
  const second = await addModuleSlot(first, { module: "parallel-two" });
  for (const fixture of [first, second]) {
    await writeJson(join(fixture.moduleRoot, "package.json"), {
      name: fixture.module,
      private: true,
      scripts: { dev: "bun server.mjs" },
    });
  }
  const appOptions = (fixture) => ({
    ...fixture,
    apply: true,
    appPackage: "package.json",
    appId: `acme-${fixture.module}-v1`,
    title: fixture.module,
    devScript: "dev",
  });

  const reports = await Promise.all([
    setupModule(appOptions(first)),
    setupModule(appOptions(second)),
  ]);
  expect(reports.map((report) => report.status)).toEqual(["completed", "completed"]);
  const ports = await Promise.all([first, second].map(async (fixture) =>
    (await readJson(join(fixture.moduleRoot, "lazurio.module.json"))).port_leases[0].port
  ));
  expect(ports.sort((left, right) => left - right)).toEqual([24_000, 24_001]);
});

async function moduleFixture({ module, status = null }) {
  const root = await mkdtemp(join(tmpdir(), "lazurio-module-setup-"));
  roots.push(root);
  const organizationRoot = join(root, "organizations", "Acme_GEN3");
  const moduleRoot = join(organizationRoot, "workspace", module);
  await mkdir(moduleRoot, { recursive: true });
  await writeJson(join(organizationRoot, "company.gen3.json"), {
    organization_generation: "gen3",
    company: { slug: "Acme", display_name: "Acme" },
    module_port_pool: { start: 24_000, end: 24_099 },
  });
  await writeJson(join(organizationRoot, "modules.manifest.json"), {
    organization_generation: "gen3",
    company: "Acme",
    module_slots: [{
      path: `workspace/${module}`,
      slug: module,
      ...(status ? { status } : {}),
      git: { url: `git@github.com:Acme/${module}.git`, branch: "main" },
    }],
  });
  return { lazurioRoot: root, moduleRoot, organizationRoot, module };
}

async function addModuleSlot(fixture, { module }) {
  const manifestPath = join(fixture.organizationRoot, "modules.manifest.json");
  const manifest = await readJson(manifestPath);
  manifest.module_slots.push({
    path: `workspace/${module}`,
    slug: module,
    git: { url: `git@github.com:Acme/${module}.git`, branch: "main" },
  });
  await writeJson(manifestPath, manifest);
  const moduleRoot = join(fixture.organizationRoot, "workspace", module);
  await mkdir(moduleRoot, { recursive: true });
  return { ...fixture, moduleRoot, module };
}

function legacyPackage({ company, module, port }) {
  return {
    name: module,
    private: true,
    scripts: { dev: "bun server.mjs" },
    companyascode: {
      app: {
        schema_version: "companyascode.launchpad_app.v1",
        id: `${company.toLowerCase()}-${module}-v1`,
        title: module,
        company,
        module,
        surface: "internal",
        port,
        host: "127.0.0.1",
        health_path: "/health",
        dev_script: "dev",
        tags: [module],
      },
    },
  };
}

function declaredPackage({ company, module }) {
  return {
    name: module,
    private: true,
    scripts: { dev: "bun server.mjs" },
    lazurio: {
      runtime: {
        schema_version: "lazurio.runtime.v1",
        id: `${company.toLowerCase()}-${module}-v1`,
        title: module,
        company,
        module,
        surface: "internal",
        dev_script: "dev",
        tags: [module],
        listeners: [{
          id: "app",
          role: "entrypoint",
          lease: "main",
          protocol: "http",
          health: { kind: "http", path: "/health" },
        }],
      },
    },
  };
}

function initGitModule(root) {
  runGit(root, ["init"]);
  runGit(root, ["config", "user.name", "Lazurio Test"]);
  runGit(root, ["config", "user.email", "lazurio-test@example.invalid"]);
  runGit(root, ["add", "."]);
  runGit(root, ["commit", "-m", "fixture"]);
}

function runGit(cwd, args) {
  const executable = Bun.which("git");
  if (!executable) throw new Error("Git is required for Module setup worktree tests");
  const result = Bun.spawnSync([executable, ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
    },
  });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`);
  }
  return result.stdout.toString().trim();
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
