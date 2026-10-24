// The built version of an App from `main` on a computer (decision 0212 point
// 9, Module Standard 4.5 and 4.6). Until computers get the LazurioPlatform
// Launchpad (plan DEV-6628), the root Launchpad and `lazurio update` build an
// App that declares `build_output` (a static App) or `start_script` (an App
// with its own server and, optionally, a built client) with the same
// declaration and into the same cache layout as the Platform (F58): one build
// per key, outside the checkout, never changed once there. No watcher, no
// background swap: an Open from `main` builds when the key has no build yet,
// and `lazurio update` builds the new key of a moved Module.
//
//   <cache>/<organization>/<module>/<app id>-<digest of the package dir>/
//     build.json      current, previous and the last failure (Platform shape)
//     served.json     the key the App's last built start serves
//     <key>/          the output of one build
//     logs/<key>.log  the output of the build of that key
import { createHash, randomBytes } from "node:crypto";
import { cp, lstat, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, posix, relative, sep, win32 } from "node:path";
import { runGit } from "./git-lib.mjs";
import { acquireModuleRuntimeLock } from "./module-runtime-lock-lib.mjs";
import { resolveStaticRequest } from "./static-build-server.mjs";
import { trustedWindowsSystemExecutable } from "./windows-system-path-lib.mjs";

/** A build that runs longer is ended (the Platform's bound, F58 point 4). */
export const BUILD_TIMEOUT_MS = 10 * 60_000;

const KEY_PATTERN = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const NAME_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const STATE_SCHEMA = "lazurio.build-state.v1";
const SERVED_SCHEMA = "lazurio.build-served.v1";

/** What a person reads about a build that failed, with or without a
 * previous build to run instead (the Platform's words, F58 point 9). */
export const BUILD_FINDING_MESSAGES = Object.freeze({
  previous: "Nejnovější verzi se nepodařilo sestavit. Dál běží předchozí verze.",
  none: "Aplikaci se nepodařilo sestavit.",
});

/**
 * How an App runs from `main`: `static` (its build, served by the root's
 * static server), `server` (its own production process) or null (its
 * development script, until the cutover of decision 0212 point 8).
 */
export function builtAppMode(app) {
  if (app?.runtime_contract?.schema_version !== "lazurio.runtime.v1") return null;
  if (typeof app.start_script === "string" && app.start_script !== "") return "server";
  if (typeof app.build_output === "string" && app.build_output !== "") return "static";
  return null;
}

/**
 * The account's build cache: `${XDG_CACHE_HOME:-~/.cache}/lazurio/builds` on
 * macOS and Linux (the Platform's path, also on macOS), and
 * `%LOCALAPPDATA%\Lazurio\cache\builds` on Windows.
 */
export function buildCacheRoot({ platform = process.platform, env = process.env, homeDirectory = homedir() } = {}) {
  if (platform === "win32") {
    const local = typeof env?.LOCALAPPDATA === "string" && win32.isAbsolute(env.LOCALAPPDATA)
      ? env.LOCALAPPDATA
      : win32.join(homeDirectory, "AppData", "Local");
    return win32.join(local, "Lazurio", "cache", "builds");
  }
  const cache = typeof env?.XDG_CACHE_HOME === "string" && posix.isAbsolute(env.XDG_CACHE_HOME)
    ? env.XDG_CACHE_HOME
    : posix.join(homeDirectory, ".cache");
  return posix.join(cache, "lazurio", "builds");
}

/** The directory of one App's builds; the digest of its canonical package
 * directory keeps two checkouts of one Module apart. */
export function appBuildDirectory(cacheRoot, { organization, module, appId, applicationDirectory }) {
  for (const part of [organization, module, appId]) {
    if (typeof part !== "string" || !NAME_SEGMENT.test(part)) {
      throw new Error(`Build directory name ${String(part)} is not a safe segment.`);
    }
  }
  const digest = createHash("sha256").update(String(applicationDirectory)).digest("hex").slice(0, 12);
  return join(cacheRoot, organization, module, `${appId}-${digest}`);
}

/**
 * The key of a build, the same as the Platform's: the Module's commit when
 * the build reads nothing else, otherwise the digest of that commit and of
 * every other checkout it reads (its data repository, its required slots).
 */
export function buildKeyOf(commit, inputs = []) {
  if (inputs.length === 0) return commit;
  return createHash("sha256")
    .update(`lazurio.build-key.v1\n. ${commit}\n${inputs
      .map((input) => `${input.path} ${input.commit ?? "absent"}`)
      .sort()
      .join("\n")}\n`)
    .digest("hex");
}

