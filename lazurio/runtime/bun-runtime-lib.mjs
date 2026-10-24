import { execFile } from "node:child_process";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  statfs,
  symlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, posix, win32 } from "node:path";
import { promisify } from "node:util";
import { acquireFileLock, FileLockError } from "./file-lock-lib.mjs";

const execute = promisify(execFile);

// The Bun an App pins is that App's runtime (decision 0171, addendum of
// 2026-10-24), like T3 Code's own Node (decision 0161 point 4): not a tool of
// the user's and not a second copy of one. Every path of the root that runs an
// App's code with Bun (its dependency install and its start) runs the exact
// version its package.json pins (`packageManager: bun@x.y.z`), chosen in this
// order:
//
//   1. the user's Bun when it reports that version exactly: nothing is
//      downloaded and the App's environment stays as it was;
//   2. otherwise that version in Lazurio's runtime cache, off the user's PATH,
//      whose directories are never changed once placed;
//   3. otherwise that version fetched into the cache with Bun's own installer
//      from Bun's official npm distribution (`bun add --exact --ignore-scripts
//      @oven/bun-<target>@<version>`, run by the user's Bun): Bun checks the
//      registry's sha512 integrity before it extracts anything, no install
//      script runs, and the installed program must report the pinned version
//      before it is placed, by one rename, beside the others.
//
// Never another version: what cannot be had is a typed refusal
// (`BunRuntimeRefused`, `runtimeReasons`) named by the package.json that pins
// it. A package that pins no exact version keeps the user's Bun, as before.
// Lazurio's own processes are not an App's code and stay on the Bun they run
// on.
//
// The same contract, cache layout and locks as LazurioPlatform (decision F62,
// `src/modules/bun-runtime.ts`), so the two share one cache on one machine:
// `~/.local/share/lazurio/runtimes/bun/<version>/` with the exclusion of each
// version in `~/.local/share/lazurio/runtimes/bun.locks/<version>`. On Windows
// the cache is `%LOCALAPPDATA%\Lazurio\runtimes\bun\<version>\` and there is
// no exclusion across processes (no qualified `flock`, as the Platform's own
// case without one): two processes repairing one broken version at once are
// not excluded from each other, while the identity check before a broken copy
// is moved aside and the one-step rename remain.

/** The refusals of an App's pinned Bun, the closed set LazurioPlatform uses. */
export const runtimeReasons = Object.freeze([
  "runtime-unavailable",
  "runtime-integrity-failed",
  "runtime-version-unknown",
  "runtime-disk-full",
  "runtime-unsupported-platform",
]);

/** A fetch needs this much free space where the runtimes are kept: the
 * download and the extracted program (about 70 MB) with room to spare. */
export const runtimeFreeBytesMin = 300 * 1024 * 1024;
/** The bound of one fetch. */
export const runtimeFetchTimeoutMs = 300_000;
const probeTimeoutMs = 10_000;
/** A private directory older than this is left over from a fetch whose
 * process ended, never one under way. */
const leftoverAgeMs = 60 * 60_000;
const exactPin = /^bun@(\d+\.\d+\.\d+)$/;

/** The exact Bun a package pins (`bun@x.y.z`), or null when its
 * `packageManager` names none exactly: only an exact version is a pin. */
export function exactBunPin(packageManager) {
  return typeof packageManager === "string" && exactPin.test(packageManager) ? packageManager : null;
}

/** Where Lazurio keeps the Bun versions Apps pin, under the user's home and
 * off their PATH; on Windows in their LocalAppData. */
export function moduleBunRoot(home, { platform = process.platform, env = process.env } = {}) {
  if (platform === "win32") {
    const localAppData = typeof env.LOCALAPPDATA === "string" && env.LOCALAPPDATA !== ""
      ? env.LOCALAPPDATA
      : win32.join(home, "AppData", "Local");
    return win32.join(localAppData, "Lazurio", "runtimes", "bun");
  }
  return posix.join(home, ".local", "share", "lazurio", "runtimes", "bun");
}

/** The lock files of the versions' exclusions, beside the cache and never
 * removed (a waiter may hold one open). */
export function moduleBunLocks(home, options = {}) {
  const path = (options.platform ?? process.platform) === "win32" ? win32 : posix;
  return path.join(path.dirname(moduleBunRoot(home, options)), "bun.locks");
}

