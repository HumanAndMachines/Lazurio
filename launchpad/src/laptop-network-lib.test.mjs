import { expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { createSshAccessService } from "./ssh-access-lib.mjs";
import { parseHandover } from "../public/connections.js";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createLaptopNetworkService,
  extractRegistration,
  hostBlock,
  isLazurioMachineHost,
  parseHostBlock,
  parseSshConfigHosts,
  validLoginServer,
} from "./laptop-network-lib.mjs";

const hostKey = {
  type: "ssh-ed25519",
  key: "AAAAC3NzaC1lZDI1NTE5AAAAIGb7d9Q6Cy1S1ZwZ5vN5a1r0Q6Q4XxT3s1jWl5eGqk0L",
};
const laptopKey = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOb7d9Q6Cy1S1ZwZ5vN5a1r0Q6Q4XxT3s1jWl5eGqk0M lazurio-launchpad anna-laptop";

async function service({ run, organizations = [], platform = "darwin" } = {}) {
  const home = await mkdtemp(join(tmpdir(), "laptop-home-"));
  const stateRoot = await mkdtemp(join(tmpdir(), "laptop-state-"));
  const calls = [];
  const network = createLaptopNetworkService({
    home,
    stateRoot,
    hostName: "anna-laptop",
    platform,
    env: {},
    organizations: async () => organizations,
    now: () => new Date("2026-09-24T12:00:00Z"),
    run: async (program, args) => {
      calls.push([program, ...args]);
      return run(program, args);
    },
  });
  return { home, stateRoot, network, calls };
}

const status = (overrides = {}) => JSON.stringify({
  BackendState: "Running",
  CurrentTailnet: { Name: "headscale.betaco.lazurio.io" },
  Self: { TailscaleIPs: ["100.72.0.40"], HostName: "anna-laptop" },
  ...overrides,
});

test("login server and registration URL are validated strictly", () => {
  expect(validLoginServer("https://headscale.betaco.lazurio.io")).toBe("https://headscale.betaco.lazurio.io");
  expect(validLoginServer("https://headscale.betaco.lazurio.io/")).toBe("https://headscale.betaco.lazurio.io");
  expect(validLoginServer("http://headscale.betaco.lazurio.io")).toBeNull();
  expect(validLoginServer("https://headscale.betaco.lazurio.io/path")).toBeNull();
  expect(validLoginServer("https://user:pw@headscale.betaco.lazurio.io")).toBeNull();
  expect(extractRegistration("To authenticate, visit:\n\n\thttps://headscale.betaco.lazurio.io/register/hskey-authreq-abcdefghijklmnop\n"))
    .toEqual({ url: "https://headscale.betaco.lazurio.io/register/hskey-authreq-abcdefghijklmnop", key: "hskey-authreq-abcdefghijklmnop" });
  expect(extractRegistration("nothing here")).toBeNull();
});

test("ssh config hosts are parsed and only Lazurio Machines count", () => {
  expect(isLazurioMachineHost("100.64.0.3")).toBe(true);
  expect(isLazurioMachineHost("betaco-anna-vm.tailnet.betaco.lazurio.io")).toBe(true);
  expect(isLazurioMachineHost("console.host.example-client.com")).toBe(false);
  expect(isLazurioMachineHost("10.0.0.144")).toBe(false);
  expect(parseSshConfigHosts("# c\nInclude ~/.orbstack/ssh/config\nHost a b\n  HostName x\nHost one\n  HostName 100.64.0.3\n  User u\n  IdentityFile ~/.ssh/k\nMatch host x\n  User z\n")).toEqual([
    { label: "one", host: "100.64.0.3", user: "u", identity_file: "~/.ssh/k", connect: "ssh one" },
  ]);
});

