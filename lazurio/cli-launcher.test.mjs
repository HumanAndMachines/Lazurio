import { afterAll, expect, test } from "bun:test";
import { chmod, cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  BunRuntimeRefused,
  bunRuntimeRefusalMessage,
  bunTargets,
  hostBunSystem,
  moduleBunRoot,
} from "./runtime/bun-runtime-lib.mjs";
import {
  CLI_BUN_ENV,
  cliBunMarkerRefusal,
  cliRuntimeFallbackLine,
  finishLazurioCli,
  isResidentArtifact,
  launchLazurioCli,
} from "./runtime/cli-runtime-lib.mjs";
import { compareStableVersions } from "./core/toolchain-lib.mjs";
import { platformTestTimeout } from "../launchpad/src/test-platform-setup.mjs";

// The `lazurio` command runs the CLI on Lazurio's exact Bun (decision 0134
// with its addendum of 2026-10-25): in its own process when it already runs
// on it, otherwise re-executed on it from Lazurio's runtime cache, and on the
// user's Bun with one line only offline. First the launcher with every seam
// a fake, then real processes: copies of this package with their own pin, a
// runtime cache under a temporary home and a fake exact Bun in it. Nothing
// here reads the real cache or the network.
const tempRoots = [];
const posix = process.platform !== "win32";
const posixTest = test.skipIf(!posix);
const packageRoot = "/opt/lazurio/lazurio";
const mainPath = "/opt/lazurio/lazurio/cli-main.mjs";
const cachedBun = "/home/anna/.local/share/lazurio/runtimes/bun/1.4.2/node_modules/@oven/bun-linux-x64/bin/bun";

afterAll(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
});

// The seams of one launch; every call they see is recorded in `calls`.
function seams({
  running = "1.4.4",
  pin = "1.4.2",
  env = { PATH: "/usr/bin:/bin" },
  resolve = async () => ({ executable: cachedBun, binDir: dirname(cachedBun), source: "cache" }),
  mainCode = 0,
  platform = "linux",
} = {}) {
  const calls = { resolve: [], spawn: [], kill: [], main: [], stderr: [] };
  const handlers = new Map();
  let endChild;
  const child = {
    exitCode: null,
    signalCode: null,
    exited: new Promise((resolve) => { endChild = resolve; }),
    kill(signal) {
      calls.kill.push(signal);
    },
  };
  return {
    calls,
    handlers,
    // The child ends with an exit code or a signal, as Bun reports it.
    end({ code = null, signal = null }) {
      child.exitCode = code;
      child.signalCode = signal;
      endChild(signal === null ? code : 128 + { SIGHUP: 1, SIGINT: 2, SIGTERM: 15 }[signal]);
    },
    options: {
      argv: ["doctor", "--json"],
      packageRoot,
      mainPath,
      env,
      runningVersion: running,
      execPath: "/usr/local/bin/bun",
      platform,
      readPin: async () => pin,
      loadMain: async () => async (argv) => {
        calls.main.push(argv);
        return mainCode;
      },
      resolveBun: async (input) => {
        calls.resolve.push(input);
        return resolve(input);
      },
      spawnProcess: (command, options) => {
        calls.spawn.push({ command, options });
        return child;
      },
      processObject: {
        on(signal, handler) { handlers.set(signal, handler); },
        off(signal, handler) { if (handlers.get(signal) === handler) handlers.delete(signal); },
      },
      writeError: (line) => calls.stderr.push(line),
    },
  };
}

const refused = (reason) => new BunRuntimeRefused(reason, {
  path: join(packageRoot, "package.json"),
  version: "1.4.2",
  cacheRoot: "~/.local/share/lazurio/runtimes/bun",
});

test("on its exact Bun the CLI runs in this process: no resolution, no child, no line, its own exit code", async () => {
  const launch = seams({ running: "1.4.2", mainCode: 3 });
  launch.options.resolveBun = () => { throw new Error("the exact Bun needs no resolution"); };
  launch.options.spawnProcess = () => { throw new Error("the exact Bun needs no child"); };

  expect(await launchLazurioCli(launch.options)).toEqual({ code: 3 });
  expect(launch.calls.main).toEqual([["doctor", "--json"]]);
  expect(launch.calls.stderr).toEqual([]);
});

