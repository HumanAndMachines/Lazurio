import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createModuleBunResolver, moduleBunRoot } from "../../lazurio/runtime/bun-runtime-lib.mjs";
import { createRuntimeManager, RuntimeActionError } from "../../lazurio/runtime/runtime-lib.mjs";

// The Bun an App pins is that App's runtime (decision 0171, addendum of
// 2026-10-24), on the real consumer: the root runtime manager behind the
// Launchpad and `lazurio module start`, with real processes. Bun's npm
// distribution is a fake that lays out, for each version, a program named bun
// that logs every call, prints the version for --version and runs the real Bun
// otherwise; it exports LAZURIO_FIXTURE_BUN, so whatever an App's process
// reports, it ran under that version. No network.
const supported = ["darwin", "linux"].includes(process.platform);
const posixTest = test.skipIf(!supported);
const linuxArm = Object.freeze({ platform: "linux", arch: "arm64", libc: "glibc", avx2: null });
// The user's PATH, with their own Bun on it.
const userBunDirectory = dirname(process.execPath);
const systemPath = [userBunDirectory, "/usr/bin", "/bin"].join(":");

function distribution(directory) {
  const offline = new Set();
  const fetched = [];
  // A version's fetch can be held open: the test changes the package
  // meanwhile, then lets the fetch finish.
  const gates = new Map();
  const entered = new Set();
  const install = async (input) => {
    if (gates.has(input.version)) {
      entered.add(input.version);
      await gates.get(input.version);
    }
    if (offline.has(input.version)) return { kind: "refused", reason: "runtime-unavailable" };
    fetched.push(`${input.packageName}@${input.version}`);
    const program = join(input.directory, "node_modules", input.packageName, "bin", "bun");
    await mkdir(dirname(program), { recursive: true });
    await writeFile(program, [
      "#!/bin/sh",
      `printf '%s\\n' "$*" >> '${join(directory, `bun-${input.version}.log`)}'`,
      `if [ "$1" = "--version" ]; then echo '${input.version}'; exit 0; fi`,
      `LAZURIO_FIXTURE_BUN='${input.version}'; export LAZURIO_FIXTURE_BUN`,
      `exec '${process.execPath}' "$@"`,
      "",
    ].join("\n"), { mode: 0o755 });
    await chmod(program, 0o755);
    return { kind: "installed" };
  };
  return {
    install,
    offline,
    fetched,
    gates,
    entered,
    // What that version's program ran, its version checks left out.
    calls: async (version) => (await readFile(join(directory, `bun-${version}.log`), "utf8").catch(() => ""))
      .split("\n")
      .filter((line) => line !== "" && line !== "--version"),
  };
}

// An App's own process reports the Bun it runs under and its PATH.
const reporterSource = [
  "Bun.serve({",
  "  hostname: process.env.LAZURIO_RUNTIME_HOST,",
  "  port: Number(process.env.LAZURIO_RUNTIME_PORT),",
  "  fetch(request) {",
  "    if (new URL(request.url).pathname === '/health') return Response.json({ status: 'ok' });",
  "    return Response.json({ bun: process.env.LAZURIO_FIXTURE_BUN ?? null, path: process.env.PATH ?? '' });",
  "  },",
  "});",
  "setInterval(() => {}, 2147483647);",
  "",
].join("\n");

// The install every App needs before it starts: whatever Bun the manager runs
// it with, it records that Bun's version beside the dependency it lays out.
const installScript = [
  'const { mkdir, writeFile } = await import("node:fs/promises")',
  'await mkdir("node_modules/fixture", { recursive: true })',
  'await writeFile("node_modules/fixture/package.json", JSON.stringify({ name: "fixture", version: "1.0.0" }))',
  'await writeFile("node_modules/fixture/installed-by.txt", process.env.LAZURIO_FIXTURE_BUN ?? "user")',
].join("; ");

async function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

