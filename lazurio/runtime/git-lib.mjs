import { existsSync } from "fs";
import { lstat, mkdtemp, realpath, rm } from "fs/promises";
import { basename, dirname, win32 } from "path";
import { fileURLToPath } from "url";

import { isSamePath } from "../core/path-boundary-lib.mjs";
import { trustedGitCandidates } from "../core/cli-provenance-lib.mjs";

export const GIT_LOCAL_TIMEOUT_MS = 10_000;
export const GIT_FETCH_TIMEOUT_MS = 20_000;
export const GIT_COMMAND_CONCURRENCY = 4;
export const GIT_FETCH_CONCURRENCY = 4;
const GIT_TIMEOUT_DRAIN_GRACE_MS = 2_000;
export const PINNED_TEMPORARY_CHILD_MODE = "--lazurio-pinned-temporary-git-child";

let cachedGitExecutablePromise = null;
let cachedGitExecutableSync;
let hasCachedGitExecutableSync = false;

export async function resolveGitExecutable(options = {}) {
  const useCache = Object.keys(options).length === 0;
  if (useCache && cachedGitExecutablePromise) return cachedGitExecutablePromise;

  const resolution = resolveGitExecutableUncached(options);
  if (useCache) cachedGitExecutablePromise = resolution;
  return resolution;
}

async function resolveGitExecutableUncached({
  platform = process.platform,
  env = processEnv(),
  pathExists = existsSync,
  probe = probeGitExecutable,
} = {}) {
  for (const candidate of orderedGitExecutableCandidates({ platform, env, pathExists })) {
    if (await probe(candidate)) return candidate;
  }
  return null;
}

export function resolveGitExecutableSync(options = {}) {
  const useCache = Object.keys(options).length === 0;
  if (useCache && hasCachedGitExecutableSync) return cachedGitExecutableSync;

  const resolved = resolveGitExecutableSyncUncached(options);
  if (useCache) {
    cachedGitExecutableSync = resolved;
    hasCachedGitExecutableSync = true;
  }
  return resolved;
}

function resolveGitExecutableSyncUncached({
  platform = process.platform,
  env = processEnv(),
  pathExists = existsSync,
  probe = probeGitExecutableSync,
} = {}) {
  for (const candidate of orderedGitExecutableCandidates({ platform, env, pathExists })) {
    if (probe(candidate)) return candidate;
  }
  return null;
}

export async function runGit(args, { cwd, timeoutMs = GIT_LOCAL_TIMEOUT_MS, env = {} } = {}) {
  if (!cwd) throw new Error("runGit requires cwd");
  const executable = await resolveGitExecutable();
  if (!executable) {
    return {
      ok: false,
      exitCode: null,
      timedOut: false,
      stdout: "",
      stderr: "",
      error: "Git executable was not found.",
    };
  }
  return runCommand([executable, ...args], {
    cwd,
    timeoutMs,
    env,
  });
}

// Creates the temporary child and runs Git inside one OS-pinned parent cwd.
// The caller supplies Git arguments without the final child path; this
// capability appends the verified relative child name. A lexical parent swap
// therefore cannot redirect either staging creation or the mutating command.
export async function runGitInPinnedTemporaryChild(args, {
  cwd,
  expectedCwdRealPath,
  childPrefix,
  timeoutMs = GIT_LOCAL_TIMEOUT_MS,
  env = {},
} = {}) {
  const payload = JSON.stringify({
    args,
    expected_cwd_real_path: expectedCwdRealPath,
    child_prefix: childPrefix,
    timeout_ms: timeoutMs,
    env,
  });
  const child = await runCommand(
    [process.execPath, fileURLToPath(import.meta.url), PINNED_TEMPORARY_CHILD_MODE],
    {
      cwd,
      input: payload,
      timeoutMs: timeoutMs + GIT_TIMEOUT_DRAIN_GRACE_MS + 5_000,
    },
  );
  try {
    const result = JSON.parse(child.stdout.trim());
    if (child.ok && result?.ok === true) return result;
    return pinnedGitChildFailure(result?.code ?? "pinned_runner_failed", result);
  } catch {
    return pinnedGitChildFailure("pinned_runner_failed");
  }
}

