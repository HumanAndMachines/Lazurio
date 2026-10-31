#!/usr/bin/env bun
// `bun run tailnet -- <command>`: foreign tailnets on a Linux Environment, a
// kernel-mode tailscaled per tailnet in its own container (the model is in
// lib.mjs). Linux only; a Mac keeps its headless clients.
//
// Exit codes: 0 done, 1 failed, 2 usage or unsupported platform, 3 `up`
// waits for sign-in or approval. `run` and `ssh-proxy` return the code of
// the command they ran. Manual: manual/station-tailnets.md.
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { constants, homedir, tmpdir, userInfo } from "node:os";
import { basename, join, resolve } from "node:path";
import {
  allocatePorts,
  CONFIG_SCHEMA,
  configPath,
  containerSpec,
  countProfiles,
  defaultImage,
  entrypointScript,
  evaluateSystem,
  evaluateTailnet,
  LABEL,
  listConfigs,
  networkCreateArgs,
  normalizeLoginServer,
  parseImage,
  parseListeners,
  pinnedReference,
  readConfig,
  resources,
  runArgv,
  runEnvScript,
  SPEC_LABEL,
  TAILNETS_ROOT,
  TailnetError,
  UP_TIMEOUT_SECONDS,
  upArgs,
  USAGE,
  usesStatedir,
  validateConfig,
  validateName,
  validateNodeName,
  WAITING,
  writeConfig,
} from "./lib.mjs";

const HELP = `Usage: bun run tailnet -- <command>   (Linux Environments; manual/station-tailnets.md)

  up <name> --login-server <url> --hostname <node> [--adopt-state <statedir>] [--image <ref>]
  status [<name>] [--json]
  doctor [--json]
  run <name> -- <command…>
  proxy <name> [--json]
  ssh-proxy <name> <host> <port>
  down <name>

<name> matches ^[a-z0-9][a-z0-9-]{0,38}$. \`bun run\` starts in the repository root;
call \`bun <Lazurio>/scripts/tailnet/cli.mjs run …\` to keep your working directory.`;

const NOT_LINUX = {
  darwin:
    "bun run tailnet runs on Linux Environments only. This Mac keeps its headless clients: one userspace tailscaled per tailnet, used with `tailscale --socket=<socket> …` (manual/station-tailnets.md).",
  other: "bun run tailnet runs on Linux Environments only (manual/station-tailnets.md).",
};

// --- the system: everything cli.mjs runs goes through this object, so tests can stand in for it

function execSync(argv, { input, timeoutMs = 120_000 } = {}) {
  try {
    const result = Bun.spawnSync(argv, {
      stdin: input === undefined ? "ignore" : Buffer.from(input),
      stdout: "pipe",
      stderr: "pipe",
      timeout: timeoutMs,
    });
    return { code: result.exitCode ?? 128, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
  } catch (error) {
    return { code: 127, stdout: "", stderr: `${argv[0]}: ${error?.message ?? "cannot run"}` };
  }
}

// Runs a command on this terminal and returns its exit code. A terminal's
// Ctrl-C reaches the child's process group by itself; other signals sent to
// this process are passed on.
async function spawnInherit(argv) {
  let child;
  try {
    child = Bun.spawn(argv, { stdio: ["inherit", "inherit", "inherit"] });
  } catch (error) {
    throw new TailnetError(`cannot start ${argv[0]}: ${error?.message ?? "unknown error"}`);
  }
  const ignore = () => {};
  const forward = ["SIGTERM", "SIGHUP", "SIGQUIT"].map((signal) => [signal, () => child.kill(signal)]);
  process.on("SIGINT", ignore);
  for (const [signal, handler] of forward) process.on(signal, handler);
  try {
    await child.exited;
  } finally {
    process.off("SIGINT", ignore);
    for (const [signal, handler] of forward) process.off(signal, handler);
  }
  return child.exitCode ?? 128 + (constants.signals[child.signalCode] ?? 1);
}

function probe(options, onConnect, timeoutMs = 2_000) {
  return new Promise((done) => {
    const socket = createConnection(options);
    const finish = (ok) => {
      socket.destroy();
      done(ok);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.on("error", () => finish(false));
    socket.on("connect", () => onConnect(socket, finish));
  });
}

// A SOCKS5 greeting without authentication, answered by tailscaled.
const socks5Answers = (port) =>
  probe({ host: "127.0.0.1", port }, (socket, finish) => {
    socket.on("data", (data) => finish(data.length >= 2 && data[0] === 5 && data[1] === 0));
    socket.write(Buffer.from([5, 1, 0]));
  });

const socketConnects = (path) => probe({ path }, (_socket, finish) => finish(true));

function processes() {
  const list = [];
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/u.test(entry)) continue;
    try {
      const argv = readFileSync(`/proc/${entry}/cmdline`, "utf8").split("\0").filter(Boolean);
      if (argv.length > 0) list.push({ pid: Number(entry), argv });
    } catch {
      // The process ended meanwhile.
    }
  }
  return list;
}

