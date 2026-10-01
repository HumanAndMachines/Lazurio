// `lazurio module create <Organization>/<slug>`: writes the plan of
// `planModuleScaffold` (module-scaffold-lib.mjs) into a task checkout of the
// Organization root, adds the slot to its modules.manifest.json, installs the
// App dependencies, makes the initial Module commit and measures the result
// with the Lazurio Module Standard checks (manual/module-create.md). It never
// creates a GitHub repository, pushes or opens a PR; those stay with the
// Principal (and later with the Dashboard, DEV-6634 task 407).

import { existsSync } from "node:fs";
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

import {
  DEFAULT_SCAFFOLD_VERSIONS,
  insertModuleSlotText,
  MODULE_SCAFFOLD_LAYERS,
  MODULE_SCAFFOLD_STACKS,
  ModuleScaffoldError,
  planModuleScaffold,
} from "./module-scaffold-lib.mjs";
import { MODULE_SETUP_EXIT_CODES, readOrganizationPolicies } from "./module-setup-lib.mjs";
import { evaluateModuleStandard } from "./module-standard-lib.mjs";
import { readAllModuleContracts } from "./module-port-lib.mjs";
import { materializeRuntimeFromModule, normalizeModuleManifest } from "./core/module-contract-lib.mjs";
import { normalizeOrganizationPortPool } from "./core/organization-port-policy-lib.mjs";
import { readOrganizationRoot } from "./core/organization-root-reader-lib.mjs";
import { readRequiredBunVersion, resolveExecutableOnPath } from "./core/toolchain-lib.mjs";
import { runGit } from "./runtime/git-lib.mjs";
import { validateAgainstSchema } from "./runtime/json-schema-mini.mjs";
import { acquireModuleRuntimeLock } from "./runtime/module-runtime-lock-lib.mjs";

export const MODULE_CREATE_REPORT_VERSION = "lazurio.module_create.report.v1";
export const DEFAULT_MODULE_TEMPLATES_ROOT = join(import.meta.dirname, "templates", "module");
const INSTALL_TIMEOUT_MS = 10 * 60_000;
const WORKTREE_ACTION = "Založ task worktree root repa Organizace (bun run worktrees:create -- --plan <KOD> --repository organizations/<mount>), spusť příkaz z něj, nebo nejdřív ověř plán přes --dry-run.";
const IGNORED_ORGANIZATION_ENTRIES = new Set([".git", ".worktrees", "node_modules", "archive"]);

class ModuleCreateRefusal extends Error {
  constructor(code, message, action = undefined) {
    super(message);
    this.code = code;
    if (action) this.action = action;
  }
}

/** Reads the template layers (lazurio/templates/module/<layer>/**) for planModuleScaffold. */
export async function loadModuleTemplates(root = DEFAULT_MODULE_TEMPLATES_ROOT) {
  const layers = {};
  for (const layer of MODULE_SCAFFOLD_LAYERS) {
    const directory = join(root, layer);
    const files = [];
    const walk = async (current, prefix) => {
      for (const entry of (await readdir(current, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1))) {
        const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
        if (entry.isDirectory()) await walk(join(current, entry.name), path);
        else if (entry.isFile()) {
          files.push({ path, content: (await readFile(join(current, entry.name), "utf8")).replace(/\r\n/g, "\n") });
        } else {
          throw new ModuleScaffoldError("template_invalid", `${layer}/${path} není běžný soubor.`);
        }
      }
    };
    if (!existsSync(directory)) {
      throw new ModuleScaffoldError("template_invalid", `Šablony nemají vrstvu ${layer} (${directory}).`);
    }
    await walk(directory, "");
    layers[layer] = files;
  }
  return { layers };
}

/**
 * Creates (or, with `dryRun`, only plans) a Module. Returns a
 * `lazurio.module_create.report.v1` report; refusals are reports, not throws.
 */
