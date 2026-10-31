import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "./cli.mjs";
import { containerSpec, readConfig, TAILNETS_ROOT, writeConfig } from "./lib.mjs";

// A stand-in for the system: Docker, sudo, ss and the host tailscale are
// simulated, so the command flows run without a daemon. The real thing is
// proven on a Linux station (manual/station-tailnets.md, "Ověření").
const DIGEST = `sha256:${"ab12".repeat(16)}`;
const IMAGE = `tailscale/tailscale@${DIGEST}`;
const LOGIN = "https://headscale.example.lazurio.io";
const sandbox = mkdtempSync(join(tmpdir(), "tailnet-cli-"));
afterAll(() => rmSync(sandbox, { recursive: true, force: true }));

const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });
const fail = (stderr) => ({ code: 1, stdout: "", stderr });

function fakeSystem({ platform = "linux", uid = 1000, backend = "Running", authUrl = "", processes = [], statePresent = false } = {}) {
  const home = mkdtempSync(join(sandbox, "home-"));
  const docker = { containers: new Map(), networks: new Map(), backend, authUrl, controlUrl: LOGIN, upCode: 0 };
  const calls = [];
  const out = [];
  const err = [];
  const spawned = [];
  const option = (args, flag) => args.flatMap((a, k) => (a === flag ? [args[k + 1]] : []));
  const prefs = () => ({
    ControlURL: docker.controlUrl,
    Hostname: "login-device-cli",
    ShieldsUp: true,
    RouteAll: false,
    CorpDNS: true,
    ExitNodeID: "",
    ExitNodeIP: "",
    RunSSH: false,
    OperatorUser: "station-user",
  });
  const exec = (argv) => {
    calls.push(argv);
    const [command, ...a] = argv;
    if (command === "sudo") {
      const rest = a.slice(a.indexOf("--") + 1);
      if (rest[0] === "find") return ok(statePresent ? `${rest[1]}/tailscaled.state\n` : "");
      if (rest[0] === "tailscale") return ok("ID    Tailnet               Account\n1a2b  example.lazurio.io    login@example.lazurio.io*\n");
      return ok();
    }
    if (command === "tailscale") {
      if (a[0] === "version") return ok("1.102.2\n  tailscale commit: 0000000\n");
      if (a.includes("prefs")) return ok(JSON.stringify(prefs()));
      return fail("unexpected tailscale call");
    }
    if (command === "ss") return ok("LISTEN 0 4096 0.0.0.0:22 0.0.0.0:*\nLISTEN 0 4096 127.0.0.1:10550 0.0.0.0:*\nLISTEN 0 4096 127.0.0.1:10551 0.0.0.0:*\n");
    if (command !== "docker") return fail(`${command}: not simulated`);
    const name = a.at(-1);
    switch (`${a[0]} ${a[1]}`) {
      case "image inspect":
        return ok(JSON.stringify([{ RepoDigests: [`docker.io/${IMAGE}`] }]));
      case "network inspect":
        return docker.networks.has(name) ? ok(JSON.stringify(docker.networks.get(name))) : fail(`Error response from daemon: network ${name} not found`);
      case "network create":
        docker.networks.set(name, Object.fromEntries(option(a, "--label").map((l) => l.split("="))));
        return ok("netid\n");
      case "network rm":
        docker.networks.delete(name);
        return ok();
      case "container inspect": {
        const c = docker.containers.get(name);
        if (!c) return fail(`Error: No such container: ${name}`);
        // Published as `docker run --publish <ip>:<host port>:<container port>/tcp` asked.
        const ports = Object.fromEntries(
          (c.publish ?? []).map((p) => p.split(":")).map(([ip, hostPort, containerPort]) => [containerPort, [{ HostIp: ip, HostPort: hostPort }]]),
        );
        return ok(
          JSON.stringify([
            {
              Id: "c0ffee",
              State: { Running: c.running, Status: c.running ? "running" : "exited", Pid: c.running ? 4242 : 0 },
              HostConfig: { RestartPolicy: { Name: "unless-stopped" }, PortBindings: ports },
              Config: { Image: c.image, Labels: c.labels },
              NetworkSettings: { Ports: c.running ? ports : {} },
            },
          ]),
        );
      }
    }
    switch (a[0]) {
      case "pull":
        return ok(`docker.io/${name}\n`);
      case "run": {
        const container = option(a, "--name")[0];
        docker.containers.set(container, {
          running: true,
          image: a.at(-2),
          labels: Object.fromEntries(option(a, "--label").map((l) => l.split("="))),
          publish: option(a, "--publish"),
        });
        return ok("c0ffee\n");
      }
      case "start":
        docker.containers.get(name).running = true;
        return ok();
      case "stop":
        docker.containers.get(name).running = false;
        return ok();
      case "rm":
        docker.containers.delete(name);
        return ok();
      case "exec": {
        const inside = a.slice(2).join(" ");
        if (inside === "tailscale status --json") return ok(JSON.stringify({ BackendState: docker.backend, AuthURL: docker.authUrl, Peer: { a: { Online: true }, b: { Online: false } } }));
        if (inside.startsWith("tailscale up ")) return docker.upCode === 0 ? ok() : fail("timeout waiting for Tailscale service to enter a Running state");
        if (inside === "tailscale debug prefs") return ok(JSON.stringify(prefs()));
        if (inside === "ip -4 route show type unreachable") return ok("unreachable 100.64.0.0/10 \n");
        if (inside === "ip -6 route show type unreachable") return ok("");
        if (inside === "cat /etc/resolv.conf") return ok("nameserver 100.100.100.100\n");
        return fail(`not simulated: ${inside}`);
      }
      default:
        return fail(`not simulated: docker ${a.join(" ")}`);
    }
  };
  const ctx = {
    platform,
    env: { PATH: "/usr/bin:/bin", HOME: home, EXAMPLE: "kept" },
    home,
    uid,
    gid: 1000,
    user: "station-user",
    cwd: "/home/station-user/work",
    umask: 0o022,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    exec,
    spawnInherit: async (argv) => {
      const envFile = argv[argv.indexOf("lazurio-tailnet-run") + 6];
      spawned.push({ argv, env: envFile && existsSync(envFile) ? readFileSync(envFile, "utf8") : null });
      return 7;
    },
    which: () => "/usr/bin/tailscale",
    sleep: async () => {},
    now: () => "2026-10-31T00:00:00.000Z",
    processes: () => processes,
    socks5Answers: async () => true,
    socketConnects: async () => true,
    tempDir: () => mkdtempSync(join(sandbox, "tmp-")),
  };
  const ran = (prefix) => calls.filter((argv) => argv.join(" ").startsWith(prefix));
  return { ctx, docker, calls, out, err, spawned, home, ran };
}