test("on another Bun the CLI re-executes itself on the exact Bun the resolver gives, with the loop guard set", async () => {
  for (const code of [0, 1, 2, 3]) {
    const env = { PATH: "/usr/bin:/bin", LANG: "cs_CZ.UTF-8" };
    const launch = seams({ env });
    const outcome = launchLazurioCli(launch.options);
    await Bun.sleep(0);
    launch.end({ code });

    expect(await outcome).toEqual({ code });
    expect(launch.calls.resolve).toEqual([{
      pin: "1.4.2",
      packageRoot,
      execPath: "/usr/local/bin/bun",
      env,
      platform: "linux",
    }]);
    expect(launch.calls.spawn).toEqual([{
      command: [cachedBun, mainPath, "doctor", "--json"],
      options: {
        env: { PATH: "/usr/bin:/bin", LANG: "cs_CZ.UTF-8", [CLI_BUN_ENV]: "1.4.2" },
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
      },
    }]);
    // The user's environment itself stays as it was.
    expect(env).toEqual({ PATH: "/usr/bin:/bin", LANG: "cs_CZ.UTF-8" });
    expect(launch.calls.main).toEqual([]);
    expect(launch.calls.stderr).toEqual([]);
    expect(launch.handlers.size).toBe(0);
  }
});

test("SIGINT, SIGTERM and SIGHUP reach the re-executed CLI and the launcher ends with its signal", async () => {
  const launch = seams();
  const outcome = launchLazurioCli(launch.options);
  await Bun.sleep(0);
  expect([...launch.handlers.keys()].sort()).toEqual(["SIGHUP", "SIGINT", "SIGTERM"]);
  launch.handlers.get("SIGINT")();
  launch.handlers.get("SIGTERM")();
  launch.end({ signal: "SIGTERM" });

  expect(await outcome).toEqual({ code: 143, signal: "SIGTERM" });
  expect(launch.calls.kill).toEqual(["SIGINT", "SIGTERM"]);
  expect(launch.handlers.size).toBe(0);

  // The launcher's own end: the child's signal, its code if that does not end it.
  const kills = [];
  const ended = { pid: 4242, exitCode: undefined, kill: (pid, signal) => kills.push([pid, signal]) };
  finishLazurioCli({ code: 143, signal: "SIGTERM" }, { processObject: ended, platform: "linux" });
  expect(kills).toEqual([[4242, "SIGTERM"]]);
  expect(ended.exitCode).toBe(143);

  const exited = { pid: 4242, exitCode: undefined, kill: () => { throw new Error("an exit code is no signal"); } };
  finishLazurioCli({ code: 3 }, { processObject: exited, platform: "linux" });
  expect(exited.exitCode).toBe(3);
});

test("on Windows the same spawn path runs the .exe the resolver gives, without POSIX signals", async () => {
  const exe = "C:\\Users\\anna\\AppData\\Local\\Lazurio\\runtimes\\bun\\1.4.2\\node_modules\\@oven\\bun-windows-x64\\bin\\bun.exe";
  const launch = seams({
    platform: "win32",
    env: { Path: "C:\\Windows\\System32" },
    resolve: async () => ({ executable: exe, binDir: dirname(exe), source: "cache" }),
  });
  launch.options.mainPath = "C:\\Users\\anna\\Lazurio\\lazurio\\cli-main.mjs";
  const outcome = launchLazurioCli(launch.options);
  await Bun.sleep(0);
  expect([...launch.handlers.keys()].sort()).toEqual(["SIGINT", "SIGTERM"]);
  launch.end({ code: 1 });

  expect(await outcome).toEqual({ code: 1 });
  expect(launch.calls.spawn[0].command).toEqual([exe, "C:\\Users\\anna\\Lazurio\\lazurio\\cli-main.mjs", "doctor", "--json"]);
  expect(launch.calls.spawn[0].options.env).toEqual({ Path: "C:\\Windows\\System32", [CLI_BUN_ENV]: "1.4.2" });

  // A Windows child ended by TerminateProcess leaves its exit code only.
  const ended = { pid: 7, exitCode: undefined, kill: () => { throw new Error("no POSIX signal on Windows"); } };
  finishLazurioCli({ code: 1, signal: "SIGTERM" }, { processObject: ended, platform: "win32" });
  expect(ended.exitCode).toBe(1);
});

