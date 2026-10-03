#!/usr/bin/env bun

// Lazurio Module Standard conformance (manual/module-standard.md kap. 11,
// decision 0171). Read-only and cheap: file reads, JSON and regex over App
// sources plus one local `git ls-files`. It never executes Module scripts and
// never touches the network. `lazurio module setup` owns orchestration and
// writes; this module only measures and proposes the few mechanical repairs
// the standard allows.

import { lstat, readFile, readdir, readlink, realpath } from "fs/promises";
import { extname, isAbsolute, join, posix, relative as relativePath, resolve, sep } from "path";
import { readRequiredBunVersion } from "./core/toolchain-lib.mjs";
import { findModuleStandardPortFindings } from "./core/organization-port-policy-lib.mjs";
import { GIT_LOCAL_TIMEOUT_MS, runGit } from "./runtime/git-lib.mjs";
import { validateAgainstSchema } from "./runtime/json-schema-mini.mjs";

export const MODULE_STANDARD_CHECKS = Object.freeze([
  { id: "MS-01", summary: "lazurio.module.json platné, id odpovídá slotu, lease v poolu Organizace, pooly disjunktní" },
  { id: "MS-02", summary: "packageManager je přesný Bun a lockfile je commitnutý a čerstvý" },
  { id: "MS-03", summary: "lazurio.runtime má listenery s health a dev_script existuje" },
  { id: "MS-04", summary: "lazurio.preparation je deklarované, check_script existuje a runtime je bun nebo uv" },
  { id: "MS-05", summary: "dev skript spouští právě jeden proces" },
  { id: "MS-06", summary: "App nečte legacy LAZURIO_RUNTIME_HOST/PORT, PORT, COMPANYASCODE_* ani lease soubor a port leasu nemá zapsaný natvrdo" },
  { id: "MS-07", summary: "žádné .env* na start cestě, žádné dotenv a Bun se spouští s --no-env-file" },
  { id: "MS-08", summary: "TypeScript strict a žádné .js/.mjs/.cjs zdroje App" },
  { id: "MS-09", summary: "žádné importy mimo repozitář Modulu" },
  { id: "MS-10", summary: "repository-db a module-kit jsou připnuté na vydaný tag" },
  { id: "MS-11", summary: "žádné absolutní cesty na stroj, symlinky vytvářené při startu ani layout modules/" },
  { id: "MS-12", summary: "apps[] odpovídá adresářům a Modul drží nejvýše dvě generace App (výchozí a jednu předchozí nebo kandidátní)" },
  { id: "MS-13", summary: "skripty check a test existují" },
]);

const CHECK_ACTIONS = Object.freeze({
  "MS-01": "Přepiš port leasu v lazurio.module.json na navržený volný port poolu v PR Modulu a ověř start App na novém portu (lazurio module start); setup lease nepřesouvá. Překryv poolů opraví Organization Admin v Organization manifestu.",
  "MS-02": "Doplň packageManager na přesnou verzi Bunu z Lazuria a commitni čerstvý bun.lock z bun install.",
  "MS-03": "Doplň lazurio.runtime s listenery, health a existujícím dev_script podle manual/module-setup.md.",
  "MS-04": "Doplň lazurio.preparation s check_script (read-only package skript) podle lazurio-preparation.schema.json.",
  "MS-05": "Zjednoduš dev skript na jeden dlouho běžící proces; build, guardy a další procesy patří do přípravy nebo do App.",
  "MS-06": "Čti host a port jen z LAZURIO_RUNTIME_LISTENER_<ID>_HOST/_PORT (ideálně přes @lazurio/module-kit) a bez nich skonči chybou; port leasu žije jen v lazurio.module.json.",
  "MS-07": "Odstraň .env soubory a dotenv a spouštěj Bun s --no-env-file; konfigurace je runtime env plus commitnuté config soubory, tajemství deklaruj v lazurio.runtime.secrets (trezor Environmentu).",
  "MS-08": "Zapni strict v tsconfig.json (nebo extends strict preset) a převeď .js/.mjs/.cjs zdroje a configy na TypeScript.",
  "MS-09": "Nahraď importy mimo repo verzovanou závislostí nebo kód vlož do Modulu, který ho jediný používá.",
  "MS-10": "Připni závislost na vydaný tag, například github:Lazurio/repository-db#v3.1.0.",
  "MS-11": "Odstraň absolutní cesty a vytváření symlinků ze startu (patří do prepare_script); Modul patří do workspace/.",
  "MS-12": "Sjednoť apps[] s adresáři app/*/package.json a smaž starší generace App (historie zůstává v Gitu).",
  "MS-13": "Doplň do každé App skripty check (typecheck + biome) a test (bun test).",
});

const SKIPPED_DIRECTORIES = new Set([
  ".git",
  ".worktrees",
  ".astro",
  ".next",
  ".svelte-kit",
  ".turbo",
  ".cache",
  ".output",
  ".vercel",
  ".wrangler",
  ".venv",
  "__pycache__",
  "node_modules",
  "dist",
  "build",
  "coverage",
]);
const TEST_DIRECTORIES = new Set(["test", "tests", "__tests__", "e2e", "fixtures", "__fixtures__"]);
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".astro"]);
const JAVASCRIPT_EXTENSIONS = new Set([".js", ".jsx", ".mjs", ".cjs"]);
const MAX_WALKED_FILES = 20_000;
const MAX_READ_BYTES = 1_048_576;
const KNOWN_STRICT_TSCONFIG_PRESETS = [
  /^astro\/tsconfigs\/strict(?:est)?(?:\.json)?$/,
  /^@tsconfig\/strictest(?:\/tsconfig\.json)?$/,
];
const PINNED_DEPENDENCY = /^github:Lazurio\/(?:repository-db|module-kit)#v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