export function systemContext() {
  return {
    platform: process.platform,
    env: process.env,
    home: homedir(),
    uid: process.getuid?.() ?? -1,
    gid: process.getgid?.() ?? -1,
    user: userInfo().username,
    cwd: process.cwd(),
    umask: process.umask(),
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
    exec: execSync,
    spawnInherit,
    which: (name) => Bun.which(name),
    sleep: (ms) => Bun.sleep(ms),
    now: () => new Date().toISOString(),
    processes,
    socks5Answers,
    socketConnects,
    tempDir: () => mkdtempSync(join(tmpdir(), "lazurio-tailnet-")),
  };
}

// --- helpers

const firstLine = (text) => String(text ?? "").trim().split("\n").find(Boolean) ?? "no output";

function must(result, what) {
  if (result.code !== 0) throw new TailnetError(`${what} failed: ${firstLine(result.stderr || result.stdout)}`);
  return result;
}

const docker = (ctx, args, options) => ctx.exec(["docker", ...args], options);
const sudo = (ctx, args, what) => must(ctx.exec(["sudo", "-n", "--", ...args]), what);

function requireSudo(ctx) {
  if (ctx.exec(["sudo", "-n", "true"]).code !== 0) {
    throw new TailnetError("needs passwordless sudo (`sudo -n`): the state lives under root, and `run` enters a network namespace");
  }
}

function parseArgs(args, valueOptions = [], flagOptions = []) {
  const positionals = [];
  const options = {};
  const flags = {};
  for (let k = 0; k < args.length; k += 1) {
    const arg = args[k];
    const eq = arg.startsWith("--") ? arg.indexOf("=") : -1;
    const key = eq > 0 ? arg.slice(0, eq) : arg;
    if (valueOptions.includes(key)) {
      const value = eq > 0 ? arg.slice(eq + 1) : args[(k += 1)];
      if (value === undefined || value === "") throw new TailnetError(`${key} needs a value`, USAGE);
      options[key] = value;
    } else if (flagOptions.includes(arg)) flags[arg] = true;
    else if (arg.startsWith("-")) throw new TailnetError(`unknown option ${arg}`, USAGE);
    else positionals.push(arg);
  }
  return { positionals, options, flags };
}

function oneName(positionals, usage) {
  if (positionals.length !== 1) throw new TailnetError(`usage: ${usage}`, USAGE);
  return validateName(positionals[0]);
}

function requireConfig(ctx, name) {
  const config = readConfig(ctx.home, name);
  if (!config) throw new TailnetError(`no tailnet ${name}; create it with \`bun run tailnet -- up ${name} --login-server <url> --hostname <node>\``);
  return config;
}

