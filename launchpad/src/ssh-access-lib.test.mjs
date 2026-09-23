import { afterAll, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LAUNCHPAD_KEY_MARKER,
  buildSetupCommands,
  createSshAccessService,
  listAuthorizedKeys,
  parsePublicKeyInput,
  sshHostLabel,
} from "./ssh-access-lib.mjs";

const posix = process.platform !== "win32";
const tempRoots = [];
afterAll(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
});

function syntheticKey(type = "ssh-ed25519", comment = "") {
  const name = Buffer.from(type);
  const blob = Buffer.alloc(4 + name.length + 4 + 32);
  blob.writeUInt32BE(name.length, 0);
  name.copy(blob, 4);
  blob.writeUInt32BE(32, 4 + name.length);
  randomBytes(32).copy(blob, 8 + name.length);
  return `${type} ${blob.toString("base64")}${comment ? ` ${comment}` : ""}`;
}

async function tempDir(prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

async function service({ run } = {}) {
  const root = await tempDir("lazurio-ssh-access-");
  const home = join(root, "home");
  await mkdir(home);
  const hostKeyPath = join(root, "ssh_host_ed25519_key.pub");
  const hostKey = syntheticKey("ssh-ed25519", "root@vm");
  await writeFile(hostKeyPath, `${hostKey}\n`);
  const machineIdentityPath = join(root, "lazurio.machine.json");
  await writeFile(machineIdentityPath, JSON.stringify({
    machine: { id: "spectoda-anna" },
    network: { headscale_hostname: "spectoda-anna-vm" },
  }));
  const stateRoot = join(root, "state");
  const calls = [];
  const access = createSshAccessService({
    home,
    user: "anna",
    hostName: "anna",
    stateRoot,
    hostKeyPath,
    machineIdentityPath,
    now: () => new Date("2026-09-23T10:00:00Z"),
    run: run ?? (async (program, args) => {
      calls.push([program, ...args]);
      if (program === "tailscale") return "100.64.0.7\n";
      return execFileSync(program, args, { encoding: "utf8" });
    }),
  });
  return { access, root, home, stateRoot, hostKey, calls };
}

test("public key input accepts one key line and sanitizes its comment", () => {
  const key = syntheticKey("ssh-ed25519");
  const parsed = parsePublicKeyInput(`  ${key} matěj@MacBook<script>;rm -rf\n`);
  expect(parsed.type).toBe("ssh-ed25519");
  expect(parsed.body).toBe(key.split(" ")[1]);
  expect(parsed.comment).toBe("matj@MacBookscriptrm -rf");
  expect(parsed.fingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);
  expect(parsePublicKeyInput(`${key} ${LAUNCHPAD_KEY_MARKER} laptop`).comment).toBe("laptop");
});

test("public key input rejects private material, several lines and forged blobs", () => {
  const key = syntheticKey();
  const cases = [
    ["", "ssh_key_empty"],
    ["-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAA\n-----END OPENSSH PRIVATE KEY-----", "ssh_key_private_material"],
    [`${key}\n${syntheticKey()}`, "ssh_key_multiline"],
    [syntheticKey("ssh-dss"), "ssh_key_type_unsupported"],
    [`ssh-rsa ${key.split(" ")[1]}`, "ssh_key_invalid"],
    ["ssh-ed25519 not*base64", "ssh_key_invalid"],
    [`ssh-ed25519 ${"A".repeat(9000)}`, "ssh_key_too_long"],
  ];
  for (const [input, code] of cases) {
    expect(() => parsePublicKeyInput(input)).toThrow(code);
  }
});

test.skipIf(!posix)("fingerprints match what ssh-keygen prints", async () => {
  const root = await tempDir("lazurio-ssh-fp-");
  const key = syntheticKey();
  await writeFile(join(root, "key.pub"), `${key}\n`);
  const output = execFileSync("ssh-keygen", ["-l", "-E", "sha256", "-f", join(root, "key.pub")], { encoding: "utf8" });
  expect(output).toContain(parsePublicKeyInput(key).fingerprint);
});

test("authorized_keys listing marks only keys Launchpad added as removable", () => {
  const provisioned = syntheticKey("ssh-ed25519", "anna@recovery");
  const optioned = `restrict,command="echo hi" ${syntheticKey("ssh-ed25519", `${LAUNCHPAD_KEY_MARKER} x`)}`;
  const managed = syntheticKey("ssh-ed25519", `${LAUNCHPAD_KEY_MARKER} laptop`);
  const keys = listAuthorizedKeys(`# comment\n${provisioned}\n\n${optioned}\nnot a key\n${managed}\n`);
  expect(keys.map((key) => [key.comment, key.removable])).toEqual([
    ["anna@recovery", false],
    [`${LAUNCHPAD_KEY_MARKER} x`, false],
    [`${LAUNCHPAD_KEY_MARKER} laptop`, true],
  ]);
});

test("host label prefers the Headscale node name and stays DNS-safe", () => {
  expect(sshHostLabel({ machineIdentity: { network: { headscale_hostname: "Spectoda-Anna-VM" } }, hostName: "anna" }))
    .toBe("spectoda-anna-vm");
  expect(sshHostLabel({ machineIdentity: { machine: { id: "iotor_jakub" } }, hostName: "jakub" })).toBe("iotor-jakub");
  expect(sshHostLabel({ hostName: "vm.local" })).toBe("vm-local");
  expect(sshHostLabel({ hostName: "!!" })).toBe("lazurio-machine");
});

test("setup commands exist only for validated values and never ask for admin rights", () => {
  const hostKey = { type: "ssh-ed25519", key: syntheticKey().split(" ")[1] };
  const commands = buildSetupCommands({ label: "spectoda-anna-vm", ipv4: "100.64.0.7", user: "anna", hostKey });
  expect(commands.connect).toBe("ssh spectoda-anna-vm");
  for (const script of [commands.macos, commands.windows]) {
    expect(script).toContain(`spectoda-anna-vm ssh-ed25519 ${hostKey.key}`);
    expect(script).toContain("HostKeyAlias");
    expect(script).toContain("IdentitiesOnly yes");
    expect(script).not.toMatch(/sudo|RunAs|Administrator/);
  }
  expect(commands.macos).toContain("pbcopy");
  expect(commands.windows).toContain("ssh-keygen.exe");
  expect(commands.windows).toContain("Set-Clipboard");
  expect(commands.windows).toContain("-Encoding ascii");
  expect(commands.windows).toContain("$PSNativeCommandArgumentPassing");
  expect(buildSetupCommands({ label: "x", ipv4: "100.64.0.7'; rm", user: "anna", hostKey })).toBeNull();
  expect(buildSetupCommands({ label: "x", ipv4: "100.64.0.7", user: "an'na", hostKey })).toBeNull();
  expect(buildSetupCommands({ label: "x", ipv4: null, user: "anna", hostKey })).toBeNull();
});

test.skipIf(!posix)("macOS setup command is idempotent and yields a pinned ssh host", async () => {
  const root = await tempDir("lazurio-ssh-laptop-");
  const home = join(root, "home");
  const bin = join(root, "bin");
  await mkdir(home);
  await mkdir(bin);
  await writeFile(join(bin, "pbcopy"), `#!/bin/sh\ncat > "${join(root, "clipboard")}"\n`);
  await chmod(join(bin, "pbcopy"), 0o755);
  const hostKey = { type: "ssh-ed25519", key: syntheticKey().split(" ")[1] };
  const { macos } = buildSetupCommands({ label: "spectoda-anna-vm", ipv4: "100.64.0.7", user: "anna", hostKey });
  const env = { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}` };
  const first = execFileSync("/bin/sh", ["-c", macos], { env, encoding: "utf8" });
  execFileSync("/bin/sh", ["-c", macos], { env, encoding: "utf8" });

  const publicKey = await readFile(join(home, ".ssh", "lazurio-spectoda-anna-vm.pub"), "utf8");
  expect(first.trim()).toBe(publicKey.trim());
  expect(await readFile(join(root, "clipboard"), "utf8")).toBe(publicKey);
  expect(parsePublicKeyInput(publicKey).type).toBe("ssh-ed25519");
  const config = await readFile(join(home, ".ssh", "config"), "utf8");
  expect(config.match(/^Host spectoda-anna-vm$/gm)).toHaveLength(1);
  const knownHosts = await readFile(join(home, ".ssh", "known_hosts"), "utf8");
  expect(knownHosts.trim().split("\n")).toEqual([`spectoda-anna-vm ssh-ed25519 ${hostKey.key}`]);
  const resolved = execFileSync("ssh", ["-G", "-F", join(home, ".ssh", "config"), "spectoda-anna-vm"], { env, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  expect(resolved).toContain("hostname 100.64.0.7");
  expect(resolved).toContain("user anna");
  expect(resolved).toContain("hostkeyalias spectoda-anna-vm");
  expect(resolved).toContain("identitiesonly yes");
});

test.skipIf(!posix)("service reads Machine facts and builds commands", async () => {
  const { access, hostKey } = await service();
  const state = await access.read();
  expect(state).toMatchObject({
    available: true,
    user: "anna",
    label: "spectoda-anna-vm",
    tailnet_ipv4: "100.64.0.7",
    host_key: { type: "ssh-ed25519", fingerprint: parsePublicKeyInput(hostKey).fingerprint },
    keys: [],
    issues: [],
  });
  expect(state.commands.connect).toBe("ssh spectoda-anna-vm");

  const offline = await service({ run: async () => { throw new Error("tailscale missing"); } });
  const degraded = await offline.access.read();
  expect(degraded.tailnet_ipv4).toBeNull();
  expect(degraded.commands).toBeNull();
  expect(degraded.issues).toEqual(["tailnet_ip_unavailable"]);
});

test.skipIf(!posix)("adding keys writes only ~/.ssh/authorized_keys with private modes, dedups and audits", async () => {
  const { access, home, stateRoot } = await service();
  const key = syntheticKey("ssh-ed25519", "matej@laptop");
  const added = await access.addKey(key);
  expect(added.added).toBe(true);
  expect((await lstat(join(home, ".ssh"))).mode & 0o777).toBe(0o700);
  const file = join(home, ".ssh", "authorized_keys");
  expect((await lstat(file)).mode & 0o777).toBe(0o600);
  expect(await readFile(file, "utf8")).toBe(`${key.split(" ").slice(0, 2).join(" ")} ${LAUNCHPAD_KEY_MARKER} matej@laptop\n`);
  expect((await access.addKey(`${key.split(" ").slice(0, 2).join(" ")} other`)).added).toBe(false);

  const audit = (await readFile(join(stateRoot, "runtime", "audit", "ssh-access.jsonl"), "utf8")).trim().split("\n");
  expect(audit).toHaveLength(1);
  expect(JSON.parse(audit[0])).toEqual({
    at: "2026-09-23T10:00:00.000Z", action: "add", type: "ssh-ed25519", fingerprint: added.fingerprint,
  });
  expect(audit[0]).not.toContain(key.split(" ")[1]);
  await expect(access.addKey("ssh-ed25519 AAAA")).rejects.toThrow("ssh_key_invalid");
});

test.skipIf(!posix)("removal keeps provisioned keys and removes only Launchpad keys", async () => {
  const { access, home, stateRoot } = await service();
  await mkdir(join(home, ".ssh"), { mode: 0o700 });
  const file = join(home, ".ssh", "authorized_keys");
  const provisioned = syntheticKey("ssh-ed25519", "anna@recovery");
  await writeFile(file, `${provisioned}\n# keep me`, { mode: 0o600 });
  const { fingerprint } = await access.addKey(syntheticKey("ssh-ed25519", "laptop"));
  expect(await readFile(file, "utf8")).toStartWith(`${provisioned}\n# keep me\nssh-ed25519 `);

  const [recovery] = listAuthorizedKeys(provisioned);
  await expect(access.removeKey(recovery.fingerprint)).rejects.toThrow("ssh_key_not_managed");
  await expect(access.removeKey(`SHA256:${"A".repeat(43)}`)).rejects.toThrow("ssh_key_not_found");
  await expect(access.removeKey("../../etc/passwd")).rejects.toThrow("ssh_fingerprint_invalid");
  expect(await access.removeKey(fingerprint)).toEqual({ removed: true, fingerprint });
  expect(await readFile(file, "utf8")).toBe(`${provisioned}\n# keep me\n`);
  const audit = (await readFile(join(stateRoot, "runtime", "audit", "ssh-access.jsonl"), "utf8")).trim().split("\n");
  expect(audit.map((line) => JSON.parse(line).action)).toEqual(["add", "remove"]);
});

test.skipIf(!posix)("a symlinked authorized_keys is refused, never written through", async () => {
  const { access, home, root } = await service();
  await mkdir(join(home, ".ssh"), { mode: 0o700 });
  const outside = join(root, "outside");
  await writeFile(outside, "original\n");
  await symlink(outside, join(home, ".ssh", "authorized_keys"));
  await expect(access.addKey(syntheticKey())).rejects.toThrow("ssh_path_unsafe");
  expect(await readFile(outside, "utf8")).toBe("original\n");
});
