import { afterAll, beforeAll, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  realpath,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  BunRuntimeRefused,
  bunInstaller,
  bunPublishedCheckTimeoutMs,
  bunRuntimeRefusalMessage,
  bunTargets,
  bunVersionCached,
  bunVersionPublished,
  createModuleBunResolver,
  exactBunPin,
  moduleBunCacheBytes,
  moduleBunLocks,
  moduleBunRoot,
  runtimeFreeBytesMin,
  runtimeReasons,
  withModuleBun,
} from "../../lazurio/runtime/bun-runtime-lib.mjs";
import { acquireFileLock } from "../../lazurio/runtime/file-lock-lib.mjs";

// The Bun an App pins is that App's runtime (decision 0171, addendum of
// 2026-10-24; LazurioPlatform F62): the user's Bun when it is exactly that
// version, otherwise the runtime cache Lazurio shares with LazurioPlatform on
// the same machine, otherwise a verified fetch with Bun's own installer. No
// case here uses the network: an injected installer lays out the package Bun's
// installer would, and the real `bun add` runs only against a registry on the
// loopback interface. One opt-in case (LAZURIO_TEST_NETWORK=1) fetches a real
// Bun from npm.
const supported = ["darwin", "linux"].includes(process.platform);
const posixTest = test.skipIf(!supported);
let root = "";
beforeAll(async () => {
  if (!supported) return;
  root = await realpath(await mkdtemp(join(tmpdir(), "lazurio-bun-runtime-")));
});
afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

const plenty = async () => 10 * 1024 ** 3;
// A fixed system, so every machine resolves the same package names; the fake
// programs are shell scripts and run anywhere.
const linuxArm = Object.freeze({ platform: "linux", arch: "arm64", libc: "glibc", avx2: null });

async function place(name) {
  const directory = join(root, name);
  const home = join(directory, "home");
  const owner = join(directory, "module", "app", "v1");
  await mkdir(home, { recursive: true, mode: 0o700 });
  await mkdir(owner, { recursive: true });
  return { directory, home, owner, file: join(owner, "package.json") };
}

// A program named bun: `--version` prints `version`; anything else runs the
// real Bun with LAZURIO_FIXTURE_BUN naming the version, after logging its
// arguments when a log is given. `broken` cannot run at all (as a build for
// another CPU).
async function fakeBun(path, version, { mode = "runs", log = null } = {}) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    mode === "broken"
      ? "#!/bin/sh\nexit 132\n"
      : [
          "#!/bin/sh",
          ...(log ? [`printf '%s\\n' "$*" >> '${log}'`] : []),
          `if [ "$1" = "--version" ]; then echo '${version}'; exit 0; fi`,
          `LAZURIO_FIXTURE_BUN='${version}'; export LAZURIO_FIXTURE_BUN`,
          `exec '${process.execPath}' "$@"`,
          "",
        ].join("\n"),
    { mode: 0o755 },
  );
  await chmod(path, 0o755);
}

// Bun's installer as the resolver sees it: what it was asked for, whether its
// private directory was a project of its own when it ran, and the package it
// lays out (or the refusal it answers).
function fakeInstaller({ refuse, reports, gate, log } = {}) {
  const calls = [];
  const install = async (input) => {
    calls.push({ ...input, ownProject: existsSync(join(input.directory, "package.json")) });
    await gate?.();
    const refused = refuse?.(input);
    if (refused !== undefined) return { kind: "refused", reason: refused };
    const reported = reports?.(input) ?? input.version;
    await fakeBun(
      join(input.directory, "node_modules", input.packageName, "bin", "bun"),
      reported === "broken" ? input.version : reported,
      { mode: reported === "broken" ? "broken" : "runs", log: log?.(input) ?? null },
    );
    return { kind: "installed" };
  };
  return { install, calls };
}

async function refusalOf(pending) {
  const error = await pending.then(() => null, (caught) => caught);
  if (!(error instanceof BunRuntimeRefused)) throw new Error(`Expected a refusal, got ${String(error)}`);
  return { reason: error.reason, path: error.path };
}

const cachedExecutable = (home, version, target) =>
  join(moduleBunRoot(home), version, "node_modules", "@oven", `bun-${target}`, "bin", "bun");

const run = (executable, args, env = {}) =>
  execFileSync(executable, args, { encoding: "utf8", env: { PATH: "/usr/bin:/bin", ...env } }).trim();

function resolverFor(home, options = {}) {
  return createModuleBunResolver({
    home,
    userBun: process.execPath,
    path: "/usr/bin:/bin",
    system: async () => linuxArm,
    freeBytes: plenty,
    ...options,
  });
}

posixTest("an App whose pin is the user's Bun gets the user's Bun and nothing is downloaded; an App that pins none, or names Bun without an exact version, keeps the user's Bun", async () => {
  const { home, owner } = await place("same");
  const fake = fakeInstaller();
  const resolve = resolverFor(home, { install: fake.install });
  const user = { executable: process.execPath, binDir: null, source: "user" };
  expect(await resolve({ packageManager: `bun@${Bun.version}`, owner })).toEqual(user);
  expect(await resolve({ packageManager: null, owner })).toEqual(user);
  // Only an exact `bun@x.y.z` is a pin; what it reads from a package.json.
  expect(exactBunPin(`bun@${Bun.version}`)).toBe(`bun@${Bun.version}`);
  for (const declared of [undefined, null, 42, "", "bun", "bun@1.4", "bun@^1.4.3", "bun@latest", "bun@1.4.3+sha512.abc", " bun@1.4.3", "npm@10.0.0"]) {
    expect(exactBunPin(declared)).toBeNull();
  }
  expect(fake.calls).toEqual([]);
  expect(existsSync(moduleBunRoot(home))).toBe(false);
  // Its process environment stays exactly as it is.
  const env = { HOME: home, PATH: "/usr/bin:/bin", BUN_OPTIONS: "--x" };
  expect(withModuleBun(env, user)).toEqual(env);
});