function inspectContainer(ctx, container) {
  const result = docker(ctx, ["container", "inspect", container]);
  if (result.code !== 0) {
    if (/no such (?:container|object)/iu.test(result.stderr)) return null;
    throw new TailnetError(`docker container inspect ${container} failed: ${firstLine(result.stderr)}`);
  }
  const info = JSON.parse(result.stdout)[0];
  if (!info) return null;
  const running = info.State?.Running === true;
  return {
    id: info.Id,
    running,
    status: info.State?.Status ?? "unknown",
    pid: info.State?.Pid ?? 0,
    restartPolicy: info.HostConfig?.RestartPolicy?.Name ?? null,
    image: info.Config?.Image ?? null,
    labels: info.Config?.Labels ?? {},
    spec: info.Config?.Labels?.[SPEC_LABEL] ?? null,
    ports: (running ? info.NetworkSettings?.Ports : info.HostConfig?.PortBindings) ?? {},
    resolvConf: info.ResolvConfPath ?? null,
  };
}

function ours(found, kind, name, objectName) {
  if (found && found[LABEL] !== name) throw new TailnetError(`a Docker ${kind} ${objectName} exists that this tool did not create; remove or rename it first`);
}

function networkLabels(ctx, network) {
  const result = docker(ctx, ["network", "inspect", "--format", "{{json .Labels}}", network]);
  if (result.code !== 0) {
    if (/not found|no such network/iu.test(result.stderr)) return null;
    throw new TailnetError(`docker network inspect ${network} failed: ${firstLine(result.stderr)}`);
  }
  return JSON.parse(result.stdout || "null") ?? {};
}

function stopAndRemove(ctx, container) {
  must(docker(ctx, ["stop", "-t", "10", container]), `docker stop ${container}`);
  must(docker(ctx, ["rm", container]), `docker rm ${container}`);
}

function jsonOf(result) {
  if (!result || result.code !== 0) return null;
  try {
    return JSON.parse(result.stdout);
  } catch {
    return null;
  }
}

const readStatus = (ctx, container) => jsonOf(docker(ctx, ["exec", container, "tailscale", "status", "--json"]));

function hostListeners(ctx) {
  const result = ctx.exec(["ss", "-Hltn"]);
  return result.code === 0 ? parseListeners(result.stdout) : null;
}

const proxies = (config) => ({ socks5: `socks5h://127.0.0.1:${config.ports.socks5}`, http: `http://127.0.0.1:${config.ports.http}` });

// --- up

function resolveImage(ctx, existing, requested) {
  if (!requested && existing?.image) {
    if (docker(ctx, ["image", "inspect", "--format", "{{.Id}}", existing.image]).code !== 0) {
      must(docker(ctx, ["pull", "--quiet", existing.image], { timeoutMs: 600_000 }), `docker pull ${existing.image}`);
    }
    return { reference: existing.image, tag: existing.image_tag ?? null };
  }
  let reference = requested;
  if (!reference) {
    const version = ctx.exec(["tailscale", "version"]);
    if (version.code !== 0) throw new TailnetError("the host has no working `tailscale version`; pass --image tailscale/tailscale:v<version>");
    reference = defaultImage(version.stdout);
  }
  const parsed = parseImage(reference);
  must(docker(ctx, ["pull", "--quiet", reference], { timeoutMs: 600_000 }), `docker pull ${reference}`);
  const info = jsonOf(must(docker(ctx, ["image", "inspect", reference]), `docker image inspect ${reference}`))?.[0];
  const pinned = pinnedReference(parsed.repository, info?.RepoDigests);
  if (parsed.digest && !pinned.endsWith(`@${parsed.digest}`)) throw new TailnetError(`${reference} resolved to ${pinned}`);
  return { reference: pinned, tag: parsed.tag };
}

