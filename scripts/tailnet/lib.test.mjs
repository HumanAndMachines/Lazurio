import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  allocatePorts,
  CGNAT_IPV4,
  configPath,
  containerMismatch,
  containerSpec,
  countProfiles,
  daemonMismatch,
  defaultImage,
  entrypointScript,
  evaluateSystem,
  evaluateTailnet,
  isSameReleaseWarning,
  listConfigs,
  nameservers,
  normalizeLoginServer,
  parseImage,
  parseListeners,
  pinnedReference,
  readConfig,
  resources,
  RUN_SCRIPT,
  runArgv,
  runEnvScript,
  TAILNETS_ROOT,
  TailnetError,
  upArgs,
  usesStatedir,
  validateName,
  validateNodeName,
  writeConfig,
} from "./lib.mjs";

// Synthetic values only: a placeholder login server and a made-up digest.
const DIGEST = `sha256:${"ab12".repeat(16)}`;
const sandbox = mkdtempSync(join(tmpdir(), "tailnet-lib-"));
afterAll(() => rmSync(sandbox, { recursive: true, force: true }));

const config = (overrides = {}) => ({
  schema_version: "lazurio.tailnet.v1",
  name: "example-org",
  login_server: "https://headscale.example.lazurio.io",
  hostname: "login-device-cli",
  operator: "station-user",
  image: `tailscale/tailscale@${DIGEST}`,
  image_tag: "v1.102.2",
  ports: { socks5: 10550, http: 10551 },
  adopted_from: null,
  created_at: "2026-10-31T00:00:00.000Z",
  updated_at: "2026-10-31T00:00:00.000Z",
  ...overrides,
});

describe("names", () => {
  test("a tailnet name is a short lowercase label", () => {
    for (const name of ["scratch", "example-org", "a", "0", "x".repeat(39)]) expect(validateName(name)).toBe(name);
    for (const name of ["", "-x", "Example", "a_b", "a.b", "../x", "x".repeat(40), null, 7]) {
      expect(() => validateName(name)).toThrow(TailnetError);
    }
  });

  test("a node name is one DNS label", () => {
    expect(validateNodeName("login-device-cli")).toBe("login-device-cli");
    for (const name of ["Login", "-x", "x-", "a.b", "x".repeat(64), ""]) expect(() => validateNodeName(name)).toThrow(TailnetError);
  });

  test("resources follow from the name only", () => {
    expect(resources("example-org")).toEqual({
      container: "lazurio-tailnet-example-org",
      network: "lazurio-tailnet-example-org",
      dir: `${TAILNETS_ROOT}/example-org`,
      stateDir: `${TAILNETS_ROOT}/example-org/state`,
      socketDir: `${TAILNETS_ROOT}/example-org/run`,
      socket: `${TAILNETS_ROOT}/example-org/run/tailscaled.sock`,
      entrypoint: `${TAILNETS_ROOT}/example-org/entrypoint.sh`,
    });
    // Persistent, not /run: Docker re-creates the bind mounts at boot.
    expect(TAILNETS_ROOT.startsWith("/var/lib/")).toBe(true);
  });

  test("the login server is normalized as tailscaled reports ControlURL", () => {
    expect(normalizeLoginServer("https://headscale.example.lazurio.io/")).toBe("https://headscale.example.lazurio.io");
    expect(normalizeLoginServer("http://headscale.example.invalid:8080")).toBe("http://headscale.example.invalid:8080");
    for (const bad of ["ftp://x", "https://user:pw@x", "https://x/?a=1", "not a url", undefined]) {
      expect(() => normalizeLoginServer(bad)).toThrow(TailnetError);
    }
  });
});

