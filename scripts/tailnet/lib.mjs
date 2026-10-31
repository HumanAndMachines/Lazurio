// Foreign tailnets on a Linux Environment, one kernel-mode tailscaled each.
//
// Every foreign tailnet gets its own Docker container: its own network
// namespace, its own /etc (the Linux DNS manager of tailscaled backs up
// resolv.conf next to it in /etc and may restart systemd-resolved when it
// closes, so instances sharing one /etc would fight), its own state and its
// own socket. A thread picks the tailnet per command (`run`, `proxy`,
// `ssh-proxy`); nothing switches globally and nothing routes between
// tailnets. The Environment's own tailscaled, the system service whose
// network Machines manages, is never touched.
//
// This module holds what can be decided without running anything: names,
// config, ports, docker arguments, the entrypoint, the `run` invocation and
// the doctor verdicts. cli.mjs does the I/O. Manual: manual/station-tailnets.md.
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, posix } from "node:path";

// Host side of every tailnet. Not under /var/lib/lazurio: that directory is
// root-only (0700) and belongs to other services, so a socket below it would
// need sudo for every `tailscale --socket` call.
export const TAILNETS_ROOT = "/var/lib/lazurio-tailnets";
// The Environment's own tailscaled: the systemd RuntimeDirectory and the
// CLI's default path through the /var/run symlink.
export const SYSTEM_SOCKET_DIR = "/run/tailscale";
export const SYSTEM_SOCKETS = Object.freeze(["/run/tailscale/tailscaled.sock", "/var/run/tailscale/tailscaled.sock"]);
export const CONTAINER_SOCKS5_PORT = 1055;
export const CONTAINER_HTTP_PORT = 1056;
// Host loopback ports, allocated in pairs: SOCKS5 on the even port, HTTP on the next.
export const PORT_RANGE = Object.freeze({ first: 10550, last: 10649 });
export const CGNAT_IPV4 = "100.64.0.0/10";
export const TAILSCALE_IPV6 = "fd7a:115c:a1e0::/48";
export const QUAD_100 = "100.100.100.100";
export const CONFIG_SCHEMA = "lazurio.tailnet.v1";
export const ENTRYPOINT_IN_CONTAINER = "/usr/local/bin/lazurio-tailnet-entrypoint";
export const LABEL = "ai.lazurio.tailnet";
export const SPEC_LABEL = "ai.lazurio.tailnet.spec";
export const UP_TIMEOUT_SECONDS = 15;
export const USAGE = 2;
// `up` stopped at sign-in or at the Admin's approval: not an error, not done.
export const WAITING = 3;

const NAME = /^[a-z0-9][a-z0-9-]{0,38}$/u;
const NODE_NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const USER_NAME = /^[a-z_][a-z0-9_.-]{0,31}$/u;
const IMAGE = /^((?:docker\.io\/|ghcr\.io\/)?tailscale\/tailscale)(?::([A-Za-z0-9_][A-Za-z0-9_.-]{0,127}))?(?:@(sha256:[0-9a-f]{64}))?$/u;
const PINNED = /^(?:ghcr\.io\/)?tailscale\/tailscale@sha256:[0-9a-f]{64}$/u;

export class TailnetError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.name = "TailnetError";
    this.exitCode = exitCode;
  }
}

export function validateName(name) {
  if (typeof name !== "string" || !NAME.test(name)) {
    throw new TailnetError(`a tailnet name matches ${NAME.source} (got ${JSON.stringify(name ?? null)})`, USAGE);
  }
  return name;
}

export function validateNodeName(hostname) {
  if (typeof hostname !== "string" || !NODE_NAME.test(hostname)) {
    throw new TailnetError(`--hostname is one lowercase DNS label, e.g. <login>-<device>-cli (got ${JSON.stringify(hostname ?? null)})`, USAGE);
  }
  return hostname;
}