posixTest("another version is fetched once with Bun's own installer into the runtime cache, verified by its version and kept: the next resolution downloads nothing", async () => {
  const { home, owner } = await place("fetch");
  const fake = fakeInstaller();
  const resolve = resolverFor(home, { install: fake.install });
  const executable = cachedExecutable(home, "1.4.99", "linux-aarch64");
  expect(await resolve({ packageManager: "bun@1.4.99", owner })).toEqual({
    executable,
    binDir: dirname(executable),
    source: "fetched",
  });
  expect(fake.calls).toHaveLength(1);
  const [call] = fake.calls;
  expect(call).toMatchObject({
    installer: process.execPath,
    packageName: "@oven/bun-linux-aarch64",
    version: "1.4.99",
    path: "/usr/bin:/bin",
    // Its own project: `bun add` never walks up to a package.json above.
    ownProject: true,
  });
  // A private directory beside the cache, with a home and a cache of its own:
  // nothing of the user's Bun or npm configuration or cache.
  const runtimes = moduleBunRoot(home);
  // The very cache LazurioPlatform keeps on the same machine.
  expect(runtimes).toBe(join(home, ".local/share/lazurio/runtimes/bun"));
  expect(moduleBunLocks(home)).toBe(join(home, ".local/share/lazurio/runtimes/bun.locks"));
  expect(dirname(call.directory)).toBe(runtimes);
  expect(basename(call.directory).startsWith(".tmp-")).toBe(true);
  expect(call.home.startsWith(`${call.directory}/`)).toBe(true);
  expect(call.cache.startsWith(`${call.directory}/`)).toBe(true);
  // Placed whole: only the version's directory, no private directory left, nor
  // its home and cache inside it.
  expect(await readdir(runtimes)).toEqual(["1.4.99"]);
  for (const leftover of ["home", "cache"]) {
    expect(existsSync(join(runtimes, "1.4.99", leftover))).toBe(false);
  }
  expect(run(executable, ["--version"])).toBe("1.4.99");
  // `bunx` beside it is the same program.
  expect(await readlink(join(dirname(executable), "bunx"))).toBe("bun");
  expect(await resolve({ packageManager: "bun@1.4.99", owner })).toEqual({
    executable,
    binDir: dirname(executable),
    source: "cache",
  });
  expect(fake.calls).toHaveLength(1);
  // Never written into the user's own tools.
  expect(existsSync(join(home, ".local/bin"))).toBe(false);
  expect(existsSync(join(home, ".bun"))).toBe(false);
});

posixTest("a version that cannot be had is a typed refusal named by the package that pins it, never another version, and nothing is kept: offline, an integrity failure, a wrong version reported, an unknown version, a full disk", async () => {
  const cases = [
    ["runtime-unavailable", { refuse: () => "runtime-unavailable" }],
    ["runtime-integrity-failed", { refuse: () => "runtime-integrity-failed" }],
    // Installed, but the program says another version.
    ["runtime-integrity-failed", { reports: () => "1.4.98" }],
    ["runtime-version-unknown", { refuse: () => "runtime-version-unknown" }],
    // Less than the minimum free: nothing is downloaded.
    ["runtime-disk-full", {}, runtimeFreeBytesMin - 1],
  ];
  for (const [index, [reason, options, free]] of cases.entries()) {
    const { home, owner, file } = await place(`refused-${index}`);
    const fake = fakeInstaller(options);
    const resolve = resolverFor(home, {
      install: fake.install,
      freeBytes: async () => free ?? 10 * 1024 ** 3,
    });
    const error = await resolve({ packageManager: "bun@1.4.99", owner }).catch((caught) => caught);
    expect(error).toBeInstanceOf(BunRuntimeRefused);
    expect({ reason: error.reason, path: error.path, version: error.version }).toEqual({ reason, path: file, version: "1.4.99" });
    // Its words name the package.json that pins it and the version.
    expect(error.message).toContain(file);
    expect(error.message).toContain("1.4.99");
    expect(fake.calls).toHaveLength(reason === "runtime-disk-full" ? 0 : 1);
    // Nothing kept and nothing left behind; the user's Bun is untouched.
    expect(await readdir(moduleBunRoot(home))).toEqual([]);
  }
});

test("the closed set of refusals is LazurioPlatform's, each with its own Czech words naming the package.json and the version", () => {
  expect([...runtimeReasons]).toEqual([
    "runtime-unavailable",
    "runtime-integrity-failed",
    "runtime-version-unknown",
    "runtime-disk-full",
    "runtime-unsupported-platform",
  ]);
  const file = "organizations/TestCompany/workspace/notes/app/v1/package.json";
  const messages = runtimeReasons.map((reason) =>
    bunRuntimeRefusalMessage(reason, { file, version: "1.4.99", cacheRoot: "~/.local/share/lazurio/runtimes/bun" }));
  expect(new Set(messages).size).toBe(runtimeReasons.length);
  for (const message of messages) {
    expect(message).toContain(file);
    expect(message).toContain("1.4.99");
  }
  // In the root's voice: what happened and what the user does next.
  expect(messages[0]).toContain("registr npm neodpověděl");
  expect(messages[0]).toContain("jinou verzí Bunu");
  expect(messages[2]).toContain("packageManager");
  expect(messages[3]).toContain("300 MB");
  expect(messages[3]).toContain("~/.local/share/lazurio/runtimes/bun");
  expect(() => bunRuntimeRefusalMessage("runtime-other", { file, version: "1.4.99" })).toThrow();
});

