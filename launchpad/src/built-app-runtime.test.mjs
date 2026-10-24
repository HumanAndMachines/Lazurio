// Decision 0212 point 9 with real processes: an App from main on a computer
// runs as its build (a static App through the root's static server, an App
// with its own server through its start_script), a worktree keeps its dev
// script, and `lazurio update` builds a moved App without restarting it.
import { afterAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { createRuntimeManager } from "../../lazurio/runtime/runtime-lib.mjs";
import { runLazurioUpdate } from "../../lazurio/runtime/lazurio-update-lib.mjs";
import { createLaunchpadGitFixture, initGitRepo, runGit, writeJson } from "./git-fixture-helpers.test.mjs";

const roots = [];
const appId = "betaco-deals";
// Several real builds, starts and stops per test.
const TEST_TIMEOUT_MS = 120_000;

afterAll(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }).catch(() => {});
});

async function createBuiltModuleFixture({ kind = "static", version = "v1" } = {}) {
  const port = await findFreePort();
  const root = await createLaunchpadGitFixture();
  roots.push(root);
  const orgRoot = join(root, "organizations", "BetaCo_GEN3");
  const companyPath = join(orgRoot, "company.gen3.json");
  const company = JSON.parse(await readFile(companyPath, "utf8"));
  company.module_port_pool = { start: port, end: port };
  await writeJson(companyPath, company);
  const moduleRoot = join(orgRoot, "workspace", "deals");
  await initGitRepo(moduleRoot, { remotePath: join(root, "remotes", "deals.git") });
  await writeFile(join(moduleRoot, ".gitignore"), "db\n.worktrees/\napp/dist/\napp/runs/\n");
  await writeJson(join(moduleRoot, "lazurio.module.json"), {
    schema_version: "lazurio.module.v1",
    id: "deals",
    company: "BetaCo",
    tcp_port_policy: { mode: "single" },
    port_leases: [{ id: "main", host: "127.0.0.1", port }],
    apps: ["app/package.json"],
    default_app: "app/package.json",
  });
  const appRoot = join(moduleRoot, "app");
  await writeJson(join(appRoot, "package.json"), {
    name: appId,
    private: true,
    type: "module",
    scripts: {
      dev: "bun --no-env-file dev.mjs",
      build: "bun --no-env-file build.mjs",
      ...(kind === "server" ? { start: "bun --no-env-file server.mjs" } : {}),
    },
    lazurio: {
      runtime: {
        schema_version: "lazurio.runtime.v1",
        id: appId,
        title: "BetaCo Deals",
        company: "BetaCo",
        module: "deals",
        surface: "internal",
        dev_script: "dev",
        build_script: "build",
        build_output: "dist",
        ...(kind === "server" ? { start_script: "start" } : {}),
        tags: [],
        listeners: [{ id: "web", role: "entrypoint", lease: "main", protocol: "http", health: { kind: "http", path: "/" } }],
      },
    },
  });
  const listen = [
    "hostname: process.env.LAZURIO_RUNTIME_LISTENER_WEB_HOST,",
    "port: Number(process.env.LAZURIO_RUNTIME_LISTENER_WEB_PORT),",
  ].join(" ");
  await writeFile(join(appRoot, "version.txt"), version);
  await writeFile(join(appRoot, "build.mjs"), [
    'import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";',
    'const version = (await readFile("version.txt", "utf8")).trim();',
    'await mkdir("runs", { recursive: true });',
    'await appendFile("runs/builds.txt", `${version}\\n`);',
    'if (version.startsWith("broken")) { console.error("the build is broken"); process.exit(1); }',
    'await mkdir("dist", { recursive: true });',
    'await writeFile("dist/index.html", `<h1>${version}</h1>`);',
  ].join("\n"));
  await writeFile(join(appRoot, "dev.mjs"), [
    'import { mkdir, writeFile } from "node:fs/promises";',
    'await mkdir("runs", { recursive: true });',
    'await writeFile("runs/dev-ran.txt", "dev");',
    `Bun.serve({ ${listen} fetch: () => new Response("dev") });`,
  ].join("\n"));
  await writeFile(join(appRoot, "server.mjs"), [
    'import { readFile } from "node:fs/promises";',
    "const output = process.env.LAZURIO_RUNTIME_BUILD_OUTPUT ?? null;",
    `Bun.serve({ ${listen} fetch: async () => Response.json({`,
    "  nodeEnv: process.env.NODE_ENV ?? null,",
    "  output,",
    '  client: output ? await readFile(`${output}/index.html`, "utf8") : null,',
    "}) });",
  ].join("\n"));
  runGit(["add", "."], moduleRoot);
  runGit(["commit", "-m", "deals app"], moduleRoot);
  runGit(["push", "origin", "main"], moduleRoot);

  const cacheRoot = join(root, "cache");
  return {
    root,
    port,
    orgRoot,
    moduleRoot,
    appRoot,
    cacheRoot,
    url: `http://127.0.0.1:${port}`,
    runtime: (options = {}) => createRuntimeManager({
      companiesRoot: root,
      launchpadRoot: join(root, "launchpad"),
      instanceId: `built-${kind}`,
      buildCacheRoot: cacheRoot,
      ...options,
    }),
    head: () => runGit(["rev-parse", "HEAD"], moduleRoot).trim(),
    commit: async (next) => {
      await writeFile(join(appRoot, "version.txt"), next);
      runGit(["commit", "-am", next], moduleRoot);
      runGit(["push", "origin", "main"], moduleRoot);
      return runGit(["rev-parse", "HEAD"], moduleRoot).trim();
    },
    builds: async () => (await readFile(join(appRoot, "runs", "builds.txt"), "utf8").catch(() => ""))
      .split("\n").filter(Boolean),
    devRan: () => existsSync(join(appRoot, "runs", "dev-ran.txt")),
  };
}