// The login server as tailscaled reports it in ControlURL: scheme, host and
// path without a trailing slash.
export function normalizeLoginServer(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    url = null;
  }
  if (!url || !["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new TailnetError(`--login-server is an http(s) URL without credentials or query (got ${JSON.stringify(value ?? null)})`, USAGE);
  }
  return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/u, "")}`;
}

// Everything on the host and in Docker that belongs to one tailnet.
export function resources(name) {
  validateName(name);
  const dir = `${TAILNETS_ROOT}/${name}`;
  return {
    container: `lazurio-tailnet-${name}`,
    network: `lazurio-tailnet-${name}`,
    dir,
    stateDir: `${dir}/state`,
    socketDir: `${dir}/run`,
    socket: `${dir}/run/tailscaled.sock`,
    entrypoint: `${dir}/entrypoint.sh`,
  };
}

// --- config: ~/.config/lazurio/tailnets/<name>.json, 0600 in a 0700 directory

export function configDirectory(home) {
  return join(home, ".config", "lazurio", "tailnets");
}

export function configPath(home, name) {
  return join(configDirectory(home), `${validateName(name)}.json`);
}

const isPort = (port) => Number.isInteger(port) && port >= 1 && port <= 65535;

export function validateConfig(config, name = config?.name) {
  const problems = [];
  if (config?.schema_version !== CONFIG_SCHEMA) problems.push(`schema_version is not ${CONFIG_SCHEMA}`);
  if (typeof name !== "string" || !NAME.test(name) || config?.name !== name) problems.push("name does not match the file name");
  try {
    if (normalizeLoginServer(config?.login_server) !== config?.login_server) problems.push("login_server is not normalized");
  } catch {
    problems.push("login_server is not an http(s) URL");
  }
  if (!NODE_NAME.test(String(config?.hostname))) problems.push("hostname is not a DNS label");
  if (!USER_NAME.test(String(config?.operator))) problems.push("operator is not a user name");
  if (!PINNED.test(String(config?.image))) problems.push("image is not tailscale/tailscale pinned by digest");
  const ports = config?.ports;
  if (!isPort(ports?.socks5) || !isPort(ports?.http) || ports.socks5 === ports.http) problems.push("ports are not two distinct TCP ports");
  if (problems.length > 0) throw new TailnetError(`tailnet config ${name}: ${problems.join("; ")}`);
  return config;
}

export function readConfig(home, name) {
  const path = configPath(home, name);
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  let config;
  try {
    config = JSON.parse(text);
  } catch {
    throw new TailnetError(`${path} is not valid JSON`);
  }
  return validateConfig(config, name);
}

export function writeConfig(home, config) {
  validateConfig(config);
  const directory = configDirectory(home);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const path = configPath(home, config.name);
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
  return path;
}

export function listConfigs(home) {
  let entries;
  try {
    entries = readdirSync(configDirectory(home));
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  return entries
    .filter((entry) => entry.endsWith(".json") && NAME.test(entry.slice(0, -5)))
    .sort()
    .map((entry) => readConfig(home, entry.slice(0, -5)));
}

// The lowest pair in the range that no other tailnet has recorded and nothing
// on the host listens on. Once recorded in the config it never moves.
export function allocatePorts({ taken = [], busy = [] } = {}, range = PORT_RANGE) {
  const used = new Set([...taken, ...busy]);
  for (let socks5 = range.first; socks5 + 1 <= range.last; socks5 += 2) {
    if (!used.has(socks5) && !used.has(socks5 + 1)) return { socks5, http: socks5 + 1 };
  }
  throw new TailnetError(`no free port pair left in ${range.first}-${range.last}`);
}

// --- image: the official tailscale/tailscale, pinned by digest

export function parseImage(reference) {
  const match = IMAGE.exec(typeof reference === "string" ? reference : "");
  if (!match || (!match[2] && !match[3])) {
    throw new TailnetError(`--image is tailscale/tailscale with a tag or a digest (got ${JSON.stringify(reference ?? null)})`, USAGE);
  }
  return { repository: match[1].replace(/^docker\.io\//u, ""), tag: match[2] ?? null, digest: match[3] ?? null };
}

// The default image matches the host's own tailscale (`tailscale version`).
export function defaultImage(versionOutput) {
  const version = /^(\d+\.\d+\.\d+)\s*$/u.exec(String(versionOutput ?? "").split("\n")[0] ?? "")?.[1];
  if (!version) throw new TailnetError("could not read the host's `tailscale version`; pass --image tailscale/tailscale:v<version>");
  return `tailscale/tailscale:v${version}`;
}

// The digest reference Docker recorded for a pulled image.
export function pinnedReference(repository, repoDigests) {
  const found = (Array.isArray(repoDigests) ? repoDigests : [])
    .map((entry) => String(entry).replace(/^docker\.io\//u, ""))
    .find((entry) => entry.split("@")[0] === repository);
  if (!found || !PINNED.test(found)) throw new TailnetError(`Docker has no registry digest for ${repository}`);
  return found;
}

// --- container

export function tailscaledArgs() {
  return [
    "--statedir=/var/lib/tailscale",
    "--socket=/var/run/tailscale/tailscaled.sock",
    "--tun=tailscale0",
    "--port=0",
    `--socks5-server=0.0.0.0:${CONTAINER_SOCKS5_PORT}`,
    `--outbound-http-proxy-listen=0.0.0.0:${CONTAINER_HTTP_PORT}`,
    "--no-logs-no-support",
  ];
}

// Mounted read-only into the container. The unreachable routes go in before
// tailscaled starts, so an address of 100.64.0.0/10 that is not a peer of
// THIS tailnet fails at once instead of leaving through Docker NAT into the
// host's own tailnet. Peers still win: tailscaled puts their routes in table
// 52 behind rule 5270, which is consulted before main (32766).
export function entrypointScript() {
  return [
    "#!/bin/sh",
    "# Lazurio tailnet entrypoint, written by `bun run tailnet -- up` (scripts/tailnet/lib.mjs).",
    "set -eu",
    `ip -4 route replace unreachable ${CGNAT_IPV4}`,
    `ip -6 route replace unreachable ${TAILSCALE_IPV6} 2>/dev/null || echo "lazurio-tailnet: no IPv6 in this namespace, ${TAILSCALE_IPV6} not routed" >&2`,
    `exec tailscaled ${tailscaledArgs().join(" ")}`,
    "",
  ].join("\n");
}

// `docker run` arguments and a short hash of everything that defines the
// container. `up` recreates a container whose spec label differs; the state
// lives on the host, so nothing is lost.
export function containerSpec(config) {
  const r = resources(config.name);
  const options = [
    "--name", r.container,
    "--label", `${LABEL}=${config.name}`,
    "--network", r.network,
    "--restart", "unless-stopped",
    "--cap-add", "NET_ADMIN",
    "--cap-add", "NET_RAW",
    "--device", "/dev/net/tun:/dev/net/tun",
    "--publish", `127.0.0.1:${config.ports.socks5}:${CONTAINER_SOCKS5_PORT}/tcp`,
    "--publish", `127.0.0.1:${config.ports.http}:${CONTAINER_HTTP_PORT}/tcp`,
    // Docker would copy the host's search domains, the Environment's own
    // tailnet suffix among them, and complete short names with it.
    "--dns-search", ".",
    "--mount", `type=bind,source=${r.stateDir},target=/var/lib/tailscale`,
    "--mount", `type=bind,source=${r.socketDir},target=/var/run/tailscale`,
    "--mount", "type=bind,source=/etc/passwd,target=/etc/passwd,readonly",
    "--mount", "type=bind,source=/etc/group,target=/etc/group,readonly",
    "--mount", `type=bind,source=${r.entrypoint},target=${ENTRYPOINT_IN_CONTAINER},readonly`,
    "--log-driver", "local",
    "--log-opt", "max-size=10m",
    "--log-opt", "max-file=3",
    "--entrypoint", "/bin/sh",
  ];
  const spec = createHash("sha256")
    .update(JSON.stringify({ options, image: config.image, entrypoint: entrypointScript() }))
    .digest("hex")
    .slice(0, 16);
  return { spec, args: ["run", "--detach", ...options, "--label", `${SPEC_LABEL}=${spec}`, config.image, ENTRYPOINT_IN_CONTAINER] };
}

export function networkCreateArgs(name) {
  return ["network", "create", "--driver", "bridge", "--label", `${LABEL}=${name}`, resources(name).network];
}

// The prefs `up` applies, run with the container's own CLI. --reset makes
// them exactly this set, also for an adopted state. Nothing routes between
// tailnets: no subnet routes, no exit node, no Tailscale SSH, shields up.
export function upArgs(config) {
  return [
    "tailscale",
    "up",
    "--reset",
    `--login-server=${config.login_server}`,
    `--hostname=${config.hostname}`,
    `--operator=${config.operator}`,
    "--accept-dns=true",
    "--shields-up=true",
    "--accept-routes=false",
    "--exit-node=",
    "--ssh=false",
    `--timeout=${UP_TIMEOUT_SECONDS}s`,
  ];
}

// Whether a tailscaled command line uses this state directory (`--statedir`,
// or `--state` with a file in it). Adoption refuses a state that is in use:
// two daemons with one node key fight over the node.
export function usesStatedir(argv, directory) {
  const target = posix.normalize(directory).replace(/(.)\/+$/u, "$1");
  for (let k = 0; k < argv.length; k += 1) {
    const match = /^--?(statedir|state)(?:=(.*))?$/u.exec(argv[k]);
    if (!match) continue;
    const value = match[2] ?? argv[k + 1] ?? "";
    if (!value.startsWith("/")) continue;
    const path = posix.normalize(match[1] === "state" ? posix.dirname(value) : value).replace(/(.)\/+$/u, "$1");
    if (path === target) return true;
  }
  return false;
}

// The host CLI comes from the distribution's package, the daemon from the
// official image: the same release in two builds, so every CLI call prints
// a version warning. `ssh-proxy` drops it only when the releases match, so a
// real mismatch still shows.
export function isSameReleaseWarning(line) {
  const match = /^Warning: client version "([^"]+)" != tailscaled server version "([^"]+)"$/u.exec(String(line).trim());
  const release = (version) => version.split("-")[0];
  return Boolean(match) && release(match[1]) === release(match[2]);
}

// --- run: a command inside one tailnet

const shellQuote = (value) => `'${String(value).replaceAll("'", `'\\''`)}'`;

