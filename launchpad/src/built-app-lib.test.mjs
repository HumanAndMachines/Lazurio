// The built version of an App from `main` on a computer (decision 0212
// point 9): the static server's resolution rules and headers, the cache
// location per operating system, the build key and the build itself with a
// real Bun build script in a real Git checkout.
import { afterAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appBuildDirectory,
  buildCacheRoot,
  buildEnvironment,
  buildKeyOf,
  builtAppMode,
  ensureAppBuild,
  recordServedBuild,
} from "../../lazurio/runtime/built-app-lib.mjs";
import {
  answerStatic,
  argumentsOf,
  entrypointOf,
  resolveStaticRequest,
} from "../../lazurio/runtime/static-build-server.mjs";
import { initGitRepo, runGit } from "./git-fixture-helpers.test.mjs";
import { supportsFileSymlinks } from "../../scripts/test-platform-capabilities.mjs";

const roots = [];
const linkTest = await supportsFileSymlinks() ? test : test.skip;
const posixTest = process.platform === "win32" ? test.skip : test;

afterAll(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }).catch(() => {});
});

async function temporary(prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

async function writeBuild(root, files) {
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, ...path.split("/"));
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(target, content);
  }
}

// --- the static server ---------------------------------------------------

test("static resolution: exact file, .html, directory index, redirect and fallbacks", async () => {
  const root = await temporary("lazurio-static-");
  await writeBuild(root, {
    "index.html": "home",
    "about.html": "about",
    "docs/index.html": "docs",
    "_astro/app.1234.js": "js",
    "404.html": "missing",
  });
  expect(await resolveStaticRequest(root, "/", "404")).toMatchObject({ kind: "file", status: 200 });
  expect((await resolveStaticRequest(root, "/about", "404")).path).toEndWith("about.html");
  expect((await resolveStaticRequest(root, "/about.html", "404")).path).toEndWith("about.html");
  expect(await resolveStaticRequest(root, "/docs", "404")).toEqual({ kind: "redirect", location: "/docs/" });
  expect((await resolveStaticRequest(root, "/docs/", "404")).path).toEndWith(join("docs", "index.html"));
  const missing = await resolveStaticRequest(root, "/nope", "404");
  expect(missing).toMatchObject({ kind: "file", status: 404 });
  expect(missing.path).toEndWith("404.html");
  expect(await resolveStaticRequest(root, "/client/route", "spa")).toMatchObject({ kind: "file", status: 200 });
  expect((await resolveStaticRequest(root, "/client/route", "spa")).path).toEndWith("index.html");
  // A path with an extension is a missing file, never the SPA's page.
  expect(await resolveStaticRequest(root, "/client/app.css", "spa")).toEqual({ kind: "missing" });
});

test("static resolution refuses anything that could leave the build", async () => {
  const root = await temporary("lazurio-static-refused-");
  await writeBuild(root, { "index.html": "home" });
  for (const path of ["/../secret", "/%2e%2e/secret", "/a%2fb", "/a%5cb", "/C:", "/index.html:stream", "/%00", "relative"]) {
    expect(await resolveStaticRequest(root, path, "404")).toEqual({ kind: "refused" });
  }
});

linkTest("static resolution never follows a link out of the build", async () => {
  const root = await temporary("lazurio-static-link-");
  const outside = await temporary("lazurio-static-outside-");
  await writeBuild(root, { "index.html": "home" });
  await writeBuild(outside, { "secret.html": "secret" });
  await symlink(join(outside, "secret.html"), join(root, "secret.html"));
  await symlink(outside, join(root, "linked"), "dir");
  expect(await resolveStaticRequest(root, "/secret.html", "404")).toEqual({ kind: "missing" });
  expect(await resolveStaticRequest(root, "/linked/secret.html", "404")).toEqual({ kind: "missing" });
});

