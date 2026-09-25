import { spawn } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { appendFile, chmod, mkdir, readFile } from "node:fs/promises";
import { homedir, hostname as osHostname, userInfo } from "node:os";
import { join } from "node:path";
import { BROKERED_GITHUB_ACTOR, brokeredGitHubIdentity } from "../../lazurio/core/brokered-github-lib.mjs";
import { sanitizedGitHubEnvironment } from "../../lazurio/core/github-provider-lib.mjs";
import { resolveExecutableOnPath } from "../../lazurio/core/toolchain-lib.mjs";

// Machine setup step "GitHub" (Launchpad /api/setup/github/*; later steps of
// the same setup namespace add SSH access, Codex and Claude logins).
//
// One button for the correct GitHub login of a Machine's operator: `gh` with
// the SSH Git protocol, an SSH key that GitHub actually accepts for the same
// account, verified by `ssh -T` and `git ls-remote` of the Organization root.
// The procedure is the one manual/organization-install.md and
// manual/hosted-machine-first-login.md describe; this module only runs it.
//
// Privacy: the one-time user code exists only in the in-memory session and is
// returned only to the caller holding the capability issued by `start`. It is
// never logged, written to a file or put on the clipboard. The internal OAuth
// device_code, the token and the private key never pass through here at all.

export const GITHUB_LOGIN_SCHEMA = "lazurio.launchpad.setup.github.v1";
export const MACHINE_IDENTITY_FILE = "/etc/lazurio/lazurio.machine.json";
export const GITHUB_DEVICE_URL = "https://github.com/login/device";
export const GITHUB_KEY_SCOPE = "admin:public_key";
export const ORGANIZATION_INSTALL_ROLE = "builder";

const setupGitHubPattern = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/u;
const machineLoginPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const deviceCodePattern = /one-time code:\s*([A-Z0-9]{4}-[A-Z0-9]{4})\b/u;
const publicKeyPattern = /^(ssh-ed25519|ecdsa-sha2-nistp256|ecdsa-sha2-nistp384|ecdsa-sha2-nistp521|ssh-rsa|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com)\s+([A-Za-z0-9+/]+={0,3})(?:\s|$)/u;
const sshGreetingPattern = /Hi ([A-Za-z0-9-]+)! You've successfully authenticated/u;
const keyWriteScopes = new Set([GITHUB_KEY_SCOPE, "write:public_key"]);
const githubSshHosts = new Set(["github.com", "ssh.github.com"]);
const commandTimeoutMs = 30_000;
const installTimeoutMs = 15 * 60_000;
const deviceFlowTimeoutMs = 15 * 60_000;
const maxOutputBytes = 256 * 1024;

export class GitHubLoginError extends Error {
  constructor(code, details = {}) {
    super(code);
    this.name = "GitHubLoginError";
    this.code = code;
    this.details = details;
  }
}

// ---------------------------------------------------------------------------
// Parsing: pure functions over command output.
// ---------------------------------------------------------------------------

/** `gh auth status --json hosts` → the active github.com account. */
export function parseGitHubAuthStatus(raw) {
  let value;
  try {
    value = JSON.parse(String(raw ?? ""));
  } catch {
    return Object.freeze({ state: "unreadable" });
  }
  if (!value || typeof value !== "object" || !value.hosts || typeof value.hosts !== "object") {
    return Object.freeze({ state: "unreadable" });
  }
  const entries = value.hosts["github.com"];
  const active = Array.isArray(entries) ? entries.find((entry) => entry?.active === true) : null;
  if (!active) return Object.freeze({ state: "logged_out" });
  const login = typeof active.login === "string" && active.login !== "" ? active.login : null;
  // With GH_HOST set, gh reports an unconfigured host as an anonymous error
  // entry instead of an empty list; that is still "not signed in".
  if (!login) return Object.freeze({ state: "logged_out" });
  const tokenSource = typeof active.tokenSource === "string" ? active.tokenSource : null;
  const scopes = typeof active.scopes === "string"
    ? active.scopes.split(",").map((scope) => scope.trim()).filter(Boolean)
    : [];
  return Object.freeze({
    state: active.state === "success" ? "logged_in" : "invalid",
    login,
    brokered: login === BROKERED_GITHUB_ACTOR,
    git_protocol: typeof active.gitProtocol === "string" && active.gitProtocol !== ""
      ? active.gitProtocol.toLowerCase()
      : null,
    scopes: Object.freeze(scopes),
    // A token from GH_TOKEN/GITHUB_TOKEN wins over every stored login and
    // `gh auth login` refuses to run next to it.
    environment_token: tokenSource !== null && /^(?:GH|GITHUB)_(?:ENTERPRISE_)?TOKEN$/u.test(tokenSource),
  });
}