export function safeGitRemoteEnv(platform = process.platform) {
  const common = {
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "never",
    SSH_ASKPASS_REQUIRE: "never",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: platform === "win32" ? "NUL" : "/dev/null",
    GIT_CONFIG_COUNT: "0",
    // Launchpad spouští Git nad explicitním cwd. Kontext zděděný například
    // z hooku nesmí přesměrovat child proces do jiného repozitáře.
    GIT_ALTERNATE_OBJECT_DIRECTORIES: undefined,
    GIT_COMMON_DIR: undefined,
    GIT_DIR: undefined,
    GIT_INDEX_FILE: undefined,
    GIT_OBJECT_DIRECTORY: undefined,
    GIT_PREFIX: undefined,
    GIT_WORK_TREE: undefined,
  };
  if (platform === "win32") {
    return {
      ...common,
      // Undefined values explicitly remove inherited POSIX-only helpers in
      // commandEnvironment() before Bun receives the environment.
      GIT_ASKPASS: undefined,
      SSH_ASKPASS: undefined,
    };
  }
  return {
    ...common,
    GIT_ASKPASS: "/bin/false",
    SSH_ASKPASS: "/bin/false",
  };
}

export function safeGitCommandEnv(platform = process.platform, base = processEnv()) {
  const {
    GIT_CONFIG_NOSYSTEM: _systemConfig,
    GIT_CONFIG_GLOBAL: _globalConfig,
    GIT_CONFIG_COUNT: _configCount,
    ...nonInteractive
  } = safeGitRemoteEnv(platform);
  // General Git operations retain the user's normal credentials, SSH agent
  // and enterprise proxy, while checkout-context injection variables are
  // stripped. Materialization passes safeGitRemoteEnv() explicitly and is the
  // narrower sterile lane that also disables all ambient Git config.
  return commandEnvironment(base, nonInteractive);
}

export function gitExecutableCandidates({ platform = process.platform, env = processEnv() } = {}) {
  if (platform !== "win32") return trustedGitCandidates(platform);
  const roots = [env.ProgramW6432, env.ProgramFiles, env["ProgramFiles(x86)"]].filter(Boolean);
  const candidates = [];
  for (const root of roots) {
    candidates.push(
      win32.join(root, "Git", "cmd", "git.exe"),
      win32.join(root, "Git", "bin", "git.exe"),
    );
  }
  if (env.LOCALAPPDATA) {
    candidates.push(
      win32.join(env.LOCALAPPDATA, "Programs", "Git", "cmd", "git.exe"),
      win32.join(env.LOCALAPPDATA, "Programs", "Git", "bin", "git.exe"),
    );
  }
  return [...new Set(candidates)];
}

export function resetGitExecutableCacheForTests() {
  cachedGitExecutablePromise = null;
  cachedGitExecutableSync = undefined;
  hasCachedGitExecutableSync = false;
}

