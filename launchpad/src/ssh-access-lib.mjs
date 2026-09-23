import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { appendFile, chmod, lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// SSH access lets the operator of a hosted Machine reach it from a laptop over
// the Headscale tailnet. The Launchpad runs as the Machine's workspace user, so
// everything here reads and writes only that user's own ~/.ssh: the page
// shortens what the same person can already do in a shell on the Machine.
//
// Keys added here carry a marker comment. Only marked keys can be removed from
// the page, so the recovery keys Machines provisioned (and whose presence the
// Machine readback proves) can never be deleted with one click.

export const LAUNCHPAD_KEY_MARKER = "lazurio-launchpad";
const addableKeyTypes = new Set([
  "ssh-ed25519",
  "ecdsa-sha2-nistp256",
  "ecdsa-sha2-nistp384",
  "ecdsa-sha2-nistp521",
  "ssh-rsa",
]);
const maxKeyInputBytes = 8 * 1024;
const commandTimeoutMs = 5_000;
const base64Pattern = /^[A-Za-z0-9+/]+={0,2}$/;
const fingerprintPattern = /^SHA256:[A-Za-z0-9+/]{43}$/;
const ipv4Pattern = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;
const userPattern = /^[a-z_][a-z0-9_-]{0,31}$/;

export class SshAccessError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

function decodeKeyBlob(type, body) {
  if (typeof body !== "string" || !base64Pattern.test(body)) return null;
  const blob = Buffer.from(body, "base64");
  if (blob.toString("base64") !== body || blob.length < 8) return null;
  const nameLength = blob.readUInt32BE(0);
  if (4 + nameLength >= blob.length) return null;
  return blob.subarray(4, 4 + nameLength).toString("latin1") === type ? blob : null;
}

function fingerprintOf(blob) {
  return `SHA256:${createHash("sha256").update(blob).digest("base64").replace(/=+$/, "")}`;
}

function sanitizeComment(value) {
  return String(value ?? "")
    .replace(/[^A-Za-z0-9 ._@+:=,/-]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(new RegExp(`^(?:${LAUNCHPAD_KEY_MARKER}\\s*)+`), "")
    .slice(0, 80)
    .trim();
}

// Parses what a person pastes: exactly one public key line, never a private key.
export function parsePublicKeyInput(text) {
  const raw = String(text ?? "");
  if (Buffer.byteLength(raw, "utf8") > maxKeyInputBytes) throw new SshAccessError("ssh_key_too_long");
  if (/PRIVATE KEY/i.test(raw)) throw new SshAccessError("ssh_key_private_material");
  const line = raw.trim();
  if (!line) throw new SshAccessError("ssh_key_empty");
  if (/[\r\n\0]/.test(line)) throw new SshAccessError("ssh_key_multiline");
  const [type, body, ...comment] = line.split(/[ \t]+/);
  if (!addableKeyTypes.has(type)) throw new SshAccessError("ssh_key_type_unsupported");
  const blob = decodeKeyBlob(type, body);
  if (!blob) throw new SshAccessError("ssh_key_invalid");
  return Object.freeze({ type, body, comment: sanitizeComment(comment.join(" ")), fingerprint: fingerprintOf(blob) });
}

// One authorized_keys line → the key it grants, or null for blanks, comments
// and lines this reader does not understand (those are preserved untouched).
export function parseAuthorizedKeyLine(line) {
  const text = String(line ?? "").trim();
  if (!text || text.startsWith("#")) return null;
  const tokens = text.split(/\s+/);
  for (let index = 0; index + 1 < tokens.length; index += 1) {
    if (!/^(?:ssh-|ecdsa-|sk-)/.test(tokens[index])) continue;
    const blob = decodeKeyBlob(tokens[index], tokens[index + 1]);
    if (!blob) continue;
    const comment = tokens.slice(index + 2).join(" ");
    return {
      type: tokens[index],
      fingerprint: fingerprintOf(blob),
      comment,
      removable: index === 0 && comment.split(" ")[0] === LAUNCHPAD_KEY_MARKER,
    };
  }
  return null;
}

export function listAuthorizedKeys(text) {
  return String(text ?? "").split("\n").map(parseAuthorizedKeyLine).filter(Boolean);
}

export function authorizedKeyLine(parsed) {
  return [parsed.type, parsed.body, LAUNCHPAD_KEY_MARKER, parsed.comment].filter(Boolean).join(" ");
}

// machine.id is Organization- or owner-qualified by the Machines contract,
// so one laptop can hold aliases for Machines of several tailnets.
export function sshHostLabel({ machineIdentity = null, hostName = "" } = {}) {
  for (const candidate of [
    machineIdentity?.machine?.id,
    machineIdentity?.network?.headscale_hostname,
    hostName,
  ]) {
    const label = String(candidate ?? "").toLowerCase().replace(/[^a-z0-9-]/g, "-")
      .replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 63).replace(/-$/, "");
    if (label) return label;
  }
  return "lazurio-machine";
}

// One idempotent paste per laptop OS. Every interpolated value was validated
// above (label [a-z0-9-], IPv4, POSIX user, key type and canonical base64), so
// no value can escape its quotes. The host key lives in its own known_hosts
// file under HostKeyAlias with strict checking: a 100.64.x.y address repeats
// in every tailnet, so a laptop on the wrong tailnet fails the host key check
// instead of reaching another Machine, and no shared known_hosts line clashes.
export function buildSetupCommands({ label, ipv4, user, hostKey }) {
  if (!label || !ipv4Pattern.test(ipv4 ?? "") || !userPattern.test(user ?? "") || !hostKey) return null;
  const knownHost = `${label} ${hostKey.type} ${hostKey.key}`;
  const macos = [
    "(",
    "set -e",
    `L='${label}'`,
    'K="$HOME/.ssh/lazurio-$L"',
    'mkdir -p "$HOME/.ssh" && chmod 700 "$HOME/.ssh"',
    '[ -f "$K" ] || ssh-keygen -q -t ed25519 -N \'\' -C "$(whoami)@$(hostname -s)" -f "$K"',
    'touch "$HOME/.ssh/config"',
    `grep -qx "Host $L" "$HOME/.ssh/config" || printf '\\nHost %s\\n  HostName %s\\n  User %s\\n  IdentityFile ~/.ssh/lazurio-%s\\n  IdentitiesOnly yes\\n  HostKeyAlias %s\\n  UserKnownHostsFile ~/.ssh/lazurio-%s.known_hosts\\n  StrictHostKeyChecking yes\\n' "$L" '${ipv4}' '${user}' "$L" "$L" "$L" >> "$HOME/.ssh/config"`,
    `printf '%s\\n' '${knownHost}' > "$K.known_hosts"`,
    'pbcopy < "$K.pub" 2>/dev/null || true',
    'cat "$K.pub"',
    ")",
  ].join("\n");
  const windows = [
    "& {",
    "$ErrorActionPreference = 'Stop'",
    `$L = '${label}'`,
    "$D = Join-Path $HOME '.ssh'",
    '$K = Join-Path $D "lazurio-$L"',
    "if (-not (Get-Command ssh-keygen.exe -ErrorAction SilentlyContinue)) { throw 'OpenSSH Client is missing: Settings > System > Optional features > OpenSSH Client' }",
    "New-Item -ItemType Directory -Force -Path $D | Out-Null",
    "if (-not (Test-Path -LiteralPath $K)) {",
    // Windows PowerShell 5.1 drops an empty native argument; 7.3+ passes it.
    "  $N = if ($PSNativeCommandArgumentPassing -and $PSNativeCommandArgumentPassing -ne 'Legacy') { '' } else { '\"\"' }",
    '  ssh-keygen.exe -q -t ed25519 -N $N -C "$env:USERNAME@$env:COMPUTERNAME" -f $K',
    "  if ($LASTEXITCODE -ne 0) { throw 'ssh-keygen failed' }",
    "}",
    "$C = Join-Path $D 'config'",
    `if (@(Get-Content -LiteralPath $C -ErrorAction SilentlyContinue) -notcontains "Host $L") { Add-Content -LiteralPath $C -Encoding ascii -Value @('', "Host $L", '  HostName ${ipv4}', '  User ${user}', "  IdentityFile ~/.ssh/lazurio-$L", '  IdentitiesOnly yes', "  HostKeyAlias $L", "  UserKnownHostsFile ~/.ssh/lazurio-$L.known_hosts", '  StrictHostKeyChecking yes') }`,
    `Set-Content -LiteralPath "$K.known_hosts" -Encoding ascii -Value '${knownHost}'`,
    '$Pub = (Get-Content -LiteralPath "$K.pub" -Raw).Trim()',
    "Set-Clipboard -Value $Pub",
    "$Pub",
    "}",
  ].join("\n");
  return { macos, windows, connect: `ssh ${label}` };
}

function runCommand(program, args, { timeoutMs = commandTimeoutMs } = {}) {
  return new Promise((resolve, reject) => {
    execFile(program, args, { timeout: timeoutMs, maxBuffer: 64 * 1024 }, (error, stdout) => {
      if (error) reject(error);
      else resolve(String(stdout));
    });
  });
}

async function readOptional(path) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

export function createSshAccessService({
  home,
  user,
  hostName,
  stateRoot,
  run = runCommand,
  hostKeyPath = "/etc/ssh/ssh_host_ed25519_key.pub",
  machineIdentityPath = "/etc/lazurio/lazurio.machine.json",
  now = () => new Date(),
}) {
  const sshDirectory = join(home, ".ssh");
  const authorizedKeysPath = join(sshDirectory, "authorized_keys");
  const auditPath = join(stateRoot, "runtime", "audit", "ssh-access.jsonl");
  let writeQueue = Promise.resolve();

  function serialized(operation) {
    const result = writeQueue.then(operation, operation);
    writeQueue = result.catch(() => {});
    return result;
  }

  async function readTailnetIpv4() {
    try {
      const address = (await run("tailscale", ["ip", "-4"])).split(/\s+/).find((value) => ipv4Pattern.test(value));
      return address ?? null;
    } catch {
      return null;
    }
  }

  async function readHostKey() {
    try {
      const [type, key] = String(await readOptional(hostKeyPath) ?? "").trim().split(/\s+/);
      const blob = decodeKeyBlob(type, key);
      return blob ? { type, key, fingerprint: fingerprintOf(blob) } : null;
    } catch {
      return null;
    }
  }

  async function readMachineIdentity() {
    try {
      return JSON.parse(await readOptional(machineIdentityPath) ?? "null");
    } catch {
      return null;
    }
  }

  async function readKeys() {
    return listAuthorizedKeys(await readOptional(authorizedKeysPath) ?? "");
  }

  async function read() {
    const [ipv4, hostKey, machineIdentity, keys] = await Promise.all([
      readTailnetIpv4(),
      readHostKey(),
      readMachineIdentity(),
      readKeys(),
    ]);
    const label = sshHostLabel({ machineIdentity, hostName });
    const validUser = userPattern.test(user ?? "") ? user : null;
    const issues = [
      ...(ipv4 ? [] : ["tailnet_ip_unavailable"]),
      ...(hostKey ? [] : ["host_key_unavailable"]),
      ...(validUser ? [] : ["workspace_user_unsupported"]),
    ];
    return {
      available: true,
      user: validUser,
      label,
      tailnet_ipv4: ipv4,
      host_key: hostKey ? { type: hostKey.type, fingerprint: hostKey.fingerprint } : null,
      keys,
      commands: buildSetupCommands({ label, ipv4, user: validUser, hostKey }),
      issues,
    };
  }

  // Writes stay inside the user's own ~/.ssh. A symlinked or foreign-typed
  // path is refused instead of followed, so nothing is written elsewhere.
  async function assertRegularOrAbsent(path, kind) {
    try {
      const stats = await lstat(path);
      if (stats.isSymbolicLink() || (kind === "directory" ? !stats.isDirectory() : !stats.isFile())) {
        throw new SshAccessError("ssh_path_unsafe", 409);
      }
      return true;
    } catch (error) {
      if (error?.code === "ENOENT") return false;
      throw error;
    }
  }

  async function readForWrite() {
    if (!(await assertRegularOrAbsent(sshDirectory, "directory"))) {
      await mkdir(sshDirectory, { mode: 0o700 });
    }
    await chmod(sshDirectory, 0o700);
    await assertRegularOrAbsent(authorizedKeysPath, "file");
    return await readOptional(authorizedKeysPath) ?? "";
  }

  async function writeAuthorizedKeys(text) {
    const temporary = join(sshDirectory, `.authorized_keys.lazurio-${randomBytes(6).toString("hex")}`);
    try {
      await writeFile(temporary, text, { mode: 0o600, flag: "wx" });
      await chmod(temporary, 0o600);
      await rename(temporary, authorizedKeysPath);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }

  async function audit(action, key, result = null) {
    await mkdir(join(stateRoot, "runtime", "audit"), { recursive: true });
    await appendFile(auditPath, `${JSON.stringify({
      at: now().toISOString(), action, type: key.type, fingerprint: key.fingerprint, ...(result ? { result } : {}),
    })}\n`, "utf8");
  }

  // The audit line comes first: without it no access change happens. A change
  // that fails after its line was written is recorded as failed, best effort.
  async function auditedWrite(action, key, text) {
    await audit(action, key);
    try {
      await writeAuthorizedKeys(text);
    } catch (error) {
      await audit(action, key, "failed").catch(() => {});
      throw error;
    }
  }

  // OpenSSH itself must accept the key, not only this parser.
  async function verifyWithSshKeygen(parsed) {
    const directory = await mkdtemp(join(tmpdir(), "lazurio-ssh-key-"));
    try {
      const path = join(directory, "key.pub");
      await writeFile(path, `${parsed.type} ${parsed.body}\n`, { mode: 0o600 });
      let output;
      try {
        output = await run("ssh-keygen", ["-l", "-E", "sha256", "-f", path]);
      } catch (error) {
        if (error?.code === "ENOENT") throw new SshAccessError("ssh_keygen_unavailable", 503);
        throw new SshAccessError("ssh_key_invalid");
      }
      if (!output.split(/\s+/).includes(parsed.fingerprint)) throw new SshAccessError("ssh_key_invalid");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  async function addKey(text) {
    const parsed = parsePublicKeyInput(text);
    await verifyWithSshKeygen(parsed);
    return serialized(async () => {
      const current = await readForWrite();
      if (listAuthorizedKeys(current).some((key) => key.fingerprint === parsed.fingerprint)) {
        return { added: false, fingerprint: parsed.fingerprint };
      }
      const separator = current && !current.endsWith("\n") ? "\n" : "";
      await auditedWrite("add", parsed, `${current}${separator}${authorizedKeyLine(parsed)}\n`);
      return { added: true, fingerprint: parsed.fingerprint };
    });
  }

  async function removeKey(fingerprint) {
    if (typeof fingerprint !== "string" || !fingerprintPattern.test(fingerprint)) {
      throw new SshAccessError("ssh_fingerprint_invalid");
    }
    return serialized(async () => {
      const lines = (await readForWrite()).split("\n");
      const matches = lines.map(parseAuthorizedKeyLine).filter((key) => key?.fingerprint === fingerprint);
      if (matches.length === 0) throw new SshAccessError("ssh_key_not_found", 404);
      if (!matches.every((key) => key.removable)) throw new SshAccessError("ssh_key_not_managed", 409);
      await auditedWrite("remove", matches[0], lines.filter((line) => parseAuthorizedKeyLine(line)?.fingerprint !== fingerprint).join("\n"));
      return { removed: true, fingerprint };
    });
  }

  return Object.freeze({ read, addKey, removeKey });
}
