#!/usr/bin/env bun

import { existsSync } from "fs";
import { link, lstat, readFile, readdir, realpath, rename, rm, writeFile } from "fs/promises";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { basename, dirname, isAbsolute, join, relative, resolve, sep, win32 } from "path";
import { fileURLToPath } from "node:url";
import { acquireModuleRuntimeLock } from "../launchpad/src/module-runtime-lock-lib.mjs";
import { GIT_LOCAL_TIMEOUT_MS, runGit } from "../launchpad/src/git-lib.mjs";
import {
  materializeRuntimeFromModule,
  normalizeModuleManifest,
} from "./core/module-contract-lib.mjs";
import {
  nextFreeModulePort,
  normalizeOrganizationPortPool,
  validateModuleLeasesAgainstOrganizationPools,
} from "./core/organization-port-policy-lib.mjs";
import { validateDeclaredRuntime } from "./core/runtime-contract-lib.mjs";
import { organizationSlotRepositoryId } from "./core/organization-slot-scope-lib.mjs";
import { readAllModuleContracts } from "./module-port-lib.mjs";

const ignoredDirectories = new Set([
  ".git",
  ".worktrees",
  "archive",
  "build",
  ".build",
  "coverage",
  "data",
  "dist",
  "exports",
  "generated",
  "history",
  "node_modules",
  "personalspace",
  "snapshots",
  "test",
  "tests",
  "fixture",
  "fixtures",
  "__tests__",
  "test-data",
  "testdata",
]);

const PINNED_JSON_PUBLISH_MODE = "__lazurio_pinned_json_publish_v1";

export function migrateLegacyRuntimePackage(packageJson, {
  packagePath = "package.json",
  organization = undefined,
  moduleRoot = undefined,
} = {}) {
  if (packageJson?.lazurio?.runtime && packageJson?.companyascode?.app) {
    return blocked(packageJson, `${packagePath}: package deklaruje nový i legacy runtime`);
  }
  if (packageJson?.lazurio?.runtime) {
    return migrateInlineRuntimePackage(packageJson, { packagePath, organization, moduleRoot });
  }
  const legacy = packageJson?.companyascode?.app;
  if (!legacy) return unchanged(packageJson);

  const scripts = packageJson.scripts ?? {};
  if (typeof scripts[legacy.dev_script] !== "string" || !scripts[legacy.dev_script].trim()) {
    return blocked(packageJson, `${packagePath}: legacy dev_script ${String(legacy.dev_script)} neexistuje nebo je prázdný`);
  }
  const devCommands = selectedScriptCommands(scripts, legacy.dev_script);
  const observedPorts = [...new Set(devCommands.flatMap(commandPorts))];
  if (observedPorts.length === 1 && observedPorts[0] !== legacy.port) {
    return blocked(
      packageJson,
      `${packagePath}: dev runtime používá port ${observedPorts[0]}, ale legacy manifest deklaruje ${String(legacy.port)}; migrace vyžaduje ruční sjednocení`,
    );
  }
  const usesSplitRuntime = observedPorts.length > 1
    || devCommands.some((command) =>
      /\b(?:concurrently|npm-run-all|run-p)\b/.test(command)
      || /(?:^|\s)&(?:\s|$)|(^|[^|])\|([^|]|$)|(?:^|\s);(?:\s|$)/.test(command)
    );
  if (usesSplitRuntime) {
    return blocked(
      packageJson,
      `${packagePath}: víceprocesový runtime${observedPorts.length > 0 ? ` (${observedPorts.join("/")})` : ""} vyžaduje ruční migraci všech listenerů a zapojení LAZURIO_RUNTIME_LISTENER_<ID>_PORT do každého serveru/proxy`,
    );
  }

  const {
    schema_version: _legacySchemaVersion,
    port,
    host,
    health_path: healthPath,
    ...metadata
  } = legacy;
  const next = structuredClone(packageJson);
  next.lazurio = {
    ...(next.lazurio ?? {}),
    runtime: {
      schema_version: "lazurio.runtime.v1",
      ...metadata,
      listeners: [{
        id: "app",
        role: "entrypoint",
        lease: "main",
        protocol: "http",
        health: { kind: "http", path: healthPath },
      }],
    },
  };
  const remainingLegacy = { ...(next.companyascode ?? {}) };
  delete remainingLegacy.app;
  if (Object.keys(remainingLegacy).length === 0) delete next.companyascode;
  else next.companyascode = remainingLegacy;
  return validateMigration({
    packageJson: next,
    original: packageJson,
    packagePath,
    moduleManifest: singleModuleManifest({
      company: legacy.company,
      module: legacy.module,
      host,
      port,
      packagePath,
      moduleRoot,
    }),
    organization,
    moduleRoot,
  });
}

export function migrateInlineRuntimePackage(packageJson, {
  packagePath = "package.json",
  organization = undefined,
  moduleRoot = undefined,
} = {}) {
  const runtime = packageJson?.lazurio?.runtime;
  if (!runtime) return unchanged(packageJson);
  const listeners = Array.isArray(runtime.listeners) ? runtime.listeners : [];
  if (listeners.length === 0) return blocked(packageJson, `${packagePath}: lazurio.runtime.listeners je prázdné`);
  const alreadyReferencesLeases = listeners.every((listener) =>
    typeof listener?.lease === "string"
    && listener.allocation === undefined
    && listener.host === undefined
    && listener.port === undefined
    && listener.claim === undefined
  );
  if (alreadyReferencesLeases) return unchanged(packageJson);

  const issues = [];
  const seenPorts = new Set();
  const inlineLeases = listeners.map((listener, index) => {
    const label = `${packagePath}: lazurio.runtime.listeners[${index}]`;
    if (listener?.allocation !== "static") issues.push(`${label}.allocation musí být static pro bezpečnou migraci`);
    if (!["127.0.0.1", "localhost", "::1"].includes(listener?.host)) issues.push(`${label}.host musí být loopback`);
    if (!Number.isInteger(listener?.port) || listener.port < 1024 || listener.port > 65_535) {
      issues.push(`${label}.port musí být číslo 1024-65535`);
    } else if (seenPorts.has(listener.port)) {
      issues.push(`${label}.port ${listener.port} je duplicitní`);
    } else {
      seenPorts.add(listener.port);
    }
    return {
      id: listeners.length === 1 ? "main" : listener.id,
      host: listener.host === "localhost" ? "127.0.0.1" : listener.host,
      port: listener.port,
    };
  });
  if (issues.length > 0) return { changed: false, packageJson, moduleManifest: null, issues };

  const next = structuredClone(packageJson);
  next.lazurio.runtime.listeners = listeners.map((listener, index) => ({
    id: listener.id,
    role: listener.role,
    lease: inlineLeases[index].id,
    protocol: listener.protocol,
    health: listener.health,
  }));
  const moduleManifest = {
    schema_version: "lazurio.module.v1",
    id: runtime.module,
    company: runtime.company,
    tcp_port_policy: listeners.length === 1
      ? { mode: "single" }
      : {
          mode: "exception",
          reason: "Existing split TCP runtime retained during migration; consolidate behind one listener or local IPC in a follow-up.",
        },
    port_leases: inlineLeases,
    apps: [appPackagePathForModule(packagePath, runtime.module, moduleRoot)],
    default_app: appPackagePathForModule(packagePath, runtime.module, moduleRoot),
  };
  return validateMigration({
    packageJson: next,
    original: packageJson,
    packagePath,
    moduleManifest,
    organization,
    moduleRoot,
  });
}