// Run as root through sudo, inside the tailnet's network namespace and a
// private mount namespace. It checks that the PID still belongs to the
// container, binds the container's resolv.conf over /etc/resolv.conf and the
// tailnet's socket directory over /run/tailscale (so a bare `tailscale` talks
// to this tailnet, not to the Environment's own), and drops to the user.
//
// The resolv.conf source is the host file Docker bind-mounts into the
// container (ResolvConfPath), which tailscaled rewrites in place. Binding
// /proc/<pid>/root/etc/resolv.conf instead does not work: mount(8)
// canonicalizes that path to the host's own /etc/resolv.conf and binds it
// without an error, and without canonicalization the kernel refuses a bind
// from another mount namespace (both seen on the station). So the result is
// compared with what the container sees before anything runs.
export const RUN_SCRIPT = [
  "set -eu",
  'pid=$1 container_id=$2 resolv_conf=$3 socket_dir=$4 uid=$5 gid=$6 env_file=$7',
  "shift 7",
  'grep -q -- "$container_id" "/proc/$pid/cgroup" || { echo "lazurio-tailnet: the container restarted; run the command again" >&2; exit 125; }',
  'mount --bind -- "$resolv_conf" /etc/resolv.conf',
  'cmp -s /etc/resolv.conf "/proc/$pid/root/etc/resolv.conf" || { echo "lazurio-tailnet: /etc/resolv.conf does not match the container; not running the command" >&2; exit 125; }',
  `if [ -d ${SYSTEM_SOCKET_DIR} ]; then mount --bind -- "$socket_dir" ${SYSTEM_SOCKET_DIR}; fi`,
  `exec setpriv --reuid="$uid" --regid="$gid" --init-groups -- /bin/sh -c '. "$0"' "$env_file" "$@"`,
].join("\n");

