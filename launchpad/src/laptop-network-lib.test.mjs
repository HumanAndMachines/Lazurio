import { expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
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

  expect(await network.removeConnection({ label: "iotor-jakub-vm" })).toEqual({ removed: true, label: "iotor-jakub-vm" });
  expect(await network.readConnections()).toEqual([]);
  expect(existsSync(join(home, ".ssh", "lazurio-iotor-jakub-vm"))).toBe(false);
});