function validateMigration({
  packageJson,
  original,
  packagePath,
  moduleManifest,
  organization = undefined,
  moduleRoot = undefined,
}) {
  const runtimeIssues = validateDeclaredRuntime({ runtime: packageJson.lazurio.runtime, packageJson, packagePath });
  const normalizedModule = normalizeModuleManifest({
    manifest: moduleManifest,
    modulePath: `${moduleRoot ?? moduleRootForPackage(packagePath, moduleManifest.id)}/lazurio.module.json`,
  });
  const policyIssues = [];
  if (normalizedModule.module && organization === null) {
    policyIssues.push(`${normalizedModule.module.module_path}: owning Organization nemá čitelnou port policy`);
  } else if (normalizedModule.module && organization) {
    if (organization.slug !== normalizedModule.module.company) {
      policyIssues.push(
        `${normalizedModule.module.module_path}: company ${normalizedModule.module.company} `
        + `neodpovídá owning Organizaci ${organization.slug}`,
      );
    } else {
      policyIssues.push(...validateModuleLeasesAgainstOrganizationPools({
        modules: [normalizedModule.module],
        organizations: [organization],
      }));
    }
  }
  const issues = [...runtimeIssues, ...normalizedModule.issues, ...policyIssues];
  if (issues.length > 0) {
    return {
      changed: false,
      packageJson: original,
      moduleManifest: null,
      issues: issues.map((issue) => `${packagePath}: migrace zablokována, ${issue}`),
    };
  }
  return { changed: true, packageJson, moduleManifest, issues: [] };
}

function singleModuleManifest({ company, module, host, port, packagePath, moduleRoot = undefined }) {
  const appPackage = appPackagePathForModule(packagePath, module, moduleRoot);
  return {
    schema_version: "lazurio.module.v1",
    id: module,
    company,
    tcp_port_policy: { mode: "single" },
    port_leases: [{ id: "main", host: host === "localhost" ? "127.0.0.1" : host, port }],
    apps: [appPackage],
    default_app: appPackage,
  };
}

function appPackagePathForModule(packagePath, moduleId, moduleRoot = undefined) {
  return relative(moduleRoot ?? moduleRootForPackage(packagePath, moduleId), resolve(packagePath)).split(sep).join("/");
}

function unchanged(packageJson) {
  return { changed: false, packageJson, moduleManifest: null, issues: [] };
}

function blocked(packageJson, issue) {
  return { changed: false, packageJson, moduleManifest: null, issues: [issue] };
}

function selectedScriptCommands(scripts, entrypoint) {
  const commands = [];
  const visited = new Set();
  const visit = (name) => {
    if (visited.has(name) || typeof scripts?.[name] !== "string") return;
    visited.add(name);
    const command = scripts[name];
    commands.push(command);
    for (const match of command.matchAll(/\b(?:bun|npm|pnpm|yarn)\s+run\s+([A-Za-z0-9:_-]+)\b/g)) visit(match[1]);
  };
  visit(entrypoint);
  return commands;
}

function commandPorts(command) {
  const source = String(command ?? "");
  return [
    ...source.matchAll(/--port(?:=|\s+)(\d{4,5})\b/g),
    ...source.matchAll(/(?:^|\s)-p\s+(\d{4,5})\b/g),
    ...source.matchAll(/(?:^|\s)(?:PORT|[A-Za-z][A-Za-z0-9_]*_PORT)\s*=\s*(\d{4,5})\b/g),
  ].map((match) => Number(match[1]));
}

export async function packagePathsBelow(root) {
  const output = [];
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
      if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && entry.name === "package.json") output.push(path);
    }
  }
  await walk(root);
  return output.sort();
}

export function moduleRootForPackage(packagePath, moduleId = null) {
  const absolute = resolve(packagePath);
  const packageDirectory = dirname(absolute);
  const parts = absolute.split(sep);
  const organizationsIndex = parts.findLastIndex((part, index) =>
    part === "organizations"
    && ["workspace", "modules"].includes(parts[index + 2])
    && index + 3 < parts.length - 1
  );
  if (organizationsIndex >= 0) {
    const moduleRoot = parts.slice(0, organizationsIndex + 4).join(sep) || sep;
    return moduleRoot;
  }
  // A module may itself be named `app`. In that case a root package belongs
  // beside its lazurio.module.json and must not be mistaken for <module>/app.
  // A standalone double `app/app/package.json` keeps the outer matching root;
  // canonical Organization paths above are authoritative when available.
  if (moduleId && basename(packageDirectory) === moduleId) {
    const parent = dirname(packageDirectory);
    return moduleId === "app" && basename(parent) === moduleId ? parent : packageDirectory;
  }
  const appIndex = parts.findLastIndex((part, index) =>
    part === "app"
    && (index === parts.length - 2 || /^v\d+$/.test(parts[index + 1] ?? ""))
  );
  if (appIndex > 0) {
    const candidate = parts.slice(0, appIndex).join(sep) || sep;
    return candidate;
  }
  return packageDirectory;
}

