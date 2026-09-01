import {
  accessSync,
  constants,
  lstatSync,
  readFileSync,
} from "node:fs";
import {
  delimiter,
  isAbsolute,
  join,
  resolve,
} from "node:path";

const exactStableVersionPattern = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u;

export function bunVersionFromPackageManager(packageManager) {
  const match = /^bun@(.+)$/u.exec(packageManager ?? "");
  if (!match || !exactStableVersionPattern.test(match[1])) {
    throw new Error("package.json#packageManager must pin an exact stable Bun version");
  }
  return match[1];
}

export function readRequiredBunVersion({
  root = resolve(import.meta.dirname, ".."),
  readText = (path) => readFileSync(path, "utf8"),
} = {}) {
  let sourcePackage;
  try {
    sourcePackage = JSON.parse(readText(resolve(root, "package.json")));
  } catch (error) {
    throw new Error(
      `Lazurio Bun version authority cannot be read: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return bunVersionFromPackageManager(sourcePackage.packageManager);
}

export function classifyBunRuntime({ currentVersion, requiredVersion }) {
  if (!exactStableVersionPattern.test(requiredVersion ?? "")) {
    throw new Error("required Bun version must be an exact stable version");
  }
  if (typeof currentVersion !== "string" || currentVersion === "") {
    return Object.freeze({ status: "unavailable", current_version: null, required_version: requiredVersion });
  }
  return Object.freeze({
    status: currentVersion === requiredVersion ? "current" : "mismatch",
    current_version: currentVersion,
    required_version: requiredVersion,
  });
}

export function resolveExecutableOnPath(command, {
  environment = process.env,
  platform = process.platform,
  cwd = process.cwd(),
} = {}) {
  if (typeof command !== "string" || !/^[A-Za-z0-9._-]+$/u.test(command)) return null;
  const pathValue = environmentPathValue(environment, platform);
  const pathDelimiter = platform === "win32" ? ";" : delimiter;
  const extensions = platform === "win32"
    ? (environment.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
      .split(";")
      .filter(Boolean)
      .map((extension) => extension.toLowerCase())
    : [""];
  for (const rawDirectory of pathValue.split(pathDelimiter)) {
    const unquoted = rawDirectory.replace(/^"|"$/gu, "");
    if (!unquoted) continue;
    const directory = isAbsolute(unquoted) ? unquoted : resolve(cwd, unquoted);
    const candidates = platform === "win32"
      ? extensions.map((extension) => join(directory, `${command}${extension}`))
      : [join(directory, command)];
    for (const candidate of candidates) {
      try {
        const stat = lstatSync(candidate);
        if (!stat.isFile() && !stat.isSymbolicLink()) continue;
        if (platform !== "win32") accessSync(candidate, constants.X_OK);
        return resolve(candidate);
      } catch {
        // Continue through PATH just like a shell resolver.
      }
    }
  }
  return null;
}

function environmentPathValue(environment, platform) {
  if (platform !== "win32") return environment.PATH ?? "";
  const entry = Object.entries(environment).find(([name]) => name.toLowerCase() === "path");
  return entry?.[1] ?? "";
}