export async function mapWithConcurrency(items, limit, fn) {
  const output = new Array(items.length);
  const workerCount = Math.max(1, Math.min(limit, items.length || 1));
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      output[index] = await fn(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return output;
}

async function runCommand(command, { cwd, timeoutMs, env = {}, input } = {}) {
  let child;
  let timedOut = false;
  let timeout;
  let drainTimeout;
  try {
    child = Bun.spawn(command, {
      cwd,
      stdin: input === undefined ? "ignore" : "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: commandEnvironment(
        isSterileGitEnvironment(env)
          ? minimalRemoteGitEnvironment(processEnv(), globalThis.process.platform)
          : processEnv(),
        env,
      ),
      detached: globalThis.process.platform !== "win32",
      windowsHide: true,
    });
    if (input !== undefined) {
      child.stdin.write(input);
      child.stdin.end();
    }
    const stdout = collectStreamText(child.stdout);
    const stderr = collectStreamText(child.stderr);
    const completed = Promise.all([stdout.promise, stderr.promise, child.exited]);
    const forced = new Promise((resolve) => {
      timeout = setTimeout(() => {
        timedOut = true;
        terminateGitProcessTree(child);
        // A credential helper can escape the Git process group yet keep an
        // inherited pipe open. Bound the drain as well as the process itself;
        // cancelling our readers closes the local pipe ends and lets the
        // update lane return a truthful timeout instead of hanging forever.
        drainTimeout = setTimeout(async () => {
          await Promise.allSettled([stdout.cancel(), stderr.cancel()]);
          resolve(null);
        }, GIT_TIMEOUT_DRAIN_GRACE_MS);
      }, timeoutMs);
    });
    const completion = await Promise.race([completed, forced]);
    if (completion === null) {
      const [partialStdout, partialStderr] = await Promise.all([
        stdout.promise.catch(() => ""),
        stderr.promise.catch(() => ""),
      ]);
      return {
        ok: false,
        exitCode: null,
        timedOut: true,
        stdout: partialStdout.trim(),
        stderr: partialStderr.trim(),
      };
    }
    const [stdoutText, stderrText, exitCode] = completion;
    return {
      ok: exitCode === 0 && !timedOut,
      exitCode,
      timedOut,
      stdout: stdoutText.trim(),
      stderr: stderrText.trim(),
    };
  } catch (error) {
    return {
      ok: false,
      exitCode: null,
      timedOut,
      stdout: "",
      stderr: "",
      error: error.message,
    };
  } finally {
    clearTimeout(timeout);
    clearTimeout(drainTimeout);
  }
}

function terminateGitProcessTree(child) {
  if (!child) return;
  if (globalThis.process.platform === "win32" && Number.isInteger(child.pid)) {
    try {
      const killed = Bun.spawnSync(gitTimeoutKillCommand(child.pid), {
        stdout: "ignore",
        stderr: "ignore",
        windowsHide: true,
        timeout: 5_000,
      });
      if (killed.exitCode === 0) return;
    } catch {}
  }
  if (globalThis.process.platform !== "win32" && Number.isInteger(child.pid)) {
    try {
      // POSIX Git transports (notably ssh) are descendants of the Git process
      // and inherit its pipes. Each command has its own process group, so the
      // negative pid is bounded to this one Git operation.
      globalThis.process.kill(-child.pid, "SIGKILL");
      return;
    } catch {}
  }
  try {
    child.kill("SIGKILL");
  } catch {}
}

export function gitTimeoutKillCommand(pid, env = processEnv()) {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error(`Invalid Windows process id: ${pid}`);
  const executable = env.SystemRoot
    ? win32.join(env.SystemRoot, "System32", "taskkill.exe")
    : "taskkill.exe";
  return [executable, "/PID", String(pid), "/T", "/F"];
}

function processEnv() {
  return typeof process !== "undefined" && process.env ? process.env : {};
}

function commandEnvironment(base, overrides) {
  const merged = {};
  for (const [key, value] of Object.entries(base)) {
    if (!unsafeAmbientGitEnvironmentKey(key)) merged[key] = value;
  }
  for (const [key, value] of Object.entries(overrides)) {
    const normalizedKey = key.toUpperCase();
    for (const existingKey of Object.keys(merged)) {
      if (existingKey.toUpperCase() === normalizedKey) delete merged[existingKey];
    }
    if (unsafeAmbientGitEnvironmentKey(key)) {
      const safePosixAskpass =
        ["GIT_ASKPASS", "SSH_ASKPASS"].includes(normalizedKey) &&
        value === "/bin/false";
      const safeSterileGitConfig =
        (normalizedKey === "GIT_CONFIG_NOSYSTEM" && value === "1")
        || (normalizedKey === "GIT_CONFIG_GLOBAL" && ["/dev/null", "NUL"].includes(value))
        || (normalizedKey === "GIT_CONFIG_COUNT" && value === "0");
      if (safePosixAskpass || safeSterileGitConfig) merged[normalizedKey] = value;
      continue;
    }
    if (value !== undefined && value !== null) merged[key] = value;
  }
  return merged;
}