test("a static App from main builds on its first Open, reuses it, rebuilds after a commit and keeps it on a broken one", async () => {
  const fixture = await createBuiltModuleFixture();
  const runtime = fixture.runtime();
  try {
    const v1 = fixture.head();
    const first = await runtime.open(appId);
    expect(first.url).toBe(fixture.url);
    expect(first.build).toMatchObject({ mode: "static", key: v1, commit: v1 });
    expect(first.build.finding).toBeUndefined();
    expect(await body(`${fixture.url}/`)).toBe("<h1>v1</h1>");
    expect(await fixture.builds()).toEqual(["v1"]);
    const outputs = await keyDirectories(fixture.cacheRoot);
    expect(outputs).toEqual([v1]);
    expect((await runtime.health(appId)).build).toMatchObject({ mode: "static", key: v1 });

    // The second Open reuses the running build: no build, the same process.
    const second = await runtime.open(appId);
    expect(second.steps.map((step) => step.step)).toEqual(["reuse"]);
    expect(second.runtime.pid).toBe(first.runtime.pid);
    expect(await fixture.builds()).toEqual(["v1"]);

    // A new commit: the next Open builds it and restarts the App onto it.
    const v2 = await fixture.commit("v2");
    const third = await runtime.open(appId);
    expect(third.steps.map((step) => step.step)).toEqual(["rebuilt", "start"]);
    expect(third.build).toMatchObject({ mode: "static", key: v2 });
    expect(third.runtime.pid).not.toBe(first.runtime.pid);
    expect(await body(`${fixture.url}/`)).toBe("<h1>v2</h1>");
    expect(await fixture.builds()).toEqual(["v1", "v2"]);

    // A broken commit: the build fails, the running v2 keeps serving.
    const broken = await fixture.commit("broken");
    const fourth = await runtime.open(appId);
    expect(fourth.steps.map((step) => step.step)).toEqual(["reuse"]);
    expect(fourth.runtime.pid).toBe(third.runtime.pid);
    expect(fourth.build).toMatchObject({
      key: v2,
      finding: {
        reason: "build-script-failed",
        key: broken,
        message: "Nejnovější verzi se nepodařilo sestavit. Dál běží předchozí verze.",
      },
    });
    expect(await readFile(fourth.build.finding.log_path, "utf8")).toContain("the build is broken");
    expect(await body(`${fixture.url}/`)).toBe("<h1>v2</h1>");
    // The recorded failure is not built again by another Open of the running App.
    await runtime.open(appId);
    expect(await fixture.builds()).toEqual(["v1", "v2", "broken"]);

    // Stopped and opened again, it starts as the previous build with the finding.
    await runtime.stop(appId);
    const fifth = await runtime.open(appId);
    expect(fifth.build).toMatchObject({ mode: "static", key: v2, finding: { reason: "build-script-failed", key: broken } });
    expect(await body(`${fixture.url}/`)).toBe("<h1>v2</h1>");
    expect(fixture.devRan()).toBe(false);
  } finally {
    await runtime.shutdown();
  }
}, TEST_TIMEOUT_MS);