test("host block round-trips and keeps the paste command's layout", () => {
  const block = hostBlock({ label: "iotor-jakub-vm", ipv4: "100.72.0.3", user: "jakub" });
  expect(block).toContain("HostKeyAlias iotor-jakub-vm");
  expect(block).toContain("UserKnownHostsFile ~/.ssh/lazurio/iotor-jakub-vm.known_hosts");
  expect(block).toContain("StrictHostKeyChecking yes");
  expect(parseHostBlock("iotor-jakub-vm", block)).toEqual({
    label: "iotor-jakub-vm", host: "100.72.0.3", user: "jakub", identity_file: "~/.ssh/lazurio-iotor-jakub-vm", connect: "ssh iotor-jakub-vm",
  });
});

test("read reports Tailscale, the active tailnet and each Organization's state", async () => {
  const { network } = await service({
    organizations: [
      { slug: "BetaCo", display_name: "BetaCo", repository: "BetaCo/BetaCo_GEN3", conglomerate_host: { headscale_login_server: "https://headscale.betaco.lazurio.io" } },
      { slug: "Gamma", display_name: "Gamma", repository: "Gamma/Gamma_GEN3" },
    ],
    run: async (program, args) => {
      if (args[0] === "version") return { code: program === "tailscale" ? 0 : 1, stdout: "1.90.0\n", stderr: "" };
      if (args[0] === "status") return { code: 0, stdout: status(), stderr: "" };
      return { code: 1, stdout: "", stderr: "" };
    },
  });
  const state = await network.read();
  expect(state.available).toBe(true);
  expect(state.tailscale).toEqual({ installed: true, path: "tailscale" });
  expect(state.status.tailnet).toBe("headscale.betaco.lazurio.io");
  expect(state.status.ipv4).toBe("100.72.0.40");
  expect(state.organizations.map(({ slug, state: s, tailnet }) => [slug, s, tailnet])).toEqual([
    ["BetaCo", "connected", "headscale.betaco.lazurio.io"],
    ["Gamma", "unconfigured", null],
  ]);
});

test("requestJoin starts the login, files the request with the person's gh and remembers it", async () => {
  const organizations = [
    { slug: "BetaCo", display_name: "BetaCo", repository: "BetaCo/BetaCo_GEN3", conglomerate_host: { headscale_login_server: "https://headscale.betaco.lazurio.io" } },
  ];
  const { network, calls, stateRoot } = await service({
    organizations,
    run: async (program, args) => {
      if (args[0] === "version") return { code: program === "tailscale" ? 0 : 1, stdout: "1.90.0", stderr: "" };
      if (args[0] === "status") return { code: 0, stdout: status({ BackendState: "NeedsLogin", CurrentTailnet: null, AuthURL: "https://headscale.betaco.lazurio.io/register/hskey-authreq-0123456789abcdef" }), stderr: "" };
      if (args[0] === "login") return { code: null, stdout: "", stderr: "To authenticate, visit:\n\n\thttps://headscale.betaco.lazurio.io/register/hskey-authreq-0123456789abcdef\n" };
      if (program === "gh" && args[0] === "api") return { code: 0, stdout: "anna\n", stderr: "" };
      if (program === "gh" && args[0] === "issue" && args[1] === "create") return { code: 0, stdout: "https://github.com/BetaCo/BetaCo_GEN3/issues/42\n", stderr: "" };
      if (program === "gh" && args[0] === "issue" && args[1] === "view") return { code: 0, stdout: "OPEN\n", stderr: "" };
      return { code: 1, stdout: "", stderr: "" };
    },
  });
  const result = await network.requestJoin({ organization: "BetaCo" });
  expect(result.state).toBe("pending");
  expect(result.issue_url).toBe("https://github.com/BetaCo/BetaCo_GEN3/issues/42");
  expect(result.registration_key).toBe("hskey-authreq-0123456789abcdef");
  expect(calls).toContainEqual(["tailscale", "login", "--login-server", "https://headscale.betaco.lazurio.io"]);
  const create = calls.find((call) => call[0] === "gh" && call[1] === "issue" && call[2] === "create");
  expect(create.slice(3, 5)).toEqual(["-R", "BetaCo/BetaCo_GEN3"]);
  const body = create[create.indexOf("--body") + 1];
  expect(body).toContain("headscale nodes register --user anna --key hskey-authreq-0123456789abcdef");
  expect(body).toContain("workspace_ssh_grants");
  expect(body).not.toMatch(/PRIVATE|secret/i);
  const stored = JSON.parse(await readFile(join(stateRoot, "runtime", "network", "join-requests.json"), "utf8"));
  expect(stored.BetaCo.issue_url).toBe("https://github.com/BetaCo/BetaCo_GEN3/issues/42");

  const state = await network.read();
  expect(state.organizations[0].state).toBe("pending");
  expect(state.organizations[0].request.issue_state).toBe("open");
});