describe("config", () => {
  test("is written 0600 in a 0700 directory and read back", () => {
    const home = join(sandbox, "home-a");
    const path = writeConfig(home, config());
    expect(path).toBe(configPath(home, "example-org"));
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(home, ".config/lazurio/tailnets")).mode & 0o777).toBe(0o700);
    expect(readConfig(home, "example-org")).toEqual(config());
    expect(readConfig(home, "other")).toBeNull();
  });

  test("an invalid config is refused, not guessed", () => {
    const home = join(sandbox, "home-b");
    for (const bad of [
      config({ name: "Other" }),
      config({ login_server: "https://headscale.example.lazurio.io/" }),
      config({ image: "tailscale/tailscale:v1.102.2" }),
      config({ image: `example/other@${DIGEST}` }),
      config({ ports: { socks5: 10550, http: 10550 } }),
      config({ operator: "Root User" }),
    ]) {
      expect(() => writeConfig(home, bad)).toThrow(TailnetError);
    }
    mkdirSync(join(home, ".config/lazurio/tailnets"), { recursive: true });
    writeFileSync(join(home, ".config/lazurio/tailnets/example-org.json"), "{ broken");
    expect(() => readConfig(home, "example-org")).toThrow(TailnetError);
    // The file name is the tailnet; a config moved under another name is refused.
    writeFileSync(join(home, ".config/lazurio/tailnets/example-org.json"), JSON.stringify(config({ name: "other" })));
    expect(() => readConfig(home, "example-org")).toThrow(TailnetError);
  });

  test("listConfigs reads every tailnet in name order", () => {
    const home = join(sandbox, "home-c");
    writeConfig(home, config({ name: "zeta", ports: { socks5: 10552, http: 10553 } }));
    writeConfig(home, config({ name: "alpha" }));
    writeFileSync(join(home, ".config/lazurio/tailnets/notes.txt"), "ignored");
    expect(listConfigs(home).map((c) => c.name)).toEqual(["alpha", "zeta"]);
    expect(listConfigs(join(sandbox, "nobody"))).toEqual([]);
  });
});

describe("ports", () => {
  test("the lowest free pair, skipping recorded and listening ports", () => {
    expect(allocatePorts()).toEqual({ socks5: 10550, http: 10551 });
    expect(allocatePorts({ taken: [10550, 10551] })).toEqual({ socks5: 10552, http: 10553 });
    expect(allocatePorts({ busy: [10551] })).toEqual({ socks5: 10552, http: 10553 });
    expect(allocatePorts({ taken: [10552, 10553], busy: [10550] })).toEqual({ socks5: 10554, http: 10555 });
  });

  test("an exhausted range is an error", () => {
    expect(() => allocatePorts({ taken: [20000, 20001] }, { first: 20000, last: 20001 })).toThrow(TailnetError);
  });
});

describe("image", () => {
  test("only the official image, by tag or digest", () => {
    expect(parseImage("tailscale/tailscale:v1.102.2")).toEqual({ repository: "tailscale/tailscale", tag: "v1.102.2", digest: null });
    expect(parseImage(`docker.io/tailscale/tailscale@${DIGEST}`)).toEqual({ repository: "tailscale/tailscale", tag: null, digest: DIGEST });
    expect(parseImage(`ghcr.io/tailscale/tailscale:stable@${DIGEST}`).repository).toBe("ghcr.io/tailscale/tailscale");
    for (const bad of ["tailscale/tailscale", "example/tailscale:v1", "tailscale/tailscale:v1;rm", ""]) expect(() => parseImage(bad)).toThrow(TailnetError);
  });

  test("the default follows the host's tailscale version", () => {
    expect(defaultImage("1.102.2\n  tailscale commit: 0123456789\n  go version: go1.26\n")).toBe("tailscale/tailscale:v1.102.2");
    expect(() => defaultImage("")).toThrow(TailnetError);
  });

  test("the digest comes from what Docker recorded", () => {
    expect(pinnedReference("tailscale/tailscale", [`docker.io/tailscale/tailscale@${DIGEST}`])).toBe(`tailscale/tailscale@${DIGEST}`);
    expect(() => pinnedReference("tailscale/tailscale", [`example/other@${DIGEST}`])).toThrow(TailnetError);
    expect(() => pinnedReference("tailscale/tailscale", undefined)).toThrow(TailnetError);
  });
});