const UP = ["up", "example-org", "--login-server", `${LOGIN}/`, "--hostname", "login-device-cli"];

describe("entry", () => {
  test("a Mac keeps its headless clients", async () => {
    const { ctx, err, calls } = fakeSystem({ platform: "darwin" });
    expect(await main(["status"], ctx)).toBe(2);
    expect(err.join("\n")).toContain("headless clients");
    expect(calls).toEqual([]);
  });

  test("other platforms are refused too", async () => {
    const { ctx } = fakeSystem({ platform: "win32" });
    expect(await main(["doctor"], ctx)).toBe(2);
  });

  test("usage", async () => {
    const { ctx, out, err } = fakeSystem();
    expect(await main([], ctx)).toBe(2);
    expect(err.join("\n")).toContain("ssh-proxy <name> <host> <port>");
    expect(await main(["--help"], ctx)).toBe(0);
    expect(out.join("\n")).toContain("run <name> -- <command…>");
    expect(await main(["switch"], ctx)).toBe(2);
    expect(await main(["up", "Bad_Name", "--login-server", LOGIN, "--hostname", "x"], ctx)).toBe(2);
  });
});

describe("up", () => {
  test("prepares the host, records the config and applies the prefs", async () => {
    const { ctx, out, ran, home, docker } = fakeSystem();
    expect(await main(UP, ctx)).toBe(0);
    const config = readConfig(home, "example-org");
    expect(config).toMatchObject({
      name: "example-org",
      login_server: LOGIN,
      hostname: "login-device-cli",
      operator: "station-user",
      image: IMAGE,
      image_tag: "v1.102.2",
      ports: { socks5: 10552, http: 10553 },
    });
    // 10550 and 10551 are taken on the host, so the next pair is recorded.
    expect(ran("docker pull --quiet tailscale/tailscale:v1.102.2")).toHaveLength(1);
    expect(ran(`sudo -n -- install -d -o root -g root -m 0700 ${TAILNETS_ROOT}/example-org/state`)).toHaveLength(1);
    expect(ran("sudo -n -- install -o root -g root -m 0755")[0].at(-1)).toBe(`${TAILNETS_ROOT}/example-org/entrypoint.sh`);
    expect(ran("docker network create")).toHaveLength(1);
    expect(ran("docker run --detach")).toEqual([["docker", ...containerSpec(config).args]]);
    const upCall = ran("docker exec lazurio-tailnet-example-org tailscale up")[0];
    expect(upCall).toContain("--reset");
    expect(upCall).toContain("--operator=station-user");
    expect(out[0]).toBe("tailnet example-org: Running as login-device-cli (2 peers, 1 online)");
    expect(out.join("\n")).toContain("socks5h://127.0.0.1:10552  http://127.0.0.1:10553");
    expect(docker.containers.get("lazurio-tailnet-example-org").running).toBe(true);
  });

  test("a second up keeps the container and the recorded ports", async () => {
    const system = fakeSystem();
    expect(await main(UP, system.ctx)).toBe(0);
    const first = readConfig(system.home, "example-org");
    system.calls.length = 0;
    expect(await main(UP, system.ctx)).toBe(0);
    expect(system.ran("docker run")).toEqual([]);
    expect(system.ran("docker pull")).toEqual([]);
    expect(readConfig(system.home, "example-org").ports).toEqual(first.ports);
    expect(system.out.join("\n")).toContain("container lazurio-tailnet-example-org kept");
  });

  test("a container from another version of the tool is recreated, its state stays", async () => {
    const system = fakeSystem();
    await main(UP, system.ctx);
    system.docker.containers.get("lazurio-tailnet-example-org").labels["ai.lazurio.tailnet.spec"] = "0000000000000000";
    system.calls.length = 0;
    expect(await main(UP, system.ctx)).toBe(0);
    expect(system.ran("docker stop -t 10 lazurio-tailnet-example-org")).toHaveLength(1);
    expect(system.ran("docker rm lazurio-tailnet-example-org")).toHaveLength(1);
    expect(system.ran("docker run --detach")).toHaveLength(1);
    expect(system.ran("sudo -n -- rm")).toEqual([]);
  });

  test("another login server is another tailnet", async () => {
    const system = fakeSystem();
    await main(UP, system.ctx);
    const code = await main(["up", "example-org", "--login-server", "https://other.example.lazurio.io", "--hostname", "login-device-cli"], system.ctx);
    expect(code).toBe(2);
    expect(system.err.join("\n")).toContain("another login server is another tailnet");
  });

  test("not as root", async () => {
    const { ctx, err } = fakeSystem({ uid: 0 });
    expect(await main(UP, ctx)).toBe(2);
    expect(err.join("\n")).toContain("not as root");
  });

  test("waiting for sign-in prints the link and exits 3", async () => {
    const { ctx, out, err, docker } = fakeSystem({ backend: "NeedsLogin", authUrl: `${LOGIN}/register/example` });
    docker.upCode = 1;
    expect(await main(UP, ctx)).toBe(3);
    expect(out.join("\n")).toContain(`sign in   ${LOGIN}/register/example`);
    expect(err).toEqual([]);
  });

  test("a login server that does not answer yet says so", async () => {
    const { ctx, out, err, docker } = fakeSystem({ backend: "NeedsLogin" });
    docker.upCode = 1;
    expect(await main(UP, ctx)).toBe(3);
    expect(out.join("\n")).toContain("no link from");
    expect(err.join("\n")).toContain("timeout waiting");
  });

  test("a container this tool did not create is left alone", async () => {
    const system = fakeSystem();
    system.docker.containers.set("lazurio-tailnet-example-org", { running: true, image: "example/other", labels: {} });
    expect(await main(UP, system.ctx)).toBe(1);
    expect(system.err.join("\n")).toContain("did not create");
    expect(system.ran("docker rm")).toEqual([]);
  });

  test("adoption copies an idle state into an empty state directory", async () => {
    const source = "/home/station-user/.local/state/ts-example/state";
    const system = fakeSystem({ processes: [{ pid: 9, argv: ["/usr/sbin/tailscaled", "--statedir=/var/lib/tailscale"] }] });
    expect(await main([...UP, "--adopt-state", source], system.ctx)).toBe(0);
    expect(system.ran(`sudo -n -- cp -a -- ${source}/. ${TAILNETS_ROOT}/example-org/state/`)).toHaveLength(1);
    expect(system.ran(`sudo -n -- chmod 0700 ${TAILNETS_ROOT}/example-org/state`)).toHaveLength(1);
    expect(readConfig(system.home, "example-org").adopted_from).toBe(source);
  });

  test("adoption refuses a state another tailscaled still uses", async () => {
    const source = "/home/station-user/.local/state/ts-example/state";
    const system = fakeSystem({ processes: [{ pid: 4711, argv: ["/usr/sbin/tailscaled", "--tun=userspace-networking", `--statedir=${source}`] }] });
    expect(await main([...UP, "--adopt-state", source], system.ctx)).toBe(1);
    expect(system.err.join("\n")).toContain("tailscaled 4711 still uses");
    expect(system.ran("sudo -n -- cp")).toEqual([]);
    expect(readConfig(system.home, "example-org")).toBeNull();
  });

  test("adoption never replaces a node that is already there", async () => {
    const system = fakeSystem({ statePresent: true });
    expect(await main([...UP, "--adopt-state", "/home/station-user/old-state"], system.ctx)).toBe(1);
    expect(system.err.join("\n")).toContain("already holds a node");
    expect(system.ran("sudo -n -- cp")).toEqual([]);
  });
});

