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
const minimumStableVersionRangePattern = /^>=((?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*))$/u;

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

export function nodeVersionRangeFromEngines(engines) {
  const range = engines?.node;
  if (typeof range !== "string" || !minimumStableVersionRangePattern.test(range)) {
    throw new Error("package.json#engines.node must declare one minimum stable Node.js version");
  }
  return range;
}

export function readRequiredNodeVersionRange({
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
  return nodeVersionRangeFromEngines(sourcePackage.engines);
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

export function classifyNodeRuntime({ currentVersion, requiredRange }) {
  const minimumMatch = minimumStableVersionRangePattern.exec(requiredRange ?? "");
  if (!minimumMatch) {
    throw new Error("required Node.js range must declare one minimum stable version");
  }
  if (typeof currentVersion !== "string" || !exactStableVersionPattern.test(currentVersion)) {
    return Object.freeze({
      status: "unavailable",
      current_version: null,
      required_range: requiredRange,
    });
  }
  return Object.freeze({
    status: compareStableVersions(currentVersion, minimumMatch[1]) >= 0 ? "compatible" : "incompatible",
    current_version: currentVersion,
    required_range: requiredRange,
  });
}

export function nodeVersionFromOutput(output) {
  if (typeof output !== "string") return null;
  const match = /^v?((?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*))$/u
    .exec(output.trim());
  return match?.[1] ?? null;
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

function compareStableVersions(left, right) {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] !== rightParts[index]) return leftParts[index] - rightParts[index];
  }
  return 0;
}