export function hasKeyWriteScope(auth) {
  return Boolean(auth?.scopes?.some((scope) => keyWriteScopes.has(scope)));
}

/** First two fields of an OpenSSH public key line: `<type> <base64>`. */
export function normalizePublicKey(text) {
  const match = publicKeyPattern.exec(String(text ?? "").trim());
  return match ? `${match[1]} ${match[2]}` : null;
}

/** `gh ssh-key list` (non-TTY, tab separated: title, key, created, id, type). */
export function parseSshKeyList(raw) {
  const keys = [];
  for (const line of String(raw ?? "").split(/\r?\n/u)) {
    if (line.trim() === "") continue;
    const fields = line.split("\t");
    if (fields.length < 2) continue;
    const key = normalizePublicKey(fields[1]);
    if (!key) continue;
    keys.push(Object.freeze({
      title: fields[0].trim(),
      key,
      id: (fields[3] ?? "").trim() || null,
      type: (fields[4] ?? "authentication").trim() || "authentication",
    }));
  }
  return Object.freeze(keys);
}

export function sshKeyRegistered(keys, publicKey) {
  const normalized = normalizePublicKey(publicKey);
  return Boolean(normalized) && keys.some((entry) => entry.key === normalized && entry.type !== "signing");
}

/** gh prints the user-facing code and the verification URL on stderr. */
export function parseDeviceCodeOutput(text) {
  const match = deviceCodePattern.exec(String(text ?? ""));
  return match ? Object.freeze({ user_code: match[1], verification_uri: GITHUB_DEVICE_URL }) : null;
}

/** `ssh -T git@github.com` output and exit code → transport state. */
export function classifySshProbe({ code, output }) {
  const text = String(output ?? "");
  const greeting = sshGreetingPattern.exec(text);
  if (greeting) return Object.freeze({ state: "ok", login: greeting[1] });
  if (/REMOTE HOST IDENTIFICATION HAS CHANGED|Host key for .* has changed/u.test(text)) {
    return Object.freeze({ state: "host_key_changed", login: null });
  }
  if (/No [A-Z0-9-]+ host key is known for|Host key verification failed/u.test(text)) {
    return Object.freeze({ state: "host_key_unknown", login: null });
  }
  if (/Permission denied/u.test(text)) return Object.freeze({ state: "denied", login: null });
  return Object.freeze({ state: code === 0 ? "denied" : "unreachable", login: null });
}

/** `ssh -G git@github.com` → the host key name ssh checks for github.com. */
export function parseSshConfig(raw) {
  const values = new Map();
  for (const line of String(raw ?? "").split(/\r?\n/u)) {
    const match = /^(\S+)\s+(.+)$/u.exec(line.trim());
    if (match && !values.has(match[1].toLowerCase())) values.set(match[1].toLowerCase(), match[2].trim());
  }
  const hostname = (values.get("hostname") ?? "github.com").toLowerCase();
  const port = Number(values.get("port") ?? 22);
  const alias = values.get("hostkeyalias");
  const knownHostsName = alias && alias !== "none"
    ? alias
    : port === 22 ? hostname : `[${hostname}]:${port}`;
  return Object.freeze({ hostname, port, known_hosts_name: knownHostsName });
}

/**
 * `/etc/lazurio/lazurio.machine.json` (Machines docs/machine-identity.md).
 * The only signal for who may be signed in; never guessed from hostnames.
 */