test("the package of Bun's npm distribution for each system, the baseline build for an x64 CPU without AVX2, and no package for every other system", () => {
  const system = (overrides) => ({ platform: "linux", arch: "x64", libc: "glibc", avx2: null, ...overrides });
  const bun = (name) => ({ name, executable: "bun" });
  const exe = (name) => ({ name, executable: "bun.exe" });
  expect(bunTargets(system({ platform: "darwin", arch: "arm64", libc: null }), "1.4.3")).toEqual([bun("darwin-aarch64")]);
  // Elsewhere than Linux the plain build first, its baseline when it does not run.
  expect(bunTargets(system({ platform: "darwin", libc: null }), "1.4.3")).toEqual([bun("darwin-x64"), bun("darwin-x64-baseline")]);
  // On Linux /proc/cpuinfo decides up front; unreadable, as elsewhere.
  expect(bunTargets(system({ avx2: true }), "1.4.3")).toEqual([bun("linux-x64")]);
  expect(bunTargets(system({ avx2: false }), "1.4.3")).toEqual([bun("linux-x64-baseline")]);
  expect(bunTargets(system({}), "1.4.3")).toEqual([bun("linux-x64"), bun("linux-x64-baseline")]);
  expect(bunTargets(system({ arch: "arm64" }), "1.4.3")).toEqual([bun("linux-aarch64")]);
  expect(bunTargets(system({ platform: "win32", libc: null }), "1.4.3")).toEqual([exe("windows-x64"), exe("windows-x64-baseline")]);
  expect(bunTargets(system({ platform: "win32", arch: "arm64", libc: null }), "1.3.10")).toEqual([exe("windows-aarch64")]);
  // Windows on ARM from Bun 1.3.10 only; Linux with musl, FreeBSD and every
  // other system are refused for now.
  for (const [overrides, version] of [
    [{ platform: "win32", arch: "arm64", libc: null }, "1.3.9"],
    [{ libc: "musl" }, "1.4.3"],
    [{ arch: "arm64", libc: "musl" }, "1.4.3"],
    [{ platform: "freebsd", libc: null }, "1.4.3"],
    [{ arch: "ia32" }, "1.4.3"],
  ]) {
    expect(bunTargets(system(overrides), version)).toBeNull();
  }
});

test("on Windows the runtime cache lives in the user's LocalAppData, and the App's Path keeps its own key and separator", () => {
  expect(moduleBunRoot("C:\\Users\\someone", {
    platform: "win32",
    env: { LOCALAPPDATA: "D:\\Profiles\\someone\\Local" },
  })).toBe("D:\\Profiles\\someone\\Local\\Lazurio\\runtimes\\bun");
  expect(moduleBunRoot("C:\\Users\\someone", { platform: "win32", env: {} }))
    .toBe("C:\\Users\\someone\\AppData\\Local\\Lazurio\\runtimes\\bun");
  expect(moduleBunLocks("C:\\Users\\someone", { platform: "win32", env: {} }))
    .toBe("C:\\Users\\someone\\AppData\\Local\\Lazurio\\runtimes\\bun.locks");
  for (const platform of ["darwin", "linux"]) {
    expect(moduleBunRoot("/home/someone", { platform, env: { LOCALAPPDATA: "ignored" } }))
      .toBe("/home/someone/.local/share/lazurio/runtimes/bun");
  }
  const binDir = "C:\\Users\\someone\\AppData\\Local\\Lazurio\\runtimes\\bun\\1.4.99\\node_modules\\@oven\\bun-windows-x64\\bin";
  expect(withModuleBun(
    { Path: `C:\\Windows\\System32;${binDir.toUpperCase()};C:\\Tools`, SystemRoot: "C:\\Windows" },
    { executable: `${binDir}\\bun.exe`, binDir, source: "cache" },
    { platform: "win32" },
  )).toEqual({ Path: `${binDir};C:\\Windows\\System32;C:\\Tools`, SystemRoot: "C:\\Windows" });
});

// MS-02 asks whether a pinned Bun is published (decision 0171, addendum of
// 2026-10-24, point 4); the Doctor asks which pins the cache holds. Both read
// the same cache layout the resolver places, and neither runs a program.
async function cacheWithProgram(versions) {
  const cacheRoot = await mkdtemp(join(tmpdir(), "lazurio-bun-cache-"));
  for (const [version, target, bytes] of versions) {
    const program = join(cacheRoot, version, "node_modules", "@oven", `bun-${target}`, "bin", "bun");
    await mkdir(dirname(program), { recursive: true });
    await writeFile(program, "x".repeat(bytes));
  }
  return cacheRoot;
}
const linuxX64 = async () => ({ platform: "linux", arch: "x64", libc: "glibc", avx2: true });

