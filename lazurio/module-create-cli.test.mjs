import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { setupModule } from "./module-setup-lib.mjs";

const cliPath = join(import.meta.dirname, "cli.mjs");
const roots = [];
let home;

// Deliberately not JSON.stringify(…, 2) shaped: the slot must be inserted
// without reformatting the rest of the Organization manifest.
const modulesManifest = `{
  "organization_generation": "gen3",
  "company": "Acme",
  "github_org": "AcmeHQ",
  "module_slots": [
    {
      "path": "workspace/billing",
      "slug": "billing",
      "required_roles": ["*"],
      "git": { "url": "git@github.com:AcmeHQ/billing.git", "branch": "main" }
    },
    { "path": "infra", "slug": "infra", "space": "root", "required_roles": ["admin"] }
  ]
}
`;

beforeAll(async () => {
  home = await tempRoot("lazurio-module-create-home-");
});

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

test("--dry-run prints the plan and writes nothing, even on main", async () => {
  const fixture = await organizationFixture();
  const run = cli(["module", "create", "Acme/portal", "--stack", "bun-service", "--teams", "web", "--dry-run", "--json"], fixture);
  expect(run.exitCode).toBe(1);
  const report = JSON.parse(run.stdout);
  expect(report).toMatchObject({
    schema_version: "lazurio.module_create.report.v1",
    status: "actionable",
    reason: "scaffold_planned",
    dry_run: true,
    organization: { slug: "Acme", source: "primary", branch: "main" },
    lease: { id: "main", host: "127.0.0.1", port: 24_009 },
    slot: { path: "workspace/portal", teams: ["web"], git: { url: "git@github.com:AcmeHQ/portal.git" } },
    generated_by_install: ["app/v1/bun.lock"],
    standard: null,
  });
  expect(report.tree_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  expect(report.files.map((file) => file.path)).toContain("app/v1/src/server.ts");
  expect(await readFile(join(fixture.organizationRoot, "modules.manifest.json"), "utf8")).toBe(modulesManifest);
  expect(existsSync(join(fixture.organizationRoot, "workspace", "portal"))).toBe(false);
});

test("refuses to write while the Organization root is on main", async () => {
  const fixture = await organizationFixture();
  const run = cli(["module", "create", "Acme/portal", "--stack", "none", "--json"], fixture);
  expect(run.exitCode).toBe(2);
  expect(JSON.parse(run.stdout)).toMatchObject({
    status: "blocked",
    reason: "organization_root_on_main",
    issues: [{ code: "organization_root_on_main" }],
  });
  expect(await readFile(join(fixture.organizationRoot, "modules.manifest.json"), "utf8")).toBe(modulesManifest);
  expect(existsSync(join(fixture.organizationRoot, "workspace", "portal"))).toBe(false);
});

test("refuses to write from a primary checkout switched to a work branch; --dry-run still plans", async () => {
  const fixture = await organizationFixture({ branch: "agent/DEV-1-portal" });
  const run = cli(["module", "create", "Acme/portal", "--stack", "none", "--json"], fixture);
  expect(run.exitCode).toBe(2);
  const report = JSON.parse(run.stdout);
  expect(report).toMatchObject({
    status: "blocked",
    reason: "organization_root_not_task_worktree",
    organization: { source: "primary", branch: "agent/DEV-1-portal" },
    issues: [{ code: "organization_root_not_task_worktree" }],
  });
  expect(report.issues[0].action).toContain("worktrees:create");
  expect(await readFile(join(fixture.organizationRoot, "modules.manifest.json"), "utf8")).toBe(modulesManifest);
  expect(existsSync(join(fixture.organizationRoot, "workspace", "portal"))).toBe(false);
  expect(git(fixture.organizationRoot, ["status", "--porcelain"])).toBe("");

  const dryRun = cli(["module", "create", "Acme/portal", "--stack", "none", "--dry-run", "--json"], fixture);
  expect(dryRun.exitCode).toBe(1);
  expect(JSON.parse(dryRun.stdout)).toMatchObject({ status: "actionable", reason: "scaffold_planned" });
  expect(existsSync(join(fixture.organizationRoot, "workspace", "portal"))).toBe(false);
});

test("creates a no-app Module in an Organization task worktree, current from the first commit", async () => {
  const fixture = await organizationFixture();
  const worktree = join(fixture.organizationRoot, ".worktrees", "root", "DEV-1-new-module");
  git(fixture.organizationRoot, ["worktree", "add", "--quiet", "-b", "agent/DEV-1-new-module", worktree]);

  const run = cli(["module", "create", "Acme/handbook", "--stack", "none", "--name", "Příručka", "--json"], { ...fixture, cwd: worktree });
  expect(run.stderr).toBe("");
  expect(run.exitCode).toBe(0);
  const report = JSON.parse(run.stdout);
  const moduleRoot = join(worktree, "workspace", "handbook");
  expect(report).toMatchObject({
    status: "completed",
    reason: "module_created_and_verified",
    organization: { source: "worktree", branch: "agent/DEV-1-new-module" },
    lease: null,
    issues: [],
  });
  expect(report.module_root.endsWith(join("workspace", "handbook"))).toBe(true);
  expect(report.standard.checks.every((check) => check.status === "pass")).toBe(true);

  // Only the slot is added to the worktree manifest; the primary checkout is untouched.
  const written = await readFile(join(worktree, "modules.manifest.json"), "utf8");
  expect(written.startsWith(modulesManifest.slice(0, modulesManifest.indexOf("\n    { \"path\": \"infra\"")))).toBe(true);
  expect(written).toContain("{ \"path\": \"infra\", \"slug\": \"infra\", \"space\": \"root\", \"required_roles\": [\"admin\"] }");
  expect(JSON.parse(written).module_slots.map((slot) => slot.path)).toEqual(["workspace/billing", "workspace/handbook", "infra"]);
  expect(await readFile(join(fixture.organizationRoot, "modules.manifest.json"), "utf8")).toBe(modulesManifest);

  expect(git(moduleRoot, ["log", "--format=%s"])).toBe("Create handbook with lazurio module create (none)");
  expect(git(moduleRoot, ["status", "--porcelain"])).toBe("");
  expect(git(moduleRoot, ["ls-files"]).split("\n").sort()).toEqual([".gitignore", "AGENTS.md", "README.md", "lazurio.module.json"]);
  expect(report.next_steps.join("\n")).toContain("git@github.com:AcmeHQ/handbook.git");

  const again = cli(["module", "create", "Acme/handbook", "--stack", "none", "--json"], { ...fixture, cwd: worktree });
  expect(again.exitCode).toBe(2);
  expect(JSON.parse(again.stdout).reason).toBe("slot_exists");
});

test("a Bun stack without install reports exactly the missing lockfile", async () => {
  const fixture = await organizationFixture();
  const worktree = join(fixture.organizationRoot, ".worktrees", "root", "DEV-1-portal");
  git(fixture.organizationRoot, ["worktree", "add", "--quiet", "-b", "agent/DEV-1-portal", worktree]);
  const inWorktree = { ...fixture, cwd: worktree };
  const run = cli(["module", "create", "Acme/portal", "--stack", "vite-react", "--json"], inWorktree, {
    LAZURIO_SCAFFOLD_SKIP_INSTALL: "1",
  });
  expect(run.exitCode).toBe(2);
  const report = JSON.parse(run.stdout);
  expect(report).toMatchObject({
    status: "action_required",
    reason: "module_standard_nonconformant",
    organization: { source: "worktree", branch: "agent/DEV-1-portal" },
    lease: { port: 24_009 },
    issues: [],
  });
  expect(report.next_steps.join("\n")).toContain("module_port_conflict, napříč Organizacemi MS-01 „port 24009 drží i …“");
  expect(report.next_steps.join("\n")).toContain("module_port_pool 24000-24099");
  expect(report.warnings).toContain("Instalace přeskočena (LAZURIO_SCAFFOLD_SKIP_INSTALL=1); app/v1/bun.lock nevznikl.");
  const failing = report.standard.checks.filter((check) => check.status !== "pass");
  expect(failing.map((check) => check.id)).toEqual(["MS-02"]);
  expect(failing[0].details).toEqual(["app/v1/package.json: bun.lock chybí vedle package.json (app/v1/bun.lock)"]);

  // Before the slot reaches main, `lazurio module setup` cannot measure the
  // Module in the Organization task worktree (it measures declared slots only)…
  const early = await setupModule({ lazurioRoot: fixture.lazurioRoot, moduleRoot: report.module_root });
  expect(early.reason).toBe("module_root_not_linked_to_slot");
  // …so the next steps send it to the canonical path after merge and lazurio update.
  const canonical = join(fixture.organizationRoot, "workspace", "portal");
  expect(report.next_steps.join("\n")).toContain(`lazurio module setup ${canonical}`);
  git(worktree, ["commit", "--quiet", "-am", "Add portal slot"]);
  git(fixture.organizationRoot, ["merge", "--quiet", "--ff-only", "agent/DEV-1-portal"]);
  await rename(report.module_root, canonical);
  const setup = await setupModule({ lazurioRoot: fixture.lazurioRoot, moduleRoot: canonical });
  expect(setup.standard.checks.filter((check) => check.status !== "pass").map((check) => check.id)).toEqual(["MS-02"]);

  const human = cli(["module", "create", "Acme/portal", "--stack", "vite-react"], inWorktree);
  expect(human.exitCode).toBe(2);
  expect(human.stdout).toContain("Lazurio module create · blocked");
  expect(human.stdout).toContain("Problém slot_exists");

  await mkdir(join(worktree, "workspace", "stray"), { recursive: true });
  const stray = cli(["module", "create", "Acme/stray", "--stack", "none", "--json"], inWorktree);
  expect(stray.exitCode).toBe(2);
  expect(JSON.parse(stray.stdout)).toMatchObject({ status: "blocked", reason: "directory_exists" });
});

test("two Modules created in distinct task worktrees get different default ports", async () => {
  // Neither worktree sees the other's unmerged Module; the slug-derived start
  // keeps them apart (portal 24009, crm 24003; billing holds 24000).
  const fixture = await organizationFixture();
  const ports = {};
  for (const slug of ["portal", "crm"]) {
    const worktree = join(fixture.organizationRoot, ".worktrees", "root", `DEV-1-${slug}`);
    git(fixture.organizationRoot, ["worktree", "add", "--quiet", "-b", `agent/DEV-1-${slug}`, worktree]);
    const run = cli(["module", "create", `Acme/${slug}`, "--stack", "bun-service", "--json"], { ...fixture, cwd: worktree }, {
      LAZURIO_SCAFFOLD_SKIP_INSTALL: "1",
    });
    const report = JSON.parse(run.stdout);
    expect(report.organization.source).toBe("worktree");
    expect(JSON.parse(await readFile(join(worktree, "workspace", slug, "lazurio.module.json"), "utf8")).port_leases[0].port)
      .toBe(report.lease.port);
    ports[slug] = report.lease.port;
  }
  expect(ports).toEqual({ portal: 24_009, crm: 24_003 });
});

test("usage errors exit 3", async () => {
  const fixture = await organizationFixture();
  const missingStack = cli(["module", "create", "Acme/portal"], fixture);
  expect(missingStack.exitCode).toBe(3);
  expect(missingStack.stderr).toContain("--stack");
  const unknownStack = cli(["module", "create", "Acme/portal", "--stack", "rails", "--json"], fixture);
  expect(unknownStack.exitCode).toBe(2);
  expect(JSON.parse(unknownStack.stdout).reason).toBe("unknown_stack");
  const unknownOrganization = cli(["module", "create", "Nobody/portal", "--stack", "none", "--dry-run", "--json"], fixture);
  expect(JSON.parse(unknownOrganization.stdout).reason).toBe("organization_not_found");
});

function cli(args, { lazurioRoot, organizationRoot, cwd = organizationRoot }, env = {}) {
  const inherited = { ...process.env };
  for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "LAZURIO_SCAFFOLD_SKIP_INSTALL"]) delete inherited[name];
  const result = Bun.spawnSync([process.execPath, "run", cliPath, ...args, "--root", lazurioRoot], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    // The full environment stays (Windows needs SystemRoot and friends to
    // resolve the lock owner's process identity); home and Git identity are
    // redirected to the test.
    env: {
      ...inherited,
      HOME: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      XDG_STATE_HOME: join(home, ".local", "state"),
      XDG_CACHE_HOME: join(home, ".cache"),
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "Lazurio Test",
      GIT_AUTHOR_EMAIL: "lazurio-test@example.invalid",
      GIT_COMMITTER_NAME: "Lazurio Test",
      GIT_COMMITTER_EMAIL: "lazurio-test@example.invalid",
      ...env,
    },
  });
  return { exitCode: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

async function organizationFixture({ branch = null } = {}) {
  const lazurioRoot = await tempRoot("lazurio-module-create-");
  const organizationRoot = join(lazurioRoot, "organizations", "Acme_GEN3");
  await writeText(join(organizationRoot, "company.gen3.json"), `${JSON.stringify({
    organization_generation: "gen3",
    company: { slug: "Acme", display_name: "Acme", github_org: "AcmeHQ" },
    module_port_pool: { start: 24_000, end: 24_099 },
    teams: [{ slug: "core", display_name: "Core", default: true }, { slug: "web", display_name: "Web" }],
  }, null, 2)}\n`);
  await writeText(join(organizationRoot, "modules.manifest.json"), modulesManifest);
  await writeText(join(organizationRoot, ".gitignore"), "/workspace/*/\n/.worktrees/\n");
  await writeText(join(organizationRoot, "workspace", "billing", "lazurio.module.json"), `${JSON.stringify({
    schema_version: "lazurio.module.v1",
    id: "billing",
    company: "Acme",
    tcp_port_policy: { mode: "single" },
    port_leases: [{ id: "main", host: "127.0.0.1", port: 24_000 }],
  }, null, 2)}\n`);
  git(organizationRoot, ["init", "--quiet", "--initial-branch=main"]);
  git(organizationRoot, ["add", "--all"]);
  git(organizationRoot, ["commit", "--quiet", "-m", "Organization"]);
  if (branch) git(organizationRoot, ["switch", "--quiet", "-c", branch]);
  return { lazurioRoot, organizationRoot };
}

function git(cwd, args) {
  const result = Bun.spawnSync(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      HOME: home,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "Lazurio Test",
      GIT_AUTHOR_EMAIL: "lazurio-test@example.invalid",
      GIT_COMMITTER_NAME: "Lazurio Test",
      GIT_COMMITTER_EMAIL: "lazurio-test@example.invalid",
    },
  });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}

async function tempRoot(prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

async function writeText(path, text) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text, "utf8");
}