describe("container", () => {
  test("the entrypoint routes CGNAT to unreachable before it starts tailscaled", () => {
    const script = entrypointScript();
    const v4 = script.indexOf(`ip -4 route replace unreachable ${CGNAT_IPV4}`);
    const v6 = script.indexOf("ip -6 route replace unreachable fd7a:115c:a1e0::/48");
    const exec = script.indexOf("exec tailscaled ");
    expect(v4).toBeGreaterThan(0);
    expect(v6).toBeGreaterThan(v4);
    expect(exec).toBeGreaterThan(v6);
    // IPv6 is best effort; IPv4 must hold or the container does not start.
    expect(script).toContain("set -eu");
    expect(script.slice(v6, exec)).toContain("||");
    for (const flag of [
      "--statedir=/var/lib/tailscale",
      "--socket=/var/run/tailscale/tailscaled.sock",
      "--tun=tailscale0",
      "--port=0",
      "--socks5-server=0.0.0.0:1055",
      "--outbound-http-proxy-listen=0.0.0.0:1056",
      "--no-logs-no-support",
    ]) {
      expect(script).toContain(flag);
    }
  });

  test("docker run: own network, loopback-only proxies, persistent mounts, read-only passwd", () => {
    const { args, spec } = containerSpec(config());
    const joined = args.join(" ");
    expect(args.slice(0, 2)).toEqual(["run", "--detach"]);
    for (const part of [
      "--name lazurio-tailnet-example-org",
      "--network lazurio-tailnet-example-org",
      "--restart unless-stopped",
      "--cap-add NET_ADMIN",
      "--cap-add NET_RAW",
      "--device /dev/net/tun:/dev/net/tun",
      "--publish 127.0.0.1:10550:1055/tcp",
      "--publish 127.0.0.1:10551:1056/tcp",
      "--dns-search .",
      `--mount type=bind,source=${TAILNETS_ROOT}/example-org/state,target=/var/lib/tailscale`,
      `--mount type=bind,source=${TAILNETS_ROOT}/example-org/run,target=/var/run/tailscale`,
      "--mount type=bind,source=/etc/passwd,target=/etc/passwd,readonly",
      "--mount type=bind,source=/etc/group,target=/etc/group,readonly",
      `--mount type=bind,source=${TAILNETS_ROOT}/example-org/entrypoint.sh,target=/usr/local/bin/lazurio-tailnet-entrypoint,readonly`,
      "--label ai.lazurio.tailnet=example-org",
      `--label ai.lazurio.tailnet.spec=${spec}`,
    ]) {
      expect(joined).toContain(part);
    }
    expect(args.filter((a) => a.startsWith("127.0.0.1:") || /^\d+:\d+/u.test(a))).toHaveLength(2);
    expect(args.slice(-2)).toEqual([`tailscale/tailscale@${DIGEST}`, "/usr/local/bin/lazurio-tailnet-entrypoint"]);
    expect(joined).not.toContain("/run/tailscale/tailscaled.sock");
  });

  test("the spec hash changes with anything that defines the container", () => {
    const { spec } = containerSpec(config());
    expect(containerSpec(config()).spec).toBe(spec);
    expect(containerSpec(config({ hostname: "other-cli" })).spec).toBe(spec);
    expect(containerSpec(config({ ports: { socks5: 10552, http: 10553 } })).spec).not.toBe(spec);
    expect(containerSpec(config({ image: `tailscale/tailscale@sha256:${"cd34".repeat(16)}` })).spec).not.toBe(spec);
  });

  test("up applies exactly the declared prefs", () => {
    expect(upArgs(config())).toEqual([
      "tailscale",
      "up",
      "--reset",
      "--login-server=https://headscale.example.lazurio.io",
      "--hostname=login-device-cli",
      "--operator=station-user",
      "--accept-dns=true",
      "--shields-up=true",
      "--accept-routes=false",
      "--exit-node=",
      "--ssh=false",
      "--timeout=15s",
    ]);
  });

  test("a version warning between two builds of one release is noise, a real mismatch is not", () => {
    expect(isSameReleaseWarning('Warning: client version "1.102.2-t6cac91817-g6ff0ddc72" != tailscaled server version "1.102.2-teb67e5dcb"')).toBe(true);
    expect(isSameReleaseWarning('Warning: client version "1.102.2-t6cac91817" != tailscaled server version "1.104.0-t0123456"')).toBe(false);
    expect(isSameReleaseWarning("Logged out.")).toBe(false);
  });

  test("adoption sees a tailscaled that still uses the state", () => {
    const dir = "/home/station-user/.local/state/ts-example/state";
    expect(usesStatedir(["/usr/sbin/tailscaled", "--tun=userspace-networking", `--statedir=${dir}`], dir)).toBe(true);
    expect(usesStatedir(["/usr/sbin/tailscaled", "--statedir", `${dir}/`], dir)).toBe(true);
    expect(usesStatedir(["/usr/sbin/tailscaled", `--state=${dir}/tailscaled.state`], dir)).toBe(true);
    expect(usesStatedir(["/usr/sbin/tailscaled", "--statedir=/var/lib/tailscale"], dir)).toBe(false);
    expect(usesStatedir(["/usr/sbin/tailscaled", "--state=mem:"], dir)).toBe(false);
  });
});