// sudo, nsenter and unshare keep the working directory, stdin, stdout and
// the exit code; the environment travels in envFile because sudo resets it.
export function runArgv({ name, pid, containerId, resolvConf, uid, gid, envFile, command }) {
  if (!Number.isInteger(pid) || pid <= 1) throw new TailnetError(`tailnet ${name} has no running process`);
  if (!Array.isArray(command) || command.length === 0) throw new TailnetError("run needs a command after --", USAGE);
  const r = resources(name);
  return [
    "sudo", "-n", "--",
    "nsenter", `--target=${pid}`, "--net", "--",
    "unshare", "--mount", "--propagation", "private", "--",
    "/bin/sh", "-c", RUN_SCRIPT, "lazurio-tailnet-run",
    String(pid), containerId, resolvConf, r.socketDir, String(uid), String(gid), envFile,
    ...command,
  ];
}

// Sourced as the user by the last shell of RUN_SCRIPT ($0 is this file,
// "$@" the command): deletes itself, restores the umask and the exact
// environment of the caller plus LAZURIO_TAILNET, then executes the command.
export function runEnvScript(env, name, umask = 0o022) {
  const assignments = Object.entries(env)
    .filter(([key, value]) => typeof value === "string" && /^[^=\0-][^=\0]*$/u.test(key) && !value.includes("\0") && key !== "LAZURIO_TAILNET")
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => shellQuote(`${key}=${value}`));
  assignments.push(shellQuote(`LAZURIO_TAILNET=${validateName(name)}`));
  return [
    'rm -f -- "$0"',
    `umask ${umask.toString(8).padStart(4, "0")}`,
    `exec /usr/bin/env -i ${assignments.join(" ")} /bin/sh -c 'exec "$@"' sh "$@"`,
    "",
  ].join("\n");
}