/** The environment of a build: the App's closed environment without anything
 * of where it is served, in production mode (F58 point 4). */
export function buildEnvironment(env) {
  const result = { ...env };
  for (const name of Object.keys(result)) {
    if (name.startsWith("LAZURIO_RUNTIME_")) delete result[name];
  }
  delete result.HOST;
  delete result.PORT;
  result.NODE_ENV = "production";
  return result;
}

/**
 * The build of the App's current key, built now when there is none. Returns
 * `{ ok: true, mode, key, commit, output, directory, built, finding }`, where
 * `output` is the build to serve or hand over (null for a server App without
 * a client) and `finding` says that the newest key failed and an earlier
 * build is used; or `{ ok: false, mode, finding }` when there is nothing to
 * run. `retryFailed: false` returns a recorded failure of the current key
 * without building it again (an Open of an App that already runs).
 */
export async function ensureAppBuild({
  app,
  cwd,
  checkoutRoot,
  organizationRoot = null,
  cacheRoot,
  bunExecutable,
  env = process.env,
  retryFailed = true,
  instanceId = "lazurio-build",
  spawnProcess = Bun.spawn,
  timeoutMs = BUILD_TIMEOUT_MS,
  platform = process.platform,
  now = () => new Date(),
}) {
  const mode = builtAppMode(app);
  if (mode === null) throw new Error(`${app?.id ?? "App"} declares no built version.`);
  const readContext = async () => {
    const commit = await readCommit(checkoutRoot);
    if (commit === null) return null;
    const inputs = mode === "static" ? await buildInputs({ app, checkoutRoot, organizationRoot }) : [];
    return { commit, inputs, key: buildKeyOf(commit, inputs) };
  };
  let context = await readContext();
  // A server without a client builds nothing: its key is its commit.
  if (mode === "server" && typeof app.build_output !== "string") {
    if (context === null) return { ok: false, mode, finding: finding("checkout-unreadable", null, null, null, false) };
    return { ok: true, mode, key: context.key, commit: context.commit, output: null, directory: null, built: false, finding: null };
  }
  const directory = appBuildDirectory(cacheRoot, {
    organization: app.company,
    module: app.module,
    appId: app.id,
    applicationDirectory: cwd,
  });
  const state = await readState(directory);
  const fallback = async (reason, key, commit) => {
    const previous = state?.current ? await outputOf(directory, state.current.key) : null;
    const log = key ? logPathOf(directory, key) : null;
    return previous
      ? {
          ok: true, mode, key: state.current.key, commit: state.current.commit, output: previous,
          directory, built: false, finding: finding(reason, key, commit, log, true),
        }
      : { ok: false, mode, directory, finding: finding(reason, key, commit, log, false) };
  };
  if (context === null) return fallback("checkout-unreadable", null, null);
  const ready = await outputOf(directory, context.key);
  if (ready) return built(mode, context, ready, directory, false);
  if (!retryFailed && state?.failure?.key === context.key) {
    return fallback(state.failure.reason, context.key, context.commit);
  }

  await mkdir(join(directory, "logs"), { recursive: true });
  const lock = await acquireModuleRuntimeLock({
    root: directory,
    key: `build/${app.company}/${app.module}/${app.id}`,
    instanceId,
    timeoutMs: timeoutMs + 60_000,
    pollMs: 500,
  });
  try {
    // A pull during a build builds the new commit instead, at most three times.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const existing = await outputOf(directory, context.key);
      if (existing) return built(mode, context, existing, directory, false);
      const startedAt = now();
      const result = await runBuild({
        app, mode, cwd, checkoutRoot, logPath: logPathOf(directory, context.key),
        bunExecutable, env, spawnProcess, timeoutMs, platform,
      });
      const latest = await readState(directory);
      if (!result.ok) {
        await writeState(directory, {
          ...stateBase(app, cwd, checkoutRoot, latest),
          failure: { key: context.key, commit: context.commit, at: now().toISOString(), reason: result.reason },
        });
        return fallback(result.reason, context.key, context.commit);
      }
      const after = await readContext();
      if (after === null) break;
      if (after.key !== context.key) {
        context = after;
        continue;
      }
      const output = await installOutput(result.outputPath, directory, context.key, platform);
      const current = {
        key: context.key,
        commit: context.commit,
        inputs: context.inputs,
        dirty: result.dirty,
        at: startedAt.toISOString(),
      };
      const previous = latest?.current && latest.current.key !== context.key
        ? latest.current
        : latest?.previous ?? null;
      await writeState(directory, {
        ...stateBase(app, cwd, checkoutRoot, latest),
        current,
        previous,
        failure: null,
      });
      const served = await readJson(join(directory, "served.json"));
      await collect(directory, new Set([
        current.key,
        previous?.key,
        typeof served?.key === "string" ? served.key : null,
      ].filter(Boolean)));
      return built(mode, context, output, directory, true);
    }
    const latest = await readState(directory);
    await writeState(directory, {
      ...stateBase(app, cwd, checkoutRoot, latest),
      failure: { key: context.key, commit: context.commit, at: now().toISOString(), reason: "checkout-changing" },
    });
    return fallback("checkout-changing", context.key, context.commit);
  } finally {
    await lock.release().catch(() => {});
  }
}