// Platform issue that makes the Launchpad read lazurio.runtime.secrets; the
// MS-03 warning goes away with its release (decision 0177).
const SECRETS_PLATFORM_ISSUE = "Lazurio/LazurioPlatform#PLATFORM_ISSUE";

let preparationSchemaPromise = null;

/**
 * Measures one Module against the standard. `manifest` and `packages` are the
 * values setup is about to leave on disk (planned writes overlaid on the
 * checkout), so a dry-run reports the state `--apply` would produce for the
 * contract layer. Returns the 13 checks and repaired values for the
 * mechanical items only.
 */
export async function evaluateModuleStandard({
  moduleRoot,
  slotPath,
  manifest,
  packages,
  organization,
  organizations = [],
  modules = [],
  requiredBunVersion = readRequiredBunVersion(),
}) {
  const root = resolve(moduleRoot);
  const results = new Map(MODULE_STANDARD_CHECKS.map(({ id }) => [id, { status: "pass", details: [], repairs: [] }]));
  const record = (id, status, detail) => {
    const result = results.get(id);
    if (status === "fail" || (status === "warn" && result.status === "pass")) result.status = status;
    if (detail) result.details.push(detail);
  };
  const { files, symlinks } = await walkModuleFiles(root);
  const apps = (Array.isArray(manifest?.apps) ? manifest.apps : []).map((appPath) => ({
    appPath,
    appDirectory: posix.dirname(appPath) === "." ? "" : posix.dirname(appPath),
    packageJson: packages.get(appPath) ?? null,
  }));
  const repairedPackages = new Map();
  const leasePorts = (Array.isArray(manifest?.port_leases) ? manifest.port_leases : [])
    .map((lease) => lease?.port)
    .filter((port) => Number.isInteger(port));

  const lockPaths = apps.flatMap(({ appDirectory }) => ["bun.lock", "uv.lock"].map((name) => joinPosix(appDirectory, name)));
  const tracked = await gitTrackedPaths(root, lockPaths);

  for (const app of apps) {
    const label = app.appPath;
    const packageJson = app.packageJson;
    if (!packageJson) {
      for (const { id } of MODULE_STANDARD_CHECKS.filter(({ id }) => !["MS-01", "MS-11", "MS-12"].includes(id))) {
        record(id, "fail", `${label}: package.json nejde přečíst`);
      }
      continue;
    }
    const appFiles = filesBelow(files, app.appDirectory);
    const appSources = appFiles.filter((file) => SOURCE_EXTENSIONS.has(file.extension) && !file.test);
    const preparation = packageJson?.lazurio?.preparation;
    const hasPyproject = appFiles.some((file) => file.path === joinPosix(app.appDirectory, "pyproject.toml"));
    const preparationRuntime = preparation?.runtime ?? (hasPyproject ? "uv" : "bun");
    const scripts = packageJson.scripts && typeof packageJson.scripts === "object" ? packageJson.scripts : {};
    let nextPackage = null;
    const ensureNextPackage = () => {
      nextPackage ??= structuredClone(packageJson);
      return nextPackage;
    };

    // MS-02 packageManager + lockfile
    if (preparationRuntime === "uv") {
      const lockPath = joinPosix(app.appDirectory, "uv.lock");
      checkLockTracked({ record, label, lockPath, files, tracked, name: "uv.lock" });
    } else {
      const expected = `bun@${requiredBunVersion}`;
      if (packageJson.packageManager === undefined) {
        record("MS-02", "fail", `${label}: packageManager chybí (očekáváno ${expected})`);
        insertKeyAfter(ensureNextPackage(), "packageManager", expected, ["type", "private", "version", "name"]);
        results.get("MS-02").repairs.push(`${label}: doplnit packageManager ${expected}`);
      } else if (packageJson.packageManager !== expected) {
        record("MS-02", "fail", `${label}: packageManager ${String(packageJson.packageManager)} neodpovídá ${expected}`);
      }
      const lockPath = joinPosix(app.appDirectory, "bun.lock");
      if (files.some((file) => file.path === joinPosix(app.appDirectory, "bun.lockb"))) {
        record("MS-02", "fail", `${label}: binární bun.lockb nahraď textovým bun.lock`);
      }
      if (checkLockTracked({ record, label, lockPath, files, tracked, name: "bun.lock" })) {
        const drift = await bunLockDrift(join(root, ...lockPath.split("/")), packageJson);
        if (drift === null) record("MS-02", "fail", `${label}: ${lockPath} nejde přečíst`);
        else for (const item of drift) record("MS-02", "fail", `${label}: ${lockPath} není čerstvý (${item})`);
      }
    }

    // MS-03 runtime, listeners, health, dev_script
    const runtime = packageJson?.lazurio?.runtime;
    const devScriptName = typeof runtime?.dev_script === "string" ? runtime.dev_script : "dev";
    if (!runtime || typeof runtime !== "object") {
      record("MS-03", "fail", `${label}: lazurio.runtime chybí`);
    } else {
      const listeners = Array.isArray(runtime.listeners) ? runtime.listeners : [];
      if (listeners.length === 0) record("MS-03", "fail", `${label}: lazurio.runtime.listeners je prázdné`);
      for (const listener of listeners) {
        if (!listener?.health || typeof listener.health !== "object" || !["http", "tcp"].includes(listener.health.kind)) {
          record("MS-03", "fail", `${label}: listener ${String(listener?.id)} nemá health`);
        }
      }
      if (!nonEmptyString(scripts[devScriptName])) {
        record("MS-03", "fail", `${label}: dev_script ${devScriptName} neexistuje v scripts`);
      }
      // Declared secrets (decision 0177): the shape is validated by the Core
      // runtime contract. Until a released Platform reads the key, its runtime
      // reader refuses the whole declaration, so the App would not start.
      if (Array.isArray(runtime.secrets) && runtime.secrets.length > 0) {
        record(
          "MS-03",
          "warn",
          `${label}: lazurio.runtime.secrets (${runtime.secrets.join(", ")}) Launchpad zatím nečte a App s deklarací nespustí (${SECRETS_PLATFORM_ISSUE})`,
        );
      }
    }

    // MS-04 preparation
    if (preparationRuntime === "uv") {
      // A Python App carries its declaration in app/v<N>/pyproject.toml
      // [tool.lazurio] (manual/module-standard.md kap. 7). Core does not read
      // it yet, so MS-04 stays undecided; a declaration that is visible here
      // is still held to the schema (uv_version is required for uv).
      record("MS-04", "warn", `${label}: Python App: čtení [tool.lazurio] z pyproject.toml zatím není v Core; ověř přípravu ručně`);
      if (preparation !== undefined) {
        for (const issue of await preparationDeclarationIssues(preparation, label)) record("MS-04", "fail", issue);
      }
    } else if (preparation === undefined) {
      record("MS-04", "fail", `${label}: lazurio.preparation chybí`);
      // No `runtime` key: absence means bun, and today's Platform reader
      // refuses unknown fields until it reads the key (DEV-6634 W0-5).
      const skeleton = {
        schema_version: "lazurio.preparation.v1",
        owner_package: app.appPath,
        ...(nonEmptyString(scripts["check:prepared"]) ? { check_script: "check:prepared" } : {}),
      };
      const schema = await preparationSchema();
      const ownerPattern = new RegExp(schema.properties.owner_package.pattern);
      if (!runtime) {
        record("MS-04", "fail", `${label}: skeleton přípravy se nedoplní bez lazurio.runtime`);
      } else if (!ownerPattern.test(app.appPath)) {
        record("MS-04", "fail", `${label}: owner_package ${app.appPath} neodpovídá schématu; přesuň App do app/v<N>/`);
      } else {
        const next = ensureNextPackage();
        next.lazurio = { ...(next.lazurio ?? {}), preparation: skeleton };
        results.get("MS-04").repairs.push(
          `${label}: doplnit lazurio.preparation skeleton${skeleton.check_script ? " s check_script check:prepared" : " (check_script doplň ručně)"}`,
        );
        if (!skeleton.check_script) record("MS-04", "fail", `${label}: chybí skript check:prepared pro check_script`);
      }
    } else {
      for (const issue of await preparationDeclarationIssues(preparation, label)) record("MS-04", "fail", issue);
      if (preparation && typeof preparation === "object" && !Array.isArray(preparation) && preparation.runtime === "bun") {
        record(
          "MS-04",
          "fail",
          `${label}: runtime: bun zapsané explicitně — Platforma dnes neznámá pole odmítá; klíč vynech (chybí = bun)`,
        );
      }
      if (preparation && typeof preparation === "object" && !Array.isArray(preparation)) {
        const ownerPackagePath = typeof preparation.owner_package === "string" ? preparation.owner_package : null;
        const ownerPackage = ownerPackagePath === app.appPath
          ? packageJson
          : ownerPackagePath && !escapesRoot(ownerPackagePath)
            ? packages.get(ownerPackagePath) ?? await readJsonOrNull(join(root, ...ownerPackagePath.split("/")))
            : null;
        if (ownerPackagePath && !ownerPackage) {
          record("MS-04", "fail", `${label}: owner_package ${ownerPackagePath} není čitelný package.json uvnitř Modulu`);
        }
        for (const key of ["check_script", "prepare_script"]) {
          const scriptName = preparation[key];
          if (typeof scriptName !== "string" || !ownerPackage) continue;
          if (!nonEmptyString(ownerPackage.scripts?.[scriptName])) {
            record("MS-04", "fail", `${label}: ${key} ${scriptName} neexistuje v ${ownerPackagePath}`);
          }
        }
      }
    }

    // MS-05 single-process dev script
    if (nonEmptyString(scripts[devScriptName])) {
      for (const command of scriptChain(scripts, devScriptName)) {
        for (const finding of devScriptFindings(command)) {
          record("MS-05", "fail", `${label}: ${devScriptName} obsahuje ${finding}: ${command}`);
        }
      }
    }

    // MS-06 legacy host/port authority in sources
    // MS-09 imports outside the Module
    // MS-11 absolute machine paths
    for (const file of appSources) {
      const text = await readText(join(root, ...file.path.split("/")));
      if (text === null) continue;
      for (const finding of legacyRuntimeReads(text)) {
        record("MS-06", "fail", `${file.path}: čte ${finding}`);
      }
      for (const port of leasePorts) {
        if (new RegExp(`(?<![0-9.])${port}(?![0-9]|\\.[0-9])`).test(text)) {
          record("MS-06", "fail", `${file.path}: port leasu ${port} je zapsaný natvrdo`);
        }
      }
      for (const specifier of importSpecifiers(text)) {
        const issue = importBoundaryIssue({ specifier, filePath: file.path });
        if (issue) record("MS-09", "fail", `${file.path}: ${issue}`);
      }
      for (const path of absoluteMachinePaths(text)) {
        record("MS-11", "fail", `${file.path}: absolutní cesta ${path}`);
      }
      if (/(?:\bfrom\s*|\bimport\s*|\brequire\(\s*|\bimport\(\s*)["']dotenv(?:\/[^"']*)?["']/.test(text)) {
        record("MS-07", "fail", `${file.path}: importuje dotenv`);
      }
    }

    // MS-07 Bun loads .env, .env.local and .env.<NODE_ENV> by itself unless
    // started with --no-env-file (HumanAndMachines/Lazurio#471); every Bun
    // invocation on the start path carries the flag.
    const startPath = nonEmptyString(scripts[devScriptName]) ? scriptChain(scripts, devScriptName) : [];
    for (const command of startPath) {
      if (/(?:^|[\s(])bun(?=\s|$)/.test(command) && !/(?:^|\s)--no-env-file(?=\s|$)/.test(command)) {
        record("MS-07", "fail", `${label}: ${devScriptName} spouští Bun bez --no-env-file: ${command}`);
      }
    }

    // MS-07 .env files and dotenv dependency
    for (const file of appFiles) {
      const name = posix.basename(file.path);
      if (name.startsWith(".env") && name !== ".env.example") {
        record("MS-07", "fail", `${file.path}: soubor ${name} na start cestě`);
      }
    }
    for (const [dependency] of dependencyEntries(packageJson)) {
      if (dependency === "dotenv" || dependency.startsWith("dotenv-")) {
        record("MS-07", "fail", `${label}: závislost ${dependency}`);
      }
    }

    // MS-08 TypeScript strict, no JavaScript sources
    if (preparationRuntime === "uv") {
      record("MS-08", "warn", `${label}: Python App (ruff/pyright strict) zatím Lazurio nekontroluje`);
    } else {
      const tsconfig = await tsconfigStrictness({
        root,
        appDirectory: app.appDirectory,
      });
      if (tsconfig.status !== "pass") record("MS-08", tsconfig.status, `${label}: ${tsconfig.detail}`);
      for (const file of appFiles) {
        if (!JAVASCRIPT_EXTENSIONS.has(file.extension) || file.public) continue;
        record("MS-08", "fail", `${file.path}: JavaScript zdroj`);
      }
    }

    // MS-09 file:/link: dependencies outside the Module
    for (const [dependency, specification] of dependencyEntries(packageJson)) {
      const match = /^(?:file|link):(.+)$/.exec(String(specification));
      if (!match) continue;
      const target = posix.normalize(joinPosix(app.appDirectory, match[1]));
      if (isAbsolute(match[1]) || escapesRoot(target)) {
        record("MS-09", "fail", `${label}: závislost ${dependency} ukazuje mimo repo (${specification})`);
      }
    }

    // MS-10 pinned Lazurio dependencies
    for (const [dependency, specification] of dependencyEntries(packageJson)) {
      if (!/repository-db|module-kit/.test(`${dependency} ${specification}`)) continue;
      if (/^(?:workspace|file|link):/.test(String(specification))) continue;
      if (!PINNED_DEPENDENCY.test(String(specification))) {
        record("MS-10", "fail", `${label}: ${dependency}@${String(specification)} není github:Lazurio/<repo>#v<semver>`);
      }
    }

    // MS-11 start-path scripts: machine paths and symlink creation
    const startCommands = nonEmptyString(scripts[devScriptName]) ? scriptChain(scripts, devScriptName) : [];
    for (const command of startCommands) {
      for (const path of absoluteMachinePaths(command)) record("MS-11", "fail", `${label}: ${devScriptName} obsahuje ${path}`);
      if (/\bln\s+-[a-zA-Z]*s/.test(command)) record("MS-11", "fail", `${label}: ${devScriptName} vytváří symlink: ${command}`);
      for (const entry of commandEntryFiles(command)) {
        const entryPath = posix.normalize(joinPosix(app.appDirectory, entry));
        if (escapesRoot(entryPath)) continue;
        const text = await readText(join(root, ...entryPath.split("/")));
        if (text !== null && /\bsymlink(?:Sync)?\s*\(/.test(text)) {
          record("MS-11", "fail", `${entryPath}: start entrypoint vytváří symlink`);
        }
      }
    }

    // MS-13 check and test scripts
    for (const scriptName of ["check", "test"]) {
      if (!nonEmptyString(scripts[scriptName])) record("MS-13", "fail", `${label}: skript ${scriptName} chybí`);
    }

    if (nextPackage && JSON.stringify(nextPackage) !== JSON.stringify(packageJson)) {
      repairedPackages.set(app.appPath, nextPackage);
    }
  }
  if (apps.length === 0) {
    for (const id of ["MS-02", "MS-03", "MS-04", "MS-05", "MS-06", "MS-07", "MS-08", "MS-09", "MS-10", "MS-13"]) {
      results.get(id).details.push("Modul nemá App");
    }
  }

  // MS-09 symlinks whose target lies outside the Module repository: an
  // import through them resolves inside the repo textually but reads foreign
  // code. A tracked symlink is the repo's own boundary breach (fail); an
  // untracked one is a workstation artifact worth a warning.
  if (symlinks.length > 0) {
    const realRoot = await realpath(root).catch(() => resolve(root));
    const tracked = await gitTrackedPaths(root, symlinks.map((link) => link.path));
    for (const link of symlinks) {
      const target = await realpath(join(root, ...link.path.split("/"))).catch(() => null);
      const inside = target === null ? null : relativePath(realRoot, target).split(sep).join("/");
      if (inside !== null && !escapesRoot(inside)) continue;
      const status = tracked === null || tracked.has(link.path) ? "fail" : "warn";
      record("MS-09", status, target === null
        ? `${link.path}: symlink míří na neexistující cíl mimo repo (${link.target})`
        : `${link.path}: symlink vede mimo repo Modulu (${link.target})`);
    }
  }


  // MS-01 port leases, pool, disjointness
  const leases = Array.isArray(manifest?.port_leases) ? manifest.port_leases : [];
  const pool = organization?.module_port_pool ?? null;
  if (leases.length > 0) {
    if (!pool) {
      record("MS-01", "warn", `${organization?.slug ?? "Organizace"} nemá module_port_pool; lease nelze posoudit`);
    } else if (modules === null) {
      record("MS-01", "warn", "manifesty ostatních Modulů nejdou přečíst; kolize a volný port nelze posoudit");
    } else {
      const candidate = {
        company: manifest.company,
        id: manifest.id,
        port_leases: leases,
      };
      const others = modules.filter((module) => module.company !== candidate.company || module.id !== candidate.id);
      const findings = findModuleStandardPortFindings({
        modules: [...others, candidate],
        organizations: organizations.some((item) => item.slug === organization.slug)
          ? organizations
          : [...organizations, organization],
      });
      for (const overlap of findings.pool_overlaps) {
        const pair = overlap.organizations ?? [];
        if (!pair.some((item) => item.company === organization.slug)) continue;
        const other = pair.find((item) => item.company !== organization.slug);
        record("MS-01", "fail", `pool ${pool.start}-${pool.end} se překrývá s ${other?.company ?? "jinou Organizací"} na ${overlap.start}-${overlap.end}`);
      }
      for (const collision of findings.cross_organization_lease_collisions) {
        if (!collision.owners.some((owner) => owner.company === candidate.company && owner.module === candidate.id)) continue;
        const foreign = collision.owners.filter((owner) => owner.company !== candidate.company);
        record("MS-01", "fail", `port ${collision.port} drží i ${foreign.map((owner) => `${owner.company}/${owner.module}`).join(", ")}`);
      }
      const outside = findings.leases_outside_pool.filter((item) => item.company === candidate.company && item.module === candidate.id);
      if (outside.length > 0) {
        const used = new Set([...others, candidate].flatMap((module) => (module.port_leases ?? []).map((lease) => lease.port)));
        // The checker reports and suggests; it never moves a lease. The port
        // lives only in the lease, so the move is one manifest edit in the
        // Module PR, proved by starting the App on the new port.
        for (const item of outside) {
          let port = pool.start;
          while (port <= pool.end && used.has(port)) port += 1;
          if (port > pool.end) {
            record("MS-01", "fail", `lease ${item.lease} ${item.port} leží mimo pool ${pool.start}-${pool.end}; pool je vyčerpaný`);
            continue;
          }
          used.add(port);
          record("MS-01", "fail", `lease ${item.lease} ${item.port} leží mimo pool ${pool.start}-${pool.end}; volný port poolu: ${port}`);
        }
      }
    }
  }
  if (results.get("MS-01").status === "pass") {
    results.get("MS-01").details.push(
      leases.length === 0
        ? `id ${manifest?.id} odpovídá slotu; Modul nemá port lease`
        : `id ${manifest?.id} odpovídá slotu; ${leases.map((lease) => `${lease.id} ${lease.port}`).join(", ")} v poolu ${pool.start}-${pool.end}`,
    );
  }

  // MS-11 layout
  if (typeof slotPath === "string" && /^modules\//.test(slotPath)) {
    record("MS-11", "fail", `slot ${slotPath} používá zrušený layout modules/; Modul patří do workspace/`);
  }

  // MS-12 apps[] vs directories and generations
  const declared = new Set(apps.map(({ appPath }) => appPath));
  const appPackages = files
    .filter((file) => /^app\/[^/]+\/package\.json$/.test(file.path))
    .map((file) => file.path)
    .sort();
  for (const path of appPackages) {
    if (!declared.has(path)) record("MS-12", "fail", `${path} není deklarovaný v apps[]`);
  }
  const generations = [...new Set(appPackages
    .map((path) => /^app\/v(\d+)\/package\.json$/.exec(path)?.[1])
    .filter(Boolean)
    .map(Number))].sort((left, right) => left - right);
  if (generations.length > 2) {
    record("MS-12", "fail", `Modul drží ${generations.length} generace App (${generations.map((value) => `v${value}`).join(", ")}); povolené jsou dvě: výchozí a jedna předchozí nebo kandidátní`);
  }
  // The second generation may be the previous one (kept for rollback) or the
  // next candidate that is not the default yet (migration window); the
  // default only has to be one of the declared generations.
  const defaultGeneration = Number(/^app\/v(\d+)\/package\.json$/.exec(manifest?.default_app ?? "")?.[1] ?? Number.NaN);
  if (generations.length > 0 && Number.isInteger(defaultGeneration) && !generations.includes(defaultGeneration)) {
    record("MS-12", "fail", `výchozí App v${defaultGeneration} není mezi generacemi ${generations.map((value) => `v${value}`).join(", ")}`);
  }

  const checks = MODULE_STANDARD_CHECKS.map(({ id, summary }) => {
    const result = results.get(id);
    return {
      id,
      status: result.status,
      summary,
      details: [...new Set(result.details)],
      ...(result.status === "pass" ? {} : { action: CHECK_ACTIONS[id] }),
      ...(result.repairs.length > 0 ? { repairs: result.repairs } : {}),
    };
  });
  return { checks, repairedPackages };
}

export function moduleStandardIssues(checks) {
  return (checks ?? [])
    .filter((check) => check.status !== "pass")
    .map((check) => ({
      code: check.id,
      message: `${check.id} ${check.status}: ${check.summary}${check.details.length > 0 ? ` — ${check.details.slice(0, 5).join("; ")}${check.details.length > 5 ? ` (+${check.details.length - 5})` : ""}` : ""}`,
      action: check.action ?? CHECK_ACTIONS[check.id],
    }));
}

export function devScriptFindings(command) {
  const source = String(command ?? "");
  const unquoted = source.replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, "\"\"");
  const findings = [];
  if (/&&/.test(unquoted)) findings.push("&&");
  if (/\|\|/.test(unquoted)) findings.push("||");
  if (/(^|[^|])\|([^|]|$)/.test(unquoted)) findings.push("|");
  if (/;/.test(unquoted)) findings.push(";");
  if (/(^|[^&])&([^&]|$)/.test(unquoted)) findings.push("& (proces na pozadí)");
  if (/(?:^|\s)[A-Za-z_][A-Za-z0-9_]*=/.test(unquoted)) findings.push("inline VAR=");
  const words = [
    ["concurrently", /\bconcurrently\b/],
    ["npm-run-all", /\bnpm-run-all\b|\brun-p\b|\brun-s\b/],
    ["build", /(?<![-\w])build\b/],
    ["npx", /\bnpx\b/],
    ["node", /(?:^|[\s;&|(])node\s/],
    ["bunx", /\bbunx\b/],
    ["bun x", /\bbun\s+x\b/],
    ["nvm", /\bnvm\b/],
  ];
  for (const [label, pattern] of words) if (pattern.test(unquoted)) findings.push(label);
  return findings;
}

export function legacyRuntimeReads(text) {
  const findings = [];
  const patterns = [
    ["LAZURIO_RUNTIME_HOST", /\bLAZURIO_RUNTIME_HOST\b/],
    ["LAZURIO_RUNTIME_PORT", /\bLAZURIO_RUNTIME_PORT\b/],
    ["process.env.PORT", /process\.env(?:\.PORT\b|\[\s*["']PORT["']\s*\])/],
    ["Bun.env.PORT", /Bun\.env(?:\.PORT\b|\[\s*["']PORT["']\s*\])/],
    ["import.meta.env.PORT", /import\.meta\.env\.PORT\b/],
    ["COMPANYASCODE_*", /\bCOMPANYASCODE_[A-Z0-9_]+/],
    ["lazurio.module.json (lease soubor)", /lazurio\.module\.json/],
  ];
  for (const [label, pattern] of patterns) if (pattern.test(text)) findings.push(label);
  return findings;
}

function importSpecifiers(text) {
  const specifiers = new Set();
  const patterns = [
    /\b(?:import|export)\s[^'"`;]*?\bfrom\s*["']([^"']+)["']/g,
    /\bimport\s*["']([^"']+)["']/g,
    /\bimport\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns) for (const match of text.matchAll(pattern)) specifiers.add(match[1]);
  return [...specifiers];
}

function importBoundaryIssue({ specifier, filePath }) {
  if (specifier.startsWith("/")) return `import ${specifier} je absolutní cesta`;
  if (!specifier.startsWith(".")) return null;
  const target = posix.normalize(joinPosix(posix.dirname(filePath), specifier));
  if (!escapesRoot(target)) return null;
  const shared = /\/(launchpad|infra|design-system)\//.exec(`${specifier}/`)?.[1];
  return shared
    ? `import ${specifier} míří mimo repo Modulu do ${shared}/`
    : `import ${specifier} míří mimo repo Modulu`;
}

function absoluteMachinePaths(text) {
  const paths = new Set();
  for (const match of String(text).matchAll(/(?<![\w.:/-])\/(?:Users|home)\/[A-Za-z0-9._-]+\/[^\s"'`)]*/g)) {
    paths.add(match[0]);
  }
  return [...paths];
}

function commandEntryFiles(command) {
  const entries = new Set();
  for (const match of String(command).matchAll(/(?:^|\s)["']?((?:\.{0,2}\/)?[A-Za-z0-9_@./-]+\.(?:ts|tsx|mts|cts|js|mjs|cjs))["']?(?=\s|$)/g)) {
    if (match[1].includes("node_modules/")) continue;
    entries.add(match[1]);
  }
  return [...entries];
}

function scriptChain(scripts, entrypoint) {
  const commands = [];
  const visited = new Set();
  const visit = (name) => {
    if (visited.has(name) || typeof scripts?.[name] !== "string") return;
    visited.add(name);
    const command = scripts[name];
    commands.push(command);
    for (const match of command.matchAll(/\b(?:bun|npm|pnpm|yarn)(?:\s+--[a-z][a-z-]*)*\s+(?:run\s+)?([A-Za-z0-9:_-]+)\b/g)) {
      if (match[1] !== name && typeof scripts[match[1]] === "string") visit(match[1]);
    }
  };
  visit(entrypoint);
  return commands;
}

function dependencyEntries(packageJson) {
  const entries = [];
  for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
    const value = packageJson?.[field];
    if (!value || typeof value !== "object") continue;
    for (const [name, specification] of Object.entries(value)) entries.push([name, specification]);
  }
  return entries;
}

function checkLockTracked({ record, label, lockPath, files, tracked, name }) {
  if (!files.some((file) => file.path === lockPath)) {
    record("MS-02", "fail", `${label}: ${name} chybí vedle package.json (${lockPath})`);
    return false;
  }
  if (tracked === null) {
    record("MS-02", "warn", `${label}: Modul není Git checkout; commit ${lockPath} nelze ověřit`);
  } else if (!tracked.has(lockPath)) {
    record("MS-02", "fail", `${label}: ${lockPath} není commitnutý`);
  }
  return true;
}

async function bunLockDrift(path, packageJson) {
  const text = await readText(path);
  if (text === null) return null;
  let lock;
  try {
    lock = JSON.parse(stripJsonc(text));
  } catch {
    return null;
  }
  const workspace = lock?.workspaces?.[""];
  if (!workspace || typeof workspace !== "object") return ["chybí kořenový workspace"];
  const drift = [];
  for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
    const declared = packageJson?.[field] ?? {};
    const locked = workspace[field] ?? {};
    for (const [name, specification] of Object.entries(declared)) {
      if (locked[name] === undefined) drift.push(`${field}.${name} chybí v lockfilu`);
      else if (locked[name] !== specification) drift.push(`${field}.${name} ${specification} ≠ ${locked[name]}`);
    }
    for (const name of Object.keys(locked)) {
      if (declared[name] === undefined) drift.push(`${field}.${name} je jen v lockfilu`);
    }
  }
  return drift;
}

async function tsconfigStrictness({ root, appDirectory }) {
  const path = joinPosix(appDirectory, "tsconfig.json");
  const resolved = await resolveTsconfig({ root, path, appDirectory, depth: 0 });
  if (resolved.missing) return { status: "fail", detail: `${path} chybí` };
  if (resolved.unreadable) return { status: "fail", detail: `${resolved.unreadable} nejde přečíst` };
  if (resolved.allowJs === true) return { status: "fail", detail: `${path} povoluje allowJs` };
  if (resolved.strict === true) return { status: "pass" };
  if (resolved.strict === false) return { status: "fail", detail: `${path} nemá strict: true` };
  if (resolved.unresolvedPreset) {
    return { status: "warn", detail: `${path} rozšiřuje ${resolved.unresolvedPreset}; bez nainstalovaných závislostí nelze strict ověřit` };
  }
  return { status: "fail", detail: `${path} nemá strict: true ani strict preset` };
}

async function resolveTsconfig({ root, path, appDirectory, depth }) {
  const text = await readText(join(root, ...path.split("/")));
  if (text === null) return depth === 0 ? { missing: true } : { unreadable: path };
  let config;
  try {
    config = JSON.parse(stripJsonc(text));
  } catch {
    return { unreadable: path };
  }
  const own = {
    strict: typeof config?.compilerOptions?.strict === "boolean" ? config.compilerOptions.strict : undefined,
    allowJs: typeof config?.compilerOptions?.allowJs === "boolean" ? config.compilerOptions.allowJs : undefined,
  };
  let inherited = {};
  const parents = Array.isArray(config?.extends) ? config.extends : config?.extends ? [config.extends] : [];
  for (const parent of parents) {
    if (typeof parent !== "string" || depth >= 4) continue;
    let next;
    if (KNOWN_STRICT_TSCONFIG_PRESETS.some((pattern) => pattern.test(parent))) {
      next = { strict: true };
    } else if (parent.startsWith(".")) {
      const target = posix.normalize(joinPosix(posix.dirname(path), parent.endsWith(".json") ? parent : `${parent}.json`));
      next = escapesRoot(target)
        ? { unreadable: `${path} extends ${parent} mimo repo` }
        : await resolveTsconfig({ root, path: target, appDirectory, depth: depth + 1 });
    } else {
      const candidates = parent.endsWith(".json")
        ? [joinPosix(appDirectory, `node_modules/${parent}`)]
        : [joinPosix(appDirectory, `node_modules/${parent}.json`), joinPosix(appDirectory, `node_modules/${parent}/tsconfig.json`)];
      next = null;
      for (const candidate of candidates) {
        if (await readText(join(root, ...candidate.split("/"))) === null) continue;
        next = await resolveTsconfig({ root, path: candidate, appDirectory, depth: depth + 1 });
        break;
      }
      next ??= { unresolvedPreset: parent };
    }
    if (next.unreadable) return next;
    inherited = {
      strict: next.strict ?? inherited.strict,
      allowJs: next.allowJs ?? inherited.allowJs,
      unresolvedPreset: next.unresolvedPreset ?? inherited.unresolvedPreset,
    };
  }
  return {
    strict: own.strict ?? inherited.strict,
    allowJs: own.allowJs ?? inherited.allowJs,
    unresolvedPreset: own.strict === undefined ? inherited.unresolvedPreset : undefined,
  };
}

async function gitTrackedPaths(root, paths) {
  const marker = await lstat(join(root, ".git")).catch(() => null);
  if (!marker || marker.isSymbolicLink()) return null;
  if (paths.length === 0) return new Set();
  const result = await runGit(["ls-files", "-z", "--", ...paths], { cwd: root, timeoutMs: GIT_LOCAL_TIMEOUT_MS });
  if (!result.ok) return null;
  return new Set(result.stdout.split("\0").map((item) => item.trim()).filter(Boolean));
}

async function walkModuleFiles(root) {
  const files = [];
  const symlinks = [];
  async function walk(directory, relativeDirectory, flags) {
    if (files.length >= MAX_WALKED_FILES) return;
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    if (relativeDirectory !== "" && entries.some((entry) => entry.name === ".git")) return;
    for (const entry of entries) {
      if (files.length >= MAX_WALKED_FILES) return;
      const relativePath = relativeDirectory === "" ? entry.name : `${relativeDirectory}/${entry.name}`;
      if (entry.isSymbolicLink()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name)) {
          const target = await readlink(join(directory, entry.name)).catch(() => "?");
          symlinks.push({ path: relativePath, target });
        }
        continue;
      }
      if (entry.isDirectory()) {
        if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
        await walk(join(directory, entry.name), relativePath, {
          test: flags.test || TEST_DIRECTORIES.has(entry.name),
          public: flags.public || entry.name === "public",
        });
      } else if (entry.isFile()) {
        files.push({
          path: relativePath,
          extension: extname(entry.name).toLowerCase(),
          test: flags.test || /\.(?:test|spec)\.[A-Za-z]+$/.test(entry.name),
          public: flags.public,
        });
      }
    }
  }
  await walk(root, "", { test: false, public: false });
  return { files, symlinks };
}

function filesBelow(files, directory) {
  if (directory === "") return files;
  const prefix = `${directory}/`;
  return files.filter((file) => file.path.startsWith(prefix));
}

async function readText(path) {
  try {
    const entry = await lstat(path);
    if (!entry.isFile() || entry.size > MAX_READ_BYTES) return null;
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

async function readJsonOrNull(path) {
  const text = await readText(path);
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// Schema findings for one declaration. Script names get the dedicated
// Platform-grammar and npm-lifecycle details instead of the generic schema
// wording; both rules are read from the schema, which mirrors the
// LazurioPlatform reader.
async function preparationDeclarationIssues(preparation, label) {
  const schema = await preparationSchema();
  const scriptKeys = ["check_script", "prepare_script"];
  const namedScripts = scriptKeys.filter((key) => typeof preparation?.[key] === "string");
  const issues = validateAgainstSchema(preparation, schema, `${label}: lazurio.preparation`)
    .filter((issue) => !namedScripts.some((key) => issue.startsWith(`${label}: lazurio.preparation.${key}:`)));
  for (const key of namedScripts) {
    const scriptName = preparation[key];
    const rule = schema.properties[key];
    if (!new RegExp(rule.pattern).test(scriptName)) {
      issues.push(`${label}: ${scriptName}: jméno skriptu neodpovídá gramatice čtečky Platformy ${rule.pattern}`);
    } else if (rule.not?.enum?.includes(scriptName)) {
      issues.push(`${label}: ${scriptName} je npm lifecycle jméno — bun install ho spouští sám; použij prepare:app / check:prepared`);
    }
  }
  return issues;
}

async function preparationSchema() {
  preparationSchemaPromise ??= Bun.file(join(import.meta.dirname, "schemas", "lazurio-preparation.schema.json")).json();
  return preparationSchemaPromise;
}

// JSONC (tsconfig, bun.lock): strip comments and trailing commas outside strings.
export function stripJsonc(text) {
  let output = "";
  let inString = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    const next = text[index + 1];
    if (inString) {
      output += character;
      if (character === "\\") {
        output += next ?? "";
        index += 1;
      } else if (character === "\"") {
        inString = false;
      }
      continue;
    }
    if (character === "\"") {
      inString = true;
      output += character;
    } else if (character === "/" && next === "/") {
      while (index < text.length && text[index] !== "\n") index += 1;
      output += "\n";
    } else if (character === "/" && next === "*") {
      index += 2;
      while (index < text.length && !(text[index] === "*" && text[index + 1] === "/")) index += 1;
      index += 1;
    } else if (character === ",") {
      let lookahead = index + 1;
      while (lookahead < text.length && /\s/.test(text[lookahead])) lookahead += 1;
      if (text[lookahead] !== "}" && text[lookahead] !== "]") output += character;
    } else {
      output += character;
    }
  }
  return output;
}

function insertKeyAfter(object, key, value, afterKeys) {
  const entries = Object.entries(object);
  const anchorIndex = Math.max(-1, ...afterKeys.map((candidate) => entries.findIndex(([name]) => name === candidate)));
  entries.splice(anchorIndex + 1, 0, [key, value]);
  for (const name of Object.keys(object)) delete object[name];
  for (const [name, entryValue] of entries) object[name] = entryValue;
}

function joinPosix(directory, path) {
  return directory === "" ? posix.normalize(path) : posix.join(directory, path);
}

function escapesRoot(path) {
  const normalized = posix.normalize(path);
  return normalized === ".." || normalized.startsWith("../") || posix.isAbsolute(normalized);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "";
}
