import {
  accessSync,
  constants,
  statSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import {
  delimiter,
  isAbsolute,
  join,
  resolve,
} from "node:path";
import { fileURLToPath } from "node:url";

const exactStableVersionPattern = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u;
const minimumStableVersionRangePattern = /^>=((?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*))$/u;

// One manifest of the default and minimum versions of Lazurio's tools
// (decision 0171, addendum of 2026-10-24, point 5): the scaffold, MS-02, the
// Doctor and Install Core read it, and LazurioPlatform and the Machines tool
// catalog hold parity tests against it. It ships beside package.json; the URL
// reference lets the npm package gate prove that it is packed.
// `package.json#packageManager` stays the exact Bun of Lazurio itself (0134),
// equal to `tools.bun.default` by test.
const toolchainManifestUrl = new URL("../toolchain.json", import.meta.url);
export const TOOLCHAIN_SCHEMA_VERSION = "lazurio.toolchain.v1";
// The tools and the versions each declares, every one required. Strict: an
// unknown tool or field is an error until Organizations may declare tools of
// their own in the same shape.
const toolchainFields = Object.freeze({
  bun: Object.freeze(["default", "minimum"]),
  node: Object.freeze(["minimum"]),
  uv: Object.freeze(["default"]),
  gh: Object.freeze(["minimum"]),
  git: Object.freeze(["minimum"]),
});

/** The toolchain manifest, validated and deeply frozen; `root` is the
 * directory of its `toolchain.json` (default: beside lazurio/package.json). */
export function readToolchainManifest({
  root = undefined,
  readText = (path) => readFileSync(path, "utf8"),
} = {}) {
  const path = root === undefined ? fileURLToPath(toolchainManifestUrl) : resolve(root, "toolchain.json");
  let manifest;
  try {
    manifest = JSON.parse(readText(path));
  } catch (error) {
    throw new Error(
      `Lazurio toolchain manifest cannot be read: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return validToolchainManifest(manifest);
}

function validToolchainManifest(manifest) {
  const invalid = (detail) => new Error(`Lazurio toolchain manifest is invalid: ${detail}`);
  const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
  if (!isObject(manifest)) throw invalid("it must be a JSON object");
  for (const key of Object.keys(manifest)) {
    if (key !== "schema_version" && key !== "tools") throw invalid(`unknown field ${key}`);
  }
  if (manifest.schema_version !== TOOLCHAIN_SCHEMA_VERSION) {
    throw invalid(`unknown schema_version ${JSON.stringify(manifest.schema_version)}`);
  }
  if (!isObject(manifest.tools)) throw invalid("tools must be an object");
  for (const tool of Object.keys(manifest.tools)) {
    if (!Object.hasOwn(toolchainFields, tool)) throw invalid(`unknown tool ${tool}`);
  }
  const tools = {};
  for (const [tool, fields] of Object.entries(toolchainFields)) {
    const entry = manifest.tools[tool];
    if (!isObject(entry)) throw invalid(`tools.${tool} is missing`);
    for (const key of Object.keys(entry)) {
      if (!fields.includes(key)) throw invalid(`tools.${tool}.${key} is not a field of ${tool}`);
    }
    for (const field of fields) {
      if (typeof entry[field] !== "string" || !exactStableVersionPattern.test(entry[field])) {
        throw invalid(`tools.${tool}.${field} must be an exact x.y.z version`);
      }
    }
    if (fields.includes("default") && fields.includes("minimum")
      && compareStableVersions(entry.minimum, entry.default) > 0) {
      throw invalid(`tools.${tool}.minimum ${entry.minimum} is above its default ${entry.default}`);
    }
    tools[tool] = Object.freeze(Object.fromEntries(fields.map((field) => [field, entry[field]])));
  }
  return Object.freeze({ schema_version: manifest.schema_version, tools: Object.freeze(tools) });
}

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

/** The supported Node.js range of a toolchain manifest: its minimum and up. */
export function requiredNodeVersionRange(toolchain) {
  return `>=${toolchain.tools.node.minimum}`;
}

// The toolchain manifest owns the Node.js minimum; `package.json#engines.node`
// is the same range for npm, held equal by test.
export function readRequiredNodeVersionRange(options = {}) {
  return requiredNodeVersionRange(readToolchainManifest(options));
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
  if (pathValue === "") return null;
  const pathDelimiter = platform === "win32" ? ";" : delimiter;
  const extensions = platform === "win32"
    ? (environment.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
      .split(";")
      .filter(Boolean)
      .map((extension) => extension.toLowerCase())
    : [""];
  for (const rawDirectory of pathValue.split(pathDelimiter)) {
    const unquoted = rawDirectory.replace(/^"|"$/gu, "");
    const directory = isAbsolute(unquoted) ? unquoted : resolve(cwd, unquoted);
    const candidates = platform === "win32"
      ? extensions.map((extension) => join(directory, `${command}${extension}`))
      : [join(directory, command)];
    for (const candidate of candidates) {
      try {
        const stat = statSync(candidate);
        if (!stat.isFile()) continue;
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

export function compareStableVersions(left, right) {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] !== rightParts[index]) return leftParts[index] - rightParts[index];
  }
  return 0;
}

// Package execution used by versioned repository scripts is `bun x`. A
// standalone `bunx` binary is optional: the official WinGet package may ship
// only `bun.exe`, and that must not fail a machine that can run `bun x`.
// Bun 1.4 prints the bunx usage contract and exits 1 when no package is
// supplied; only that exact sentinel counts as capability proof.
export const BUN_PACKAGE_RUNNER_PROBE_ARGS = Object.freeze(["x", "--help"]);
export function classifyBunPackageRunnerProbe({ exitCode = null, stdout = "", stderr = "" } = {}) {
  if (exitCode === 0) return "ready";
  if (exitCode === 1 && /Usage:\s+bunx\b/u.test(`${stdout ?? ""}\n${stderr ?? ""}`)) return "ready";
  return "unusable";
}

// Official, version-pinned Bun remedy. Doctor and Install Core only quote it;
// they never run it, and they never point at a third-party registry package.
export const OFFICIAL_BUN_INSTALL_DOCS_URL = "https://bun.com/docs/installation";
export function officialBunInstallCommand({ platform, version }) {
  if (!exactStableVersionPattern.test(version ?? "")) {
    throw new Error("official Bun install command requires an exact stable version");
  }
  if (platform === "win32") {
    // PowerShell form quoted verbatim from the official installation docs.
    return `iex "& {$(irm https://bun.com/install.ps1)} -Version ${version}"`;
  }
  if (platform === "darwin" || platform === "linux") {
    return `curl -fsSL https://bun.com/install | bash -s "bun-v${version}"`;
  }
  return null;
}

// Workstation executable selection belongs to the Principal's process PATH.
// Keep the selected shim path: resolving its symlink can change argv[0] behavior.
export function resolveGitExecutableOnPath(options = {}) {
  return resolveExecutableOnPath("git", options);
}
export function resolveGitHubCliExecutableOnPath(options = {}) {
  return resolveExecutableOnPath("gh", options);
}
export function resolveNodeExecutableOnPath(options = {}) {
  return resolveExecutableOnPath("node", options);
}

// Capability floors, independent of the optional latest-release lookup, from
// the toolchain manifest. Git: rev-parse --path-format; gh: auth status
// --active.
export function requiredToolVersions(toolchain) {
  return Object.freeze({ git: toolchain.tools.git.minimum, github_cli: toolchain.tools.gh.minimum });
}
export const REQUIRED_TOOL_VERSIONS = requiredToolVersions(readToolchainManifest());
export function classifyToolVersion(tool, output, minimums = REQUIRED_TOOL_VERSIONS) {
  const pattern = {
    git: /^git version (\d+\.\d+\.\d+)(?:[. -]|$)/u,
    github_cli: /^gh version (\d+\.\d+\.\d+)(?:[ (\r\n]|$)/u,
    codex: /^codex-cli (\d+\.\d+\.\d+)(?:[\r\n]|$)/u,
  }[tool];
  if (!pattern) throw new Error(`Unknown tool: ${tool}`);
  const current = pattern.exec(String(output ?? "").trim())?.[1] ?? null;
  const minimum = minimums[tool] ?? null;
  return { current_version: current, minimum_version: minimum,
    status: !current ? "unusable" : minimum && compareStableVersions(current, minimum) < 0 ? "incompatible" : "compatible" };
}
