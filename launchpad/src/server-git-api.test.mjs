import { afterAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, realpathSync } from "fs";
import { cp, mkdir, readFile, rm, symlink, writeFile } from "fs/promises";
import { createServer } from "net";
import { join } from "path";
import {
  createLaunchpadGitFixture,
  createPackageApp,
  initGitRepo,
  runGit,
  startConflictingGitAm,
  startConflictingRebase,
  writeJson,
} from "./git-fixture-helpers.test.mjs";
import { platformTestTimeout } from "./test-platform-setup.mjs";
import { computeServerRootId } from "../../lazurio/core/server-identity-lib.mjs";
import { runModuleLifecycle } from "../../lazurio/core/module-lifecycle-client-lib.mjs";
import {
  readServerLocator,
  readServerLocatorIfPresent,
  resolveServerStateDirectory,
  serverLocatorPath,
  writeServerLocator,
} from "../../lazurio/core/server-locator-lib.mjs";
import {
  buildDesiredModuleState,
  readDesiredModuleState,
  writeDesiredModuleState,
} from "./desired-module-state-lib.mjs";
import {
  acquireServerLifetimeLock,
  acquireServerStartupLock,
} from "./server-lifetime-lock-lib.mjs";
import { moduleRuntimeLockName } from "./module-runtime-lock-lib.mjs";
import { launchpadFallbackUrls } from "./server-startup-lib.mjs";

const tempRoots = [];
const servers = [];
const allocatedFixturePorts = new Set();
const serverFallbackPortSpan = launchpadFallbackUrls({ startPort: 1 }).length;

afterAll(async () => {
  // Počkej, až servery opravdu skončí — kill() jen pošle SIGTERM a nečeká na
  // uvolnění portu, takže bez await by port mohl přežít do dalšího test filu.
  await Promise.all(
    servers.map((server) => {
      server.kill();
      return server.exited;
    }),
  );
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
});

test("Launchpad server exposes read-only git and Mission Control routes", async () => {
  const root = await createLaunchpadGitFixture();
  tempRoots.push(root);
  const dealsRepo = join(root, "organizations", "BetaCo_GEN3", "workspace", "deals");
  await initGitRepo(dealsRepo);
  await writeFile(join(dealsRepo, "draft.md"), "local draft\n");
  const omegacoRoot = join(root, "organizations", "OmegaCo_GEN3");
  await writeJson(join(omegacoRoot, "modules.manifest.json"), {
    organization_generation: "gen3",
    company: "OmegaCo",
    github_org: "OmegaCo",
    module_slots: [
      {
        path: "productionspace/firmware",
        category: "firmware",
        repo: "git@github.com:OmegaCo/firmware.git",
        branch: "main",
      },
    ],
  });
  await initGitRepo(join(omegacoRoot, "productionspace", "firmware"));
  const { port } = await startLaunchpadServer(root);

  const repos = await getJson(port, "/api/git/repos");
  const deals = await getJson(port, "/api/git/repos/BetaCo%3A%3Adeals");
  const changes = await getJson(port, "/api/git/repos/BetaCo%3A%3Adeals/changes");
  const blockedPull = await postJson(port, "/api/git/repos/BetaCo%3A%3Adeals/pull", {});
  const blockedAutostashPull = await postJson(port, "/api/git/repos/BetaCo%3A%3Adeals/pull-autostash", {});
  const blockedProductionPull = await postJson(port, "/api/git/repos/OmegaCo%3A%3Afirmware/pull", {});
  const pullAll = await postJson(port, "/api/git/pull-all", {});
  const scopedPull = await postJson(port, "/api/git/pull-all?company=BetaCo", {});
  const worktrees = await getJson(port, "/api/git/worktrees?organization=BetaCo&module=deals");
  const plans = await getJson(port, "/api/mission-control/plans?organization=BetaCo&module=deals");
  const moduleFolderGet = await fetch(`http://127.0.0.1:${port}/api/modules/open-folder`);
  const invalidModuleFolderPost = await fetch(`http://127.0.0.1:${port}/api/modules/open-folder`, { method: "POST" });

  expect(repos.schema_version).toBe("companiesascode.launchpad.git.v1");
  expect(deals.repo.key).toBe("BetaCo::deals");
  expect(deals.repo.status).toBe("draft_changes");
  expect(changes.changes[0]).toMatchObject({ path: "draft.md", porcelain: "??" });
  for (const report of [blockedPull, blockedAutostashPull, blockedProductionPull, pullAll, scopedPull]) {
    expect(report.schema_version).toBe("lazurio.update.v1");
    expect(["current", "updated", "blocked"]).toContain(report.state);
  }
  expect(JSON.stringify(pullAll)).not.toContain("OmegaCo::firmware");
  expect(scopedPull.results).toEqual(pullAll.results);
  expect(worktrees.schema_version).toBe("companiesascode.launchpad.worktrees.v1");
  expect(plans.schema_version).toBe("companiesascode.launchpad.mission_control_plans.v1");
  expect(moduleFolderGet.status).toBe(405);
  expect(invalidModuleFolderPost.status).toBe(400);
});

test("fixture ports cannot overlap another Server fallback window", () => {
  expect(fixturePortsOverlap(39_019, 39_019 + serverFallbackPortSpan - 1)).toBe(true);
  expect(fixturePortsOverlap(39_019, 39_019 + serverFallbackPortSpan)).toBe(false);
});

test("public Module lifecycle client drives one physical Server-owned App", async () => {
  const root = await createLaunchpadGitFixture();
  tempRoots.push(root);
  const appPort = await findFreePort();
  const moduleRoot = join(root, "organizations", "BetaCo_GEN3", "workspace", "deals");
  const appRoot = join(moduleRoot, "app", "v1");
  const organizationManifestPath = join(root, "organizations", "BetaCo_GEN3", "company.gen3.json");
  const organizationManifest = JSON.parse(await readFile(organizationManifestPath, "utf8"));
  organizationManifest.module_port_pool = { start: appPort, end: appPort };
  await writeJson(organizationManifestPath, organizationManifest);
  await writeJson(join(moduleRoot, "lazurio.module.json"), {
    schema_version: "lazurio.module.v1",
    id: "deals",
    company: "BetaCo",
    tcp_port_policy: { mode: "single" },
    apps: ["app/v1/package.json"],
    default_app: "app/v1/package.json",
    port_leases: [{ id: "main", host: "127.0.0.1", port: appPort }],
  });
  await writeJson(join(appRoot, "package.json"), {
    name: "betaco-deals",
    private: true,
    type: "module",
    scripts: { dev: "bun server.mjs" },
    lazurio: {
      runtime: {
        schema_version: "lazurio.runtime.v1",
        id: "betaco-deals-v1",
        title: "BetaCo Deals",
        company: "BetaCo",
        module: "deals",
        surface: "internal",
        dev_script: "dev",
        tags: [],
        listeners: [{
          id: "app",
          role: "entrypoint",
          lease: "main",
          protocol: "http",
          health: { kind: "http", path: "/health" },
        }],
      },
    },
  });
  await writeFile(join(appRoot, "server.mjs"), [
    "const server = Bun.serve({",
    "  hostname: process.env.LAZURIO_RUNTIME_HOST,",
    "  port: Number(process.env.LAZURIO_RUNTIME_PORT),",
    "  fetch: (request) => new URL(request.url).pathname === '/health'",
    "    ? Response.json({ status: 'ok' })",
    "    : new Response('fixture'),",
    "});",
    "setInterval(() => {}, 2_147_483_647);",
    "",
  ].join("\n"));
  await mkdir(join(appRoot, "node_modules"), { recursive: true });

  const { serverStateDirectory } = await startLaunchpadServer(root);
  const run = (action) => runModuleLifecycle({
    action,
    selector: "BetaCo/deals",
    stateDirectory: serverStateDirectory,
  });

  const status = await run("status");
  expect(status).toMatchObject({
    status: "current",
    app: { app_id: "betaco-deals-v1", port: appPort, default: true },
  });
  const opened = await run("open");
  expect(opened).toMatchObject({
    status: "completed",
    result: { action: "open", url: `http://127.0.0.1:${appPort}` },
  });
  const firstPid = opened.result.runtime.pid;
  expect(Number.isInteger(firstPid)).toBe(true);
  expect((await fetch(`http://127.0.0.1:${appPort}/health`)).status).toBe(200);
  const repeated = await run("open");
  expect(repeated.result.runtime.pid).toBe(firstPid);
  const stopped = await run("stop");
  expect(stopped).toMatchObject({ status: "completed", result: { action: "stop" } });
  await waitForPortVacancy(appPort);
}, platformTestTimeout(20_000));