test("a guard inherited from an earlier re-execution never stops a launcher on another Bun: it re-executes with a fresh guard", async () => {
  // Bun.spawn without an env option hands a child the variables of its own
  // start, so a process a re-executed CLI starts can carry LAZURIO_CLI_BUN into
  // a later `lazurio` on another Bun (an App's binDir first on PATH, say). The
  // launcher starts cli-main.mjs, never itself, so it cannot loop; the guard
  // is only the re-executed CLI's check of the Bun it was given.
  for (const inherited of ["1.4.2", "1.3.10"]) {
    const launch = seams({ env: { PATH: "/usr/bin:/bin", [CLI_BUN_ENV]: inherited } });
    const outcome = launchLazurioCli(launch.options);
    await Bun.sleep(0);
    launch.end({ code: 0 });
    expect(await outcome).toEqual({ code: 0 });
    expect(launch.calls.resolve).toHaveLength(1);
    expect(launch.calls.spawn[0].options.env[CLI_BUN_ENV]).toBe("1.4.2");
    expect(launch.calls.stderr).toEqual([]);
  }
});

test("a CLI in a Resident artifact runs on the artifact's own Bun: no resolution, no child, no line (decision 0134)", async () => {
  const launch = seams({ running: "1.3.10", env: { PATH: "/usr/bin:/bin", [CLI_BUN_ENV]: "1.4.2" } });
  launch.options.residentArtifact = () => true;
  launch.options.resolveBun = () => { throw new Error("a Resident artifact is never resolved"); };
  launch.options.spawnProcess = () => { throw new Error("a Resident artifact is never re-executed"); };

  expect(await launchLazurioCli(launch.options)).toEqual({ code: 0 });
  expect(launch.calls.main).toEqual([["doctor", "--json"]]);
  expect(launch.calls.stderr).toEqual([]);
  expect(launch.options.env[CLI_BUN_ENV]).toBeUndefined();
});

test("a Resident artifact is a code root whose lazurio.resident.json is a regular file", async () => {
  const root = await mkdtemp(join(tmpdir(), "lazurio-resident-"));
  tempRoots.push(root);
  const packageRoot = join(root, "lazurio");
  await mkdir(packageRoot, { recursive: true });
  expect(await isResidentArtifact(packageRoot)).toBe(false);
  await mkdir(join(root, "lazurio.resident.json"));
  expect(await isResidentArtifact(packageRoot)).toBe(false);
  await rm(join(root, "lazurio.resident.json"), { recursive: true });
  await writeFile(join(root, "lazurio.resident.json"), "{}");
  expect(await isResidentArtifact(packageRoot)).toBe(true);
});

test("offline, without its exact Bun, the CLI runs on the user's Bun with exactly one line", async () => {
  const launch = seams({ resolve: async () => { throw refused("runtime-unavailable"); }, mainCode: 1 });
  launch.options.spawnProcess = () => { throw new Error("offline nothing is spawned"); };

  expect(await launchLazurioCli(launch.options)).toEqual({ code: 1 });
  expect(launch.calls.stderr).toEqual([
    "lazurio: přesný Bun 1.4.2 není dostupný offline, Lazurio běží na Bunu 1.4.4. Spusťte lazurio update s připojením k internetu.",
  ]);
  expect(cliRuntimeFallbackLine({ pin: "1.4.2", running: "1.4.4" })).toBe(launch.calls.stderr[0]);
  expect(launch.calls.main).toEqual([["doctor", "--json"]]);
});