test("requestJoin fails closed without Tailscale, a login server or a signed-in gh", async () => {
  const base = { slug: "BetaCo", display_name: "BetaCo", repository: "BetaCo/BetaCo_GEN3" };
  const noTailscale = await service({
    organizations: [{ ...base, conglomerate_host: { headscale_login_server: "https://headscale.betaco.lazurio.io" } }],
    run: async () => ({ code: 1, stdout: "", stderr: "" }),
  });
  await expect(noTailscale.network.requestJoin({ organization: "BetaCo" })).rejects.toMatchObject({ code: "tailscale_missing" });
  const unconfigured = await service({ organizations: [base], run: async () => ({ code: 0, stdout: "", stderr: "" }) });
  await expect(unconfigured.network.requestJoin({ organization: "BetaCo" })).rejects.toMatchObject({ code: "login_server_unconfigured" });
  await expect(unconfigured.network.requestJoin({ organization: "Nope" })).rejects.toMatchObject({ code: "organization_unknown" });
  const noGh = await service({
    organizations: [{ ...base, conglomerate_host: { headscale_login_server: "https://headscale.betaco.lazurio.io" } }],
    run: async (program, args) => {
      if (args[0] === "version") return { code: program === "tailscale" ? 0 : 1, stdout: "1.90.0", stderr: "" };
      if (args[0] === "login") return { code: null, stdout: "", stderr: "https://headscale.betaco.lazurio.io/register/hskey-authreq-0123456789abcdef" };
      return { code: 1, stdout: "", stderr: "" };
    },
  });
  await expect(noGh.network.requestJoin({ organization: "BetaCo" })).rejects.toMatchObject({
    code: "github_cli_unavailable",
    details: { registration: { key: "hskey-authreq-0123456789abcdef" } },
  });
});

test("the tailnet is the control server tailscaled is logged into, not the presentational name", async () => {
  const organizations = [
    { slug: "BetaCo", display_name: "BetaCo", repository: "BetaCo/BetaCo_GEN3", conglomerate_host: { headscale_login_server: "https://headscale.betaco.lazurio.io" } },
  ];
  const { network } = await service({
    organizations,
    run: async (program, args) => {
      if (args[0] === "version") return { code: program === "tailscale" ? 0 : 1, stdout: "1.90.0", stderr: "" };
      if (args[0] === "status") return { code: 0, stdout: status({ CurrentTailnet: { Name: "BetaCo tailnet" } }), stderr: "" };
      if (args[0] === "debug" && args[1] === "prefs") return { code: 0, stdout: JSON.stringify({ ControlURL: "https://headscale.betaco.lazurio.io" }), stderr: "" };
      return { code: 1, stdout: "", stderr: "" };
    },
  });
  const state = await network.read();
  expect(state.status.tailnet).toBe("headscale.betaco.lazurio.io");
  expect(state.status.control_url).toBe("https://headscale.betaco.lazurio.io");
  expect(state.organizations[0].state).toBe("connected");
});