// A Lazurio root with one Organization whose Modules each hold one App with
// its own pin, a dependency (to install, or already installed) and a locked
// package.
async function world(name, apps) {
  const root = await realpath(await mkdtemp(join(tmpdir(), `lazurio-module-bun-${name}-`)));
  const home = join(root, "home");
  const companyRoot = join(root, "organizations", "TestCompany");
  for (const directory of [home, join(root, "launchpad"), join(root, "guide"), join(root, "manual"), join(companyRoot, "manual"), join(companyRoot, "company", "colleagues")]) {
    await mkdir(directory, { recursive: true });
  }
  await writeJson(join(root, "launchpad.gen3.json"), {
    launchpad_root: { slug: "test-companies", display_name: "Test Companies", root_role: "companies-root" },
  });
  await writeJson(join(companyRoot, "company.gen3.json"), {
    organization_generation: "gen3",
    company: { slug: "test-company", display_name: "Test Company", github_org: "TestCompany" },
  });
  await writeJson(join(companyRoot, "modules.manifest.json"), {
    company: "test-company",
    github_org: "TestCompany",
    module_slots: apps.map(({ id }) => ({
      path: `modules/${id}`,
      slug: id,
      git: { url: `git@github.com:TestCompany/${id}.git`, branch: "main" },
    })),
  });
  for (const file of ["TODO.tasks.json", "DONE.tasks.json", "ISSUES.open.json"]) {
    await writeJson(join(companyRoot, file), {});
  }
  const ports = {};
  for (const { id, pin, installed = false } of apps) {
    ports[id] = await findFreePort();
    const appRoot = join(companyRoot, "modules", id, "app", "v1");
    await mkdir(appRoot, { recursive: true });
    await writeJson(join(appRoot, "package.json"), {
      name: `test-company-${id}-v1`,
      private: true,
      type: "module",
      packageManager: pin,
      dependencies: { fixture: "1.0.0" },
      scripts: { dev: "bun server.mjs" },
      companyascode: {
        app: {
          schema_version: "companyascode.launchpad_app.v1",
          id: `test-company-${id}-v1`,
          title: `App ${id}`,
          company: "test-company",
          module: id,
          surface: "internal",
          port: ports[id],
          host: "127.0.0.1",
          health_path: "/health",
          dev_script: "dev",
          tags: ["test"],
        },
      },
    });
    await writeFile(join(appRoot, "bun.lock"), "# fixture\n", "utf8");
    await writeFile(join(appRoot, "server.mjs"), reporterSource, "utf8");
    if (installed) {
      await mkdir(join(appRoot, "node_modules", "fixture"), { recursive: true });
      await writeJson(join(appRoot, "node_modules", "fixture", "package.json"), { name: "fixture", version: "1.0.0" });
    }
  }
  const npm = distribution(root);
  const installs = [];
  const runtime = createRuntimeManager({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    instanceId: `module-bun-${name}`,
    // A Launchpad's own clean environment, nothing of the test runner's: under
    // an outer `bun run` (as in `bun run check`) a nested `bun run` puts no
    // Bun of its own on PATH, and the App's scripts find Bun on PATH alone.
    systemEnvironment: {
      HOME: home,
      PATH: systemPath,
      ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
    },
    bunExecutable: process.execPath,
    resolveModuleBunFn: createModuleBunResolver({
      home,
      userBun: process.execPath,
      path: systemPath,
      install: npm.install,
      system: async () => linuxArm,
      freeBytes: async () => 10 * 1024 ** 3,
    }),
    // The install the manager asks for runs with the Bun and PATH it chose;
    // only its work is the fixture's, so no registry is needed.
    spawnProcess(command, options) {
      if (command[1] !== "install") return Bun.spawn(command, options);
      installs.push({ executable: command[0], args: command.slice(1), path: options.env.PATH });
      return Bun.spawn([command[0], "-e", installScript], options);
    },
  });
  return {
    root,
    home,
    npm,
    installs,
    runtime,
    appId: (id) => `test-company-${id}-v1`,
    appRoot: (id) => join(companyRoot, "modules", id, "app", "v1"),
    packagePath: (id) => `organizations/TestCompany/modules/${id}/app/v1/package.json`,
    report: (id) => fetch(`http://127.0.0.1:${ports[id]}/report`)
      .then((response) => (response.ok ? response.json() : null))
      .catch(() => null),
    async close() {
      await runtime.shutdown().catch(() => {});
      await rm(root, { recursive: true, force: true });
    },
  };
}

async function until(read, done, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (done(value) || Date.now() > deadline) return value;
    await Bun.sleep(50);
  }
}

const runtimeBin = (home, version) =>
  join(moduleBunRoot(home), version, "node_modules", "@oven", "bun-linux-aarch64", "bin");