export async function createModule({
  lazurioRoot,
  selector,
  stack,
  displayName = undefined,
  teams = [],
  port = null,
  dryRun = false,
  cwd = process.cwd(),
  skipInstall = process.env.LAZURIO_SCAFFOLD_SKIP_INSTALL === "1",
  templatesRoot = DEFAULT_MODULE_TEMPLATES_ROOT,
}) {
  const root = resolve(lazurioRoot);
  const report = baseReport({ dryRun, stack });
  let target;
  try {
    const { organizationSlug, slug } = parseSelector(selector);
    report.module.slug = slug;
    target = await resolveOrganizationTarget({ lazurioRoot: root, organizationSlug, cwd });
    report.organization = {
      slug: target.slug,
      root: target.organizationRoot,
      source: target.source,
      branch: target.branch,
    };
    const moduleRoot = join(target.organizationRoot, "workspace", slug);
    report.module_root = moduleRoot;
    const templates = await loadModuleTemplates(templatesRoot);
    const versions = { bun: readRequiredBunVersion(), ...DEFAULT_SCAFFOLD_VERSIONS };
    const input = { stack, slug, display_name: displayName, teams, port, templates, versions };

    let plan = await planFor({ lazurioRoot: root, target, input });
    Object.assign(report, planSummary(plan));
    if (await pathExists(moduleRoot)) {
      throw new ModuleCreateRefusal(
        "directory_exists",
        `${moduleRoot} už existuje; scaffold nepřepisuje existující Modul.`,
        "Zvol jiný slug, nebo existující složku po review odstraň či převeď přes lazurio module setup.",
      );
    }
    if (!dryRun && (target.branch === null || target.branch === target.defaultBranch)) {
      throw new ModuleCreateRefusal(
        "organization_root_on_main",
        `Organization root ${target.organizationRoot} je na ${target.branch ?? "detached HEAD"}; slot Modulu musí vzniknout v task worktree a PR.`,
        WORKTREE_ACTION,
      );
    }
    if (!dryRun && !target.linkedWorktree) {
      throw new ModuleCreateRefusal(
        "organization_root_not_task_worktree",
        `Organization root ${target.organizationRoot} je primární checkout (branch ${target.branch}), ne task worktree; Modul ani slot do něj nezapisuju.`,
        WORKTREE_ACTION,
      );
    }
    if (dryRun) {
      report.status = "actionable";
      report.reason = "scaffold_planned";
      report.next_steps = nextSteps({ plan, target, moduleRoot, dryRun: true });
      return report;
    }

    // Writes: the port pool is shared with `lazurio module setup`, so the
    // lease is re-derived and written under the same Organization lock.
    const lock = await acquireModuleRuntimeLock({
      root: join(root, "launchpad", "runtime", "creator-locks"),
      key: `port-allocation/${target.slug}`,
      instanceId: `module-create-${process.pid}`,
    });
    try {
      target = await resolveOrganizationTarget({ lazurioRoot: root, organizationSlug, cwd });
      plan = await planFor({ lazurioRoot: root, target, input });
      Object.assign(report, planSummary(plan));
      await writeModule({ moduleRoot, plan, target });
    } finally {
      await lock.release();
    }

    const toolchainIssues = await prepareToolchain({ moduleRoot, plan, skipInstall, report });
    const commitIssue = await commitModule({ moduleRoot, plan });
    const evaluation = await measureModule({ lazurioRoot: root, target, moduleRoot, plan });
    report.standard = { checks: evaluation.checks };
    report.issues.push(...toolchainIssues, ...(commitIssue ? [commitIssue] : []), ...evaluation.contractIssues);
    const failing = evaluation.checks.filter((check) => check.status === "fail");
    report.status = report.issues.length === 0 && failing.length === 0 ? "completed" : "action_required";
    report.reason = report.status === "completed"
      ? "module_created_and_verified"
      : failing.length > 0 && report.issues.length === 0 ? "module_standard_nonconformant" : "module_created_with_issues";
    report.next_steps = nextSteps({ plan, target, moduleRoot, dryRun: false, report });
    return report;
  } catch (error) {
    if (!(error instanceof ModuleScaffoldError) && !(error instanceof ModuleCreateRefusal)) throw error;
    report.status = "blocked";
    report.reason = error.code;
    report.issues.push({ code: error.code, message: error.message, ...(error.action ? { action: error.action } : {}) });
    return report;
  }
}

export function moduleCreateExitCode(report) {
  if (report?.status === "completed") return MODULE_SETUP_EXIT_CODES.current_or_completed;
  if (report?.status === "actionable") return MODULE_SETUP_EXIT_CODES.actionable;
  return MODULE_SETUP_EXIT_CODES.action_required;
}