function sameJson(left, right) {
  return stableJson(left) === stableJson(right);
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function rewriteRuntimeScriptsFromModule(packageJson, moduleManifest) {
  const runtime = packageJson?.lazurio?.runtime;
  if (!runtime || !moduleManifest || !packageJson?.scripts) return { changed: false, packageJson };
  const leases = new Map((moduleManifest.port_leases ?? []).map((lease) => [lease.id, lease]));
  const replacements = [];
  for (const listener of runtime.listeners ?? []) {
    const lease = leases.get(listener.lease);
    if (!Number.isInteger(lease?.port) || typeof lease.host !== "string") continue;
    const portEnv = listener.role === "entrypoint"
      ? "$PORT"
      : `$LAZURIO_RUNTIME_LISTENER_${String(listener.id).toUpperCase().replace(/[^A-Z0-9]/g, "_")}_PORT`;
    const hostEnv = listener.role === "entrypoint"
      ? "$HOST"
      : `$LAZURIO_RUNTIME_LISTENER_${String(listener.id).toUpperCase().replace(/[^A-Z0-9]/g, "_")}_HOST`;
    replacements.push({ port: lease.port, host: lease.host, portEnv, hostEnv });
  }
  const next = structuredClone(packageJson);
  let changed = false;
  for (const [name, command] of Object.entries(next.scripts)) {
    if (typeof command !== "string") continue;
    let rewritten = command;
    for (const { port, host, portEnv, hostEnv } of replacements) {
      rewritten = rewritten.replace(
        new RegExp(`(--port(?:=|\\s+))(?:\")?${port}(?:\")?`, "g"),
        `$1\"${portEnv}\"`,
      );
      rewritten = rewritten.replace(
        new RegExp(`((?:^|\\s)(?:PORT|[A-Za-z][A-Za-z0-9_]*_PORT)=)(?:\")?${port}(?:\")?`, "g"),
        `$1\"${portEnv}\"`,
      );
      const escapedHost = host.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      rewritten = rewritten.replace(
        new RegExp(`(--host(?:=|\\s+))(?:\")?${escapedHost}(?:\")?`, "g"),
        `$1\"${hostEnv}\"`,
      );
      rewritten = rewritten.replace(
        new RegExp(`((?:^|\\s)(?:HOST|[A-Za-z][A-Za-z0-9_]*_HOST)=)(?:\")?${escapedHost}(?:\")?`, "g"),
        `$1\"${hostEnv}\"`,
      );
    }
    const requiredVariables = [...new Set(
      replacements
        .flatMap(({ portEnv, hostEnv }) => [portEnv, hostEnv])
        .map((variable) => variable.slice(1))
        .filter((variable) => rewritten.includes(`$${variable}`)),
    )];
    if (
      rewritten !== command
      && requiredVariables.length > 0
      && !requiredVariables.every((variable) => rewritten.includes(`process.env.${variable}`))
    ) {
      const injected = requiredVariables.map((variable) => `process.env.${variable}`).join(" && ");
      rewritten = `bun -e \"process.exit(${injected} ? 0 : 1)\" && ${rewritten}`;
    }
    if (rewritten !== command) {
      next.scripts[name] = rewritten;
      changed = true;
    }
  }
  return { changed, packageJson: next };
}

export const MODULE_SETUP_EXIT_CODES = Object.freeze({
  current_or_completed: 0,
  actionable: 1,
  action_required: 2,
  usage_or_environment: 3,
});

export async function setupModule({
  lazurioRoot,
  moduleRoot,
  apply = false,
  noApp = false,
  appPackage = null,
  appId = null,
  title = null,
  devScript = null,
  healthPath = "/health",
  surface = "internal",
  tags = [],
  adoptPort = null,
  failAfterWrite = null,
  beforePublish = null,
} = {}) {
  const options = {
    lazurioRoot: resolve(lazurioRoot),
    moduleRoot: resolve(moduleRoot),
    noApp,
    appPackage,
    appId,
    title,
    devScript,
    healthPath,
    surface,
    tags,
    adoptPort,
  };
  let plan;
  try {
    plan = await buildModuleSetupPlan(options);
  } catch (error) {
    if (!(error instanceof ModuleSetupActionRequired)) throw error;
    return blockedModuleSetupReport(options, error);
  }
  if (!apply || plan.report.status !== "actionable") return plan.report;

  const lock = await acquireModuleRuntimeLock({
    root: join(options.lazurioRoot, "launchpad", "runtime", "creator-locks"),
    // Module setup and the existing standalone allocator mutate the same
    // Organization-owned port pool. One shared key prevents both writers from
    // choosing the same free lease concurrently.
    key: `port-allocation/${plan.context.company}`,
    instanceId: `module-setup-${process.pid}`,
  });
  try {
    // The read-only plan is intentionally advisory. Re-derive it under the
    // existing Organization-scoped creator lock immediately before writing.
    plan = await buildModuleSetupPlan(options);
    if (plan.report.status !== "actionable") return plan.report;
    let completedWrites = 0;
    for (const write of plan.writes) {
      const containmentRoot = write.containmentRoot ?? options.moduleRoot;
      const expectedParentRealPath = write.action === "create"
        ? await assertModuleWriteParent({
          moduleRoot: containmentRoot,
          path: write.path,
          context: plan.context,
        })
        : await assertRegularModuleFile({
          moduleRoot: containmentRoot,
          path: write.path,
          displayPath: relative(containmentRoot, write.path).split(sep).join("/"),
          context: plan.context,
          missingAction: "Filesystem App se po plánu změnil; spusť setup znovu až po jeho kontrole.",
        });
      await beforePublish?.({ action: write.action, path: write.path });
      publishJsonFileAtomically({
        action: write.action,
        path: write.path,
        displayPath: relative(containmentRoot, write.path).split(sep).join("/"),
        value: write.value,
        expectedText: write.expectedText,
        expectedParentRealPath,
        context: plan.context,
      });
      completedWrites += 1;
      if (failAfterWrite === completedWrites) {
        throw new Error(`Injected module setup failure after write ${completedWrites}`);
      }
    }
    const verified = await buildModuleSetupPlan(options);
    if (verified.report.status !== "current") {
      throw new Error(
        `Module setup apply se po zápisu neověřil jako current (${verified.report.status})`,
      );
    }
    return {
      ...verified.report,
      status: "completed",
      reason: "setup_applied_and_reverified",
      changes: plan.report.changes,
      operator_assertions: plan.report.operator_assertions,
    };
  } catch (error) {
    if (error instanceof ModuleSetupActionRequired) return blockedModuleSetupReport(options, error);
    throw error;
  } finally {
    await lock.release();
  }
}

export function moduleSetupExitCode(report) {
  if (["current", "completed"].includes(report?.status)) return MODULE_SETUP_EXIT_CODES.current_or_completed;
  if (report?.status === "actionable") return MODULE_SETUP_EXIT_CODES.actionable;
  return MODULE_SETUP_EXIT_CODES.action_required;
}

export function renderHumanModuleSetup(report) {
  const lines = [
    `Lazurio Module setup · ${report.status}`,
    `Modul: ${report.module.company}/${report.module.id}`,
    `Cesta: ${report.module.root}`,
  ];
  if (report.status === "current") lines.push("Kontrakt je platný a není co měnit.");
  if (report.status === "completed") lines.push("Změny byly zapsány a celý Module kontrakt byl znovu ověřen.");
  if (report.status === "actionable") {
    lines.push("Připravené změny:");
    for (const change of report.changes) lines.push(`  - ${change.action}: ${change.path}`);
    lines.push("Pro zápis spusť tentýž příkaz s --apply a potom zkontroluj Git diff.");
  }
  if (report.status === "action_required") {
    lines.push("Je potřeba zásah Agenta nebo vlastníka Organizace:");
    for (const issue of report.issues) {
      lines.push(`  - ${issue.message}`);
      if (issue.action) lines.push(`    Další krok: ${issue.action}`);
    }
  }
  if (report.operator_assertions.length > 0) {
    lines.push("Tvrzení operátora k review:");
    for (const assertion of report.operator_assertions) lines.push(`  - ${assertion}`);
  }
  return lines.join("\n");
}

async function buildModuleSetupPlan(options) {
  const context = await resolveModuleSetupContext(options);
  const manifestPath = join(options.moduleRoot, "lazurio.module.json");
  const manifestEntry = await pathEntry(manifestPath);
  let writes = [];
  let operatorAssertions = [];

  if (manifestEntry) {
    if (!manifestEntry.isFile() || manifestEntry.isSymbolicLink()) {
      throw actionRequired(
        "module_manifest_not_regular_file",
        `${relativeForReport(options.lazurioRoot, manifestPath)} není běžný soubor`,
        "Odstraň cizí filesystem entry až po vědomém review; setup ji nepřepisuje.",
        context,
      );
    }
    const manifestText = await readFile(manifestPath, "utf8");
    const manifest = parseJsonForSetup(manifestText, manifestPath, context);
    const normalized = normalizeModuleManifest({ manifest, modulePath: manifestPath });
    const identityIssues = [
      ...normalized.issues,
      ...(manifest.id === context.module ? [] : [`id ${String(manifest.id)} neodpovídá slotu ${context.module}`]),
      ...(manifest.company === context.company ? [] : [`company ${String(manifest.company)} neodpovídá Organizaci ${context.company}`]),
    ];
    if (identityIssues.length > 0) {
      throw actionRequired(
        "module_manifest_invalid",
        identityIssues.join("; "),
        "Oprav lazurio.module.json podle Core validátoru; setup neuhodne zamýšlenou identitu ani port.",
        context,
      );
    }
    const policyIssues = await modulePolicyIssues(options.lazurioRoot, context, normalized.module);
    if (policyIssues.length > 0) {
      throw actionRequired(
        "module_port_policy_invalid",
        policyIssues.join("; "),
        "Odstraň duplicitní lease nebo aktivuj Organization module_port_pool; stabilní port neměň.",
        context,
      );
    }
    ({ writes, operatorAssertions } = await planExistingModule({
      options,
      context,
      manifest,
      manifestText,
      manifestPath,
      normalizedModule: normalized.module,
    }));
  } else {
    ({ writes, operatorAssertions } = await planNewModule({ options, context, manifestPath }));
  }

  return {
    context,
    writes,
    report: moduleSetupReport({
      options,
      context,
      status: writes.length === 0 ? "current" : "actionable",
      reason: writes.length === 0 ? "module_contract_current" : "setup_changes_ready",
      writes,
      operatorAssertions,
    }),
  };
}

async function planExistingModule({
  options,
  context,
  manifest,
  manifestText,
  manifestPath,
  normalizedModule,
}) {
  if (options.noApp && (!Array.isArray(manifest.apps) || manifest.apps.length !== 0)) {
    throw actionRequired(
      "no_app_conflicts_with_manifest",
      "--no-app vyžaduje v existujícím manifestu explicitní apps: []",
      "Spusť setup bez --no-app nebo vědomě potvrď bezaplikační kontrakt v samostatném review.",
      context,
    );
  }
  if (manifest.apps?.length === 0) return { writes: [], operatorAssertions: [] };

  let appPaths = manifest.apps;
  if (appPaths === undefined) {
    const discovered = await runtimePackagePaths(options.moduleRoot);
    if (discovered.length !== 1) {
      throw actionRequired(
        "apps_declaration_missing",
        `Module nemá explicitní apps a nalezeno runtime balíčků: ${discovered.length}`,
        discovered.length === 0
          ? "Potvrď --no-app, nebo předej --app-package, --app-id, --title a --dev-script."
          : "Vyber default App ručně v lazurio.module.json; setup neuhodne pořadí více Apps.",
        context,
      );
    }
    appPaths = [relative(options.moduleRoot, discovered[0]).split(sep).join("/")];
  }

  const writes = [];
  let derivedManifest = manifest.apps === undefined
    ? { ...manifest, apps: appPaths, default_app: appPaths[0] }
    : manifest;
  for (const appPath of appPaths) {
    const packagePath = resolve(options.moduleRoot, ...appPath.split("/"));
    await assertRegularModuleFile({
      moduleRoot: options.moduleRoot,
      path: packagePath,
      displayPath: appPath,
      context,
      missingAction: "Materializuj deklarovanou App nebo oprav apps/default_app v Module manifestu.",
    });
    const packageText = await readFile(packagePath, "utf8");
    const packageJson = parseJsonForSetup(packageText, packagePath, context);
    const migration = migrateLegacyRuntimePackage(packageJson, {
      packagePath,
      organization: context.organization,
      moduleRoot: options.moduleRoot,
    });
    if (migration.issues.length > 0) {
      throw actionRequired(
        "runtime_migration_blocked",
        migration.issues.join("; "),
        "Uprav custom nebo víceprocesový runtime ručně podle Agent manuálu; setup obecný source parser nepřidává.",
        context,
      );
    }
    if (migration.changed) {
      if (!moduleManifestsMatchIgnoringMissingApps(derivedManifest, migration.moduleManifest)) {
        throw actionRequired(
          "runtime_module_lease_drift",
          `${appPath} odvozuje jiný Module lease než existující lazurio.module.json`,
          "Zachovej existující stabilní lease a ručně sjednoť runtime reference.",
          context,
        );
      }
      derivedManifest = { ...migration.moduleManifest, apps: appPaths, default_app: manifest.default_app ?? appPaths[0] };
      const rewritten = rewriteRuntimeScriptsFromModule(migration.packageJson, derivedManifest).packageJson;
      writes.push({
        action: "replace",
        path: packagePath,
        value: rewritten,
        expectedText: packageText,
        containmentRoot: options.moduleRoot,
      });
      continue;
    }
    const runtime = packageJson?.lazurio?.runtime;
    if (!runtime) {
      const explicitPackagePath = options.appPackage
        ? resolve(options.moduleRoot, options.appPackage)
        : null;
      if (explicitPackagePath !== packagePath) {
        throw actionRequired(
          "app_runtime_missing",
          `${appPath} nemá lazurio.runtime ani podporovanou legacy deklaraci`,
          "Předej explicitní --app-package, --app-id, --title a --dev-script pro tuto App, nebo doplň reference-only lazurio.runtime podle manuálu.",
          context,
        );
      }
      const nextPackage = explicitRuntimePackage({ options, context, packageJson, packagePath });
      const runtimeIssues = validateDeclaredRuntime({
        runtime: nextPackage.lazurio.runtime,
        packageJson: nextPackage,
        packagePath,
      });
      const materialized = materializeRuntimeFromModule({
        runtime: nextPackage.lazurio.runtime,
        module: { ...normalizedModule, apps: appPaths, default_app: manifest.default_app ?? appPaths[0] },
        packagePath,
      });
      if (runtimeIssues.length > 0 || materialized.issues.length > 0) {
        throw actionRequired(
          "app_contract_invalid",
          [...runtimeIssues, ...materialized.issues].join("; "),
          "Oprav explicitní App vstupy; existující Module lease zůstává beze změny.",
          context,
        );
      }
      writes.push({
        action: "replace",
        path: packagePath,
        value: nextPackage,
        expectedText: packageText,
        containmentRoot: options.moduleRoot,
      });
      continue;
    }
    const runtimeIssues = validateDeclaredRuntime({ runtime, packageJson, packagePath });
    const materialized = materializeRuntimeFromModule({
      runtime,
      module: { ...normalizedModule, apps: appPaths, default_app: manifest.default_app ?? appPaths[0] },
      packagePath,
    });
    if (runtimeIssues.length > 0 || materialized.issues.length > 0) {
      throw actionRequired(
        "runtime_contract_invalid",
        [...runtimeIssues, ...materialized.issues].join("; "),
        "Oprav App runtime reference; port zůstává pouze v lazurio.module.json.",
        context,
      );
    }
  }
  if (!sameJson(manifest, derivedManifest)) {
    writes.unshift({ action: "replace", path: manifestPath, value: derivedManifest, expectedText: manifestText });
  }
  return { writes, operatorAssertions: [] };
}

async function planNewModule({ options, context, manifestPath }) {
  if (options.noApp && options.appPackage) {
    throw actionRequired(
      "conflicting_app_mode",
      "--no-app a --app-package se vzájemně vylučují",
      "Vyber právě jeden explicitní typ Modulu.",
      context,
    );
  }
  if (options.noApp) {
    const manifest = {
      schema_version: "lazurio.module.v1",
      id: context.module,
      company: context.company,
      tcp_port_policy: { mode: "none" },
      port_leases: [],
      apps: [],
    };
    assertCandidateModule(manifest, manifestPath, context, []);
    return {
      writes: [{ action: "create", path: manifestPath, value: manifest }],
      operatorAssertions: [],
    };
  }

  if (options.appPackage) return planExplicitAppModule({ options, context, manifestPath });

  const discovered = await runtimePackagePaths(options.moduleRoot);
  if (discovered.length !== 1) {
    throw actionRequired(
      "module_kind_required",
      `Module nemá manifest a nalezeno runtime balíčků: ${discovered.length}`,
      discovered.length === 0
        ? "Použij --no-app, nebo předej --app-package, --app-id, --title a --dev-script."
        : "Přidej explicitní lazurio.module.json s apps/default_app; setup neuhodne default z více Apps.",
      context,
    );
  }
  const packagePath = discovered[0];
  const packageText = await readFile(packagePath, "utf8");
  const packageJson = parseJsonForSetup(packageText, packagePath, context);
  const migration = migrateLegacyRuntimePackage(packageJson, {
    packagePath,
    organization: context.organization,
    moduleRoot: options.moduleRoot,
  });
  if (!migration.changed || migration.issues.length > 0 || !migration.moduleManifest) {
    throw actionRequired(
      "runtime_migration_blocked",
      migration.issues.join("; ") || "Runtime nelze jednoznačně převést na Module lease",
      "Použij explicitní App vstupy nebo proveď bounded ruční migraci podle Agent manuálu.",
      context,
    );
  }
  assertCandidateIdentity(migration.moduleManifest, context);
  await assertCandidatePolicy(options.lazurioRoot, context, migration.moduleManifest);
  const rewritten = rewriteRuntimeScriptsFromModule(migration.packageJson, migration.moduleManifest).packageJson;
  return {
    writes: [
      { action: "create", path: manifestPath, value: migration.moduleManifest },
      {
        action: "replace",
        path: packagePath,
        value: rewritten,
        expectedText: packageText,
        containmentRoot: options.moduleRoot,
      },
    ],
    operatorAssertions: [],
  };
}

async function planExplicitAppModule({ options, context, manifestPath }) {
  if (!context.organization.module_port_pool) {
    throw actionRequired(
      "organization_port_pool_missing",
      `${context.company} nemá aktivní module_port_pool`,
      "Organization Admin musí v company.gen3.json aktivovat stabilní module_port_pool.",
      context,
    );
  }
  const packagePath = resolve(options.moduleRoot, options.appPackage);
  await assertRegularModuleFile({
    moduleRoot: options.moduleRoot,
    path: packagePath,
    displayPath: options.appPackage,
    context,
    missingAction: "Nejdřív vytvoř App package a jeho dev script; setup nevytváří aplikační source.",
  });
  const packageText = await readFile(packagePath, "utf8");
  const packageJson = parseJsonForSetup(packageText, packagePath, context);
  if (packageJson?.lazurio?.runtime || packageJson?.companyascode?.app) {
    throw actionRequired(
      "app_runtime_already_declared",
      `${options.appPackage} už obsahuje runtime deklaraci`,
      "Spusť setup bez explicitních App vstupů, nebo nejdřív vyřeš drift deklarace.",
      context,
    );
  }
  const modules = await readAllModuleContracts(options.lazurioRoot);
  const port = options.adoptPort ?? nextFreeModulePort({
    pool: context.organization.module_port_pool,
    company: context.company,
    modules,
  });
  if (!Number.isInteger(port) || port < 1024 || port > 65_535) {
    throw actionRequired(
      "adopt_port_invalid",
      `--adopt-port musí být celé číslo 1024-65535, obdrženo ${String(options.adoptPort)}`,
      "Použij doložený stabilní localhost port.",
      context,
    );
  }
  const appPath = relative(options.moduleRoot, packagePath).split(sep).join("/");
  const manifest = {
    schema_version: "lazurio.module.v1",
    id: context.module,
    company: context.company,
    tcp_port_policy: { mode: "single" },
    port_leases: [{ id: "main", host: "127.0.0.1", port }],
    apps: [appPath],
    default_app: appPath,
  };
  const nextPackage = rewriteRuntimeScriptsFromModule(
    explicitRuntimePackage({ options, context, packageJson, packagePath }),
    manifest,
  ).packageJson;
  const remainingPorts = [...new Set(
    selectedScriptCommands(nextPackage.scripts, options.devScript).flatMap(commandPorts),
  )];
  if (remainingPorts.length > 0) {
    throw actionRequired(
      "app_runtime_port_authority",
      `${options.appPackage}: dev script stále deklaruje číselný port ${remainingPorts.join("/")}`,
      "Odstraň hardcoded port nebo jej převeď na Launchpadem injektovaný PORT; setup nepřidává druhou portovou autoritu.",
      context,
    );
  }
  const validation = validateMigration({
    packageJson: nextPackage,
    original: packageJson,
    packagePath,
    moduleManifest: manifest,
    organization: context.organization,
    moduleRoot: options.moduleRoot,
  });
  if (!validation.changed || validation.issues.length > 0) {
    throw actionRequired(
      "app_contract_invalid",
      validation.issues.join("; "),
      "Oprav explicitní App vstupy nebo dev script; setup nepublikuje nevalidní kontrakt.",
      context,
    );
  }
  await assertCandidatePolicy(options.lazurioRoot, context, manifest);
  return {
    writes: [
      { action: "create", path: manifestPath, value: manifest },
      {
        action: "replace",
        path: packagePath,
        value: nextPackage,
        expectedText: packageText,
        containmentRoot: options.moduleRoot,
      },
    ],
    operatorAssertions: options.adoptPort === null
      ? []
      : [`Port ${port} byl převzat z explicitního --adopt-port; Lazurio neověřuje jeho historický původ.`],
  };
}

function explicitRuntimePackage({ options, context, packageJson, packagePath }) {
  const missing = [
    ["--app-id", options.appId],
    ["--title", options.title],
    ["--dev-script", options.devScript],
  ].filter(([, value]) => typeof value !== "string" || value.trim() === "").map(([name]) => name);
  if (missing.length > 0) {
    throw actionRequired(
      "app_inputs_missing",
      `Chybí explicitní vstupy: ${missing.join(", ")}`,
      "Doplň App identitu; setup ji neodvozuje z názvu balíčku ani složky.",
      context,
    );
  }
  if (typeof packageJson?.scripts?.[options.devScript] !== "string"
    || packageJson.scripts[options.devScript].trim() === "") {
    throw actionRequired(
      "app_dev_script_missing",
      `${packagePath}: script ${options.devScript} neexistuje nebo je prázdný`,
      "Vytvoř skutečný App dev script; setup nevytváří aplikační source.",
      context,
    );
  }
  const nextPackage = structuredClone(packageJson);
  nextPackage.lazurio = {
    ...(nextPackage.lazurio ?? {}),
    runtime: {
      schema_version: "lazurio.runtime.v1",
      id: options.appId,
      title: options.title,
      company: context.company,
      module: context.module,
      surface: options.surface,
      dev_script: options.devScript,
      tags: options.tags.length > 0 ? options.tags : [context.module],
      listeners: [{
        id: "app",
        role: "entrypoint",
        lease: "main",
        protocol: "http",
        health: { kind: "http", path: options.healthPath },
      }],
    },
  };
  return nextPackage;
}

async function resolveModuleSetupContext(options) {
  if (!existsSync(join(options.lazurioRoot, "organizations"))) {
    const error = new Error(`${options.lazurioRoot} není Lazurio Root: chybí organizations/`);
    error.lazurioExitCode = MODULE_SETUP_EXIT_CODES.usage_or_environment;
    throw error;
  }
  const rootEntry = await pathEntry(options.moduleRoot);
  if (!rootEntry?.isDirectory() || rootEntry.isSymbolicLink()) {
    throw new ModuleSetupActionRequired({
      code: "module_root_unavailable",
      message: `${relativeForReport(options.lazurioRoot, options.moduleRoot)} není běžná materializovaná složka`,
      action: "Materializuj přesný Organization Module slot; setup nevytváří Git repo ani nepřepisuje symlink.",
      context: fallbackContext(options),
    });
  }
  const physicalModuleRoot = await realpath(options.moduleRoot);
  const targetCheckout = await gitCheckoutIdentity(options.moduleRoot);
  const matches = [];
  const organizationsRoot = join(options.lazurioRoot, "organizations");
  for (const entry of await readdir(organizationsRoot, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory() || ignoredDirectories.has(entry.name)) continue;
    const organizationRoot = join(organizationsRoot, entry.name);
    const companyPath = join(organizationRoot, "company.gen3.json");
    const modulesPath = join(organizationRoot, "modules.manifest.json");
    if (!existsSync(companyPath) || !existsSync(modulesPath)) continue;
    const organizationEntry = await pathEntry(organizationRoot);
    if (!organizationEntry?.isDirectory() || organizationEntry.isSymbolicLink()) continue;
    const physicalOrganizationRoot = await realpath(organizationRoot);
    if (!pathIsStrictlyInside(physicalOrganizationRoot, physicalModuleRoot)) continue;
    const companyManifest = parseJsonForSetup(await readFile(companyPath, "utf8"), companyPath, fallbackContext(options));
    if (companyManifest.organization_kind === "template") continue;
    const modulesManifest = parseJsonForSetup(await readFile(modulesPath, "utf8"), modulesPath, fallbackContext(options));
    const exactRelative = relative(resolve(organizationRoot), options.moduleRoot).split(sep).join("/");
    for (const slot of modulesManifest.module_slots ?? []) {
      if (typeof slot?.path !== "string") continue;
      const moduleId = organizationSlotRepositoryId(slot, slot.path);
      if (moduleId === null) continue;
      const canonicalModuleRoot = resolve(organizationRoot, slot.path);
      const physicalCanonicalRoot = await realpath(canonicalModuleRoot).catch(() => null);
      if (!physicalCanonicalRoot || !pathIsStrictlyInside(physicalOrganizationRoot, physicalCanonicalRoot)) continue;
      const exact = slot.path === exactRelative
        && samePhysicalPath(physicalCanonicalRoot, physicalModuleRoot);
      const canonicalCheckout = exact || !targetCheckout
        ? null
        : await gitCheckoutIdentity(canonicalModuleRoot);
      const linkedWorktree = Boolean(
        targetCheckout
        && canonicalCheckout
        && samePhysicalPath(targetCheckout.commonDirectory, canonicalCheckout.commonDirectory),
      );
      if (!exact && !linkedWorktree) continue;
      const pool = normalizeOrganizationPortPool({ manifest: companyManifest, source: companyPath });
      if (pool.issues.length > 0) {
        throw new ModuleSetupActionRequired({
          code: "organization_port_pool_invalid",
          message: pool.issues.join("; "),
          action: "Organization Admin musí opravit company.gen3.json#module_port_pool.",
          context: fallbackContext(options),
        });
      }
      matches.push({
        company: companyManifest?.company?.slug,
        module: moduleId,
        organizationRoot,
        slot,
        source_kind: exact ? "slot" : "worktree",
        organization: {
          slug: companyManifest?.company?.slug,
          path: relative(options.lazurioRoot, organizationRoot),
          module_port_pool: pool.pool,
          module_port_pool_source: `${companyPath}#module_port_pool`,
        },
      });
    }
  }
  if (matches.length !== 1) {
    const unlinked = matches.length === 0 && targetCheckout !== null;
    throw new ModuleSetupActionRequired({
      code: matches.length === 0
        ? (unlinked ? "module_root_not_linked_to_slot" : "module_slot_not_declared")
        : "module_slot_ambiguous",
      message: matches.length === 0
        ? `${relativeForReport(options.lazurioRoot, options.moduleRoot)} není přesný slot ani Git worktree jeho kanonického checkoutu`
        : "Module root odpovídá více Organization slotům",
      action: matches.length === 0 && unlinked
        ? "Vytvoř task worktree z přesného Module checkoutu deklarovaného v modules.manifest.json; shodný remote URL není důkaz ownershipu."
        : "Oprav modules.manifest.json; setup nevytváří slot ani nehádá Organization ownership.",
      context: fallbackContext(options),
    });
  }
  const context = matches[0];
  if (!context.company || context.slot.status === "planned_slot") {
    throw new ModuleSetupActionRequired({
      code: context.slot.status === "planned_slot" ? "module_slot_planned" : "organization_identity_missing",
      message: context.slot.status === "planned_slot"
        ? `${context.slot.path} je stále planned_slot`
        : "Owning Organization nemá platný company.slug",
      action: "Organization Admin musí reviewovaně aktivovat slot a Git souřadnice před Module setupem.",
      context,
    });
  }
  return context;
}

async function runtimePackagePaths(moduleRoot) {
  const packages = await packagePathsBelow(moduleRoot);
  const runtimePackages = [];
  for (const packagePath of packages) {
    const packageJson = await Bun.file(packagePath).json().catch(() => null);
    if (packageJson?.lazurio?.runtime || packageJson?.companyascode?.app) runtimePackages.push(packagePath);
  }
  return runtimePackages;
}

async function modulePolicyIssues(lazurioRoot, context, module) {
  const modules = await readAllModuleContracts(lazurioRoot);
  return validateModuleLeasesAgainstOrganizationPools({
    modules: [
      ...modules.filter((candidate) => candidate.company !== module.company || candidate.id !== module.id),
      module,
    ],
    organizations: [context.organization],
  });
}

async function assertCandidatePolicy(lazurioRoot, context, manifest) {
  assertCandidateModule(manifest, join(context.organizationRoot, context.slot.path, "lazurio.module.json"), context, []);
  const normalized = normalizeModuleManifest({
    manifest,
    modulePath: join(context.organizationRoot, context.slot.path, "lazurio.module.json"),
  });
  const issues = await modulePolicyIssues(lazurioRoot, context, normalized.module);
  if (issues.length > 0) {
    throw actionRequired(
      "module_port_conflict",
      issues.join("; "),
      "Zachovej existující leases; pro nový Module nech Lazurio vybrat další volný port.",
      context,
    );
  }
}

function assertCandidateModule(manifest, manifestPath, context, extraIssues) {
  const normalized = normalizeModuleManifest({ manifest, modulePath: manifestPath });
  const issues = [...normalized.issues, ...extraIssues];
  if (issues.length > 0) {
    throw actionRequired(
      "generated_module_invalid",
      issues.join("; "),
      "Oprav explicitní vstupy; setup nikdy nezapisuje schema-nevalidní manifest.",
      context,
    );
  }
  assertCandidateIdentity(manifest, context);
}

function assertCandidateIdentity(manifest, context) {
  if (manifest.company !== context.company || manifest.id !== context.module) {
    throw actionRequired(
      "generated_module_identity_mismatch",
      `Odvozená identita ${String(manifest.company)}/${String(manifest.id)} neodpovídá slotu ${context.company}/${context.module}`,
      "Oprav Organization slot nebo legacy runtime identitu; setup ji nepřepisuje odhadem.",
      context,
    );
  }
}

function moduleManifestsMatchIgnoringMissingApps(existing, derived) {
  if (existing.apps === undefined) {
    const candidate = { ...existing, apps: derived.apps, default_app: derived.default_app };
    return sameJson(candidate, derived);
  }
  return sameJson(existing, derived);
}

function moduleSetupReport({ options, context, status, reason, writes = [], operatorAssertions = [], issues = [] }) {
  return {
    schema_version: "lazurio.module_setup.report.v1",
    status,
    reason,
    root: relativeForReport(options.lazurioRoot, options.lazurioRoot),
    module: {
      company: context.company ?? null,
      id: context.module ?? basename(options.moduleRoot),
      root: relativeForReport(options.lazurioRoot, options.moduleRoot),
      manifest: relativeForReport(options.lazurioRoot, join(options.moduleRoot, "lazurio.module.json")),
    },
    changes: writes.map((write) => ({
      action: write.action,
      path: relativeForReport(options.lazurioRoot, write.path),
    })),
    issues,
    operator_assertions: operatorAssertions,
  };
}

function blockedModuleSetupReport(options, error) {
  return moduleSetupReport({
    options,
    context: error.context ?? fallbackContext(options),
    status: "action_required",
    reason: error.code,
    issues: [{ code: error.code, message: error.message, action: error.action }],
  });
}

function fallbackContext(options) {
  return { company: null, module: basename(options.moduleRoot) };
}

class ModuleSetupActionRequired extends Error {
  constructor({ code, message, action, context }) {
    super(message);
    this.name = "ModuleSetupActionRequired";
    this.code = code;
    this.action = action;
    this.context = context;
  }
}

function actionRequired(code, message, action, context) {
  return new ModuleSetupActionRequired({ code, message, action, context });
}

function parseJsonForSetup(text, path, context) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw actionRequired(
      "json_invalid",
      `${path}: JSON nejde přečíst (${error.message})`,
      "Oprav JSON ručně; setup neobnovuje poškozený obsah odhadem.",
      context,
    );
  }
}