test("public read routes do not expose an unmaterialized protected repo through changes or worktrees", async () => {
  const root = await createLaunchpadGitFixture();
  tempRoots.push(root);
  const orgRoot = join(root, "organizations", "BetaCo_GEN3");
  const manifestPath = join(orgRoot, "modules.manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const knowledgebase = manifest.module_slots.find((slot) => slot.path === "workspace/knowledgebase");
  knowledgebase.default_access = "restricted";
  knowledgebase.required_roles = ["knowledge"];
  await writeJson(manifestPath, manifest);

  const worktreeRoot = join(orgRoot, ".worktrees", "workspace", "knowledgebase");
  await initGitRepo(join(worktreeRoot, "protected-review"), { branch: "protected-review" });
  await writeJson(join(worktreeRoot, "protected-review.worktree.json"), {
    schema_version: "companiesascode.worktree.v1",
    organization: "BetaCo",
    organization_path: "organizations/BetaCo_GEN3",
    workspace: "workspace",
    module: "knowledgebase",
    module_path: "workspace/knowledgebase",
    repo_kind: "module",
    base_branch: "main",
    branch: "protected-review",
    mission_control_plan_code: "DEV-9999",
    mission_control_plan_path: "mission-control/plans/2026/07/DEV-9999-protected.yaml",
    created_at: new Date().toISOString(),
    created_by: "fixture-agent",
    status: "active",
  });
  await writeFile(
    join(orgRoot, "mission-control", "plans", "2026", "07", "DEV-9999-protected.yaml"),
    "dev_code: DEV-9999\ntitle: Protected worktree\nstatus: in_progress\nlinks:\n  - path: workspace/knowledgebase\n",
  );
  await writeFile(
    join(orgRoot, "mission-control", "plans", "2026", "07", "DEV-9000-visible.yaml"),
    "dev_code: DEV-9000\ntitle: Visible deals plan\nstatus: ready\nlinks:\n  - path: workspace/deals\n",
  );
  const { port } = await startLaunchpadServer(root);

  const repos = await getJson(port, "/api/git/repos?company=BetaCo");
  expect(repos.repos.some((repo) => repo.key === "BetaCo::knowledgebase")).toBe(false);
  expect(repos.worktrees).toEqual([]);
  expect(repos.summary.worktree_count).toBe(0);
  expect(JSON.stringify(repos)).not.toContain("protected-review");

  const worktrees = await getJson(port, "/api/git/worktrees?organization=BetaCo&module=knowledgebase");
  expect(worktrees.worktrees).toEqual([]);
  expect(worktrees.warnings).toEqual([]);
  expect(JSON.stringify(worktrees)).not.toContain("protected-review");

  const plans = await getJson(port, "/api/mission-control/plans?organization=BetaCo&module=knowledgebase");
  expect(plans.plans).toEqual([]);

  const organizationPlans = await getJson(port, "/api/mission-control/plans?organization=BetaCo");
  expect(organizationPlans.plans.map((plan) => plan.code)).toEqual(["DEV-9000"]);
  expect(JSON.stringify(organizationPlans)).not.toContain("DEV-9999");
  expect(JSON.stringify(organizationPlans)).not.toContain("Protected worktree");
  expect(JSON.stringify(organizationPlans)).not.toContain("DEV-9999-protected.yaml");
  expect(JSON.stringify(organizationPlans)).not.toContain('"status":"in_progress"');

  const detailResponse = await fetch(
    `http://127.0.0.1:${port}/api/git/repos/BetaCo%3A%3Aknowledgebase`,
  );
  expect(detailResponse.status).toBe(404);
  expect(await detailResponse.json()).toMatchObject({ error: "repo_not_found" });

  const changesResponse = await fetch(
    `http://127.0.0.1:${port}/api/git/repos/BetaCo%3A%3Aknowledgebase/changes`,
  );
  expect(changesResponse.status).toBe(404);
  const changes = await changesResponse.json();
  expect(changes).toMatchObject({ error: "repo_not_found" });
  expect(changes.repo_path).toBeUndefined();
});

test("module-scoped plan route fails closed on a visible and protected basename collision", async () => {
  const root = await createLaunchpadGitFixture();
  tempRoots.push(root);
  const orgRoot = join(root, "organizations", "BetaCo_GEN3");
  const manifestPath = join(orgRoot, "modules.manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.module_slots.push(
    {
      path: "workspace/shared-name",
      slug: "visible-shared",
      teams: ["sales"],
      repo: "git@github.com:BetaCo/shared-name.git",
      branch: "main",
    },
    {
      path: "modules/shared-name",
      slug: "hidden-shared",
      teams: ["knowledge"],
      default_access: "restricted",
      required_roles: ["knowledge"],
      repo: "git@github.com:BetaCo/shared-name.git",
      branch: "main",
    },
  );
  await writeJson(manifestPath, manifest);
  const plansRoot = join(orgRoot, "mission-control", "plans", "2026", "07");
  await writeFile(
    join(plansRoot, "DEV-7004-visible-shared.yaml"),
    "dev_code: DEV-7004\ntitle: Visible shared plan\nstatus: ready\nlinks:\n  - path: workspace/shared-name\n",
  );
  await writeFile(
    join(plansRoot, "DEV-7005-hidden-shared.yaml"),
    "dev_code: DEV-7005\ntitle: Restricted shared plan\nstatus: review\ncontext: This protected plan merely mentions workspace/shared-name and visible-shared.\nlinks:\n  - path: modules/shared-name\n",
  );
  const worktreeRoot = join(orgRoot, ".worktrees", "workspace", "shared-name");
  await initGitRepo(join(worktreeRoot, "protected-review"), { branch: "protected-review" });
  await writeJson(join(worktreeRoot, "protected-review.worktree.json"), {
    schema_version: "companiesascode.worktree.v1",
    organization: "BetaCo",
    organization_path: "organizations/BetaCo_GEN3",
    workspace: "workspace",
    // The visible stable ID conflicts with the protected canonical path.
    module: "visible-shared",
    module_path: "modules/shared-name",
    repo_kind: "module",
    base_branch: "main",
    branch: "protected-review",
    mission_control_plan_code: "DEV-7005",
    mission_control_plan_path: "mission-control/plans/2026/07/DEV-7005-hidden-shared.yaml",
    created_at: new Date().toISOString(),
    created_by: "fixture-agent",
    status: "active",
  });
  const { port } = await startLaunchpadServer(root);

  const repos = await getJson(port, "/api/git/repos?company=BetaCo");
  expect(repos.repos.some((repo) => repo.key === "BetaCo::visible-shared")).toBe(true);
  expect(repos.worktrees).toEqual([]);
  expect(JSON.stringify(repos)).not.toContain("protected-review");
  expect(JSON.stringify(repos)).not.toContain("DEV-7005-hidden-shared.yaml");

  const worktrees = await getJson(
    port,
    "/api/git/worktrees?organization=BetaCo&module=shared-name",
  );
  expect(worktrees.worktrees).toEqual([]);
  expect(worktrees.warnings).toEqual([]);
  expect(JSON.stringify(worktrees)).not.toContain("protected-review");
  expect(JSON.stringify(worktrees)).not.toContain("DEV-7005");

  const ambiguous = await getJson(
    port,
    "/api/mission-control/plans?organization=BetaCo&module=shared-name",
  );
  expect(ambiguous.plans).toEqual([]);
  expect(JSON.stringify(ambiguous)).not.toContain("DEV-7005");
  expect(JSON.stringify(ambiguous)).not.toContain("Restricted shared plan");
  expect(JSON.stringify(ambiguous)).not.toContain("modules/shared-name");
  expect(JSON.stringify(ambiguous)).not.toContain('"status":"review"');

  const visible = await getJson(
    port,
    "/api/mission-control/plans?organization=BetaCo&module=visible-shared",
  );
  expect(visible.plans.map((plan) => plan.code)).toEqual(["DEV-7004"]);
  expect(JSON.stringify(visible)).not.toContain("DEV-7005");

  const hidden = await getJson(
    port,
    "/api/mission-control/plans?organization=BetaCo&module=hidden-shared",
  );
  expect(hidden.plans).toEqual([]);
});

test("identity endpoint is local-only and a foreign root cannot reuse the port", async () => {
  const root = await createLaunchpadGitFixture();
  const otherRoot = await createLaunchpadGitFixture();
  tempRoots.push(root, otherRoot);
  const {
    server,
    port,
    environment: serverEnvironment,
    serverStateDirectory,
  } = await startLaunchpadServer(root);

  const legacyIdentity = await getJson(port, "/api/launchpad/identity");
  expect(legacyIdentity).toEqual({
    schema_version: "companiesascode.launchpad.identity.v1",
    root_id: legacyIdentity.root_id,
  });
  expect(legacyIdentity.root_id).toMatch(/^[a-f0-9]{64}$/);

  const identity = await getJson(port, "/api/lazurio/server-identity");
  expect(identity).toMatchObject({
    schema_version: "lazurio.server.identity.v1",
    product: "lazurio-launchpad-server",
    root_id: legacyIdentity.root_id,
    control_root_id: legacyIdentity.root_id,
    pid: server.pid,
  });
  expect(identity.install_generation).toMatch(/^[a-f0-9]{64}$/);
  expect(identity.instance_id).toMatch(/^[a-f0-9-]{36}$/);
  expect(Number.isFinite(Date.parse(identity.started_at))).toBe(true);
  expect(await readServerLocator({ stateDirectory: serverStateDirectory })).toMatchObject({
    schema_version: "lazurio.server.locator.v1",
    origin: `http://127.0.0.1:${port}`,
    root_id: identity.root_id,
    control_root_id: identity.control_root_id,
    instance_id: identity.instance_id,
    install_generation: identity.install_generation,
  });

  const crossOriginIdentity = await fetch(`http://127.0.0.1:${port}/api/launchpad/identity`, {
    headers: { origin: "https://evil.invalid", "sec-fetch-site": "cross-site" },
  });
  expect(crossOriginIdentity.status).toBe(403);
  const crossOriginServerIdentity = await fetch(`http://127.0.0.1:${port}/api/lazurio/server-identity`, {
    headers: { origin: "https://evil.invalid", "sec-fetch-site": "cross-site" },
  });
  expect(crossOriginServerIdentity.status).toBe(403);
  const crossOriginShutdown = await fetch(`http://127.0.0.1:${port}/api/lazurio/server-shutdown`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "https://evil.invalid",
      "sec-fetch-site": "cross-site",
    },
    body: JSON.stringify({ instance_id: identity.instance_id }),
  });
  expect(crossOriginShutdown.status).toBe(403);
  expect((await fetch(`http://127.0.0.1:${port}/health`)).status).toBe(200);

  const sameRootLauncher = Bun.spawn(
    ["bun", "src/server.mjs", "--root", root, "--port", String(port), "--reuse"],
    {
      cwd: join(import.meta.dirname, ".."),
      env: serverEnvironment,
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  expect(await sameRootLauncher.exited).toBe(0);
  expect(await new Response(sameRootLauncher.stdout).text()).toContain("používám existující instanci");
  expect((await getJson(port, "/api/lazurio/server-identity")).instance_id).toBe(identity.instance_id);
  expect((await readServerLocator({ stateDirectory: serverStateDirectory })).instance_id).toBe(identity.instance_id);

  const otherRootLauncher = Bun.spawn(
    ["bun", "src/server.mjs", "--root", otherRoot, "--port", String(port), "--open"],
    {
      cwd: join(import.meta.dirname, ".."),
      env: serverEnvironment,
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  expect(await otherRootLauncher.exited).not.toBe(0);
  expect(await new Response(otherRootLauncher.stderr).text()).toContain("jiný Root");
});

test("the lifetime lease blocks a second Server even when its locator was removed", async () => {
  const root = await createLaunchpadGitFixture();
  tempRoots.push(root);
  const primary = await startLaunchpadServer(root);
  await rm(join(primary.serverStateDirectory, "server.json"));
  let candidatePort = await findFreePort();
  while (Math.abs(candidatePort - primary.port) < 25) candidatePort = await findFreePort();

  const contender = Bun.spawn(
    ["bun", "src/server.mjs", "--root", root, "--port", String(candidatePort), "--reuse"],
    {
      cwd: join(import.meta.dirname, ".."),
      env: primary.environment,
      stdout: "ignore",
      stderr: "pipe",
    },
  );
  servers.push(contender);
  expect(await contender.exited).not.toBe(0);
  expect(await new Response(contender.stderr).text()).toContain("per-user lifetime lease");
  expect((await getJson(primary.port, "/health")).status).toBe("ok");
});

test("a reuse launcher restores a deleted locator for the requested-port Server", async () => {
  const root = await createLaunchpadGitFixture();
  tempRoots.push(root);
  const primary = await startLaunchpadServer(root, { useDefaultStateRoot: true });
  const identity = await getJson(primary.port, "/api/lazurio/server-identity");
  await rm(join(primary.serverStateDirectory, "server.json"));

  const recovery = Bun.spawn(
    ["bun", "src/server.mjs", "--root", root, "--port", String(primary.port), "--reuse"],
    {
      cwd: join(import.meta.dirname, ".."),
      env: primary.environment,
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  expect(await recovery.exited).toBe(0);
  expect(await new Response(recovery.stdout).text()).toContain("používám existující instanci");
  expect(await readServerLocator({ stateDirectory: primary.serverStateDirectory })).toMatchObject({
    origin: `http://127.0.0.1:${primary.port}`,
    instance_id: identity.instance_id,
  });
  expect((await getJson(primary.port, "/health")).status).toBe("ok");
});

test("linked worktree gets only a read-only canonical Root mount context", async () => {
  const root = await createLaunchpadGitFixture();
  const guidePort = await findFreePort();
  const primaryConfigPath = join(root, "launchpad.gen3.json");
  const primaryConfig = JSON.parse(await readFile(primaryConfigPath, "utf8"));
  primaryConfig.personalspace_mountpoint = "ignored-personalspace";
  primaryConfig.local_surfaces = [{ path: "guide", kind: "shared-guide" }];
  await writeJson(primaryConfigPath, primaryConfig);
  await createPackageApp({
    root,
    packagePath: "guide/app/v1",
    app: {
      id: "test-root-guide-v1",
      title: "Fixture Guide",
      company: "test-root",
      module: "guide",
      port: guidePort,
    },
  });
  const guidePackagePath = join(root, "guide", "app", "v1", "package.json");
  const guidePackage = JSON.parse(await readFile(guidePackagePath, "utf8"));
  guidePackage.dependencies = { "worktree-only-fixture": "1.0.0" };
  await writeJson(guidePackagePath, guidePackage);
  await mkdir(join(root, "manual"), { recursive: true });
  await writeFile(join(root, "launchpad", ".fixture"), "tracked fixture\n");
  await writeFile(join(root, "manual", ".fixture"), "tracked fixture\n");
  await initGitRepo(root);
  runGit(["add", "."], root);
  runGit(["commit", "-m", "track fixture Root"], root);
  await writeJson(join(root, "launchpad.gen3.local.json"), { personalspace_owner: "fixtureowner" });
  const personalspaceRoot = join(root, "personalspace", "fixtureowner_GEN3");
  await mkdir(join(personalspaceRoot, "workspace"), { recursive: true });
  await writeJson(join(personalspaceRoot, "personal.gen3.json"), {
    personal_generation: "gen3",
    owner: { github_username: "fixtureowner", display_name: "Fixture Owner", type: "human" },
    repository: {
      github_repo: "fixtureowner/fixtureowner_GEN3",
      mount_path: "personalspace/fixtureowner_GEN3",
      visibility: "private",
    },
    privacy: {
      default_share: "private",
      agent_boundary: "personal-context-only",
      shared_outputs: "metadata-only",
    },
    modules_manifest_path: "modules.manifest.json",
    workspace_path: "workspace",
    gbrain: { path: "gbrain", default_shared: false, human_editor: "obsidian", agent_access: "mcp-only" },
    secrets: {
      path: "secrets",
      custody_pattern: "personalspace/<owner>_GEN3/secrets/<provider>/<scope>/<purpose>",
      git: "ignored",
    },
    shared_spaces: [],
  });
  await writeJson(join(personalspaceRoot, "modules.manifest.json"), {
    personal_generation: "gen3",
    owner: "fixtureowner",
    module_slots: [],
  });
  const primaryStatusBefore = runGit(["status", "--short"], root);
  const primary = await startLaunchpadServer(root, { useDefaultStateRoot: true });
  const worktreeRoot = `${root}-linked-worktree`;
  runGit(["worktree", "add", "-b", "linked-launchpad", worktreeRoot], root);
  tempRoots.push(worktreeRoot, root);
  const worktreeConfigPath = join(worktreeRoot, "launchpad.gen3.json");
  const worktreeConfig = JSON.parse(await readFile(worktreeConfigPath, "utf8"));
  worktreeConfig.launchpad_root.display_name = "Linked Root";
  worktreeConfig.personalspace_mountpoint = "personalspace";
  await writeJson(worktreeConfigPath, worktreeConfig);
  await writeFile(join(worktreeRoot, "guide", "app", "v1", "server.mjs"), [
    "const server = Bun.serve({",
    '  hostname: process.env.HOST ?? "127.0.0.1",',
    "  port: Number(process.env.PORT),",
    '  fetch: () => Response.json({ status: "ok" }),',
    "});",
    "setInterval(() => {}, 2_147_483_647);",
    "",
  ].join("\n"));
  await mkdir(join(worktreeRoot, "guide", "app", "v1", "node_modules"), { recursive: true });
  await rm(join(worktreeRoot, "organizations"), { recursive: true, force: true });
  await mkdir(join(worktreeRoot, "organizations"), { recursive: true });

  const { port } = await startLaunchpadServer(worktreeRoot, {
    env: primary.environment,
    useDefaultStateRoot: true,
  });
  expect(await primary.server.exited).toBe(0);
  const identity = await getJson(port, "/api/lazurio/server-identity");
  expect(identity.root_id).toBe(computeServerRootId(realpathSync.native(root)));
  expect(identity.control_root_id).toBe(computeServerRootId(realpathSync.native(worktreeRoot)));
  expect(identity.control_root_id).not.toBe(identity.root_id);
  const apps = await getJson(port, "/api/apps");
  expect(apps.launchpad_root.display_name).toBe("Linked Root");
  expect(apps.root).toBe(realpathSync.native(root));
  expect(apps.control_root).toBe(realpathSync.native(worktreeRoot));
  expect(apps.organizations.length).toBeGreaterThan(0);
  expect(apps.apps.find((app) => app.id === "test-root-guide-v1")?.dependency_status).toBe("ready");
  const personalspace = await getJson(port, "/api/personalspace");
  expect(personalspace.primary_owner).toBe("fixtureowner");
  expect(personalspace.summary.space_count).toBe(1);

  const startResponse = await fetch(`http://127.0.0.1:${port}/api/apps/test-root-guide-v1/start`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  const started = await startResponse.json();
  expect({ status: startResponse.status, payload: started }).toEqual({
    status: 200,
    payload: expect.objectContaining({ action: "start" }),
  });
  expect(existsSync(join(root, "launchpad", "logs", "apps", "test-root-guide-v1.log"))).toBe(true);
  expect(existsSync(join(worktreeRoot, "launchpad", "logs", "apps", "test-root-guide-v1.log"))).toBe(false);
  expect((await getJson(port, "/api/apps/test-root-guide-v1/health")).status).toBe("healthy");
  expect((await postJson(port, "/api/apps/test-root-guide-v1/open", {})).action).toBe("open");
  expect(existsSync(join(root, "launchpad", "runtime", "usage.json"))).toBe(true);
  expect(existsSync(join(worktreeRoot, "launchpad", "runtime", "usage.json"))).toBe(false);
  expect((await postJson(port, "/api/apps/test-root-guide-v1/stop", {})).action).toBe("stop");

  const mutation = await fetch(`http://127.0.0.1:${port}/api/sync`, { method: "POST" });
  expect(mutation.status).toBe(409);
  expect(await mutation.json()).toEqual({
    error: "worktree_mount_context_read_only",
    message: "Linked worktree smí canonical Lazurio Root používat jen jako read-only mount context.",
  });
  await rm(join(root, "launchpad", "logs"), { recursive: true, force: true });
  await rm(join(root, "launchpad", "runtime"), { recursive: true, force: true });
  expect(runGit(["status", "--short"], root)).toBe(primaryStatusBefore);
});

test("control-root replacement waits for an in-flight runtime mutation", async () => {
  const root = await createLaunchpadGitFixture();
  const appRoot = join(root, "organizations", "BetaCo_GEN3", "workspace", "deals", "app", "v1");
  await createPackageApp({
    root,
    packagePath: "organizations/BetaCo_GEN3/workspace/deals/app/v1",
    app: {
      id: "betaco-slow-install-v1",
      title: "Slow install",
      company: "BetaCo",
      module: "deals",
      port: 5418,
    },
  });
  const packagePath = join(appRoot, "package.json");
  const packageJson = JSON.parse(await readFile(packagePath, "utf8"));
  packageJson.scripts.preinstall = "bun slow-install.mjs";
  packageJson.dependencies = { "fixture-dependency": "file:./fixture-dependency" };
  await writeJson(packagePath, packageJson);
  await writeJson(join(appRoot, "fixture-dependency", "package.json"), {
    name: "fixture-dependency",
    version: "1.0.0",
  });
  await writeFile(
    join(appRoot, "slow-install.mjs"),
    'await Bun.write("install.started", "started\\n");\nawait Bun.sleep(1500);\n',
    "utf8",
  );
  const lockfileInstall = Bun.spawn(
    [process.execPath, "install", "--lockfile-only", "--ignore-scripts"],
    { cwd: appRoot, stdout: "pipe", stderr: "pipe" },
  );
  const [, , lockfileExitCode] = await Promise.all([
    new Response(lockfileInstall.stdout).text(),
    new Response(lockfileInstall.stderr).text(),
    lockfileInstall.exited,
  ]);
  expect(lockfileExitCode).toBe(0);

  await initGitRepo(root);
  runGit(["add", "."], root);
  runGit(["commit", "-m", "track slow install fixture"], root);
  const worktreeRoot = `${root}-linked-worktree`;
  runGit(["worktree", "add", "-b", "linked-slow-install", worktreeRoot], root);
  tempRoots.push(worktreeRoot, root);

  const primary = await startLaunchpadServer(root);
  const installRequest = fetch(`http://127.0.0.1:${primary.port}/api/apps/betaco-slow-install-v1/install`, {
    method: "POST",
  });
  const installMarker = join(appRoot, "install.started");
  for (let attempt = 0; attempt < 100 && !(await Bun.file(installMarker).exists()); attempt += 1) {
    await Bun.sleep(20);
  }
  expect(await Bun.file(installMarker).exists()).toBe(true);

  const candidatePort = await findFreePort();
  const replacement = Bun.spawn(
    ["bun", "src/server.mjs", "--root", worktreeRoot, "--port", String(candidatePort), "--reuse"],
    {
      cwd: join(import.meta.dirname, ".."),
      env: primary.environment,
      stdout: "ignore",
      stderr: "pipe",
    },
  );
  expect(await replacement.exited).not.toBe(0);
  expect(await new Response(replacement.stderr).text()).toContain("nepodařilo bezpečně zastavit");

  const installResponse = await installRequest;
  expect(installResponse.status).toBe(200);
  expect((await getJson(primary.port, "/health")).status).toBe("ok");
});

test("control-root replacement waits until boot reconciliation publishes one ready locator", async () => {
  const root = await createLaunchpadGitFixture();
  const appPort = await findFreePort();
  const appRoot = join(root, "organizations", "BetaCo_GEN3", "workspace", "deals", "app", "v1");
  const app = {
    id: "betaco-boot-reconcile-v1",
    title: "Boot reconcile",
    company: "BetaCo",
    module: "deals",
    port: appPort,
  };
  await createPackageApp({
    root,
    packagePath: "organizations/BetaCo_GEN3/workspace/deals/app/v1",
    app,
  });
  const startedMarker = join(appRoot, "boot-reconcile.started");
  const completedMarker = join(appRoot, "boot-reconcile.completed");
  await writeFile(
    join(appRoot, "server.mjs"),
    [
      'await Bun.write("boot-reconcile.started", `${process.pid}\\n`);',
      "await Bun.sleep(1200);",
      "const server = Bun.serve({",
      '  hostname: process.env.HOST ?? "127.0.0.1",',
      "  port: Number(process.env.PORT),",
      '  fetch: () => new Response("ok"),',
      "});",
      'await Bun.write("boot-reconcile.completed", `${process.pid}\\n`);',
      "setTimeout(() => { server.stop(true); process.exit(0); }, 2000);",
      "setInterval(() => {}, 2_147_483_647);",
      "",
    ].join("\n"),
    "utf8",
  );
  await initGitRepo(root);
  runGit(["add", "."], root);
  runGit(["commit", "-m", "track boot reconcile fixture"], root);
  const worktreeRoot = `${root}-boot-worktree`;
  runGit(["worktree", "add", "-b", "linked-boot-reconcile", worktreeRoot], root);
  const stateRoot = `${root}-launchpad-state`;
  tempRoots.push(worktreeRoot, root, stateRoot);
  await writeDesiredModuleState({
    root: join(stateRoot, "runtime", "desired-modules"),
    state: buildDesiredModuleState({ app, source: { type: "main" } }),
  });

  const primaryPort = await findFreePort();
  const {
    environment: primaryEnvironment,
    serverStateDirectory,
  } = serverTestEnvironment(root, {
    LAZURIO_LAUNCHPAD_STATE_ROOT: stateRoot,
  });
  const primaryServer = Bun.spawn(
    ["bun", "src/server.mjs", "--root", root, "--port", String(primaryPort)],
    {
      cwd: join(import.meta.dirname, ".."),
      env: primaryEnvironment,
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  servers.push(primaryServer);
  for (let attempt = 0; attempt < 100 && !(await Bun.file(startedMarker).exists()); attempt += 1) {
    await Bun.sleep(20);
  }
  expect(await Bun.file(startedMarker).exists()).toBe(true);
  const startingHealth = await fetch(`http://127.0.0.1:${primaryPort}/health`);
  expect(startingHealth.status).toBe(503);
  expect(await startingHealth.json()).toEqual({ status: "starting" });
  expect(await readServerLocatorIfPresent({ stateDirectory: serverStateDirectory })).toBeNull();

  const replacementPort = await findFreePort();
  const replacement = Bun.spawn(
    ["bun", "src/server.mjs", "--root", worktreeRoot, "--port", String(replacementPort), "--reuse"],
    {
      cwd: join(import.meta.dirname, ".."),
      env: primaryEnvironment,
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  servers.push(replacement);
  await Bun.sleep(100);
  expect(replacement.exitCode).toBeNull();
  expect(primaryServer.exitCode).toBeNull();
  expect(await readServerLocatorIfPresent({ stateDirectory: serverStateDirectory })).toBeNull();

  for (let attempt = 0; attempt < 150 && !(await Bun.file(completedMarker).exists()); attempt += 1) {
    await Bun.sleep(20);
  }
  expect(await Bun.file(completedMarker).exists()).toBe(true);
  expect(await readLaunchpadPort(replacement)).toBe(replacementPort);
  await waitForHealth(replacementPort, replacement);
  expect(await primaryServer.exited).toBe(0);
  expect((await getJson(replacementPort, "/health")).status).toBe("ok");
  expect(await readServerLocator({ stateDirectory: serverStateDirectory })).toMatchObject({
    origin: `http://127.0.0.1:${replacementPort}`,
  });
}, platformTestTimeout(15_000));

test("locator publication failure rolls back boot runtimes and releases Server leases for retry", async () => {
  const root = await createLaunchpadGitFixture();
  const stateRoot = `${root}-launchpad-state`;
  const appPort = await findFreePort();
  let serverPort = await findFreePort();
  while (serverPort === appPort) serverPort = await findFreePort();
  const appRoot = join(root, "organizations", "BetaCo_GEN3", "workspace", "deals", "app", "v1");
  const app = {
    id: "betaco-locator-rollback-v1",
    title: "Locator rollback",
    company: "BetaCo",
    module: "deals",
    port: appPort,
  };
  await createPackageApp({
    root,
    packagePath: "organizations/BetaCo_GEN3/workspace/deals/app/v1",
    app,
  });
  await writeFile(
    join(appRoot, "server.mjs"),
    [
      'import { mkdir } from "node:fs/promises";',
      "await mkdir(process.env.LAZURIO_TEST_LOCATOR_COLLISION_PATH);",
      "const server = Bun.serve({",
      '  hostname: process.env.HOST ?? "127.0.0.1",',
      "  port: Number(process.env.PORT),",
      "  fetch(request) {",
      "    const url = new URL(request.url);",
      "    if (url.pathname === '/health') return Response.json({ status: 'ok' });",
      "    return new Response('ok');",
      "  },",
      "});",
      'await Bun.write("locator-rollback.started", `${process.pid}\\n`);',
      "setInterval(() => {}, 2_147_483_647);",
      "",
    ].join("\n"),
    "utf8",
  );
  tempRoots.push(root, stateRoot);
  await writeDesiredModuleState({
    root: join(stateRoot, "runtime", "desired-modules"),
    state: buildDesiredModuleState({ app, source: { type: "main" } }),
  });

  const { environment, serverStateDirectory } = serverTestEnvironment(root, {
    LAZURIO_LAUNCHPAD_STATE_ROOT: stateRoot,
  });
  environment.LAZURIO_TEST_LOCATOR_COLLISION_PATH = serverLocatorPath(serverStateDirectory);
  const server = Bun.spawn(
    ["bun", "src/server.mjs", "--root", root, "--port", String(serverPort)],
    {
      cwd: join(import.meta.dirname, ".."),
      env: environment,
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  servers.push(server);

  const exitCode = await waitForProcessExit(server, 10_000);
  const stderr = await new Response(server.stderr).text();
  expect(exitCode).not.toBe(0);
  if (process.platform === "win32") {
    // Windows reports an atomic replacement collision as EPERM. The Server
    // deliberately maps that OS detail to its stable permission contract.
    expect(stderr).toContain("LAZURIO_SERVER_STATE_PERMISSION_REQUIRED:");
  } else {
    expect(stderr.trim()).not.toBe("");
  }
  expect(await Bun.file(join(appRoot, "locator-rollback.started")).exists()).toBe(true);
  await waitForPortVacancy(appPort);
  await waitForPortVacancy(serverPort);
  expect(await readDesiredModuleState({
    root: join(stateRoot, "runtime", "desired-modules"),
    company: app.company,
    module: app.module,
  })).toMatchObject({
    app_id: app.id,
    enabled: true,
    status: "active",
    source: { type: "main" },
  });

  const startupProbe = await acquireServerStartupLock({
    stateDirectory: serverStateDirectory,
    instanceId: randomUUID(),
  });
  await startupProbe.release();
  const lifetimeProbe = await acquireServerLifetimeLock({
    stateDirectory: serverStateDirectory,
    instanceId: randomUUID(),
  });
  await lifetimeProbe.release();
}, platformTestTimeout(15_000));

test("hosted Launchpad rejects forged gateway headers without a TLS-authenticated OAuth session", async () => {
  const root = await createLaunchpadGitFixture();
  const stateRoot = `${root}-launchpad-state`;
  tempRoots.push(root, stateRoot);
  const externalOrigin = "https://launchpad.management.example.test";
  const authPort = await findFreePort();
  const { port } = await startLaunchpadServer(root, {
    env: {
      LAZURIO_WORKSPACE_PROFILE: "hosted",
      LAZURIO_TEAM_ID: "management",
      LAZURIO_LAUNCHPAD_STATE_ROOT: stateRoot,
      LAZURIO_TEAM_SERVICE_CATALOG_JSON: JSON.stringify({
        schema_version: "lazurio.team_service_catalog.v1",
        team_id: "management",
        generated_at: "2026-08-18T19:45:00Z",
        services: [],
      }),
      LAZURIO_LAUNCHPAD_EXTERNAL_ORIGIN: externalOrigin,
      LAZURIO_LAUNCHPAD_AUTH_COOKIE_NAME: "__Secure-lazurio-management-workspace",
      // Nothing listens on this HTTPS endpoint. A local caller cannot replace
      // the authenticated gateway with plain spoofed request headers.
      LAZURIO_LAUNCHPAD_AUTH_CHECK_URL: `https://127.0.0.1:${authPort}/oauth2/auth`,
    },
  });
  const gatewayHeaders = {
    origin: externalOrigin,
    "sec-fetch-site": "same-origin",
    "x-lazurio-github-login": "annavesela",
  };

  const directServerIdentity = await getJson(port, "/api/lazurio/server-identity");
  expect(directServerIdentity.request_trust_profile).toBe("hosted");

  const forgedGatewayHeaders = await fetch(`http://127.0.0.1:${port}/api/sync`, {
    method: "POST",
    headers: gatewayHeaders,
  });
  expect(forgedGatewayHeaders.status).toBe(403);
  expect((await forgedGatewayHeaders.json()).error).toBe("mutating_request_forbidden");

  const forgedSession = await fetch(`http://127.0.0.1:${port}/api/sync`, {
    method: "POST",
    headers: { ...gatewayHeaders, cookie: "_oauth2_proxy=forged" },
  });
  expect(forgedSession.status).toBe(403);
  expect((await forgedSession.json()).error).toBe("mutating_request_forbidden");

  const directLoopbackPull = await fetch(`http://127.0.0.1:${port}/api/git/pull-all?company=BetaCo`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  expect(directLoopbackPull.status).toBe(403);
  expect((await directLoopbackPull.json()).error).toBe("mutating_request_forbidden");

  const personalspace = await fetch(`http://127.0.0.1:${port}/api/personalspace`, {
    headers: gatewayHeaders,
  });
  expect(personalspace.status).toBe(403);
  expect((await personalspace.json()).error).toBe("personalspace_request_forbidden");

  const identity = await fetch(`http://127.0.0.1:${port}/api/launchpad/identity`, {
    headers: gatewayHeaders,
  });
  expect(identity.status).toBe(403);
  expect((await identity.json()).error).toBe("identity_request_forbidden");

  const serverIdentity = await fetch(`http://127.0.0.1:${port}/api/lazurio/server-identity`, {
    headers: gatewayHeaders,
  });
  expect(serverIdentity.status).toBe(403);
  expect((await serverIdentity.json()).error).toBe("identity_request_forbidden");

  const shutdown = await fetch(`http://127.0.0.1:${port}/api/lazurio/server-shutdown`, {
    method: "POST",
    headers: { ...gatewayHeaders, "content-type": "application/json" },
    body: JSON.stringify({ instance_id: "00000000-0000-4000-8000-000000000000" }),
  });
  expect(shutdown.status).toBe(403);
  expect((await shutdown.json()).error).toBe("server_shutdown_forbidden");
});

test("hosted Launchpad omits another Team app and rejects its runtime route before runtime dispatch", async () => {
  const root = await createLaunchpadGitFixture();
  const stateRoot = `${root}-launchpad-state`;
  tempRoots.push(root, stateRoot);
  const externalOrigin = "https://launchpad.management.example.test";
  const authPort = await findFreePort();
  await createPackageApp({
    root,
    packagePath: "organizations/BetaCo_GEN3/workspace/deals/app/v1",
    app: {
      id: "betaco-hidden-deals-v1",
      title: "Hidden Deals",
      company: "BetaCo",
      module: "deals",
      port: await findFreePort(),
    },
  });
  const { port } = await startLaunchpadServer(root, {
    env: {
      LAZURIO_WORKSPACE_PROFILE: "hosted",
      LAZURIO_TEAM_ID: "management",
      LAZURIO_LAUNCHPAD_STATE_ROOT: stateRoot,
      LAZURIO_LAUNCHPAD_EXTERNAL_ORIGIN: externalOrigin,
      LAZURIO_LAUNCHPAD_AUTH_COOKIE_NAME: "__Secure-lazurio-management-workspace",
      LAZURIO_LAUNCHPAD_AUTH_CHECK_URL: `https://127.0.0.1:${authPort}/oauth2/auth`,
      LAZURIO_TEAM_SERVICE_CATALOG_JSON: JSON.stringify({
        schema_version: "lazurio.team_service_catalog.v1",
        team_id: "management",
        generated_at: "2026-08-23T00:00:00Z",
        services: [],
      }),
    },
  });

  const apps = await getJson(port, "/api/apps");
  expect(apps.apps.map((app) => app.id)).not.toContain("betaco-hidden-deals-v1");

  const hiddenRuntime = await fetch(`http://127.0.0.1:${port}/api/apps/betaco-hidden-deals-v1/health`);
  expect(hiddenRuntime.status).toBe(404);
  expect(await hiddenRuntime.json()).toMatchObject({
    error: "app_not_found",
    message: "Aplikace není dostupná v aktivním Team Workspace.",
  });
});

test("instance-bound local shutdown rejects stale callers and releases the exact port", async () => {
  const root = await createLaunchpadGitFixture();
  tempRoots.push(root);
  const { server, port, serverStateDirectory } = await startLaunchpadServer(root);
  const identity = await getJson(port, "/api/lazurio/server-identity");
  expect((await readServerLocator({ stateDirectory: serverStateDirectory })).instance_id).toBe(identity.instance_id);

  const mismatch = await postJson(port, "/api/lazurio/server-shutdown", {
    instance_id: "00000000-0000-4000-8000-000000000000",
  }, 409);
  expect(mismatch.error).toBe("server_instance_mismatch");
  expect((await fetch(`http://127.0.0.1:${port}/health`)).status).toBe(200);

  const accepted = await postJson(port, "/api/lazurio/server-shutdown", {
    instance_id: identity.instance_id,
  });
  expect(accepted).toEqual({
    schema_version: "lazurio.server.shutdown.v1",
    instance_id: identity.instance_id,
    stopping: true,
  });
  expect(await server.exited).toBe(0);
  await expect(fetch(`http://127.0.0.1:${port}/health`)).rejects.toThrow();
  expect(await readServerLocatorIfPresent({ stateDirectory: serverStateDirectory })).toBeNull();
  expect(existsSync(join(serverStateDirectory, moduleRuntimeLockName("server-lifetime")))).toBe(false);
});

test("launcher replaces the immediately preceding pre-control-root Server on the same port", async () => {
  const root = await createLaunchpadGitFixture();
  const stateRoot = `${root}-launchpad-state`;
  tempRoots.push(root, stateRoot);
  const port = await findFreePort();
  const instanceId = "2a6db6d3-ad60-42b7-b6a8-e522ac838284";
  const rootId = computeServerRootId(realpathSync.native(root));
  const blockerPath = join(root, "stale-server.mjs");
  const { environment: serverEnvironment } = serverTestEnvironment(root, {
    LAZURIO_LAUNCHPAD_STATE_ROOT: stateRoot,
  });
  await writeFile(blockerPath, staleServerFixtureSource());
  const blocker = Bun.spawn(["bun", blockerPath], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      ROOT_ID: rootId,
      INSTANCE_ID: instanceId,
    },
    stdout: "ignore",
    stderr: "pipe",
  });
  await waitForHealth(port, blocker);
  const launcher = Bun.spawn(
    ["bun", "src/server.mjs", "--root", root, "--port", String(port), "--reuse"],
    {
      cwd: join(import.meta.dirname, ".."),
      env: serverEnvironment,
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  servers.push(launcher);
  try {
    expect(await readLaunchpadPort(launcher)).toBe(port);
    await waitForHealth(port, launcher);
    const identity = await getJson(port, "/api/lazurio/server-identity");
    expect(identity.instance_id).not.toBe(instanceId);
    expect(identity.install_generation).not.toBe("0".repeat(64));
  } finally {
    if (blocker.exitCode === null) blocker.kill();
    await blocker.exited;
  }
});

test("apps cache keeps first paint Git-free and invalidates on force sync and failed mutation", async () => {
  const root = await createLaunchpadGitFixture();
  tempRoots.push(root);
  await createPackageApp({
    root,
    packagePath: "organizations/BetaCo_GEN3/workspace/deals/app/v1",
    app: { id: "betaco-cache-deals-v1", title: "Cache Deals", company: "BetaCo", module: "deals", port: 5411 },
  });
  const { port } = await startLaunchpadServer(root);

  const first = await getJson(port, "/api/apps");
  expect(first.apps.map((app) => app.id)).toContain("betaco-cache-deals-v1");
  expect(first.apps.every((app) => app.git === undefined)).toBe(true);

  await createPackageApp({
    root,
    packagePath: "organizations/BetaCo_GEN3/workspace/knowledgebase/app/v1",
    app: {
      id: "betaco-cache-knowledgebase-v1",
      title: "Cache Knowledgebase",
      company: "BetaCo",
      module: "knowledgebase",
      port: 5412,
    },
  });
  expect((await getJson(port, "/api/apps")).apps.map((app) => app.id)).not.toContain("betaco-cache-knowledgebase-v1");

  const forced = await postJson(port, "/api/sync", {});
  expect(forced.apps.map((app) => app.id)).toContain("betaco-cache-knowledgebase-v1");
  expect((await getJson(port, "/api/apps")).generated_at).toBe(forced.generated_at);

  await createPackageApp({
    root,
    packagePath: "organizations/OmegaCo_GEN3/workspace/studio/app/v1",
    app: { id: "omegaco-cache-studio-v1", title: "Cache Studio", company: "OmegaCo", module: "studio", port: 5413 },
  });
  const failedMutation = await fetch(`http://127.0.0.1:${port}/api/apps/not-an-app/start`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  expect(failedMutation.ok).toBe(false);
  expect((await getJson(port, "/api/apps")).apps.map((app) => app.id)).toContain("omegaco-cache-studio-v1");
});

test("Launchpad server reports a live rebase and routes recovery through the shared update handoff", async () => {
  const root = await createLaunchpadGitFixture();
  tempRoots.push(root);
  const dealsRepo = join(root, "organizations", "BetaCo_GEN3", "workspace", "deals");
  await initGitRepo(dealsRepo);
  await startConflictingRebase(dealsRepo);
  const { port } = await startLaunchpadServer(root);

  const before = await getJson(port, "/api/git/repos/BetaCo%3A%3Adeals");
  expect(before.repo.status).toBe("rebase_in_progress");
  expect(before.repo.operation).toEqual({ kind: "rebase", backend: "merge" });

  const blockedPull = await postJson(port, "/api/git/repos/BetaCo%3A%3Adeals/pull", {});
  expect(blockedPull.schema_version).toBe("lazurio.update.v1");
  expect(blockedPull.state).toBe("blocked");
  expect(blockedPull.next_action).toMatchObject({ kind: "codex" });
  expect((await getJson(port, "/api/git/repos/BetaCo%3A%3Adeals")).repo.status)
    .toBe("rebase_in_progress");
  runGit(["rebase", "--abort"], dealsRepo);
});

test("Launchpad server reports git am and leaves recovery to Codex", async () => {
  const root = await createLaunchpadGitFixture();
  tempRoots.push(root);
  const dealsRepo = join(root, "organizations", "BetaCo_GEN3", "workspace", "deals");
  await initGitRepo(dealsRepo);
  await startConflictingGitAm(dealsRepo);
  const { port } = await startLaunchpadServer(root);

  const before = await getJson(port, "/api/git/repos/BetaCo%3A%3Adeals");
  expect(before.repo.status).toBe("git_am_in_progress");
  expect(before.repo.operation).toEqual({ kind: "am", backend: "apply" });

  const blockedPull = await postJson(port, "/api/git/repos/BetaCo%3A%3Adeals/pull", {});
  expect(blockedPull.schema_version).toBe("lazurio.update.v1");
  expect(blockedPull.state).toBe("blocked");
  expect(blockedPull.next_action).toMatchObject({ kind: "codex" });
  expect((await getJson(port, "/api/git/repos/BetaCo%3A%3Adeals")).repo.status).toBe("git_am_in_progress");
  runGit(["am", "--abort"], dealsRepo);
});

test("PORT environment configuration is implicit and falls forward to a free port", async () => {
  const root = await createLaunchpadGitFixture();
  const stateRoot = `${root}-launchpad-state`;
  tempRoots.push(root, stateRoot);
  const blockerConnections = new Set();
  const blocker = createServer((connection) => {
    blockerConnections.add(connection);
    connection.once("close", () => blockerConnections.delete(connection));
  });
  const blockedPort = await findFreePort();
  await new Promise((resolve, reject) => {
    blocker.once("error", reject);
    blocker.listen(blockedPort, "127.0.0.1", resolve);
  });
  const { port } = blocker.address();
  const { environment: serverEnvironment } = serverTestEnvironment(root, {
    LAZURIO_LAUNCHPAD_STATE_ROOT: stateRoot,
    PORT: String(port),
  });

  const launcher = Bun.spawn(["bun", "src/server.mjs", "--root", root], {
    cwd: join(import.meta.dirname, ".."),
    env: serverEnvironment,
    stdout: "pipe",
    stderr: "pipe",
  });
  servers.push(launcher);

  try {
    const actualPort = await Promise.race([
      readLaunchpadPort(launcher),
      Bun.sleep(5_000).then(() => {
        throw new Error("Launchpad s implicitním PORT nenastartoval na fallback portu");
      }),
    ]);
    expect(actualPort).not.toBe(port);
    for (const connection of blockerConnections) connection.destroy();
    await new Promise((resolve) => blocker.close(resolve));
    await waitForHealth(actualPort, launcher);
  } finally {
    if (blocker.listening) {
      for (const connection of blockerConnections) connection.destroy();
      await new Promise((resolve) => blocker.close(resolve));
    }
  }
});

test("explicit --port without a value fails during argument parsing", async () => {
  const root = await createLaunchpadGitFixture();
  tempRoots.push(root);
  const { environment: serverEnvironment } = serverTestEnvironment(root);
  const launcher = Bun.spawn(["bun", "src/server.mjs", "--root", root, "--port"], {
    cwd: join(import.meta.dirname, ".."),
    env: serverEnvironment,
    stdout: "pipe",
    stderr: "pipe",
  });

  const outcome = await Promise.race([
    launcher.exited,
    Bun.sleep(3_000).then(() => "timeout"),
  ]);
  if (outcome === "timeout") launcher.kill();

  expect(outcome).not.toBe("timeout");
  expect(outcome).not.toBe(0);
  expect(await new Response(launcher.stderr).text()).toContain("Chybí hodnota pro --port");
});

test("organization branding serves local logos and design-system themes without symlink escapes", async () => {
  const root = await createLaunchpadGitFixture();
  tempRoots.push(root);
  const omegacoLogo = join(root, "organizations", "OmegaCo_GEN3", "launchpad", "app", "v1", "web", "launchpad-icon.png");
  const betacoLogo = join(root, "organizations", "BetaCo_GEN3", "launchpad", "app", "v1", "web", "launchpad-icon.png");
  const secretDirectory = join(root, "secret-logo-directory");
  await mkdir(join(omegacoLogo, ".."), { recursive: true });
  await mkdir(join(betacoLogo, ".."), { recursive: true });
  await writeFile(omegacoLogo, "safe-logo");
  await writeFile(
    join(omegacoLogo, "..", "style.css"),
    `:root {
      --bg: #fff;
      --surface: #fff;
      --text: #1b1348;
      --accent: #6058e9;
      --font-body: "Manrope", sans-serif;
    }
    [data-theme="dark"] {
      --bg: #0b0e14;
      --surface: #151a24;
      --text: #f3f4f8;
      --accent: #728efc;
    }`,
  );
  await mkdir(secretDirectory, { recursive: true });
  await writeFile(join(secretDirectory, "launchpad-icon.png"), "must-not-leak");
  await rm(join(betacoLogo, ".."), { recursive: true, force: true });
  await symlink(
    secretDirectory,
    join(betacoLogo, ".."),
    process.platform === "win32" ? "junction" : "dir",
  );
  const { port } = await startLaunchpadServer(root);

  const apps = await getJson(port, "/api/apps");
  expect(apps.organizations.find((organization) => organization.slug === "OmegaCo")?.logo_url).toBe(
    "/api/organizations/OmegaCo/logo",
  );
  expect(apps.organizations.find((organization) => organization.slug === "BetaCo")?.logo_url).toBeUndefined();
  expect(apps.organizations.find((organization) => organization.slug === "OmegaCo")?.theme).toMatchObject({
    source: "launchpad/app/v1/web/style.css",
    light: { "--accent": "#6058e9", "--font-body": '"Manrope", sans-serif' },
    dark: { "--accent": "#728efc" },
  });
  expect(apps.organizations.find((organization) => organization.slug === "BetaCo")?.theme).toBeUndefined();

  const safeResponse = await fetch(`http://127.0.0.1:${port}/api/organizations/OmegaCo/logo`);
  expect(safeResponse.status).toBe(200);
  expect(safeResponse.headers.get("content-type")).toBe("image/png");
  expect(await safeResponse.text()).toBe("safe-logo");
  expect(safeResponse.headers.get("cross-origin-resource-policy")).toBe("same-origin");

  const crossOriginResponse = await fetch(`http://127.0.0.1:${port}/api/organizations/OmegaCo/logo`, {
    headers: { origin: "https://example.com", "sec-fetch-site": "cross-site" },
  });
  expect(crossOriginResponse.status).toBe(403);

  const escapedResponse = await fetch(`http://127.0.0.1:${port}/api/organizations/BetaCo/logo`);
  expect(escapedResponse.status).toBe(404);
  expect(await escapedResponse.text()).not.toContain("must-not-leak");
});

test("personalspace API rejects cross-origin and DNS-rebinding requests", async () => {
  const root = await createLaunchpadGitFixture();
  tempRoots.push(root);
  const { port } = await startLaunchpadServer(root);

  const crossOrigin = await fetch(`http://127.0.0.1:${port}/api/personalspace`, {
    headers: { origin: "https://example.com", "sec-fetch-site": "cross-site" },
  });
  expect(crossOrigin.status).toBe(403);

  const rebound = await fetch(`http://127.0.0.1:${port}/api/personalspace`, {
    headers: { host: "attacker.example" },
  });
  expect(rebound.status).toBe(403);
});

test("mutating APIs reject cross-origin and DNS-rebinding requests before routing", async () => {
  const root = await createLaunchpadGitFixture();
  tempRoots.push(root);
  const { port } = await startLaunchpadServer(root);
  const mutatingPaths = [
    "/api/git/pull-all",
    "/api/git/repos/BetaCo%3A%3Adeals/pull",
    "/api/git/repos/BetaCo%3A%3Adeals/pull-autostash",
    "/api/git/repos/BetaCo%3A%3Adeals/worktrees/create",
    "/api/git/repos/BetaCo%3A%3Adeals/worktrees/review-fix/publish",
    "/api/apps/betaco-deals-v1/health",
    "/api/apps/betaco-deals-v1/install",
    "/api/apps/betaco-deals-v1/repair",
    "/api/apps/betaco-deals-v1/start",
    "/api/apps/betaco-deals-v1/open",
    "/api/apps/betaco-deals-v1/stop",
    "/api/apps/betaco-deals-v1/restart",
    "/api/sync",
  ];

  for (const path of mutatingPaths) {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://evil.invalid",
        "sec-fetch-site": "cross-site",
      },
      body: "{}",
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "mutating_request_forbidden" });
  }

  const rebound = await fetch(`http://127.0.0.1:${port}/api/git/pull-all`, {
    method: "POST",
    headers: { "content-type": "application/json", host: "attacker.example" },
    body: "{}",
  });
  expect(rebound.status).toBe(403);
  expect(await rebound.json()).toEqual({ error: "mutating_request_forbidden" });
});

test("Launchpad server forwards runtime source from POST body to worktree open", async () => {
  const root = await createLaunchpadGitFixture();
  tempRoots.push(root);
  const orgRoot = join(root, "organizations", "BetaCo_GEN3");
  const dealsRepo = join(orgRoot, "workspace", "deals");
  await initGitRepo(dealsRepo);
  const mainPort = await findFreePort();
  await createPackageApp({
    root,
    packagePath: "organizations/BetaCo_GEN3/workspace/deals/app/v1",
    app: {
      id: "betaco-deals-v1",
      title: "Deals v1",
      company: "BetaCo",
      module: "deals",
      port: mainPort,
    },
  });
  await writeFile(join(dealsRepo, "app", "v1", "server.mjs"), fixtureServerSource(), "utf8");

  const worktreeSlug = "CAC-0042-deals-runtime-selector";
  const worktreeRoot = join(orgRoot, ".worktrees", "workspace", "deals", worktreeSlug);
  await mkdir(join(orgRoot, ".worktrees", "workspace", "deals"), { recursive: true });
  await cp(dealsRepo, worktreeRoot, { recursive: true });
  await writeFile(
    join(orgRoot, "mission-control", "plans", "2026", "07", "CAC-0042-deals-runtime-selector.yaml"),
    "dev_code: CAC-0042\ntitle: Deals runtime selector\nstatus: in_progress\nlinks:\n  - path: workspace/deals\n",
  );
  await writeJson(join(orgRoot, ".worktrees", "workspace", "deals", `${worktreeSlug}.worktree.json`), {
    schema_version: "companiesascode.worktree.v1",
    organization: "BetaCo",
    organization_path: "organizations/BetaCo_GEN3",
    workspace: "workspace",
    module: "deals",
    module_path: "workspace/deals",
    repo_kind: "module",
    base_branch: "main",
    branch: "CAC-0042-deals-runtime-selector",
    mission_control_plan_code: "CAC-0042",
    mission_control_plan_path: "mission-control/plans/2026/07/CAC-0042-deals-runtime-selector.yaml",
    worktree_path: ".worktrees/workspace/deals/CAC-0042-deals-runtime-selector",
    created_at: "2026-07-04T00:00:00.000Z",
    created_by: "examplebuddy-buddy",
    status: "active",
  });

  const { port } = await startLaunchpadServer(root);

  try {
    const opened = await postJson(port, "/api/apps/betaco-deals-v1/open", {
      source: { type: "worktree", slug: worktreeSlug },
    });

    expect(opened.runtime_source).toMatchObject({ type: "worktree", slug: worktreeSlug, plan_code: "CAC-0042" });
    expect(opened.url).toBe(`http://127.0.0.1:${mainPort}`);

    const health = await postJson(port, "/api/apps/betaco-deals-v1/health", {
      source: { type: "worktree", slug: worktreeSlug },
    });

    expect(health.runtime_source).toMatchObject({ type: "worktree", slug: worktreeSlug, plan_code: "CAC-0042" });
    expect(health.port).toBe(mainPort);
  } finally {
    await postJson(port, "/api/apps/betaco-deals-v1/stop", { source: { type: "worktree", slug: worktreeSlug } }).catch(() => null);
    await postJson(port, "/api/apps/betaco-deals-v1/stop", {}).catch(() => null);
  }
}, platformTestTimeout(15_000));

test("Launchpad server creates and publishes a Mission-Control-owned worktree via explicit builder actions", async () => {
  const root = await createLaunchpadGitFixture();
  tempRoots.push(root);
  const orgRoot = join(root, "organizations", "BetaCo_GEN3");
  const dealsRepo = join(orgRoot, "workspace", "deals");
  const remotePath = join(root, "remotes", "deals.git");
  await initGitRepo(dealsRepo, { remotePath });
  await writeFile(
    join(orgRoot, "mission-control", "plans", "2026", "07", "CAC-0042-deals-publish.yaml"),
    "dev_code: CAC-0042\ntitle: Deals publish assistant\nstatus: in_progress\nlinks:\n  - path: workspace/deals\n",
  );

  const { port } = await startLaunchpadServer(root);

  const created = await postJson(port, "/api/git/repos/BetaCo%3A%3Adeals/worktrees/create", {
    planPath: "mission-control/plans/2026/07/CAC-0042-deals-publish.yaml",
    branch: "CAC-0042-deals-publish",
    createdBy: "test-agent",
  });
  expect(created.worktree).toMatchObject({
    slug: "CAC-0042-deals-publish",
    ownership_status: "owned",
    owner_plan: { code: "CAC-0042" },
  });

  await writeFile(join(root, created.worktree.path, "draft.md"), "publish through server\n");
  const published = await postJson(port, "/api/git/repos/BetaCo%3A%3Adeals/worktrees/CAC-0042-deals-publish/publish", {
    commitMessage: "feat: publish via launchpad",
    publisher: "test-agent",
  });

  expect(published).toMatchObject({
    action: "publish_worktree",
    repo_key: "BetaCo::deals",
    branch: "CAC-0042-deals-publish",
    pushed: true,
    pr_opened: false,
  });
  expect(runGit(["--git-dir", remotePath, "rev-parse", "refs/heads/CAC-0042-deals-publish"], root)).toBe(
    published.commit.sha,
  );
});

async function readLaunchpadPort(server) {
  const reader = server.stdout.getReader();
  const decoder = new TextDecoder();
  let output = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (value) output += decoder.decode(value, { stream: true });
      const match = output.match(/Launchpad GEN3 běží na http:\/\/127\.0\.0\.1:(\d+)/);
      if (match) return Number(match[1]);
      if (done) {
        const stderr = server.stderr ? await new Response(server.stderr).text() : "";
        throw new Error(`Launchpad skončil před oznámením portu: ${stderr.trim()}`);
      }
    }
  } finally {
    reader.releaseLock();
  }
}

// Spustí launchpad server na OS-přiděleném volném portu (findFreePort) místo
// hádání z pevného rozsahu. Fixní rozsahy kolidovaly s reálnými dev servery
// běžícími na mašině (porty ~5288–5711): test si vylosoval obsazený port, jeho
// vlastní Bun.serve se nenabindoval, waitForHealth dostal 200 z /health cizího
// serveru a /api/git/repos pak vrátilo 404. OS přidělený port je garantovaně
// volný, takže health probe i git routy trefí vždy NÁŠ server.
async function startLaunchpadServer(root, { env = {}, useDefaultStateRoot = false } = {}) {
  const port = await findFreePort();
  const stateRoot = useDefaultStateRoot
    ? null
    : (env.LAZURIO_LAUNCHPAD_STATE_ROOT ?? `${root}-launchpad-state`);
  if (stateRoot && !tempRoots.includes(stateRoot)) tempRoots.push(stateRoot);
  const launchpadEnvironment = { ...env };
  if (stateRoot) launchpadEnvironment.LAZURIO_LAUNCHPAD_STATE_ROOT = stateRoot;
  else delete launchpadEnvironment.LAZURIO_LAUNCHPAD_STATE_ROOT;
  const { environment, serverStateDirectory } = serverTestEnvironment(root, launchpadEnvironment);
  const server = Bun.spawn(["bun", "src/server.mjs", "--root", root, "--port", String(port)], {
    cwd: join(import.meta.dirname, ".."),
    env: environment,
    stdout: "pipe",
    stderr: "pipe",
  });
  servers.push(server);
  await waitForHealth(port, server);
  return { server, port, environment, serverStateDirectory };
}

function serverTestEnvironment(root, env = {}) {
  const homeDirectory = `${root}-server-home`;
  if (!tempRoots.includes(homeDirectory)) tempRoots.push(homeDirectory);
  const environment = {
    ...process.env,
    HOME: homeDirectory,
    USERPROFILE: homeDirectory,
    XDG_STATE_HOME: join(homeDirectory, ".local", "state"),
    LOCALAPPDATA: join(homeDirectory, "AppData", "Local"),
    ...env,
  };
  return {
    environment,
    serverStateDirectory: resolveServerStateDirectory({
      environment,
      homeDirectory,
    }),
  };
}

async function findFreePort() {
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    const port = await probeFreePort();
    if ([...allocatedFixturePorts].some((allocated) => fixturePortsOverlap(port, allocated))) continue;
    allocatedFixturePorts.add(port);
    return port;
  }
  throw new Error("Could not allocate an isolated fixture port outside every Server fallback window.");
}

function fixturePortsOverlap(left, right) {
  return Math.abs(left - right) < serverFallbackPortSpan;
}

function probeFreePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.unref();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function waitForHealth(port, server) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    // Pokud server spadl při startu (např. port si mezi findFreePort a bindem
    // stihl vzít někdo jiný), neplýtvej 5 s timeoutem ani nepokračuj proti
    // cizímu serveru — vypíš rovnou proč.
    if (server && server.exitCode !== null) {
      const stderr = server.stderr ? await new Response(server.stderr).text() : "";
      throw new Error(`launchpad server on ${port} exited early (code ${server.exitCode}): ${stderr.trim()}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return;
    } catch {
      // server not ready yet
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`server on ${port} did not become healthy`);
}

async function waitForProcessExit(server, timeoutMs) {
  const result = await Promise.race([
    server.exited.then((exitCode) => ({ exitCode })),
    Bun.sleep(timeoutMs).then(() => null),
  ]);
  if (result) return result.exitCode;
  server.kill();
  await server.exited;
  throw new Error(`server process did not exit within ${timeoutMs} ms`);
}

async function waitForPortVacancy(port) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await canBindPort(port)) return;
    await Bun.sleep(50);
  }
  throw new Error(`port ${port} remained occupied after startup rollback`);
}

async function canBindPort(port) {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.unref();
    probe.once("error", () => resolve(false));
    probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)));
  });
}

async function getJson(port, path) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`);
  expect(response.status).toBe(200);
  return response.json();
}

async function postJson(port, path, body, expectedStatus = 200) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(expectedStatus);
  return response.json();
}

function fixtureServerSource() {
  return [
    "const server = Bun.serve({",
    "  hostname: process.env.LAZURIO_RUNTIME_HOST,",
    "  port: Number(process.env.LAZURIO_RUNTIME_PORT),",
    "  fetch(request) {",
    "    const url = new URL(request.url);",
    "    if (url.pathname === '/health') return Response.json({ status: 'ok' });",
    "    return new Response('ok');",
    "  },",
    "});",
    "console.log(`fixture listening ${server.port}`);",
    "setInterval(() => {}, 2147483647);",
    "",
  ].join("\n");
}

function staleServerFixtureSource() {
  return [
    "Bun.serve({",
    "  hostname: '127.0.0.1',",
    "  port: Number(process.env.PORT),",
    "  async fetch(request) {",
    "    const url = new URL(request.url);",
    "    if (url.pathname === '/health') return Response.json({ status: 'ok' });",
    "    if (url.pathname === '/api/lazurio/server-identity') {",
    "      return Response.json({",
    "        schema_version: 'lazurio.server.identity.v1',",
    "        product: 'lazurio-launchpad-server',",
    "        root_id: process.env.ROOT_ID,",
    "        ...(process.env.CONTROL_ROOT_ID ? { control_root_id: process.env.CONTROL_ROOT_ID } : {}),",
    "        install_generation: '0'.repeat(64),",
    "        instance_id: process.env.INSTANCE_ID,",
    "        pid: process.pid,",
    "        started_at: '2026-08-18T19:00:00.000Z',",
    "      });",
    "    }",
    "    if (url.pathname === '/api/lazurio/server-shutdown' && request.method === 'POST') {",
    "      const payload = await request.json();",
    "      if (payload.instance_id !== process.env.INSTANCE_ID) {",
    "        return Response.json({ error: 'mismatch' }, { status: 409 });",
    "      }",
    "      setTimeout(() => process.exit(0), 25);",
    "      return Response.json({ instance_id: process.env.INSTANCE_ID, stopping: true });",
    "    }",
    "    return Response.json({ error: 'not_found' }, { status: 404 });",
    "  },",
    "});",
    "setInterval(() => {}, 2147483647);",
    "",
  ].join("\n");
}