export function renderHumanModuleCreate(report) {
  const title = {
    actionable: "plán připravený, nic nezapsáno (--dry-run)",
    completed: "Modul vytvořený a ověřený",
    action_required: "Modul vytvořený, zbývá zásah",
    blocked: "odmítnuto, nic nezapsáno",
  }[report.status] ?? report.status;
  const lines = [`Lazurio module create · ${report.status} · ${title}`];
  if (report.organization?.slug && report.module?.slug) {
    lines.push(`Modul: ${report.organization.slug}/${report.module.slug} (stack ${report.module.stack})`);
  }
  if (report.module_root) lines.push(`Cesta: ${report.module_root}`);
  if (report.organization?.root) {
    lines.push(`Organization root: ${report.organization.root} (${report.organization.source}, branch ${report.organization.branch ?? "detached"})`);
  }
  if (report.slot) lines.push(`Slot: ${report.slot.path} → modules.manifest.json`);
  if (report.lease) lines.push(`Lease: ${report.lease.id} ${report.lease.host}:${report.lease.port}`);
  else if (report.slot) lines.push("Lease: žádný (Modul bez App, tcp_port_policy none)");
  if (report.tree_hash) lines.push(`Obsah: ${report.files.length} souborů, ${report.tree_hash}`);
  if (report.standard?.checks) {
    const passed = report.standard.checks.filter((check) => check.status === "pass").length;
    lines.push(`Lazurio Module Standard: ${passed}/${report.standard.checks.length} pass`);
    for (const check of report.standard.checks) {
      if (check.status === "pass") continue;
      lines.push(`  ${check.id} ${check.status} · ${check.summary}`);
      for (const detail of check.details.slice(0, 3)) lines.push(`    - ${detail}`);
    }
  }
  for (const warning of report.warnings) lines.push(`Upozornění: ${warning}`);
  for (const issue of report.issues) {
    lines.push(`Problém ${issue.code}: ${issue.message}`);
    if (issue.action) lines.push(`  Další krok: ${issue.action}`);
  }
  if (report.next_steps.length > 0) {
    lines.push("Další kroky:");
    report.next_steps.forEach((step, index) => lines.push(`  ${index + 1}. ${step}`));
  }
  return lines.join("\n");
}

/** `lazurio module create …` after the two command words; returns the exit code. */
export async function runModuleCreateCli(argv, { defaultRoot }) {
  const options = parseModuleCreateArgs(argv);
  if (options.help) {
    console.log(MODULE_CREATE_USAGE);
    return 0;
  }
  const report = await createModule({
    lazurioRoot: options.root ?? defaultRoot(),
    selector: options.selector,
    stack: options.stack,
    displayName: options.name,
    teams: options.teams,
    port: options.port,
    dryRun: options.dryRun,
  });
  console.log(options.json ? JSON.stringify(report, null, 2) : renderHumanModuleCreate(report));
  return moduleCreateExitCode(report);
}

export const MODULE_CREATE_USAGE = [
  "lazurio module create <Organization>/<slug> --stack <stack> [--name <název>] [--teams a,b] [--port N] [--dry-run] [--json] [--root <cesta>]",
  `  stacky: ${MODULE_SCAFFOLD_STACKS.join(", ")}`,
  "  Spouštěj z task worktree root repa Organizace; --dry-run jen vypíše plán (soubory, slot, lease, tree_hash).",
].join("\n");

export function parseModuleCreateArgs(argv) {
  const options = { selector: null, stack: null, name: undefined, teams: [], port: null, dryRun: false, json: false, root: null, help: false };
  const valueFlags = new Map([
    ["--stack", (value) => { options.stack = value; }],
    ["--name", (value) => { options.name = value; }],
    ["--teams", (value) => { options.teams = value.split(",").map((team) => team.trim()).filter(Boolean); }],
    ["--port", (value) => {
      if (!/^\d+$/.test(value)) throw usageError("--port musí být celé číslo.");
      options.port = Number(value);
    }],
    ["--root", (value) => { options.root = resolve(value); }],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--json") options.json = true;
    else if (arg.startsWith("--")) {
      const [name, inline] = arg.includes("=") ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)] : [arg, undefined];
      const assign = valueFlags.get(name);
      if (!assign) throw usageError(`Neznámý argument '${arg}' pro module create.`);
      const value = inline ?? argv[index + 1];
      if (value === undefined || value === "" || (inline === undefined && value.startsWith("-"))) {
        throw usageError(`${name} vyžaduje hodnotu.`);
      }
      if (inline === undefined) index += 1;
      assign(value);
    } else if (options.selector === null) options.selector = arg;
    else throw usageError(`module create přijímá jediný selector <Organization>/<slug>, navíc '${arg}'.`);
  }
  if (!options.help) {
    if (!options.selector) throw usageError("module create vyžaduje <Organization>/<slug>.");
    if (!options.stack) throw usageError(`module create vyžaduje --stack (${MODULE_SCAFFOLD_STACKS.join(", ")}).`);
  }
  return options;
}