function unsafeAmbientGitEnvironmentKey(key) {
  const normalizedKey = key.toUpperCase();
  return (
    [
      "GIT_ALTERNATE_OBJECT_DIRECTORIES",
      "GIT_ASKPASS",
      "GIT_CEILING_DIRECTORIES",
      "GIT_COMMON_DIR",
      "GIT_CONFIG",
      "GIT_CONFIG_GLOBAL",
      "GIT_CONFIG_NOSYSTEM",
      "GIT_CONFIG_PARAMETERS",
      "GIT_CONFIG_SYSTEM",
      "GIT_DIR",
      "GIT_EXEC_PATH",
      "GIT_GRAFT_FILE",
      "GIT_IMPLICIT_WORK_TREE",
      "GIT_INDEX_FILE",
      "GIT_INTERNAL_SUPER_PREFIX",
      "GIT_NO_REPLACE_OBJECTS",
      "GIT_OBJECT_DIRECTORY",
      "GIT_PREFIX",
      "GIT_PROXY_COMMAND",
      "GIT_REPLACE_REF_BASE",
      "GIT_SHALLOW_FILE",
      "GIT_SSH",
      "GIT_SSH_COMMAND",
      "GIT_WORK_TREE",
      "SSH_ASKPASS",
    ].includes(normalizedKey) ||
    normalizedKey === "GIT_CONFIG_COUNT" ||
    normalizedKey.startsWith("GIT_CONFIG_KEY_") ||
    normalizedKey.startsWith("GIT_CONFIG_VALUE_")
  );
}

function orderedGitExecutableCandidates({ platform, env, pathExists }) {
  const installedCandidates = gitExecutableCandidates({ platform, env })
    .filter((candidate) => pathExists(candidate));
  return [...new Set(installedCandidates)];
}

function isSterileGitEnvironment(environment) {
  return environment?.GIT_CONFIG_NOSYSTEM === "1"
    && environment?.GIT_CONFIG_COUNT === "0"
    && ["/dev/null", "NUL"].includes(environment?.GIT_CONFIG_GLOBAL);
}

function minimalRemoteGitEnvironment(base, platform) {
  const allowed = new Set([
    "APPDATA",
    "COMSPEC",
    "HOMEDRIVE",
    "HOMEPATH",
    "HOME",
    "LANG",
    "LC_ALL",
    "LOCALAPPDATA",
    "PATHEXT",
    "PROGRAMDATA",
    "PROGRAMFILES",
    "PROGRAMFILES(X86)",
    "PROGRAMW6432",
    "SSH_AUTH_SOCK",
    "SYSTEMDRIVE",
    "SYSTEMROOT",
    "TEMP",
    "TMP",
    "TMPDIR",
    "USER",
    "USERNAME",
    "USERPROFILE",
    "WINDIR",
  ]);
  const clean = {};
  for (const [key, value] of Object.entries(base)) {
    if (allowed.has(key.toUpperCase()) && typeof value === "string") clean[key] = value;
  }
  clean.PATH = platform === "win32"
    ? trustedWindowsChildPath(base)
    : "/usr/bin:/bin:/usr/sbin:/sbin";
  return clean;
}

function trustedWindowsChildPath(environment) {
  const candidates = [];
  if (environment.SystemRoot) {
    candidates.push(
      win32.join(environment.SystemRoot, "System32"),
      win32.join(environment.SystemRoot, "System32", "OpenSSH"),
    );
  }
  for (const git of gitExecutableCandidates({ platform: "win32", env: environment })) {
    candidates.push(dirname(git), win32.join(dirname(dirname(git)), "usr", "bin"));
  }
  return [...new Set(candidates)].join(";");
}

async function probeGitExecutable(executable) {
  const result = await runCommand([executable, "--version"], {
    timeoutMs: GIT_LOCAL_TIMEOUT_MS,
  });
  return result.ok;
}