// Copies the state of an existing client, so the node keeps its identity
// and the Admin of that tailnet approves nothing again.
function adoptState(ctx, r, source) {
  if (ctx.exec(["sudo", "-n", "--", "test", "-f", join(source, "tailscaled.state")]).code !== 0) {
    throw new TailnetError(`--adopt-state ${source} holds no tailscaled.state`, USAGE);
  }
  const users = ctx.processes().filter((p) => basename(p.argv[0] ?? "") === "tailscaled" && usesStatedir(p.argv, source));
  if (users.length > 0) {
    throw new TailnetError(`tailscaled ${users.map((p) => p.pid).join(", ")} still uses ${source}; stop that client first, two daemons with one node key fight over the node`);
  }
  const present = sudo(ctx, ["find", r.stateDir, "-mindepth", "1", "-maxdepth", "1", "-print", "-quit"], "look into the state directory").stdout.trim();
  if (present) throw new TailnetError(`${r.stateDir} already holds a node; adopting would replace its identity`);
  sudo(ctx, ["cp", "-a", "--", `${source}/.`, `${r.stateDir}/`], "copy the state");
  sudo(ctx, ["chown", "-R", "root:root", r.stateDir], "hand the state to root");
  sudo(ctx, ["chmod", "0700", r.stateDir], "protect the state");
}