function usageError(message) {
  const error = new Error(message);
  error.lazurioExitCode = MODULE_SETUP_EXIT_CODES.usage_or_environment;
  return error;
}

function parseSelector(selector) {
  const match = /^([^/\s]+)\/([^/\s]+)$/.exec(String(selector ?? ""));
  if (!match) {
    throw new ModuleCreateRefusal("invalid_selector", `Selector ${JSON.stringify(selector)} není <Organization>/<slug>.`);
  }
  return { organizationSlug: match[1], slug: match[2] };
}

function baseReport({ dryRun, stack }) {
  return {
    schema_version: MODULE_CREATE_REPORT_VERSION,
    status: null,
    reason: null,
    dry_run: dryRun,
    organization: null,
    module: { slug: null, stack: stack ?? null },
    module_root: null,
    slot: null,
    lease: null,
    tree_hash: null,
    files: [],
    generated_by_install: [],
    warnings: [],
    issues: [],
    standard: null,
    next_steps: [],
  };
}

function planSummary(plan) {
  return {
    slot: plan.slot,
    lease: plan.lease,
    tree_hash: plan.tree_hash,
    files: plan.files.map((file) => ({ path: file.path, bytes: Buffer.byteLength(file.content), ...(file.mode ? { mode: file.mode } : {}) })),
    generated_by_install: plan.generated_by_install,
    warnings: plan.warnings,
  };
}

async function planFor({ lazurioRoot, target, input }) {
  const manifest = JSON.parse(target.modulesManifestText);
  let leases;
  try {
    leases = await readAllModuleContracts(lazurioRoot);
  } catch (error) {
    throw new ModuleCreateRefusal(
      "module_contracts_unreadable",
      `Leasy namountovaných Modulů nejdou přečíst, volný port nelze bezpečně vybrat: ${error.message.split("\n")[0]}`,
      "Oprav nevalidní lazurio.module.json (lazurio doctor ho ukáže) a příkaz zopakuj.",
    );
  }
  // A task checkout may already hold Modules created there but not yet merged.
  if (target.source === "worktree") leases.push(...await worktreeModuleContracts(target.organizationRoot));
  return planModuleScaffold({
    ...input,
    organization: {
      slug: target.slug,
      github_org: target.githubOrg,
      module_port_pool: target.pool,
      teams: target.teams,
      existing_slots: Array.isArray(manifest.module_slots) ? manifest.module_slots : [],
      existing_leases: leases.flatMap((module) => (module.port_leases ?? []).map((lease) => ({
        company: module.company,
        module: module.id,
        port: lease.port,
      }))),
    },
  });
}

async function worktreeModuleContracts(organizationRoot) {
  const modules = [];
  const workspace = join(organizationRoot, "workspace");
  for (const entry of await readdir(workspace, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory()) continue;
    const text = await readFile(join(workspace, entry.name, "lazurio.module.json"), "utf8").catch(() => null);
    if (text === null) continue;
    try {
      modules.push(normalizeModuleManifest({ manifest: JSON.parse(text) }).module);
    } catch {
      // An unreadable neighbour cannot hold a lease the plan would collide with.
    }
  }
  return modules;
}