test("a Bun version is published when the runtime cache holds it, otherwise as Bun's npm distribution answers for this system, and unknown on any other answer", async () => {
  const cacheRoot = await cacheWithProgram([["1.4.3", "linux-x64", 4]]);
  try {
    const requests = [];
    const registry = (answer) => async (url, init) => {
      requests.push({ url: String(url), bounded: init?.signal instanceof AbortSignal });
      if (answer instanceof Error) throw answer;
      return new Response(answer === 404 ? "\"version not found\"" : "{}", { status: answer });
    };
    const published = (version, answer) => bunVersionPublished(version, { cacheRoot, system: linuxX64, fetchFn: registry(answer) });

    // In the cache: published, and the registry is never asked.
    expect(await published("1.4.3", new Error("the registry must not be asked"))).toBe(true);
    expect(requests).toEqual([]);

    expect(await published("1.4.4", 200)).toBe(true);
    expect(await published("1.4.99", 404)).toBe(false);
    for (const status of [500, 503, 429, 403]) expect(await published("1.4.5", status)).toBeNull();
    // Offline, and a registry that does not answer within the bound.
    expect(await published("1.4.5", new TypeError("fetch failed"))).toBeNull();
    expect(await published("1.4.5", new DOMException("The operation timed out.", "TimeoutError"))).toBeNull();
    expect(requests.map((request) => request.url)).toEqual([
      "https://registry.npmjs.org/@oven/bun-linux-x64/1.4.4",
      "https://registry.npmjs.org/@oven/bun-linux-x64/1.4.99",
      ...Array(6).fill("https://registry.npmjs.org/@oven/bun-linux-x64/1.4.5"),
    ]);
    expect(requests.every((request) => request.bounded)).toBe(true);

    // The bound is real: a registry that hangs is abandoned, never awaited.
    const hanging = async (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason));
    });
    expect(await bunVersionPublished("1.4.6", { cacheRoot, system: linuxX64, fetchFn: hanging, timeoutMs: 20 })).toBeNull();
    expect(bunPublishedCheckTimeoutMs).toBe(5_000);

    // The bound covers the whole question, not only the headers: a body whose
    // cancellation never settles still answers at once, and a fetch that
    // ignores its signal is abandoned at the bound.
    const unbounded = async (promise) => {
      let timer;
      const guard = new Promise((resolve) => { timer = setTimeout(() => resolve("unbounded"), 500); });
      try {
        return await Promise.race([promise, guard]);
      } finally {
        clearTimeout(timer);
      }
    };
    const stalledBody = async () => ({ status: 200, body: { cancel: () => new Promise(() => {}) } });
    expect(await unbounded(bunVersionPublished("1.4.6", { cacheRoot, system: linuxX64, fetchFn: stalledBody, timeoutMs: 20 })))
      .toBe(true);
    const deaf = async () => new Promise(() => {});
    expect(await unbounded(bunVersionPublished("1.4.6", { cacheRoot, system: linuxX64, fetchFn: deaf, timeoutMs: 20 })))
      .toBeNull();

    // A system Bun publishes no build for cannot tell.
    expect(await bunVersionPublished("1.4.4", {
      cacheRoot,
      system: async () => ({ platform: "freebsd", arch: "x64", libc: null, avx2: null }),
      fetchFn: registry(200),
    })).toBeNull();
    expect(requests).toHaveLength(8);
    await expect(bunVersionPublished("../1.4.3", { cacheRoot, system: linuxX64, fetchFn: registry(200) }))
      .rejects.toThrow(TypeError);
  } finally {
    await rm(cacheRoot, { recursive: true, force: true });
  }
});

test("the runtime cache tells which pinned Bun versions it holds for this system and how much space it takes", async () => {
  const cacheRoot = await cacheWithProgram([
    ["1.4.3", "linux-x64-baseline", 1000],
    ["1.4.4", "linux-aarch64", 300],
  ]);
  try {
    await writeFile(join(cacheRoot, "1.4.3", "package.json"), "{}");
    // Without AVX2 known, the plain build and its baseline both count.
    const linuxUnknownAvx2 = async () => ({ platform: "linux", arch: "x64", libc: "glibc", avx2: null });
    expect(await bunVersionCached("1.4.3", { cacheRoot, system: linuxUnknownAvx2 })).toBe(true);
    expect(await bunVersionCached("1.4.2", { cacheRoot, system: linuxUnknownAvx2 })).toBe(false);
    // Another system's build is not this system's runtime.
    expect(await bunVersionCached("1.4.4", { cacheRoot, system: linuxUnknownAvx2 })).toBe(false);
    // A directory where the program belongs is not a program.
    await mkdir(join(cacheRoot, "1.4.5", "node_modules", "@oven", "bun-linux-x64", "bin", "bun"), { recursive: true });
    expect(await bunVersionCached("1.4.5", { cacheRoot, system: linuxUnknownAvx2 })).toBe(false);

    expect(await moduleBunCacheBytes({ cacheRoot })).toBe(1302);
    expect(await moduleBunCacheBytes({ cacheRoot: join(cacheRoot, "absent") })).toBe(0);
  } finally {
    await rm(cacheRoot, { recursive: true, force: true });
  }
});

posixTest("an unsupported system is refused before anything is downloaded; a plain x64 build that does not run is replaced by its baseline once, and on Linux without AVX2 only the baseline is fetched", async () => {
  const { home, owner, file } = await place("systems");
  const unsupported = fakeInstaller();
  expect(await refusalOf(resolverFor(home, {
    install: unsupported.install,
    system: async () => ({ platform: "freebsd", arch: "x64", libc: null, avx2: null }),
  })({ packageManager: "bun@1.4.99", owner }))).toEqual({ reason: "runtime-unsupported-platform", path: file });
  expect(unsupported.calls).toEqual([]);
  // macOS on an Intel CPU without AVX2: the plain build cannot run.
  const intel = fakeInstaller({
    reports: (input) => (input.packageName.endsWith("-baseline") ? input.version : "broken"),
  });
  const resolve = resolverFor(home, {
    install: intel.install,
    system: async () => ({ platform: "darwin", arch: "x64", libc: null, avx2: null }),
  });
  const baseline = cachedExecutable(home, "1.4.99", "darwin-x64-baseline");
  expect(await resolve({ packageManager: "bun@1.4.99", owner })).toEqual({
    executable: baseline,
    binDir: dirname(baseline),
    source: "fetched",
  });
  expect(intel.calls.map((call) => call.packageName)).toEqual(["@oven/bun-darwin-x64", "@oven/bun-darwin-x64-baseline"]);
  expect(await resolve({ packageManager: "bun@1.4.99", owner })).toEqual({
    executable: baseline,
    binDir: dirname(baseline),
    source: "cache",
  });
  expect(intel.calls).toHaveLength(2);
  // A build that does not run where there is no baseline to try.
  const arm = await place("systems-arm");
  const broken = fakeInstaller({ reports: () => "broken" });
  expect(await refusalOf(resolverFor(arm.home, { install: broken.install })({
    packageManager: "bun@1.4.99",
    owner: arm.owner,
  }))).toEqual({ reason: "runtime-unsupported-platform", path: arm.file });
  expect(await readdir(moduleBunRoot(arm.home))).toEqual([]);
  // Linux without AVX2: decided up front.
  const old = await place("systems-old");
  const plain = fakeInstaller();
  await resolverFor(old.home, {
    install: plain.install,
    system: async () => ({ platform: "linux", arch: "x64", libc: "glibc", avx2: false }),
  })({ packageManager: "bun@1.4.99", owner: old.owner });
  expect(plain.calls.map((call) => call.packageName)).toEqual(["@oven/bun-linux-x64-baseline"]);
});