export function parseMachineAssignment(raw) {
  let value;
  try {
    value = JSON.parse(String(raw ?? ""));
  } catch {
    return Object.freeze({ kind: "invalid" });
  }
  if (value?.schema_version !== "lazurio.machine.v1") return Object.freeze({ kind: "invalid" });
  const owner = value.owner ?? {};
  const machineKind = value.machine?.kind;
  if (machineKind === "personal-vm" && owner.kind === "principal") {
    return expectedAccount("principal", owner.github_login, owner.github_id);
  }
  if (machineKind === "workspace-vm" && owner.kind === "organization") {
    const assignment = owner.assignment;
    if (!assignment) return Object.freeze({ kind: "unassigned" });
    if (assignment.kind === "team") return Object.freeze({ kind: "team" });
    if (assignment.kind === "operator") {
      return expectedAccount("operator", assignment.github_login, assignment.github_id);
    }
  }
  return Object.freeze({ kind: "invalid" });
}

function expectedAccount(kind, login, id) {
  if (typeof login !== "string" || !machineLoginPattern.test(login) || !Number.isSafeInteger(id) || id <= 0) {
    return Object.freeze({ kind: "invalid" });
  }
  return Object.freeze({ kind, github_login: login, github_id: id });
}

export function readMachineAssignment({ path = MACHINE_IDENTITY_FILE, exists = existsSync, read = readFileSync } = {}) {
  if (!exists(path)) return Object.freeze({ kind: "none" });
  try {
    return parseMachineAssignment(read(path, "utf8"));
  } catch {
    return Object.freeze({ kind: "invalid" });
  }
}

export function accountMatchesAssignment(user, assignment) {
  if (!assignment?.github_login) return true;
  return String(user?.login ?? "").toLowerCase() === assignment.github_login
    && Number(user?.id) === assignment.github_id;
}

export function normalizeOrganizationLogin(value) {
  if (value === undefined || value === null || value === "") return null;
  const login = String(value).trim();
  if (!setupGitHubPattern.test(login)) throw new GitHubLoginError("organization_login_invalid");
  return login;
}

export function organizationRootRemote(login) {
  return `git@github.com:${login}/${login}_GEN3.git`;
}

// ---------------------------------------------------------------------------
// Local effects.
// ---------------------------------------------------------------------------

export function sshKeyComment({ user, host }) {
  const clean = (value, fallback) => String(value ?? "").replace(/[^A-Za-z0-9._-]/gu, "") || fallback;
  return `${clean(user, "operator")}@${clean(host, "machine")} lazurio`;
}

/**
 * Makes sure `~/.ssh/id_ed25519` exists. Creates it without a passphrase only
 * when both halves are missing; a half-present pair is a blocker, never
 * overwritten. Returns only public material.
 */
export async function ensureSshKey({ home, comment, run }) {
  const directory = join(home, ".ssh");
  const privatePath = join(directory, "id_ed25519");
  const publicPath = `${privatePath}.pub`;
  const hasPrivate = existsSync(privatePath);
  const hasPublic = existsSync(publicPath);
  if (hasPrivate && hasPublic) {
    const publicKey = normalizePublicKey(await readFile(publicPath, "utf8"));
    if (!publicKey) throw new GitHubLoginError("ssh_public_key_unreadable");
    return Object.freeze({ created: false, public_key: publicKey, public_key_path: publicPath });
  }
  if (hasPrivate || hasPublic) throw new GitHubLoginError("ssh_key_pair_incomplete");

  const directoryExisted = existsSync(directory);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (!directoryExisted) await chmod(directory, 0o700);
  const result = await run("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", comment, "-f", privatePath]);
  if (result.code !== 0 || !existsSync(privatePath) || !existsSync(publicPath)) {
    throw new GitHubLoginError("ssh_key_generation_failed");
  }
  await chmod(privatePath, 0o600);
  const publicKey = normalizePublicKey(await readFile(publicPath, "utf8"));
  if (!publicKey) throw new GitHubLoginError("ssh_public_key_unreadable");
  return Object.freeze({ created: true, public_key: publicKey, public_key_path: publicPath });
}

/**
 * Pins GitHub's published SSH host keys (https://api.github.com/meta, TLS
 * authenticated) for the exact name ssh checks. Only for GitHub's own SSH
 * endpoints and only when no key is known yet; a changed key is never
 * re-accepted.
 */