test("with no build at all, a static App from main is not started and its dev script never runs", async () => {
  const fixture = await createBuiltModuleFixture({ version: "broken" });
  const runtime = fixture.runtime();
  try {
    const failure = await runtime.open(appId).catch((error) => error);
    expect(failure).toMatchObject({
      code: "app_build_unavailable",
      metadata: { failure_kind: "build_unavailable", build: { mode: "static", finding: { reason: "build-script-failed" } } },
    });
    expect(failure.message).toContain("Aplikaci se nepodařilo sestavit.");
    expect(failure.message).toContain("Na vašem počítači");
    expect(fixture.devRan()).toBe(false);
    const health = await runtime.health(appId);
    expect(health).toMatchObject({ status: "stopped", managed: false, failure_kind: "build_unavailable" });
    expect(await fetch(`${fixture.url}/`).then(() => "answered", () => "refused")).toBe("refused");
  } finally {
    await runtime.shutdown();
  }
}, TEST_TIMEOUT_MS);

test("an App with its own server starts its start_script in production with its built client", async () => {
  const fixture = await createBuiltModuleFixture({ kind: "server" });
  const runtime = fixture.runtime();
  try {
    const opened = await runtime.open(appId);
    const key = fixture.head();
    expect(opened.build).toMatchObject({ mode: "server", key });
    const answer = await (await fetch(`${fixture.url}/`)).json();
    expect(answer.nodeEnv).toBe("production");
    expect(answer.client).toBe("<h1>v1</h1>");
    const output = await realpath(answer.output);
    const cache = await realpath(fixture.cacheRoot);
    expect(relative(cache, output).split(sep)).toEqual(["BetaCo", "deals", expect.stringMatching(/^betaco-deals-[0-9a-f]{12}$/), key]);
    expect(fixture.devRan()).toBe(false);
  } finally {
    await runtime.shutdown();
  }
}, TEST_TIMEOUT_MS);

test("a worktree source keeps running its dev script", async () => {
  const fixture = await createBuiltModuleFixture();
  const slug = "DEV-9100-preview";
  const worktreePath = join(fixture.moduleRoot, ".worktrees", "root", slug);
  runGit(["worktree", "add", "-b", `codex/${slug}`, worktreePath], fixture.moduleRoot);
  const relativeWorktree = relative(fixture.root, worktreePath).split(sep).join("/");
  const runtime = fixture.runtime({
    buildWorktreeIndexFn: async () => ({
      worktrees: [{
        slug,
        module: "deals",
        module_path: "workspace/deals",
        path: relativeWorktree,
        branch: `codex/${slug}`,
        plan_code: "DEV-9100",
        owner_plan: { title: "Preview" },
        ownership_status: "owned",
        status: "active",
        metadata: {},
      }],
    }),
  });
  const source = { type: "worktree", slug };
  try {
    const opened = await runtime.open(appId, { source });
    expect(opened.build).toBeUndefined();
    expect(await body(`${fixture.url}/`)).toBe("dev");
    expect(existsSync(join(worktreePath, "app", "runs", "dev-ran.txt"))).toBe(true);
    expect(existsSync(join(worktreePath, "app", "runs", "builds.txt"))).toBe(false);
    expect(existsSync(fixture.cacheRoot)).toBe(false);
    await runtime.stop(appId, { source });
  } finally {
    await runtime.shutdown();
  }
}, TEST_TIMEOUT_MS);