// The cache as its words name it, without the user's home.
const displayedRoot = (platform) => (platform === "win32"
  ? "%LOCALAPPDATA%\\Lazurio\\runtimes\\bun"
  : "~/.local/share/lazurio/runtimes/bun");

/** The words of a refusal, naming the package.json that pins the version. */
export function bunRuntimeRefusalMessage(reason, { file, version, cacheRoot = null }) {
  switch (reason) {
    case "runtime-unavailable":
      return `Aplikace potřebuje Bun ${version}, který připíná ${file}. V mezipaměti Lazuria zatím není a stáhnout ho nešlo, protože registr npm neodpověděl, takže se nic nespustilo. Zkuste to znovu, až bude připojení k internetu; jinou verzí Bunu Lazurio aplikaci nespustí.`;
    case "runtime-integrity-failed":
      return `Bun ${version}, který připíná ${file}, se stáhl, ale neprošel kontrolou, takže se nepoužil a nic se nespustilo. Zkuste to znovu; když to selže i podruhé, požádejte agenta, ať se na to podívá.`;
    case "runtime-version-unknown":
      return `${file} připíná Bun ${version}, který registr npm nezná, takže aplikace nemůže běžet. Změňte tam packageManager na vydanou verzi Bunu.`;
    case "runtime-disk-full":
      return `Na disku není dost místa na stažení Bunu ${version}, který připíná ${file}: Lazurio potřebuje alespoň 300 MB volných v ${cacheRoot ?? "mezipaměti Lazuria"}. Uvolněte místo a zkuste to znovu.`;
    case "runtime-unsupported-platform":
      return `Bun pro tento systém nevydává build verze ${version}, kterou připíná ${file}, takže aplikace tu běžet nemůže.`;
    default:
      throw new Error(`Unknown Bun runtime refusal: ${String(reason)}`);
  }
}

/** The pinned Bun of a package cannot be had: `reason` is one of
 * `runtimeReasons`, `path` the package.json that pins `version`. */
export class BunRuntimeRefused extends Error {
  constructor(reason, { path, version, cacheRoot = null }) {
    super(bunRuntimeRefusalMessage(reason, { file: path, version, cacheRoot }));
    this.name = "BunRuntimeRefused";
    this.reason = reason;
    this.path = path;
    this.version = version;
    this.cacheRoot = cacheRoot;
  }
}

/** A refusal that may pass by itself: the registry did not answer, or the
 * disk was full. Unattended work (the hosted maintenance) tries it again; a
 * download that did not verify, an unknown version and an unsupported system
 * wait for a person's start instead, so nothing downloads again and again
 * (LazurioPlatform decision F62 point 7). */
export function runtimeRefusalMayPass(reason) {
  return reason === "runtime-unavailable" || reason === "runtime-disk-full";
}

/** The environment of an App's process for its Bun: that Bun's directory
 * first on PATH (once), everything else as it is; the user's Bun changes
 * nothing. On Windows the existing `Path` key and `;` stay. */
export function withModuleBun(env, bun, { platform = process.platform } = {}) {
  if (bun.binDir === null) return { ...env };
  const windows = platform === "win32";
  const separator = windows ? ";" : ":";
  const key = windows
    ? Object.keys(env).find((name) => name.toUpperCase() === "PATH") ?? "Path"
    : "PATH";
  const same = (entry) => (windows ? entry.toLowerCase() === bun.binDir.toLowerCase() : entry === bun.binDir);
  const rest = String(env[key] ?? "").split(separator).filter((entry) => entry !== "" && !same(entry));
  return { ...env, [key]: [bun.binDir, ...rest].join(separator) };
}

// The version `bun --version` reported: exactly `x.y.z` and a line end on
// stdout and nothing on stderr, or null.
function parseBunVersion(stdout, stderr) {
  const version = String(stdout ?? "").replace(/\r?\n$/, "");
  return String(stderr ?? "").length || !/^\d+\.\d+\.\d+$/.test(version) ? null : version;
}

function atLeast(version, minimum) {
  const parts = version.split(".").map(Number);
  for (let index = 0; index < minimum.length; index += 1) {
    const part = parts[index] ?? 0;
    const floor = minimum[index] ?? 0;
    if (part !== floor) return part > floor;
  }
  return true;
}