test("every other refusal fails closed with its words and exit 2", async () => {
  for (const reason of [
    "runtime-integrity-failed",
    "runtime-version-unknown",
    "runtime-disk-full",
    "runtime-unsupported-platform",
  ]) {
    const launch = seams({ resolve: async () => { throw refused(reason); } });
    launch.options.spawnProcess = () => { throw new Error("a refusal spawns nothing"); };

    expect(await launchLazurioCli(launch.options)).toEqual({ code: 2 });
    expect(launch.calls.stderr).toEqual([`lazurio: ${bunRuntimeRefusalMessage(reason, {
      file: join(packageRoot, "package.json"),
      version: "1.4.2",
      cacheRoot: "~/.local/share/lazurio/runtimes/bun",
    })}`]);
    expect(launch.calls.main).toEqual([]);
  }

  // Not a refusal (here: the user's Bun does not run, so nothing can be
  // fetched): the same closed end.
  const broken = seams({ resolve: async () => { throw new Error("Bun uživatele nejde spustit."); } });
  expect(await launchLazurioCli(broken.options)).toEqual({ code: 2 });
  expect(broken.calls.stderr).toEqual(["lazurio: Bun uživatele nejde spustit."]);
  expect(broken.calls.main).toEqual([]);

  // Nor does a pin that cannot be read pass for one.
  const unreadable = seams();
  unreadable.options.readPin = async () => {
    throw new Error("package.json#packageManager must pin an exact stable Bun version");
  };
  expect(await launchLazurioCli(unreadable.options)).toEqual({ code: 2 });
  expect(unreadable.calls.stderr).toEqual(["lazurio: package.json#packageManager must pin an exact stable Bun version"]);
  expect(unreadable.calls.resolve).toEqual([]);
  expect(unreadable.calls.main).toEqual([]);
});

test("the re-executed CLI consumes its loop guard and refuses a Bun that is not that version", () => {
  const env = { [CLI_BUN_ENV]: "1.4.2", PATH: "/usr/bin" };
  expect(cliBunMarkerRefusal({ env, runningVersion: "1.4.2" })).toBeNull();
  // Consumed: what the CLI starts does not inherit it.
  expect(env).toEqual({ PATH: "/usr/bin" });

  expect(cliBunMarkerRefusal({ env: { PATH: "/usr/bin" }, runningVersion: "1.4.4" })).toBeNull();

  const refusal = cliBunMarkerRefusal({ env: { [CLI_BUN_ENV]: "9.9.9" }, runningVersion: "1.4.2" });
  expect(refusal).toStartWith("lazurio: ");
  expect(refusal).toContain("9.9.9");
  expect(refusal).toContain("1.4.2");
});

test("cli.mjs stays the bin and imports only node builtins and the launcher library; cli-main.mjs is the CLI", async () => {
  const manifest = JSON.parse(await readFile(join(import.meta.dirname, "package.json"), "utf8"));
  expect(manifest.bin).toEqual({ lazurio: "cli.mjs" });

  const launcher = await readFile(join(import.meta.dirname, "cli.mjs"), "utf8");
  expect(launcher.split("\n")[0]).toBe("#!/usr/bin/env bun");
  const imports = (source) => new Bun.Transpiler({ loader: "js" })
    .scanImports(source.replace(/^#![^\n]*\n/u, ""))
    .map(({ path: specifier, kind }) => `${kind} ${specifier}`)
    .sort();
  expect(imports(launcher)).toEqual([
    "dynamic-import ./cli-main.mjs",
    "import-statement ./runtime/cli-runtime-lib.mjs",
    "import-statement node:url",
  ]);
  // The launcher library loads the toolchain and the resolver only when it
  // needs them.
  const library = await readFile(join(import.meta.dirname, "runtime", "cli-runtime-lib.mjs"), "utf8");
  for (const entry of imports(library)) {
    expect(entry).toMatch(/^(import-statement node:[a-z_/]+|dynamic-import \.\.?\/[a-z/-]+-lib\.mjs)$/u);
  }

  const cli = await import("./cli-main.mjs");
  expect(cli.main).toBeFunction();
});

// --- Real processes ---------------------------------------------------------

// A copy of this package whose CLI pins `pin`, as an installed package would;
// the copies are made once per pin.
const copies = new Map();
function lazurioCopy(pin) {
  if (!copies.has(pin)) copies.set(pin, makeCopy(pin));
  return copies.get(pin);
}

async function makeCopy(pin) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "lazurio-cli-launcher-")));
  tempRoots.push(root);
  const copy = join(root, "lazurio");
  await cp(import.meta.dirname, copy, {
    recursive: true,
    filter: (source) => !/[\\/]node_modules(?:[\\/]|$)/u.test(source) && !source.endsWith(".test.mjs"),
  });
  const manifestPath = join(copy, "package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.packageManager = `bun@${pin}`;
  manifest.engines = { ...manifest.engines, bun: pin };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  // The default follows the pin by test; the minimum stays unless it would be
  // above it.
  const toolchainPath = join(copy, "toolchain.json");
  const toolchain = JSON.parse(await readFile(toolchainPath, "utf8"));
  const { minimum } = toolchain.tools.bun;
  toolchain.tools.bun = { default: pin, minimum: compareStableVersions(pin, minimum) < 0 ? pin : minimum };
  await writeFile(toolchainPath, `${JSON.stringify(toolchain, null, 2)}\n`);
  return { root, packageRoot: copy };
}