test("a request whose issue was closed without registering the laptop is refused, not pending", async () => {
  const organizations = [
    { slug: "BetaCo", display_name: "BetaCo", repository: "BetaCo/BetaCo_GEN3", conglomerate_host: { headscale_login_server: "https://headscale.betaco.lazurio.io" } },
  ];
  let issueState = "OPEN";
  const { network } = await service({
    organizations,
    run: async (program, args) => {
      if (args[0] === "version") return { code: program === "tailscale" ? 0 : 1, stdout: "1.90.0", stderr: "" };
      if (args[0] === "status") return { code: 0, stdout: status({ BackendState: "NeedsLogin", CurrentTailnet: null }), stderr: "" };
      if (args[0] === "login") return { code: null, stdout: "", stderr: "https://headscale.betaco.lazurio.io/register/hskey-authreq-0123456789abcdef" };
      if (program === "gh" && args[0] === "api") return { code: 0, stdout: "anna\n", stderr: "" };
      if (program === "gh" && args[0] === "issue" && args[1] === "create") return { code: 0, stdout: "https://github.com/BetaCo/BetaCo_GEN3/issues/42\n", stderr: "" };
      if (program === "gh" && args[0] === "issue" && args[1] === "view") return { code: 0, stdout: `${issueState}\n`, stderr: "" };
      return { code: 1, stdout: "", stderr: "" };
    },
  });
  await network.requestJoin({ organization: "BetaCo" });
  expect((await network.read()).organizations[0].state).toBe("pending");
  issueState = "CLOSED";
  const refused = (await network.read()).organizations[0];
  expect(refused.state).toBe("refused");
  expect(refused.request.issue_state).toBe("closed");
  // Asking again is possible and replaces the refused record.
  const again = await network.requestJoin({ organization: "BetaCo" });
  expect(again.state).toBe("pending");
});

test("full flow: Machine SSH state → hand-over code → laptop activation when CurrentTailnet.Name differs from ControlURL", async () => {
  // Machine side: tailscaled logged into headscale.betaco.lazurio.io, status name is presentational.
  const machineRoot = await mkdtemp(join(tmpdir(), "machine-"));
  await writeFile(join(machineRoot, "host.pub"), `${hostKey.type} ${hostKey.key} root@vm\n`);
  await writeFile(join(machineRoot, "machine.json"), JSON.stringify({ machine: { id: "betaco-anna" }, network: { headscale_hostname: "betaco-anna-vm" } }));
  await mkdir(join(machineRoot, "home"));
  const machine = createSshAccessService({
    home: join(machineRoot, "home"), user: "anna", hostName: "anna", stateRoot: join(machineRoot, "state"),
    hostKeyPath: join(machineRoot, "host.pub"), machineIdentityPath: join(machineRoot, "machine.json"),
    run: async (program, args) => {
      if (args[0] === "debug") return JSON.stringify({ ControlURL: "https://headscale.betaco.lazurio.io" });
      return JSON.stringify({ Self: { TailscaleIPs: ["100.72.0.3"] }, CurrentTailnet: { Name: "betaco-tailnet" } });
    },
  });
  const state = await machine.read();
  expect(state.tailnet).toBe("headscale.betaco.lazurio.io");

  // The hand-over code exactly as ssh-access.js builds it (base64url JSON).
  const payload = {
    label: state.label, ipv4: state.tailnet_ipv4, user: state.user, tailnet: state.tailnet,
    host_key: { type: state.host_key.type, key: state.host_key.key }, fingerprint: state.host_key.fingerprint,
    return: "https://launchpad.betaco-anna-vm.betaco.lazurio.io/settings/ssh",
  };
  const handover = parseHandover(Buffer.from(JSON.stringify(payload)).toString("base64url"));
  expect(handover.tailnet).toBe("headscale.betaco.lazurio.io");

  // Laptop side: same control server, a different presentational name.
  const { network, home } = await service({
    run: async (program, args) => {
      if (args[0] === "version") return { code: program === "tailscale" ? 0 : 1, stdout: "1.90.0", stderr: "" };
      if (args[0] === "debug") return { code: 0, stdout: JSON.stringify({ ControlURL: "https://headscale.betaco.lazurio.io" }), stderr: "" };
      if (args[0] === "status") return { code: 0, stdout: status({ CurrentTailnet: { Name: "anna's laptop net" } }), stderr: "" };
      if (program === "ssh-keygen") {
        const target = args[args.indexOf("-f") + 1];
        await writeFile(target, "private", { mode: 0o600 });
        await writeFile(`${target}.pub`, `${laptopKey}\n`);
        return { code: 0, stdout: "", stderr: "" };
      }
      return { code: 1, stdout: "", stderr: "" };
    },
  });
  const outcome = await network.connect({ label: handover.label, ipv4: handover.ipv4, user: handover.user, tailnet: handover.tailnet, host_key: handover.host_key });
  expect(outcome.created).toBe(true);
  expect(await readFile(join(home, ".ssh", "lazurio", `${state.label}.known_hosts`), "utf8")).toBe(`${state.label} ${hostKey.type} ${hostKey.key}\n`);
});

