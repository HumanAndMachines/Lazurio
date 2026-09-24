import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { parsePublicKeyInput } from "./ssh-access-lib.mjs";
import { runProcess } from "./setup-github-lib.mjs";
import { readTailscaleIdentity, validControlUrl } from "./tailscale-identity-lib.mjs";

// Laptop side of Machine connections — local profile only. Two things a
// person clicks in the Launchpad of their own laptop:
//
// 1. Network: ask to join an Organization's Headscale. `tailscale login`
//    against the Organization's login server yields the registration URL;
//    the join request travels as a GitHub issue in the Organization root
//    repository, written with the person's own `gh` (members may write
//    there, infra stays closed, GitHub remains the only access authority).
//    The Organization's Admin approves by registering the node and granting
//    port 22 in the Deployment Repo, or refuses by closing the issue.
// 2. Connections: activate SSH from this laptop to a hosted Machine whose
//    Launchpad handed over the facts (label, tailnet address, user, host
//    key): create the key pair, write ~/.ssh/lazurio/<label>.conf with the
//    pinned known_hosts and include it once in ~/.ssh/config — the same
//    layout as the paste command in ssh-access-lib, without a terminal.
//
// Nothing here changes Headscale policy: port 22 between nodes stays a grant
// the Organization declares in its Deployment Repo.

export class LaptopNetworkError extends Error {
  constructor(code, details = {}) {
    super(code);
    this.code = code;
    this.details = details;
  }
}

const labelPattern = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const ipv4Pattern = /^100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.(?:25[0-5]|2[0-4]\d|1?\d?\d)\.(?:25[0-5]|2[0-4]\d|1?\d?\d)$/;
const userPattern = /^[a-z_][a-z0-9_-]{0,31}$/;
const tailnetPattern = /^[A-Za-z0-9._@+-]{1,253}$/;
const registrationUrlPattern = /https:\/\/[A-Za-z0-9.-]+(?::\d+)?\/register\/([A-Za-z0-9_-]{16,})/;
const includeLine = "Include lazurio/*.conf";
const loginTimeoutMs = 15_000;

export function validLoginServer(value) {
  return validControlUrl(value);
}

// The registration URL Headscale hands to the client:
// https://<login server>/register/<key>. The key is what the Admin registers.
export function extractRegistration(text) {
  const match = registrationUrlPattern.exec(String(text ?? ""));
  return match ? { url: match[0], key: match[1] } : null;
}

export function hostBlock({ label, ipv4, user }) {
  return [
    `Host ${label}`,
    `  HostName ${ipv4}`,
    `  User ${user}`,
    `  IdentityFile ~/.ssh/lazurio-${label}`,
    "  IdentitiesOnly yes",
    `  HostKeyAlias ${label}`,
    `  UserKnownHostsFile ~/.ssh/lazurio/${label}.known_hosts`,
    "  StrictHostKeyChecking yes",
  ].join("\n") + "\n";
}

export function parseHostBlock(label, text) {
  const value = (name) => {
    const match = new RegExp(`^\\s*${name}\\s+(\\S+)\\s*$`, "m").exec(String(text ?? ""));
    return match ? match[1] : null;
  };
  return { label, host: value("HostName"), user: value("User"), identity_file: value("IdentityFile"), connect: `ssh ${label}` };
}