/** The packages of Bun's npm distribution (`@oven/bun-<name>`, program in
 * `bin/`) that may run `version` on `system`, in the order they are tried;
 * null when Bun publishes none for it (Linux with musl, FreeBSD and anything
 * else, for now). An x64 CPU without AVX2 needs the baseline build: on Linux
 * /proc/cpuinfo decides up front, elsewhere the baseline is tried once when
 * the plain build does not run. */
export function bunTargets(system, version) {
  const x64 = (os, executable) => (system.avx2 === true
    ? [`${os}-x64`]
    : system.avx2 === false
      ? [`${os}-x64-baseline`]
      : [`${os}-x64`, `${os}-x64-baseline`]
  ).map((name) => Object.freeze({ name, executable }));
  const one = (name, executable) => [Object.freeze({ name, executable })];
  if (system.platform === "darwin") {
    if (system.arch === "arm64") return one("darwin-aarch64", "bun");
    if (system.arch === "x64") return x64("darwin", "bun");
    return null;
  }
  if (system.platform === "linux") {
    if (system.libc !== "glibc") return null;
    if (system.arch === "arm64") return one("linux-aarch64", "bun");
    if (system.arch === "x64") return x64("linux", "bun");
    return null;
  }
  if (system.platform === "win32") {
    if (system.arch === "arm64") return atLeast(version, [1, 3, 10]) ? one("windows-aarch64", "bun.exe") : null;
    if (system.arch === "x64") return x64("windows", "bun.exe");
    return null;
  }
  return null;
}

// glibc or musl, as detect-libc tells them apart: the C library the runtime
// reports, else the text of ldd, which on musl names it.
async function linuxLibc() {
  try {
    if (typeof process.report?.getReport?.()?.header?.glibcVersionRuntime === "string") return "glibc";
  } catch {
    // No report: read ldd.
  }
  const ldd = await readFile("/usr/bin/ldd", "latin1").catch(() => "");
  return ldd.includes("musl") ? "musl" : "glibc";
}

/** This system as `bunTargets` reads it; `libc` and `avx2` are known on Linux
 * only (null elsewhere, or when they cannot be read). */
export async function hostBunSystem(platform = process.platform, arch = process.arch) {
  if (platform !== "linux") return { platform, arch, libc: null, avx2: null };
  const cpuinfo = await readFile("/proc/cpuinfo", "latin1").catch(() => null);
  const flags = cpuinfo?.split("\n").find((line) => /^flags\s*:/.test(line));
  return {
    platform,
    arch,
    libc: await linuxLibc(),
    avx2: flags === undefined ? null : /\savx2(\s|$)/.test(flags),
  };
}

/** Bun's official npm distribution. */
export const officialRegistry = "https://registry.npmjs.org/";

// Bun's installer's own words for why it failed (Bun 1.4: "Integrity check
// failed for tarball", "IntegrityCheckFailed extracting tarball", "No version
// matching … found", "GET … - 404", "ConnectionRefused downloading package
// manifest", "DNSResolveFailed …"). Anything not known for a refusal of its own
// is a registry that did not answer.
function installRefusal(output) {
  if (/integrity\s*check\s*failed|IntegrityCheckFailed/i.test(output)) return "runtime-integrity-failed";
  if (/no version matching|\s-\s404\b/i.test(output)) return "runtime-version-unknown";
  if (/ENOSPC|no space left|NoSpaceLeft|disk quota/i.test(output)) return "runtime-disk-full";
  return "runtime-unavailable";
}

/** Bun's own installer: `bun add --exact --ignore-scripts <package>@<version>`
 * from `registry` (Bun's official npm distribution; another only in tests),
 * with a private home and cache, bounded in time. Never `curl | sh`. Answers
 * `{ kind: "installed" }` or `{ kind: "refused", reason }`. */