test("connect writes the key, Host block, pinned known_hosts and one Include, only on the right tailnet", async () => {
  const { network, home, calls } = await service({
    run: async (program, args) => {
      if (args[0] === "version") return { code: program === "tailscale" ? 0 : 1, stdout: "1.90.0", stderr: "" };
      if (args[0] === "status") return { code: 0, stdout: status(), stderr: "" };
      if (program === "ssh-keygen") {
        const target = args[args.indexOf("-f") + 1];
        await writeFile(target, "private", { mode: 0o600 });
        await writeFile(`${target}.pub`, `${laptopKey}\n`);
        return { code: 0, stdout: "", stderr: "" };
      }
      return { code: 1, stdout: "", stderr: "" };
    },
  });
  await mkdir(join(home, ".ssh"), { recursive: true });
  await writeFile(join(home, ".ssh", "config"), "Host old\n  HostName 10.0.0.1\n");
  // Hosts a person wrote by hand that point at Lazurio Machines are listed read-only.
  expect(await network.readConnections()).toEqual([]);
  await writeFile(join(home, ".ssh", "config"), "Host old\n  HostName 10.0.0.1\nHost gamma-otto-workspace\n  HostName 100.64.0.3\n  User otto\n  HostKeyAlias gamma-otto-workspace\nHost betaco-anna-workspace\n  HostName betaco-anna-vm.tailnet.betaco.lazurio.io\nHost *.example.com\n  HostName x\n");
  expect(await network.readConnections()).toEqual([
    { label: "gamma-otto-workspace", host: "100.64.0.3", user: "otto", identity_file: null, connect: "ssh gamma-otto-workspace", managed: false },
    { label: "betaco-anna-workspace", host: "betaco-anna-vm.tailnet.betaco.lazurio.io", user: null, identity_file: null, connect: "ssh betaco-anna-workspace", managed: false },
  ]);
  await writeFile(join(home, ".ssh", "config"), "Host old\n  HostName 10.0.0.1\n");
  const request = { label: "iotor-jakub-vm", ipv4: "100.72.0.3", user: "jakub", tailnet: "headscale.betaco.lazurio.io", host_key: hostKey };

  await expect(network.connect({ ...request, tailnet: "headscale.other.lazurio.io" })).rejects.toMatchObject({
    code: "tailnet_mismatch", details: { active: "headscale.betaco.lazurio.io", expected: "headscale.other.lazurio.io" },
  });
  await expect(network.connect({ ...request, label: "Bad Label" })).rejects.toMatchObject({ code: "label_invalid" });
  await expect(network.connect({ ...request, ipv4: "10.0.0.1" })).rejects.toMatchObject({ code: "ipv4_invalid" });
  await expect(network.connect({ ...request, host_key: { type: "ssh-ed25519", key: "nope" } })).rejects.toMatchObject({ code: "host_key_invalid" });
  expect(existsSync(join(home, ".ssh", "lazurio"))).toBe(false);

  const first = await network.connect(request);
  expect(first.created).toBe(true);
  expect(first.public_key).toBe(laptopKey);
  expect(first.connect).toBe("ssh iotor-jakub-vm");
  expect(calls.some((call) => call[0] === "ssh-keygen" && call.includes("ed25519"))).toBe(true);
  expect(await readFile(join(home, ".ssh", "lazurio", "iotor-jakub-vm.conf"), "utf8")).toBe(hostBlock({ label: "iotor-jakub-vm", ipv4: "100.72.0.3", user: "jakub" }));
  expect(await readFile(join(home, ".ssh", "lazurio", "iotor-jakub-vm.known_hosts"), "utf8")).toBe(`iotor-jakub-vm ${hostKey.type} ${hostKey.key}\n`);
  expect(await readFile(join(home, ".ssh", "config"), "utf8")).toBe("Include lazurio/*.conf\n\nHost old\n  HostName 10.0.0.1\n");

  const second = await network.connect({ ...request, ipv4: "100.72.0.4" });
  expect(second.created).toBe(false);
  expect(calls.filter((call) => call[0] === "ssh-keygen")).toHaveLength(1);
  expect(await readFile(join(home, ".ssh", "config"), "utf8").then((text) => text.split("Include lazurio/*.conf").length - 1)).toBe(1);
  expect(await network.readConnections()).toEqual([
    { label: "iotor-jakub-vm", host: "100.72.0.4", user: "jakub", identity_file: "~/.ssh/lazurio-iotor-jakub-vm", connect: "ssh iotor-jakub-vm", managed: true },
  ]);

  expect(await network.removeConnection({ label: "iotor-jakub-vm" })).toEqual({ removed: true, label: "iotor-jakub-vm", conf_removed: true, known_hosts_removed: true, key_removed: true, kept: [] });
  expect(await network.readConnections()).toEqual([]);
  expect(existsSync(join(home, ".ssh", "lazurio-iotor-jakub-vm"))).toBe(false);
});

