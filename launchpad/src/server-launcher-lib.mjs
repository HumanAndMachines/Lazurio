import { link, lstat, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LAZURIO_LAUNCHPAD_NAME } from "./launchpad-identity-lib.mjs";

const forwardedSignals = Object.freeze(["SIGINT", "SIGTERM", "SIGHUP"]);

export async function prepareLaunchpadServerExecutable({
  platform = process.platform,
  executablePath = process.execPath,
  temporaryRoot = tmpdir(),
  createTemporaryDirectory = mkdtemp,
  createHardLink = link,
  readPathStat = lstat,
  resolveRealPath = realpath,
  removePath = rm,
} = {}) {
  if (platform !== "darwin") {
    return {
      executablePath,
      canonicalExecutablePath: executablePath,
      branded: false,
      warning: null,
      cleanup: async () => {},
    };
  }

  let temporaryDirectory = null;
  try {
    const canonicalExecutablePath = await resolveRealPath(executablePath);
    const sourceStat = await readPathStat(canonicalExecutablePath);
    if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) {
      throw processIdentityError("canonical Bun executable is not a physical file");
    }

    temporaryDirectory = await createTemporaryDirectory(join(temporaryRoot, "lazurio-launchpad-"));
    const namedExecutablePath = join(temporaryDirectory, LAZURIO_LAUNCHPAD_NAME);
    await createHardLink(canonicalExecutablePath, namedExecutablePath);
    const namedStat = await readPathStat(namedExecutablePath);
    if (
      !namedStat.isFile()
      || namedStat.isSymbolicLink()
      || namedStat.dev !== sourceStat.dev
      || namedStat.ino !== sourceStat.ino
    ) {
      throw processIdentityError("named executable is not the exact Bun hardlink");
    }

    let cleanupPromise = null;
    return {
      executablePath: namedExecutablePath,
      canonicalExecutablePath,
      branded: true,
      warning: null,
      temporaryDirectory,
      cleanup: () => {
        cleanupPromise ??= removePath(temporaryDirectory, { recursive: true, force: true });
        return cleanupPromise;
      },
    };
  } catch (error) {
    if (temporaryDirectory) {
      await removePath(temporaryDirectory, { recursive: true, force: true }).catch(() => {});
    }
    return {
      executablePath,
      canonicalExecutablePath: executablePath,
      branded: false,
      warning:
        `${LAZURIO_LAUNCHPAD_NAME}: pojmenování macOS procesu není dostupné `
        + `(${failureReason(error)}); spouštím kanonický Bun runtime.`,
      cleanup: async () => {},
    };
  }
}

export async function launchLazurioLaunchpadServer({
  args = [],
  serverPath,
  platform = process.platform,
  executablePath = process.execPath,
  environment = process.env,
  cwd = process.cwd(),
  prepareExecutable = prepareLaunchpadServerExecutable,
  spawnProcess = (command, options) => Bun.spawn(command, options),
  processObject = process,
  warn = console.warn,
} = {}) {
  if (typeof serverPath !== "string" || serverPath === "") {
    throw new TypeError("Lazurio Launchpad server launcher requires an absolute server path.");
  }
  const prepared = await prepareExecutable({ platform, executablePath });
  if (prepared.warning) warn(prepared.warning);

  let child = null;
  const signalHandlers = new Map();
  try {
    child = spawnProcess(
      [prepared.executablePath, serverPath, ...args],
      {
        cwd,
        env: environment,
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
      },
    );
    for (const signal of forwardedSignalsFor(platform)) {
      const handler = () => {
        try {
          child.kill(signal);
        } catch {
          // The child may already be exiting from the same terminal signal.
        }
      };
      signalHandlers.set(signal, handler);
      processObject.on?.(signal, handler);
    }
    return await child.exited;
  } finally {
    for (const [signal, handler] of signalHandlers) {
      processObject.off?.(signal, handler);
    }
    try {
      await prepared.cleanup();
    } catch (error) {
      warn(
        `${LAZURIO_LAUNCHPAD_NAME}: dočasný pojmenovaný executable nelze uklidit `
        + `(${failureReason(error)}).`,
      );
    }
  }
}

function forwardedSignalsFor(platform) {
  return platform === "win32" ? forwardedSignals.slice(0, 2) : forwardedSignals;
}

function processIdentityError(message) {
  const error = new Error(message);
  error.code = "LAZURIO_LAUNCHPAD_PROCESS_IDENTITY_INVALID";
  return error;
}

function failureReason(error) {
  const code = typeof error?.code === "string" ? error.code : "verification_failed";
  return /^[A-Z0-9_]+$/u.test(code) ? code : "verification_failed";
}
