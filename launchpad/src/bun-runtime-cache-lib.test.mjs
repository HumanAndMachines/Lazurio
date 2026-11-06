import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  realpath,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  BunRuntimeRefused,
  createModuleBunResolver,
  moduleBunLocks,
  moduleBunRoot,
  moduleBunUsed,
} from "../../lazurio/runtime/bun-runtime-lib.mjs";
import {
  bunCachePruneReport,
  bunPinInventory,
  bunProcessCheck,
  bunRecentUseMs,
  formatBunRuntimesReport,
  linuxProcTable,
  prewarmBunRuntimes,
  updateBunRuntimes,
} from "../../lazurio/runtime/bun-runtime-cache-lib.mjs";
import { discoverLaunchpadApps } from "../../lazurio/runtime/discovery-lib.mjs";
import { runLazurioUpdate } from "../../lazurio/runtime/lazurio-update-lib.mjs";

// Plan DEV-6682 M2b-2b (#640; decision 0171, addendum of 2026-10-24, point 5):
// `lazurio update` on a computer fetches ahead the Bun versions the root and
// its Apps pin, and reports what a prune of the runtime cache would remove and
// why every other version stays. Nothing is removed in this release. No case
// here uses the network, the real runtime cache or the real process table:
// every root, home and cache is temporary, Bun's distribution is a fake and so
// is every process listing.
const supported = ["darwin", "linux"].includes(process.platform);
const posixTest = test.skipIf(!supported);
// Permission denials need a user the kernel holds to them.
const permissionTest = test.skipIf(!supported || process.getuid?.() === 0);
const day = 24 * 60 * 60 * 1000;
const linuxArm = Object.freeze({ platform: "linux", arch: "arm64", libc: "glibc", avx2: null });

let scratch = "";
let made = 0;
beforeAll(async () => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), "lazurio-bun-cache-")));
});
afterAll(async () => {
  if (scratch) await rm(scratch, { recursive: true, force: true });
});