function prepareHost(ctx, r, adopt) {
  sudo(ctx, ["install", "-d", "-o", "root", "-g", "root", "-m", "0755", TAILNETS_ROOT, r.dir, r.socketDir], "create the tailnet directories");
  sudo(ctx, ["install", "-d", "-o", "root", "-g", "root", "-m", "0700", r.stateDir], "create the state directory");
  if (adopt) adoptState(ctx, r, adopt);
  const temporary = ctx.tempDir();
  try {
    const file = join(temporary, "entrypoint.sh");
    writeFileSync(file, entrypointScript(), { mode: 0o644 });
    sudo(ctx, ["install", "-o", "root", "-g", "root", "-m", "0755", file, r.entrypoint], "write the entrypoint");
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

function ensureNetwork(ctx, name) {
  const { network } = resources(name);
  const labels = networkLabels(ctx, network);
  ours(labels, "network", name, network);
  if (labels) return;
  must(docker(ctx, networkCreateArgs(name)), `docker network create ${network}`);
}

function ensureContainer(ctx, config) {
  const { container } = resources(config.name);
  const { spec, args } = containerSpec(config);
  const found = inspectContainer(ctx, container);
  ours(found?.labels, "container", config.name, container);
  if (found && found.spec === spec) {
    if (found.running) return "kept";
    must(docker(ctx, ["start", container]), `docker start ${container}`);
    return "started";
  }
  if (found) stopAndRemove(ctx, container);
  must(docker(ctx, args), `docker run ${container}`);
  return found ? "recreated" : "created";
}

async function waitForDaemon(ctx, container, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const status = readStatus(ctx, container);
    if (status) return status;
    if (Date.now() > deadline) throw new TailnetError(`tailscaled in ${container} did not answer within ${timeoutMs / 1000} s; see \`docker logs ${container}\``);
    await ctx.sleep(500);
  }
}

async function up(ctx, args) {
  const usage = "up <name> --login-server <url> --hostname <node> [--adopt-state <statedir>] [--image <ref>]";
  const { positionals, options } = parseArgs(args, ["--login-server", "--hostname", "--adopt-state", "--image"]);
  const name = oneName(positionals, usage);
  if (!options["--login-server"] || !options["--hostname"]) throw new TailnetError(`usage: ${usage}`, USAGE);
  const loginServer = normalizeLoginServer(options["--login-server"]);
  const hostname = validateNodeName(options["--hostname"]);
  if (ctx.uid === 0) {
    throw new TailnetError("run `up` as the Environment's user, not as root: it calls sudo where it must, and the user becomes the tailnet's operator", USAGE);
  }
  const existing = readConfig(ctx.home, name);
  if (existing && existing.login_server !== loginServer) {
    throw new TailnetError(`${name} belongs to ${existing.login_server}; another login server is another tailnet, so give it another name`, USAGE);
  }
  const adopt = options["--adopt-state"] ? resolve(ctx.cwd, options["--adopt-state"]) : null;
  requireSudo(ctx);
  const r = resources(name);
  const image = resolveImage(ctx, existing, options["--image"]);
  const ports =
    existing?.ports ??
    allocatePorts({
      taken: listConfigs(ctx.home)
        .filter((c) => c.name !== name)
        .flatMap((c) => [c.ports.socks5, c.ports.http]),
      busy: (hostListeners(ctx) ?? []).map((l) => l.port),
    });
  const now = ctx.now();
  const config = validateConfig({
    schema_version: CONFIG_SCHEMA,
    name,
    login_server: loginServer,
    hostname,
    operator: ctx.user,
    image: image.reference,
    image_tag: image.tag,
    ports,
    adopted_from: adopt ?? existing?.adopted_from ?? null,
    created_at: existing?.created_at ?? now,
    updated_at: now,
  });
  prepareHost(ctx, r, adopt);
  const path = writeConfig(ctx.home, config);
  ensureNetwork(ctx, name);
  const action = ensureContainer(ctx, config);
  await waitForDaemon(ctx, r.container);
  const applied = docker(ctx, ["exec", r.container, ...upArgs(config)], { timeoutMs: (UP_TIMEOUT_SECONDS + 30) * 1000 });
  const status = readStatus(ctx, r.container);
  const backend = status?.BackendState ?? "unknown";
  const peers = Object.values(status?.Peer ?? {});
  const { socks5, http } = proxies(config);
  ctx.out(`tailnet ${name}: ${backend} as ${hostname}${backend === "Running" ? ` (${peers.length} peers, ${peers.filter((p) => p.Online).length} online)` : ""}`);
  ctx.out(`  container ${r.container} ${action}, ${config.image}`);
  ctx.out(`  socket    ${r.socket}`);
  ctx.out(`  proxy     ${socks5}  ${http}`);
  ctx.out(`  config    ${path}`);
  const waiting = backend === "NeedsLogin" || backend === "NeedsMachineAuth";
  // While it waits for sign-in, `tailscale up` ends at its timeout; that is expected once there is a link.
  if (applied.code !== 0 && !(waiting && status?.AuthURL)) ctx.err(`tailscale up: ${firstLine(applied.stderr || applied.stdout)}`);
  if (backend === "Running") return applied.code === 0 ? 0 : 1;
  if (!waiting) return 1;
  ctx.out(
    status?.AuthURL
      ? `  sign in   ${status.AuthURL}  (an Admin of that tailnet approves the node; then \`bun run tailnet -- doctor\`)`
      : `  sign in   no link from ${loginServer} yet; \`bun run tailnet -- status ${name}\` shows it once the login server answers`,
  );
  return WAITING;
}

// --- status and doctor

function statusRow(ctx, config) {
  const r = resources(config.name);
  const container = inspectContainer(ctx, r.container);
  const status = container?.running ? readStatus(ctx, r.container) : null;
  const peers = Object.values(status?.Peer ?? {});
  const backend = status?.BackendState ?? null;
  return {
    name: config.name,
    container: container?.status ?? "missing",
    backend,
    node: config.hostname,
    login_server: config.login_server,
    peers: peers.length,
    online_peers: peers.filter((p) => p.Online).length,
    auth_url: backend !== "Running" && status?.AuthURL ? status.AuthURL : null,
    ...proxies(config),
    socket: r.socket,
  };
}

function status(ctx, args) {
  const { positionals, flags } = parseArgs(args, [], ["--json"]);
  if (positionals.length > 1) throw new TailnetError("usage: status [<name>] [--json]", USAGE);
  const configs = positionals.length === 1 ? [requireConfig(ctx, validateName(positionals[0]))] : listConfigs(ctx.home);
  const rows = configs.map((config) => statusRow(ctx, config));
  if (flags["--json"]) {
    ctx.out(JSON.stringify(rows, null, 2));
    return 0;
  }
  if (rows.length === 0) ctx.out("no tailnets yet: bun run tailnet -- up <name> --login-server <url> --hostname <node>");
  for (const row of rows) {
    const backend = row.backend ?? "-";
    const peers = row.backend === "Running" ? ` peers ${row.online_peers}/${row.peers} online` : "";
    ctx.out(`${row.name}  ${row.container}  ${backend}  node ${row.node}${peers}  ${row.socks5}  ${row.http}`);
    if (row.auth_url) ctx.out(`  sign in: ${row.auth_url}`);
  }
  return 0;
}

async function gatherFacts(ctx, config, listeners) {
  const r = resources(config.name);
  const container = inspectContainer(ctx, r.container);
  const inside = (argv) => (container?.running ? docker(ctx, ["exec", r.container, ...argv]) : null);
  const text = (result) => (result && result.code === 0 ? result.stdout : null);
  return {
    container,
    status: jsonOf(inside(["tailscale", "status", "--json"])),
    prefs: jsonOf(inside(["tailscale", "debug", "prefs"])),
    routes: container?.running
      ? { v4: text(inside(["ip", "-4", "route", "show", "type", "unreachable"])) ?? "", v6: text(inside(["ip", "-6", "route", "show", "type", "unreachable"])) ?? "" }
      : null,
    resolvConf: text(inside(["cat", "/etc/resolv.conf"])),
    listeners,
    socks5: container?.running ? await ctx.socks5Answers(config.ports.socks5) : false,
    socket: await ctx.socketConnects(r.socket),
  };
}

// The Environment's own tailscaled, read only. Listing profiles needs root.
function systemReport(ctx) {
  if (!ctx.which("tailscale")) return evaluateSystem({ present: false });
  const prefs = jsonOf(ctx.exec(["tailscale", "debug", "prefs"]));
  const list = ctx.exec(["sudo", "-n", "--", "tailscale", "switch", "--list"]);
  return evaluateSystem({ present: true, profiles: list.code === 0 ? countProfiles(list.stdout) : null, controlUrl: prefs?.ControlURL ?? null });
}

async function doctor(ctx, args) {
  const { positionals, flags } = parseArgs(args, [], ["--json"]);
  if (positionals.length > 0) throw new TailnetError("usage: doctor [--json]", USAGE);
  const listeners = hostListeners(ctx);
  const tailnets = [];
  for (const config of listConfigs(ctx.home)) tailnets.push(evaluateTailnet(config, await gatherFacts(ctx, config, listeners)));
  const system = systemReport(ctx);
  const ok = tailnets.every((t) => t.ok);
  if (flags["--json"]) {
    ctx.out(JSON.stringify({ ok, tailnets, system }, null, 2));
    return ok ? 0 : 1;
  }
  if (tailnets.length === 0) ctx.out("no tailnets yet: bun run tailnet -- up <name> --login-server <url> --hostname <node>");
  for (const tailnet of tailnets) {
    ctx.out(`${tailnet.name}: ${tailnet.ok ? "OK" : "FAIL"}`);
    for (const c of tailnet.checks) ctx.out(`  ${c.ok ? "ok  " : c.level === "required" ? "FAIL" : "warn"}  ${c.id.padEnd(26)} ${c.detail}`);
  }
  ctx.out(
    system.present
      ? `system tailscaled (read only): ${system.ok ? "ok  " : "warn"} ${system.detail}, ControlURL ${system.control_url ?? "unknown"}`
      : "system tailscaled: none",
  );
  return ok ? 0 : 1;
}

// --- run, proxy, ssh-proxy, down

async function run(ctx, args) {
  if (args.length < 3 || args[1] !== "--") throw new TailnetError("usage: run <name> -- <command…>", USAGE);
  const name = validateName(args[0]);
  requireConfig(ctx, name);
  const container = inspectContainer(ctx, resources(name).container);
  if (!container?.running) throw new TailnetError(`tailnet ${name} is not running; \`bun run tailnet -- up ${name} …\` starts it`);
  if (!container.resolvConf) throw new TailnetError(`Docker reports no resolv.conf for tailnet ${name}`);
  const temporary = ctx.tempDir();
  try {
    const envFile = join(temporary, "env.sh");
    writeFileSync(envFile, runEnvScript(ctx.env, name, ctx.umask), { mode: 0o600 });
    const argv = runArgv({ name, pid: container.pid, containerId: container.id, resolvConf: container.resolvConf, uid: ctx.uid, gid: ctx.gid, envFile, command: args.slice(2) });
    return await ctx.spawnInherit(argv);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

function proxy(ctx, args) {
  const { positionals, flags } = parseArgs(args, [], ["--json"]);
  const name = oneName(positionals, "proxy <name> [--json]");
  const { socks5, http } = proxies(requireConfig(ctx, name));
  if (flags["--json"]) ctx.out(JSON.stringify({ name, socks5, http }));
  else {
    ctx.out(socks5);
    ctx.out(http);
  }
  return 0;
}

// For `ProxyCommand bun <Lazurio>/scripts/tailnet/cli.mjs ssh-proxy <name> %h %p`.
// Stdout carries the connection, so everything else goes to stderr.
async function sshProxy(ctx, args) {
  if (args.length !== 3) throw new TailnetError("usage: ssh-proxy <name> <host> <port>", USAGE);
  const name = validateName(args[0]);
  const [, host, port] = args;
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(host)) throw new TailnetError(`not a host: ${JSON.stringify(host)}`, USAGE);
  if (!/^\d{1,5}$/u.test(port) || Number(port) < 1 || Number(port) > 65535) throw new TailnetError(`not a port: ${JSON.stringify(port)}`, USAGE);
  const config = requireConfig(ctx, name);
  const { socket } = resources(name);
  const prefs = ctx.exec(["tailscale", `--socket=${socket}`, "debug", "prefs"]);
  if (prefs.code !== 0) throw new TailnetError(`tailnet ${name} does not answer on ${socket}: ${firstLine(prefs.stderr)}`);
  let controlUrl = null;
  try {
    controlUrl = normalizeLoginServer(JSON.parse(prefs.stdout).ControlURL);
  } catch {
    controlUrl = null;
  }
  if (controlUrl !== config.login_server) {
    throw new TailnetError(`the daemon on ${socket} is signed in to ${controlUrl ?? "nothing"}, not ${config.login_server}; not connecting`);
  }
  return ctx.spawnInherit(["tailscale", `--socket=${socket}`, "nc", host, port]);
}

function down(ctx, args) {
  const { positionals } = parseArgs(args);
  const name = oneName(positionals, "down <name>");
  const r = resources(name);
  const container = inspectContainer(ctx, r.container);
  ours(container?.labels, "container", name, r.container);
  if (container) stopAndRemove(ctx, r.container);
  const labels = networkLabels(ctx, r.network);
  ours(labels, "network", name, r.network);
  if (labels) must(docker(ctx, ["network", "rm", r.network]), `docker network rm ${r.network}`);
  ctx.out(`tailnet ${name}: ${container ? "container" : "no container"} and ${labels ? "network" : "no network"} removed`);
  ctx.out(`  kept: state ${r.stateDir} and config ${configPath(ctx.home, name)}; \`up\` brings the same node back`);
  return 0;
}

const COMMANDS = { up, status, doctor, run, proxy, "ssh-proxy": sshProxy, down };

export async function main(argv, ctx = systemContext()) {
  const [command, ...args] = argv;
  if (command === undefined || ["help", "--help", "-h"].includes(command)) {
    (command === undefined ? ctx.err : ctx.out)(HELP);
    return command === undefined ? USAGE : 0;
  }
  if (!Object.hasOwn(COMMANDS, command)) {
    ctx.err(`unknown command ${JSON.stringify(command)}\n\n${HELP}`);
    return USAGE;
  }
  if (ctx.platform !== "linux") {
    ctx.err(NOT_LINUX[ctx.platform === "darwin" ? "darwin" : "other"]);
    return USAGE;
  }
  try {
    return await COMMANDS[command](ctx, args);
  } catch (error) {
    if (!(error instanceof TailnetError)) throw error;
    ctx.err(`tailnet ${command}: ${error.message}`);
    return error.exitCode;
  }
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