// A gate a test opens.
function gated() {
  let open = () => {};
  const wait = new Promise((resolve) => {
    open = resolve;
  });
  return { wait, open: () => open() };
}

// The real exclusion, counting how often it was asked for.
function countedLock() {
  const counted = {
    attempts: 0,
    lock: async (path, timeoutMs) => {
      counted.attempts += 1;
      return acquireFileLock(path, { timeoutMs });
    },
  };
  return counted;
}

async function until(condition, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Condition not reached");
    await Bun.sleep(10);
  }
}

posixTest("concurrent resolutions of one version fetch it once in a process; two processes racing both get it, the second waiting for the first's exclusion and reading the copy it placed", async () => {
  const { home, owner } = await place("concurrent");
  const released = gated();
  const fake = fakeInstaller({ gate: () => released.wait });
  const resolve = resolverFor(home, { install: fake.install });
  const pending = Array.from({ length: 5 }, () => resolve({ packageManager: "bun@1.4.99", owner }));
  await Bun.sleep(100);
  released.open();
  const results = await Promise.all(pending);
  const executable = cachedExecutable(home, "1.4.99", "linux-aarch64");
  for (const result of results) expect(result.executable).toBe(executable);
  expect(fake.calls).toHaveLength(1);
  // Two processes: each its own in-flight fetches, one cache and one kernel
  // lock per version, as two Launchpads (or a Launchpad and LazurioPlatform)
  // on one machine.
  const racing = await place("racing");
  const fetched = gated();
  const racer = fakeInstaller({ gate: () => fetched.wait });
  const locks = countedLock();
  const [one, two] = [0, 1].map(() => resolverFor(racing.home, {
    install: racer.install,
    fetches: new Map(),
    lock: locks.lock,
  }));
  const first = one({ packageManager: "bun@1.4.99", owner: racing.owner });
  await until(() => racer.calls.length === 1);
  const second = two({ packageManager: "bun@1.4.99", owner: racing.owner });
  await until(() => locks.attempts === 2);
  fetched.open();
  const raced = await Promise.all([first, second]);
  const placed = cachedExecutable(racing.home, "1.4.99", "linux-aarch64");
  expect(racer.calls).toHaveLength(1);
  for (const result of raced) expect(result.executable).toBe(placed);
  expect(raced.map((result) => result.source)).toEqual(["fetched", "cache"]);
  expect(run(placed, ["--version"])).toBe("1.4.99");
  expect(await readdir(moduleBunRoot(racing.home))).toEqual(["1.4.99"]);
  // The lock files stay: a waiter may hold one open.
  expect(await readdir(moduleBunLocks(racing.home))).toEqual(["1.4.99"]);
});

posixTest("two processes repairing one broken cached version at once: one moves it aside and places a fetched copy, the other waits and reads that copy, and neither removes the replacement", async () => {
  const { home, owner } = await place("repair-race");
  const versionDirectory = join(moduleBunRoot(home), "1.4.99");
  // A broken copy: its program says another version.
  await fakeBun(join(versionDirectory, "node_modules", "@oven", "bun-linux-aarch64", "bin", "bun"), "1.4.97");
  const fetched = gated();
  const fake = fakeInstaller({ gate: () => fetched.wait });
  const locks = countedLock();
  const [repairing, waiting] = [0, 1].map(() => resolverFor(home, {
    install: fake.install,
    fetches: new Map(),
    lock: locks.lock,
  }));
  const first = repairing({ packageManager: "bun@1.4.99", owner });
  // The first holds the exclusion, has moved the broken copy aside and is
  // fetching; the second sees no ready copy and waits for the exclusion.
  await until(() => fake.calls.length === 1);
  const second = waiting({ packageManager: "bun@1.4.99", owner });
  await until(() => locks.attempts === 2);
  fetched.open();
  const placed = await first;
  const identity = await lstat(versionDirectory);
  const read = await second;
  const executable = cachedExecutable(home, "1.4.99", "linux-aarch64");
  expect(placed.executable).toBe(executable);
  expect(read.executable).toBe(executable);
  expect([placed.source, read.source]).toEqual(["fetched", "cache"]);
  // The copy the first placed (and handed out) is the one still there.
  const after = await lstat(versionDirectory);
  expect(`${after.dev}:${after.ino}`).toBe(`${identity.dev}:${identity.ino}`);
  expect(run(executable, ["--version"])).toBe("1.4.99");
  expect(fake.calls).toHaveLength(1);
  expect(await readdir(moduleBunRoot(home))).toEqual(["1.4.99"]);
});