async function resolveOrganizationTarget({ lazurioRoot, organizationSlug, cwd }) {
  const organizationsRoot = join(lazurioRoot, "organizations");
  if (!existsSync(organizationsRoot)) {
    throw new ModuleCreateRefusal("lazurio_root_invalid", `${lazurioRoot} není Lazurio Root: chybí organizations/.`, "Předej --root <Lazurio root>.");
  }
  const mounts = [];
  for (const entry of await readdir(organizationsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || IGNORED_ORGANIZATION_ENTRIES.has(entry.name)) continue;
    const organizationRoot = join(organizationsRoot, entry.name);
    const resolution = readOrganizationRoot({ organizationRoot });
    if (!["legacy", "transition"].includes(resolution.state) || resolution.resource_count !== 1) continue;
    if (resolution.resource.kind === "template") continue;
    mounts.push({ organizationRoot, slug: resolution.resource.organization?.slug });
  }
  const exact = mounts.filter((mount) => mount.slug === organizationSlug);
  const folded = exact.length > 0 ? exact : mounts.filter((mount) => mount.slug?.toLowerCase() === organizationSlug.toLowerCase());
  if (folded.length !== 1) {
    throw new ModuleCreateRefusal(
      folded.length === 0 ? "organization_not_found" : "organization_ambiguous",
      folded.length === 0
        ? `Organizace ${organizationSlug} není v ${organizationsRoot} namountovaná.`
        : `Organizace ${organizationSlug} je namountovaná vícekrát.`,
      "Použij přesný company.slug namountované Organizace (lazurio context ho ukáže).",
    );
  }
  const primary = folded[0].organizationRoot;
  const primaryCommon = await gitPath(primary, "--git-common-dir");
  if (primaryCommon === null) {
    throw new ModuleCreateRefusal(
      "organization_root_not_git",
      `${primary} není Git checkout root repa Organizace.`,
      "Materializuj Organizaci přes lazurio organization install.",
    );
  }
  let organizationRoot = primary;
  let source = "primary";
  const cwdTop = await gitPath(cwd, "--show-toplevel");
  const cwdCommon = await gitPath(cwd, "--git-common-dir");
  if (cwdTop && cwdCommon && (await samePath(cwdCommon, primaryCommon)) && !(await samePath(cwdTop, primary))) {
    organizationRoot = cwdTop;
    source = "worktree";
  }
  const resolution = readOrganizationRoot({ organizationRoot });
  if (!["legacy", "transition"].includes(resolution.state) || resolution.resource_count !== 1) {
    throw new ModuleCreateRefusal(
      "organization_manifest_not_mutation_safe",
      `Organization manifest v ${organizationRoot} není bezpečný pro zápis (${resolution.state}).`,
      "Oprav Organization manifest (lazurio migrate organization-manifest) a příkaz zopakuj.",
    );
  }
  const resource = resolution.resource;
  const pool = normalizeOrganizationPortPool({ manifest: resource, source: `${organizationRoot}/Organization manifest` });
  if (pool.issues.length > 0) {
    throw new ModuleCreateRefusal("organization_port_pool_invalid", pool.issues.join("; "), "Organization Admin opraví module_port_pool.");
  }
  const manifestPath = join(organizationRoot, resource.manifests?.modules ?? "modules.manifest.json");
  const modulesManifestText = await readFile(manifestPath, "utf8").catch(() => null);
  if (modulesManifestText === null) {
    throw new ModuleCreateRefusal("modules_manifest_missing", `${manifestPath} chybí.`, "Organizace musí mít modules.manifest.json.");
  }
  let modulesManifest;
  try {
    modulesManifest = JSON.parse(modulesManifestText);
  } catch (error) {
    throw new ModuleCreateRefusal("manifest_invalid", `${manifestPath} není platný JSON: ${error.message}`);
  }
  const branchResult = await runGit(["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd: organizationRoot });
  // A linked worktree has its own git dir under the common one; in the
  // primary checkout both are the same directory.
  const [gitDir, commonDir] = await Promise.all([
    gitPath(organizationRoot, "--git-dir"),
    gitPath(organizationRoot, "--git-common-dir"),
  ]);
  return {
    slug: resource.organization.slug,
    organizationRoot,
    primaryRoot: primary,
    source,
    linkedWorktree: gitDir !== null && commonDir !== null && !(await samePath(gitDir, commonDir)),
    branch: branchResult.ok ? branchResult.stdout.trim() : null,
    defaultBranch: resource.root_repository?.default_branch ?? "main",
    githubOrg: resource.organization.forge_binding?.locator ?? modulesManifest.github_org ?? null,
    pool: pool.pool,
    teams: Array.isArray(resource.teams) && resource.teams.length > 0
      ? resource.teams.map((team) => team?.slug).filter((slug) => typeof slug === "string")
      : null,
    manifestPath,
    modulesManifestText,
  };
}

async function writeModule({ moduleRoot, plan, target }) {
  await mkdir(dirname(moduleRoot), { recursive: true });
  try {
    await mkdir(moduleRoot);
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw new ModuleCreateRefusal("directory_exists", `${moduleRoot} už existuje; scaffold nepřepisuje existující Modul.`);
    }
    throw error;
  }
  try {
    for (const file of plan.files) {
      const path = join(moduleRoot, ...file.path.split("/"));
      if (!path.startsWith(`${moduleRoot}${sep}`)) throw new Error(`${file.path} míří mimo Modul`);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, file.content, { encoding: "utf8", flag: "wx", ...(file.mode ? { mode: Number.parseInt(file.mode, 8) } : {}) });
    }
    const current = await readFile(target.manifestPath, "utf8");
    if (current !== target.modulesManifestText) {
      throw new ModuleCreateRefusal("manifest_changed", `${target.manifestPath} se během zápisu změnil.`, "Zkontroluj změnu a příkaz zopakuj.");
    }
    const next = insertModuleSlotText(current, plan.slot);
    const temporary = `${target.manifestPath}.lazurio-module-create-${process.pid}.tmp`;
    await writeFile(temporary, next, { encoding: "utf8", flag: "wx" });
    await rename(temporary, target.manifestPath);
  } catch (error) {
    // Nothing references the directory created in this run yet; leave no half Module behind.
    await rm(moduleRoot, { recursive: true, force: true });
    throw error;
  }
}