function probeGitExecutableSync(executable) {
  try {
    const result = Bun.spawnSync([executable, "--version"], {
      stdout: "ignore",
      stderr: "ignore",
      env: safeGitCommandEnv(),
      windowsHide: true,
      timeout: GIT_LOCAL_TIMEOUT_MS,
    });
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

function collectStreamText(stream) {
  if (!stream) return { promise: Promise.resolve(""), cancel: async () => {} };
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let cancelled = false;
  const promise = (async () => {
    let text = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
      return text;
    } catch (error) {
      if (cancelled) return text;
      throw error;
    } finally {
      reader.releaseLock();
    }
  })();
  return {
    promise,
    cancel: async () => {
      cancelled = true;
      try {
        await reader.cancel("Git command timed out");
      } catch {}
    },
  };
}

export async function runPinnedTemporaryGitChild() {
  let childName = null;
  try {
    const payload = JSON.parse(await Bun.stdin.text());
    assertPinnedTemporaryGitChildPayload(payload);
    const actualParentRealPath = await realpath(".");
    if (!isSamePath(actualParentRealPath, payload.expected_cwd_real_path)) {
      throw pinnedGitChildError("parent_identity_changed");
    }

    const childPath = await mkdtemp(payload.child_prefix);
    childName = basename(childPath);
    const entry = await lstat(childName);
    const childRealPath = await realpath(childName);
    if (
      !entry.isDirectory()
      || entry.isSymbolicLink()
      || !isSamePath(dirname(childRealPath), actualParentRealPath)
    ) {
      throw pinnedGitChildError("child_identity_changed");
    }

    const result = await runGit([...payload.args, childName], {
      cwd: ".",
      timeoutMs: payload.timeout_ms,
      env: payload.env,
    });
    if (!result.ok) {
      await rm(childName, { recursive: true, force: true }).catch(() => {});
      childName = null;
      writePinnedGitChildResult({ ...result, ok: false, code: "git_command_failed" });
      return;
    }
    writePinnedGitChildResult({ ...result, child_name: childName });
  } catch (error) {
    if (childName) await rm(childName, { recursive: true, force: true }).catch(() => {});
    writePinnedGitChildResult({
      ok: false,
      code: error?.pinnedGitChildCode ?? "pinned_runner_failed",
      exitCode: null,
      timedOut: false,
      stdout: "",
      stderr: "",
    });
  }
}

function assertPinnedTemporaryGitChildPayload(payload) {
  if (
    !Array.isArray(payload?.args)
    || payload.args.length === 0
    || payload.args.some((value) => typeof value !== "string")
    || typeof payload.expected_cwd_real_path !== "string"
    || payload.expected_cwd_real_path === ""
    || !isPortableTemporaryChildPrefix(payload.child_prefix)
    || !Number.isFinite(payload.timeout_ms)
    || payload.timeout_ms <= 0
    || !payload.env
    || typeof payload.env !== "object"
    || Array.isArray(payload.env)
  ) {
    throw pinnedGitChildError("invalid_request");
  }
}

function isPortableTemporaryChildPrefix(value) {
  return typeof value === "string"
    && value.startsWith(".")
    && value.endsWith("-")
    && basename(value) === value
    && !value.includes("/")
    && !value.includes("\\");
}

function pinnedGitChildError(code) {
  const error = new Error(code);
  error.pinnedGitChildCode = code;
  return error;
}

function pinnedGitChildFailure(code, result = {}) {
  return {
    ok: false,
    code,
    exitCode: result.exitCode ?? null,
    timedOut: result.timedOut ?? false,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function writePinnedGitChildResult(result) {
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.ok) process.exitCode = 1;
}

export async function runPinnedTemporaryGitChildMode(argv = process.argv.slice(2)) {
  if (argv[0] !== PINNED_TEMPORARY_CHILD_MODE) return false;
  await runPinnedTemporaryGitChild();
  return true;
}

if (import.meta.main) {
  if (!await runPinnedTemporaryGitChildMode()) {
    throw new Error("git-lib.mjs je interní Git knihovna");
  }
}