// --- doctor

// `ss -Hltn`: the local address and port of every TCP listener.
export function parseListeners(text) {
  const listeners = [];
  for (const line of String(text ?? "").split("\n")) {
    const local = line.trim().split(/\s+/u)[3];
    const match = /^(.*):(\d+)$/u.exec(local ?? "");
    if (match) listeners.push({ address: match[1].replace(/^\[(.*)\]$/u, "$1").replace(/%.*$/u, ""), port: Number(match[2]) });
  }
  return listeners;
}

export function nameservers(resolvConf) {
  return [...String(resolvConf ?? "").matchAll(/^\s*nameserver\s+(\S+)/gmu)].map((match) => match[1]);
}

// `tailscale switch --list`: a header row, then one row per profile.
export function countProfiles(text) {
  const rows = String(text ?? "").split("\n").filter((line) => line.trim() !== "");
  return rows.length > 0 && /^ID\s/u.test(rows[0]) ? rows.length - 1 : null;
}

const bindingOf = (bindings) => (Array.isArray(bindings) ? bindings.map((b) => `${b?.HostIp ?? "?"}:${b?.HostPort ?? "?"}`) : []);

// The verdicts for one tailnet, from facts cli.mjs gathered. A required check
// that fails makes `doctor` fail; an advisory one only reports.
export function evaluateTailnet(config, facts) {
  const checks = [];
  const check = (id, ok, detail, level = "required") => checks.push({ id, level, ok: Boolean(ok), detail });
  const { container, prefs, status, routes, listeners } = facts;
  check("container", container?.running, container ? container.status : "missing");
  check("restart_policy", container?.restartPolicy === "unless-stopped", container?.restartPolicy ?? "unknown");
  check("image", container?.image === config.image, container?.image ?? "unknown");
  const current = container?.spec === containerSpec(config).spec;
  check("spec", current, current ? "matches this version of the tool" : "from another version of the tool; `up` recreates it", "advisory");
  const backend = status?.BackendState ?? "unknown";
  check("backend", backend === "Running", status?.AuthURL && backend !== "Running" ? `${backend}, sign in: ${status.AuthURL}` : backend);
  let controlUrl = null;
  try {
    controlUrl = prefs?.ControlURL ? normalizeLoginServer(prefs.ControlURL) : null;
  } catch {
    controlUrl = String(prefs.ControlURL);
  }
  check("control_url", controlUrl === config.login_server, controlUrl ?? "unknown");
  check("node_name", prefs?.Hostname === config.hostname, prefs?.Hostname || "unset");
  check("shields_up", prefs?.ShieldsUp === true, String(prefs?.ShieldsUp ?? "unknown"));
  check("accept_routes_off", prefs?.RouteAll === false, String(prefs?.RouteAll ?? "unknown"));
  check("accept_dns_on", prefs?.CorpDNS === true, String(prefs?.CorpDNS ?? "unknown"));
  check("no_exit_node", Boolean(prefs) && !prefs.ExitNodeID && !prefs.ExitNodeIP, prefs ? prefs.ExitNodeID || prefs.ExitNodeIP || "none" : "unknown");
  check("tailscale_ssh_off", Boolean(prefs) && prefs.RunSSH !== true, String(prefs?.RunSSH ?? "unknown"));
  check("operator", prefs?.OperatorUser === config.operator, prefs?.OperatorUser || "unset");
  const v4 = /^unreachable 100\.64\.0\.0\/10(?:\s|$)/mu.test(routes?.v4 ?? "");
  check("unreachable_cgnat", v4, v4 ? CGNAT_IPV4 : "missing");
  const v6 = /^unreachable fd7a:115c:a1e0::\/48(?:\s|$)/mu.test(routes?.v6 ?? "");
  check("unreachable_tailscale_ipv6", v6, v6 ? TAILSCALE_IPV6 : "missing (no IPv6 in the container)", "advisory");
  const published = Object.fromEntries(
    Object.entries(container?.ports ?? {})
      .filter(([, bindings]) => Array.isArray(bindings) && bindings.length > 0)
      .map(([port, bindings]) => [port, bindingOf(bindings)])
      .sort(([a], [b]) => (a < b ? -1 : 1)),
  );
  const expected = {
    [`${CONTAINER_SOCKS5_PORT}/tcp`]: [`127.0.0.1:${config.ports.socks5}`],
    [`${CONTAINER_HTTP_PORT}/tcp`]: [`127.0.0.1:${config.ports.http}`],
  };
  const shown = Object.entries(published).map(([port, list]) => `${port}->${list.join(",")}`).join(" ");
  check("published_loopback_only", JSON.stringify(published) === JSON.stringify(expected), shown || "none");
  if (listeners) {
    const ours = listeners.filter((l) => l.port === config.ports.socks5 || l.port === config.ports.http);
    check("listeners_loopback_only", ours.every((l) => l.address === "127.0.0.1"), ours.map((l) => `${l.address}:${l.port}`).join(" ") || "no host listener");
  } else check("listeners_loopback_only", false, "could not list listeners (ss)", "advisory");
  check("socks5_answers", facts.socks5 === true, facts.socks5 === true ? `socks5h://127.0.0.1:${config.ports.socks5}` : "no SOCKS5 answer");
  const servers = nameservers(facts.resolvConf);
  check("dns_quad100", servers.length === 1 && servers[0] === QUAD_100, servers.join(" ") || "unknown");
  check("socket_reachable", facts.socket === true, facts.socket === true ? resources(config.name).socket : "no connection without sudo", "advisory");
  return { name: config.name, ok: checks.every((c) => c.ok || c.level !== "required"), checks };
}

// The Environment's own tailscaled, read only: one profile means nothing can
// be switched under the threads; its ControlURL is the tailnet Machines manages.
export function evaluateSystem({ present, profiles, controlUrl }) {
  if (!present) return { present: false, ok: true, profiles: null, control_url: null, detail: "no system tailscaled" };
  const ok = profiles === 1;
  return {
    present: true,
    ok,
    profiles,
    control_url: controlUrl ?? null,
    detail: profiles === null ? "profile count unknown" : ok ? "one profile" : `${profiles} profiles; a switch would cut every thread off`,
  };
}