async function prepareToolchain({ moduleRoot, plan, skipInstall, report }) {
  const lockPath = plan.generated_by_install[0];
  if (!lockPath) return [];
  const appRoot = join(moduleRoot, ...dirname(lockPath).split("/"));
  if (skipInstall) {
    report.warnings.push(`Instalace přeskočena (LAZURIO_SCAFFOLD_SKIP_INSTALL=1); ${lockPath} nevznikl.`);
    return [];
  }
  const uv = lockPath.endsWith("uv.lock");
  const executable = uv ? resolveExecutableOnPath("uv") : process.execPath;
  if (!executable) {
    report.warnings.push(`uv není v PATH; ${lockPath} nevznikl. Nainstaluj uv ${DEFAULT_SCAFFOLD_VERSIONS.uv} a spusť uv lock v ${appRoot}.`);
    return [];
  }
  const command = uv ? [executable, "lock"] : [executable, "install"];
  const result = await runBounded(command, appRoot);
  if (result.exitCode === 0) return [];
  return [{
    code: uv ? "uv_lock_failed" : "install_failed",
    message: `${command.slice(1).join(" ")} v ${appRoot} skončil ${result.timedOut ? "timeoutem" : `kódem ${result.exitCode}`}: ${tail(result.output)}`,
    action: `Oprav příčinu, spusť ${uv ? "uv lock" : "bun install"} v ${appRoot} a commitni ${lockPath}.`,
  }];
}

async function commitModule({ moduleRoot, plan }) {
  const steps = [
    ["init", "--quiet", "--initial-branch=main"],
    ["add", "--all"],
    ["commit", "--quiet", "-m", `Create ${plan.module} with lazurio module create (${plan.stack})`],
  ];
  for (const args of steps) {
    const result = await runGit(args, { cwd: moduleRoot, timeoutMs: 60_000, env: { GIT_TERMINAL_PROMPT: "0" } });
    if (!result.ok) {
      return {
        code: "module_commit_failed",
        message: `git ${args[0]} v ${moduleRoot} selhal: ${tail(`${result.stderr}${result.stdout}${result.error ?? ""}`)}`,
        action: "Nastav git user.name a user.email a v Modulu spusť git add --all && git commit.",
      };
    }
  }
  return null;
}