test("static answers: methods, cache headers, ETag revalidation and HEAD", async () => {
  const root = await temporary("lazurio-static-answer-");
  await writeBuild(root, {
    "index.html": "<h1>home</h1>",
    "_astro/app.1234.js": "console.log(1)",
    "assets/index-abcd.css": "body{}",
    "docs/index.html": "docs",
  });
  const page = await answerStatic(new Request("http://127.0.0.1/"), { root, fallback: "404" });
  expect(page.status).toBe(200);
  expect(page.headers.get("cache-control")).toBe("no-cache");
  expect(page.headers.get("content-type")).toContain("text/html");
  expect(page.headers.get("x-content-type-options")).toBe("nosniff");
  expect(await page.text()).toBe("<h1>home</h1>");
  const tag = page.headers.get("etag");
  expect(tag).toMatch(/^"[0-9a-f]+-[0-9a-f]+"$/);
  const again = await answerStatic(new Request("http://127.0.0.1/", { headers: { "If-None-Match": tag } }), { root, fallback: "404" });
  expect(again.status).toBe(304);
  for (const asset of ["/_astro/app.1234.js", "/assets/index-abcd.css"]) {
    const response = await answerStatic(new Request(`http://127.0.0.1${asset}`), { root, fallback: "404" });
    expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
  }
  const head = await answerStatic(new Request("http://127.0.0.1/", { method: "HEAD" }), { root, fallback: "404" });
  expect(head.status).toBe(200);
  expect(head.headers.get("content-length")).toBe(String("<h1>home</h1>".length));
  expect(await head.text()).toBe("");
  const post = await answerStatic(new Request("http://127.0.0.1/", { method: "POST" }), { root, fallback: "404" });
  expect(post.status).toBe(405);
  expect(post.headers.get("allow")).toBe("GET, HEAD");
  const redirect = await answerStatic(new Request("http://127.0.0.1/docs?x=1"), { root, fallback: "404" });
  expect(redirect.status).toBe(308);
  expect(redirect.headers.get("location")).toBe("/docs/?x=1");
  expect((await answerStatic(new Request("http://127.0.0.1/nope"), { root, fallback: "404" })).status).toBe(404);
  // The URL parser already removes dot segments; an encoded separator is refused.
  expect((await answerStatic(new Request("http://127.0.0.1/%2e%2e/x"), { root, fallback: "404" })).status).toBe(404);
  expect((await answerStatic(new Request("http://127.0.0.1/a%2fb"), { root, fallback: "404" })).status).toBe(400);
});

test("static server arguments take an absolute root on every system, listener from the lifecycle", () => {
  const root = process.platform === "win32" ? "C:\\Users\\a\\AppData\\Local\\Lazurio\\cache\\builds\\k" : "/home/a/.cache/lazurio/builds/k";
  expect(argumentsOf(["--root", root, "--fallback", "spa"])).toEqual({ root, fallback: "spa" });
  expect(() => argumentsOf(["--root", "relative", "--fallback", "404"])).toThrow();
  expect(() => argumentsOf(["--root", root, "--fallback", "other"])).toThrow();
  expect(() => argumentsOf(["--root", root])).toThrow();
  expect(entrypointOf({
    LAZURIO_RUNTIME_ENTRYPOINT_ID: "web",
    LAZURIO_RUNTIME_LISTENER_WEB_HOST: "127.0.0.1",
    LAZURIO_RUNTIME_LISTENER_WEB_PORT: "4321",
  })).toEqual({ hostname: "127.0.0.1", port: 4321 });
  expect(() => entrypointOf({})).toThrow();
});