posixTest("Apps with different pins run side by side through the root runtime manager, each installed and started with its own Bun first on its PATH; an App whose pin is the user's Bun downloads nothing and keeps its environment", async () => {
  const w = await world("side-by-side", [
    { id: "older", pin: "bun@1.4.98" },
    { id: "newer", pin: "bun@1.4.99" },
    { id: "same", pin: `bun@${Bun.version}` },
  ]);
  try {
    for (const id of ["older", "newer", "same"]) {
      const opened = await w.runtime.open(w.appId(id));
      expect(opened.status).toBe("healthy");
      expect(opened.steps.map((step) => step.step)).toEqual(["install", "start"]);
    }
    const reports = Object.fromEntries(await Promise.all(["older", "newer", "same"].map(async (id) => [
      id,
      await until(() => w.report(id), (value) => value !== null),
    ])));
    expect(reports.older.bun).toBe("1.4.98");
    expect(reports.newer.bun).toBe("1.4.99");
    expect(reports.same.bun).toBeNull();
    // Its own version's directory ahead of the user's PATH and their Bun, so
    // a nested bun, bun x or bunx is that version too.
    for (const [id, version] of [["older", "1.4.98"], ["newer", "1.4.99"]]) {
      const path = reports[id].path.split(":");
      const own = path.indexOf(runtimeBin(w.home, version));
      expect(own).toBeGreaterThanOrEqual(0);
      expect(own).toBeLessThan(path.indexOf(userBunDirectory));
      expect(own).toBeLessThan(path.indexOf("/usr/bin"));
    }
    expect(reports.same.path.split(":").some((entry) => entry.startsWith(moduleBunRoot(w.home)))).toBe(false);
    // The install ran with the same Bun as the App: the pinned program with
    // its directory first, or the user's Bun with the PATH exactly as it was.
    expect(w.installs).toEqual([
      { executable: join(runtimeBin(w.home, "1.4.98"), "bun"), args: ["install", "--frozen-lockfile"], path: `${runtimeBin(w.home, "1.4.98")}:${systemPath}` },
      { executable: join(runtimeBin(w.home, "1.4.99"), "bun"), args: ["install", "--frozen-lockfile"], path: `${runtimeBin(w.home, "1.4.99")}:${systemPath}` },
      { executable: process.execPath, args: ["install", "--frozen-lockfile"], path: systemPath },
    ]);
    for (const [id, installedBy] of [["older", "1.4.98"], ["newer", "1.4.99"], ["same", "user"]]) {
      expect(await readFile(join(w.appRoot(id), "node_modules", "fixture", "installed-by.txt"), "utf8")).toBe(installedBy);
    }
    expect(await w.npm.calls("1.4.99")).toEqual([`-e ${installScript}`, "run dev"]);
    // Each pinned version fetched once, although its install and its start
    // both resolved it; nothing for the App on the user's Bun.
    expect([...w.npm.fetched].sort()).toEqual(["@oven/bun-linux-aarch64@1.4.98", "@oven/bun-linux-aarch64@1.4.99"]);
    expect((await readdir(moduleBunRoot(w.home))).sort()).toEqual(["1.4.98", "1.4.99"]);
    // Stopped and started again: from the cache, nothing downloaded.
    await w.runtime.stop(w.appId("newer"));
    expect(await w.report("newer")).toBeNull();
    await w.runtime.start(w.appId("newer"));
    expect((await until(() => w.report("newer"), (value) => value !== null)).bun).toBe("1.4.99");
    expect(w.npm.fetched).toHaveLength(2);
  } finally {
    await w.close();
  }
}, 60_000);