/** Records which build the App's started process serves, so that a later
 * build never removes it while it runs (written whole, by a rename). */
export async function recordServedBuild(directory, { key, commit }) {
  if (!directory || !KEY_PATTERN.test(String(key))) return;
  await mkdir(directory, { recursive: true });
  await writeJson(join(directory, "served.json"), {
    schema_version: SERVED_SCHEMA,
    mode: "built",
    key,
    commit,
    at: new Date().toISOString(),
  });
}

function built(mode, context, output, directory, builtNow) {
  return {
    ok: true,
    mode,
    key: context.key,
    commit: context.commit,
    output,
    directory,
    built: builtNow,
    finding: null,
  };
}

function finding(reason, key, commit, logPath, previous) {
  return {
    reason,
    key,
    commit,
    log_path: logPath,
    message: previous ? BUILD_FINDING_MESSAGES.previous : BUILD_FINDING_MESSAGES.none,
  };
}

function stateBase(app, cwd, checkoutRoot, latest) {
  return {
    schema_version: STATE_SCHEMA,
    organization: app.company,
    module: app.module,
    // The App's package, relative to its Module, as the Platform names it.
    app: relative(checkoutRoot, join(cwd, "package.json")).split(sep).join("/"),
    current: latest?.current ?? null,
    previous: latest?.previous ?? null,
    building: null,
    failure: latest?.failure ?? null,
  };
}

async function runBuild({ app, mode, cwd, checkoutRoot, logPath, bunExecutable, env, spawnProcess, timeoutMs, platform }) {
  const outputPath = join(cwd, ...app.build_output.split("/"));
  // Fail closed on a stale output: whatever is there now was not built from
  // this key, so the build must write it again.
  await rm(outputPath, { recursive: true, force: true });
  const dirty = await readDirty(checkoutRoot);
  let child;
  try {
    child = spawnProcess([bunExecutable, "--no-env-file", "run", app.build_script], {
      cwd,
      env: buildEnvironment(env),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
      detached: platform !== "win32",
    });
  } catch (error) {
    await writeFile(logPath, `$ bun --no-env-file run ${app.build_script}\n${error.message}\n`, "utf8");
    return { ok: false, reason: "build-script-failed" };
  }
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    void endProcessTree(child, platform, env);
  }, timeoutMs);
  const [stdout, stderr, exitCode] = await Promise.all([
    child.stdout ? new Response(child.stdout).text().catch(() => "") : "",
    child.stderr ? new Response(child.stderr).text().catch(() => "") : "",
    child.exited,
  ]);
  clearTimeout(timer);
  await writeFile(
    logPath,
    `$ bun --no-env-file run ${app.build_script}\n${stdout}${stderr}\n[exit ${exitCode}]\n`,
    "utf8",
  );
  if (timedOut) return { ok: false, reason: "build-timed-out" };
  if (exitCode !== 0) return { ok: false, reason: "build-script-failed" };
  if (!await isDirectory(outputPath)) return { ok: false, reason: "build-output-missing" };
  if (mode === "static") {
    const healthPath = String(app.entrypoint_listener?.health?.path ?? "/").split("?")[0] || "/";
    const answer = await resolveStaticRequest(outputPath, healthPath, app.static_fallback ?? "404");
    if (answer.kind !== "file" || answer.status !== 200) return { ok: false, reason: "build-output-unservable" };
  }
  return { ok: true, outputPath, dirty };
}

async function endProcessTree(child, platform, env) {
  try {
    if (platform === "win32") {
      const taskkill = trustedWindowsSystemExecutable(["System32", "taskkill.exe"], env);
      await Bun.spawn([taskkill, "/PID", String(child.pid), "/T", "/F"], {
        stdout: "ignore",
        stderr: "ignore",
        windowsHide: true,
      }).exited;
    } else {
      process.kill(-child.pid, "SIGKILL");
    }
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {}
  }
}