describe("run", () => {
  test("enters the netns and a private mount namespace through sudo, then drops to the user", () => {
    const argv = runArgv({
      name: "example-org",
      pid: 4242,
      containerId: "c0ffee",
      resolvConf: "/var/lib/docker/containers/c0ffee/resolv.conf",
      uid: 1000,
      gid: 1000,
      envFile: "/tmp/lazurio-tailnet-x/env.sh",
      command: ["curl", "-sS", "https://app.example.lazurio.io"],
    });
    expect(argv.slice(0, 13)).toEqual(["sudo", "-n", "--", "nsenter", "--target=4242", "--net", "--", "unshare", "--mount", "--propagation", "private", "--", "/bin/sh"]);
    expect(argv.slice(15)).toEqual([
      "lazurio-tailnet-run",
      "4242",
      "c0ffee",
      "/var/lib/docker/containers/c0ffee/resolv.conf",
      `${TAILNETS_ROOT}/example-org/run`,
      "1000",
      "1000",
      "/tmp/lazurio-tailnet-x/env.sh",
      "curl",
      "-sS",
      "https://app.example.lazurio.io",
    ]);
    expect(RUN_SCRIPT).toContain('mount --bind -- "$resolv_conf" /etc/resolv.conf');
    // The bound file is compared with what the container sees before the command runs.
    expect(RUN_SCRIPT).toContain('cmp -s /etc/resolv.conf "/proc/$pid/root/etc/resolv.conf" ||');
    expect(RUN_SCRIPT.indexOf("cmp -s")).toBeLessThan(RUN_SCRIPT.indexOf("exec setpriv"));
    expect(RUN_SCRIPT).toContain('mount --bind -- "$socket_dir" /run/tailscale');
    expect(RUN_SCRIPT).toContain('setpriv --reuid="$uid" --regid="$gid" --init-groups');
    expect(() => runArgv({ name: "example-org", pid: 4242, containerId: "c", resolvConf: "/r", uid: 1, gid: 1, envFile: "/e", command: [] })).toThrow(TailnetError);
    expect(() => runArgv({ name: "example-org", pid: 0, containerId: "c", resolvConf: "/r", uid: 1, gid: 1, envFile: "/e", command: ["id"] })).toThrow(TailnetError);
  });

  // Root, namespaces and mounts are proven on a Linux station (manual). Here
  // the plumbing runs for real with stand-ins for grep, mount and setpriv:
  // the arguments, the environment, the working directory, stdin and the
  // exit code arrive exactly.
  const shell = Bun.which("sh") ? test : test.skip;
  shell("the hand-off keeps env, cwd, stdin and the exit code exactly", () => {
    const dir = mkdtempSync(join(sandbox, "run-"));
    const bin = join(dir, "bin");
    mkdirSync(bin);
    const stub = (name, body) => {
      writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
      chmodSync(join(bin, name), 0o755);
    };
    stub("grep", "exit 0");
    stub("cmp", 'exit "${CMP_EXIT:-0}"');
    stub("mount", 'echo "mount $*" >> "$STUB_LOG"');
    stub("setpriv", 'while [ "$1" != "--" ]; do shift; done; shift; exec "$@"');
    const work = join(dir, "work dir");
    mkdirSync(work);
    const callerEnv = {
      PATH: `${bin}:/usr/bin:/bin`,
      HOME: "/home/station-user",
      PYTHONPATH: "/opt/kept",
      LD_LIBRARY_PATH: "/opt/also-kept",
      QUOTED: "it's \"quoted\" $HOME `x`",
      MULTILINE: "line one\nline two",
      EMPTY: "",
      LAZURIO_TAILNET: "spoofed",
    };
    const envFile = join(dir, "env.sh");
    writeFileSync(envFile, runEnvScript(callerEnv, "example-org", 0o027), { mode: 0o600 });
    const log = join(dir, "stub.log");
    const command = ["/bin/sh", "-c", 'umask; pwd; read line; echo "stdin=$line"; /usr/bin/env; exit 7'];
    const argv = ["sh", "-c", RUN_SCRIPT, "lazurio-tailnet-run", "4242", "c0ffee", "/resolv.conf", `${TAILNETS_ROOT}/example-org/run`, "1000", "1000", envFile, ...command];
    // What sudo hands over: a reset environment, as on the station.
    const result = Bun.spawnSync(argv, { cwd: work, env: { PATH: `${bin}:/usr/bin:/bin`, STUB_LOG: log, SUDO_USER: "station-user" }, stdin: Buffer.from("hello\n") });
    expect(result.exitCode).toBe(7);
    const lines = result.stdout.toString().split("\n");
    expect(lines[0]).toBe("0027");
    expect([work, realpathSync(work)]).toContain(lines[1]);
    expect(lines[2]).toBe("stdin=hello");
    const env = result.stdout.toString().split("\n").slice(3).join("\n");
    for (const [key, value] of Object.entries({ ...callerEnv, LAZURIO_TAILNET: "example-org" })) expect(env).toContain(`${key}=${value}`);
    expect(env).not.toContain("LAZURIO_TAILNET=spoofed");
    expect(env).not.toContain("SUDO_USER");
    expect(env).not.toContain("STUB_LOG");
    expect(existsSync(envFile)).toBe(false);
    expect(readFileSync(log, "utf8")).toContain("mount --bind -- /resolv.conf /etc/resolv.conf");
    // A resolv.conf that is not the container's stops the command before it runs.
    writeFileSync(envFile, runEnvScript(callerEnv, "example-org"), { mode: 0o600 });
    const refused = Bun.spawnSync(argv, { cwd: work, env: { PATH: `${bin}:/usr/bin:/bin`, STUB_LOG: log, CMP_EXIT: "1" }, stdin: Buffer.from("hello\n") });
    expect(refused.exitCode).toBe(125);
    expect(refused.stdout.toString()).toBe("");
    expect(refused.stderr.toString()).toContain("does not match the container");
  });

  test("the env script quotes every value and skips names env cannot carry", () => {
    const script = runEnvScript({ GOOD: "a'b", "BAD=NAME": "x", "-DASH": "y", NUL: "a\0b" }, "example-org");
    expect(script).toContain(`'GOOD=a'\\''b'`);
    expect(script).not.toContain("BAD=NAME");
    expect(script).not.toContain("-DASH");
    expect(script).not.toContain("NUL=");
    expect(script).toContain("'LAZURIO_TAILNET=example-org'");
    expect(script.split("\n")[0]).toBe('rm -f -- "$0"');
  });
});

