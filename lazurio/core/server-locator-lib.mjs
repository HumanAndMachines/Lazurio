import { randomUUID } from "node:crypto";
import { existsSync, lstatSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, posix, resolve, win32 } from "node:path";

export const LAZURIO_SERVER_LOCATOR_SCHEMA = "lazurio.server.locator.v1";

export function resolveServerStateDirectory({
  platform = process.platform,
  environment = process.env,
  homeDirectory = homedir(),
} = {}) {
  if (platform === "win32") {
    const localAppData = typeof environment?.LOCALAPPDATA === "string"
      && win32.isAbsolute(environment.LOCALAPPDATA)
      ? environment.LOCALAPPDATA
      : win32.join(homeDirectory, "AppData", "Local");
    if (!win32.isAbsolute(localAppData)) {
      throw new TypeError("Lazurio Server state requires an absolute Windows user directory.");
    }
    return win32.join(win32.normalize(localAppData), "Lazurio");
  }

  if (!posix.isAbsolute(homeDirectory)) {
    throw new TypeError("Lazurio Server state requires an absolute user home directory.");
  }
  if (platform === "darwin") {
    return posix.join(homeDirectory, "Library", "Application Support", "Lazurio");
  }
  const xdgStateHome = typeof environment?.XDG_STATE_HOME === "string"
    && posix.isAbsolute(environment.XDG_STATE_HOME)
    ? environment.XDG_STATE_HOME
    : posix.join(homeDirectory, ".local", "state");
  return posix.join(xdgStateHome, "lazurio");
}

export function serverLocatorPath(stateDirectory) {
  if (typeof stateDirectory !== "string" || stateDirectory.trim() === "") {
    throw new TypeError("Server locator requires a per-user state directory.");
  }
  return joinForStateDirectory(stateDirectory, "server.json");
}

export function buildServerLocator({ origin, identity, writtenAt = new Date().toISOString() }) {
  const locator = {
    schema_version: LAZURIO_SERVER_LOCATOR_SCHEMA,
    origin: normalizeLoopbackOrigin(origin),
    root_id: identity?.root_id,
    control_root_id: identity?.control_root_id,
    instance_id: identity?.instance_id,
    install_generation: identity?.install_generation,
    written_at: writtenAt,
  };
  const errors = validateServerLocator(locator);
  if (errors.length > 0) {
    throw new TypeError(
      `Cannot build an invalid Lazurio Server locator: ${errors.join("; ")}`,
    );
  }
  return Object.freeze(locator);
}

export function validateServerLocator(locator) {
  const errors = [];
  if (!locator || typeof locator !== "object" || Array.isArray(locator)) {
    return ["locator must be a JSON object"];
  }
  const allowed = new Set([
    "schema_version",
    "origin",
    "root_id",
    "control_root_id",
    "instance_id",
    "install_generation",
    "written_at",
  ]);
  for (const key of Object.keys(locator)) {
    if (!allowed.has(key)) errors.push(`unknown property: ${key}`);
  }
  if (locator.schema_version !== LAZURIO_SERVER_LOCATOR_SCHEMA) {
    errors.push(`schema_version must be ${LAZURIO_SERVER_LOCATOR_SCHEMA}`);
  }
  try {
    if (normalizeLoopbackOrigin(locator.origin) !== locator.origin) {
      errors.push("origin must be canonical");
    }
  } catch (error) {
    errors.push(error.message);
  }
  for (const key of ["root_id", "control_root_id", "install_generation"]) {
    if (!/^[a-f0-9]{64}$/.test(locator[key] ?? "")) errors.push(`${key} must be a SHA-256 digest`);
  }
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(locator.instance_id ?? "")) {
    errors.push("instance_id must be a UUID");
  }
  if (typeof locator.written_at !== "string" || !Number.isFinite(Date.parse(locator.written_at))) {
    errors.push("written_at must be an ISO date-time");
  }
  return errors;
}

export async function readServerLocator({ stateDirectory }) {
  const locator = await readServerLocatorFile({ stateDirectory, allowMissing: false });
  return locator;
}

export async function readServerLocatorIfPresent({ stateDirectory }) {
  return readServerLocatorFile({ stateDirectory, allowMissing: true });
}

async function readServerLocatorFile({ stateDirectory, allowMissing }) {
  const path = serverLocatorPath(stateDirectory);
  let locator;
  try {
    locator = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (allowMissing && error?.code === "ENOENT") return null;
    throw new Error(`Lazurio Server locator ${path} cannot be read: ${error.message}`);
  }
  const errors = validateServerLocator(locator);
  if (errors.length > 0) throw new Error(`Lazurio Server locator is invalid: ${errors.join("; ")}`);
  return locator;
}

export async function writeServerLocator({
  stateDirectory,
  origin,
  identity,
  writeFileFn = writeFile,
  renameFn = rename,
  removeFileFn = rm,
}) {
  const locator = buildServerLocator({ origin, identity });
  const target = serverLocatorPath(stateDirectory);
  const directory = dirname(target);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  assertPhysicalDirectory(directory, "Lazurio Server state directory");
  const temporary = join(directory, `.${basename(target)}.${randomUUID()}.tmp`);
  try {
    await writeFileFn(temporary, `${JSON.stringify(locator, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await renameFn(temporary, target);
  } finally {
    await removeFileFn(temporary, { force: true }).catch(() => {});
  }
  return { path: target, locator };
}

function normalizeLoopbackOrigin(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("origin must be an absolute URL");
  }
  if (
    url.protocol !== "http:"
    || !["127.0.0.1", "localhost"].includes(url.hostname.toLowerCase())
    || !url.port
    || url.username
    || url.password
    || url.pathname !== "/"
    || url.search
    || url.hash
  ) {
    throw new Error("origin must be a clean loopback HTTP origin with an explicit port");
  }
  const port = Number(url.port);
  if (!Number.isInteger(port) || port < 1024 || port > 65_535) {
    throw new Error("origin port must be between 1024 and 65535");
  }
  return url.origin;
}

function assertPhysicalDirectory(path, label) {
  if (!existsSync(path)) throw new Error(`${label} does not exist: ${path}`);
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a physical directory: ${path}`);
  }
}

function joinForStateDirectory(directory, basename) {
  return /^[A-Za-z]:[\\/]/u.test(directory) || directory.startsWith("\\\\")
    ? win32.join(directory, basename)
    : join(resolve(directory), basename);
}
