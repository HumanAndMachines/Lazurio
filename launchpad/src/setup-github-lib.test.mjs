import { afterEach, expect, test } from "bun:test";
import { existsSync, statSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GITHUB_DEVICE_URL,
  classifySshProbe,
  createGitHubLoginController,
  ensureSshKey,
  hasKeyWriteScope,
  parseDeviceCodeOutput,
  parseGitHubAuthStatus,
  parseMachineAssignment,
  parseSshConfig,
  parseSshKeyList,
  pinGitHubHostKeys,
  sshKeyComment,
  sshKeyRegistered,
} from "./setup-github-lib.mjs";

const temps = [];
afterEach(async () => {
  await Promise.all(temps.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function tempHome() {
  const path = await mkdtemp(join(tmpdir(), "lazurio-setup-"));
  temps.push(path);
  return path;
}

const publicKey = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExampleExampleExampleExampleExampleExample0";
const otherKey = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOtherOtherOtherOtherOtherOtherOtherOther000";
const loggedIn = (overrides = {}) => JSON.stringify({
  hosts: {
    "github.com": [{
      state: "success",
      active: true,
      host: "github.com",
      login: "example-operator",
      tokenSource: "keyring",
      scopes: "gist, read:org, repo, admin:public_key",
      gitProtocol: "ssh",
      ...overrides,
    }],
  },
});

test("gh auth status JSON: signed in, signed out, bot, environment token and unreadable", () => {
  const signedIn = parseGitHubAuthStatus(loggedIn());
  expect(signedIn).toMatchObject({ state: "logged_in", login: "example-operator", git_protocol: "ssh", brokered: false, environment_token: false });
  expect(hasKeyWriteScope(signedIn)).toBe(true);
  expect(hasKeyWriteScope(parseGitHubAuthStatus(loggedIn({ scopes: "gist, read:org, repo" })))).toBe(false);
  expect(parseGitHubAuthStatus('{"hosts":{}}')).toEqual({ state: "logged_out" });
  expect(parseGitHubAuthStatus(loggedIn({ state: "error", login: "", tokenSource: "default", gitProtocol: "https" })))
    .toEqual({ state: "logged_out" });
  expect(parseGitHubAuthStatus(loggedIn({ state: "error" })).state).toBe("invalid");
  expect(parseGitHubAuthStatus(loggedIn({ login: "lazurio-for-github[bot]", gitProtocol: "https" })).brokered).toBe(true);
  expect(parseGitHubAuthStatus(loggedIn({ tokenSource: "GH_TOKEN" })).environment_token).toBe(true);
  expect(parseGitHubAuthStatus("unknown flag: --json").state).toBe("unreadable");
});

test("gh ssh-key list: authentication keys match by type and base64, signing keys do not count", () => {
  const listed = parseSshKeyList([
    `laptop\t${otherKey} laptop\t2022-10-29T15:11:45Z\t1\tauthentication`,
    `signing\t${publicKey}\t2023-01-01T00:00:00Z\t2\tsigning`,
    "garbage line",
    "",
  ].join("\n"));
  expect(listed.map((entry) => entry.title)).toEqual(["laptop", "signing"]);
  expect(sshKeyRegistered(listed, `${otherKey} someone@host`)).toBe(true);
  expect(sshKeyRegistered(listed, publicKey)).toBe(false);
  expect(sshKeyRegistered(parseSshKeyList(`vm\t${publicKey}\t2026-09-23T00:00:00Z\t3\tauthentication\n`), `${publicKey} op@vm lazurio\n`)).toBe(true);
});

test("device prompt yields only the user code and the fixed verification URL", () => {
  const output = "! First copy your one-time code: AB12-CD34\nOpen this URL to continue in your web browser: https://github.com/login/device\n";
  expect(parseDeviceCodeOutput(output)).toEqual({ user_code: "AB12-CD34", verification_uri: GITHUB_DEVICE_URL });
  expect(parseDeviceCodeOutput("Open this URL to continue")).toBeNull();
});

test("ssh -T and ssh -G output classification", () => {
  expect(classifySshProbe({ code: 1, output: "Hi example-operator! You've successfully authenticated, but GitHub does not provide shell access." }))
    .toEqual({ state: "ok", login: "example-operator" });
  expect(classifySshProbe({ code: 255, output: "git@github.com: Permission denied (publickey)." }).state).toBe("denied");
  expect(classifySshProbe({ code: 255, output: "No ED25519 host key is known for github.com and you have requested strict checking.\nHost key verification failed." }).state)
    .toBe("host_key_unknown");
  expect(classifySshProbe({ code: 255, output: "@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @\nHost key verification failed." }).state)
    .toBe("host_key_changed");
  expect(classifySshProbe({ code: 255, output: "ssh: connect to host github.com port 22: Operation timed out" }).state).toBe("unreachable");
  expect(classifySshProbe({ code: 255, output: "ssh: connect to host github.com port 22: Permission denied" }).state).toBe("unreachable");
  expect(classifySshProbe({ code: 255, output: "operator@jump.example: Permission denied (publickey)." }).state).toBe("unreachable");
  expect(classifySshProbe({ code: 0, output: "banner: Hi example-operator! You've successfully authenticated, but GitHub does not provide shell access." }).state).toBe("unreachable");
  expect(classifySshProbe({ code: 255, output: "Hi example-operator! You've successfully authenticated, but GitHub does not provide shell access." }).state).toBe("unreachable");
  expect(classifySshProbe({ code: 1, output: "git@github.com: Permission denied (publickey)." }).state).toBe("unreachable");
  expect(classifySshProbe({ code: 0, output: "" }).state).toBe("unreachable");
  expect(parseSshConfig("user git\nhostname github.com\nport 22\n").known_hosts_name).toBe("github.com");
  expect(parseSshConfig("hostname ssh.github.com\nport 443\n").known_hosts_name).toBe("[ssh.github.com]:443");
  expect(parseSshConfig("hostname github.com\nport 22\nhostkeyalias gh-pinned\n").known_hosts_name).toBe("gh-pinned");
});

test("machine identity is read exactly as declared and never guessed", () => {
  const organization = (assignment) => JSON.stringify({
    schema_version: "lazurio.machine.v1",
    machine: { id: "example-anna", kind: "workspace-vm", name: "anna", vmid: 102 },
    owner: { kind: "organization", organization: "example", team: "anna", ...(assignment ? { assignment } : {}) },
  });
  expect(parseMachineAssignment(organization({ kind: "operator", github_login: "anna-example", github_id: 12345678 })))
    .toEqual({ kind: "operator", github_login: "anna-example", github_id: 12345678 });
  expect(parseMachineAssignment(organization({ kind: "team" }))).toEqual({ kind: "team" });
  expect(parseMachineAssignment(organization(null))).toEqual({ kind: "unassigned" });
  expect(parseMachineAssignment(organization({ kind: "operator", github_login: "Anna", github_id: 1 })).kind).toBe("invalid");
  expect(parseMachineAssignment(JSON.stringify({
    schema_version: "lazurio.machine.v1",
    machine: { kind: "personal-vm" },
    owner: { kind: "principal", github_login: "example-owner", github_id: 42 },
  }))).toEqual({ kind: "principal", github_login: "example-owner", github_id: 42 });
  expect(parseMachineAssignment("{").kind).toBe("invalid");
});

test("ensureSshKey creates id_ed25519 with private permissions only when both halves are missing", async () => {
  const home = await tempHome();
  const calls = [];
  const run = async (name, args) => {
    calls.push([name, ...args]);
    const path = args[args.indexOf("-f") + 1];
    await writeFile(path, "-----BEGIN OPENSSH PRIVATE KEY-----\nexample\n-----END OPENSSH PRIVATE KEY-----\n");
    await writeFile(`${path}.pub`, `${publicKey} ${args[args.indexOf("-C") + 1]}\n`);
    return { code: 0, stdout: "", stderr: "" };
  };
  const created = await ensureSshKey({ home, comment: sshKeyComment({ user: "anna", host: "example-vm" }), run });
  expect(created).toMatchObject({ created: true, public_key: publicKey });
  expect(calls[0]).toEqual(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", "anna@example-vm lazurio", "-f", join(home, ".ssh", "id_ed25519")]);
  if (process.platform !== "win32") {
    expect(statSync(join(home, ".ssh")).mode & 0o777).toBe(0o700);
    expect(statSync(join(home, ".ssh", "id_ed25519")).mode & 0o777).toBe(0o600);
  }
  // An existing pair is reused as is; nothing is regenerated.
  expect(await ensureSshKey({ home, comment: "x", run })).toMatchObject({ created: false, public_key: publicKey });
  expect(calls).toHaveLength(1);

  // Half a pair is never overwritten.
  await rm(join(home, ".ssh", "id_ed25519.pub"));
  await expect(ensureSshKey({ home, comment: "x", run })).rejects.toMatchObject({ code: "ssh_key_pair_incomplete" });
  expect(calls).toHaveLength(1);
});

test("GitHub host keys are pinned from the TLS meta endpoint under the exact ssh host key name", async () => {
  const home = await tempHome();
  const run = async (name, args) => ({ code: 0, stdout: name === "ssh" && args[0] === "-G" ? "hostname ssh.github.com\nport 443\n" : "", stderr: "" });
  const fetchImpl = async () => new Response(JSON.stringify({ ssh_keys: [publicKey, "not a key"] }));
  expect(await pinGitHubHostKeys({ home, run, fetchImpl })).toBe(1);
  expect(await readFile(join(home, ".ssh", "known_hosts"), "utf8")).toBe(`[ssh.github.com]:443 ${publicKey}\n`);
  const foreign = async () => ({ code: 0, stdout: "hostname git.example.com\nport 22\n", stderr: "" });
  await expect(pinGitHubHostKeys({ home, run: foreign, fetchImpl })).rejects.toMatchObject({ code: "github_host_key_unverifiable" });
});

// A scripted Machine: `gh`, `ssh`, `git` and `ssh-keygen` answers from state.
function fakeMachine({ signedIn = false, scopes = "gist, read:org, repo, admin:public_key", login = "example-operator", id = 42, keysOnGitHub = [], sshKnown = true, brokered = false } = {}) {
  const state = { signedIn, scopes, login, id, keysOnGitHub: [...keysOnGitHub], sshKnown, protocol: "ssh", calls: [], flows: [] };
  const run = async (program, args) => {
    const name = program.split("/").pop();
    state.calls.push([name, ...args]);
    if (name === "gh" && args[0] === "auth" && args[1] === "status") {
      if (brokered) return { code: 0, stdout: loggedIn({ login: "lazurio-for-github[bot]", gitProtocol: "https", tokenSource: "lazurio-broker-live-proof", scopes: "" }), stderr: "" };
      return { code: 0, stdout: state.signedIn ? loggedIn({ login: state.login, scopes: state.scopes, gitProtocol: state.protocol }) : '{"hosts":{}}', stderr: "" };
    }
    if (name === "gh" && args[0] === "api" && args[1] === "user") return { code: 0, stdout: JSON.stringify({ login: state.login, id: state.id }), stderr: "" };
    if (name === "gh" && args[0] === "config") { state.protocol = args[3]; return { code: 0, stdout: "", stderr: "" }; }
    if (name === "gh" && args[0] === "ssh-key" && args[1] === "list") {
      return { code: 0, stdout: state.keysOnGitHub.map((key, index) => `k${index}\t${key}\t2026\t${index}\tauthentication`).join("\n"), stderr: "" };
    }
    if (name === "gh" && args[0] === "ssh-key" && args[1] === "delete") {
      state.keysOnGitHub.splice(Number(args[2]), 1);
      return { code: 0, stdout: "", stderr: "" };
    }
    if (name === "gh" && args[0] === "auth" && args[1] === "logout") {
      state.signedIn = false;
      return { code: 0, stdout: "", stderr: "" };
    }
    if (name === "gh" && args[0] === "ssh-key" && args[1] === "add") {
      state.keysOnGitHub.push((await readFile(args[2], "utf8")).trim());
      return { code: 0, stdout: "", stderr: "" };
    }
    if (name === "ssh" && args[0] === "-G") {
      // Only the host key pin asks for the resolved config; it then succeeds.
      state.sshKnown = true;
      return { code: 0, stdout: "hostname github.com\nport 22\n", stderr: "" };
    }
    if (name === "ssh-keygen" && args.includes("-y")) {
      return state.keyEncrypted ? { code: 1, stdout: "", stderr: "incorrect passphrase\n" } : { code: 0, stdout: `${publicKey}\n`, stderr: "" };
    }
    if (name === "ssh" && state.defaultSshLogin && !args.includes("-i")) {
      return { code: 1, stdout: "", stderr: `Hi ${state.defaultSshLogin}! You've successfully authenticated, but GitHub does not provide shell access.\n` };
    }
    if (name === "ssh") {
      if (!state.sshKnown) return { code: 255, stdout: "", stderr: "No ED25519 host key is known for github.com and you have requested strict checking.\nHost key verification failed.\n" };
      return state.keysOnGitHub.some((key) => key.startsWith(publicKey))
        ? { code: 1, stdout: "", stderr: `Hi ${state.login}! You've successfully authenticated, but GitHub does not provide shell access.\n` }
        : { code: 255, stdout: "", stderr: "git@github.com: Permission denied (publickey).\n" };
    }
    if (name === "ssh-keygen") {
      const path = args[args.indexOf("-f") + 1];
      await writeFile(path, "private\n");
      await writeFile(`${path}.pub`, `${publicKey} ${args[args.indexOf("-C") + 1]}\n`);
      return { code: 0, stdout: "", stderr: "" };
    }
    if (name === "git") return { code: 0, stdout: "0123456789abcdef0123456789abcdef01234567\trefs/heads/main\n", stderr: "" };
    if (name === "bun") return { code: 0, stdout: JSON.stringify({ state: "updated", target: { message: "ok" } }), stderr: "" };
    return { code: 1, stdout: "", stderr: "" };
  };
  const spawnDeviceFlow = (program, args, { onOutput }) => {
    const flow = { args, killed: false };
    let finish;
    flow.exited = new Promise((resolve) => { finish = resolve; });
    flow.kill = () => { flow.killed = true; finish(null); };
    flow.emit = (text) => onOutput(text);
    flow.complete = (changes = {}) => { Object.assign(state, changes); finish(0); };
    state.flows.push(flow);
    queueMicrotask(() => onOutput("! First copy your one-time code: AB12-CD34\nOpen this URL to continue in your web browser: https://github.com/login/device\n"));
    return flow;
  };
  return { state, run, spawnDeviceFlow };
}

async function controllerFor(machine, options = {}) {
  const home = await tempHome();
  return {
    home,
    controller: createGitHubLoginController({
      home,
      host: "example-vm",
      user: "anna",
      env: { PATH: "/usr/bin" },
      readAssignment: () => ({ kind: "none" }),
      readBrokered: () => null,
      resolveExecutable: (name) => `/usr/bin/${name}`,
      run: machine.run,
      spawnDeviceFlow: machine.spawnDeviceFlow,
      fetchImpl: async () => new Response(JSON.stringify({ ssh_keys: [otherKey] })),
      ...options,
    }),
  };
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await Bun.sleep(5);
  }
  throw new Error("condition not reached");
}

test("login driver: device code shown only while waiting, then key created, uploaded and proven", async () => {
  const machine = fakeMachine({ sshKnown: false });
  const { controller, home } = await controllerFor(machine);
  const initial = await controller.status({ organization: "ExampleOrg" });
  expect(initial).toMatchObject({ mode: "personal", ready: false, blocker: null, actions: { login: true, update: false } });

  const { capability } = controller.start({ organization: "ExampleOrg" });
  expect(capability).toMatch(/^[A-Za-z0-9_-]{43}$/);
  await waitFor(() => controller.snapshot().state === "awaiting_user");
  // Only the starter's capability reveals the code; status and others see progress only.
  expect(controller.snapshot(capability).device).toMatchObject({ user_code: "AB12-CD34", verification_uri: GITHUB_DEVICE_URL });
  expect(controller.snapshot().device).toBeNull();
  expect(controller.snapshot("x".repeat(43)).device).toBeNull();
  expect((await controller.status()).session.device).toBeNull();
  expect(() => controller.cancel("x".repeat(43))).toThrow("session_capability_invalid");
  // gh itself never uploads a key: only the post-verification `gh ssh-key add` may.
  expect(machine.state.flows[0].args).toEqual(["auth", "login", "--hostname", "github.com", "--git-protocol", "ssh", "--web", "--skip-ssh-key", "--scopes", "admin:public_key"]);

  machine.state.flows[0].complete({ signedIn: true });
  await controller.settled();
  const done = controller.snapshot();
  expect(done).toMatchObject({ state: "completed", error: null, device: null, ssh_key_created: true, ssh_key_registered: true });
  expect(done.steps.every((step) => step.state === "done")).toBe(true);
  expect(existsSync(join(home, ".ssh", "id_ed25519"))).toBe(true);
  expect(await readFile(join(home, ".ssh", "known_hosts"), "utf8")).toBe(`github.com ${otherKey}\n`);
  expect(machine.state.calls).toContainEqual(["gh", "ssh-key", "add", join(home, ".ssh", "id_ed25519.pub"), "--title", "anna@example-vm lazurio"]);
  expect(machine.state.calls).toContainEqual(["git", "ls-remote", "--exit-code", "--heads", "--", "git@github.com:ExampleOrg/ExampleOrg_GEN3.git", "refs/heads/main"]);
  // The code never reaches a command line or any other command output.
  expect(JSON.stringify(machine.state.calls)).not.toContain("AB12-CD34");

  const ready = await controller.status({ organization: "ExampleOrg" });
  expect(ready).toMatchObject({
    ready: true,
    account: { state: "logged_in", login: "example-operator", id: 42, git_protocol: "ssh" },
    ssh: { state: "ok", matches_account: true },
    organization: { login: "ExampleOrg", root_repository: "ExampleOrg/ExampleOrg_GEN3", ls_remote: "ok" },
    actions: { login: false, update: true, organization_install: true },
  });
});

test("an already working SSH transport is left alone and missing key scope is refreshed only when needed", async () => {
  const working = fakeMachine({ signedIn: true, keysOnGitHub: [publicKey] });
  const first = await controllerFor(working);
  first.controller.start();
  await first.controller.settled();
  expect(first.controller.snapshot()).toMatchObject({ state: "completed", ssh_key_created: false, ssh_key_registered: false });
  expect(working.state.flows).toHaveLength(0);
  expect(working.state.calls.some(([name]) => name === "ssh-keygen")).toBe(false);

  const narrow = fakeMachine({ signedIn: true, scopes: "gist, read:org, repo" });
  const second = await controllerFor(narrow);
  second.controller.start();
  await waitFor(() => second.controller.snapshot().state === "awaiting_user");
  expect(narrow.state.flows[0].args).toEqual(["auth", "refresh", "--hostname", "github.com", "--scopes", "admin:public_key"]);
  narrow.state.flows[0].complete({ scopes: "gist, read:org, repo, admin:public_key" });
  await second.controller.settled();
  expect(second.controller.snapshot()).toMatchObject({ state: "completed", ssh_key_registered: true });
});

test("GitHub unreachable over SSH stops before any key is created or uploaded", async () => {
  const machine = fakeMachine({ signedIn: true });
  const base = machine.run;
  machine.run = async (program, args) => program.endsWith("/ssh") && args[0] === "-T"
    ? { code: 255, stdout: "", stderr: "ssh: connect to host github.com port 22: Operation timed out\n" }
    : base(program, args);
  const { controller, home } = await controllerFor(machine);
  controller.start();
  await controller.settled();
  expect(controller.snapshot()).toMatchObject({ state: "failed", error: "github_ssh_unreachable" });
  expect(existsSync(join(home, ".ssh", "id_ed25519"))).toBe(false);
  expect(machine.state.calls.some(([name, sub]) => name === "gh" && sub === "ssh-key")).toBe(false);
});

test("the operator signs in with any account, whatever the Machine declares", async () => {
  const machine = fakeMachine({ signedIn: true, login: "someone-else", id: 7 });
  const { controller } = await controllerFor(machine, {
    hosted: true,
    readAssignment: () => ({ kind: "operator", github_login: "anna-example", github_id: 12345678 }),
  });
  const status = await controller.status();
  expect(status).toMatchObject({ blocker: null, actions: { login: true, logout: true }, machine: { assignment: "operator" } });
  expect(status.machine).not.toHaveProperty("expected_login");
  controller.start();
  await controller.settled();
  expect(controller.snapshot()).toMatchObject({ state: "completed", ssh_key_created: true, ssh_key_registered: true });
});

test("Sign out removes this Machine's key from the wrong account, after which the right account signs in", async () => {
  const machine = fakeMachine({ signedIn: true, login: "someone-else", id: 7, keysOnGitHub: [`${otherKey} other`, `${publicKey} example-vm`] });
  const { controller, home } = await controllerFor(machine, {
    hosted: true,
    readAssignment: () => ({ kind: "operator", github_login: "anna-example", github_id: 12345678 }),
  });
  await mkdir(join(home, ".ssh"), { recursive: true });
  await writeFile(join(home, ".ssh", "id_ed25519"), "private\n");
  await writeFile(join(home, ".ssh", "id_ed25519.pub"), `${publicKey} example-vm\n`);
  expect(await controller.status()).toMatchObject({ blocker: null, actions: { logout: true } });

  expect(await controller.logout()).toEqual({ logged_out: true, login: "someone-else", ssh_key_removed: true });
  expect(machine.state.keysOnGitHub).toEqual([`${otherKey} other`]);
  expect(machine.state.calls).toContainEqual(["gh", "auth", "logout", "--hostname", "github.com", "--user", "someone-else"]);
  expect(existsSync(join(home, ".ssh", "id_ed25519"))).toBe(true);
  expect(await controller.status()).toMatchObject({ blocker: null, actions: { login: true, logout: false } });

  controller.start();
  await waitFor(() => controller.snapshot().state === "awaiting_user");
  machine.state.flows[0].complete({ signedIn: true, login: "anna-example", id: 12345678, keysOnGitHub: [] });
  await controller.settled();
  expect(controller.snapshot()).toMatchObject({ state: "completed", ssh_key_created: false, ssh_key_registered: true });
  expect(machine.state.keysOnGitHub).toEqual([`${publicKey} example-vm`]);
});

test("Sign out without the key deletion scope keeps the account while its key still answers over SSH", async () => {
  for (const scopes of ["gist, read:org, repo", "gist, read:org, repo, write:public_key"]) {
    const machine = fakeMachine({ signedIn: true, login: "someone-else", scopes, keysOnGitHub: [`${publicKey} example-vm`] });
    const { controller, home } = await controllerFor(machine);
    await mkdir(join(home, ".ssh"), { recursive: true });
    await writeFile(join(home, ".ssh", "id_ed25519"), "private\n");
    await writeFile(join(home, ".ssh", "id_ed25519.pub"), `${publicKey} example-vm\n`);
    await expect(controller.logout()).rejects.toMatchObject({ code: "ssh_key_still_registered" });
    expect(machine.state.signedIn).toBe(true);
    expect(machine.state.calls.some(([name, sub, verb]) => name === "gh" && sub === "ssh-key" && verb === "delete")).toBe(false);

    // Once the key is removed on GitHub, the same Sign out goes through.
    machine.state.keysOnGitHub = [];
    expect(await controller.logout()).toEqual({ logged_out: true, login: "someone-else", ssh_key_removed: false });
  }
});

test("Sign out from an unreadable gh keeps it while this Machine's key still answers for any account", async () => {
  const machine = fakeMachine({ signedIn: true, login: "someone-else", keysOnGitHub: [`${publicKey} example-vm`] });
  const base = machine.run;
  machine.run = async (program, args) => program.endsWith("/gh") && args[0] === "auth" && args[1] === "status"
    ? { code: 0, stdout: "not json", stderr: "" }
    : base(program, args);
  const { controller } = await controllerFor(machine);
  expect((await controller.status()).actions.logout).toBe(true);
  await expect(controller.logout()).rejects.toMatchObject({ code: "ssh_key_still_registered" });
  expect(machine.state.calls.some(([name, sub, verb]) => name === "gh" && sub === "auth" && verb === "logout")).toBe(false);

  machine.state.keysOnGitHub = [];
  expect(await controller.logout()).toEqual({ logged_out: true, login: null, ssh_key_removed: false });
});

test("Sign out stops when SSH cannot prove where this Machine's key belongs", async () => {
  for (const answer of [
    { code: 255, stdout: "", stderr: "ssh: connect to host github.com port 22: Operation timed out\n" },
    { code: 255, stdout: "", stderr: "@@@@@@@@@@@\nREMOTE HOST IDENTIFICATION HAS CHANGED!\n" },
    { code: 255, stdout: "", stderr: "ssh: connect to host github.com port 22: Permission denied\n" },
    { code: 255, stdout: "", stderr: "operator@jump.example: Permission denied (publickey).\n" },
    { code: 255, stdout: "", stderr: "Hi someone-else! You've successfully authenticated, but GitHub does not provide shell access.\n" },
  ]) {
    const machine = fakeMachine({ signedIn: true, login: "someone-else" });
    const base = machine.run;
    machine.run = async (program, args) => program.endsWith("/ssh") && args[0] === "-T" ? answer : base(program, args);
    const { controller } = await controllerFor(machine);
    await expect(controller.logout()).rejects.toMatchObject({ code: "logout_ssh_unproven" });
    expect(machine.state.signedIn).toBe(true);
    expect(machine.state.calls.some(([name, sub, verb]) => name === "gh" && sub === "auth" && verb === "logout")).toBe(false);
  }

  // An unknown GitHub host key is pinned first; the probe then decides.
  const fresh = fakeMachine({ signedIn: true, sshKnown: false });
  const { controller } = await controllerFor(fresh);
  expect(await controller.logout()).toMatchObject({ logged_out: true });
  expect(fresh.state.calls).toContainEqual(["ssh", "-G", "git@github.com"]);
});

test("Sign out probes this Machine's key alone, so another key answering first hides nothing", async () => {
  const machine = fakeMachine({ signedIn: true, login: "someone-else", scopes: "gist, read:org, repo", keysOnGitHub: [`${publicKey} example-vm`] });
  machine.state.defaultSshLogin = "another-account";
  const { controller, home } = await controllerFor(machine);
  await mkdir(join(home, ".ssh"), { recursive: true });
  await writeFile(join(home, ".ssh", "id_ed25519"), "private\n");
  await writeFile(join(home, ".ssh", "id_ed25519.pub"), `${publicKey} example-vm\n`);
  await expect(controller.logout()).rejects.toMatchObject({ code: "ssh_key_still_registered" });
  const keyProbe = machine.state.calls.find(([name, ...args]) => name === "ssh" && args.includes("-i"));
  expect(keyProbe).toEqual(expect.arrayContaining(["-F", "none", "IdentitiesOnly=yes", "IdentityAgent=none", join(home, ".ssh", "id_ed25519")]));
  expect(machine.state.calls.some(([name, sub, verb]) => name === "gh" && sub === "auth" && verb === "logout")).toBe(false);

  // A key that needs a passphrase cannot answer, so it proves nothing.
  machine.state.keysOnGitHub = [];
  machine.state.keyEncrypted = true;
  await expect(controller.logout()).rejects.toMatchObject({ code: "logout_ssh_unproven" });
  machine.state.keyEncrypted = false;
  expect(await controller.logout()).toMatchObject({ logged_out: true });
});

test("a token in the environment rules out Sign out even when gh status is unreadable", async () => {
  for (const variable of ["GH_TOKEN", "GITHUB_TOKEN"]) {
    const machine = fakeMachine({ signedIn: true });
    const base = machine.run;
    machine.run = async (program, args) => program.endsWith("/gh") && args[0] === "auth" && args[1] === "status"
      ? { code: 0, stdout: "not json", stderr: "" }
      : base(program, args);
    const { controller } = await controllerFor(machine, { env: { PATH: "/usr/bin", [variable]: "example-value" } });
    expect(await controller.status()).toMatchObject({ blocker: "environment_token", actions: { login: false, logout: false } });
    await expect(controller.logout()).rejects.toMatchObject({ code: "environment_token" });
    controller.start();
    await controller.settled();
    expect(controller.snapshot()).toMatchObject({ state: "failed", error: "environment_token" });
    expect(machine.state.calls.some(([name, sub, verb]) => name === "gh" && sub === "auth" && verb === "logout")).toBe(false);
  }
});

test("Sign out is offered for a broken GitHub CLI state but never for a Team bot or an environment token", async () => {
  const signedOut = fakeMachine();
  expect((await (await controllerFor(signedOut)).controller.status()).actions.logout).toBe(false);
  const unreadable = fakeMachine({ signedIn: true });
  const unreadableRun = unreadable.run;
  unreadable.run = async (program, args) => program.endsWith("/gh") && args[0] === "auth" && args[1] === "status"
    ? { code: 0, stdout: "not json", stderr: "" }
    : unreadableRun(program, args);
  const unreadableStatus = await (await controllerFor(unreadable)).controller.status();
  expect(unreadableStatus).toMatchObject({ blocker: "github_cli_unreadable", actions: { login: false, logout: true } });
  const bot = fakeMachine({ brokered: true });
  const botController = (await controllerFor(bot)).controller;
  expect((await botController.status()).actions.logout).toBe(false);
  await expect(botController.logout()).rejects.toMatchObject({ code: "brokered_identity" });
  expect(bot.state.calls.some(([name, sub, verb]) => name === "gh" && sub === "auth" && verb === "logout")).toBe(false);
});

test("only an installed Organization bot keeps a personal login away", async () => {
  const machine = fakeMachine();
  const { controller: botMachine } = await controllerFor(machine, { readBrokered: () => ({ valid: true }) });
  expect((await botMachine.status()).actions).toEqual({ login: false, logout: false, update: false, organization_install: false });
  botMachine.start();
  await botMachine.settled();
  expect(botMachine.snapshot()).toMatchObject({ state: "failed", error: "brokered_identity" });
  expect(machine.state.flows).toHaveLength(0);

  // A Team VM still without its bot, an undeclared or an invalid identity:
  // whoever operates the Machine signs in.
  for (const options of [
    { readAssignment: () => ({ kind: "team" }) },
    { hosted: true, readAssignment: () => ({ kind: "none" }) },
    { readAssignment: () => ({ kind: "unassigned" }) },
    { hosted: true, readAssignment: () => ({ kind: "invalid" }) },
  ]) {
    const open = fakeMachine();
    const { controller } = await controllerFor(open, options);
    expect(await controller.status()).toMatchObject({ blocker: null, actions: { login: true } });
    const { capability } = controller.start();
    await waitFor(() => controller.snapshot().state === "awaiting_user");
    controller.cancel(capability);
    await controller.settled();
  }
  const bot = fakeMachine({ brokered: true });
  const { controller } = await controllerFor(bot);
  expect(await controller.status()).toMatchObject({ mode: "brokered", blocker: "brokered_identity" });
});

test("cancel stops the device flow and forgets the code", async () => {
  const machine = fakeMachine();
  const { controller } = await controllerFor(machine);
  const { capability } = controller.start();
  expect(() => controller.start()).toThrow("login_in_progress");
  await waitFor(() => controller.snapshot().state === "awaiting_user");
  controller.cancel(capability);
  await controller.settled();
  expect(machine.state.flows[0].killed).toBe(true);
  expect(controller.snapshot()).toMatchObject({ state: "cancelled", error: "cancelled", device: null });
});

test("a cancel while the key is being created stops before anything reaches GitHub", async () => {
  const machine = fakeMachine({ signedIn: true });
  const base = machine.run;
  let releaseKeygen;
  const keygenStarted = new Promise((resolve) => {
    machine.run = async (program, args) => {
      if (program.endsWith("/ssh-keygen")) {
        resolve();
        await new Promise((release) => { releaseKeygen = release; });
      }
      return base(program, args);
    };
  });
  const { controller } = await controllerFor(machine);
  const { capability } = controller.start();
  await keygenStarted;
  controller.cancel(capability);
  releaseKeygen();
  await controller.settled();
  expect(controller.snapshot()).toMatchObject({ state: "cancelled", ssh_key_registered: false });
  expect(machine.state.calls.some(([name, sub, action]) => name === "gh" && sub === "ssh-key" && action === "add")).toBe(false);
  expect(machine.state.flows).toHaveLength(0);
});

test("organization install runs the existing CLI with the builder role and stays off personal Machines", async () => {
  const machine = fakeMachine({ signedIn: true, keysOnGitHub: [publicKey] });
  const { controller } = await controllerFor(machine, { cliCommand: ["/usr/bin/bun", "/opt/lazurio/lazurio/cli.mjs"], cliCwd: "/home/anna/Lazurio" });
  // The server re-runs the readiness gate: no install before SSH works.
  const notReady = fakeMachine({ signedIn: true });
  const early = await controllerFor(notReady, { cliCommand: ["/usr/bin/bun", "cli.mjs"] });
  await expect(early.controller.organizationInstall({ organization: "ExampleOrg" }))
    .rejects.toMatchObject({ code: "organization_install_not_ready" });
  expect(notReady.state.calls.some(([name]) => name === "bun")).toBe(false);
  const result = await controller.organizationInstall({ organization: "ExampleOrg" });
  expect(result.report.state).toBe("updated");
  expect(machine.state.calls.at(-1)).toEqual(["bun", "/opt/lazurio/lazurio/cli.mjs", "organization", "install", "ExampleOrg", "--role", "builder", "--json"]);
  await expect(controller.organizationInstall({ organization: "../evil" })).rejects.toMatchObject({ code: "organization_login_invalid" });

  // A hosted Organization Machine installs only the Organization whose root declares its slug.
  for (const [slug, expected] of [["example", "updated"], ["other", null]]) {
    const scoped = fakeMachine({ signedIn: true, keysOnGitHub: [publicKey] });
    const base = scoped.run;
    scoped.run = async (program, args) => args[0] === "api" && args[3]?.endsWith("/contents/company.gen3.json")
      ? { code: 0, stdout: JSON.stringify({ company: { slug: "example" } }), stderr: "" }
      : base(program, args);
    const { controller: scopedController } = await controllerFor(scoped, { organizationScope: slug, cliCommand: ["/usr/bin/bun", "cli.mjs"] });
    if (expected) {
      expect((await scopedController.organizationInstall({ organization: "ExampleOrg" })).report.state).toBe(expected);
    } else {
      await expect(scopedController.organizationInstall({ organization: "ExampleOrg" }))
        .rejects.toMatchObject({ code: "organization_outside_machine_scope" });
      expect(scoped.state.calls.some(([name]) => name === "bun")).toBe(false);
    }
  }

  const personal = await controllerFor(fakeMachine(), { personalScope: true, cliCommand: ["/usr/bin/bun", "cli.mjs"] });
  await expect(personal.controller.organizationInstall({ organization: "ExampleOrg" }))
    .rejects.toMatchObject({ code: "organization_install_not_available" });
});

test("a lone public key is half a pair and is never completed or overwritten", async () => {
  const home = await tempHome();
  await mkdir(join(home, ".ssh"), { mode: 0o700 });
  await writeFile(join(home, ".ssh", "id_ed25519.pub"), `${publicKey} existing\n`);
  await expect(ensureSshKey({ home, comment: "x", run: async () => ({ code: 0 }) }))
    .rejects.toMatchObject({ code: "ssh_key_pair_incomplete" });
});

test("the page never puts the one-time code on the clipboard", async () => {
  const publicRoot = join(import.meta.dirname, "..", "public");
  const [script, settings] = await Promise.all([
    readFile(join(publicRoot, "setup-github.js"), "utf8"),
    readFile(join(publicRoot, "settings.html"), "utf8"),
  ]);
  // The GitHub section of the Settings page hosts the step's markup.
  const page = settings.slice(settings.indexOf('class="settings-section" data-section="github"'), settings.indexOf('class="settings-section" data-section="ssh"'));
  expect(page).toContain('id="setupGitHubCode"');
  expect(script).not.toMatch(/navigator\.clipboard|execCommand\(\s*["']copy/);
  expect(page).not.toMatch(/copy/i);
});