describe("identity", () => {
  const ours = () => ({ labels: { "ai.lazurio.tailnet": "example-org" }, image: `tailscale/tailscale@${DIGEST}` });

  test("a container is the tailnet's by the name label this tool sets and by the pinned image", () => {
    expect(containerMismatch(config(), ours())).toBeNull();
    expect(containerMismatch(config(), { ...ours(), labels: {} })).toBe("container lazurio-tailnet-example-org was not created by this tool for example-org");
    expect(containerMismatch(config(), { ...ours(), labels: { "ai.lazurio.tailnet": "other-org" } })).toContain("was not created by this tool");
    expect(containerMismatch(config(), { ...ours(), image: "tailscale/tailscale:latest" })).toBe(
      `container lazurio-tailnet-example-org runs tailscale/tailscale:latest, not the recorded tailscale/tailscale@${DIGEST}`,
    );
    // A spec label from an older version of the tool is no mismatch: `up` recreates that container.
    expect(containerMismatch(config(), { ...ours(), labels: { ...ours().labels, "ai.lazurio.tailnet.spec": "0000000000000000" } })).toBeNull();
  });

  test("a daemon is the tailnet's node by its ControlURL and its hostname", () => {
    const prefs = { ControlURL: "https://headscale.example.lazurio.io/", Hostname: "login-device-cli" };
    expect(daemonMismatch(config(), prefs)).toBeNull();
    expect(daemonMismatch(config(), { ...prefs, ControlURL: "https://other.example.lazurio.io" })).toBe(
      "uses https://other.example.lazurio.io, not the recorded https://headscale.example.lazurio.io",
    );
    expect(daemonMismatch(config(), { ...prefs, ControlURL: "" })).toBe("uses no login server, not the recorded https://headscale.example.lazurio.io");
    expect(daemonMismatch(config(), { ...prefs, Hostname: "other-cli" })).toBe("is node other-cli, not the recorded login-device-cli");
    expect(daemonMismatch(config(), { ...prefs, Hostname: "" })).toBe("is node (none), not the recorded login-device-cli");
    expect(daemonMismatch(config(), null)).toBe("does not answer");
    // A login server that is no clean URL is not repeated: it could carry credentials.
    const odd = daemonMismatch(config(), { ...prefs, ControlURL: "https://user:secret@other.example.lazurio.io" });
    expect(odd).toBe("uses an invalid login server, not the recorded https://headscale.example.lazurio.io");
  });
});