test("the static server runs as a process on its listener and ends on SIGTERM", async () => {
  const root = await temporary("lazurio-static-process-");
  await writeBuild(root, { "index.html": "served" });
  const port = await freePort();
  const child = Bun.spawn([
    process.execPath,
    "--no-env-file",
    join(import.meta.dir, "..", "..", "lazurio", "runtime", "static-build-server.mjs"),
    "--root", root,
    "--fallback", "404",
  ], {
    env: {
      ...process.env,
      LAZURIO_RUNTIME_ENTRYPOINT_ID: "web",
      LAZURIO_RUNTIME_LISTENER_WEB_HOST: "127.0.0.1",
      LAZURIO_RUNTIME_LISTENER_WEB_PORT: String(port),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    const response = await waitForFetch(`http://127.0.0.1:${port}/`);
    expect(await response.text()).toBe("served");
    child.kill("SIGTERM");
    const exitCode = await child.exited;
    if (process.platform !== "win32") expect(exitCode).toBe(0);
  } finally {
    child.kill("SIGKILL");
  }
});

// --- cache, key and environment -------------------------------------------

test("the build cache lives in the account's cache on macOS, Linux and Windows", () => {
  expect(buildCacheRoot({ platform: "darwin", env: {}, homeDirectory: "/Users/a" })).toBe("/Users/a/.cache/lazurio/builds");
  expect(buildCacheRoot({ platform: "linux", env: { XDG_CACHE_HOME: "/var/cache/a" }, homeDirectory: "/home/a" }))
    .toBe("/var/cache/a/lazurio/builds");
  // A relative XDG directory is invalid and ignored, as for the Platform.
  expect(buildCacheRoot({ platform: "linux", env: { XDG_CACHE_HOME: "cache" }, homeDirectory: "/home/a" }))
    .toBe("/home/a/.cache/lazurio/builds");
  expect(buildCacheRoot({ platform: "win32", env: { LOCALAPPDATA: "C:\\Users\\a\\AppData\\Local" }, homeDirectory: "C:\\Users\\a" }))
    .toBe("C:\\Users\\a\\AppData\\Local\\Lazurio\\cache\\builds");
  expect(buildCacheRoot({ platform: "win32", env: { LOCALAPPDATA: "relative" }, homeDirectory: "C:\\Users\\a" }))
    .toBe("C:\\Users\\a\\AppData\\Local\\Lazurio\\cache\\builds");
});

test("one App's builds sit below its Organization and Module, apart per package directory", () => {
  const identity = { organization: "BetaCo", module: "deals", appId: "betaco-deals" };
  const first = appBuildDirectory("/cache", { ...identity, applicationDirectory: "/a/workspace/deals/app" });
  const second = appBuildDirectory("/cache", { ...identity, applicationDirectory: "/b/workspace/deals/app" });
  const digest = createHash("sha256").update("/a/workspace/deals/app").digest("hex").slice(0, 12);
  expect(first).toBe(join("/cache", "BetaCo", "deals", `betaco-deals-${digest}`));
  expect(second).not.toBe(first);
  expect(() => appBuildDirectory("/cache", { ...identity, module: "..", applicationDirectory: "/a" })).toThrow();
  expect(() => appBuildDirectory("/cache", { ...identity, organization: "a\\b", applicationDirectory: "/a" })).toThrow();
});

test("the build key is the Module commit, or the Platform's digest with the data and slots it reads", () => {
  const commit = "a".repeat(40);
  expect(buildKeyOf(commit, [])).toBe(commit);
  const inputs = [
    { path: "workspace/other", commit: null },
    { path: "workspace/deals/db", commit: "b".repeat(40) },
  ];
  const expected = createHash("sha256")
    .update(`lazurio.build-key.v1\n. ${commit}\nworkspace/deals/db ${"b".repeat(40)}\nworkspace/other absent\n`)
    .digest("hex");
  expect(buildKeyOf(commit, inputs)).toBe(expected);
});

test("a build gets nothing of where the App is served, in production mode", () => {
  expect(buildEnvironment({
    PATH: "/bin",
    HOST: "0.0.0.0",
    PORT: "1",
    NODE_ENV: "development",
    LAZURIO_RUNTIME_LISTENER_WEB_PORT: "4321",
    LAZURIO_RUNTIME_LISTENERS_JSON: "[]",
    COMPANYASCODE_APP_ID: "app",
  })).toEqual({ PATH: "/bin", NODE_ENV: "production", COMPANYASCODE_APP_ID: "app" });
});

test("only a declared lazurio.runtime App runs built from main", () => {
  const runtime = { runtime_contract: { schema_version: "lazurio.runtime.v1" } };
  expect(builtAppMode({ ...runtime, build_output: "dist", build_script: "build" })).toBe("static");
  expect(builtAppMode({ ...runtime, start_script: "start" })).toBe("server");
  expect(builtAppMode({ ...runtime, start_script: "start", build_output: "dist" })).toBe("server");
  expect(builtAppMode({ ...runtime, build_script: "build" })).toBeNull();
  expect(builtAppMode({ runtime_contract: { schema_version: "companyascode.launchpad_app.v1" }, build_output: "dist" })).toBeNull();
});

// --- the build -------------------------------------------------------------

async function createBuildCheckout({ health = "/" } = {}) {
  const root = await temporary("lazurio-build-");
  const checkout = join(root, "workspace", "deals");
  await initGitRepo(checkout);
  const cwd = join(checkout, "app");
  await writeBuild(cwd, {
    "version.txt": "v1",
    "build.mjs": [
      'import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";',
      'const version = (await readFile("version.txt", "utf8")).trim();',
      'await mkdir("runs", { recursive: true });',
      'await appendFile("runs/builds.txt", `${version} ${process.env.NODE_ENV} ${process.env.LAZURIO_RUNTIME_LISTENER_WEB_PORT ?? "-"}\\n`);',
      'if (version.startsWith("broken")) { console.error("broken build"); process.exit(1); }',
      'if (version.startsWith("empty")) process.exit(0);',
      'await mkdir("dist", { recursive: true });',
      'if (!version.startsWith("unservable")) await writeFile("dist/index.html", `<h1>${version}</h1>`);',
      'else await writeFile("dist/other.html", "other");',
    ].join("\n"),
  });
  await writeFile(join(checkout, ".gitignore"), "app/dist/\napp/runs/\n");
  runGit(["add", "."], checkout);
  runGit(["commit", "-m", "app"], checkout);
  const app = {
    id: "betaco-deals",
    company: "BetaCo",
    module: "deals",
    build_script: "build",
    build_output: "dist",
    entrypoint_listener: { id: "web", health: { kind: "http", path: health } },
    runtime_contract: { schema_version: "lazurio.runtime.v1" },
  };
  await writeFile(join(cwd, "package.json"), JSON.stringify({ name: "deals", scripts: { build: "bun --no-env-file build.mjs" } }));
  runGit(["add", "."], checkout);
  runGit(["commit", "-m", "package"], checkout);
  const cacheRoot = join(root, "cache");
  const build = (options = {}) => ensureAppBuild({
    app,
    cwd,
    checkoutRoot: checkout,
    organizationRoot: root,
    cacheRoot,
    bunExecutable: process.execPath,
    env: { ...process.env, LAZURIO_RUNTIME_LISTENER_WEB_PORT: "4321" },
    ...options,
  });
  const commitVersion = async (version) => {
    await writeFile(join(cwd, "version.txt"), version);
    runGit(["commit", "-am", version], checkout);
    return head(checkout);
  };
  return { root, checkout, cwd, app, cacheRoot, build, commitVersion };
}

test("a build of the current commit lands in the cache once, in production mode and without the listener", async () => {
  const fixture = await createBuildCheckout();
  const first = await fixture.build();
  const key = head(fixture.checkout);
  expect(first).toMatchObject({ ok: true, mode: "static", key, commit: key, built: true, finding: null });
  expect(first.output).toBe(join(first.directory, key));
  expect(await readFile(join(first.output, "index.html"), "utf8")).toBe("<h1>v1</h1>");
  expect(await readFile(join(fixture.cwd, "runs", "builds.txt"), "utf8")).toBe("v1 production -\n");
  const second = await fixture.build();
  expect(second).toMatchObject({ ok: true, key, built: false });
  expect(await readFile(join(fixture.cwd, "runs", "builds.txt"), "utf8")).toBe("v1 production -\n");
  const state = JSON.parse(await readFile(join(first.directory, "build.json"), "utf8"));
  expect(state).toMatchObject({
    schema_version: "lazurio.build-state.v1",
    organization: "BetaCo",
    module: "deals",
    app: "app/package.json",
    current: { key, commit: key, inputs: [], dirty: false },
    failure: null,
  });
});

test("a failed build keeps the previous build with a finding, and is not retried on request", async () => {
  const fixture = await createBuildCheckout();
  const good = await fixture.build();
  const broken = await fixture.commitVersion("broken");
  const failed = await fixture.build();
  expect(failed).toMatchObject({
    ok: true,
    key: good.key,
    output: good.output,
    finding: { reason: "build-script-failed", key: broken, message: "Nejnovější verzi se nepodařilo sestavit. Dál běží předchozí verze." },
  });
  expect(await readFile(failed.finding.log_path, "utf8")).toContain("broken build");
  const notRetried = await fixture.build({ retryFailed: false });
  expect(notRetried.finding.reason).toBe("build-script-failed");
  expect((await readFile(join(fixture.cwd, "runs", "builds.txt"), "utf8")).trim().split("\n")).toHaveLength(2);
});

test("with no build at all a failure leaves nothing to run", async () => {
  const fixture = await createBuildCheckout();
  await fixture.commitVersion("broken");
  const failed = await fixture.build();
  expect(failed).toMatchObject({
    ok: false,
    finding: { reason: "build-script-failed", message: "Aplikaci se nepodařilo sestavit." },
  });
});

test("a build that writes no output, or one that cannot answer its health path, is never used", async () => {
  const fixture = await createBuildCheckout();
  // A stale output from before must not pass as this key's build.
  await writeBuild(fixture.cwd, { "dist/index.html": "stale" });
  await fixture.commitVersion("empty");
  expect((await fixture.build()).finding.reason).toBe("build-output-missing");
  await fixture.commitVersion("unservable");
  expect((await fixture.build()).finding.reason).toBe("build-output-unservable");
});

test("old builds are removed; the current, the previous and the served one stay", async () => {
  const fixture = await createBuildCheckout();
  const first = await fixture.build();
  await recordServedBuild(first.directory, { key: first.key, commit: first.commit });
  await fixture.commitVersion("v2");
  const second = await fixture.build();
  await fixture.commitVersion("v3");
  const third = await fixture.build();
  await fixture.commitVersion("v4");
  const fourth = await fixture.build();
  const entries = (await readdir(fourth.directory)).filter((entry) => /^[0-9a-f]{40}$/.test(entry)).sort();
  expect(entries).toEqual([first.key, third.key, fourth.key].sort());
  expect(entries).not.toContain(second.key);
  const served = JSON.parse(await readFile(join(first.directory, "served.json"), "utf8"));
  expect(served).toMatchObject({ schema_version: "lazurio.build-served.v1", mode: "built", key: first.key });
});

test("a static build's key includes the Module's data repository and its required slots", async () => {
  const fixture = await createBuildCheckout();
  await initGitRepo(join(fixture.checkout, "db"));
  const app = { ...fixture.app, required_module_slots: ["workspace/other"] };
  const result = await fixture.build({ app });
  expect(result.key).toBe(buildKeyOf(head(fixture.checkout), [
    { path: "workspace/deals/db", commit: head(join(fixture.checkout, "db")) },
    { path: "workspace/other", commit: null },
  ]));
});

test("a server App without a client builds nothing; its key is its commit", async () => {
  const fixture = await createBuildCheckout();
  const app = { ...fixture.app, start_script: "start", build_output: undefined };
  const result = await fixture.build({ app });
  expect(result).toMatchObject({ ok: true, mode: "server", key: head(fixture.checkout), output: null, built: false });
});

function head(directory) {
  return new TextDecoder().decode(Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: directory }).stdout).trim();
}

async function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolvePort(port));
    });
  });
}

async function waitForFetch(url, attempts = 100) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await fetch(url);
    } catch (error) {
      lastError = error;
      await Bun.sleep(50);
    }
  }
  throw lastError;
}