posixTest("a cached version whose program does not run or says another version is fetched again once, never in a loop", async () => {
  const { home, owner, file } = await place("corrupt");
  let reports = "1.4.99";
  const fake = fakeInstaller({ reports: () => reports });
  const resolve = resolverFor(home, { install: fake.install });
  const executable = cachedExecutable(home, "1.4.99", "linux-aarch64");
  await resolve({ packageManager: "bun@1.4.99", owner });
  for (const corruption of ["broken", "runs"]) {
    await fakeBun(executable, "1.4.97", { mode: corruption });
    const calls = fake.calls.length;
    expect(await resolve({ packageManager: "bun@1.4.99", owner })).toEqual({
      executable,
      binDir: dirname(executable),
      source: "fetched",
    });
    expect(fake.calls).toHaveLength(calls + 1);
    expect(run(executable, ["--version"])).toBe("1.4.99");
  }
  // A fetch again that gives a wrong program too: refused, one fetch.
  await fakeBun(executable, "1.4.97");
  reports = "1.4.96";
  const calls = fake.calls.length;
  expect(await refusalOf(resolve({ packageManager: "bun@1.4.99", owner }))).toEqual({
    reason: "runtime-integrity-failed",
    path: file,
  });
  expect(fake.calls).toHaveLength(calls + 1);
  expect(await readdir(moduleBunRoot(home))).toEqual([]);
});

posixTest("the resolved Bun's directory goes first on the App's PATH, once, so a nested bun and bun x run the pinned version", async () => {
  const { directory, home, owner } = await place("path");
  const log = join(directory, "pinned.log");
  const fake = fakeInstaller({ log: () => log });
  const bun = await resolverFor(home, { install: fake.install })({ packageManager: "bun@1.4.99", owner });
  // Only what runs below: the resolver's own version check is not counted.
  await writeFile(log, "");
  // The user's own Bun lies earlier on their PATH; the pinned one goes ahead
  // of it, and a copy of the pinned directory further on is not repeated.
  const userDirectory = join(directory, "user-bin");
  await fakeBun(join(userDirectory, "bun"), "1.0.0");
  const env = withModuleBun(
    { HOME: home, PATH: `${userDirectory}:/usr/bin:${bun.binDir}:/bin`, KEEP: "kept" },
    bun,
  );
  expect(env).toEqual({ HOME: home, PATH: `${bun.binDir}:${userDirectory}:/usr/bin:/bin`, KEEP: "kept" });
  expect(execFileSync("/bin/sh", ["-c", "bun --version"], { encoding: "utf8", env }).trim()).toBe("1.4.99");
  execFileSync("/bin/sh", ["-c", "bun x --version"], { encoding: "utf8", env, stdio: ["ignore", "pipe", "ignore"] });
  // A script that a nested bun runs reports the pinned version.
  const script = join(directory, "report.mjs");
  await writeFile(script, "console.log(process.env.LAZURIO_FIXTURE_BUN ?? 'unpinned');\n");
  expect(execFileSync("/bin/sh", ["-c", `bun ${script}`], { encoding: "utf8", env }).trim()).toBe("1.4.99");
  expect((await readFile(log, "utf8")).trim().split("\n")).toEqual(["--version", "x --version", script]);
});

// The use marker (#640, plan DEV-6682 M2b-2b): a resolution that answers a
// version from the runtime cache touches `bun.used/<version>` beside the cache,
// where the locks are, so that a later prune knows when the version was last
// used. Never a file in the version's directory, which stays exactly as it was
// placed (decision 0171, addendum of 2026-10-24, point 3), and never anything
// for the user's Bun, which uses no cache entry.
const usedMarker = (home, version) => join(home, ".local/share/lazurio/runtimes/bun.used", version);
// Permission denials need a user the kernel holds to them.
const permissionTest = test.skipIf(!supported || process.getuid?.() === 0);

// Every entry below a directory with its kind, mode, content and time, links
// not followed: what "unchanged" means for a placed version.
async function treeOf(directory) {
  const entries = [];
  const walk = async (path) => {
    for (const name of (await readdir(path)).sort()) {
      const entry = join(path, name);
      const info = await lstat(entry);
      const kind = info.isSymbolicLink() ? "link" : info.isDirectory() ? "directory" : "file";
      entries.push([
        entry.slice(directory.length),
        kind,
        info.mode,
        kind === "file" ? createHash("sha256").update(await readFile(entry)).digest("hex") : null,
        kind === "link" ? await readlink(entry) : null,
        kind === "file" ? info.mtimeMs : null,
      ]);
      if (kind === "directory") await walk(entry);
    }
  };
  await walk(directory);
  return entries;
}

posixTest("a fetched version is marked used beside the cache with an empty file of the user's own, and a refused one is not", async () => {
  const { home, owner } = await place("used-fetch");
  const fake = fakeInstaller();
  const resolve = resolverFor(home, { install: fake.install });
  expect((await resolve({ packageManager: "bun@1.4.99", owner })).source).toBe("fetched");
  const marker = await lstat(usedMarker(home, "1.4.99"));
  expect(marker.isFile()).toBe(true);
  expect(marker.size).toBe(0);
  expect(marker.mode & 0o777).toBe(0o600);
  expect((await lstat(dirname(usedMarker(home, "1.4.99")))).mode & 0o777).toBe(0o700);
  // Beside the versions and their locks; the cache root keeps listing only
  // version directories.
  expect((await readdir(dirname(moduleBunRoot(home)))).sort()).toEqual(["bun", "bun.locks", "bun.used"]);
  expect(await readdir(moduleBunRoot(home))).toEqual(["1.4.99"]);
  // What cannot be had answers no version, so nothing is marked.
  const offline = await place("used-refused");
  await refusalOf(resolverFor(offline.home, { install: fakeInstaller({ refuse: () => "runtime-unavailable" }).install })({
    packageManager: "bun@1.4.98",
    owner: offline.owner,
  }));
  expect(existsSync(usedMarker(offline.home, "1.4.98"))).toBe(false);
});