export function bunInstaller(registry = officialRegistry) {
  return async (input) => {
    try {
      await execute(input.installer, [
        "add",
        "--exact",
        "--ignore-scripts",
        "--no-progress",
        "--no-summary",
        `--registry=${registry}`,
        `--cache-dir=${input.cache}`,
        `${input.packageName}@${input.version}`,
      ], {
        cwd: input.directory,
        env: {
          HOME: input.home,
          PATH: input.path,
          ...(input.tmpdir ? { TMPDIR: input.tmpdir } : {}),
          ...input.systemEnv,
        },
        encoding: "utf8",
        timeout: input.timeoutMs,
        maxBuffer: 1024 * 1024,
        killSignal: "SIGKILL",
        windowsHide: true,
      });
      return { kind: "installed" };
    } catch (error) {
      // Ended at its bound: the registry did not answer in time.
      if (error?.killed || error?.signal === "SIGKILL") return { kind: "refused", reason: "runtime-unavailable" };
      const output = `${typeof error?.stderr === "string" ? error.stderr : ""}\n${typeof error?.stdout === "string" ? error.stdout : ""}`;
      return { kind: "refused", reason: installRefusal(output) };
    }
  };
}

// A runtime refusal inside a fetch, which waiters of several packages share;
// each names its own package.json.
class RuntimeFailure extends Error {
  constructor(reason) {
    super(reason);
    this.reason = reason;
  }
}

// The fetches under way in this process, by runtime directory: concurrent
// resolutions of one version fetch it once, whichever resolver asks.
const fetchesOfThisProcess = new Map();

// The exclusion of one version's directory across processes, LazurioPlatform's
// included: one kernel `flock` on `<version>` in `moduleBunLocks`, which a dead
// holder releases by itself. Null where there is none to take: a system
// without a qualified `flock` (Windows, for now) or a filesystem that does not
// support it.
async function versionLock(path, timeoutMs) {
  if (process.platform !== "darwin" && process.platform !== "linux") return null;
  try {
    return await acquireFileLock(path, { timeoutMs });
  } catch (error) {
    if (error instanceof FileLockError && error.reason === "unsupported") return null;
    throw error;
  }
}

async function freeBytesAt(directory) {
  try {
    const space = await statfs(directory);
    return Number(space.bavail) * Number(space.bsize);
  } catch {
    // Where the system cannot tell, a disk that fills during the fetch still
    // answers `runtime-disk-full`.
    return Number.POSITIVE_INFINITY;
  }
}

function pathOf(env, platform) {
  if (platform !== "win32") return env.PATH;
  const key = Object.keys(env).find((name) => name.toUpperCase() === "PATH");
  return key === undefined ? undefined : env[key];
}

/** The resolver of one user's Apps: `({ packageManager, owner }) => { executable,
 * binDir, source }` for the package in the directory `owner`, whose
 * `packageManager` is an exact pin or null. `binDir` goes first on the PATH of
 * the App's processes (`withModuleBun`); null for the user's Bun, whose
 * environment stays as it is. A pin that cannot be had throws
 * `BunRuntimeRefused`. */