// A home of its own: its runtime cache starts empty.
async function home() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "lazurio-cli-launcher-home-")));
  tempRoots.push(directory);
  return directory;
}

// The CLI's Bun as the runtime cache keeps it, faked: it logs the loop guard
// and its arguments, answers --version with `version` and otherwise runs the
// real Bun, or `sleep` or `cat` when LAZURIO_FIXTURE_CHILD asks.
async function cachedFakeBun({ homeDirectory, version }) {
  const [target] = bunTargets(await hostBunSystem(), version);
  const program = join(moduleBunRoot(homeDirectory), version, "node_modules", "@oven", `bun-${target.name}`, "bin", target.executable);
  const log = join(homeDirectory, `bun-${version}.log`);
  await mkdir(dirname(program), { recursive: true });
  await writeFile(program, [
    "#!/bin/sh",
    `printf '%s|%s\\n' "\${${CLI_BUN_ENV}:-}" "$*" >> '${log}'`,
    `if [ "$1" = "--version" ]; then echo '${version}'; exit 0; fi`,
    'case "${LAZURIO_FIXTURE_CHILD:-}" in',
    '  sleep) echo "child $$"; exec sleep 30 ;;',
    "  cat) exec cat ;;",
    "esac",
    `exec '${process.execPath}' "$@"`,
    "",
  ].join("\n"), { mode: 0o755 });
  await chmod(program, 0o755);
  return { program, calls: async () => (await readFile(log, "utf8").catch(() => "")).split("\n").filter(Boolean) };
}

// A process of the real launcher with seams of its own: a CLI that believes
// it runs on `running`, or one whose Bun's installer meets no registry.
async function harness({ root, packageRoot: copy }, { running = null, offline = false } = {}) {
  const url = (path) => JSON.stringify(pathToFileURL(path).href);
  const path = join(root, `harness-${running ?? "real"}-${offline ? "offline" : "online"}.mjs`);
  await writeFile(path, [
    `import { runLazurioCli } from ${url(join(copy, "runtime", "cli-runtime-lib.mjs"))};`,
    `import { createModuleBunResolver } from ${url(join(copy, "runtime", "bun-runtime-lib.mjs"))};`,
    "await runLazurioCli({",
    "  argv: Bun.argv.slice(2),",
    `  packageRoot: ${JSON.stringify(copy)},`,
    `  mainPath: ${JSON.stringify(join(copy, "cli-main.mjs"))},`,
    `  loadMain: async () => (await import(${url(join(copy, "cli-main.mjs"))})).main,`,
    ...(running ? [`  runningVersion: ${JSON.stringify(running)},`] : []),
    ...(offline ? [
      "  resolveBun: ({ pin, packageRoot, execPath, env }) => createModuleBunResolver({",
      "    userBun: execPath,",
      "    env,",
      "    install: async () => ({ kind: \"refused\", reason: \"runtime-unavailable\" }),",
      "    freeBytes: async () => Number.POSITIVE_INFINITY,",
      "  })({ packageManager: `bun@${pin}`, owner: packageRoot }),",
    ] : []),
    "});",
    "",
  ].join("\n"));
  return path;
}