posixTest("a resolution from the cache marks the version used when it was not yet, and moves the mark forward when it was", async () => {
  const { home, owner } = await place("used-cache");
  const fake = fakeInstaller();
  const resolve = resolverFor(home, { install: fake.install });
  await resolve({ packageManager: "bun@1.4.99", owner });
  // A version in the cache that was never marked, as every version placed
  // before the marker existed.
  await rm(usedMarker(home, "1.4.99"));
  expect((await resolve({ packageManager: "bun@1.4.99", owner })).source).toBe("cache");
  expect((await lstat(usedMarker(home, "1.4.99"))).isFile()).toBe(true);
  // A later resolution moves its time forward.
  const earlier = new Date("2026-01-02T03:04:05Z");
  await utimes(usedMarker(home, "1.4.99"), earlier, earlier);
  expect((await resolve({ packageManager: "bun@1.4.99", owner })).source).toBe("cache");
  expect((await lstat(usedMarker(home, "1.4.99"))).mtimeMs).toBeGreaterThan(earlier.getTime() + 60_000);
  // Concurrent resolutions of one version, one fetch, one marker.
  await Promise.all(Array.from({ length: 3 }, () => resolve({ packageManager: "bun@1.4.97", owner })));
  expect((await lstat(usedMarker(home, "1.4.97"))).isFile()).toBe(true);
  expect(fake.calls.map((call) => call.version)).toEqual(["1.4.99", "1.4.97"]);
});

posixTest("the user's Bun and a package without an exact pin write no marker: no cache entry is used", async () => {
  const { home, owner } = await place("used-user");
  const fake = fakeInstaller();
  const resolve = resolverFor(home, { install: fake.install });
  expect((await resolve({ packageManager: `bun@${Bun.version}`, owner })).source).toBe("user");
  expect((await resolve({ packageManager: null, owner })).source).toBe("user");
  expect(existsSync(join(home, ".local", "share", "lazurio"))).toBe(false);
  expect(fake.calls).toEqual([]);
});

permissionTest("a marker that cannot be written changes nothing about the resolution: a read-only marker directory, and a file where the directory belongs", async () => {
  const { home, owner } = await place("used-read-only");
  const fake = fakeInstaller();
  const resolve = resolverFor(home, { install: fake.install });
  const executable = cachedExecutable(home, "1.4.99", "linux-aarch64");
  await resolve({ packageManager: "bun@1.4.99", owner });
  const used = dirname(usedMarker(home, "1.4.99"));
  await rm(usedMarker(home, "1.4.99"));
  await chmod(used, 0o500);
  try {
    expect(await resolve({ packageManager: "bun@1.4.99", owner })).toEqual({
      executable,
      binDir: dirname(executable),
      source: "cache",
    });
    expect(existsSync(usedMarker(home, "1.4.99"))).toBe(false);
  } finally {
    await chmod(used, 0o700);
  }
  await rm(used, { recursive: true, force: true });
  await writeFile(used, "not a directory\n");
  expect((await resolve({ packageManager: "bun@1.4.99", owner })).source).toBe("cache");
  expect(await readFile(used, "utf8")).toBe("not a directory\n");
  expect(fake.calls).toHaveLength(1);
});

posixTest("marking a version used never changes its directory: nothing appears in it and nothing in it changes", async () => {
  const { home, owner } = await place("used-immutable");
  const resolve = resolverFor(home, { install: fakeInstaller().install });
  await resolve({ packageManager: "bun@1.4.99", owner });
  const version = join(moduleBunRoot(home), "1.4.99");
  const placed = await treeOf(version);
  for (let round = 0; round < 3; round += 1) {
    await rm(usedMarker(home, "1.4.99"), { force: true });
    expect((await resolve({ packageManager: "bun@1.4.99", owner })).source).toBe("cache");
    expect(existsSync(usedMarker(home, "1.4.99"))).toBe(true);
  }
  expect(await treeOf(version)).toEqual(placed);
  expect(await readdir(moduleBunRoot(home))).toEqual(["1.4.99"]);
});

// A registry on the loopback interface, as npm's answers it: a package
// document per name and its tarballs, each version with its integrity or
// deliberately another one.
async function loopbackRegistry(directory, packageName, versions, marker) {
  const tarballs = new Map();
  const documents = {};
  for (const [version, { reports, integrity }] of Object.entries(versions)) {
    const staging = join(directory, `tarball-${version}`);
    await mkdir(join(staging, "package", "bin"), { recursive: true });
    await writeFile(join(staging, "package", "package.json"), JSON.stringify({
      name: packageName,
      version,
      // Never run: Bun's installer runs no install scripts here.
      scripts: { postinstall: `echo ran > '${marker}'` },
    }));
    await fakeBun(join(staging, "package", "bin", "bun"), reports);
    const file = join(directory, `${version}.tgz`);
    const tar = Bun.spawnSync(["tar", "-czf", file, "-C", staging, "package"], {
      env: { PATH: "/usr/bin:/bin", COPYFILE_DISABLE: "1" },
    });
    expect(tar.exitCode).toBe(0);
    const bytes = await Bun.file(file).arrayBuffer();
    tarballs.set(version, bytes);
    const digest = createHash("sha512")
      .update(integrity === "good" ? new Uint8Array(bytes) : Buffer.from("another tarball"))
      .digest("base64");
    documents[version] = { digest };
  }
  let port = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      const tarball = /^\/tarballs\/(.+)\.tgz$/.exec(url.pathname);
      if (tarball !== null) {
        const bytes = tarballs.get(tarball[1]);
        return bytes === undefined ? new Response("not found", { status: 404 }) : new Response(bytes);
      }
      if (decodeURIComponent(url.pathname) !== `/${packageName}`) return new Response("not found", { status: 404 });
      return Response.json({
        name: packageName,
        "dist-tags": {},
        versions: Object.fromEntries(Object.entries(documents).map(([version, value]) => [version, {
          name: packageName,
          version,
          dist: {
            tarball: `http://127.0.0.1:${port}/tarballs/${version}.tgz`,
            integrity: `sha512-${value.digest}`,
          },
        }])),
      });
    },
  });
  port = server.port;
  return server;
}