export async function pinGitHubHostKeys({ home, run, fetchImpl }) {
  const config = await run("ssh", ["-G", "git@github.com"]);
  const target = parseSshConfig(config.stdout);
  if (config.code !== 0 || !githubSshHosts.has(target.hostname)) {
    throw new GitHubLoginError("github_host_key_unverifiable");
  }
  let keys;
  try {
    const response = await fetchImpl("https://api.github.com/meta", {
      headers: { accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error("meta unavailable");
    keys = (await response.json())?.ssh_keys;
  } catch {
    throw new GitHubLoginError("github_host_key_unverifiable");
  }
  const lines = (Array.isArray(keys) ? keys : [])
    .map(normalizePublicKey)
    .filter(Boolean)
    .map((key) => `${target.known_hosts_name} ${key}`);
  if (lines.length === 0) throw new GitHubLoginError("github_host_key_unverifiable");
  const directory = join(home, ".ssh");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await appendFile(join(directory, "known_hosts"), `${lines.join("\n")}\n`, { mode: 0o600 });
  return lines.length;
}

// ---------------------------------------------------------------------------
// Process runners (injected in tests).
// ---------------------------------------------------------------------------

function boundedAppend(buffer, chunk) {
  const next = buffer + chunk;
  return next.length > maxOutputBytes ? next.slice(-maxOutputBytes) : next;
}

export function runProcess(program, args, { env = process.env, cwd, timeoutMs = commandTimeoutMs } = {}) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let child;
    try {
      child = spawn(program, args, { env, cwd, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    } catch {
      resolve({ code: null, stdout: "", stderr: "" });
      return;
    }
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout = boundedAppend(stdout, chunk); });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr = boundedAppend(stderr, chunk); });
    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    };
    child.on("error", () => finish(null));
    child.on("close", (code) => finish(code));
  });
}