test("lazurio update builds the new key of a moved built App and leaves the running App alone", async () => {
  const fixture = await createBuiltModuleFixture();
  const runtime = fixture.runtime();
  const runtimeRoot = await mkdtemp(join(tmpdir(), "lazurio-update-runtime-"));
  roots.push(runtimeRoot);
  try {
    const first = await runtime.open(appId);
    const v2 = await fixture.commit("v2");
    const organization = {
      key: "BetaCo::root",
      repo_kind: "organization_root",
      organization: "BetaCo",
      module: "root",
      workspace: null,
      repo_path: "organizations/BetaCo_GEN3",
      absolute_path: fixture.orgRoot,
      expected_branch: "main",
    };
    const moduleRepo = {
      key: "BetaCo::deals",
      repo_kind: "module",
      organization: "BetaCo",
      module: "deals",
      workspace: "workspace",
      repo_path: "organizations/BetaCo_GEN3/workspace/deals",
      absolute_path: fixture.moduleRoot,
      expected_branch: "main",
    };
    const moved = (item) => item.key === moduleRepo.key;
    const report = await runLazurioUpdate({
      rootPath: fixture.root,
      runtimeRoot,
      deps: {
        acquireLock: async () => ({ release: async () => {} }),
        sshSharing: null,
        buildInventory: async () => ({ repos: [organization, moduleRepo], warnings: [] }),
        // The fast-forward itself is the commit above; the update sees it moved.
        updateRepo: async (item) => ({
          repo_key: item.key,
          repo_kind: item.repo_kind,
          organization: item.organization,
          module: item.module,
          path: item.repo_path,
          state: moved(item) ? "updated" : "current",
          actions: moved(item) ? ["fast_forward"] : [],
          message: "fixture",
        }),
        buildCacheRoot: fixture.cacheRoot,
      },
    });
    const result = report.results.find((item) => item.repo_key === moduleRepo.key);
    expect(result).toMatchObject({
      state: "updated",
      actions: expect.arrayContaining(["fast_forward", "apps_built"]),
      builds: [{ app_id: appId, state: "built", key: v2 }],
    });
    expect(await fixture.builds()).toEqual(["v1", "v2"]);
    // Not restarted: the running App still serves v1 from the same process.
    const health = await runtime.health(appId);
    expect(health).toMatchObject({ status: "healthy", pid: first.runtime.pid, build: { key: first.build.key } });
    expect(await body(`${fixture.url}/`)).toBe("<h1>v1</h1>");
    // The next Open restarts onto the new build without building again.
    const reopened = await runtime.open(appId);
    expect(reopened.build).toMatchObject({ key: v2 });
    expect(await body(`${fixture.url}/`)).toBe("<h1>v2</h1>");
    expect(await fixture.builds()).toEqual(["v1", "v2"]);
  } finally {
    await runtime.shutdown();
  }
}, TEST_TIMEOUT_MS);

async function keyDirectories(cacheRoot) {
  const appDirectory = join(cacheRoot, "BetaCo", "deals");
  const [entry] = await readdir(appDirectory);
  return (await readdir(join(appDirectory, entry))).filter((name) => /^[0-9a-f]{40}$/.test(name));
}

async function body(url) {
  return (await fetch(url)).text();
}

async function findFreePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolvePort(port));
    });
  });
}