describe("run, proxy, ssh-proxy, down, status, doctor", () => {
  const ready = async (options) => {
    const system = fakeSystem(options);
    expect(await main(UP, system.ctx)).toBe(0);
    system.calls.length = 0;
    system.out.length = 0;
    return system;
  };

  test("run hands the command, the environment and the exit code through", async () => {
    const system = await ready();
    expect(await main(["run", "example-org", "--", "curl", "-sS", "https://app.example.lazurio.io"], system.ctx)).toBe(7);
    const [{ argv, env }] = system.spawned;
    expect(argv.slice(0, 6)).toEqual(["sudo", "-n", "--", "nsenter", "--target=4242", "--net"]);
    expect(argv.slice(-3)).toEqual(["curl", "-sS", "https://app.example.lazurio.io"]);
    expect(argv.slice(argv.indexOf("lazurio-tailnet-run") + 1, argv.indexOf("lazurio-tailnet-run") + 3)).toEqual(["4242", "c0ffee"]);
    expect(env).toContain("'LAZURIO_TAILNET=example-org'");
    expect(env).toContain("'EXAMPLE=kept'");
    // The temporary environment file is gone once the command ended.
    expect(existsSync(argv[argv.indexOf("lazurio-tailnet-run") + 6])).toBe(false);
  });

  test("run needs -- and a running tailnet", async () => {
    const system = await ready();
    expect(await main(["run", "example-org", "id"], system.ctx)).toBe(2);
    await main(["down", "example-org"], system.ctx);
    expect(await main(["run", "example-org", "--", "id"], system.ctx)).toBe(1);
    expect(system.err.join("\n")).toContain("is not running");
    expect(system.spawned).toEqual([]);
  });

  test("proxy prints the loopback proxies", async () => {
    const system = await ready();
    expect(await main(["proxy", "example-org"], system.ctx)).toBe(0);
    expect(system.out).toEqual(["socks5h://127.0.0.1:10552", "http://127.0.0.1:10553"]);
    system.out.length = 0;
    await main(["proxy", "example-org", "--json"], system.ctx);
    expect(JSON.parse(system.out[0])).toEqual({ name: "example-org", socks5: "socks5h://127.0.0.1:10552", http: "http://127.0.0.1:10553" });
  });

  test("ssh-proxy checks the login server, then runs tailscale nc on the tailnet's socket", async () => {
    const system = await ready();
    expect(await main(["ssh-proxy", "example-org", "example-host", "22"], system.ctx)).toBe(7);
    expect(system.spawned[0].argv).toEqual(["tailscale", `--socket=${TAILNETS_ROOT}/example-org/run/tailscaled.sock`, "nc", "example-host", "22"]);
    system.docker.controlUrl = "https://other.example.lazurio.io";
    expect(await main(["ssh-proxy", "example-org", "example-host", "22"], system.ctx)).toBe(1);
    expect(system.err.join("\n")).toContain("not connecting");
    expect(system.spawned).toHaveLength(1);
    expect(await main(["ssh-proxy", "example-org", "example-host", "99999"], system.ctx)).toBe(2);
    expect(system.out).toEqual([]);
  });

  test("down removes the container and the network and keeps state and config", async () => {
    const system = await ready();
    expect(await main(["down", "example-org"], system.ctx)).toBe(0);
    expect(system.docker.containers.size).toBe(0);
    expect(system.docker.networks.size).toBe(0);
    expect(system.ran("sudo")).toEqual([]);
    expect(readConfig(system.home, "example-org")).not.toBeNull();
    expect(system.out.join("\n")).toContain(`kept: state ${TAILNETS_ROOT}/example-org/state`);
  });

  test("status reports every tailnet", async () => {
    const system = await ready();
    writeConfig(system.home, { ...readConfig(system.home, "example-org"), name: "second", ports: { socks5: 10554, http: 10555 } });
    expect(await main(["status", "--json"], system.ctx)).toBe(0);
    const rows = JSON.parse(system.out.join("\n"));
    expect(rows.map((r) => [r.name, r.container, r.backend])).toEqual([
      ["example-org", "running", "Running"],
      ["second", "missing", null],
    ]);
  });

  test("doctor passes a healthy tailnet and reports the system tailscaled", async () => {
    const system = await ready();
    expect(await main(["doctor"], system.ctx)).toBe(0);
    const text = system.out.join("\n");
    expect(text).toContain("example-org: OK");
    expect(text).toContain("warn  unreachable_tailscale_ipv6");
    expect(text).toContain("system tailscaled (read only): ok   one profile");
    expect(system.ran("sudo -n -- tailscale switch --list")).toHaveLength(1);
  });

  test("doctor fails a tailnet signed in elsewhere", async () => {
    const system = await ready();
    system.docker.controlUrl = "https://other.example.lazurio.io";
    expect(await main(["doctor", "--json"], system.ctx)).toBe(1);
    const report = JSON.parse(system.out.join("\n"));
    expect(report.ok).toBe(false);
    expect(report.tailnets[0].checks.find((c) => c.id === "control_url")).toMatchObject({ ok: false, detail: "https://other.example.lazurio.io" });
  });
});
