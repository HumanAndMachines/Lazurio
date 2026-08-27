import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, lstat, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { LAZURIO_LAUNCHPAD_NAME } from "./launchpad-identity-lib.mjs";
import {
  launchLazurioLaunchpadServer,
  prepareLaunchpadServerExecutable,
} from "./server-launcher-lib.mjs";

const tempRoots = [];
const macTest = process.platform === "darwin" ? test : test.skip;

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("all supported Launchpad package entrypoints use the process-identity launcher", async () => {
  const packageJson = await Bun.file(new URL("../package.json", import.meta.url)).json();
  expect({
    dev: packageJson.scripts.dev,
    launch: packageJson.scripts.launch,
    serve: packageJson.scripts.serve,
  }).toEqual({
    dev: "bun src/server-launcher.mjs",
    launch: "bun src/server-launcher.mjs --open",
    serve: "bun src/server-launcher.mjs --reuse",
  });
});

test("non-macOS Launchpad startup preserves the canonical Bun executable", async () => {
  const prepared = await prepareLaunchpadServerExecutable({
    platform: "linux",
    executablePath: "/opt/bun/bin/bun",
  });

  expect(prepared).toMatchObject({
    executablePath: "/opt/bun/bin/bun",
    canonicalExecutablePath: "/opt/bun/bin/bun",
    branded: false,
    warning: null,
  });
  await prepared.cleanup();
});

test("macOS Launchpad startup creates an exact temporary Bun hardlink with the product name", async () => {
  const root = await temporaryRoot("lazurio-launchpad-process-name-");
  const executable = join(root, "bun-runtime");
  await writeFile(executable, "fixture Bun bytes\n");
  await chmod(executable, 0o755);

  const prepared = await prepareLaunchpadServerExecutable({
    platform: "darwin",
    executablePath: executable,
    temporaryRoot: root,
  });
  const [sourceStat, namedStat] = await Promise.all([
    lstat(executable),
    lstat(prepared.executablePath),
  ]);

  expect(prepared.branded).toBe(true);
  expect(prepared.warning).toBeNull();
  expect(basename(prepared.executablePath)).toBe(LAZURIO_LAUNCHPAD_NAME);
  expect({ dev: namedStat.dev, ino: namedStat.ino }).toEqual({
    dev: sourceStat.dev,
    ino: sourceStat.ino,
  });
  expect(existsSync(prepared.temporaryDirectory)).toBe(true);

  await prepared.cleanup();
  await prepared.cleanup();
  expect(existsSync(prepared.temporaryDirectory)).toBe(false);
});

test("macOS process-name failure falls back to Bun and removes partial temporary state", async () => {
  const root = await temporaryRoot("lazurio-launchpad-process-fallback-");
  const executable = join(root, "bun-runtime");
  await writeFile(executable, "fixture Bun bytes\n");
  const linkError = Object.assign(new Error("different filesystem"), { code: "EXDEV" });

  const prepared = await prepareLaunchpadServerExecutable({
    platform: "darwin",
    executablePath: executable,
    temporaryRoot: root,
    createHardLink: async () => {
      throw linkError;
    },
  });

  expect(prepared).toMatchObject({
    executablePath: executable,
    canonicalExecutablePath: executable,
    branded: false,
  });
  expect(prepared.warning).toContain("Lazurio Launchpad");
  expect(prepared.warning).toContain("EXDEV");
  expect(await readdir(root)).toEqual(["bun-runtime"]);
});

test("server launcher preserves arguments, forwards signals, relays exit status and cleans the alias", async () => {
  let finishChild;
  const childExit = new Promise((resolve) => {
    finishChild = resolve;
  });
  const calls = [];
  const handlers = new Map();
  let cleaned = 0;
  const processObject = {
    on(signal, handler) {
      handlers.set(signal, handler);
    },
    off(signal, handler) {
      if (handlers.get(signal) === handler) handlers.delete(signal);
    },
  };

  const launch = launchLazurioLaunchpadServer({
    args: ["--root", "/workspace root", "--reuse"],
    serverPath: "/runtime/launchpad/src/server.mjs",
    platform: "darwin",
    executablePath: "/runtime/bun",
    environment: { FIXTURE: "1" },
    cwd: "/runtime/launchpad",
    prepareExecutable: async () => ({
      executablePath: "/tmp/Lazurio Launchpad",
      canonicalExecutablePath: "/runtime/bun",
      branded: true,
      warning: null,
      cleanup: async () => {
        cleaned += 1;
      },
    }),
    spawnProcess(command, options) {
      calls.push(["spawn", command, options]);
      return {
        exited: childExit,
        kill(signal) {
          calls.push(["kill", signal]);
        },
      };
    },
    processObject,
  });

  await Promise.resolve();
  handlers.get("SIGTERM")();
  finishChild(23);

  expect(await launch).toBe(23);
  expect(calls).toEqual([
    [
      "spawn",
      [
        "/tmp/Lazurio Launchpad",
        "/runtime/launchpad/src/server.mjs",
        "--root",
        "/workspace root",
        "--reuse",
      ],
      {
        cwd: "/runtime/launchpad",
        env: { FIXTURE: "1" },
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
      },
    ],
    ["kill", "SIGTERM"],
  ]);
  expect(handlers.size).toBe(0);
  expect(cleaned).toBe(1);
});

macTest("macOS lsof reports the exact Lazurio Launchpad listener command", async () => {
  const root = await temporaryRoot("lazurio-launchpad-lsof-");
  const fixture = join(root, "listener.mjs");
  await writeFile(fixture, `
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch() { return new Response("ok"); },
});
console.log(server.port);
process.on("SIGTERM", async () => {
  await server.stop(true);
  process.exit(0);
});
setInterval(() => {}, 2_147_483_647);
`);
  const prepared = await prepareLaunchpadServerExecutable({
    platform: "darwin",
    executablePath: process.execPath,
    temporaryRoot: root,
  });
  let child = null;
  try {
    child = Bun.spawn([prepared.executablePath, fixture], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const port = Number(await firstOutputLine(child.stdout));
    expect(port).toBeGreaterThan(0);
    const lsof = Bun.spawnSync([
      Bun.which("lsof") ?? "/usr/sbin/lsof",
      `-iTCP:${port}`,
      "-sTCP:LISTEN",
      "-P",
      "-n",
      "-F",
      "pcn",
    ]);
    expect(lsof.exitCode).toBe(0);
    expect(lsof.stdout.toString()).toContain(`c${LAZURIO_LAUNCHPAD_NAME}\n`);
  } finally {
    child?.kill("SIGTERM");
    await child?.exited;
    await prepared.cleanup();
  }
}, 10_000);

async function temporaryRoot(prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

async function firstOutputLine(stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let output = "";
  try {
    while (!output.includes("\n")) {
      const { done, value } = await reader.read();
      if (done) break;
      output += decoder.decode(value, { stream: true });
    }
    output += decoder.decode();
    return output.split("\n", 1)[0].trim();
  } finally {
    reader.releaseLock();
  }
}
