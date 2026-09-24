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
    machine: { id: "alpha-anna" },
    network: { headscale_hostname: "alpha-anna-vm" },
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
      if (program === "tailscale") {
        return JSON.stringify({ Self: { TailscaleIPs: ["100.64.0.7", "fd7a:115c::7"] }, CurrentTailnet: { Name: "headscale.alpha.example" } });
      }
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

test("host label prefers the qualified machine id and stays DNS-safe", () => {
  expect(sshHostLabel({ machineIdentity: { machine: { id: "alpha-anna" }, network: { headscale_hostname: "friday" } } }))
    .toBe("alpha-anna");
  expect(sshHostLabel({ machineIdentity: { network: { headscale_hostname: "Alpha-Anna-VM" } }, hostName: "anna" }))
    .toBe("alpha-anna-vm");
  expect(sshHostLabel({ machineIdentity: { machine: { id: "beta_jakub" } }, hostName: "jakub" })).toBe("beta-jakub");
  expect(sshHostLabel({ hostName: "vm.local" })).toBe("vm-local");
  expect(sshHostLabel({ hostName: "!!" })).toBe("lazurio-machine");
});

const tailnet = "headscale.alpha.example";

test("setup commands exist only for validated values and never ask for admin rights", () => {
  const hostKey = { type: "ssh-ed25519", key: syntheticKey().split(" ")[1] };
  const values = { label: "alpha-anna-vm", ipv4: "100.64.0.7", user: "anna", tailnet, hostKey };
  const commands = buildSetupCommands(values);
  expect(commands.connect).toBe("ssh alpha-anna-vm");
  for (const script of [commands.macos, commands.windows]) {
    expect(script).toContain(`alpha-anna-vm ssh-ed25519 ${hostKey.key}`);
    expect(script).toContain("HostKeyAlias alpha-anna-vm");
    expect(script).toContain("UserKnownHostsFile ~/.ssh/lazurio/alpha-anna-vm.known_hosts");
    expect(script).toContain("StrictHostKeyChecking yes");
    expect(script).toContain("IdentitiesOnly yes");
    expect(script).toContain("Include lazurio/*.conf");
    expect(script).toContain("ControlURL");
    expect(script).toContain("CurrentTailnet");
    expect(script).toContain(`'${tailnet}'`);
    expect(script).not.toContain(".ssh/known_hosts");
    expect(script).not.toMatch(/sudo|RunAs|Administrator/);
  }
  expect(commands.macos).toContain("pbcopy");
  expect(commands.windows).toContain("ssh-keygen.exe");
  expect(commands.windows).toContain("Set-Clipboard");
  expect(commands.windows).toContain("[IO.File]::WriteAllLines");
  expect(commands.windows).toContain("$PSNativeCommandArgumentPassing");
  expect(commands.windows).not.toMatch(/Add-Content|Set-Content|Out-File/);
  for (const invalid of [
    { ipv4: "100.64.0.7'; rm" },
    { user: "an'na" },
    { ipv4: null },
    { tailnet: "evil'; rm -rf ~" },
    { tailnet: null },
  ]) {
    expect(buildSetupCommands({ ...values, ...invalid })).toBeNull();
  }
});