// Copies a finished build in and makes it the directory of its key in one
// rename, so that a reader sees the whole output or none.
async function installOutput(source, directory, key, platform) {
  const incoming = join(directory, `.incoming-${randomBytes(6).toString("hex")}`);
  const target = join(directory, key);
  try {
    await cp(source, incoming, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true });
    if (await isDirectory(target)) {
      const retired = join(directory, `.retired-${randomBytes(6).toString("hex")}`);
      await renameWithRetry(target, retired, platform);
      await rm(retired, { recursive: true, force: true });
    }
    await renameWithRetry(incoming, target, platform);
    return target;
  } catch (error) {
    await rm(incoming, { recursive: true, force: true });
    throw error;
  }
}

// Windows refuses a rename for a moment while a scanner holds a new file.
async function renameWithRetry(from, to, platform) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      if (platform !== "win32" || attempt >= 5 || !["EPERM", "EBUSY", "EACCES"].includes(error?.code)) throw error;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 200));
    }
  }
}

async function collect(directory, keep) {
  for (const entry of await readdir(directory).catch(() => [])) {
    if ((KEY_PATTERN.test(entry) && !keep.has(entry)) || entry.startsWith(".incoming-") || entry.startsWith(".retired-")) {
      await rm(join(directory, entry), { recursive: true, force: true });
    }
  }
  for (const entry of await readdir(join(directory, "logs")).catch(() => [])) {
    const key = entry.replace(/\.log$/, "");
    if (entry.endsWith(".log") && KEY_PATTERN.test(key) && !keep.has(key)) {
      await rm(join(directory, "logs", entry), { force: true });
    }
  }
}

// The other checkouts a static build reads, by their Organization-relative
// path: the Module's data repository (`<module>/db`, when it is a checkout)
// and the slots the App requires. A server App reads its data at run time,
// so its key is its commit alone (F58 addendum (2) point 2).
async function buildInputs({ app, checkoutRoot, organizationRoot }) {
  if (!organizationRoot) return [];
  const paths = new Set();
  const dataMount = join(checkoutRoot, "db");
  const dataPath = relative(organizationRoot, dataMount);
  if (await hasOwnGit(dataMount) && dataPath && !dataPath.startsWith("..")) {
    paths.add(dataPath.split(sep).join("/"));
  }
  for (const slot of Array.isArray(app.required_module_slots) ? app.required_module_slots : []) {
    if (typeof slot === "string" && slot !== "") paths.add(slot);
  }
  const inputs = [];
  for (const path of [...paths].sort()) {
    inputs.push({ path, commit: await readCommit(join(organizationRoot, ...path.split("/"))) });
  }
  return inputs;
}

async function readCommit(directory) {
  if (!await hasOwnGit(directory)) return null;
  const result = await runGit(["rev-parse", "--verify", "HEAD^{commit}"], { cwd: directory });
  const commit = result.ok ? result.stdout.trim() : "";
  return KEY_PATTERN.test(commit) ? commit : null;
}

async function readDirty(directory) {
  const result = await runGit(["status", "--porcelain=v1", "--untracked-files=normal", "--ignore-submodules=all"], {
    cwd: directory,
  });
  return result.ok ? result.stdout.trim() !== "" : false;
}

// Only a directory with its own `.git` is a checkout: Git would otherwise
// answer with the commit of the repository around it.
async function hasOwnGit(directory) {
  try {
    await lstat(join(directory, ".git"));
    return true;
  } catch {
    return false;
  }
}

async function isDirectory(path) {
  try {
    return (await lstat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function outputOf(directory, key) {
  if (!KEY_PATTERN.test(String(key))) return null;
  const path = join(directory, key);
  return await isDirectory(path) ? path : null;
}

function logPathOf(directory, key) {
  return join(directory, "logs", `${key}.log`);
}

async function readState(directory) {
  const value = await readJson(join(directory, "build.json"));
  if (value?.schema_version !== STATE_SCHEMA) return null;
  const record = (item) => item && KEY_PATTERN.test(String(item.key)) && typeof item.commit === "string" ? item : null;
  return {
    ...value,
    current: record(value.current),
    previous: record(value.previous),
    failure: value.failure && typeof value.failure.key === "string" && typeof value.failure.reason === "string"
      ? value.failure
      : null,
  };
}

async function writeState(directory, state) {
  await writeJson(join(directory, "build.json"), state);
}

async function readJson(path) {
  try {
    const entry = await lstat(path);
    if (!entry.isFile() || entry.size > 64 * 1024) return null;
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

// Written whole or not at all: a temporary file renamed over the old one.
async function writeJson(path, value) {
  const temporary = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: "wx" });
  try {
    await renameWithRetry(temporary, path, process.platform);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}
