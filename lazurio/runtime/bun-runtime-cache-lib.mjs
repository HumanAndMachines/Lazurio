import { execFile } from "node:child_process";
import { lstat, readdir, readFile, readlink, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { normalizePackageRuntime } from "../core/runtime-contract-lib.mjs";
import {
  compareStableVersions,
  readRequiredBunVersion,
  readToolchainManifest,
} from "../core/toolchain-lib.mjs";
import {
  BunRuntimeRefused,
  bunRuntimeRefusalMessage,
  createModuleBunResolver,
  exactBunPin,
  moduleBunCacheBytes,
  moduleBunRoot,
  moduleBunUsed,
} from "./bun-runtime-lib.mjs";
import { APP_CHECKOUT_ROOT, APP_FILESYSTEM_ROOT, discoverLaunchpadApps } from "./discovery-lib.mjs";

const execute = promisify(execFile);

// What `lazurio update` does with the Bun runtime cache on a computer (decision
// 0171, addendum of 2026-10-24, point 5; plan DEV-6682 M2b-2b, #640). It runs
// after the checkouts are synced and before their packages and builds
// (decision 0212: Lazurio → content → tools → builds):
//
//   1. the inventory: the exact Bun versions root can see pinned after the
//      sync. They are the CLI's own (`lazurio/package.json#packageManager`),
//      `tools.bun.default` of `lazurio/toolchain.json` and every App's: the
//      mounted Organizations' through discovery, and their worktrees' through
//      an enumeration of its own, since discovery skips `.worktrees` on
//      purpose. What root cannot read makes the inventory incomplete, never
//      smaller;
//   2. the pre-warm: the resolver, one version at a time, so that the next
//      start finds its Bun ready. A pin of the user's Bun needs nothing. The
//      first registry that does not answer ends it for this run;
//   3. the prune report: for every version in the cache, whether a prune
//      would remove it, or every reason why it stays. It only reads: it never
//      removes, renames or changes anything. Deletion comes in a release of
//      its own, behind the gates of #640.
//
// None of it ever fails the update: what goes wrong is reported in the
// update's `tools` section.

/** A marker this recent keeps its version: a use within the last 14 days by
 * the local clock, or one in the future. */
export const bunRecentUseMs = 14 * 24 * 60 * 60 * 1000;
/** The bound of the worktree enumeration, in directory entries; beyond it the
 * inventory is incomplete. */
export const worktreeEntryBudget = 100_000;
const lsofTimeoutMs = 10_000;
const issueLimit = 10;
const exactVersion = /^\d+\.\d+\.\d+$/;
// Where discovery never looks for Apps, and so neither does the enumeration of
// the worktrees, besides every name that starts with a dot.
const skippedDirectories = new Set(["node_modules", "dist", "build", "coverage", "productionspace"]);

const messageOf = (error) => (error instanceof Error ? error.message : String(error));
const codeOf = (error) => (typeof error?.code === "string" ? error.code : messageOf(error));
const rootRelative = (rootPath, path) => relative(rootPath, path).split(sep).join("/") || ".";
function within(parent, child) {
  const path = relative(parent, child);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

async function readPackage(path) {
  try {
    return { ok: true, packageJson: JSON.parse(await readFile(path, "utf8")) };
  } catch (error) {
    return { ok: false, detail: error instanceof SyntaxError ? "not valid JSON" : codeOf(error) };
  }
}

const pinnedVersion = (packageJson) => exactBunPin(packageJson?.packageManager)?.slice("bun@".length) ?? null;

/**
 * The exact Bun versions root sees pinned in `rootPath` (point 1 above):
 * `{ pins, complete, issues }`. Each pin is `{ version, cli_pin, default,
 * apps, owner, file }`: whether it is the CLI's and the default, how many Apps
 * pin it, main and worktrees together, and one package that pins it (its
 * directory, and its path in the root for the words of a refusal). The CLI's
 * pin comes first, then the default, then the rest by version. `complete` is
 * false, with its `issues`, when anything root should read could not be read.
 */
export async function bunPinInventory({
  rootPath,
  discoverApps = discoverLaunchpadApps,
  entryBudget = worktreeEntryBudget,
}) {
  const pins = new Map();
  const issues = [];
  const add = (version, { owner, file, cli = false, isDefault = false, app = false }) => {
    const pin = pins.get(version) ?? { version, cli_pin: false, default: false, apps: 0, owner, file };
    if (cli) pin.cli_pin = true;
    if (isDefault) pin.default = true;
    if (app) pin.apps += 1;
    pins.set(version, pin);
  };
  const lazurio = join(rootPath, "lazurio");
  try {
    add(readRequiredBunVersion({ root: lazurio }), { owner: lazurio, file: "lazurio/package.json", cli: true });
  } catch (error) {
    issues.push(`cli_pin: ${messageOf(error)}`);
  }
  try {
    add(readToolchainManifest({ root: lazurio }).tools.bun.default, {
      owner: lazurio,
      file: "lazurio/toolchain.json",
      isDefault: true,
    });
  } catch (error) {
    issues.push(`default: ${messageOf(error)}`);
  }

  let discovery = null;
  try {
    discovery = await discoverApps(rootPath);
  } catch (error) {
    issues.push(`discovery: ${messageOf(error)}`);
  }
  if (discovery) {
    // A failure, or an Organization or Module discovery did not walk, may
    // leave Apps out.
    for (const failure of discovery.failures ?? []) issues.push(`discovery: ${failure}`);
    for (const issue of discovery.organization_issues ?? []) issues.push(`discovery: ${issue?.message ?? issue?.code}`);
    const apps = [...(discovery.apps ?? []), ...(discovery.invalid_apps ?? [])];
    const seen = new Set();
    for (const app of apps) {
      if (typeof app?.package_path !== "string" || app.package_path === "") continue;
      const path = resolve(app[APP_FILESYSTEM_ROOT] ?? rootPath, app.package_path);
      if (seen.has(path)) continue;
      seen.add(path);
      const read = await readPackage(path);
      const file = rootRelative(rootPath, path);
      if (!read.ok) {
        issues.push(`package: ${file}: ${read.detail}`);
        continue;
      }
      const version = pinnedVersion(read.packageJson);
      if (version !== null) add(version, { owner: dirname(path), file, app: true });
    }

    // The worktrees of every mounted Organization and of every checkout in it
    // that holds an App, as `<checkout>/.worktrees` lays them out.
    const organizations = [];
    for (const organization of discovery.organizations ?? []) {
      if (typeof organization?.path !== "string" || organization.path === "" || organization.status === "planned") continue;
      const lexical = resolve(rootPath, organization.path);
      organizations.push({ lexical, real: await realpath(lexical).catch(() => lexical) });
    }
    const starts = organizations.map(({ lexical }) => join(lexical, ".worktrees"));
    for (const app of apps) {
      const checkout = app?.[APP_CHECKOUT_ROOT];
      if (typeof checkout === "string"
        && organizations.some(({ lexical, real }) => within(lexical, checkout) || within(real, checkout))) {
        starts.push(join(checkout, ".worktrees"));
      }
    }
    // One walk per directory, however its path is spelled.
    const walked = new Set();
    const budget = { total: entryBudget, left: entryBudget, exceeded: false };
    for (const start of [...new Set(starts)].sort()) {
      const identity = await realpath(start).catch(() => start);
      if (walked.has(identity)) continue;
      walked.add(identity);
      for (const path of await worktreePackages(start, { rootPath, budget, issues })) {
        const read = await readPackage(path);
        const file = rootRelative(rootPath, path);
        if (!read.ok) {
          issues.push(`worktrees: ${file}: ${read.detail}`);
          continue;
        }
        // Only an App's package counts, as discovery tells one.
        if (normalizePackageRuntime({ packageJson: read.packageJson, packagePath: file }) === null) continue;
        const version = pinnedVersion(read.packageJson);
        if (version !== null) add(version, { owner: dirname(path), file, app: true });
      }
      if (budget.exceeded) break;
    }
  }

  const rank = (pin) => (pin.cli_pin ? 0 : pin.default ? 1 : 2);
  const distinct = [...new Set(issues)];
  return {
    pins: [...pins.values()].sort((left, right) =>
      rank(left) - rank(right) || compareStableVersions(left.version, right.version)),
    complete: distinct.length === 0,
    issues: distinct.length > issueLimit
      ? [...distinct.slice(0, issueLimit), `and ${distinct.length - issueLimit} more`]
      : distinct,
  };
}

// Every package.json below a `.worktrees` directory where discovery would look
// for Apps, links never followed. A `.worktrees` that is not a directory, a
// directory that cannot be read and a walk beyond its bound are issues.
async function worktreePackages(start, { rootPath, budget, issues }) {
  const found = [];
  let entry;
  try {
    entry = await lstat(start);
  } catch (error) {
    if (error?.code !== "ENOENT") issues.push(`worktrees: ${rootRelative(rootPath, start)}: ${codeOf(error)}`);
    return found;
  }
  if (!entry.isDirectory()) {
    issues.push(`worktrees: ${rootRelative(rootPath, start)}: not a directory`);
    return found;
  }
  const pending = [start];
  while (pending.length > 0) {
    const directory = pending.pop();
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      issues.push(`worktrees: ${rootRelative(rootPath, directory)}: ${codeOf(error)}`);
      continue;
    }
    for (const item of entries) {
      budget.left -= 1;
      if (budget.left < 0) {
        budget.exceeded = true;
        issues.push(`worktrees: more than ${budget.total} entries`);
        return found;
      }
      if (item.isDirectory()) {
        if (!item.name.startsWith(".") && !skippedDirectories.has(item.name)) pending.push(join(directory, item.name));
      } else if (item.isFile() && item.name === "package.json") {
        found.push(join(directory, item.name));
      }
    }
  }
  return found;
}

/**
 * The pre-warm (point 2 above): `resolve` (the Apps' resolver) asked for each
 * pin in turn. Answers each pin as `{ version, cli_pin, default, apps, state }`
 * with `state` `user` (the user's Bun is that version), `cached`, `fetched`,
 * `refused` with the refusal's `reason`, `not_fetched` (`reason: "offline"`)
 * after the first `runtime-unavailable`, or `failed` (`reason: "error"`, with
 * its `detail`) for an error that is no refusal. An integrity failure is also
 * a warning: it signals a broken or tampered download.
 */
export async function prewarmBunRuntimes({ pins, resolve: resolveBun, warnings = [] }) {
  const states = [];
  let offline = false;
  for (const pin of pins) {
    const entry = { version: pin.version, cli_pin: pin.cli_pin, default: pin.default, apps: pin.apps };
    if (offline) {
      states.push({ ...entry, state: "not_fetched", reason: "offline" });
      continue;
    }
    try {
      const bun = await resolveBun({ packageManager: `bun@${pin.version}`, owner: pin.owner });
      states.push({ ...entry, state: bun.source === "user" ? "user" : bun.source === "fetched" ? "fetched" : "cached" });
    } catch (error) {
      if (!(error instanceof BunRuntimeRefused)) {
        states.push({ ...entry, state: "failed", reason: "error", detail: messageOf(error) });
        continue;
      }
      states.push({ ...entry, state: "refused", reason: error.reason });
      if (error.reason === "runtime-unavailable") offline = true;
      if (error.reason === "runtime-integrity-failed") {
        warnings.push(bunRuntimeRefusalMessage(error.reason, { file: pin.file, version: pin.version }));
      }
    }
  }
  return states;
}

async function markerTime(path) {
  const entry = await lstat(path).catch(() => null);
  return entry?.isFile() ? entry.mtimeMs : null;
}

/**
 * The prune report (point 3 above) of the runtime cache `cacheRoot`, with the
 * use markers in `usedRoot`, against an `inventory` of `bunPinInventory`. A
 * candidate is a real directory (`lstat`, links never followed) directly under
 * the cache root named by an exact version; nothing else is looked into. For
 * each, every reason that keeps it, in this order: `cli_pin`, `default`,
 * `pinned_by_apps: N`, `used_recently: <ISO time>` (a marker within
 * `bunRecentUseMs`), `held_by_process`, then what root cannot know:
 * `unknown: no_marker_history`, `unknown: inventory_incomplete`,
 * `unknown: process_check_failed` and `unknown: no_process_check`. It
 * `would_remove` only when no reason applies, and is `kept` otherwise. The
 * report only reads.
 */
export async function bunCachePruneReport({ cacheRoot, usedRoot, inventory, now = new Date(), processCheck }) {
  const report = { mode: "report_only", cache_root: cacheRoot, state: "ready", versions: [], would_free_bytes: 0 };
  let root;
  try {
    root = await lstat(cacheRoot);
  } catch (error) {
    return { ...report, state: error?.code === "ENOENT" ? "absent" : "unreadable" };
  }
  // A linked cache root is not read through, as a prune would never delete
  // through it.
  if (root.isSymbolicLink()) return { ...report, state: "linked" };
  if (!root.isDirectory()) return { ...report, state: "not_a_directory" };
  let names;
  try {
    names = await readdir(cacheRoot);
  } catch {
    return { ...report, state: "unreadable" };
  }
  const real = await realpath(cacheRoot).catch(() => cacheRoot);
  const candidates = [];
  for (const name of names) {
    if (!exactVersion.test(name)) continue;
    const entry = await lstat(join(cacheRoot, name)).catch(() => null);
    if (entry?.isDirectory()) candidates.push({ version: name, directory: join(real, name) });
  }
  if (candidates.length === 0) return report;
  candidates.sort((left, right) => compareStableVersions(left.version, right.version));

  let holding;
  try {
    holding = await processCheck(candidates.map(({ version, directory }) => ({ version, directory })));
  } catch {
    holding = null;
  }
  const pins = new Map((inventory?.pins ?? []).map((pin) => [pin.version, pin]));
  const nowMs = now.getTime();
  for (const { version } of candidates) {
    const pin = pins.get(version);
    const used = await markerTime(join(usedRoot, version));
    // A version the check left out is a check that failed.
    const processState = holding instanceof Map ? holding.get(version) : undefined;
    const reasons = [];
    if (pin?.cli_pin) reasons.push("cli_pin");
    if (pin?.default) reasons.push("default");
    if (pin?.apps > 0) reasons.push(`pinned_by_apps: ${pin.apps}`);
    if (used !== null && nowMs - used <= bunRecentUseMs) reasons.push(`used_recently: ${new Date(used).toISOString()}`);
    if (processState === "held") reasons.push("held_by_process");
    if (used === null) reasons.push("unknown: no_marker_history");
    if (inventory?.complete !== true) reasons.push("unknown: inventory_incomplete");
    if (!["held", "free", "unsupported"].includes(processState)) reasons.push("unknown: process_check_failed");
    if (processState === "unsupported") reasons.push("unknown: no_process_check");
    const bytes = await moduleBunCacheBytes({ cacheRoot: join(cacheRoot, version) });
    const verdict = reasons.length === 0 ? "would_remove" : "kept";
    report.versions.push({ version, bytes, verdict, reasons });
    if (verdict === "would_remove") report.would_free_bytes += bytes;
  }
  return report;
}

/**
 * The process check of the prune report: `(versions) => Map<version, state>`
 * for `[{ version, directory }]`, each `held`, `free`, `failed` (an error, a
 * denial or a listing that may be incomplete) or `unsupported`. It only
 * supports the report, it is no lease: it does not see a process that has a
 * version's directory on its PATH and starts its Bun later (#640).
 *
 *   - macOS: `lsof` on each version's program;
 *   - Linux: the program and the mapped files of every process of this user in
 *     /proc. The cache is this user's own (its directories are 0700), so a
 *     process of another user cannot run a program from it unless handed one
 *     on purpose, and its entries need rights this user does not have;
 *   - every other system, Windows included: `unsupported`.
 */
export function bunProcessCheck({
  platform = process.platform,
  runLsof = systemLsof,
  procTable = linuxProcTable(),
  uid = typeof process.getuid === "function" ? process.getuid() : null,
} = {}) {
  if (platform === "darwin") return (versions) => lsofCheck(versions, runLsof);
  if (platform === "linux") return (versions) => procCheck(versions, procTable, uid);
  return async (versions) => new Map(versions.map(({ version }) => [version, "unsupported"]));
}

// The programs of a version: `bin/bun` of each of Bun's npm packages its
// directory holds (one, or a plain x64 build beside its baseline). Null when
// they cannot be listed.
async function versionPrograms(directory) {
  const oven = join(directory, "node_modules", "@oven");
  let entries;
  try {
    entries = await readdir(oven, { withFileTypes: true });
  } catch (error) {
    return error?.code === "ENOENT" ? [] : null;
  }
  const programs = [];
  for (const entry of entries.sort((left, right) => (left.name < right.name ? -1 : 1))) {
    if (!entry.isDirectory() || !entry.name.startsWith("bun-")) continue;
    for (const name of ["bun", "bun.exe"]) {
      const program = join(oven, entry.name, "bin", name);
      if ((await lstat(program).catch(() => null))?.isFile()) programs.push(program);
    }
  }
  return programs;
}

async function lsofCheck(versions, runLsof) {
  const states = new Map();
  for (const { version, directory } of versions) {
    const programs = await versionPrograms(directory);
    if (programs === null) {
      states.set(version, "failed");
    } else if (programs.length === 0) {
      // Nothing a process could run.
      states.set(version, "free");
    } else {
      let answer = null;
      try {
        answer = await runLsof(["-t", "--", ...programs]);
      } catch {
        // No answer: the check failed.
      }
      states.set(version, lsofState(answer));
    }
  }
  return states;
}

// `lsof -t` prints the IDs of the processes that hold a named file, one per
// line, and exits 1 when one of the named files is open nowhere. Anything on
// stderr (an error, or a warning that the listing may be incomplete) and any
// other output fail the check.
function lsofState(answer) {
  if (!answer || answer.error || String(answer.stderr ?? "") !== "") return "failed";
  const lines = String(answer.stdout ?? "").split("\n").filter((line) => line !== "");
  if (!lines.every((line) => /^\d+$/.test(line))) return "failed";
  if (lines.length > 0) return "held";
  return answer.code === 1 ? "free" : "failed";
}

// The system's lsof, bounded in time: `{ code, stdout, stderr }`, or `{ error }`
// when it did not run to its end.
async function systemLsof(args) {
  try {
    const { stdout, stderr } = await execute("/usr/sbin/lsof", args, {
      encoding: "utf8",
      timeout: lsofTimeoutMs,
      killSignal: "SIGKILL",
      maxBuffer: 1024 * 1024,
      env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LC_ALL: "C" },
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    if (typeof error?.code === "number") {
      return { code: error.code, stdout: String(error.stdout ?? ""), stderr: String(error.stderr ?? "") };
    }
    return { error: error?.killed ? "timeout" : codeOf(error), stdout: "", stderr: "" };
  }
}

/** Linux's process table in /proc: its numeric entries, the owner of each,
 * its program (`exe`) and its mapped files (`maps`). */
export function linuxProcTable(procRoot = "/proc") {
  return Object.freeze({
    pids: async () => (await readdir(procRoot)).filter((name) => /^\d+$/.test(name)),
    owner: async (pid) => (await lstat(join(procRoot, pid))).uid,
    exe: (pid) => readlink(join(procRoot, pid, "exe")),
    maps: (pid) => readFile(join(procRoot, pid, "maps"), "utf8"),
  });
}

// The files a /proc maps listing maps: the path after its five fields.
function mappedPaths(maps) {
  const paths = [];
  for (const line of String(maps ?? "").split("\n")) {
    const match = /^\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+(\/.*)$/.exec(line);
    if (match !== null) paths.push(match[1]);
  }
  return paths;
}

// A process that ended between the listing and the read.
const ended = (error) => error?.code === "ENOENT" || error?.code === "ESRCH";

async function procCheck(versions, table, uid) {
  const failed = () => new Map(versions.map(({ version }) => [version, "failed"]));
  if (typeof uid !== "number") return failed();
  const held = new Set();
  try {
    for (const pid of await table.pids()) {
      let owner;
      try {
        owner = await table.owner(pid);
      } catch (error) {
        if (ended(error)) continue;
        throw error;
      }
      if (owner !== uid) continue;
      const paths = [];
      try {
        paths.push(await table.exe(pid));
      } catch (error) {
        if (!ended(error)) throw error;
      }
      try {
        paths.push(...mappedPaths(await table.maps(pid)));
      } catch (error) {
        if (!ended(error)) throw error;
      }
      for (const { version, directory } of versions) {
        if (paths.some((path) => typeof path === "string" && (path === directory || path.startsWith(`${directory}/`)))) {
          held.add(version);
        }
      }
    }
  } catch {
    return failed();
  }
  return new Map(versions.map(({ version }) => [version, held.has(version) ? "held" : "free"]));
}

/**
 * The tools step of a computer's `lazurio update` (the points above), which
 * the update's entry passes to `runLazurioUpdate`. Answers the update
 * report's `tools` section: `{ bun: { pins, inventory: { complete, issues },
 * prune_report } }`, or `{ bun: { error } }` when the step itself broke. It
 * never throws. `home` holds the runtime cache; `resolve`, `processCheck`,
 * `discoverApps` and `now` are seams of the tests.
 */
export async function updateBunRuntimes({
  rootPath,
  discoverApps = discoverLaunchpadApps,
  warnings = [],
  now = () => new Date(),
  home = homedir(),
  platform = process.platform,
  env = process.env,
  resolve: resolveBun = null,
  processCheck = null,
  entryBudget = worktreeEntryBudget,
} = {}) {
  try {
    const inventory = await bunPinInventory({ rootPath, discoverApps, entryBudget });
    // The same resolver as the packages refreshed after this step: the Bun
    // the update runs on is the user's.
    const pins = await prewarmBunRuntimes({
      pins: inventory.pins,
      resolve: resolveBun ?? createModuleBunResolver({ userBun: process.execPath, home, platform, env }),
      warnings,
    });
    const pruneReport = await bunCachePruneReport({
      cacheRoot: moduleBunRoot(home, { platform, env }),
      usedRoot: moduleBunUsed(home, { platform, env }),
      inventory,
      now: now(),
      processCheck: processCheck ?? bunProcessCheck({ platform }),
    });
    return {
      bun: {
        pins,
        inventory: { complete: inventory.complete, issues: inventory.issues },
        prune_report: pruneReport,
      },
    };
  } catch (error) {
    warnings.push(`Bun pro aplikace se nepodařilo připravit předem: ${messageOf(error)}`);
    return { bun: { error: messageOf(error) } };
  }
}

const refusalWords = Object.freeze({
  "runtime-unavailable": "registr npm neodpovídá",
  "runtime-integrity-failed": "stažený Bun neprošel kontrolou",
  "runtime-version-unknown": "registr npm tuto verzi nezná",
  "runtime-disk-full": "na disku není dost místa",
  "runtime-unsupported-platform": "pro tento systém Bun tuto verzi nevydává",
});

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${Math.round(bytes / 1024)} kB`;
  return `${Math.round(bytes / 1024 ** 2)} MB`;
}

function pinLine(pin) {
  switch (pin.state) {
    case "user":
      return `· ${pin.version}: váš Bun, nic se nestahuje`;
    case "cached":
      return `· ${pin.version}: v mezipaměti Lazuria`;
    case "fetched":
      return `✓ ${pin.version}: předem staženo do mezipaměti Lazuria`;
    case "refused":
      return `${pin.reason === "runtime-unavailable" ? "·" : "!"} ${pin.version}: nestaženo, ${refusalWords[pin.reason] ?? pin.reason} (${pin.reason})`;
    case "not_fetched":
      return `· ${pin.version}: nestaženo, stáhne se při prvním startu (offline)`;
    default:
      return `! ${pin.version}: nestaženo: ${pin.detail ?? pin.reason ?? "neznámá chyba"}`;
  }
}

function pruneLines(report) {
  if (!report) return [];
  if (report.state === "linked") return ["Mezipaměť Bunu Lazuria je odkaz na jinou složku, takže se do přehledu nečte."];
  if (report.state === "not_a_directory") return ["Mezipaměť Bunu Lazuria není složka, takže se do přehledu nečte."];
  if (report.state === "unreadable") return ["! Mezipaměť Bunu Lazuria nejde přečíst."];
  const versions = report.versions ?? [];
  if (versions.length === 0) return ["Mezipaměť Bunu Lazuria je prázdná."];
  const lines = ["Mezipaměť Bunu Lazuria, jen přehled (zatím se nic nemaže):"];
  for (const entry of versions) {
    lines.push(entry.verdict === "would_remove"
      ? `· ${entry.version}, ${formatBytes(entry.bytes)}: smazala by se`
      : `· ${entry.version}, ${formatBytes(entry.bytes)}: zůstává (${entry.reasons.join(", ")})`);
  }
  if (versions.some((entry) => entry.verdict === "would_remove")) {
    lines.push(`Smazáním by se uvolnilo ${formatBytes(report.would_free_bytes)}. Aplikace mimo dohled Lazuria, která některou z těchto verzí dlouho nepoužila, by se pak bez připojení k internetu nespustila.`);
  }
  return lines;
}

/** The human lines of the update report's `tools` section, in Czech, for the
 * text output of `lazurio update`. */
export function formatBunRuntimesReport(tools) {
  const bun = tools?.bun;
  const error = bun === undefined ? tools?.error : bun?.error;
  if (typeof error === "string") return [`! Bun pro aplikace se nepodařilo připravit: ${error}`];
  if (!bun) return [];
  const pins = bun.pins ?? [];
  const lines = [pins.length === 0 ? "Bun pro aplikace: žádná přesná verze" : "Bun pro aplikace:"];
  for (const pin of pins) lines.push(pinLine(pin));
  if (bun.inventory?.complete === false) {
    lines.push(`! Seznam aplikací není úplný, proto by se nic nesmazalo: ${bun.inventory.issues?.[0] ?? "neznámý důvod"}`);
  }
  lines.push(...pruneLines(bun.prune_report));
  return lines;
}