async function measureModule({ lazurioRoot, target, moduleRoot, plan }) {
  const manifest = JSON.parse(await readFile(join(moduleRoot, "lazurio.module.json"), "utf8"));
  const packages = new Map();
  const contractIssues = [];
  const modulePath = join(moduleRoot, "lazurio.module.json");
  const normalized = normalizeModuleManifest({ manifest, modulePath });
  for (const issue of normalized.issues) contractIssues.push({ code: "module_manifest_invalid", message: issue });
  const runtimeSchema = JSON.parse(await readFile(join(import.meta.dirname, "schemas", "lazurio-runtime.schema.json"), "utf8"));
  for (const appPath of manifest.apps ?? []) {
    const packagePath = join(moduleRoot, ...appPath.split("/"));
    const packageJson = JSON.parse(await readFile(packagePath, "utf8"));
    packages.set(appPath, packageJson);
    const runtime = packageJson?.lazurio?.runtime;
    const issues = [
      ...validateAgainstSchema(runtime, runtimeSchema, `${appPath}: lazurio.runtime`),
      ...materializeRuntimeFromModule({ runtime, module: normalized.module, packagePath }).issues,
    ];
    for (const issue of issues) contractIssues.push({ code: "runtime_contract_invalid", message: issue });
  }
  const policies = await readOrganizationPolicies(lazurioRoot);
  const organization = { slug: target.slug, module_port_pool: target.pool };
  const organizations = [
    ...policies.organizations.filter((item) => item.slug !== target.slug),
    organization,
  ];
  const modules = await readAllModuleContracts(lazurioRoot).catch(() => null);
  const evaluation = await evaluateModuleStandard({
    moduleRoot,
    slotPath: plan.module_path,
    manifest,
    packages,
    organization,
    organizations,
    modules,
  });
  return { checks: evaluation.checks, contractIssues };
}

function nextSteps({ plan, target, moduleRoot, dryRun, report = null }) {
  const steps = [];
  const selector = `${target.slug}/${plan.module}`;
  if (dryRun) {
    steps.push(`Spusť tentýž příkaz bez --dry-run z task worktree root repa Organizace ${target.slug}.`);
    return steps;
  }
  for (const issue of report?.issues ?? []) if (issue.action) steps.push(issue.action);
  steps.push(
    `V ${target.organizationRoot} commitni modules.manifest.json (slot ${plan.module_path}) a otevři PR do root repa Organizace; merge je rozhodnutí oprávněného Principála.`,
    `Založ privátní GitHub repo ${target.githubOrg}/${plan.module} s chráněnou main (Organization Admin; Dashboard „Nový Modul“ to převezme) a pushni: git -C ${moduleRoot} remote add origin ${plan.slot.git.url} && git -C ${moduleRoot} push -u origin main`,
  );
  if (plan.lease) {
    const canonical = join(target.primaryRoot, "workspace", plan.module);
    steps.push(
      `Před merge rebasuj PR slotu na aktuální main. Po merge slotu a lazurio update spusť lazurio module setup ${canonical}: hlásí-li MS-01 „port ${plan.lease.port} drží i …“ (souběžně založený Modul z jiné branche), přepiš lease v lazurio.module.json Modulu na volný port module_port_pool ${target.pool.start}-${target.pool.end} a commitni to v Modulu; App čte port jen z prostředí, nic dalšího se nemění.`,
    );
  }
  if (plan.stack === "python-uv") {
    steps.push(`Ověř App ručně: v ${join(moduleRoot, "app", "v1")} uv sync --frozen, bun run check, bun run test a uv run --no-sync ${plan.module} s listener proměnnými; start přes Launchpad přijde s adaptérem uv (DEV-6634 W0-5).`);
  } else if (plan.lease) {
    steps.push(`Po merge slotu: lazurio update, potom lazurio module start ${selector} --json a otevři result.runtime.url.`);
  } else {
    steps.push("Po merge slotu: lazurio update; Launchpad Modul ukáže v katalogu bez App.");
  }
  return steps;
}

async function runBounded(command, cwd) {
  const child = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "pipe", env: process.env });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
  }, INSTALL_TIMEOUT_MS);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  clearTimeout(timer);
  return { exitCode, timedOut, output: `${stdout}${stderr}` };
}

async function gitPath(cwd, flag) {
  if (!existsSync(cwd)) return null;
  const args = flag === "--show-toplevel" ? ["rev-parse", flag] : ["rev-parse", "--path-format=absolute", flag];
  const result = await runGit(args, { cwd });
  if (!result.ok) return null;
  const value = result.stdout.trim();
  return value === "" ? null : resolve(cwd, value);
}

async function samePath(left, right) {
  const [a, b] = await Promise.all([realpathOrNull(left), realpathOrNull(right)]);
  return a !== null && a === b;
}

function realpathOrNull(path) {
  return realpath(path).catch(() => null);
}

async function pathExists(path) {
  return lstat(path).then(() => true, () => false);
}

function tail(text) {
  const lines = String(text ?? "").trim().split("\n").filter(Boolean);
  return lines.slice(-5).join(" | ") || "bez výstupu";
}