test("removal never deletes what Launchpad did not create: hand-authored .conf, pre-existing key", async () => {
  const { network, home, stateRoot } = await service({
    run: async (program, args) => {
      if (args[0] === "version") return { code: program === "tailscale" ? 0 : 1, stdout: "1.90.0", stderr: "" };
      if (args[0] === "status") return { code: 0, stdout: status(), stderr: "" };
      if (program === "ssh-keygen") {
        const target = args[args.indexOf("-f") + 1];
        await writeFile(target, "private", { mode: 0o600 });
        await writeFile(`${target}.pub`, `${laptopKey}\n`);
        return { code: 0, stdout: "", stderr: "" };
      }
      return { code: 1, stdout: "", stderr: "" };
    },
  });
  await mkdir(join(home, ".ssh", "lazurio"), { recursive: true });
  // A person wrote this .conf and this key themselves.
  await writeFile(join(home, ".ssh", "lazurio", "recovery.conf"), "Host recovery\n  HostName 100.64.0.9\n  User root\n  IdentityFile ~/.ssh/lazurio-recovery\n");
  await writeFile(join(home, ".ssh", "lazurio-recovery"), "the only copy", { mode: 0o600 });
  await writeFile(join(home, ".ssh", "lazurio-recovery.pub"), "ssh-ed25519 AAAA recovery\n");
  expect(await network.readConnections()).toEqual([
    { label: "recovery", host: "100.64.0.9", user: "root", identity_file: "~/.ssh/lazurio-recovery", connect: "ssh recovery", managed: false },
  ]);
  await expect(network.removeConnection({ label: "recovery" })).rejects.toMatchObject({ code: "connection_unmanaged", details: { label: "recovery" } });
  // Even a label without any .conf: nothing is deleted without a ledger record.
  await writeFile(join(home, ".ssh", "lazurio-orphan"), "keep me", { mode: 0o600 });
  await expect(network.removeConnection({ label: "orphan" })).rejects.toMatchObject({ code: "connection_unmanaged" });
  expect(await readFile(join(home, ".ssh", "lazurio-recovery"), "utf8")).toBe("the only copy");
  expect(await readFile(join(home, ".ssh", "lazurio-orphan"), "utf8")).toBe("keep me");
  expect(existsSync(join(home, ".ssh", "lazurio", "recovery.conf"))).toBe(true);
  // connect() will not overwrite a hand-authored .conf under the same label either.
  const request = { label: "recovery", ipv4: "100.72.0.3", user: "jakub", tailnet: "headscale.betaco.lazurio.io", host_key: hostKey };
  await expect(network.connect(request)).rejects.toMatchObject({ code: "connection_unmanaged" });

  // A connection whose key already existed: removal drops the .conf and known_hosts, keeps the key.
  await writeFile(join(home, ".ssh", "lazurio-betaco-anna-vm"), "pre-existing", { mode: 0o600 });
  await writeFile(join(home, ".ssh", "lazurio-betaco-anna-vm.pub"), `${laptopKey}\n`);
  const reused = await network.connect({ ...request, label: "betaco-anna-vm" });
  expect(reused.created).toBe(false);
  const ledger = JSON.parse(await readFile(join(stateRoot, "runtime", "network", "connections.json"), "utf8"));
  expect(ledger["betaco-anna-vm"].key_created).toBe(false);
  expect((await network.readConnections()).find((c) => c.label === "betaco-anna-vm").managed).toBe(true);
  expect(await network.removeConnection({ label: "betaco-anna-vm" })).toEqual({ removed: true, label: "betaco-anna-vm", conf_removed: true, known_hosts_removed: true, key_removed: false, kept: [] });
  expect(await readFile(join(home, ".ssh", "lazurio-betaco-anna-vm"), "utf8")).toBe("pre-existing");
  expect(existsSync(join(home, ".ssh", "lazurio", "betaco-anna-vm.conf"))).toBe(false);
  expect(existsSync(join(home, ".ssh", "lazurio", "betaco-anna-vm.known_hosts"))).toBe(false);

  // A person's own host-key pin without a .conf is never replaced nor deleted.
  await writeFile(join(home, ".ssh", "lazurio", "pinned.known_hosts"), "pinned ssh-ed25519 AAAAtheirs\n");
  await expect(network.connect({ ...request, label: "pinned" })).rejects.toMatchObject({ code: "connection_unmanaged", details: { label: "pinned" } });
  expect(await readFile(join(home, ".ssh", "lazurio", "pinned.known_hosts"), "utf8")).toBe("pinned ssh-ed25519 AAAAtheirs\n");
  await expect(network.removeConnection({ label: "pinned" })).rejects.toMatchObject({ code: "connection_unmanaged" });
  expect(existsSync(join(home, ".ssh", "lazurio", "pinned.known_hosts"))).toBe(true);

  // Files replaced by the person after connect are theirs again: removal keeps them,
  // including a key the person swapped in under a label whose key Launchpad once generated.
  const own = await network.connect({ ...request, label: "swapped" });
  expect(own.created).toBe(true);
  await writeFile(join(home, ".ssh", "lazurio-swapped"), "their new key", { mode: 0o600 });
  await writeFile(join(home, ".ssh", "lazurio-swapped.pub"), "ssh-ed25519 AAAAtheirs later@laptop\n");
  await writeFile(join(home, ".ssh", "lazurio", "swapped.known_hosts"), "swapped ssh-ed25519 AAAAtheirs\n");
  const partial = await network.removeConnection({ label: "swapped" });
  expect(partial).toMatchObject({ removed: true, conf_removed: true, known_hosts_removed: false, key_removed: false });
  expect(partial.kept.sort()).toEqual([join(home, ".ssh", "lazurio-swapped"), join(home, ".ssh", "lazurio", "swapped.known_hosts")].sort());
  expect(await readFile(join(home, ".ssh", "lazurio-swapped"), "utf8")).toBe("their new key");
  expect(await readFile(join(home, ".ssh", "lazurio", "swapped.known_hosts"), "utf8")).toBe("swapped ssh-ed25519 AAAAtheirs\n");
  // And connect() refuses to overwrite a once-managed file the person changed.
  await writeFile(join(home, ".ssh", "lazurio", "swapped.conf"), "Host swapped\n  HostName 100.64.0.1\n");
  await network.connect({ ...request, label: "edited" });
  await writeFile(join(home, ".ssh", "lazurio", "edited.conf"), "Host edited\n  HostName 100.64.0.1\n");
  await expect(network.connect({ ...request, label: "edited" })).rejects.toMatchObject({ code: "connection_unmanaged" });
});