/** Long-running child whose combined output is streamed to `onOutput`. */
export function spawnStreaming(program, args, { env = process.env, onOutput }) {
  const child = spawn(program, args, { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  child.stdout.setEncoding("utf8").on("data", onOutput);
  child.stderr.setEncoding("utf8").on("data", onOutput);
  const exited = new Promise((resolve) => {
    child.on("error", () => resolve(null));
    child.on("close", (code) => resolve(code));
  });
  return { exited, kill: () => child.kill("SIGTERM") };
}

// ---------------------------------------------------------------------------
// Controller: status, one login session at a time, Organization install.
// ---------------------------------------------------------------------------

export function createGitHubLoginController({
  hosted = false,
  personalScope = false,
  env = process.env,
  home = homedir(),
  host = osHostname(),
  user = safeUserName(),
  readAssignment = () => readMachineAssignment(),
  readBrokered = () => brokeredGitHubIdentity({ fresh: true }),
  resolveExecutable = (name) => resolveExecutableOnPath(name, { environment: env }),
  run = runProcess,
  spawnDeviceFlow = spawnStreaming,
  fetchImpl = globalThis.fetch,
  deviceTimeoutMs = deviceFlowTimeoutMs,
  cliCommand = null,
  cliCwd = undefined,
  organizationScope = null,
  now = () => new Date(),
} = {}) {
  let session = null;
  let sessionCounter = 0;
  // GH_HOST would turn an empty config into an anonymous github.com entry;
  // every command here names github.com itself.
  const { GH_HOST: _host, ...githubEnvironment } = sanitizedGitHubEnvironment(env);
  const transportEnvironment = { ...env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" };

  function executable(name) {
    return resolveExecutable(name) ?? null;
  }

  async function gh(args, options = {}) {
    const program = executable("gh");
    if (!program) throw new GitHubLoginError("github_cli_missing");
    return run(program, args, { env: githubEnvironment, ...options });
  }

  async function tool(name, args, options = {}) {
    const program = executable(name);
    if (!program) return { code: null, stdout: "", stderr: "" };
    return run(program, args, { env: transportEnvironment, ...options });
  }

  async function readAuth() {
    const result = await gh(["auth", "status", "--json", "hosts"]);
    return parseGitHubAuthStatus(result.stdout);
  }

  async function readUser() {
    const result = await gh(["api", "user", "--jq", "{login: .login, id: .id}"]);
    if (result.code !== 0) return null;
    try {
      const value = JSON.parse(result.stdout);
      return typeof value?.login === "string" && Number.isSafeInteger(value?.id)
        ? Object.freeze({ login: value.login, id: value.id })
        : null;
    } catch {
      return null;
    }
  }

  async function probeSsh() {
    const result = await tool("ssh", [
      "-T", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ConnectTimeout=15", "git@github.com",
    ]);
    if (result.code === null && result.stdout === "" && result.stderr === "") {
      return Object.freeze({ state: "ssh_missing", login: null });
    }
    return classifySshProbe({ code: result.code, output: `${result.stdout}\n${result.stderr}` });
  }

  async function probeRoot(organization) {
    const result = await tool("git", [
      "ls-remote", "--exit-code", "--heads", "--", organizationRootRemote(organization), "refs/heads/main",
    ], { timeoutMs: 45_000 });
    return result.code === 0 && result.stdout.trim() !== "" ? "ok" : "failed";
  }

  function machineContext() {
    const brokered = readBrokered();
    const assignment = readAssignment();
    return { brokered, assignment };
  }

  // A reason why this Machine never gets a personal login from this page.
  function machineBlocker({ brokered, assignment }) {
    if (brokered || assignment.kind === "team") return "brokered_identity";
    if (assignment.kind === "invalid") return "machine_identity_invalid";
    if (assignment.kind === "unassigned") return "machine_assignment_missing";
    if (hosted && assignment.kind === "none") return "machine_identity_missing";
    return null;
  }

  function installAllowed(assignment) {
    return !personalScope && assignment.kind !== "principal";
  }

  async function status({ organization = null } = {}) {
    const organizationLogin = normalizeOrganizationLogin(organization);
    const context = machineContext();
    const base = {
      schema_version: GITHUB_LOGIN_SCHEMA,
      checked_at: now().toISOString(),
      machine: machineProjection(context.assignment, hosted),
      session: snapshot(),
    };
    const blocker = machineBlocker(context);
    if (blocker === "brokered_identity") {
      // Report the bot identity only; never offer or run a personal login.
      return { ...base, mode: "brokered", ready: false, blocker, actions: noActions() };
    }
    if (!executable("gh")) {
      return { ...base, mode: "personal", ready: false, blocker: "github_cli_missing", actions: noActions() };
    }
    const auth = await readAuth();
    const account = { state: auth.state, login: auth.login ?? null, id: null, git_protocol: auth.git_protocol ?? null };
    if (auth.brokered) {
      return { ...base, mode: "brokered", ready: false, blocker: "brokered_identity", account, actions: noActions() };
    }
    if (blocker) {
      return { ...base, mode: "personal", ready: false, blocker, account, actions: { ...noActions(), logout: canLogout(auth) } };
    }
    let accountBlocker = null;
    if (auth.environment_token) accountBlocker = "environment_token";
    if (auth.state === "unreadable") accountBlocker = "github_cli_unreadable";
    const userIdentity = auth.state === "logged_in" ? await readUser() : null;
    if (userIdentity) account.id = userIdentity.id;
    if (userIdentity && !accountMatchesAssignment(userIdentity, context.assignment)) {
      accountBlocker = "account_mismatch";
    }
    const ssh = auth.state === "logged_in" ? await probeSsh() : { state: "skipped", login: null };
    const sshMatches = ssh.state === "ok" && userIdentity
      ? ssh.login.toLowerCase() === userIdentity.login.toLowerCase()
      : null;
    const rootProbe = organizationLogin && ssh.state === "ok"
      ? await probeRoot(organizationLogin)
      : organizationLogin ? "skipped" : null;
    const ready = auth.state === "logged_in"
      && account.git_protocol === "ssh"
      && Boolean(userIdentity)
      && accountBlocker === null
      && sshMatches === true
      && (rootProbe === null || rootProbe === "ok");
    return {
      ...base,
      mode: "personal",
      ready,
      blocker: accountBlocker,
      account,
      ssh: { state: ssh.state, login: ssh.login, matches_account: sshMatches },
      organization: organizationLogin
        ? { login: organizationLogin, root_repository: `${organizationLogin}/${organizationLogin}_GEN3`, ls_remote: rootProbe }
        : null,
      actions: {
        login: accountBlocker === null && !ready,
        logout: canLogout(auth),
        update: ready,
        organization_install: ready && Boolean(organizationLogin) && installAllowed(context.assignment),
      },
    };
  }

  function noActions() {
    return { login: false, logout: false, update: false, organization_install: false };
  }

  // Signing out is the way back from any wrong sign-in (another account, a
  // broken gh configuration). A token in the environment is not ours to drop.
  function canLogout(auth) {
    return !auth.environment_token && (auth.state === "logged_in" || auth.state === "unreadable");
  }

  // Signs this Machine out of GitHub: unregisters this Machine's own SSH key
  // from the signed-in account, so the next sign-in can bind it to another
  // account, then removes the GitHub CLI login. The local key pair stays.
  async function logout() {
    if (session && ["running", "awaiting_user"].includes(session.state)) {
      throw new GitHubLoginError("login_in_progress");
    }
    const context = machineContext();
    if (context.brokered || context.assignment.kind === "team") throw new GitHubLoginError("brokered_identity");
    if (!executable("gh")) throw new GitHubLoginError("github_cli_missing");
    const auth = await readAuth();
    if (auth.brokered) throw new GitHubLoginError("brokered_identity");
    if (auth.environment_token) throw new GitHubLoginError("environment_token");
    if (!canLogout(auth)) return { logged_out: false, login: null, ssh_key_removed: false };
    let sshKeyRemoved = false;
    const publicPath = join(home, ".ssh", "id_ed25519.pub");
    const publicKey = existsSync(publicPath) ? normalizePublicKey(await readFile(publicPath, "utf8")) : null;
    if (auth.state === "logged_in" && publicKey && auth.scopes?.includes(GITHUB_KEY_SCOPE)) {
      const listed = await gh(["ssh-key", "list"]);
      if (listed.code !== 0) throw new GitHubLoginError("ssh_key_list_failed");
      for (const entry of parseSshKeyList(listed.stdout)) {
        if (entry.key !== publicKey || entry.type === "signing" || !entry.id) continue;
        const removed = await gh(["ssh-key", "delete", entry.id, "--yes"]);
        if (removed.code !== 0) throw new GitHubLoginError("ssh_key_remove_failed");
        sshKeyRemoved = true;
      }
    }
    const args = ["auth", "logout", "--hostname", "github.com"];
    if (auth.login) args.push("--user", auth.login);
    const result = await gh(args);
    if (result.code !== 0) throw new GitHubLoginError("logout_failed");
    session = null;
    return { logged_out: true, login: auth.login ?? null, ssh_key_removed: sshKeyRemoved };
  }

  function holdsCapability(capability) {
    if (!session || typeof capability !== "string") return false;
    const expected = Buffer.from(session.capability);
    const given = Buffer.from(capability);
    return given.length === expected.length && timingSafeEqual(given, expected);
  }

  // Everyone admitted sees progress; only the starter sees the code.
  function snapshot(capability = null) {
    if (!session) return null;
    const owner = holdsCapability(capability);
    return {
      id: session.id,
      state: session.state,
      started_at: session.started_at,
      finished_at: session.finished_at,
      steps: session.steps.map((step) => ({ ...step })),
      // Present only while GitHub waits for the person in the browser.
      device: owner && session.state === "awaiting_user" && session.device ? { ...session.device } : null,
      error: session.error,
      ssh_key_created: session.ssh_key_created,
      ssh_key_registered: session.ssh_key_registered,
    };
  }

  function start({ organization = null } = {}) {
    const organizationLogin = normalizeOrganizationLogin(organization);
    if (session && ["running", "awaiting_user"].includes(session.state)) {
      throw new GitHubLoginError("login_in_progress");
    }
    sessionCounter += 1;
    session = {
      id: `github-login-${sessionCounter}`,
      capability: randomBytes(32).toString("base64url"),
      state: "running",
      started_at: now().toISOString(),
      finished_at: null,
      steps: ["account", "login", "identity", "ssh_key", "verify"].map((id) => ({ id, state: "pending" })),
      device: null,
      child: null,
      cancelled: false,
      error: null,
      ssh_key_created: false,
      ssh_key_registered: false,
    };
    const current = session;
    current.done = runSession(current, organizationLogin).then(
      () => finish(current, "completed", null),
      (error) => finish(current, current.cancelled ? "cancelled" : "failed",
        error instanceof GitHubLoginError ? error.code : "login_failed"),
    );
    return { ...snapshot(current.capability), capability: current.capability };
  }

  function finish(current, state, error) {
    current.state = state;
    current.error = error;
    current.device = null;
    current.child = null;
    current.finished_at = now().toISOString();
    for (const step of current.steps) {
      if (step.state === "running") step.state = state === "completed" ? "done" : "failed";
    }
  }

  function cancel(capability = null, { force = false } = {}) {
    if (!force && !holdsCapability(capability)) throw new GitHubLoginError("session_capability_invalid");
    if (!session || !["running", "awaiting_user"].includes(session.state)) return snapshot(capability);
    session.cancelled = true;
    session.child?.kill();
    return snapshot(capability);
  }

  function step(current, id, state) {
    const entry = current.steps.find((item) => item.id === id);
    entry.state = state;
  }

  function assertActive(current) {
    if (current.cancelled) throw new GitHubLoginError("cancelled");
  }

  async function deviceFlow(current, args) {
    const program = executable("gh");
    if (!program) throw new GitHubLoginError("github_cli_missing");
    let output = "";
    let timedOut = false;
    const child = spawnDeviceFlow(program, args, {
      env: githubEnvironment,
      onOutput: (chunk) => {
        if (current.device) return;
        output = boundedAppend(output, String(chunk));
        const device = parseDeviceCodeOutput(output);
        if (device) {
          output = "";
          current.device = { ...device, expires_at: new Date(now().getTime() + deviceTimeoutMs).toISOString() };
          current.state = "awaiting_user";
        }
      },
    });
    current.child = child;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, deviceTimeoutMs);
    const code = await child.exited;
    clearTimeout(timer);
    output = "";
    current.device = null;
    current.child = null;
    if (!current.cancelled) current.state = "running";
    assertActive(current);
    if (timedOut) throw new GitHubLoginError("device_flow_timeout");
    if (code !== 0) throw new GitHubLoginError("device_flow_failed");
  }

  async function runSession(current, organizationLogin) {
    step(current, "account", "running");
    const context = machineContext();
    const blocker = machineBlocker(context);
    if (blocker) throw new GitHubLoginError(blocker);
    if (!executable("gh")) throw new GitHubLoginError("github_cli_missing");
    let auth = await readAuth();
    if (auth.brokered) throw new GitHubLoginError("brokered_identity");
    if (auth.environment_token) throw new GitHubLoginError("environment_token");
    if (auth.state === "unreadable") throw new GitHubLoginError("github_cli_unreadable");
    step(current, "account", "done");
    assertActive(current);

    step(current, "login", "running");
    if (auth.state !== "logged_in") {
      await deviceFlow(current, [
        "auth", "login", "--hostname", "github.com", "--git-protocol", "ssh", "--web", "--skip-ssh-key",
        "--scopes", GITHUB_KEY_SCOPE,
      ]);
      auth = await readAuth();
      if (auth.state !== "logged_in") throw new GitHubLoginError("login_incomplete");
    }
    if (auth.git_protocol !== "ssh") {
      const configured = await gh(["config", "set", "git_protocol", "ssh", "--host", "github.com"]);
      if (configured.code !== 0) throw new GitHubLoginError("git_protocol_not_set");
    }
    step(current, "login", "done");
    assertActive(current);

    // The account must be the one this Machine is assigned to before any key
    // is uploaded to it.
    step(current, "identity", "running");
    const identity = await readUser();
    if (!identity) throw new GitHubLoginError("identity_unavailable");
    if (!accountMatchesAssignment(identity, context.assignment)) throw new GitHubLoginError("account_mismatch");
    step(current, "identity", "done");
    assertActive(current);

    step(current, "ssh_key", "running");
    let ssh = await probeSsh();
    if (ssh.state === "host_key_unknown") {
      assertActive(current);
      await pinGitHubHostKeys({ home, run: (name, args) => tool(name, args), fetchImpl });
      ssh = await probeSsh();
    }
    if (ssh.state === "host_key_changed") throw new GitHubLoginError("github_host_key_changed");
    if (ssh.state === "ssh_missing") throw new GitHubLoginError("ssh_missing");
    // No access change that could not be proven afterwards.
    if (ssh.state === "unreachable") throw new GitHubLoginError("github_ssh_unreachable");
    if (ssh.state === "ok" && ssh.login.toLowerCase() !== identity.login.toLowerCase()) {
      // Another key already answers for a different account; a new key
      // would not be offered first and cannot fix it.
      throw new GitHubLoginError("ssh_account_mismatch");
    }
    if (ssh.state !== "ok") {
      // A cancel lands between awaits; every access change re-checks it.
      assertActive(current);
      const key = await ensureSshKey({
        home,
        comment: sshKeyComment({ user, host }),
        run: (name, args) => tool(name, args),
      });
      current.ssh_key_created = key.created;
      assertActive(current);
      if (!hasKeyWriteScope(auth)) {
        await deviceFlow(current, ["auth", "refresh", "--hostname", "github.com", "--scopes", GITHUB_KEY_SCOPE]);
        auth = await readAuth();
        if (!hasKeyWriteScope(auth)) throw new GitHubLoginError("key_scope_missing");
      }
      const listed = await gh(["ssh-key", "list"]);
      if (listed.code !== 0) throw new GitHubLoginError("ssh_key_list_failed");
      if (!sshKeyRegistered(parseSshKeyList(listed.stdout), key.public_key)) {
        assertActive(current);
        const added = await gh(["ssh-key", "add", key.public_key_path, "--title", `${sshKeyComment({ user, host })}`]);
        if (added.code !== 0) throw new GitHubLoginError("ssh_key_add_failed");
        current.ssh_key_registered = true;
      }
      ssh = await probeSsh();
      if (ssh.state !== "ok" || ssh.login.toLowerCase() !== identity.login.toLowerCase()) {
        throw new GitHubLoginError("ssh_transport_failed");
      }
    }
    step(current, "ssh_key", "done");
    assertActive(current);

    step(current, "verify", "running");
    if (organizationLogin && await probeRoot(organizationLogin) !== "ok") {
      throw new GitHubLoginError("organization_root_unreachable");
    }
    step(current, "verify", "done");
  }

  // A hosted Organization Launchpad installs only its own Organization. The
  // GitHub login differs from the company slug, so the root manifest decides.
  async function organizationInScope(organizationLogin) {
    if (!organizationScope) return true;
    const result = await gh([
      "api", "-H", "Accept: application/vnd.github.raw+json",
      `repos/${organizationLogin}/${organizationLogin}_GEN3/contents/company.gen3.json`,
    ]);
    try {
      return result.code === 0 && JSON.parse(result.stdout)?.company?.slug === organizationScope;
    } catch {
      return false;
    }
  }

  async function organizationInstall({ organization }) {
    const organizationLogin = normalizeOrganizationLogin(organization);
    if (!organizationLogin) throw new GitHubLoginError("organization_login_invalid");
    const context = machineContext();
    const blocker = machineBlocker(context);
    if (blocker) throw new GitHubLoginError(blocker);
    if (!installAllowed(context.assignment)) throw new GitHubLoginError("organization_install_not_available");
    if (!cliCommand) throw new GitHubLoginError("organization_install_not_available");
    // The same gate the page shows, re-run here: assigned account, no
    // environment token, SSH working for it and the root readable.
    const readiness = await status({ organization: organizationLogin });
    if (!readiness.ready) throw new GitHubLoginError(readiness.blocker ?? "organization_install_not_ready");
    if (!await organizationInScope(organizationLogin)) throw new GitHubLoginError("organization_outside_machine_scope");
    const [program, ...prefix] = cliCommand;
    const result = await run(program, [
      ...prefix, "organization", "install", organizationLogin, "--role", ORGANIZATION_INSTALL_ROLE, "--json",
    ], { env, cwd: cliCwd, timeoutMs: installTimeoutMs });
    let report = null;
    try {
      report = JSON.parse(result.stdout);
    } catch {
      report = null;
    }
    if (!report || typeof report !== "object") throw new GitHubLoginError("organization_install_unreadable");
    return { exit_code: result.code, report };
  }

  return Object.freeze({
    status,
    start,
    cancel,
    logout,
    snapshot,
    organizationInstall,
    // Test and shutdown hook: resolves when the current session settles.
    settled: () => session?.done ?? Promise.resolve(),
  });
}

function machineProjection(assignment, hosted) {
  return {
    profile: hosted ? "hosted" : "local",
    assignment: assignment.kind,
    expected_login: assignment.github_login ?? null,
  };
}

function safeUserName() {
  try {
    return userInfo().username;
  } catch {
    return "operator";
  }
}