function assertPathWithin(root, candidate, context, code) {
  const rel = relative(resolve(root), resolve(candidate));
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw actionRequired(code, `${candidate} neleží uvnitř Module rootu`, "Použij relativní package.json cestu uvnitř Modulu.", context);
  }
}

function pathIsStrictlyInside(root, candidate) {
  const rel = relative(root, candidate);
  return rel !== ""
    && rel !== ".."
    && !rel.startsWith(`..${sep}`)
    && !isAbsolute(rel);
}

function samePhysicalPath(left, right) {
  return process.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

async function gitCheckoutIdentity(root) {
  const marker = await pathEntry(join(root, ".git"));
  if (!marker || marker.isSymbolicLink() || (!marker.isDirectory() && !marker.isFile())) return null;
  const [topLevel, commonDirectory] = await Promise.all([
    runGit(["rev-parse", "--path-format=absolute", "--show-toplevel"], {
      cwd: root,
      timeoutMs: GIT_LOCAL_TIMEOUT_MS,
    }),
    runGit(["rev-parse", "--path-format=absolute", "--git-common-dir"], {
      cwd: root,
      timeoutMs: GIT_LOCAL_TIMEOUT_MS,
    }),
  ]);
  if (!topLevel.ok || !commonDirectory.ok) return null;
  const [physicalRoot, physicalTopLevel, physicalCommonDirectory] = await Promise.all([
    realpath(root),
    realpath(topLevel.stdout).catch(() => null),
    realpath(
      isAbsolute(commonDirectory.stdout) || win32.isAbsolute(commonDirectory.stdout)
        ? commonDirectory.stdout
        : resolve(root, commonDirectory.stdout),
    ).catch(() => null),
  ]);
  if (!physicalTopLevel
    || !physicalCommonDirectory
    || !samePhysicalPath(physicalRoot, physicalTopLevel)) return null;
  const commonEntry = await pathEntry(physicalCommonDirectory);
  if (!commonEntry?.isDirectory() || commonEntry.isSymbolicLink()) return null;
  return { root: physicalRoot, commonDirectory: physicalCommonDirectory };
}

async function assertRegularModuleFile({ moduleRoot, path, displayPath, context, missingAction }) {
  assertPathWithin(moduleRoot, path, context, "app_package_outside_module");
  const root = resolve(moduleRoot);
  const segments = relative(root, resolve(path)).split(sep);
  let cursor = root;
  for (let index = 0; index < segments.length; index += 1) {
    cursor = join(cursor, segments[index]);
    const entry = await pathEntry(cursor);
    const final = index === segments.length - 1;
    if (entry?.isSymbolicLink()) {
      throw actionRequired(
        "app_package_outside_module",
        `${displayPath} prochází přes symlink nebo junction ${relative(root, cursor).split(sep).join("/")}`,
        "Použij běžnou App složku fyzicky uvnitř Modulu; setup odkazy nepřepisuje.",
        context,
      );
    }
    if (!entry || (final ? !entry.isFile() : !entry.isDirectory())) {
      throw actionRequired(
        "app_package_missing",
        `${displayPath} není čitelný běžný package.json`,
        missingAction,
        context,
      );
    }
  }
  const physicalRoot = await realpath(root);
  const physicalPath = await realpath(path);
  assertPathWithin(physicalRoot, physicalPath, context, "app_package_outside_module");
  return dirname(physicalPath);
}

async function pathEntry(path) {
  return lstat(path).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
}

async function assertModuleWriteParent({ moduleRoot, path, context }) {
  assertPathWithin(moduleRoot, path, context, "app_package_outside_module");
  const root = resolve(moduleRoot);
  const parent = dirname(resolve(path));
  const rootEntry = await pathEntry(root);
  const parentSegments = relative(root, parent) === "" ? [] : relative(root, parent).split(sep);
  let cursor = root;
  let unsafeParent = !rootEntry?.isDirectory() || rootEntry.isSymbolicLink();
  for (const segment of parentSegments) {
    cursor = join(cursor, segment);
    const entry = await pathEntry(cursor);
    if (!entry?.isDirectory() || entry.isSymbolicLink()) {
      unsafeParent = true;
      break;
    }
  }
  if (unsafeParent) {
    throw actionRequired(
      "app_package_outside_module",
      `${relative(root, path).split(sep).join("/")} nemá běžnou rodičovskou složku uvnitř Modulu`,
      "Obnov běžný Module checkout; setup nezapisuje přes symlink nebo junction.",
      context,
    );
  }
  const [physicalRoot, physicalParent] = await Promise.all([realpath(root), realpath(parent)]);
  if (!samePhysicalPath(physicalRoot, physicalParent)) {
    assertPathWithin(physicalRoot, physicalParent, context, "app_package_outside_module");
  }
  return physicalParent;
}

function publishJsonFileAtomically({
  action,
  path,
  displayPath,
  value,
  expectedText,
  expectedParentRealPath,
  context,
}) {
  const payload = JSON.stringify({
    action,
    target_name: basename(path),
    expected_parent_real_path: expectedParentRealPath,
    expected_text: expectedText ?? null,
    next_text: `${JSON.stringify(value, null, 2)}\n`,
  });
  const child = spawnSync(
    process.execPath,
    [fileURLToPath(import.meta.url), PINNED_JSON_PUBLISH_MODE],
    {
      // The child is born inside the validated parent. Its cwd is an
      // OS-pinned directory capability, so every relative mutation below
      // keeps targeting that directory even if the lexical path is replaced.
      cwd: dirname(path),
      input: payload,
      encoding: "utf8",
      maxBuffer: Math.max(1_048_576, Buffer.byteLength(payload) * 2),
      windowsHide: true,
    },
  );
  if (child.error) throw child.error;
  let result = null;
  try {
    result = JSON.parse(child.stdout.trim());
  } catch {
    throw new Error(`${path}: izolovaný atomický zápis nevrátil platný výsledek`);
  }
  if (child.status === 0 && result?.ok === true) return;
  if (result?.code === "parent_identity_changed") {
    throw actionRequired(
      "app_package_outside_module",
      `${displayPath} změnil rodičovskou složku během apply`,
      "Zkontroluj souběžný zásah do Module checkoutu a spusť setup znovu; mimo Modul nebylo nic změněno.",
      context,
    );
  }
  if (result?.code === "target_changed") {
    throw actionRequired(
      "app_package_changed_during_apply",
      `${path}: obsah se během apply změnil`,
      "Zkontroluj souběžné změny a spusť setup znovu; setup cizí obsah nepřepsal.",
      context,
    );
  }
  throw new Error(`${path}: izolovaný atomický zápis selhal (${result?.code ?? `exit_${child.status}`})`);
}

async function runPinnedJsonPublisher() {
  let payload;
  try {
    payload = JSON.parse(await Bun.stdin.text());
    assertPinnedPublisherPayload(payload);
    const actualParentRealPath = await realpath(".");
    if (!samePhysicalPath(actualParentRealPath, payload.expected_parent_real_path)) {
      throw pinnedPublisherError("parent_identity_changed");
    }
    const temporary = `.${payload.target_name}.lazurio-setup-${process.pid}-${randomUUID()}.tmp`;
    await writeFile(temporary, payload.next_text, { encoding: "utf8", flag: "wx" });
    try {
      if (payload.action === "create") {
        // The hard-link publishes only if the target is still absent. Both
        // names resolve relative to the already pinned working directory.
        await link(temporary, payload.target_name);
      } else {
        const entry = await pathEntry(payload.target_name);
        if (!entry?.isFile() || entry.isSymbolicLink()) {
          throw pinnedPublisherError("target_changed");
        }
        const observed = await readFile(payload.target_name, "utf8");
        if (observed !== payload.expected_text) throw pinnedPublisherError("target_changed");
        await rename(temporary, payload.target_name);
      }
    } finally {
      await rm(temporary, { force: true });
    }
    process.stdout.write(`${JSON.stringify({ ok: true })}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      code: error?.pinnedPublisherCode ?? "publisher_failed",
    })}\n`);
    process.exitCode = 1;
  }
}

function assertPinnedPublisherPayload(payload) {
  if (!["create", "replace"].includes(payload?.action)
    || typeof payload?.target_name !== "string"
    || payload.target_name === ""
    || payload.target_name === "."
    || payload.target_name === ".."
    || basename(payload.target_name) !== payload.target_name
    || typeof payload?.expected_parent_real_path !== "string"
    || !isAbsolute(payload.expected_parent_real_path)
    || typeof payload?.next_text !== "string"
    || (payload.action === "replace" && typeof payload?.expected_text !== "string")) {
    throw pinnedPublisherError("invalid_request");
  }
}

function pinnedPublisherError(code) {
  const error = new Error(code);
  error.pinnedPublisherCode = code;
  return error;
}

function relativeForReport(root, path) {
  const rel = relative(resolve(root), resolve(path)).split(sep).join("/");
  return rel || ".";
}

export function parseRuntimeMigrationArgs(argv) {
  let write = false;
  let explicitLazurioRoot = null;
  let usedDeprecatedRootFlag = false;
  const targets = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--write") {
      write = true;
      continue;
    }
    if (["--lazurio-root", "--conglomerate-root"].includes(argument)) {
      if (explicitLazurioRoot !== null) {
        throw new Error("Použij právě jeden z --lazurio-root nebo deprecated --conglomerate-root");
      }
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${argument} vyžaduje cestu`);
      explicitLazurioRoot = value;
      usedDeprecatedRootFlag = argument === "--conglomerate-root";
      index += 1;
      continue;
    }
    if (argument.startsWith("--")) throw new Error(`Neznámý argument ${argument}`);
    targets.push(argument);
  }
  return { write, explicitLazurioRoot, usedDeprecatedRootFlag, targets };
}

export async function runRuntimeMigrationCli(argv) {
  let parsed;
  try {
    parsed = parseRuntimeMigrationArgs(argv);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
    return;
  }
  const { write, explicitLazurioRoot, usedDeprecatedRootFlag, targets } = parsed;
  if (usedDeprecatedRootFlag) {
    console.warn("warning: --conglomerate-root je deprecated; použij --lazurio-root");
  }
  const roots = targets.map((argument) => resolve(argument));
  if (roots.length === 0) {
    console.error("Usage: bun scripts/lazurio-runtime-migrate.mjs [--write] [--lazurio-root <path>] <package.json|directory> [...]");
    process.exitCode = 2;
    return;
  }
  const paths = [];
  const lazurioRoot = resolve(explicitLazurioRoot ?? resolve(import.meta.dirname, ".."));
  if (!existsSync(join(lazurioRoot, "organizations"))) {
    console.error(`${lazurioRoot} není primární Lazurio root: chybí organizations/; předej --lazurio-root`);
    process.exitCode = 2;
    return;
  }
  const organizationPolicies = await readOrganizationPolicies(lazurioRoot);
  if (organizationPolicies.issues.length > 0) {
    console.error(`Organization port policy je nevalidní:\n${organizationPolicies.issues.join("\n")}`);
    process.exitCode = 2;
    return;
  }
  for (const root of roots) {
    if (!existsSync(root)) {
      console.error(`missing: ${root}`);
      process.exitCode = 2;
      continue;
    }
    if (root.endsWith("package.json")) paths.push(root);
    else paths.push(...await packagePathsBelow(root));
  }

  let pending = 0;
  let blockedCount = 0;
  const modules = new Map();
  const packageWrites = [];
  for (const packagePath of [...new Set(paths)].sort()) {
    let packageJson;
    try {
      packageJson = await Bun.file(packagePath).json();
    } catch (error) {
      console.warn(`warning: ${packagePath}: package.json nejde přečíst: ${error.message}`);
      blockedCount += 1;
      continue;
    }
    const organization = organizationPolicyForPackage({
      lazurioRoot,
      packagePath,
      organizations: organizationPolicies.organizations,
    });
    const result = migrateLegacyRuntimePackage(packageJson, {
      packagePath,
      organization,
    });
    if (!result.changed && result.issues.length > 0) blockedCount += 1;
    let moduleManifest = result.moduleManifest;
    let candidatePackageJson = result.packageJson;
    const runtime = candidatePackageJson?.lazurio?.runtime;
    if (!moduleManifest && runtime) {
      const existingModulePath = join(moduleRootForPackage(packagePath, runtime.module), "lazurio.module.json");
      if (existsSync(existingModulePath)) {
        try {
          moduleManifest = await Bun.file(existingModulePath).json();
        } catch (error) {
          console.warn(`warning: ${existingModulePath}: lazurio.module.json nejde přečíst: ${error.message}`);
          blockedCount += 1;
          continue;
        }
      }
    }
    const scriptsRewrite = rewriteRuntimeScriptsFromModule(candidatePackageJson, moduleManifest);
    candidatePackageJson = scriptsRewrite.packageJson;
    if (result.changed || scriptsRewrite.changed) {
      const moduleRoot = moduleRootForPackage(packagePath, moduleManifest.id);
      const modulePath = join(moduleRoot, "lazurio.module.json");
      const existing = modules.get(modulePath);
      if (existing && !sameJson(existing, moduleManifest)) {
        result.issues.push(`${packagePath}: verze modulu driftuje proti ${relative(process.cwd(), modulePath)}; port leases se liší`);
        blockedCount += 1;
      } else {
        modules.set(modulePath, moduleManifest);
        packageWrites.push([packagePath, candidatePackageJson]);
        pending += 1;
      }
    }
    for (const issue of result.issues) console.warn(`warning: ${issue}`);
  }

  if (blockedCount === 0) {
    for (const [modulePath, manifest] of modules) {
      if (existsSync(modulePath)) {
        const current = await Bun.file(modulePath).json();
        if (!sameJson(current, manifest)) {
          console.warn(`warning: ${modulePath}: existující lazurio.module.json driftuje proti migrovaným app verzím`);
          blockedCount += 1;
        }
      }
    }
  }
  if (blockedCount === 0) {
    const candidates = [];
    for (const [modulePath, manifest] of modules) {
      const normalized = normalizeModuleManifest({ manifest, modulePath });
      if (normalized.module) candidates.push(normalized.module);
    }
    const policyIssues = validateModuleLeasesAgainstOrganizationPools({
      modules: [...await readAllModuleContracts(lazurioRoot), ...candidates],
      organizations: organizationPolicies.organizations,
    });
    if (policyIssues.length > 0) {
      for (const issue of policyIssues) console.warn(`warning: ${issue}`);
      blockedCount += policyIssues.length;
    }
  }
  if (blockedCount === 0) {
    for (const [modulePath, manifest] of modules) {
      if (write) await atomicJsonWrite(modulePath, manifest);
      console.log(`${write ? "wrote" : "would write"}: ${modulePath}`);
    }
    for (const [packagePath, packageJson] of packageWrites) {
      if (write) await atomicJsonWrite(packagePath, packageJson);
      console.log(`${write ? "migrated" : "would migrate"}: ${packagePath}`);
    }
  }
  console.log(`lazurio module/runtime migration: ${pending} ${write ? "migrated" : "pending"}, ${blockedCount} blocked`);
  if (!write && pending > 0) process.exitCode = 1;
  if (blockedCount > 0) process.exitCode = 2;
}

async function readOrganizationPolicies(lazurioRoot) {
  const organizations = [];
  const issues = [];
  const slugs = new Set();
  const root = join(lazurioRoot, "organizations");
  for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory() || ignoredDirectories.has(entry.name)) continue;
    const manifestPath = join(root, entry.name, "company.gen3.json");
    if (!existsSync(manifestPath)) continue;
    let manifest;
    try {
      manifest = await Bun.file(manifestPath).json();
    } catch (error) {
      issues.push(`${manifestPath}: nejde přečíst: ${error.message}`);
      continue;
    }
    if (manifest?.organization_kind === "template") continue;
    const slug = manifest?.company?.slug;
    if (typeof slug !== "string" || slug === "") {
      issues.push(`${manifestPath}: company.slug chybí`);
      continue;
    }
    if (slugs.has(slug)) {
      issues.push(`${manifestPath}: Organization slug ${slug} je namountovaný vícekrát`);
      continue;
    }
    slugs.add(slug);
    const result = normalizeOrganizationPortPool({ manifest, source: manifestPath });
    issues.push(...result.issues);
    const organization = {
      slug,
      path: relative(lazurioRoot, join(root, entry.name)),
      module_port_pool: result.pool,
      module_port_pool_source: `${manifestPath}#module_port_pool`,
    };
    organizations.push(organization);
  }
  return { organizations, issues };
}

function organizationPolicyForPackage({ lazurioRoot, packagePath, organizations }) {
  const organizationsRoot = resolve(lazurioRoot, "organizations");
  const absolutePackagePath = resolve(packagePath);
  if (!pathIsWithin(organizationsRoot, absolutePackagePath)) return undefined;
  return organizations.find((organization) =>
    pathIsWithin(resolve(lazurioRoot, organization.path), absolutePackagePath)
  ) ?? null;
}

function pathIsWithin(root, candidate) {
  const rel = relative(root, candidate);
  return rel !== ""
    && rel !== ".."
    && !rel.startsWith(`..${sep}`)
    && !isAbsolute(rel);
}

async function atomicJsonWrite(path, value) {
  const temporary = `${path}.lazurio-migrate-${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  await rename(temporary, path);
}

if (import.meta.main) {
  if (process.argv[2] !== PINNED_JSON_PUBLISH_MODE) {
    throw new Error("module-setup-lib.mjs je interní knihovna; použij `lazurio module setup`");
  }
  await runPinnedJsonPublisher();
}