async function laptop() {
  const root = await tempDir("lazurio-ssh-laptop-");
  const home = join(root, "home");
  const bin = join(root, "bin");
  await mkdir(home);
  await mkdir(bin);
  await writeFile(join(bin, "pbcopy"), `#!/bin/sh\ncat > "${join(root, "clipboard")}"\n`);
  // The fake tailscale reports the control server through `debug prefs` and a
  // presentational name through `status`, like a Headscale client may.
  await writeFile(join(bin, "tailscale"), `#!/bin/sh\nif [ "$1" = debug ]; then printf '{\\n  "ControlURL": "https://%s",\\n  "RouteAll": false\\n}\\n' "$FAKE_TAILNET"; else printf '{\\n  "Version": "1.80.0",\\n  "CurrentTailnet": {\\n    "Name": "presentational name",\\n    "MagicDNSSuffix": "x"\\n  }\\n}\\n'; fi\n`);
  await chmod(join(bin, "pbcopy"), 0o755);
  await chmod(join(bin, "tailscale"), 0o755);
  const hostKey = { type: "ssh-ed25519", key: syntheticKey().split(" ")[1] };
  const run = (script, activeTailnet = tailnet) => execFileSync("/bin/sh", ["-c", script], {
    env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, FAKE_TAILNET: activeTailnet },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  // ssh resolves ~ and relative Includes from the passwd home, not $HOME, so
  // resolve the fixture's config through an absolute Include.
  const resolve = async (alias) => {
    const config = (await readFile(join(home, ".ssh", "config"), "utf8"))
      .replace("Include lazurio/*.conf", `Include ${join(home, ".ssh", "lazurio")}/*.conf`);
    await writeFile(join(root, "resolved-config"), config);
    return execFileSync("ssh", ["-G", "-F", join(root, "resolved-config"), alias], {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    });
  };
  return { root, home, hostKey, run, resolve };
}

test.skipIf(!posix)("macOS setup command is idempotent, pins the Machine and wins over an older block", async () => {
  const { root, home, hostKey, run, resolve } = await laptop();
  await mkdir(join(home, ".ssh"));
  const olderConfig = "Host alpha-anna-vm\n  HostName 100.64.0.99\n  StrictHostKeyChecking no\n";
  await writeFile(join(home, ".ssh", "config"), olderConfig);
  const commands = buildSetupCommands({ label: "alpha-anna-vm", ipv4: "100.64.0.7", user: "anna", tailnet, hostKey });
  const first = run(commands.macos);
  run(commands.macos);

  const publicKey = await readFile(join(home, ".ssh", "lazurio-alpha-anna-vm.pub"), "utf8");
  expect(first.trim()).toBe(publicKey.trim());
  expect(await readFile(join(root, "clipboard"), "utf8")).toBe(publicKey);
  expect(parsePublicKeyInput(publicKey).type).toBe("ssh-ed25519");
  const config = await readFile(join(home, ".ssh", "config"), "utf8");
  expect(config).toBe(`Include lazurio/*.conf\n\n${olderConfig}`);
  expect(await readFile(join(home, ".ssh", "lazurio", "alpha-anna-vm.known_hosts"), "utf8"))
    .toBe(`alpha-anna-vm ssh-ed25519 ${hostKey.key}\n`);
  expect(await Bun.file(join(home, ".ssh", "known_hosts")).exists()).toBe(false);
  const resolved = await resolve("alpha-anna-vm");
  expect(resolved).toContain("hostname 100.64.0.7");
  expect(resolved).toContain("user anna");
  expect(resolved).toContain("hostkeyalias alpha-anna-vm");
  expect(resolved).toContain("identitiesonly yes");
  expect(resolved).toContain("stricthostkeychecking true");
  expect(resolved).toMatch(/userknownhostsfile \S*lazurio\/alpha-anna-vm\.known_hosts/);

  // A moved Machine is picked up by pasting its new command again.
  run(buildSetupCommands({ label: "alpha-anna-vm", ipv4: "100.64.0.8", user: "anna", tailnet, hostKey }).macos);
  expect(await resolve("alpha-anna-vm")).toContain("hostname 100.64.0.8");
});

test.skipIf(!posix)("macOS setup command refuses a laptop on another tailnet and writes nothing", async () => {
  const { home, hostKey, run } = await laptop();
  const { macos } = buildSetupCommands({ label: "alpha-anna-vm", ipv4: "100.64.0.7", user: "anna", tailnet, hostKey });
  let failure;
  try {
    run(macos, "headscale.other.example");
  } catch (error) {
    failure = error;
  }
  expect(failure?.status).toBe(1);
  expect(String(failure?.stderr)).toContain("not to 'headscale.alpha.example'");
  expect(await Bun.file(join(home, ".ssh", "config")).exists()).toBe(false);
  expect(await Bun.file(join(home, ".ssh", "lazurio-alpha-anna-vm")).exists()).toBe(false);
});

test.skipIf(!posix)("service reads Machine facts and builds commands", async () => {
  const { access, hostKey } = await service();
  const state = await access.read();
  expect(state).toMatchObject({
    available: true,
    user: "anna",
    label: "alpha-anna",
    tailnet_ipv4: "100.64.0.7",
    tailnet: "headscale.alpha.example",
    host_key: { type: "ssh-ed25519", fingerprint: parsePublicKeyInput(hostKey).fingerprint },
    keys: [],
    issues: [],
  });
  expect(state.commands.connect).toBe("ssh alpha-anna");

  const offline = await service({ run: async () => { throw new Error("tailscale missing"); } });
  const degraded = await offline.access.read();
  expect(degraded.tailnet_ipv4).toBeNull();
  expect(degraded.commands).toBeNull();
  expect(degraded.issues).toEqual(["tailnet_ip_unavailable"]);
});

test.skipIf(!posix)("the Machine advertises the control server host, not the presentational tailnet name", async () => {
  const { access } = await service({
    run: async (program, args) => {
      if (program !== "tailscale") return execFileSync(program, args, { encoding: "utf8" });
      if (args[0] === "debug") return JSON.stringify({ ControlURL: "https://headscale.alpha.example" });
      return JSON.stringify({ Self: { TailscaleIPs: ["100.64.0.7"] }, CurrentTailnet: { Name: "alpha tailnet" } });
    },
  });
  const state = await access.read();
  expect(state.tailnet).toBe("headscale.alpha.example");
  expect(state.commands.macos).toContain("'headscale.alpha.example'");
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

test.skipIf(!posix)("an existing ~/.ssh is tightened to 0700 before a key is written", async () => {
  const { access, home } = await service();
  await mkdir(join(home, ".ssh"), { mode: 0o755 });
  await chmod(join(home, ".ssh"), 0o755);
  await access.addKey(syntheticKey("ssh-ed25519", "laptop"));
  expect((await lstat(join(home, ".ssh"))).mode & 0o777).toBe(0o700);
  expect((await lstat(join(home, ".ssh", "authorized_keys"))).mode & 0o777).toBe(0o600);
});

test.skipIf(!posix)("no access change happens when its audit line cannot be written", async () => {
  const { access, home, stateRoot } = await service();
  await writeFile(stateRoot, "not a directory");
  await expect(access.addKey(syntheticKey("ssh-ed25519", "laptop"))).rejects.toThrow();
  expect(await Bun.file(join(home, ".ssh", "authorized_keys")).exists()).toBe(false);
});
