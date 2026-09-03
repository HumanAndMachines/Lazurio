import {
  accessSync,
  constants,
  lstatSync,
  readFileSync,
  realpathSync,
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

export function nodeMinimumVersionFromEngines(nodeRange) {
  const match = /^>=(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u.exec(nodeRange ?? "");
  if (!match) {
    throw new Error("package.json#engines.node must declare one exact minimum stable Node.js version");
  }
  return `${match[1]}.${match[2]}.${match[3]}`;
}

export function readRequiredNodeMinimum({
  root = resolve(import.meta.dirname, ".."),
  readText = (path) => readFileSync(path, "utf8"),
} = {}) {
  let sourcePackage;
  try {
    sourcePackage = JSON.parse(readText(resolve(root, "package.json")));
  } catch (error) {
    throw new Error(
      `Lazurio Node.js version authority cannot be read: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return nodeMinimumVersionFromEngines(sourcePackage.engines?.node);
}

export function classifyNodeRuntime({ currentVersion, minimumVersion }) {
  const required = stableVersionParts(minimumVersion);
  if (!required) throw new Error("minimum Node.js version must be an exact stable version");
  const current = stableVersionParts(currentVersion);
  if (!current) {
    return Object.freeze({
      status: "unavailable",
      current_version: null,
      minimum_version: minimumVersion,
    });
  }
  return Object.freeze({
    status: compareVersionParts(current, required) >= 0 ? "current" : "outdated",
    current_version: current.join("."),
    minimum_version: minimumVersion,
  });
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

export function executablePathsMatch(first, second, {
  platform = process.platform,
  canonicalize = (path) => realpathSync.native(path),
} = {}) {
  if (typeof first !== "string" || first === "" || typeof second !== "string" || second === "") {
    return false;
  }
  const comparable = (path) => {
    const normalized = resolve(path).replace(/[\\/]+$/u, "");
    return platform === "win32" ? normalized.toLowerCase() : normalized;
  };
  if (comparable(first) === comparable(second)) return true;
  try {
    return comparable(canonicalize(first)) === comparable(canonicalize(second));
  } catch {
    return false;
  }
}

function environmentPathValue(environment, platform) {
  if (platform !== "win32") return environment.PATH ?? "";
  const entry = Object.entries(environment).find(([name]) => name.toLowerCase() === "path");
  return entry?.[1] ?? "";
}

function stableVersionParts(value) {
  const match = /^v?(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:[-+].*)?$/u.exec(value ?? "");
  return match ? match.slice(1, 4).map(Number) : null;
}

function compareVersionParts(first, second) {
  for (let index = 0; index < first.length; index += 1) {
    if (first[index] !== second[index]) return first[index] - second[index];
  }
  return 0;
}
