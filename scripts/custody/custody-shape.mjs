#!/usr/bin/env bun
// Shows the structure of local secret custody files without their values:
// key paths, value types and lengths, the KEY names of `KEY=value` lines and
// of env blocks held in JSON strings, PEM labels. Values are never printed.
// Only a string that names an existing filesystem path is shown, so the
// `{"path": …}` pointers of credential maps can be followed.
//
// --fingerprint adds an 8-hex HMAC-SHA256 of each value under a random key
// made for this run only: equal values in the files of one run get the same
// fingerprint, and since the key is never shown there is nothing to
// brute-force, even for short passwords. Compare values by passing all files
// to one run.
//
// Usage: bun scripts/custody/custody-shape.mjs [--fingerprint] <file>...
// Standard: manual/security/local-secret-custody.md
import { createHmac, randomBytes } from "node:crypto";
import { lstatSync, readFileSync, readlinkSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { extname, isAbsolute, resolve } from "node:path";

const MAX_BYTES = 8 * 1024 * 1024;
const MAX_ROWS = 800;
const ENV_LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=(.*)$/u;
const KV_LINE = /^(\s*)(?:-\s+)?["']?([A-Za-z0-9_.@/-]+)["']?\s*[:=]\s?(.*)$/u;
const PEM_BEGIN = /-----BEGIN ([A-Z0-9 ]{1,60})-----/gu;
const MAGIC = [
  ["zip", [0x50, 0x4b, 0x03, 0x04]],
  ["gzip", [0x1f, 0x8b]],
  ["png", [0x89, 0x50, 0x4e, 0x47]],
  ["pdf", [0x25, 0x50, 0x44, 0x46]],
  ["sqlite", [0x53, 0x51, 0x4c, 0x69, 0x74, 0x65]],
  ["der/asn.1", [0x30, 0x82]],
];

export function createFingerprinter(key = randomBytes(32)) {
  return (value) => {
    const canonical = typeof value === "string" ? `s:${value}` : `j:${stableJson(value)}`;
    return createHmac("sha256", key).update(canonical).digest("hex").slice(0, 8);
  };
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson(value[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

// A JSON key that looks like a credential itself is shown by length only.
function showKey(key) {
  if (key.length >= 24 && !/[\s_.:/-]/u.test(key) && /[0-9]/u.test(key) && /[A-Za-z]/u.test(key)) return `<key len=${key.length}>`;
  return key;
}

function keyPath(parent, key) {
  const shown = showKey(key);
  if (shown !== key) return `${parent}[${shown}]`;
  return /^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) ? `${parent}.${key}` : `${parent}[${JSON.stringify(key)}]`;
}

function envEntries(text) {
  const lines = text.split(/\r?\n/u).filter((line) => line.trim() && !line.trim().startsWith("#"));
  if (lines.length === 0) return null;
  const entries = [];
  for (const line of lines) {
    const m = ENV_LINE.exec(line);
    if (m) entries.push([m[1], unquote(m[2].trim())]);
  }
  return entries.length > 0 && entries.length >= lines.length * 0.6 ? entries : null;
}

function unquote(value) {
  if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0]) return value.slice(1, -1);
  return value;
}

function pemLabels(text) {
  return [...text.matchAll(PEM_BEGIN)].map((m) => m[1]);
}

class Shape {
  constructor({ fingerprint, home }) {
    this.fp = fingerprint;
    this.home = home;
    this.rows = [];
  }

  tilde(path) {
    return path.startsWith(`${this.home}/`) ? `~${path.slice(this.home.length)}` : path;
  }

  row(path, description, value) {
    this.rows.push([path, description, this.fp && value !== undefined ? this.fp(value) : null]);
  }

  existingPath(value) {
    if (value.length > 4096 || !/^(~\/|\/)/u.test(value) || /[\0\n]/u.test(value)) return null;
    const path = value.startsWith("~/") ? this.home + value.slice(1) : value;
    try {
      const stat = lstatSync(path);
      return `${this.tilde(path)}${stat.isDirectory() ? "/" : ""}`;
    } catch {
      return null;
    }
  }

  string(path, value) {
    const pointer = this.existingPath(value);
    if (pointer) {
      this.row(path, `path ${pointer}`);
      return;
    }
    const lines = value.split("\n").length;
    const base = `string len=${value.length}${lines > 1 ? ` lines=${lines}` : ""}`;
    const env = lines > 1 ? envEntries(value) : null;
    if (env) {
      this.row(path, `${base} · env block, ${env.length} keys`, value);
      for (const [key, v] of env) this.row(`${path} ${key}`, this.leaf(v), v);
      return;
    }
    if (/^\s*[[{]/u.test(value)) {
      try {
        const parsed = JSON.parse(value);
        this.row(path, `${base} · JSON`, value);
        this.walk(parsed, `${path}⟶$`);
        return;
      } catch {
        // Not JSON: fall through to the plain description.
      }
    }
    const pem = pemLabels(value);
    this.row(path, pem.length ? `${base} · pem ${pem.join(", ")}` : base, value);
  }

  leaf(value) {
    const pointer = this.existingPath(value);
    return pointer ? `path ${pointer}` : `len=${value.length}`;
  }

  walk(value, path) {
    if (Array.isArray(value)) {
      this.row(path, `array(${value.length})`, value);
      value.forEach((item, index) => this.walk(item, `${path}[${index}]`));
    } else if (value && typeof value === "object") {
      const keys = Object.keys(value);
      this.row(path, `object(${keys.length})`, value);
      for (const key of keys) this.walk(value[key], keyPath(path, key));
    } else if (typeof value === "string") this.string(path, value);
    else this.row(path, value === null ? "null" : typeof value, value);
  }

  text(text, extension) {
    const pem = pemLabels(text);
    if (pem.length) {
      this.row("(file)", `pem ${pem.join(", ")} · ${text.split("\n").length} lines`);
      return "pem";
    }
    const env = envEntries(text);
    if (env && ![".yaml", ".yml", ".toml"].includes(extension)) {
      for (const [key, v] of env) this.row(key, this.leaf(v), v);
      return "env";
    }
    const structured = extension === ".toml" ? globalThis.Bun?.TOML : [".yaml", ".yml"].includes(extension) ? globalThis.Bun?.YAML : null;
    if (structured) {
      try {
        this.walk(structured.parse(text), "$");
        return extension.slice(1);
      } catch {
        // Unparseable: list key lines below.
      }
    }
    const keyed = text.split(/\r?\n/u).flatMap((line) => {
      const m = KV_LINE.exec(line);
      return m && !line.trim().startsWith("#") ? [[m[1].length, m[2], unquote(m[3].trim())]] : [];
    });
    if (keyed.length > 0) {
      for (const [indent, key, v] of keyed) this.row(`${" ".repeat(Math.min(indent, 12))}${key}`, v === "" ? "(section)" : this.leaf(v), v === "" ? undefined : v);
      return "key lines";
    }
    const lines = text.split("\n").filter((line) => line.length > 0);
    this.row("(file)", `text, ${lines.length} non-empty lines, longest ${Math.max(0, ...lines.map((l) => l.length))} chars`, text);
    return "text";
  }
}

// Describes one file. Returns the printable lines and whether it worked.
export function describeFile(file, { fingerprint = null, home = homedir() } = {}) {
  const path = isAbsolute(file) ? file : resolve(file);
  const shown = path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
  let link = "";
  let stat;
  try {
    if (lstatSync(path).isSymbolicLink()) link = ` · symlink → ${readlinkSync(path)}`;
    stat = statSync(path);
  } catch {
    return { ok: false, lines: [`${shown}: not found or not readable`] };
  }
  if (stat.isDirectory()) return { ok: false, lines: [`${shown}: a directory; list it with ls and pass files`] };
  if (!stat.isFile()) return { ok: false, lines: [`${shown}: not a regular file`] };
  const mode = (stat.mode & 0o777).toString(8).padStart(4, "0");
  const header = (format) => `${shown}\n  ${format} · ${stat.size} bytes · mode ${mode} · modified ${stat.mtime.toISOString().slice(0, 16)}Z${link}`;
  if (stat.size > MAX_BYTES) return { ok: false, lines: [header("too large to inspect")] };
  let bytes;
  try {
    bytes = readFileSync(path);
  } catch {
    return { ok: false, lines: [`${shown}: not readable`] };
  }
  const shape = new Shape({ fingerprint, home });
  let format;
  let text = null;
  try {
    text = bytes.includes(0) ? null : new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    text = null;
  }
  if (text === null) {
    const kind = MAGIC.find(([, sig]) => sig.every((b, i) => bytes[i] === b))?.[0];
    format = `binary${kind ? ` (${kind})` : ""}`;
    if (fingerprint) shape.row("(file)", "content", bytes.toString("base64"));
  } else {
    const extension = extname(path).toLowerCase();
    if (extension === ".json" || /^\s*[[{]/u.test(text)) {
      try {
        shape.walk(JSON.parse(text), "$");
        format = "json";
      } catch {
        format = extension === ".json" ? "json (does not parse)" : null;
        if (format) shape.row("(file)", `text, ${text.split("\n").length} lines`);
      }
    }
    format ??= shape.text(text, extension);
  }
  const rows = shape.rows.slice(0, MAX_ROWS);
  const width = Math.min(60, Math.max(8, ...rows.map(([p]) => p.length)));
  const lines = [header(format)];
  for (const [p, description, fp] of rows) lines.push(`  ${p.padEnd(width)}  ${description}${fp ? `  fp=${fp}` : ""}`);
  if (shape.rows.length > MAX_ROWS) lines.push(`  … ${shape.rows.length - MAX_ROWS} more rows`);
  return { ok: true, lines };
}

export function main(argv, { write = (line) => process.stdout.write(`${line}\n`), home = homedir() } = {}) {
  let fingerprint = null;
  const files = [];
  let options = true;
  for (const arg of argv) {
    if (options && arg === "--") options = false;
    else if (options && (arg === "--fingerprint" || arg === "--fp")) fingerprint ??= createFingerprinter();
    else if (options && (arg === "--help" || arg === "-h")) {
      write("Usage: bun scripts/custody/custody-shape.mjs [--fingerprint] <file>...");
      write("Prints key paths, types and lengths of custody files; never values.");
      return 0;
    } else if (options && arg.startsWith("-")) {
      write(`custody-shape: unknown option ${arg}`);
      return 2;
    } else files.push(arg);
  }
  if (files.length === 0) {
    write("Usage: bun scripts/custody/custody-shape.mjs [--fingerprint] <file>...");
    return 2;
  }
  let failed = 0;
  for (const file of files) {
    const { ok, lines } = describeFile(file, { fingerprint, home });
    for (const line of lines) write(line);
    if (!ok) failed += 1;
  }
  return failed ? 1 : 0;
}

if (import.meta.main) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    // Never echo a parser or runtime message: it could quote file content.
    process.stderr.write(`custody-shape: internal ${error?.name ?? "error"}\n`);
    process.exitCode = 1;
  }
}