posixTest("Bun's own installer fetches the version from the registry it is given, verifies its sha512 integrity before anything is kept, runs no install scripts, reads none of the user's configuration and never writes a package.json above its private directory", async () => {
  const { directory, home, owner, file } = await place("installer");
  const marker = join(directory, "postinstall-ran");
  // The user's home is a project of its own, with a registry in its npm and
  // Bun configuration that would answer nothing.
  const homePackage = '{"name":"someone-elses-project","private":true}\n';
  await writeFile(join(home, "package.json"), homePackage);
  await writeFile(join(home, ".npmrc"), "registry=http://127.0.0.1:9/\n");
  await writeFile(join(home, ".bunfig.toml"), '[install]\nregistry = "http://127.0.0.1:9/"\n');
  const registry = await loopbackRegistry(join(directory, "registry"), "@oven/bun-linux-aarch64", {
    "1.4.99": { reports: "1.4.99", integrity: "good" },
    "1.4.98": { reports: "1.4.98", integrity: "bad" },
  }, marker);
  try {
    const resolve = resolverFor(home, { install: bunInstaller(`http://127.0.0.1:${registry.port}/`) });
    const executable = cachedExecutable(home, "1.4.99", "linux-aarch64");
    expect(await resolve({ packageManager: "bun@1.4.99", owner })).toEqual({
      executable,
      binDir: dirname(executable),
      source: "fetched",
    });
    expect(run(executable, ["--version"])).toBe("1.4.99");
    expect((await lstat(executable)).isFile()).toBe(true);
    // Its own project, with what Bun's installer recorded.
    const own = JSON.parse(await readFile(join(moduleBunRoot(home), "1.4.99", "package.json"), "utf8"));
    expect(own.dependencies).toEqual({ "@oven/bun-linux-aarch64": "1.4.99" });
    expect(existsSync(join(moduleBunRoot(home), "1.4.99", "bun.lock"))).toBe(true);
    // Nothing of the user's: the project above stays as it was.
    expect(await readFile(join(home, "package.json"), "utf8")).toBe(homePackage);
    for (const name of ["bun.lock", "node_modules"]) expect(existsSync(join(home, name))).toBe(false);
    expect(existsSync(marker)).toBe(false);
    // A tarball that does not match its integrity is never kept.
    expect(await refusalOf(resolve({ packageManager: "bun@1.4.98", owner }))).toEqual({
      reason: "runtime-integrity-failed",
      path: file,
    });
    // A version the registry does not know.
    expect(await refusalOf(resolve({ packageManager: "bun@1.4.97", owner }))).toEqual({
      reason: "runtime-version-unknown",
      path: file,
    });
    expect(await readdir(moduleBunRoot(home))).toEqual(["1.4.99"]);
  } finally {
    registry.stop(true);
  }
  // A registry that does not answer.
  const closed = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
  const port = closed.port;
  closed.stop(true);
  const offline = await place("installer-offline");
  expect(await refusalOf(resolverFor(offline.home, { install: bunInstaller(`http://127.0.0.1:${port}/`) })({
    packageManager: "bun@1.4.99",
    owner: offline.owner,
  }))).toEqual({ reason: "runtime-unavailable", path: offline.file });
  expect(await readdir(moduleBunRoot(offline.home))).toEqual([]);
}, 60_000);

// Opt-in: the real distribution. Fetches Bun from the npm registry for this
// system into a temporary home and runs it, nested bun and bunx included.
test.skipIf(!supported || process.env.LAZURIO_TEST_NETWORK !== "1")("opt-in (LAZURIO_TEST_NETWORK=1): a real Bun version is fetched from npm for this system, verified, and runs as the pinned version, nested bun and bunx included", async () => {
  const pinned = Bun.version === "1.4.3" ? "1.4.4" : "1.4.3";
  const { directory, home, owner } = await place("network");
  const resolve = createModuleBunResolver({ home, userBun: process.execPath, path: "/usr/bin:/bin" });
  const started = performance.now();
  const bun = await resolve({ packageManager: `bun@${pinned}`, owner });
  const seconds = ((performance.now() - started) / 1000).toFixed(1);
  expect(bun.source).toBe("fetched");
  expect(bun.binDir).not.toBeNull();
  expect(run(bun.executable, ["--version"])).toBe(pinned);
  expect(run(bun.executable, ["-e", "console.log(Bun.version)"], { HOME: home })).toBe(pinned);
  const project = join(directory, "project");
  await mkdir(project);
  await writeFile(join(project, "package.json"), JSON.stringify({
    name: "nested",
    private: true,
    scripts: { nested: "bun --version", bunx: "bunx --version" },
  }));
  const env = withModuleBun({ HOME: home, PATH: "/usr/bin:/bin" }, bun);
  for (const script of ["nested", "bunx"]) {
    expect(execFileSync(bun.executable, ["--no-env-file", "run", script], {
      cwd: project,
      encoding: "utf8",
      env,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim()).toBe(pinned);
  }
  expect(await resolve({ packageManager: `bun@${pinned}`, owner })).toMatchObject({
    executable: bun.executable,
    source: "cache",
  });
  console.log(`opt-in network: fetched bun@${pinned} for ${process.platform}-${process.arch} with the user's Bun ${Bun.version} in ${seconds} s: ${bun.executable}`);
}, 300_000);