// Host blocks of an OpenSSH config: label, HostName, User, IdentityFile.
// Patterns (`*`, `?`, negations, multi-name) are skipped: they name no Machine.
export function parseSshConfigHosts(text) {
  const blocks = [];
  let current = null;
  for (const rawLine of String(text ?? "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(\S+)\s+(.+)$/.exec(line);
    if (!match) continue;
    const [, keyword, value] = match;
    if (keyword.toLowerCase() === "host") {
      const names = value.trim().split(/\s+/);
      current = names.length === 1 && /^[A-Za-z0-9._-]+$/.test(names[0]) ? { label: names[0], host: null, user: null, identity_file: null, connect: `ssh ${names[0]}` } : null;
      if (current) blocks.push(current);
      continue;
    }
    if (keyword.toLowerCase() === "match") { current = null; continue; }
    if (!current) continue;
    const lower = keyword.toLowerCase();
    if (lower === "hostname" && current.host === null) current.host = value.trim();
    else if (lower === "user" && current.user === null) current.user = value.trim();
    else if (lower === "identityfile" && current.identity_file === null) current.identity_file = value.trim();
  }
  return blocks;
}

export function isLazurioMachineHost(host) {
  const value = String(host ?? "").toLowerCase();
  return ipv4Pattern.test(value) || value.endsWith(".lazurio.io");
}

function tailscaleCandidates(platform, env) {
  if (platform === "win32") {
    return [join(env.ProgramFiles ?? "C:\\Program Files", "Tailscale", "tailscale.exe"), "tailscale.exe"];
  }
  if (platform === "darwin") {
    return ["/Applications/Tailscale.app/Contents/MacOS/Tailscale", "/opt/homebrew/bin/tailscale", "/usr/local/bin/tailscale", "tailscale"];
  }
  return ["/usr/bin/tailscale", "tailscale"];
}

function joinRequestBody({ organization, requester, device, platform, loginServer, registration }) {
  return [
    "Žádost o přijetí notebooku do Headscale Organizace. Vytvořil ji Launchpad na notebooku žadatele; nic z toho není tajemství.",
    "",
    `- Organizace: ${organization.display_name} (\`${organization.slug}\`)`,
    `- Kdo: @${requester}`,
    `- Zařízení: \`${device}\` (${platform})`,
    `- Login server: ${loginServer}`,
    `- Registrační klíč: \`${registration.key}\``,
    `- Registrační URL: ${registration.url}`,
    "",
    "**Schválení** (Admin Conglomerate Hostu):",
    `1. na hostu: \`headscale nodes register --user ${requester.toLowerCase()} --key ${registration.key}\` (nebo pod uživatelem, kterého Organizace pro tuto osobu používá);`,
    "2. v Deployment Repu grant portu 22 z tohoto nodu na VM žadatele (`workspace_ssh_grants`), PR + review + apply;",
    "3. zavřít tuto issue. Launchpad žadatele připojení uvidí sám.",
    "",
    "**Zamítnutí:** zavřít issue bez registrace.",
  ].join("\n");
}

export function createLaptopNetworkService({
  home,
  stateRoot,
  hostName,
  organizations,
  platform = process.platform,
  env = process.env,
  run = runProcess,
  now = () => new Date(),
}) {
  const sshDirectory = join(home, ".ssh");
  const lazurioDirectory = join(sshDirectory, "lazurio");
  const requestsPath = join(stateRoot, "runtime", "network", "join-requests.json");
  // Ownership ledger of the connections this Launchpad wrote: which .conf and
  // known_hosts it created and whether it generated the private key. Removal
  // deletes only what the ledger proves is Launchpad's; a hand-authored
  // ~/.ssh/lazurio/*.conf or a pre-existing key is never touched.
  const connectionsPath = join(stateRoot, "runtime", "network", "connections.json");
  let tailscalePath;

  async function resolveTailscale() {
    if (tailscalePath !== undefined) return tailscalePath;
    for (const candidate of tailscaleCandidates(platform, env)) {
      if (isAbsolute(candidate) && !existsSync(candidate)) continue;
      const probe = await run(candidate, ["version"], { timeoutMs: 5_000 });
      if (probe.code === 0) {
        tailscalePath = candidate;
        return candidate;
      }
    }
    tailscalePath = null;
    return null;
  }

  // One identity resolver with the Machine's SSH step (tailscale-identity-lib):
  // the control server tailscaled is logged into, CurrentTailnet.Name only as
  // fallback. The hand-over compares the two sides' answers.
  async function readStatus(tailscale) {
    if (!tailscale) return { backend_state: null, tailnet: null, control_url: null, ipv4: null, auth_url: null, host_name: null };
    return readTailscaleIdentity(run, tailscale);
  }

  async function readRequests() {
    try {
      const parsed = JSON.parse(await readFile(requestsPath, "utf8"));
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }

  async function saveRequest(record) {
    const requests = await readRequests();
    requests[record.organization] = record;
    await mkdir(dirname(requestsPath), { recursive: true });
    await writeFile(requestsPath, JSON.stringify(requests, null, 2) + "\n", { mode: 0o600 });
  }

  async function readOwned() {
    try {
      const parsed = JSON.parse(await readFile(connectionsPath, "utf8"));
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }

  async function writeOwned(owned) {
    await mkdir(dirname(connectionsPath), { recursive: true });
    await writeFile(connectionsPath, JSON.stringify(owned, null, 2) + "\n", { mode: 0o600 });
  }

  async function issueState(url) {
    const result = await run("gh", ["issue", "view", url, "--json", "state", "--jq", ".state"], { timeoutMs: 10_000 });
    return result.code === 0 ? result.stdout.trim().toLowerCase() || null : null;
  }

  async function listOrganizations() {
    const list = await organizations();
    return (Array.isArray(list) ? list : []).map((organization) => ({
      slug: String(organization.slug ?? ""),
      display_name: String(organization.display_name ?? organization.slug ?? ""),
      repository: typeof organization.repository === "string" ? organization.repository : null,
      headscale_login_server: validLoginServer(organization.conglomerate_host?.headscale_login_server),
    })).filter((organization) => organization.slug);
  }

  async function read() {
    const tailscale = await resolveTailscale();
    const [status, requests, list] = await Promise.all([readStatus(tailscale), readRequests(), listOrganizations()]);
    const projected = [];
    for (const organization of list) {
      const tailnet = organization.headscale_login_server ? new URL(organization.headscale_login_server).hostname : null;
      let request = requests[organization.slug] ?? null;
      const connected = Boolean(tailnet) && status.tailnet === tailnet && status.backend_state === "Running";
      // A request whose issue the Admin closed without registering the node
      // was refused (or expired): it must not look pending forever, the
      // person may ask again.
      if (request && !connected) {
        request = { ...request, issue_state: request.issue_url ? await issueState(request.issue_url) : null };
      }
      const refused = Boolean(request) && !connected && request.issue_state === "closed";
      const state = !organization.headscale_login_server
        ? "unconfigured"
        : connected ? "connected" : refused ? "refused" : request ? "pending" : "none";
      projected.push({ ...organization, tailnet, state, request });
    }
    return {
      available: true,
      tailscale: { installed: Boolean(tailscale), path: tailscale },
      status,
      organizations: projected,
    };
  }

  async function requestJoin({ organization: slug }) {
    const organization = (await listOrganizations()).find((item) => item.slug === slug);
    if (!organization) throw new LaptopNetworkError("organization_unknown");
    if (!organization.headscale_login_server) throw new LaptopNetworkError("login_server_unconfigured");
    if (!organization.repository) throw new LaptopNetworkError("organization_repository_unknown");
    const tailscale = await resolveTailscale();
    if (!tailscale) throw new LaptopNetworkError("tailscale_missing");
    const tailnet = new URL(organization.headscale_login_server).hostname;

    // `tailscale login` prints the registration URL and then waits for the
    // Admin; the CLI is stopped once the URL is known, tailscaled keeps the
    // login pending and completes it on its own after the registration.
    const login = await run(tailscale, ["login", "--login-server", organization.headscale_login_server], { timeoutMs: loginTimeoutMs });
    let registration = extractRegistration(`${login.stdout}\n${login.stderr}`);
    for (let attempt = 0; !registration && attempt < 3; attempt += 1) {
      const status = await readStatus(tailscale);
      if (status.backend_state === "Running" && status.tailnet === tailnet) {
        return { state: "connected", organization: organization.slug, tailnet };
      }
      registration = extractRegistration(status.auth_url);
      if (!registration) await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    if (!registration) throw new LaptopNetworkError("registration_url_unavailable");

    const who = await run("gh", ["api", "user", "--jq", ".login"], { timeoutMs: 15_000 });
    const requester = who.code === 0 ? who.stdout.trim() : "";
    if (!/^[A-Za-z0-9-]{1,39}$/.test(requester)) {
      throw new LaptopNetworkError("github_cli_unavailable", { registration });
    }
    const device = String(hostName ?? "laptop");
    const title = `Headscale: přijetí notebooku ${device} (${requester}) do ${organization.display_name}`;
    const body = joinRequestBody({
      organization, requester, device, platform, loginServer: organization.headscale_login_server, registration,
    });
    const issue = await run("gh", ["issue", "create", "-R", organization.repository, "--title", title, "--body", body], { timeoutMs: 30_000 });
    const issueUrl = /https:\/\/github\.com\/\S+\/issues\/\d+/.exec(issue.stdout)?.[0] ?? null;
    if (issue.code !== 0 || !issueUrl) {
      throw new LaptopNetworkError("join_request_failed", { registration, repository: organization.repository });
    }
    const record = {
      organization: organization.slug,
      login_server: organization.headscale_login_server,
      tailnet,
      registration_url: registration.url,
      registration_key: registration.key,
      requester,
      device,
      issue_url: issueUrl,
      requested_at: now().toISOString(),
    };
    await saveRequest(record);
    return { state: "pending", ...record };
  }

  // Managed connections are the ~/.ssh/lazurio/<label>.conf files the
  // ownership ledger records. A .conf a person put there by hand, and hosts
  // written straight into ~/.ssh/config that point at a Lazurio Machine (a
  // tailnet address or a lazurio.io name), are listed read-only: Launchpad
  // never rewrites or removes what it did not create.
  async function readConnections() {
    const connections = [];
    const owned = await readOwned();
    let entries = [];
    try {
      entries = (await readdir(lazurioDirectory)).filter((name) => name.endsWith(".conf")).sort();
    } catch {
      entries = [];
    }
    for (const name of entries) {
      const label = name.slice(0, -".conf".length);
      if (!labelPattern.test(label)) continue;
      connections.push({ ...parseHostBlock(label, await readFile(join(lazurioDirectory, name), "utf8")), managed: Boolean(owned[label]) });
    }
    const managedLabels = new Set(connections.map((connection) => connection.label));
    let config = "";
    try {
      config = await readFile(join(sshDirectory, "config"), "utf8");
    } catch {
      return connections;
    }
    for (const block of parseSshConfigHosts(config)) {
      if (managedLabels.has(block.label) || !isLazurioMachineHost(block.host)) continue;
      connections.push({ ...block, managed: false });
    }
    return connections;
  }

  async function connect({ label, ipv4, user, tailnet, host_key: hostKey } = {}) {
    if (!labelPattern.test(label ?? "")) throw new LaptopNetworkError("label_invalid");
    if (!ipv4Pattern.test(ipv4 ?? "")) throw new LaptopNetworkError("ipv4_invalid");
    if (!userPattern.test(user ?? "")) throw new LaptopNetworkError("user_invalid");
    if (!tailnetPattern.test(tailnet ?? "")) throw new LaptopNetworkError("tailnet_invalid");
    let parsedHostKey;
    try {
      parsedHostKey = parsePublicKeyInput(`${hostKey?.type ?? ""} ${hostKey?.key ?? ""}`);
    } catch {
      throw new LaptopNetworkError("host_key_invalid");
    }
    const tailscale = await resolveTailscale();
    if (!tailscale) throw new LaptopNetworkError("tailscale_missing");
    const status = await readStatus(tailscale);
    if (status.tailnet !== tailnet) throw new LaptopNetworkError("tailnet_mismatch", { active: status.tailnet, expected: tailnet });

    const owned = await readOwned();
    const confPath = join(lazurioDirectory, `${label}.conf`);
    if (!owned[label] && existsSync(confPath)) {
      // Someone wrote this .conf by hand; it is theirs to change.
      throw new LaptopNetworkError("connection_unmanaged", { label });
    }
    await mkdir(sshDirectory, { recursive: true, mode: 0o700 });
    await mkdir(lazurioDirectory, { recursive: true, mode: 0o700 });
    const keyPath = join(sshDirectory, `lazurio-${label}`);
    let created = false;
    if (!existsSync(keyPath)) {
      const keygen = await run("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", `lazurio-launchpad ${hostName ?? "laptop"}`, "-f", keyPath], { timeoutMs: 20_000 });
      if (keygen.code !== 0) throw new LaptopNetworkError("ssh_keygen_failed");
      created = true;
    }
    const publicKey = (await readFile(`${keyPath}.pub`, "utf8")).trim();
    await writeFile(confPath, hostBlock({ label, ipv4, user }), { mode: 0o600 });
    await writeFile(join(lazurioDirectory, `${label}.known_hosts`), `${label} ${parsedHostKey.type} ${parsedHostKey.body}\n`, { mode: 0o600 });
    owned[label] = {
      label,
      conf: confPath,
      known_hosts: join(lazurioDirectory, `${label}.known_hosts`),
      key: keyPath,
      // True only when this Launchpad generated the key (now or earlier);
      // a key that already existed stays the person's own on removal.
      key_created: created || owned[label]?.key_created === true,
      created_at: owned[label]?.created_at ?? now().toISOString(),
      updated_at: now().toISOString(),
    };
    await writeOwned(owned);
    const configPath = join(sshDirectory, "config");
    const existing = existsSync(configPath) ? await readFile(configPath, "utf8") : "";
    if (!existing.split(/\r?\n/).includes(includeLine)) {
      await writeFile(configPath, `${includeLine}\n\n${existing}`, { mode: 0o600 });
    }
    return {
      label,
      public_key: publicKey,
      fingerprint: parsePublicKeyInput(publicKey).fingerprint,
      created,
      connect: `ssh ${label}`,
    };
  }

  // Removes only what the ledger proves this Launchpad wrote: its .conf and
  // known_hosts always, the private key only when it generated it. Anything
  // else (a hand-authored .conf, a pre-existing key) is refused untouched.
  async function removeConnection({ label } = {}) {
    if (!labelPattern.test(label ?? "")) throw new LaptopNetworkError("label_invalid");
    const owned = await readOwned();
    const record = owned[label];
    if (!record) throw new LaptopNetworkError("connection_unmanaged", { label });
    await rm(join(lazurioDirectory, `${label}.conf`), { force: true });
    await rm(join(lazurioDirectory, `${label}.known_hosts`), { force: true });
    const keyRemoved = record.key_created === true;
    if (keyRemoved) {
      await rm(join(sshDirectory, `lazurio-${label}`), { force: true });
      await rm(join(sshDirectory, `lazurio-${label}.pub`), { force: true });
    }
    delete owned[label];
    await writeOwned(owned);
    return { removed: true, label, key_removed: keyRemoved };
  }

  return { read, requestJoin, readConnections, connect, removeConnection };
}
