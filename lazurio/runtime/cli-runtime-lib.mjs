// The Bun the Lazurio CLI runs on (decision 0134 with its addendum of
// 2026-10-24): exactly the version `lazurio/package.json#packageManager`
// pins, like an App's pinned Bun (decision 0171, addendum of 2026-10-24),
// while the user's own Bun only needs `tools.bun.minimum` of
// lazurio/toolchain.json. The `lazurio` command (cli.mjs) decides here:
//
//   1. on that Bun already, the CLI (cli-main.mjs) runs in this process;
//   2. otherwise the Apps' resolver gives that Bun, from Lazurio's runtime
//      cache or fetched into it with the user's Bun, and the CLI runs
//      re-executed on it (`<exact bun> cli-main.mjs …`) with the loop guard
//      LAZURIO_CLI_BUN=<pin>, stdio, signals and exit code passed through;
//   3. only when that Bun cannot be had offline (`runtime-unavailable`) does
//      the CLI run on the user's Bun, with one line on stderr: a visible
//      degraded mode, so that `lazurio update` and the Doctor that repair it
//      still run; the Doctor fails `platform.cli_runtime` meanwhile;
//   4. every other refusal, and a guard that still sees another Bun, stops
//      with exit 2.
//
// This module loads the toolchain and the resolver only when it needs them:
// whatever it imports, the `lazurio` command imports before it can decide.

/** The loop guard: the exact Bun a re-executed CLI must run on. */
export const CLI_BUN_ENV = "LAZURIO_CLI_BUN";

// The signals a re-executed CLI receives from its launcher, as the Launchpad
// server launcher forwards them; Windows has no POSIX SIGHUP to forward.
const forwardedSignals = Object.freeze(["SIGINT", "SIGTERM", "SIGHUP"]);
const forwardedSignalsFor = (platform) => (platform === "win32" ? forwardedSignals.slice(0, 2) : forwardedSignals);

/** The one line of the degraded mode (point 3 above). */
export function cliRuntimeFallbackLine({ pin, running }) {
  return `lazurio: přesný Bun ${pin} není dostupný offline, Lazurio běží na Bunu ${running}. Spusťte lazurio update s připojením k internetu.`;
}

// A CLI under the loop guard that runs on another Bun than the guard names:
// it neither runs nor starts again.
function cliBunLoopLine({ pin, running }) {
  return `lazurio: Lazurio se mělo znovu spustit na svém přesném Bunu ${pin} (${CLI_BUN_ENV}=${pin}), ale běží na Bunu ${running ?? "neznámé verze"}, takže se znovu nespustí. Požádejte agenta, ať zkontroluje mezipaměť runtime Lazuria.`;
}

/** The re-executed CLI's side of the loop guard: it consumes the guard, so
 * nothing the CLI starts inherits it, and answers the line to stop with when
 * this process does not run on the Bun the guard names; null otherwise. */
export function cliBunMarkerRefusal({ env = process.env, runningVersion = process.versions.bun } = {}) {
  if (!Object.hasOwn(env, CLI_BUN_ENV)) return null;
  const pin = env[CLI_BUN_ENV];
  delete env[CLI_BUN_ENV];
  return pin === runningVersion ? null : cliBunLoopLine({ pin, running: runningVersion });
}

// The CLI's exact Bun version, by the one authority of decision 0134.
async function readCliBunPin(packageRoot) {
  const { readRequiredBunVersion } = await import("../core/toolchain-lib.mjs");
  return readRequiredBunVersion({ root: packageRoot });
}

// That version as the Apps' resolver gives it: the user's Bun installs it
// into the shared runtime cache, nothing else on the machine changes.
async function resolveCliBun({ pin, packageRoot, execPath, env, platform }) {
  const { createModuleBunResolver } = await import("./bun-runtime-lib.mjs");
  return createModuleBunResolver({ userBun: execPath, env, platform })({
    packageManager: `bun@${pin}`,
    owner: packageRoot,
  });
}

// A refusal of the resolver (`BunRuntimeRefused`), told by its name so this
// module need not load the resolver to recognise one.
const runtimeRefusal = (error) => error instanceof Error
  && error.name === "BunRuntimeRefused"
  && typeof error.reason === "string";

/**
 * One `lazurio` invocation on the CLI's exact Bun (the points above). Answers
 * how this process should end: `{ code }`, or `{ code, signal }` when the
 * re-executed CLI ended by a signal (`code` is then 128 + its number, as Bun
 * reports it). `loadMain` loads cli-main.mjs's `main` only when the CLI runs
 * in this process; `mainPath` is that file for a re-execution.
 */
export async function launchLazurioCli({
  argv,
  packageRoot,
  mainPath,
  loadMain,
  env = process.env,
  runningVersion = process.versions.bun,
  execPath = process.execPath,
  platform = process.platform,
  // Seams of the tests: the pin, the resolution, the child and this process.
  readPin = readCliBunPin,
  resolveBun = resolveCliBun,
  spawnProcess = (command, options) => Bun.spawn(command, options),
  processObject = process,
  writeError = (line) => console.error(line),
}) {
  let pin;
  try {
    pin = await readPin(packageRoot);
  } catch (error) {
    writeError(`lazurio: ${error.message}`);
    return { code: 2 };
  }
  if (runningVersion === pin) {
    // Nothing this CLI starts carries a guard of an earlier launch.
    delete env[CLI_BUN_ENV];
    return { code: await (await loadMain())(argv) };
  }
  if (env[CLI_BUN_ENV] === pin) {
    writeError(cliBunLoopLine({ pin, running: runningVersion }));
    return { code: 2 };
  }

  let bun;
  try {
    bun = await resolveBun({ pin, packageRoot, execPath, env, platform });
  } catch (error) {
    if (runtimeRefusal(error) && error.reason === "runtime-unavailable") {
      writeError(cliRuntimeFallbackLine({ pin, running: runningVersion }));
      return { code: await (await loadMain())(argv) };
    }
    writeError(`lazurio: ${error.message}`);
    return { code: 2 };
  }

  let child;
  try {
    child = spawnProcess([bun.executable, mainPath, ...argv], {
      env: { ...env, [CLI_BUN_ENV]: pin },
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
  } catch (error) {
    writeError(`lazurio: ${error.message}`);
    return { code: 2 };
  }
  const handlers = [];
  for (const signal of forwardedSignalsFor(platform)) {
    const handler = () => {
      try {
        child.kill(signal);
      } catch {
        // The child may already be ending from the same terminal signal.
      }
    };
    handlers.push([signal, handler]);
    processObject.on(signal, handler);
  }
  try {
    const code = await child.exited;
    return child.signalCode ? { code, signal: child.signalCode } : { code: child.exitCode ?? code };
  } finally {
    for (const [signal, handler] of handlers) processObject.off(signal, handler);
  }
}

/** This process ends as the launch answered: with its exit code, or, off
 * Windows, by the signal that ended the re-executed CLI (its handlers are
 * gone by then, so the signal's own action ends it). */
export function finishLazurioCli(outcome, { processObject = process, platform = process.platform } = {}) {
  processObject.exitCode = outcome.code;
  if (outcome.signal && platform !== "win32") processObject.kill(processObject.pid, outcome.signal);
}

/** The `lazurio` command: launch, then end as the launch answered. */
export async function runLazurioCli(options) {
  finishLazurioCli(await launchLazurioCli(options), {
    processObject: options.processObject,
    platform: options.platform,
  });
}