async function freshDirectory(name) {
  made += 1;
  const path = join(scratch, `${name}-${made}`);
  await mkdir(path, { recursive: true });
  return path;
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

const toolchain = (bunDefault) => ({
  schema_version: "lazurio.toolchain.v1",
  tools: {
    bun: { default: bunDefault, minimum: bunDefault },
    node: { minimum: "22.12.0" },
    uv: { default: "0.11.6" },
    gh: { minimum: "2.57.0" },
    git: { minimum: "2.31.0" },
  },
});

// A Lazurio root with its own CLI pin and toolchain manifest and one mounted
// Organization whose Modules are declared slots.
async function lazurioRoot(name, { cliPin = "1.4.80", bunDefault = "1.4.81", modules = [] } = {}) {
  const root = await freshDirectory(name);
  const organization = join(root, "organizations", "TestCompany");
  for (const path of ["launchpad", "guide", "manual"]) await mkdir(join(root, path), { recursive: true });
  for (const path of ["manual", join("company", "colleagues")]) await mkdir(join(organization, path), { recursive: true });
  await writeJson(join(root, "launchpad.gen3.json"), {
    launchpad_root: { slug: "test-companies", display_name: "Test Companies", root_role: "companies-root" },
  });
  if (cliPin !== null) {
    await writeJson(join(root, "lazurio", "package.json"), {
      name: "@lazurio/runtime",
      private: true,
      packageManager: `bun@${cliPin}`,
    });
  }
  if (bunDefault !== null) await writeJson(join(root, "lazurio", "toolchain.json"), toolchain(bunDefault));
  await writeJson(join(organization, "company.gen3.json"), {
    organization_generation: "gen3",
    company: { slug: "test-company", display_name: "Test Company", github_org: "TestCompany" },
    module_port_pool: { start: 5600, end: 5999 },
  });
  await writeJson(join(organization, "modules.manifest.json"), {
    company: "test-company",
    github_org: "TestCompany",
    module_slots: modules.map((id) => ({
      path: `workspace/${id}`,
      slug: id,
      git: { url: `git@github.com:TestCompany/${id}.git`, branch: "main" },
    })),
  });
  for (const file of ["TODO.tasks.json", "DONE.tasks.json", "ISSUES.open.json"]) {
    await writeJson(join(organization, file), {});
  }
  return { root, organization, workspace: join(organization, "workspace") };
}

let port = 5600;
// An App's package.json with the legacy manifest discovery reads, and the Bun
// it pins.
async function writeApp(directory, module, packageManager) {
  port += 1;
  await writeJson(join(directory, "package.json"), {
    name: `test-company-${module}-v1`,
    private: true,
    type: "module",
    ...(packageManager === undefined ? {} : { packageManager }),
    scripts: { dev: "bun server.mjs" },
    companyascode: {
      app: {
        schema_version: "companyascode.launchpad_app.v1",
        id: `test-company-${module}-v1`,
        title: `App ${module}`,
        company: "test-company",
        module,
        surface: "internal",
        port,
        host: "127.0.0.1",
        health_path: "/health",
        dev_script: "dev",
        tags: ["test"],
      },
    },
  });
}

// An App of a Module under the Lazurio Module Standard: its package.json with
// `lazurio.runtime` and the Bun it pins, beside the Module's marker.
async function writeModuleApp(moduleRoot, module, packageManager) {
  port += 1;
  await writeJson(join(moduleRoot, "lazurio.module.json"), {
    schema_version: "lazurio.module.v1",
    id: module,
    company: "test-company",
    tcp_port_policy: { mode: "single" },
    port_leases: [{ id: "main", host: "127.0.0.1", port }],
    apps: ["app/v1/package.json"],
    default_app: "app/v1/package.json",
  });
  await writeJson(join(moduleRoot, "app", "v1", "package.json"), {
    name: `test-company-${module}-v1`,
    private: true,
    type: "module",
    packageManager,
    scripts: { dev: "bun server.mjs" },
    lazurio: {
      runtime: {
        schema_version: "lazurio.runtime.v1",
        id: `test-company-${module}-v1`,
        title: `App ${module}`,
        company: "test-company",
        module,
        surface: "internal",
        dev_script: "dev",
        tags: ["test"],
        listeners: [{ id: "web", role: "entrypoint", lease: "main", protocol: "http", health: { kind: "http", path: "/" } }],
      },
    },
  });
}

// A root whose Apps pin Bun in main, in an Organization environment worktree
// and in a Module's own worktree, beside packages no App inventory counts.
async function pinnedWorld(name, { modules = [] } = {}) {
  const world = await lazurioRoot(name, { modules: ["notes", "shared", "tasks", "loose", ...modules] });
  const { workspace, organization } = world;
  await writeApp(join(workspace, "notes", "app", "v1"), "notes", "bun@1.4.90");
  await writeApp(join(workspace, "shared", "app", "v1"), "shared", "bun@1.4.90");
  // Only an exact version is a pin.
  await writeApp(join(workspace, "loose", "app", "v1"), "loose", "bun@^1.4");
  // tasks is a Module checkout of its own, and its worktrees live inside it.
  await writeModuleApp(join(workspace, "tasks"), "tasks", "bun@1.4.91");
  const organizationWorktree = join(organization, ".worktrees", "root", "DEV-0001-notes");
  await writeApp(join(organizationWorktree, "workspace", "notes", "app", "v1"), "notes", "bun@1.4.92");
  const moduleWorktree = join(workspace, "tasks", ".worktrees", "root", "DEV-0002-tasks");
  await writeModuleApp(moduleWorktree, "tasks", "bun@1.4.93");
  // Not Apps, or where discovery never looks for Apps either: a library, a
  // dependency, Productionspace and a hidden directory.
  await writeJson(join(organizationWorktree, "workspace", "notes", "lib", "package.json"), {
    name: "lib",
    private: true,
    packageManager: "bun@1.4.94",
  });
  await writeApp(join(organizationWorktree, "workspace", "notes", "app", "v1", "node_modules", "dep"), "dep", "bun@1.4.95");
  await writeApp(join(organizationWorktree, "productionspace", "site", "app", "v1"), "site", "bun@1.4.96");
  await writeApp(join(organizationWorktree, ".cache", "app"), "hidden", "bun@1.4.97");
  return { ...world, organizationWorktree, moduleWorktree };
}

const publicPin = ({ version, cli_pin, default: isDefault, apps }) => ({ version, cli_pin, default: isDefault, apps });

test("the pins root sees after the sync: the CLI's, the default, every App of a mounted Organization through discovery, and every App in their worktrees through an enumeration of its own, which discovery leaves out", async () => {
  const world = await pinnedWorld("inventory");
  // Discovery never walks .worktrees, on purpose.
  const discovered = await discoverLaunchpadApps(world.root);
  expect(discovered.failures).toEqual([]);
  expect(discovered.organization_issues).toEqual([]);
  expect(discovered.apps.map((app) => app.package_path).sort()).toEqual([
    "organizations/TestCompany/workspace/loose/app/v1/package.json",
    "organizations/TestCompany/workspace/notes/app/v1/package.json",
    "organizations/TestCompany/workspace/shared/app/v1/package.json",
    "organizations/TestCompany/workspace/tasks/app/v1/package.json",
  ]);

  const inventory = await bunPinInventory({ rootPath: world.root });
  expect({ complete: inventory.complete, issues: inventory.issues }).toEqual({ complete: true, issues: [] });
  // The CLI's pin first, then the default, then the Apps' pins by version.
  expect(inventory.pins.map(publicPin)).toEqual([
    { version: "1.4.80", cli_pin: true, default: false, apps: 0 },
    { version: "1.4.81", cli_pin: false, default: true, apps: 0 },
    { version: "1.4.90", cli_pin: false, default: false, apps: 2 },
    { version: "1.4.91", cli_pin: false, default: false, apps: 1 },
    { version: "1.4.92", cli_pin: false, default: false, apps: 1 },
    { version: "1.4.93", cli_pin: false, default: false, apps: 1 },
  ]);
  // Each pin names a package that pins it, for the words of a refusal.
  expect(Object.fromEntries(inventory.pins.map((pin) => [pin.version, pin.file]))).toEqual({
    "1.4.80": "lazurio/package.json",
    "1.4.81": "lazurio/toolchain.json",
    "1.4.90": "organizations/TestCompany/workspace/notes/app/v1/package.json",
    "1.4.91": "organizations/TestCompany/workspace/tasks/app/v1/package.json",
    "1.4.92": "organizations/TestCompany/.worktrees/root/DEV-0001-notes/workspace/notes/app/v1/package.json",
    "1.4.93": "organizations/TestCompany/workspace/tasks/.worktrees/root/DEV-0002-tasks/app/v1/package.json",
  });
  // One version that is both the CLI's and the default is one pin.
  const same = await lazurioRoot("inventory-same", { cliPin: "1.4.80", bunDefault: "1.4.80" });
  expect((await bunPinInventory({ rootPath: same.root })).pins.map(publicPin)).toEqual([
    { version: "1.4.80", cli_pin: true, default: true, apps: 0 },
  ]);
});

posixTest("a root reached through a link walks each worktree directory once, however discovery spells its checkout", async () => {
  const world = await pinnedWorld("inventory-linked-root");
  const link = join(await freshDirectory("inventory-link"), "Lazurio");
  await symlink(world.root, link);
  const inventory = await bunPinInventory({ rootPath: link });
  expect({ complete: inventory.complete, issues: inventory.issues }).toEqual({ complete: true, issues: [] });
  expect(inventory.pins.map(publicPin)).toEqual((await bunPinInventory({ rootPath: world.root })).pins.map(publicPin));
});

test("an inventory that root cannot complete says so and why: discovery that fails or reports a problem, and an unreadable CLI pin or toolchain manifest", async () => {
  const world = await pinnedWorld("incomplete-discovery");
  const failing = await bunPinInventory({
    rootPath: world.root,
    discoverApps: async () => { throw new Error("discovery broke"); },
  });
  expect(failing.complete).toBe(false);
  expect(failing.issues).toEqual(["discovery: discovery broke"]);
  // What it still knows is still pinned.
  expect(failing.pins.map((pin) => pin.version)).toEqual(["1.4.80", "1.4.81"]);

  const reporting = await bunPinInventory({
    rootPath: world.root,
    discoverApps: async () => ({
      apps: [],
      invalid_apps: [],
      organizations: [],
      organization_issues: [{ message: "organizations/Broken: Organization manifest konflikt" }],
      failures: ["organizations/Broken: Organization manifest konflikt"],
    }),
  });
  expect(reporting.complete).toBe(false);
  expect(reporting.issues).toContain("discovery: organizations/Broken: Organization manifest konflikt");

  const bare = await lazurioRoot("incomplete-pins", { cliPin: null, bunDefault: null });
  const unpinned = await bunPinInventory({ rootPath: bare.root });
  expect(unpinned.complete).toBe(false);
  expect(unpinned.pins).toEqual([]);
  expect(unpinned.issues.map((issue) => issue.split(":")[0])).toEqual(["cli_pin", "default"]);
});

test("an App whose package.json root cannot read leaves the inventory incomplete", async () => {
  const world = await pinnedWorld("incomplete-app");
  await writeFile(join(world.workspace, "shared", "app", "v1", "package.json"), "{ \"name\": ", "utf8");
  const inventory = await bunPinInventory({ rootPath: world.root });
  expect(inventory.complete).toBe(false);
  expect(inventory.issues.some((issue) => issue.includes("organizations/TestCompany/workspace/shared/app/v1/package.json"))).toBe(true);
});

test("the worktree enumeration fails closed: a package it cannot parse, a linked .worktrees it does not follow, and a walk beyond its bound", async () => {
  const unparsable = await pinnedWorld("worktree-unparsable");
  await writeFile(join(unparsable.moduleWorktree, "app", "v1", "package.json"), "<<<<<<< HEAD\n", "utf8");
  const parsed = await bunPinInventory({ rootPath: unparsable.root });
  expect(parsed.complete).toBe(false);
  expect(parsed.issues.some((issue) => issue.startsWith("worktrees: ") && issue.includes("DEV-0002-tasks/app/v1/package.json"))).toBe(true);
  expect(parsed.pins.map((pin) => pin.version)).not.toContain("1.4.93");

  const linked = await pinnedWorld("worktree-linked");
  const elsewhere = await freshDirectory("worktrees-elsewhere");
  await writeApp(join(elsewhere, "root", "DEV-0003", "app", "v1"), "notes", "bun@1.4.98");
  await rm(join(linked.organization, ".worktrees"), { recursive: true, force: true });
  await symlink(elsewhere, join(linked.organization, ".worktrees"));
  const followed = await bunPinInventory({ rootPath: linked.root });
  expect(followed.complete).toBe(false);
  expect(followed.issues).toContain("worktrees: organizations/TestCompany/.worktrees: not a directory");
  expect(followed.pins.map((pin) => pin.version)).not.toContain("1.4.98");

  const bounded = await pinnedWorld("worktree-bound");
  const walked = await bunPinInventory({ rootPath: bounded.root, entryBudget: 3 });
  expect(walked.complete).toBe(false);
  expect(walked.issues).toContain("worktrees: more than 3 entries");
});

permissionTest("a worktree directory root cannot read leaves the inventory incomplete", async () => {
  const world = await pinnedWorld("worktree-unreadable");
  const locked = join(world.organizationWorktree, "workspace");
  await chmod(locked, 0o000);
  try {
    const inventory = await bunPinInventory({ rootPath: world.root });
    expect(inventory.complete).toBe(false);
    expect(inventory.issues).toContain(
      "worktrees: organizations/TestCompany/.worktrees/root/DEV-0001-notes/workspace: EACCES",
    );
    expect(inventory.pins.map((pin) => pin.version)).not.toContain("1.4.92");
  } finally {
    await chmod(locked, 0o755);
  }
});

// A resolver that answers as told: `user`, `cache` or `fetched`, a refusal by
// its reason, or an error that is no refusal.
function scriptedResolver(outcomes) {
  const asked = [];
  const resolve = async ({ packageManager, owner }) => {
    const version = packageManager.slice("bun@".length);
    asked.push({ version, owner });
    const outcome = outcomes[version] ?? "cache";
    if (outcome instanceof Error) throw outcome;
    if (outcome.startsWith("runtime-")) {
      throw new BunRuntimeRefused(outcome, { path: join(owner, "package.json"), version });
    }
    return { executable: `/fake/${version}/bun`, binDir: outcome === "user" ? null : `/fake/${version}`, source: outcome };
  };
  return { resolve, asked };
}

const pin = (version, overrides = {}) => ({
  version,
  cli_pin: false,
  default: false,
  apps: 1,
  owner: `/root/organizations/TestCompany/workspace/app-${version}`,
  file: `organizations/TestCompany/workspace/app-${version}/package.json`,
  ...overrides,
});
const cliPin = (version) => pin(version, { cli_pin: true, apps: 0, owner: "/root/lazurio", file: "lazurio/package.json" });
const defaultPin = (version) => pin(version, { default: true, apps: 0, owner: "/root/lazurio", file: "lazurio/toolchain.json" });

test("the pre-warm asks the resolver for one version at a time in the inventory's order: the user's Bun and a cached version download nothing, any other is fetched", async () => {
  const { resolve, asked } = scriptedResolver({ "1.4.80": "cache", "1.4.81": "user", "1.4.90": "fetched" });
  const warnings = [];
  expect(await prewarmBunRuntimes({
    pins: [cliPin("1.4.80"), defaultPin("1.4.81"), pin("1.4.90", { apps: 2 }), pin("1.4.91")],
    resolve,
    warnings,
  })).toEqual([
    { version: "1.4.80", cli_pin: true, default: false, apps: 0, state: "cached" },
    { version: "1.4.81", cli_pin: false, default: true, apps: 0, state: "user" },
    { version: "1.4.90", cli_pin: false, default: false, apps: 2, state: "fetched" },
    { version: "1.4.91", cli_pin: false, default: false, apps: 1, state: "cached" },
  ]);
  expect(asked).toEqual([
    { version: "1.4.80", owner: "/root/lazurio" },
    { version: "1.4.81", owner: "/root/lazurio" },
    { version: "1.4.90", owner: "/root/organizations/TestCompany/workspace/app-1.4.90" },
    { version: "1.4.91", owner: "/root/organizations/TestCompany/workspace/app-1.4.91" },
  ]);
  expect(warnings).toEqual([]);
});

test("the first registry that does not answer ends the pre-warm: that version is refused and every later one is not fetched, offline, without asking", async () => {
  const { resolve, asked } = scriptedResolver({ "1.4.80": "cache", "1.4.81": "runtime-unavailable" });
  const warnings = [];
  expect(await prewarmBunRuntimes({
    pins: [cliPin("1.4.80"), defaultPin("1.4.81"), pin("1.4.90"), pin("1.4.91")],
    resolve,
    warnings,
  })).toEqual([
    { version: "1.4.80", cli_pin: true, default: false, apps: 0, state: "cached" },
    { version: "1.4.81", cli_pin: false, default: true, apps: 0, state: "refused", reason: "runtime-unavailable" },
    { version: "1.4.90", cli_pin: false, default: false, apps: 1, state: "not_fetched", reason: "offline" },
    { version: "1.4.91", cli_pin: false, default: false, apps: 1, state: "not_fetched", reason: "offline" },
  ]);
  expect(asked.map((entry) => entry.version)).toEqual(["1.4.80", "1.4.81"]);
  // Offline is no warning.
  expect(warnings).toEqual([]);
});

test("every other refusal is reported and the pre-warm goes on; an integrity failure is also a warning naming the package that pins it; an error that is no refusal is reported too", async () => {
  const { resolve, asked } = scriptedResolver({
    "1.4.90": "runtime-integrity-failed",
    "1.4.91": "runtime-version-unknown",
    "1.4.92": "runtime-disk-full",
    "1.4.93": "runtime-unsupported-platform",
    "1.4.94": new TypeError("the user's Bun does not run"),
    "1.4.95": "fetched",
  });
  const warnings = [];
  const states = await prewarmBunRuntimes({
    pins: ["1.4.90", "1.4.91", "1.4.92", "1.4.93", "1.4.94", "1.4.95"].map((version) => pin(version)),
    resolve,
    warnings,
  });
  expect(states.map(({ version, state, reason, detail }) => ({ version, state, reason, detail }))).toEqual([
    { version: "1.4.90", state: "refused", reason: "runtime-integrity-failed", detail: undefined },
    { version: "1.4.91", state: "refused", reason: "runtime-version-unknown", detail: undefined },
    { version: "1.4.92", state: "refused", reason: "runtime-disk-full", detail: undefined },
    { version: "1.4.93", state: "refused", reason: "runtime-unsupported-platform", detail: undefined },
    { version: "1.4.94", state: "failed", reason: "error", detail: "the user's Bun does not run" },
    { version: "1.4.95", state: "fetched", reason: undefined, detail: undefined },
  ]);
  expect(asked).toHaveLength(6);
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain("1.4.90");
  expect(warnings[0]).toContain("organizations/TestCompany/workspace/app-1.4.90/package.json");
  expect(warnings[0]).toContain("neprošel kontrolou");
});

// A runtime cache as the resolver places it: each version's own install of
// Bun's npm package, its program, `bunx` beside it and its package.json.
async function cachedVersion(cacheRoot, version, bytes = 1000, targets = ["darwin-aarch64"]) {
  const directory = join(cacheRoot, version);
  for (const target of targets) {
    const program = join(directory, "node_modules", "@oven", `bun-${target}`, "bin", "bun");
    await mkdir(dirname(program), { recursive: true });
    await writeFile(program, "x".repeat(bytes), { mode: 0o755 });
    await symlink("bun", join(dirname(program), "bunx"));
  }
  await writeFile(join(directory, "package.json"), "{}\n");
  return directory;
}

async function usedAt(usedRoot, version, at) {
  await mkdir(usedRoot, { recursive: true });
  await writeFile(join(usedRoot, version), "");
  await utimes(join(usedRoot, version), at, at);
}

async function cacheHome(name) {
  const home = await freshDirectory(name);
  return { home, cacheRoot: moduleBunRoot(home), usedRoot: moduleBunUsed(home) };
}

const inventoryOf = ({ cli = null, bunDefault = null, apps = {}, complete = true } = {}) => ({
  complete,
  issues: complete ? [] : ["worktrees: organizations/TestCompany/.worktrees: EACCES"],
  pins: [...new Set([cli, bunDefault, ...Object.keys(apps)].filter(Boolean))].map((version) => ({
    version,
    cli_pin: version === cli,
    default: version === bunDefault,
    apps: apps[version] ?? 0,
  })),
});

// A process check that answers as told, every other version free, and that
// remembers what it was asked.
function processes(states = {}) {
  const asked = [];
  const check = async (versions) => {
    asked.push(versions);
    return new Map(versions.map(({ version }) => [version, states[version] ?? "free"]));
  };
  return Object.assign(check, { asked });
}

const now = new Date("2026-10-25T12:00:00.000Z");
const longAgo = new Date(now.getTime() - 30 * day);

test("each keep reason alone keeps a version, and only a version no reason applies to would be removed, with the bytes each version holds and what removing would free", async () => {
  const { cacheRoot, usedRoot } = await cacheHome("reasons-alone");
  const sizes = { "1.4.70": 7000, "1.4.80": 8000, "1.4.81": 8100, "1.4.90": 9000, "1.4.91": 9100, "1.4.92": 9200 };
  for (const [version, bytes] of Object.entries(sizes)) {
    await cachedVersion(cacheRoot, version, bytes);
    await usedAt(usedRoot, version, version === "1.4.91" ? new Date(now.getTime() - day) : longAgo);
  }
  const report = await bunCachePruneReport({
    cacheRoot,
    usedRoot,
    now,
    inventory: inventoryOf({ cli: "1.4.80", bunDefault: "1.4.81", apps: { "1.4.90": 2 } }),
    processCheck: processes({ "1.4.92": "held" }),
  });
  // A version's bytes: its files, links not followed (the program and its
  // package.json; `bunx` is a link).
  expect(report).toEqual({
    mode: "report_only",
    cache_root: cacheRoot,
    state: "ready",
    versions: [
      { version: "1.4.70", bytes: 7003, verdict: "would_remove", reasons: [] },
      { version: "1.4.80", bytes: 8003, verdict: "kept", reasons: ["cli_pin"] },
      { version: "1.4.81", bytes: 8103, verdict: "kept", reasons: ["default"] },
      { version: "1.4.90", bytes: 9003, verdict: "kept", reasons: ["pinned_by_apps: 2"] },
      { version: "1.4.91", bytes: 9103, verdict: "kept", reasons: ["used_recently: 2026-10-24T12:00:00.000Z"] },
      { version: "1.4.92", bytes: 9203, verdict: "kept", reasons: ["held_by_process"] },
    ],
    would_free_bytes: 7003,
  });
});

test("what root cannot know keeps a version too: no marker yet, an incomplete inventory, a process check that failed and a system without one; every reason that applies is listed, in one order", async () => {
  const { cacheRoot, usedRoot } = await cacheHome("reasons-unknown");
  for (const version of ["1.4.70", "1.4.71", "1.4.72", "1.4.73", "1.4.80"]) await cachedVersion(cacheRoot, version);
  for (const version of ["1.4.71", "1.4.72", "1.4.73"]) await usedAt(usedRoot, version, longAgo);
  await usedAt(usedRoot, "1.4.80", new Date(now.getTime() - 2 * day));
  const inventory = inventoryOf({ cli: "1.4.80", bunDefault: "1.4.80", apps: { "1.4.80": 3 } });
  const check = processes({ "1.4.71": "failed", "1.4.72": "unsupported", "1.4.80": "held" });
  const reasons = async (options) => Object.fromEntries((await bunCachePruneReport({ cacheRoot, usedRoot, now, ...options }))
    .versions.map(({ version, verdict, reasons: why }) => [version, [verdict, ...why]]));

  expect(await reasons({ inventory, processCheck: check })).toEqual({
    "1.4.70": ["kept", "unknown: no_marker_history"],
    "1.4.71": ["kept", "unknown: process_check_failed"],
    "1.4.72": ["kept", "unknown: no_process_check"],
    "1.4.73": ["would_remove"],
    "1.4.80": ["kept", "cli_pin", "default", "pinned_by_apps: 3", "used_recently: 2026-10-23T12:00:00.000Z", "held_by_process"],
  });
  expect(await reasons({ inventory: { ...inventory, complete: false }, processCheck: check })).toEqual({
    "1.4.70": ["kept", "unknown: no_marker_history", "unknown: inventory_incomplete"],
    "1.4.71": ["kept", "unknown: inventory_incomplete", "unknown: process_check_failed"],
    "1.4.72": ["kept", "unknown: inventory_incomplete", "unknown: no_process_check"],
    "1.4.73": ["kept", "unknown: inventory_incomplete"],
    "1.4.80": ["kept", "cli_pin", "default", "pinned_by_apps: 3", "used_recently: 2026-10-23T12:00:00.000Z", "held_by_process", "unknown: inventory_incomplete"],
  });
  // A check that throws, or that leaves a version out, knows nothing.
  const thrown = await reasons({ inventory, processCheck: async () => { throw new Error("lsof broke"); } });
  expect(thrown["1.4.73"]).toEqual(["kept", "unknown: process_check_failed"]);
  const partial = await reasons({ inventory, processCheck: async () => new Map([["1.4.70", "free"]]) });
  expect(partial["1.4.73"]).toEqual(["kept", "unknown: process_check_failed"]);
});

test("a marker counts within 14 days of the local clock, one in the future counts as used now, and one that is not a plain file is no marker", async () => {
  expect(bunRecentUseMs).toBe(14 * day);
  const { cacheRoot, usedRoot } = await cacheHome("reasons-time");
  for (const version of ["1.4.70", "1.4.71", "1.4.72", "1.4.73", "1.4.74"]) await cachedVersion(cacheRoot, version);
  await usedAt(usedRoot, "1.4.70", new Date(now.getTime() - 14 * day + 1000));
  await usedAt(usedRoot, "1.4.71", new Date(now.getTime() - 14 * day - 1000));
  await usedAt(usedRoot, "1.4.72", new Date(now.getTime() + day));
  await mkdir(join(usedRoot, "1.4.73"));
  await symlink(join(usedRoot, "1.4.72"), join(usedRoot, "1.4.74"));
  const report = await bunCachePruneReport({ cacheRoot, usedRoot, now, inventory: inventoryOf(), processCheck: processes() });
  expect(Object.fromEntries(report.versions.map(({ version, reasons }) => [version, reasons]))).toEqual({
    "1.4.70": ["used_recently: 2026-10-11T12:00:01.000Z"],
    "1.4.71": [],
    "1.4.72": ["used_recently: 2026-10-26T12:00:00.000Z"],
    "1.4.73": ["unknown: no_marker_history"],
    "1.4.74": ["unknown: no_marker_history"],
  });
});

test("only a real directory directly under the cache root with an exact version as its name is a candidate; everything else is never looked into", async () => {
  const { cacheRoot, usedRoot } = await cacheHome("candidates");
  const version = await cachedVersion(cacheRoot, "1.4.90");
  await usedAt(usedRoot, "1.4.90", longAgo);
  // Leftovers of a fetch, names that are not exact versions, a file, a link
  // to a version and a link to elsewhere.
  for (const name of [".tmp-abc", ".trash-def", "1.4", "v1.4.91", "1.4.92-canary", "1.4.9.1"]) {
    await cachedVersion(cacheRoot, name);
  }
  await writeFile(join(cacheRoot, "1.4.93"), "a file\n");
  await symlink(version, join(cacheRoot, "1.4.94"));
  const elsewhere = await freshDirectory("elsewhere-version");
  await cachedVersion(elsewhere, "1.4.95");
  await symlink(join(elsewhere, "1.4.95"), join(cacheRoot, "1.4.95"));
  await writeFile(join(cacheRoot, "README"), "not a version\n");
  const check = processes();
  const report = await bunCachePruneReport({ cacheRoot, usedRoot, now, inventory: inventoryOf(), processCheck: check });
  expect(report.versions.map((entry) => entry.version)).toEqual(["1.4.90"]);
  expect(check.asked).toEqual([[{ version: "1.4.90", directory: version }]]);
});

test("a cache root that is absent, a link, a file or empty has no candidates and asks no process check", async () => {
  const absent = await cacheHome("root-absent");
  const check = processes();
  const report = (cacheRoot) => bunCachePruneReport({
    cacheRoot,
    usedRoot: absent.usedRoot,
    now,
    inventory: inventoryOf(),
    processCheck: check,
  });
  expect(await report(absent.cacheRoot)).toEqual({
    mode: "report_only",
    cache_root: absent.cacheRoot,
    state: "absent",
    versions: [],
    would_free_bytes: 0,
  });
  const linked = await cacheHome("root-linked");
  const target = await freshDirectory("root-linked-target");
  await cachedVersion(target, "1.4.90");
  await mkdir(dirname(linked.cacheRoot), { recursive: true });
  await symlink(target, linked.cacheRoot);
  expect(await report(linked.cacheRoot)).toMatchObject({ state: "linked", versions: [], would_free_bytes: 0 });
  const file = await cacheHome("root-file");
  await mkdir(dirname(file.cacheRoot), { recursive: true });
  await writeFile(file.cacheRoot, "not a directory\n");
  expect(await report(file.cacheRoot)).toMatchObject({ state: "not_a_directory", versions: [] });
  const empty = await cacheHome("root-empty");
  await mkdir(empty.cacheRoot, { recursive: true });
  expect(await report(empty.cacheRoot)).toMatchObject({ state: "ready", versions: [], would_free_bytes: 0 });
  expect(check.asked).toEqual([]);
});

permissionTest("a cache root that cannot be read is reported as such", async () => {
  const { cacheRoot, usedRoot } = await cacheHome("root-unreadable");
  await cachedVersion(cacheRoot, "1.4.90");
  await chmod(cacheRoot, 0o000);
  try {
    expect(await bunCachePruneReport({ cacheRoot, usedRoot, now, inventory: inventoryOf(), processCheck: processes() }))
      .toMatchObject({ state: "unreadable", versions: [], would_free_bytes: 0 });
  } finally {
    await chmod(cacheRoot, 0o700);
  }
});

// Every entry below a directory, links not followed: its kind, mode, size,
// modification time, content and link target.
async function snapshot(directory) {
  const entries = [];
  const walk = async (path) => {
    for (const name of (await readdir(path)).sort()) {
      const entry = join(path, name);
      const info = await lstat(entry);
      const kind = info.isSymbolicLink() ? "link" : info.isDirectory() ? "directory" : info.isFile() ? "file" : "other";
      entries.push({
        path: entry.slice(directory.length),
        kind,
        mode: info.mode,
        size: kind === "directory" ? null : info.size,
        mtimeMs: info.mtimeMs,
        content: kind === "file" ? createHash("sha256").update(await readFile(entry)).digest("hex") : null,
        target: kind === "link" ? await readlink(entry) : null,
      });
      if (kind === "directory") await walk(entry);
    }
  };
  await walk(directory);
  return entries;
}

test("the prune report never deletes, renames or changes anything: the runtime cache, its markers and its locks are byte-identical before and after", async () => {
  const { home, cacheRoot, usedRoot } = await cacheHome("byte-identical");
  for (const version of ["1.4.70", "1.4.80", "1.4.90"]) {
    await cachedVersion(cacheRoot, version, 4096, ["darwin-x64", "darwin-x64-baseline"]);
    await writeFile(join(cacheRoot, version, "bun.lock"), "# lock\n");
  }
  await usedAt(usedRoot, "1.4.70", longAgo);
  await usedAt(usedRoot, "1.4.90", new Date(now.getTime() - day));
  await mkdir(moduleBunLocks(home), { recursive: true });
  for (const version of ["1.4.70", "1.4.80"]) await writeFile(join(moduleBunLocks(home), version), "");
  await cachedVersion(cacheRoot, ".tmp-abc");
  await mkdir(join(cacheRoot, ".trash-def", "version"), { recursive: true });
  await writeFile(join(cacheRoot, "1.4.93"), "a file\n");
  await symlink(join(cacheRoot, "1.4.90"), join(cacheRoot, "1.4.94"));
  const runtimes = dirname(cacheRoot);
  const before = await snapshot(runtimes);
  for (const verdicts of [processes(), processes({ "1.4.80": "held" })]) {
    const report = await bunCachePruneReport({
      cacheRoot,
      usedRoot,
      now,
      inventory: inventoryOf({ cli: "1.4.80" }),
      processCheck: verdicts,
    });
    expect(report.versions.map((entry) => [entry.version, entry.verdict])).toEqual([
      ["1.4.70", "would_remove"],
      ["1.4.80", "kept"],
      ["1.4.90", "kept"],
    ]);
  }
  expect(await snapshot(runtimes)).toEqual(before);
});

test("macOS asks lsof about each version's program and counts only a terse listing of process IDs; any other answer is a failed check, and a version without a program asks nothing", async () => {
  const { cacheRoot } = await cacheHome("lsof");
  const versions = [];
  for (const version of ["1.4.90", "1.4.91", "1.4.92", "1.4.93", "1.4.94", "1.4.95", "1.4.96"]) {
    versions.push({ version, directory: await cachedVersion(cacheRoot, version) });
  }
  versions.push({ version: "1.4.97", directory: await cachedVersion(cacheRoot, "1.4.97", 10, ["darwin-x64", "darwin-x64-baseline"]) });
  await mkdir(join(cacheRoot, "1.4.98"));
  versions.push({ version: "1.4.98", directory: join(cacheRoot, "1.4.98") });
  const answers = {
    "1.4.90": { code: 0, stdout: "4242\n", stderr: "" },
    "1.4.91": { code: 1, stdout: "", stderr: "" },
    // A warning means the listing may be incomplete.
    "1.4.92": { code: 1, stdout: "", stderr: "lsof: WARNING: can't stat() nfs file system /mnt/x\n      Output information may be incomplete.\n" },
    "1.4.93": { error: "ENOENT", stdout: "", stderr: "" },
    "1.4.94": { code: 0, stdout: "", stderr: "" },
    "1.4.95": { code: 1, stdout: "COMMAND  PID\n", stderr: "" },
    "1.4.96": { error: "timeout", stdout: "4242\n", stderr: "" },
    // Of several programs lsof was asked about, one is open: it exits 1.
    "1.4.97": { code: 1, stdout: "4242\n", stderr: "" },
  };
  const asked = [];
  const check = bunProcessCheck({
    platform: "darwin",
    runLsof: async (args) => {
      asked.push(args);
      return answers[args[2].slice(cacheRoot.length + 1).split("/")[0]];
    },
  });
  expect(await check(versions)).toEqual(new Map([
    ["1.4.90", "held"],
    ["1.4.91", "free"],
    ["1.4.92", "failed"],
    ["1.4.93", "failed"],
    ["1.4.94", "failed"],
    ["1.4.95", "failed"],
    ["1.4.96", "failed"],
    ["1.4.97", "held"],
    ["1.4.98", "free"],
  ]));
  const program = (version, target = "darwin-aarch64") => join(cacheRoot, version, "node_modules", "@oven", `bun-${target}`, "bin", "bun");
  expect(asked).toEqual([
    ...["1.4.90", "1.4.91", "1.4.92", "1.4.93", "1.4.94", "1.4.95", "1.4.96"].map((version) => ["-t", "--", program(version)]),
    ["-t", "--", program("1.4.97", "darwin-x64"), program("1.4.97", "darwin-x64-baseline")],
  ]);
});

permissionTest("a version whose programs cannot be listed is a failed check on macOS", async () => {
  const { cacheRoot } = await cacheHome("lsof-unreadable");
  const directory = await cachedVersion(cacheRoot, "1.4.90");
  const oven = join(directory, "node_modules", "@oven");
  await chmod(oven, 0o000);
  try {
    const check = bunProcessCheck({ platform: "darwin", runLsof: async () => { throw new Error("must not be asked"); } });
    expect(await check([{ version: "1.4.90", directory }])).toEqual(new Map([["1.4.90", "failed"]]));
  } finally {
    await chmod(oven, 0o755);
  }
});

// A process table as Linux's /proc shows it, entry by entry; an Error stands
// for what reading that entry throws.
function fakeProcTable(processesById, { pids = null } = {}) {
  const read = (pid, field) => {
    const value = processesById[pid]?.[field];
    if (value instanceof Error) throw value;
    return value;
  };
  return {
    pids: async () => {
      if (pids instanceof Error) throw pids;
      return Object.keys(processesById);
    },
    owner: async (pid) => read(pid, "owner"),
    exe: async (pid) => read(pid, "exe"),
    maps: async (pid) => read(pid, "maps"),
  };
}

const failure = (code) => Object.assign(new Error(code), { code });

test("Linux reads the process table: a process of this user whose program or a mapped file lies in a version holds it; another user's process is never read, as the cache is this user's own; one that ended meanwhile is skipped and any other error fails the check", async () => {
  const me = 1000;
  const cache = "/home/someone/.local/share/lazurio/runtimes/bun";
  const versions = ["1.4.9", "1.4.90", "1.4.91", "1.4.92"].map((version) => ({ version, directory: `${cache}/${version}` }));
  const map = (path) => `7f00-7f10 r-xp 00000000 08:01 42                          ${path}\n7f10-7f20 rw-p 00000000 00:00 0 [heap]\n`;
  const healthy = {
    1: { owner: 0, exe: "/sbin/init", maps: "" },
    200: { owner: me, exe: `${cache}/1.4.90/node_modules/@oven/bun-linux-x64/bin/bun (deleted)`, maps: "" },
    300: { owner: me, exe: "/usr/bin/node", maps: map(`${cache}/1.4.91/node_modules/@oven/bun-linux-x64/bin/bun`) },
    400: { owner: 1001, exe: failure("EACCES"), maps: failure("EACCES") },
    500: { owner: me, exe: failure("ENOENT"), maps: failure("ESRCH") },
  };
  const check = (table) => bunProcessCheck({ platform: "linux", procTable: table, uid: me })(versions);
  expect(await check(fakeProcTable(healthy))).toEqual(new Map([
    ["1.4.9", "free"],
    ["1.4.90", "held"],
    ["1.4.91", "held"],
    ["1.4.92", "free"],
  ]));
  const failed = new Map(versions.map(({ version }) => [version, "failed"]));
  expect(await check(fakeProcTable(healthy, { pids: failure("EACCES") }))).toEqual(failed);
  expect(await check(fakeProcTable({ ...healthy, 600: { owner: me, exe: failure("EACCES"), maps: "" } }))).toEqual(failed);
  expect(await check(fakeProcTable({ ...healthy, 600: { owner: me, exe: "/usr/bin/sleep", maps: failure("EPERM") } }))).toEqual(failed);
  expect(await check(fakeProcTable({ ...healthy, 600: { owner: failure("EIO") } }))).toEqual(failed);
  // A process gone between the listing and its owner is skipped too.
  expect((await check(fakeProcTable({ ...healthy, 600: { owner: failure("ENOENT") } }))).get("1.4.90")).toBe("held");
});

posixTest("the Linux process table is read from /proc as the kernel lays it out: its numeric entries, their owner, the exe link and the maps", async () => {
  const proc = await freshDirectory("proc");
  const { cacheRoot } = await cacheHome("proc-cache");
  const directory = await cachedVersion(cacheRoot, "1.4.90");
  const program = join(directory, "node_modules", "@oven", "bun-darwin-aarch64", "bin", "bun");
  await mkdir(join(proc, "4242"));
  await symlink(program, join(proc, "4242", "exe"));
  await writeFile(join(proc, "4242", "maps"), `5500-5600 r-xp 00000000 08:01 7 ${program}\n`);
  await mkdir(join(proc, "self"));
  await writeFile(join(proc, "uptime"), "1.0 1.0\n");
  const table = linuxProcTable(proc);
  expect(await table.pids()).toEqual(["4242"]);
  expect(await table.owner("4242")).toBe(process.getuid());
  expect(await table.exe("4242")).toBe(program);
  expect(await table.maps("4242")).toContain(program);
  const other = await cachedVersion(cacheRoot, "1.4.91");
  expect(await bunProcessCheck({ platform: "linux", procTable: table, uid: process.getuid() })([
    { version: "1.4.90", directory },
    { version: "1.4.91", directory: other },
  ])).toEqual(new Map([["1.4.90", "held"], ["1.4.91", "free"]]));
});

test("Windows and every other system have no process check, and each version says so", async () => {
  for (const platform of ["win32", "freebsd"]) {
    const check = bunProcessCheck({
      platform,
      runLsof: async () => { throw new Error("must not be asked"); },
      procTable: fakeProcTable({}, { pids: new Error("must not be read") }),
    });
    expect(await check([{ version: "1.4.90", directory: "C:\\Users\\someone\\AppData\\Local\\Lazurio\\runtimes\\bun\\1.4.90" }]))
      .toEqual(new Map([["1.4.90", "unsupported"]]));
  }
});

// Bun's npm distribution as a fake: each fetched version is a program named
// bun that prints the version for --version.
function fakeDistribution() {
  const fetched = [];
  const install = async (input) => {
    fetched.push(input.version);
    const program = join(input.directory, "node_modules", input.packageName, "bin", "bun");
    await mkdir(dirname(program), { recursive: true });
    await writeFile(program, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo '${input.version}'; exit 0; fi\nexit 0\n`, { mode: 0o755 });
    await chmod(program, 0o755);
    return { kind: "installed" };
  };
  return { install, fetched };
}

const fakeResolver = (home, distribution) => createModuleBunResolver({
  home,
  userBun: process.execPath,
  path: "/usr/bin:/bin",
  system: async () => linuxArm,
  freeBytes: async () => 10 * 1024 ** 3,
  install: distribution.install,
});

posixTest("the tools step of a computer's update fetches ahead what root sees pinned and marks it used, downloads nothing for the user's Bun, and reports an old version nobody pins as one a prune would remove", async () => {
  const world = await pinnedWorld("step", { modules: ["mine"] });
  await writeApp(join(world.workspace, "mine", "app", "v1"), "mine", `bun@${Bun.version}`);
  const home = await freshDirectory("step-home");
  const cacheRoot = moduleBunRoot(home);
  await cachedVersion(cacheRoot, "1.4.70", 5000);
  await usedAt(moduleBunUsed(home), "1.4.70", new Date(Date.now() - 30 * day));
  const npm = fakeDistribution();
  const warnings = [];
  const tools = await updateBunRuntimes({
    rootPath: world.root,
    home,
    resolve: fakeResolver(home, npm),
    processCheck: processes(),
    warnings,
  });
  expect(tools.bun.inventory).toEqual({ complete: true, issues: [] });
  expect(tools.bun.pins).toEqual([
    { version: "1.4.80", cli_pin: true, default: false, apps: 0, state: "fetched" },
    { version: "1.4.81", cli_pin: false, default: true, apps: 0, state: "fetched" },
    { version: Bun.version, cli_pin: false, default: false, apps: 1, state: "user" },
    { version: "1.4.90", cli_pin: false, default: false, apps: 2, state: "fetched" },
    { version: "1.4.91", cli_pin: false, default: false, apps: 1, state: "fetched" },
    { version: "1.4.92", cli_pin: false, default: false, apps: 1, state: "fetched" },
    { version: "1.4.93", cli_pin: false, default: false, apps: 1, state: "fetched" },
  ]);
  expect(npm.fetched).toEqual(["1.4.80", "1.4.81", "1.4.90", "1.4.91", "1.4.92", "1.4.93"]);
  for (const version of npm.fetched) expect((await lstat(join(moduleBunUsed(home), version))).isFile()).toBe(true);
  expect(existsSync(join(moduleBunUsed(home), Bun.version))).toBe(false);
  const recently = expect.stringMatching(/^used_recently: \d{4}-\d{2}-\d{2}T/);
  expect(tools.bun.prune_report).toMatchObject({
    mode: "report_only",
    cache_root: cacheRoot,
    state: "ready",
    versions: [
      { version: "1.4.70", bytes: 5003, verdict: "would_remove", reasons: [] },
      { version: "1.4.80", verdict: "kept", reasons: ["cli_pin", recently] },
      { version: "1.4.81", verdict: "kept", reasons: ["default", recently] },
      { version: "1.4.90", verdict: "kept", reasons: ["pinned_by_apps: 2", recently] },
      { version: "1.4.91", verdict: "kept", reasons: ["pinned_by_apps: 1", recently] },
      { version: "1.4.92", verdict: "kept", reasons: ["pinned_by_apps: 1", recently] },
      { version: "1.4.93", verdict: "kept", reasons: ["pinned_by_apps: 1", recently] },
    ],
    would_free_bytes: 5003,
  });
  expect(warnings).toEqual([]);
  // The old version is still there: the report removes nothing.
  expect((await readdir(cacheRoot)).sort()).toEqual(["1.4.70", "1.4.80", "1.4.81", "1.4.90", "1.4.91", "1.4.92", "1.4.93"]);
});

posixTest("a tools step whose every pin is the user's Bun leaves the whole runtime cache as it was", async () => {
  const world = await lazurioRoot("step-untouched", { cliPin: Bun.version, bunDefault: Bun.version, modules: ["mine"] });
  await writeApp(join(world.workspace, "mine", "app", "v1"), "mine", `bun@${Bun.version}`);
  const home = await freshDirectory("step-untouched-home");
  const cacheRoot = moduleBunRoot(home);
  await cachedVersion(cacheRoot, "1.4.70");
  await cachedVersion(cacheRoot, "1.4.80");
  await usedAt(moduleBunUsed(home), "1.4.80", new Date(Date.now() - day));
  await mkdir(moduleBunLocks(home), { recursive: true });
  await writeFile(join(moduleBunLocks(home), "1.4.80"), "");
  const before = await snapshot(dirname(cacheRoot));
  const npm = fakeDistribution();
  const tools = await updateBunRuntimes({ rootPath: world.root, home, resolve: fakeResolver(home, npm), processCheck: processes() });
  expect(tools.bun.pins).toEqual([{ version: Bun.version, cli_pin: true, default: true, apps: 1, state: "user" }]);
  expect(tools.bun.prune_report.versions.map((entry) => [entry.version, entry.verdict, entry.reasons])).toEqual([
    ["1.4.70", "kept", ["unknown: no_marker_history"]],
    ["1.4.80", "kept", [expect.stringMatching(/^used_recently: /)]],
  ]);
  expect(npm.fetched).toEqual([]);
  expect(await snapshot(dirname(cacheRoot))).toEqual(before);
});

test("the tools step never fails: discovery that throws, a resolver error that is no refusal and a process check that throws still give its section, and a step that breaks inside answers its error", async () => {
  const world = await lazurioRoot("never-fails");
  const home = await freshDirectory("never-fails-home");
  await cachedVersion(moduleBunRoot(home), "1.4.70");
  const warnings = [];
  const tools = await updateBunRuntimes({
    rootPath: world.root,
    home,
    discoverApps: async () => { throw new Error("discovery broke"); },
    resolve: async () => { throw new TypeError("resolver broke"); },
    processCheck: async () => { throw new Error("lsof broke"); },
    warnings,
  });
  expect(tools.bun.inventory).toEqual({ complete: false, issues: ["discovery: discovery broke"] });
  expect(tools.bun.pins.map(({ version, state, detail }) => [version, state, detail])).toEqual([
    ["1.4.80", "failed", "resolver broke"],
    ["1.4.81", "failed", "resolver broke"],
  ]);
  expect(tools.bun.prune_report.versions).toEqual([{
    version: "1.4.70",
    bytes: 1003,
    verdict: "kept",
    reasons: ["unknown: no_marker_history", "unknown: inventory_incomplete", "unknown: process_check_failed"],
  }]);
  const broken = await updateBunRuntimes({
    rootPath: world.root,
    home,
    resolve: async () => ({ executable: "/fake/bun", binDir: null, source: "user" }),
    processCheck: processes(),
    now: () => { throw new Error("the clock broke"); },
    warnings,
  });
  expect(broken).toEqual({ bun: { error: "the clock broke" } });
  expect(warnings.at(-1)).toContain("the clock broke");
});

// The repositories of a root as the update engine's inventory gives them.
function repository(key, kind, organization, module, absolutePath) {
  return {
    key,
    repo_kind: kind,
    organization,
    module,
    repo_path: key,
    absolute_path: absolutePath,
    expected_branch: "main",
    ...(kind === "module" ? { slot_path: `workspace/${module}`, workspace: "workspace" } : {}),
    teams: ["workspace"],
  };
}

async function engineWorld(name) {
  const root = await freshDirectory(name);
  // A package of the root's own, refreshed once its checkout moves.
  await writeFile(join(root, "package.json"), "{\"name\":\"root\",\"private\":true}\n");
  await writeFile(join(root, "bun.lock"), "# fixture\n");
  await mkdir(join(root, "organizations", "alpha", "workspace", "notes"), { recursive: true });
  return {
    root,
    repos: [
      repository("alpha::root", "organization_root", "alpha", "root", join(root, "organizations", "alpha")),
      repository("alpha::notes", "module", "alpha", "notes", join(root, "organizations", "alpha", "workspace", "notes")),
    ],
  };
}

function engineDeps(world, events, overrides = {}) {
  return {
    runId: "tools-step",
    now: () => now,
    acquireLock: async () => ({ release: async () => {} }),
    sshSharing: null,
    buildInventory: async () => ({ repos: world.repos, warnings: [] }),
    updateRepo: async (repo) => {
      events.push(`sync ${repo.key}`);
      const moved = repo.key === "lazurio::root";
      return {
        repo_key: repo.key,
        repo_kind: repo.repo_kind,
        organization: repo.organization,
        module: repo.module,
        path: repo.repo_path,
        state: moved ? "updated" : "current",
        reason: moved ? "checkout_updated" : "already_current",
        message: moved ? "updated" : "current",
        actions: moved ? ["fast_forward"] : [],
      };
    },
    discoverApps: async () => ({ apps: [], invalid_apps: [], failures: [] }),
    refreshPackageDependencies: async () => {
      events.push("packages");
      return { ok: true };
    },
    inspectLocalRepo: async () => ({ ok: true, branch: "main", head: "a".repeat(40), dirtyPaths: [] }),
    runGit: async () => ({ ok: true, stdout: "a".repeat(40), stderr: "" }),
    ...overrides,
  };
}

test("lazurio update runs the tools step after every checkout is synced and before the packages are refreshed, reports its section and warnings, and never fails because of it", async () => {
  const world = await engineWorld("engine-order");
  const events = [];
  const section = { bun: { pins: [{ version: "1.4.90", cli_pin: false, default: false, apps: 1, state: "refused", reason: "runtime-integrity-failed" }] } };
  const report = await runLazurioUpdate({
    rootPath: world.root,
    runtimeRoot: "/runtime",
    tools: async (context) => {
      events.push("tools");
      expect(context.rootPath).toBe(world.root);
      expect(context.now()).toBe(now);
      expect(typeof context.discoverApps).toBe("function");
      context.warnings.push("Bun 1.4.90 neprošel kontrolou.");
      return section;
    },
    deps: engineDeps(world, events),
  });
  expect(events).toEqual(["sync lazurio::root", "sync alpha::root", "sync alpha::notes", "tools", "packages"]);
  expect(report).toMatchObject({ ok: true, state: "updated", tools: section });
  expect(report.warnings).toContain("Bun 1.4.90 neprošel kontrolou.");
});

test("a tools step that throws leaves the update as it was, with its error in the report", async () => {
  const world = await engineWorld("engine-throws");
  const events = [];
  const report = await runLazurioUpdate({
    rootPath: world.root,
    runtimeRoot: "/runtime",
    tools: async () => {
      events.push("tools");
      throw new Error("the tools step broke");
    },
    deps: engineDeps(world, events),
  });
  expect(events).toEqual(["sync lazurio::root", "sync alpha::root", "sync alpha::notes", "tools", "packages"]);
  expect(report).toMatchObject({ ok: true, state: "updated", tools: { error: "the tools step broke" } });
});

test("lazurio update runs no tools step on a Remote Environment, nor while the root itself is blocked, nor when none is given", async () => {
  const world = await engineWorld("engine-skips");
  const calls = [];
  const tools = async () => {
    calls.push("tools");
    return { bun: {} };
  };
  const hosted = await runLazurioUpdate({
    rootPath: world.root,
    runtimeRoot: "/runtime",
    hostedWorkspace: {
      profile: "hosted",
      organization_slug: "alpha",
      team_id: "workspace",
      domain: "alpha.example.test",
      machine: "builder",
    },
    tools,
    deps: engineDeps(world, []),
  });
  expect(hosted.ok).toBe(true);
  expect(hosted.results.some((result) => result.repo_key === "alpha::notes")).toBe(true);
  expect(hosted).not.toHaveProperty("tools");

  const blocked = await runLazurioUpdate({
    rootPath: world.root,
    runtimeRoot: "/runtime",
    tools,
    deps: engineDeps(world, [], {
      updateRepo: async (repo) => ({
        repo_key: repo.key,
        repo_kind: repo.repo_kind,
        organization: repo.organization,
        module: repo.module,
        path: repo.repo_path,
        state: "blocked",
        reason: "main_diverged",
        message: "diverged",
        actions: [],
      }),
    }),
  });
  expect(blocked.state).toBe("blocked");
  expect(blocked).not.toHaveProperty("tools");

  const none = await runLazurioUpdate({ rootPath: world.root, runtimeRoot: "/runtime", deps: engineDeps(world, []) });
  expect(none.ok).toBe(true);
  expect(none).not.toHaveProperty("tools");
  expect(calls).toEqual([]);
});

test("the human lines of the tools section: the Bun fetched ahead, then the cache report, which says that nothing is removed", () => {
  const lines = formatBunRuntimesReport({
    bun: {
      pins: [
        { version: "1.4.2", cli_pin: true, default: true, apps: 3, state: "user" },
        { version: "1.4.80", cli_pin: false, default: false, apps: 1, state: "cached" },
        { version: "1.4.90", cli_pin: false, default: false, apps: 2, state: "fetched" },
        { version: "1.4.91", cli_pin: false, default: false, apps: 1, state: "refused", reason: "runtime-integrity-failed" },
        { version: "1.4.92", cli_pin: false, default: false, apps: 1, state: "refused", reason: "runtime-unavailable" },
        { version: "1.4.93", cli_pin: false, default: false, apps: 1, state: "not_fetched", reason: "offline" },
        { version: "1.4.94", cli_pin: false, default: false, apps: 1, state: "failed", reason: "error", detail: "the user's Bun does not run" },
      ],
      inventory: { complete: false, issues: ["worktrees: organizations/TestCompany/.worktrees: EACCES"] },
      prune_report: {
        mode: "report_only",
        cache_root: "/home/someone/.local/share/lazurio/runtimes/bun",
        state: "ready",
        versions: [
          { version: "1.4.70", bytes: 89 * 1024 ** 2, verdict: "would_remove", reasons: [] },
          { version: "1.4.80", bytes: 88 * 1024 ** 2, verdict: "kept", reasons: ["pinned_by_apps: 1", "used_recently: 2026-10-25T10:00:00.000Z"] },
        ],
        would_free_bytes: 89 * 1024 ** 2,
      },
    },
  });
  expect(lines).toEqual([
    "Bun pro aplikace:",
    "· 1.4.2: váš Bun, nic se nestahuje",
    "· 1.4.80: v mezipaměti Lazuria",
    "✓ 1.4.90: předem staženo do mezipaměti Lazuria",
    "! 1.4.91: nestaženo, stažený Bun neprošel kontrolou (runtime-integrity-failed)",
    "· 1.4.92: nestaženo, registr npm neodpovídá (runtime-unavailable)",
    "· 1.4.93: nestaženo, stáhne se při prvním startu (offline)",
    "! 1.4.94: nestaženo: the user's Bun does not run",
    "! Seznam aplikací není úplný, proto by se nic nesmazalo: worktrees: organizations/TestCompany/.worktrees: EACCES",
    "Mezipaměť Bunu Lazuria, jen přehled (zatím se nic nemaže):",
    "· 1.4.70, 89 MB: smazala by se",
    "· 1.4.80, 88 MB: zůstává (pinned_by_apps: 1, used_recently: 2026-10-25T10:00:00.000Z)",
    "Smazáním by se uvolnilo 89 MB. Aplikace mimo dohled Lazuria, která některou z těchto verzí dlouho nepoužila, by se pak bez připojení k internetu nespustila.",
  ]);
  expect(formatBunRuntimesReport({
    bun: { pins: [], inventory: { complete: true, issues: [] }, prune_report: { state: "absent", versions: [], would_free_bytes: 0 } },
  })).toEqual([
    "Bun pro aplikace: žádná přesná verze",
    "Mezipaměť Bunu Lazuria je prázdná.",
  ]);
  for (const [state, line] of [
    ["linked", "Mezipaměť Bunu Lazuria je odkaz na jinou složku, takže se do přehledu nečte."],
    ["not_a_directory", "Mezipaměť Bunu Lazuria není složka, takže se do přehledu nečte."],
    ["unreadable", "! Mezipaměť Bunu Lazuria nejde přečíst."],
  ]) {
    expect(formatBunRuntimesReport({
      bun: { pins: [], inventory: { complete: true, issues: [] }, prune_report: { state, versions: [], would_free_bytes: 0 } },
    }).at(-1)).toBe(line);
  }
  expect(formatBunRuntimesReport({ bun: { error: "the clock broke" } }))
    .toEqual(["! Bun pro aplikace se nepodařilo připravit: the clock broke"]);
  expect(formatBunRuntimesReport({ error: "the tools step broke" }))
    .toEqual(["! Bun pro aplikace se nepodařilo připravit: the tools step broke"]);
  // Every kept version without a removable one: no line about what removing frees.
  expect(formatBunRuntimesReport({
    bun: {
      pins: [],
      inventory: { complete: true, issues: [] },
      prune_report: { state: "ready", versions: [{ version: "1.4.80", bytes: 900, verdict: "kept", reasons: ["cli_pin"] }], would_free_bytes: 0 },
    },
  }).slice(1)).toEqual([
    "Mezipaměť Bunu Lazuria, jen přehled (zatím se nic nemaže):",
    "· 1.4.80, 900 B: zůstává (cli_pin)",
  ]);
});