export function createModuleBunResolver({
  // The user's Bun: the first choice, and the installer.
  userBun,
  // The user's home: the runtime cache is under it (`moduleBunRoot`).
  home = homedir(),
  platform = process.platform,
  env = process.env,
  // The PATH the user's Bun runs with.
  path = pathOf(env, platform) ?? "/usr/bin:/bin",
  tmpdir = undefined,
  // Test seams: this system, Bun's installer, the free space, the fetches of
  // this process (another map is another process), the fetch bound and the
  // exclusion of a version across processes.
  system = undefined,
  install = bunInstaller(),
  freeBytes = freeBytesAt,
  fetches = fetchesOfThisProcess,
  fetchTimeoutMs = runtimeFetchTimeoutMs,
  lock = versionLock,
}) {
  if (typeof userBun !== "string" || userBun === "") throw new TypeError("The user's Bun is required");
  const root = moduleBunRoot(home, { platform, env });
  const locks = moduleBunLocks(home, { platform, env });
  const cacheRoot = displayedRoot(platform);
  // What a Windows program needs to run at all; nothing of the user's Bun or
  // npm configuration.
  const systemEnv = (ownHome) => (platform === "win32"
    ? Object.fromEntries(Object.entries({
        USERPROFILE: ownHome,
        SystemRoot: env.SystemRoot,
        windir: env.windir,
        TEMP: env.TEMP,
        TMP: env.TMP,
      }).filter(([, value]) => typeof value === "string" && value !== ""))
    : {});
  let known;
  const hostSystem = () => {
    known ??= (system ?? (() => hostBunSystem()))();
    return known;
  };
  const probeEnv = { HOME: home, PATH: path, ...systemEnv(home) };
  const user = Object.freeze({ executable: userBun, binDir: null, source: "user" });

  // The version a program reports, or null when it does not run.
  const probe = async (executable, cwd) => {
    try {
      const { stdout, stderr } = await execute(executable, ["--version"], {
        cwd,
        env: probeEnv,
        encoding: "utf8",
        timeout: probeTimeoutMs,
        maxBuffer: 4096,
        killSignal: "SIGKILL",
        windowsHide: true,
      });
      return parseBunVersion(stdout, stderr);
    } catch {
      return null;
    }
  };
  const programOf = (directory, target) =>
    join(directory, "node_modules", "@oven", `bun-${target.name}`, "bin", target.executable);
  const placed = (executable, source) => Object.freeze({ executable, binDir: dirname(executable), source });

  // The version's directory as it is: ready (its program reports the
  // version), absent, or broken (anything else), with its identity.
  async function cached(directory, version, targets) {
    const entry = await lstat(directory).catch(() => null);
    if (entry === null) return { kind: "absent" };
    const identity = `${entry.dev}:${entry.ino}`;
    if (!entry.isDirectory()) return { kind: "broken", identity };
    for (const target of targets) {
      const executable = programOf(directory, target);
      const file = await lstat(executable).catch(() => null);
      if (file === null) continue;
      if (file.isFile() && (await probe(executable, directory)) === version) {
        return { kind: "ready", bun: placed(executable, "cache") };
      }
      break;
    }
    return { kind: "broken", identity };
  }

  // A broken version's directory moves aside and goes, unless it was replaced
  // meanwhile (another process placed a good one): false then.
  async function discard(directory, identity) {
    const entry = await lstat(directory).catch(() => null);
    if (entry === null) return true;
    if (`${entry.dev}:${entry.ino}` !== identity) return false;
    const aside = await mkdtemp(join(root, ".trash-"));
    try {
      await rename(directory, join(aside, "version"));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    } finally {
      await rm(aside, { recursive: true, force: true }).catch(() => undefined);
    }
    return true;
  }

  // Private directories of fetches that never finished (their process ended):
  // never one younger than the fetch bound allows.
  async function sweepLeftovers() {
    const now = Date.now();
    for (const name of await readdir(root).catch(() => [])) {
      if (!name.startsWith(".tmp-") && !name.startsWith(".trash-")) continue;
      const entry = await lstat(join(root, name)).catch(() => null);
      if (entry !== null && now - entry.mtimeMs > leftoverAgeMs) {
        await rm(join(root, name), { recursive: true, force: true }).catch(() => undefined);
      }
    }
  }

  async function fetchVersion(directory, version, targets) {
    await mkdir(root, { recursive: true, mode: 0o700 });
    if (!(await lstat(root)).isDirectory()) throw new Error(`Mezipaměť verzí Bunu ${root} není složka.`);
    await sweepLeftovers();
    if ((await freeBytes(root)) < runtimeFreeBytesMin) throw new RuntimeFailure("runtime-disk-full");
    for (const [index, target] of targets.entries()) {
      const staging = await mkdtemp(join(root, ".tmp-"));
      try {
        const privateHome = join(staging, "home");
        const cache = join(staging, "cache");
        await mkdir(privateHome, { mode: 0o700 });
        // A project of its own: `bun add` in a directory without a
        // package.json adds to the nearest one above it.
        await writeFile(
          join(staging, "package.json"),
          `${JSON.stringify({ name: "lazurio-bun-runtime", private: true })}\n`,
          { mode: 0o600 },
        );
        const installed = await install({
          installer: userBun,
          directory: staging,
          packageName: `@oven/bun-${target.name}`,
          version,
          home: privateHome,
          cache,
          path,
          tmpdir,
          systemEnv: systemEnv(privateHome),
          timeoutMs: fetchTimeoutMs,
        });
        if (installed.kind === "refused") throw new RuntimeFailure(installed.reason);
        const executable = programOf(staging, target);
        const file = await lstat(executable).catch(() => null);
        if (file === null || !file.isFile()) throw new RuntimeFailure("runtime-integrity-failed");
        const reported = await probe(executable, staging);
        // A build that does not run here: its baseline, once, when there is
        // one to try.
        if (reported === null) {
          if (index < targets.length - 1) continue;
          throw new RuntimeFailure("runtime-unsupported-platform");
        }
        if (reported !== version) throw new RuntimeFailure("runtime-integrity-failed");
        // `bunx` is Bun under that name, as Bun's own installer links it.
        if (target.executable === "bun") {
          await symlink("bun", join(dirname(executable), "bunx")).catch((error) => {
            if (error?.code !== "EEXIST") throw error;
          });
        }
        await rm(privateHome, { recursive: true, force: true });
        await rm(cache, { recursive: true, force: true });
        try {
          await rename(staging, directory);
        } catch (error) {
          // Another process placed it first (EEXIST or ENOTEMPTY; EPERM on
          // Windows): its copy is kept and this one discarded below.
          if (!["EEXIST", "ENOTEMPTY", "EPERM"].includes(error?.code)
            || (await lstat(directory).catch(() => null)) === null) throw error;
          const there = await cached(directory, version, targets);
          if (there.kind === "ready") return there.bun;
          throw new RuntimeFailure("runtime-integrity-failed");
        }
        return placed(programOf(directory, target), "fetched");
      } finally {
        await rm(staging, { recursive: true, force: true }).catch(() => undefined);
      }
    }
    throw new RuntimeFailure("runtime-unsupported-platform");
  }

  // The cache, or one fetch: a broken cached version is fetched again once. A
  // version that is ready is only read, without any exclusion. Everything that
  // changes a version's directory (moving a broken one aside, placing a
  // fetched one) happens under that version's exclusion across processes, and
  // the cache is read again once it is held, so no process removes a copy
  // that another one has just placed and may have handed out already: a
  // second process waits, then finds it ready.
  async function provide(version, targets, userRuns) {
    const directory = join(root, version);
    const first = await cached(directory, version, targets);
    if (first.kind === "ready") return first.bun;
    await mkdir(locks, { recursive: true, mode: 0o700 });
    let held;
    try {
      // A waiter waits for one fetch at most, then refuses as a registry that
      // did not answer.
      held = await lock(join(locks, version), fetchTimeoutMs + 60_000);
    } catch (error) {
      if (error instanceof FileLockError) throw new RuntimeFailure("runtime-unavailable");
      throw error;
    }
    try {
      for (let look = 0; look < 2; look += 1) {
        const there = await cached(directory, version, targets);
        if (there.kind === "ready") return there.bun;
        if (there.kind === "absent") break;
        if (await discard(directory, there.identity)) break;
      }
      // Bun's installer is the user's Bun: without one that runs, nothing can
      // be fetched.
      if (!userRuns) throw new Error("Bun uživatele nejde spustit, takže Lazurio nemůže stáhnout verzi Bunu, kterou aplikace připíná.");
      try {
        return await fetchVersion(directory, version, targets);
      } catch (error) {
        if (error?.code === "ENOSPC" || error?.code === "EDQUOT") throw new RuntimeFailure("runtime-disk-full");
        throw error;
      }
    } finally {
      await held?.release();
    }
  }

  return async ({ packageManager, owner }) => {
    if (packageManager === null || packageManager === undefined) return user;
    const match = exactPin.exec(packageManager);
    if (match === null) throw new Error("Exact Bun version required");
    const version = match[1];
    const reported = await probe(userBun, home);
    if (reported === version) return user;
    const refusal = (reason) => new BunRuntimeRefused(reason, {
      path: join(owner, "package.json"),
      version,
      cacheRoot,
    });
    const targets = bunTargets(await hostSystem(), version);
    if (targets === null) throw refusal("runtime-unsupported-platform");
    const key = join(root, version);
    let pending = fetches.get(key);
    if (pending === undefined) {
      const started = provide(version, targets, reported !== null).finally(() => {
        if (fetches.get(key) === started) fetches.delete(key);
      });
      pending = started;
      fetches.set(key, pending);
    }
    try {
      return await pending;
    } catch (error) {
      if (error instanceof RuntimeFailure) throw refusal(error.reason);
      throw error;
    }
  };
}