posixTest("a pinned version that cannot be had refuses Start and Install with its reason and the package that pins it, stops, starts and keeps nothing, and the same Start runs it once it can be fetched", async () => {
  const w = await world("refused", [
    // Ready to start: what decides is its Bun alone.
    { id: "offline", pin: "bun@1.4.97", installed: true },
    { id: "moving", pin: "bun@1.4.96" },
  ]);
  try {
    w.npm.offline.add("1.4.97");
    const refusal = {
      status: 409,
      code: "app_runtime_refused",
      metadata: { failure_kind: "runtime-unavailable", package_path: w.packagePath("offline") },
    };
    const started = await w.runtime.start(w.appId("offline")).catch((error) => error);
    expect(started).toBeInstanceOf(RuntimeActionError);
    expect(started).toMatchObject(refusal);
    expect(started.message).toContain(w.packagePath("offline"));
    expect(started.message).toContain("registr npm neodpověděl");
    await expect(w.runtime.install(w.appId("offline"))).rejects.toMatchObject(refusal);
    await expect(w.runtime.open(w.appId("offline"))).rejects.toMatchObject(refusal);
    // Nothing ran with any Bun, nothing was installed or started, and the
    // runtime cache keeps nothing of the failed fetch.
    expect(w.installs).toEqual([]);
    expect(await w.npm.calls("1.4.97")).toEqual([]);
    expect(existsSync(join(w.appRoot("offline"), "node_modules", "fixture", "installed-by.txt"))).toBe(false);
    expect((await w.runtime.health(w.appId("offline"))).status).toBe("stopped");
    expect(await w.report("offline")).toBeNull();
    expect(await readdir(moduleBunRoot(w.home))).toEqual([]);
    // Once the registry answers, the same Start fetches and runs it.
    w.npm.offline.delete("1.4.97");
    expect((await w.runtime.open(w.appId("offline"))).status).toBe("healthy");
    expect((await until(() => w.report("offline"), (value) => value !== null)).bun).toBe("1.4.97");

    // A running App whose pin moves to a version that cannot be had keeps
    // running: the refusal of its Install comes before it is stopped.
    expect((await w.runtime.open(w.appId("moving"))).status).toBe("healthy");
    const packagePath = join(w.appRoot("moving"), "package.json");
    const manifest = JSON.parse(await readFile(packagePath, "utf8"));
    await writeJson(packagePath, { ...manifest, packageManager: "bun@1.4.95" });
    w.npm.offline.add("1.4.95");
    await expect(w.runtime.install(w.appId("moving"))).rejects.toMatchObject({
      code: "app_runtime_refused",
      metadata: { failure_kind: "runtime-unavailable", package_path: w.packagePath("moving") },
    });
    expect((await w.report("moving"))?.bun).toBe("1.4.96");
    expect((await w.runtime.health(w.appId("moving"))).managed).toBe(true);
    expect((await readdir(moduleBunRoot(w.home))).sort()).toEqual(["1.4.96", "1.4.97"]);
  } finally {
    await w.close();
  }
}, 60_000);

posixTest("a pin that moves while its Bun is fetched refuses that Start and that Install, runs nothing with the earlier pin, and the next Start runs the new pin", async () => {
  const w = await world("moved-during-fetch", [
    { id: "starting", pin: "bun@1.4.94", installed: true },
    { id: "installing", pin: "bun@1.4.92" },
  ]);
  try {
    const hold = (version) => {
      let release = () => {};
      w.npm.gates.set(version, new Promise((resolve) => { release = resolve; }));
      return () => release();
    };
    const movePin = async (id, pin) => {
      const packagePath = join(w.appRoot(id), "package.json");
      const manifest = JSON.parse(await readFile(packagePath, "utf8"));
      await writeJson(packagePath, { ...manifest, packageManager: pin });
    };
    const changed = (id) => ({
      status: 409,
      code: "app_runtime_changed",
      metadata: { failure_kind: "app_runtime_changed", package_path: w.packagePath(id) },
    });

    // Start: the pin moves from 1.4.94 to 1.4.93 while 1.4.94 is fetched.
    const releaseStart = hold("1.4.94");
    const starting = w.runtime.start(w.appId("starting")).catch((error) => error);
    await until(() => w.npm.entered.has("1.4.94"), Boolean, 10_000);
    await movePin("starting", "bun@1.4.93");
    releaseStart();
    expect(await starting).toMatchObject(changed("starting"));
    expect(await w.npm.calls("1.4.94")).toEqual([]);
    expect((await w.runtime.health(w.appId("starting"))).status).toBe("stopped");
    expect(await w.report("starting")).toBeNull();
    // The next Start runs the new pin.
    await w.runtime.start(w.appId("starting"));
    expect((await until(() => w.report("starting"), (value) => value !== null)).bun).toBe("1.4.93");

    // Install: the pin moves from 1.4.92 to 1.4.91 while 1.4.92 is fetched.
    const releaseInstall = hold("1.4.92");
    const installing = w.runtime.install(w.appId("installing")).catch((error) => error);
    await until(() => w.npm.entered.has("1.4.92"), Boolean, 10_000);
    await movePin("installing", "bun@1.4.91");
    releaseInstall();
    expect(await installing).toMatchObject(changed("installing"));
    expect(w.installs.filter((entry) => entry.executable.includes("1.4.92"))).toEqual([]);
    expect(existsSync(join(w.appRoot("installing"), "node_modules", "fixture", "installed-by.txt"))).toBe(false);
  } finally {
    await w.close();
  }
}, 60_000);