describe("doctor", () => {
  test("parses listeners, nameservers and profiles", () => {
    const ss = [
      "LISTEN 0 4096 127.0.0.1:10550 0.0.0.0:*",
      "LISTEN 0 4096 0.0.0.0:22 0.0.0.0:*",
      "LISTEN 0 4096 127.0.0.53%lo:53 0.0.0.0:*",
      "LISTEN 0 4096 [::]:22 [::]:*",
      "LISTEN 0 4096 *:443 *:*",
    ].join("\n");
    expect(parseListeners(ss)).toEqual([
      { address: "127.0.0.1", port: 10550 },
      { address: "0.0.0.0", port: 22 },
      { address: "127.0.0.53", port: 53 },
      { address: "::", port: 22 },
      { address: "*", port: 443 },
    ]);
    expect(nameservers("# generated\nnameserver 100.100.100.100\nsearch example.ts.net\n")).toEqual(["100.100.100.100"]);
    expect(countProfiles("ID    Tailnet          Account\n1a2b  example.org      user@example.org*\n")).toBe(1);
    expect(countProfiles("ID  Tailnet  Account\n1  a  a*\n2  b  b\n")).toBe(2);
    expect(countProfiles("Access denied: profiles access denied\n")).toBeNull();
  });

  const healthy = () => ({
    container: {
      running: true,
      status: "running",
      restartPolicy: "unless-stopped",
      image: `tailscale/tailscale@${DIGEST}`,
      labels: { "ai.lazurio.tailnet": "example-org", "ai.lazurio.tailnet.spec": containerSpec(config()).spec },
      spec: containerSpec(config()).spec,
      ports: { "1055/tcp": [{ HostIp: "127.0.0.1", HostPort: "10550" }], "1056/tcp": [{ HostIp: "127.0.0.1", HostPort: "10551" }] },
    },
    status: { BackendState: "Running", AuthURL: "" },
    prefs: {
      ControlURL: "https://headscale.example.lazurio.io",
      Hostname: "login-device-cli",
      ShieldsUp: true,
      RouteAll: false,
      CorpDNS: true,
      ExitNodeID: "",
      ExitNodeIP: "",
      RunSSH: false,
      OperatorUser: "station-user",
    },
    routes: { v4: "unreachable 100.64.0.0/10 \n", v6: "unreachable fd7a:115c:a1e0::/48 dev lo metric 1024 pref medium\n" },
    resolvConf: "nameserver 100.100.100.100\nsearch example.lazurio.io\n",
    listeners: [{ address: "127.0.0.1", port: 10550 }, { address: "127.0.0.1", port: 10551 }],
    socks5: true,
    socket: true,
  });

  test("a healthy tailnet passes every check", () => {
    const verdict = evaluateTailnet(config(), healthy());
    expect(verdict.checks.filter((c) => !c.ok)).toEqual([]);
    expect(verdict.ok).toBe(true);
  });

  test("quad-100 over IPv6 next to IPv4 is healthy, as tailscaled writes it where IPv6 is on", () => {
    const facts = healthy();
    facts.resolvConf = "nameserver 100.100.100.100\nnameserver fd7a:115c:a1e0::53\nsearch example.lazurio.io\n";
    expect(evaluateTailnet(config(), facts).checks.find((c) => c.id === "dns_quad100").ok).toBe(true);
  });

  const failing = (mutate) => {
    const facts = healthy();
    mutate(facts);
    const verdict = evaluateTailnet(config(), facts);
    return { ok: verdict.ok, failed: verdict.checks.filter((c) => !c.ok).map((c) => c.id) };
  };

  test.each([
    ["a different login server", (f) => (f.prefs.ControlURL = "https://other.example.lazurio.io/"), "control_url"],
    ["an exit node", (f) => (f.prefs.ExitNodeID = "nExample"), "no_exit_node"],
    ["accepted routes", (f) => (f.prefs.RouteAll = true), "accept_routes_off"],
    ["DNS off", (f) => (f.prefs.CorpDNS = false), "accept_dns_on"],
    ["shields down", (f) => (f.prefs.ShieldsUp = false), "shields_up"],
    ["Tailscale SSH on", (f) => (f.prefs.RunSSH = true), "tailscale_ssh_off"],
    ["another operator", (f) => (f.prefs.OperatorUser = ""), "operator"],
    ["another node name", (f) => (f.prefs.Hostname = "other-cli"), "node_name"],
    ["no unreachable route", (f) => (f.routes.v4 = ""), "unreachable_cgnat"],
    ["a proxy published beyond loopback", (f) => (f.container.ports["1055/tcp"] = [{ HostIp: "0.0.0.0", HostPort: "10550" }]), "published_loopback_only"],
    ["an extra published port", (f) => (f.container.ports["41641/udp"] = [{ HostIp: "", HostPort: "41641" }]), "published_loopback_only"],
    ["a host listener beyond loopback", (f) => f.listeners.push({ address: "0.0.0.0", port: 10551 }), "listeners_loopback_only"],
    ["a silent SOCKS5 port", (f) => (f.socks5 = false), "socks5_answers"],
    ["Docker's DNS instead of quad-100", (f) => (f.resolvConf = "nameserver 127.0.0.11\n"), "dns_quad100"],
    ["another resolver next to quad-100", (f) => (f.resolvConf = "nameserver 100.100.100.100\nnameserver 127.0.0.11\n"), "dns_quad100"],
    ["a container this tool did not create", (f) => (f.container.labels = {}), "owner"],
    ["a stopped container", (f) => ((f.container.running = false), (f.container.status = "exited")), "container"],
    ["another restart policy", (f) => (f.container.restartPolicy = "no"), "restart_policy"],
  ])("%s fails a required check", (_name, mutate, id) => {
    const { ok, failed } = failing(mutate);
    expect(failed).toContain(id);
    expect(ok).toBe(false);
  });

  test("waiting for sign-in shows the link", () => {
    const facts = healthy();
    facts.status = { BackendState: "NeedsLogin", AuthURL: "https://headscale.example.lazurio.io/register/example" };
    const backend = evaluateTailnet(config(), facts).checks.find((c) => c.id === "backend");
    expect(backend).toMatchObject({ ok: false, level: "required" });
    expect(backend.detail).toContain("/register/example");
  });

  test("advisory checks report without failing", () => {
    const { ok, failed } = failing((f) => {
      f.routes.v6 = "";
      f.socket = false;
      f.container.spec = "0000000000000000";
    });
    expect(failed.sort()).toEqual(["socket_reachable", "spec", "unreachable_tailscale_ipv6"]);
    expect(ok).toBe(true);
  });

  test("the system tailscaled is fine with exactly one profile", () => {
    expect(evaluateSystem({ present: true, profiles: 1, controlUrl: "https://headscale.example.lazurio.io" })).toMatchObject({ ok: true, profiles: 1 });
    expect(evaluateSystem({ present: true, profiles: 2, controlUrl: null }).ok).toBe(false);
    expect(evaluateSystem({ present: true, profiles: null, controlUrl: null }).detail).toBe("profile count unknown");
    expect(evaluateSystem({ present: false })).toMatchObject({ present: false, ok: true });
  });
});