function run(command, { cwd, homeDirectory, env = {} }) {
  const result = Bun.spawnSync(command, {
    cwd,
    env: { ...process.env, HOME: homeDirectory, USERPROFILE: homeDirectory, LOCALAPPDATA: join(homeDirectory, "AppData", "Local"), ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: result.exitCode, signal: result.signalCode ?? null, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

test("cli.mjs on its exact Bun gives the CLI's own bytes and exit code", async () => {
  const copy = await lazurioCopy(process.versions.bun);
  const homeDirectory = await home();
  const direct = run([process.execPath, join(copy.packageRoot, "cli-main.mjs"), "--help"], { cwd: copy.root, homeDirectory });
  const launched = run([process.execPath, join(copy.packageRoot, "cli.mjs"), "--help"], { cwd: copy.root, homeDirectory });

  expect(direct.code).toBe(0);
  expect(direct.stdout).toContain("Lazurio CLI v0");
  expect(launched).toEqual(direct);
}, platformTestTimeout(20_000));

test("re-executed, the CLI's stdout, stderr and exit codes 0, 1, 2 and 3 pass through unchanged", async () => {
  const copy = await lazurioCopy(process.versions.bun);
  const homeDirectory = await home();
  const emptyOrganization = join(copy.root, "empty-organization");
  await mkdir(emptyOrganization, { recursive: true });
  // The launcher believes it runs on another Bun; the resolver then hands out
  // the user's Bun, which is the pin of this copy.
  const launcher = await harness(copy, { running: "0.0.1" });
  for (const [args, code] of [
    [["--help"], 0],
    [["organization", "check", emptyOrganization], 1],
    [["no-such-command"], 2],
    [["module", "no-such-action"], 3],
  ]) {
    const direct = run([process.execPath, join(copy.packageRoot, "cli-main.mjs"), ...args], { cwd: copy.root, homeDirectory });
    const relaunched = run([process.execPath, launcher, ...args], { cwd: copy.root, homeDirectory });
    expect(direct.code).toBe(code);
    expect(relaunched).toEqual(direct);
  }
}, platformTestTimeout(60_000));

posixTest("through the runtime cache the launcher runs its exact Bun on cli-main.mjs with LAZURIO_CLI_BUN, and that CLI refuses a Bun that is not the pin", async () => {
  const copy = await lazurioCopy("9.9.9");
  const homeDirectory = await home();
  const fake = await cachedFakeBun({ homeDirectory, version: "9.9.9" });
  const result = run([process.execPath, join(copy.packageRoot, "cli.mjs"), "--help"], { cwd: copy.root, homeDirectory });

  // The fake answers 9.9.9 but runs the real Bun, so the re-executed CLI stops
  // instead of running, or re-executing, on it.
  expect(result.code).toBe(2);
  expect(result.stdout).toBe("");
  expect(result.stderr.trim().split("\n")).toHaveLength(1);
  expect(result.stderr).toContain("9.9.9");
  expect(result.stderr).toContain(process.versions.bun);
  expect(await fake.calls()).toEqual([
    "|--version",
    `9.9.9|${join(copy.packageRoot, "cli-main.mjs")} --help`,
  ]);
}, platformTestTimeout(20_000));

posixTest("an inherited LAZURIO_CLI_BUN does not stop the launcher: it resolves and re-executes the CLI", async () => {
  const copy = await lazurioCopy("9.9.9");
  const homeDirectory = await home();
  const fake = await cachedFakeBun({ homeDirectory, version: "9.9.9" });
  run([process.execPath, join(copy.packageRoot, "cli.mjs"), "--help"], {
    cwd: copy.root,
    homeDirectory,
    env: { [CLI_BUN_ENV]: "9.9.9" },
  });

  // The fake answers its version and then runs the real Bun, so the
  // re-executed CLI refuses by itself; what matters here is that the
  // launcher got that far.
  expect((await fake.calls()).at(-1)).toBe(`9.9.9|${join(copy.packageRoot, "cli-main.mjs")} --help`);
}, platformTestTimeout(20_000));

for (const signal of ["SIGINT", "SIGTERM"]) {
  posixTest(`${signal} sent to the launcher ends the re-executed CLI, and the launcher ends with ${signal}`, async () => {
    const copy = await lazurioCopy("9.9.9");
    const homeDirectory = await home();
    await cachedFakeBun({ homeDirectory, version: "9.9.9" });
    const launcher = Bun.spawn([process.execPath, join(copy.packageRoot, "cli.mjs"), "launchpad", "serve"], {
      cwd: copy.root,
      env: { ...process.env, HOME: homeDirectory, LAZURIO_FIXTURE_CHILD: "sleep" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const reader = launcher.stdout.getReader();
    let text = "";
    while (!/child \d+\n/u.test(text)) {
      const { value, done } = await reader.read();
      if (done) break;
      text += new TextDecoder().decode(value);
    }
    const childPid = Number(/child (\d+)/u.exec(text)?.[1]);
    expect(childPid).toBeGreaterThan(0);

    launcher.kill(signal);
    await launcher.exited;
    expect(launcher.signalCode).toBe(signal);
    expect(await new Response(launcher.stderr).text()).toBe("");
    let childAlive = true;
    try {
      process.kill(childPid, 0);
    } catch {
      childAlive = false;
    }
    expect(childAlive).toBe(false);
  }, platformTestTimeout(20_000));
}

posixTest("the re-executed CLI reads the launcher's stdin", async () => {
  const copy = await lazurioCopy("9.9.9");
  const homeDirectory = await home();
  await cachedFakeBun({ homeDirectory, version: "9.9.9" });
  const launcher = Bun.spawn([process.execPath, join(copy.packageRoot, "cli.mjs"), "organization", "install", "ExampleOrg"], {
    cwd: copy.root,
    env: { ...process.env, HOME: homeDirectory, LAZURIO_FIXTURE_CHILD: "cat" },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  launcher.stdin.write("an answer typed at a prompt\n");
  await launcher.stdin.end();

  expect(await launcher.exited).toBe(0);
  expect(await new Response(launcher.stdout).text()).toBe("an answer typed at a prompt\n");
}, platformTestTimeout(20_000));

test("offline, the CLI runs on the user's Bun with one line per invocation, and its doctor fails platform.cli_runtime", async () => {
  const copy = await lazurioCopy("9.9.9");
  const launcher = await harness(copy, { offline: true });
  const line = cliRuntimeFallbackLine({ pin: "9.9.9", running: process.versions.bun });

  // A command that logs several lines of its own.
  const homeDirectory = await home();
  const direct = run([process.execPath, join(copy.packageRoot, "cli-main.mjs"), "no-such-command"], { cwd: copy.root, homeDirectory });
  const offline = run([process.execPath, launcher, "no-such-command"], { cwd: copy.root, homeDirectory });
  expect(direct.stderr.split("\n").length).toBeGreaterThan(3);
  expect(offline.code).toBe(direct.code);
  expect(offline.stdout).toBe(direct.stdout);
  expect(offline.stderr).toBe(`${line}\n${direct.stderr}`);
  expect(offline.stderr.split("\n").filter((entry) => entry === line)).toHaveLength(1);

  // The doctor of that CLI names the degraded mode and its repair.
  const fixture = join(copy.root, "doctor-root");
  await mkdir(join(fixture, "organizations"), { recursive: true });
  await writeFile(join(fixture, "launchpad.gen3.json"), `${JSON.stringify({
    launchpad_root: { slug: "test-root", display_name: "Test Root", root_role: "companies-root" },
  }, null, 2)}\n`);
  const doctor = run([process.execPath, launcher, "doctor", "--json", "--root", fixture], { cwd: copy.root, homeDirectory: await home() });
  expect(doctor.stderr.split("\n").filter((entry) => entry === line)).toHaveLength(1);
  const report = JSON.parse(doctor.stdout);
  const check = report.checks.find((entry) => entry.id === "platform.cli_runtime");
  expect(check).toMatchObject({ status: "fail", severity: "required" });
  expect(check.message).toContain("lazurio update");
  expect(check.details).toEqual(expect.arrayContaining([
    `running: ${process.versions.bun}`,
    "required: 9.9.9",
    "remedy_command: lazurio update",
  ]));
}, platformTestTimeout(60_000));
