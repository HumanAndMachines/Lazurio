import { afterAll, expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "fs";
import { cp, mkdir, readFile, rm, symlink, writeFile, chmod } from "fs/promises";
import { createServer } from "net";
import { join } from "path";
import {
  createLaunchpadGitFixture,
  createOrganization,
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
  acquireServerLifetimeLock,
  acquireServerStartupLock,
} from "./server-lifetime-lock-lib.mjs";
import { moduleRuntimeLockName } from "../../lazurio/runtime/module-runtime-lock-lib.mjs";
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

test("Launchpad serves its UI and API under a machine path without sibling routes", async () => {
  const root = await createLaunchpadGitFixture();
  tempRoots.push(root);
  const logo = join(root, "organizations", "OmegaCo_GEN3", "launchpad", "app", "v1", "web", "launchpad-icon.png");
  await mkdir(join(logo, ".."), { recursive: true });
  await writeFile(logo, '<svg xmlns="http://www.w3.org/2000/svg"/>');
  const { port, environment } = await startLaunchpadServer(root, { env: { LAZURIO_LAUNCHPAD_BASE_PATH: "/launchpad/" } });
  const origin = `http://127.0.0.1:${port}`;
  const reused = Bun.spawn(["bun", "src/server.mjs", "--root", root, "--port", String(port), "--reuse", "--agent-entry", "--organization", "OmegaCo"], {
    cwd: join(import.meta.dirname, ".."), env: environment, stdout: "pipe", stderr: "pipe",
  });
  servers.push(reused);
  expect(await reused.exited).toBe(0);
  expect(await new Response(reused.stdout).text()).toContain(`${origin}/launchpad/#/org/OmegaCo`);

  const bare = await fetch(`${origin}/launchpad`, { redirect: "manual" });
  expect(bare.status).toBe(308);
  expect(bare.headers.get("location")).toBe(`${origin}/launchpad/`);
  const page = await fetch(`${origin}/launchpad/`);
  expect(page.status).toBe(200);
  const html = await page.text();
  const apps = await (await fetch(`${origin}/launchpad/api/apps`)).json();
  const logoUrl = apps.organizations.find(org => org.slug === "OmegaCo").logo_url;
  expect(logoUrl).toBe("/launchpad/api/organizations/OmegaCo/logo");
  expect((await fetch(origin + logoUrl)).status).toBe(200);
  for (const match of html.matchAll(/(?:src|href)="(\.\/[^"#]+)"/g)) {
    const asset = await fetch(new URL(match[1], `${origin}/launchpad/`));
    expect(asset.status).toBe(200);
  }
  for (const path of ["api/apps", "styles.css", "app.js", "base-path.js", "lazurio-runtime/deep-link-lib.mjs", "fonts/fonts.css"]) {
    expect((await fetch(`${origin}/launchpad/${path}`)).status).toBe(200);
  }
  for (const path of ["/", "/api/apps", "/t3code/", "/launchpad-other/api/apps"]) {
    expect((await fetch(origin + path)).status).toBe(404);
  }
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
  const guideEn = await getJson(port, "/api/guide/organization-install?locale=en");
  const guideCs = await getJson(port, "/api/guide/organization-install?locale=cs");
  const guideWithoutLocale = await fetch(`http://127.0.0.1:${port}/api/guide/organization-install`);
  const moduleFolderGet = await fetch(`http://127.0.0.1:${port}/api/modules/open-folder`);
  const invalidModuleFolderPost = await fetch(`http://127.0.0.1:${port}/api/modules/open-folder`, { method: "POST" });
  const deepLinkModule = await fetch(`http://127.0.0.1:${port}/lazurio-runtime/deep-link-lib.mjs`);
  const missingRuntimeAsset = await fetch(`http://127.0.0.1:${port}/lazurio-runtime/missing.mjs`);

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
  expect(existsSync(join(root, "manual", "organization-install.md"))).toBe(false);
  expect(guideEn).toMatchObject({
    schema_version: "lazurio.guide.organization_install.v2",
    locale: "en",
    source: {
      path: "distribution/locales/en/manual/organization-install.md",
      authority: "lazurio-root-manual",
    },
  });
  expect(guideEn.short_prompt).toContain(
    "lazurio organization install <github-organization> --role builder --json",
  );
  expect(guideEn.short_prompt).toContain("Prepare this Machine");
  expect(guideCs).toMatchObject({
    schema_version: "lazurio.guide.organization_install.v2",
    locale: "cs",
    source: { path: "manual/organization-install.md", authority: "lazurio-root-manual" },
  });
  expect(guideCs.short_prompt).toContain("Připrav tuto Mašinu");
  expect(guideWithoutLocale.status).toBe(400);
  expect(await guideWithoutLocale.json()).toEqual({ error: "guide_locale_unsupported" });
  expect(moduleFolderGet.status).toBe(405);
  expect(invalidModuleFolderPost.status).toBe(400);
  expect(deepLinkModule.status).toBe(200);
  expect(deepLinkModule.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
  expect(await deepLinkModule.text()).toContain("export function launchpadEntryHash");
  expect(missingRuntimeAsset.status).toBe(404);
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
  const worktreeDependencyRoot = join(
    worktreeRoot,
    "guide",
    "app",
    "v1",
    "node_modules",
    "worktree-only-fixture",
  );
  await mkdir(worktreeDependencyRoot, { recursive: true });
  await writeJson(join(worktreeDependencyRoot, "package.json"), {
    name: "worktree-only-fixture",
    version: "1.0.0",
  });
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

  const missingSourceResponse = await fetch(`http://127.0.0.1:${port}/api/apps/test-root-guide-v1/start`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  expect({ status: missingSourceResponse.status, payload: await missingSourceResponse.json() }).toEqual({
    status: 400,
    payload: expect.objectContaining({ error: "runtime_source_required" }),
  });

  const startResponse = await fetch(`http://127.0.0.1:${port}/api/apps/test-root-guide-v1/start`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ source: { type: "main" } }),
  });
  const started = await startResponse.json();
  expect({ status: startResponse.status, payload: started }).toEqual({
    status: 200,
    payload: expect.objectContaining({ action: "start" }),
  });
  expect(existsSync(join(root, "launchpad", "logs", "apps", "test-root-guide-v1.log"))).toBe(true);
  expect(existsSync(join(worktreeRoot, "launchpad", "logs", "apps", "test-root-guide-v1.log"))).toBe(false);
  expect((await getJson(port, "/api/apps/test-root-guide-v1/health")).status).toBe("healthy");
  expect((await postJson(port, "/api/apps/test-root-guide-v1/open", { source: { type: "main" } })).action).toBe("open");
  expect(existsSync(join(root, "launchpad", "runtime", "usage.json"))).toBe(true);
  expect(existsSync(join(worktreeRoot, "launchpad", "runtime", "usage.json"))).toBe(false);
  expect((await postJson(port, "/api/apps/test-root-guide-v1/stop", { source: { type: "main" } })).action).toBe("stop");

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
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ source: { type: "main" } }),
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
  const installBody = await installResponse.json();
  expect({ status: installResponse.status, body: installBody }).toMatchObject({
    status: 200,
    body: { action: "install", exit_code: 0 },
  });
  expect((await getJson(primary.port, "/health")).status).toBe("ok");
});

test("locator publication failure releases Server leases for retry", async () => {
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
  const { environment, serverStateDirectory } = serverTestEnvironment(root, {
    LAZURIO_LAUNCHPAD_STATE_ROOT: stateRoot,
  });
  await mkdir(serverLocatorPath(serverStateDirectory), { recursive: true });
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
  // This fixture now places a directory at the locator file path before boot.
  // Every platform must therefore fail closed while reading the locator; the
  // older Windows EPERM contract applied only to a later atomic rename race.
  expect(stderr).toContain("Lazurio Server locator");
  expect(stderr).toContain("cannot be read");
  expect(await Bun.file(join(appRoot, "locator-rollback.started")).exists()).toBe(false);
  await waitForPortVacancy(appPort);
  await waitForPortVacancy(serverPort);
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

test.skipIf(process.platform === "win32")("personal Launchpad protects reads and mutations without borrowing Organization identity", async () => {
  const root = await createLaunchpadGitFixture();
  tempRoots.push(root);
  const projectionFile = join(root, "personal-projection.json");
  const secretFile = join(root, "personal-secret");
  const externalOrigin = "https://personal.example.invalid";
  await writeJson(projectionFile, {
    schema_version: "auth.personal-vm-consumer.v1", projectionVersion: `personal-v1-${"a".repeat(64)}`,
    issuer: "https://issuer.example.invalid/realms/workspace", clientId: "personal-fixture",
    externalOrigin, resource: `${externalOrigin}/`, redirectUri: `${externalOrigin}/oauth2/callback`, ownerGithubId: "1001",
  });
  await writeFile(secretFile, "synthetic-introspection-secret", { mode: 0o600 });
  await chmod(secretFile, 0o600);
  const authPort = await findFreePort();
  const { port, server, serverStateDirectory } = await startLaunchpadServer(root, { env: {
    LAZURIO_LAUNCHPAD_ENTRY_PROFILE: "personal",
    LAZURIO_LAUNCHPAD_PERSONAL_PROJECTION_FILE: projectionFile,
    LAZURIO_LAUNCHPAD_PERSONAL_SECRET_FILE: secretFile,
    LAZURIO_LAUNCHPAD_EXTERNAL_ORIGIN: externalOrigin,
    LAZURIO_LAUNCHPAD_AUTH_CHECK_URL: `http://127.0.0.1:${authPort}/oauth2/auth`,
    LAZURIO_LAUNCHPAD_AUTH_COOKIE_NAME: "__Host-personal",
  } });
  expect((await getJson(port, "/health")).status).toBe("ok");
  expect((await getJson(port, "/api/lazurio/server-identity")).request_trust_profile).toBe("personal");
  for (const path of ["/", "/api/apps", "/api/personalspace", "/api/doctor", "/api/git/repos"]) {
    for (const headers of [{}, { "x-auth-request-user": "1001", "x-auth-request-groups": "admin" },
      { origin: externalOrigin, "sec-fetch-site": "same-origin", cookie: "__Host-personal=forged" }]) {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, { headers });
      expect(response.status).toBe(403);
      expect((await response.json()).error).toBe("personal_entry_forbidden");
    }
  }
  for (const path of ["/api/sync"]) {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { method: "POST" });
    expect(response.status).toBe(403);
  }
  const identity = await getJson(port, "/api/lazurio/server-identity");
  // Service control must work without an RP/browser session, while a browser
  // cannot turn the maintenance endpoint into an owner-admission bypass.
  for (const headers of [
    { origin: externalOrigin, "sec-fetch-site": "same-origin" },
    { "sec-fetch-site": "cross-site" },
  ]) {
    const response = await fetch(`http://127.0.0.1:${port}/api/lazurio/server-shutdown`, {
      method: "POST", headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ instance_id: identity.instance_id }),
    });
    expect(response.status).toBe(403);
  }
  const mismatch = await postJson(port, "/api/lazurio/server-shutdown", {
    instance_id: "00000000-0000-4000-8000-000000000000",
  }, 409);
  expect(mismatch.error).toBe("server_instance_mismatch");
  expect((await getJson(port, "/health")).status).toBe("ok");
  const accepted = await postJson(port, "/api/lazurio/server-shutdown", { instance_id: identity.instance_id });
  expect(accepted.stopping).toBe(true);
  expect(await server.exited).toBe(0);
  expect(await readServerLocatorIfPresent({ stateDirectory: serverStateDirectory })).toBeNull();
});

test.skipIf(process.platform === "win32")("personal Launchpad consumes RP and TLS introspection, denies owner change and preserves CSRF", async () => {
  const root = await createLaunchpadGitFixture();
  tempRoots.push(root);
  const keyPath = join(root, "fixture-key.pem"), certPath = join(root, "fixture-cert.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
    "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1",
    "-keyout", keyPath, "-out", certPath], { stdio: "ignore" });
  let currentId = "1001", introspections = 0;
  let issuer = "";
  const externalOrigin = "https://personal.example.invalid";
  const resource = `${externalOrigin}/`;
  const clientSecret = "synthetic-personal-secret";
  const provider = Bun.serve({ hostname: "127.0.0.1", port: 0,
    tls: { key: await readFile(keyPath), cert: await readFile(certPath) },
    async fetch(request) {
      expect(new URL(request.url).pathname).toBe("/realms/workspace/protocol/openid-connect/token/introspect");
      const body = new URLSearchParams(await request.text());
      expect(body.get("token")).toBe("rp-held-token");
      expect(request.headers.get("authorization")).toBe(`Basic ${Buffer.from(`https%3A%2F%2Fpersonal.example.invalid%2F:${clientSecret}`).toString("base64")}`);
      introspections++;
      const now = Math.floor(Date.now() / 1000);
      return Response.json({ active: true, iss: issuer, aud: resource, client_id: "personal-fixture",
        sub: "synthetic-subject", iat: now, exp: now + 300, "https://lazurio.ai/github-id": currentId });
    },
  });
  issuer = `https://localhost:${provider.port}/realms/workspace`;
  const rp = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    if (new URL(request.url).pathname !== "/oauth2/auth" || request.headers.get("cookie") !== "__Host-personal=valid-session") return new Response(null, { status: 401 });
    return new Response(null, { status: 202, headers: { "x-auth-request-access-token": "rp-held-token" } });
  } });
  try {
    const projectionFile = join(root, "personal-projection.json"), secretFile = join(root, "personal-secret");
    await writeJson(projectionFile, { schema_version: "auth.personal-vm-consumer.v1",
      projectionVersion: `personal-v1-${"b".repeat(64)}`, issuer, clientId: "personal-fixture",
      externalOrigin, resource, redirectUri: `${externalOrigin}/oauth2/callback`, ownerGithubId: "1001" });
    await writeFile(secretFile, clientSecret, { mode: 0o600 });
    await chmod(secretFile, 0o600);
    const { port } = await startLaunchpadServer(root, { env: {
      LAZURIO_LAUNCHPAD_ENTRY_PROFILE: "personal", LAZURIO_LAUNCHPAD_PERSONAL_PROJECTION_FILE: projectionFile,
      LAZURIO_LAUNCHPAD_PERSONAL_SECRET_FILE: secretFile, LAZURIO_LAUNCHPAD_EXTERNAL_ORIGIN: externalOrigin,
      LAZURIO_LAUNCHPAD_AUTH_CHECK_URL: `http://127.0.0.1:${rp.port}/oauth2/auth`,
      LAZURIO_LAUNCHPAD_AUTH_COOKIE_NAME: "__Host-personal", NODE_EXTRA_CA_CERTS: certPath,
    } });
    const origin = `http://127.0.0.1:${port}`;
    const headers = { cookie: "__Host-personal=valid-session", "sec-fetch-site": "same-origin" };
    for (const path of ["/", "/api/apps", "/api/personalspace"]) {
      const result = await fetch(origin + path, { headers });
      expect(result.status).toBe(200);
      expect(result.headers.has("x-auth-request-access-token")).toBe(false);
      expect(result.headers.has("authorization")).toBe(false);
      await result.body?.cancel();
    }
    expect(introspections).toBe(3);
    const csrf = await fetch(origin + "/api/sync", { method: "POST", headers });
    expect(csrf.status).toBe(403);
    expect(introspections).toBe(3);
    currentId = "1002";
    expect((await fetch(origin + "/api/apps", { headers })).status).toBe(403);
    currentId = "1001";
    expect((await fetch(origin + "/api/apps", { headers })).status).toBe(200);
    provider.stop(true);
    expect((await fetch(origin + "/api/apps", { headers })).status).toBe(403);
  } finally { provider.stop(true); rp.stop(true); }
});

test("hosted Launchpad rejects forged browser context without a TLS-authenticated OAuth session", async () => {
  const root = await createLaunchpadGitFixture();
  const stateRoot = `${root}-launchpad-state`;
  tempRoots.push(root, stateRoot);
  const externalOrigin = "https://launchpad.builder.workspace.example.test";
  const authPort = await findFreePort();
  const { port } = await startLaunchpadServer(root, {
    env: {
      LAZURIO_WORKSPACE_PROFILE: "hosted",
      LAZURIO_ORGANIZATION_SLUG: "BetaCo",
      LAZURIO_TEAM_ID: "sales",
      LAZURIO_HOSTED_DOMAIN: "workspace.example.test",
      LAZURIO_LAUNCHPAD_STATE_ROOT: stateRoot,
      LAZURIO_LAUNCHPAD_EXTERNAL_ORIGIN: externalOrigin,
      LAZURIO_LAUNCHPAD_AUTH_COOKIE_NAME: "__Secure-lazurio-sales-workspace",
      // Nothing listens on this HTTPS endpoint. A local caller cannot replace
      // the authenticated gateway with plain spoofed request headers.
      LAZURIO_LAUNCHPAD_AUTH_CHECK_URL: `https://127.0.0.1:${authPort}/oauth2/auth`,
    },
  });
  const gatewayHeaders = {
    origin: externalOrigin,
    "sec-fetch-site": "same-origin",
  };

  for (const headers of [gatewayHeaders, { ...gatewayHeaders, cookie: "__Secure-lazurio-sales-workspace=forged" }]) {
    const ensure = await fetch(`http://127.0.0.1:${port}/api/internal/hosted/apps/betaco-hosted-deals-v1/ensure`, { headers });
    expect(ensure.status).toBe(403);
    expect((await ensure.json()).error).toBe("mutating_request_forbidden");
  }
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
    body: JSON.stringify({ source: { type: "main" } }),
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
  const externalOrigin = "https://launchpad.builder.workspace.example.test";
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
      LAZURIO_ORGANIZATION_SLUG: "BetaCo",
      LAZURIO_TEAM_ID: "sales",
      LAZURIO_HOSTED_DOMAIN: "workspace.example.test",
      LAZURIO_LAUNCHPAD_STATE_ROOT: stateRoot,
      LAZURIO_LAUNCHPAD_EXTERNAL_ORIGIN: externalOrigin,
      LAZURIO_LAUNCHPAD_AUTH_COOKIE_NAME: "__Secure-lazurio-sales-workspace",
      LAZURIO_LAUNCHPAD_AUTH_CHECK_URL: `https://127.0.0.1:${authPort}/oauth2/auth`,
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

test("fresh hosted Launchpad stays usable before operator Organization checkout and discovers it later", async () => {
  const root = await createLaunchpadGitFixture();
  const stateRoot = `${root}-empty-hosted-state`;
  const organization = join(root, "organizations", "BetaCo_GEN3");
  const stagedOrganization = `${root}-operator-checkout`;
  await cp(organization, stagedOrganization, { recursive: true });
  await rm(organization, { recursive: true });
  tempRoots.push(root, stateRoot, stagedOrganization);

  const { port } = await startLaunchpadServer(root, {
    env: {
      LAZURIO_WORKSPACE_PROFILE: "hosted",
      LAZURIO_ORGANIZATION_SLUG: "BetaCo",
      LAZURIO_TEAM_ID: "sales",
      LAZURIO_HOSTED_DOMAIN: "workspace.example.test",
      LAZURIO_LAUNCHPAD_STATE_ROOT: stateRoot,
      LAZURIO_LAUNCHPAD_EXTERNAL_ORIGIN: "https://launchpad.builder.workspace.example.test",
      LAZURIO_LAUNCHPAD_AUTH_COOKIE_NAME: "__Secure-lazurio-sales-workspace",
      LAZURIO_LAUNCHPAD_AUTH_CHECK_URL: `https://127.0.0.1:${await findFreePort()}/oauth2/auth`,
    },
  });
  expect((await fetch(`http://127.0.0.1:${port}/`)).status).toBe(200);
  const empty = await getJson(port, "/api/apps");
  expect(empty.apps).toEqual([]);
  expect(empty.organizations).toEqual([]);
  expect((await getJson(port, "/health")).maintenance.total).toBe(0);
  // Other fixture Organizations do not become visible just because the
  // selected checkout is absent. Hosted authentication remains in force.
  const forged = await fetch(`http://127.0.0.1:${port}/api/internal/hosted/apps/foreign/ensure`, {
    headers: { origin: "https://launchpad.builder.workspace.example.test" },
  });
  expect(forged.status).toBe(403);

  // Models the operator's later successful checkout, with no server restart.
  await cp(stagedOrganization, organization, { recursive: true });
  let mounted;
  const discoveryDeadline = Date.now() + 12_000;
  do {
    mounted = await getJson(port, "/api/apps");
    if (mounted.organizations.some((item) => item.slug === "BetaCo")) break;
    await Bun.sleep(100);
  } while (Date.now() < discoveryDeadline);
  expect(mounted.organizations.map((item) => item.slug)).toEqual(["BetaCo"]);
  expect((await getJson(port, "/health")).status).toBe("ok");
}, platformTestTimeout(15_000));

test("hosted Chat is offered but never mints a T3 token for an unadmitted request", async () => {
  const root = await createLaunchpadGitFixture();
  const stateRoot = `${root}-chat-state`;
  const marker = `${root}-chat-minted`;
  const cli = `${root}-fake-t3.sh`;
  await writeFile(cli, `touch '${marker}'\nprintf '{"credential":"G2RQZFN6MK77"}'\n`);
  tempRoots.push(root, stateRoot, marker, cli);

  const { port } = await startLaunchpadServer(root, {
    env: {
      LAZURIO_WORKSPACE_PROFILE: "hosted",
      LAZURIO_ORGANIZATION_SLUG: "BetaCo",
      LAZURIO_TEAM_ID: "sales",
      LAZURIO_HOSTED_DOMAIN: "workspace.example.test",
      LAZURIO_LAUNCHPAD_STATE_ROOT: stateRoot,
      LAZURIO_LAUNCHPAD_EXTERNAL_ORIGIN: "https://launchpad.builder.workspace.example.test",
      LAZURIO_LAUNCHPAD_AUTH_COOKIE_NAME: "__Secure-lazurio-sales-workspace",
      LAZURIO_LAUNCHPAD_AUTH_CHECK_URL: `https://127.0.0.1:${await findFreePort()}/oauth2/auth`,
      LAZURIO_T3CODE_URL: "https://t3code.builder.workspace.example.test/t3code/",
      LAZURIO_T3CODE_PAIRING_COMMAND: JSON.stringify(["/bin/sh", cli]),
    },
  });
  expect((await getJson(port, "/api/chat")).available).toBe(true);
  const forged = await fetch(`http://127.0.0.1:${port}/api/chat/pair`, {
    method: "POST",
    headers: {
      origin: "https://launchpad.builder.workspace.example.test",
      "sec-fetch-site": "same-origin",
      cookie: "__Secure-lazurio-sales-workspace=forged",
    },
  });
  expect(forged.status).toBe(403);
  expect((await forged.json()).error).toBe("mutating_request_forbidden");
  expect(existsSync(marker)).toBe(false);
}, platformTestTimeout(15_000));

test("the Environment descriptor names this Machine without secrets", async () => {
  const root = await createLaunchpadGitFixture();
  tempRoots.push(root);
  const local = await startLaunchpadServer(root);
  // Settings is a route, not a file: /settings redirects to /settings/ and every section serves the page.
  const bare = await fetch(`http://127.0.0.1:${local.port}/settings`, { redirect: "manual" });
  expect(bare.status).toBe(308);
  expect(new URL(bare.headers.get("location")).pathname).toBe("/settings/");
  for (const path of ["/settings/", "/settings/general", "/settings/ssh"]) {
    const page = await fetch(`http://127.0.0.1:${local.port}${path}`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('id="settingsMain"');
  }
  expect((await fetch(`http://127.0.0.1:${local.port}/settings/other`)).status).toBe(404);
  expect(await getJson(local.port, "/api/setup/environment")).toEqual({
    profile: "local",
    scope: null,
    machine: null,
    organization_slug: null,
    team_id: null,
    domain: null,
  });

  const hostedRoot = await createLaunchpadGitFixture();
  tempRoots.push(hostedRoot);
  const hosted = await startLaunchpadServer(hostedRoot, {
    env: {
      ...hostedSshEnvironment("https://launchpad.builder.workspace.example.test"),
      LAZURIO_LAUNCHPAD_AUTH_CHECK_URL: `https://127.0.0.1:${await findFreePort()}/oauth2/auth`,
    },
  });
  expect(await getJson(hosted.port, "/api/setup/environment")).toEqual({
    profile: "hosted",
    scope: "organization",
    machine: "builder",
    organization_slug: "BetaCo",
    team_id: "sales",
    domain: "workspace.example.test",
  });
}, platformTestTimeout(20_000));

test("the laptop side of connections exists only on a local Launchpad", async () => {
  const root = await createLaunchpadGitFixture();
  tempRoots.push(root);
  const manifestPath = join(root, "organizations", "BetaCo_GEN3", "company.gen3.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.conglomerate_host = { headscale_login_server: "https://headscale.betaco.lazurio.io" };
  await writeJson(manifestPath, manifest);
  const local = await startLaunchpadServer(root);
  for (const path of ["/settings/network", "/settings/connections"]) {
    expect((await fetch(`http://127.0.0.1:${local.port}${path}`)).status).toBe(200);
  }
  const network = await getJson(local.port, "/api/setup/network");
  expect(network.available).toBe(true);
  expect(typeof network.tailscale.installed).toBe("boolean");
  const betaco = network.organizations.find((organization) => organization.slug === "BetaCo");
  // The fixture Organization declares no root repository; the login server still projects.
  expect(betaco).toMatchObject({
    headscale_login_server: "https://headscale.betaco.lazurio.io",
    tailnet: "headscale.betaco.lazurio.io",
    repository: null,
  });
  expect(["none", "connected", "pending"]).toContain(betaco.state);
  expect(await getJson(local.port, "/api/setup/connections")).toEqual({ available: true, connections: [] });
  // Validation runs before anything touches ~/.ssh.
  const bad = await fetch(`http://127.0.0.1:${local.port}/api/setup/connections/connect`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ label: "Bad Label" }),
  });
  expect(bad.status).toBe(400);
  expect((await bad.json()).error).toBe("label_invalid");
  expect(existsSync(join(local.environment.HOME, ".ssh"))).toBe(false);

  const hostedRoot = await createLaunchpadGitFixture();
  tempRoots.push(hostedRoot);
  const hosted = await startLaunchpadServer(hostedRoot, {
    env: {
      ...hostedSshEnvironment("https://launchpad.builder.workspace.example.test"),
      LAZURIO_LAUNCHPAD_AUTH_CHECK_URL: `https://127.0.0.1:${await findFreePort()}/oauth2/auth`,
    },
  });
  expect(await getJson(hosted.port, "/api/setup/network")).toEqual({ available: false });
  expect(await getJson(hosted.port, "/api/setup/connections")).toEqual({ available: false });
  const joinResponse = await fetch(`http://127.0.0.1:${hosted.port}/api/setup/network/join`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ organization: "BetaCo" }),
  });
  expect([403, 404]).toContain(joinResponse.status);
}, platformTestTimeout(25_000));

test("SSH access stays hidden and read-only on a localhost Launchpad", async () => {
  const root = await createLaunchpadGitFixture();
  tempRoots.push(root);
  const { port, environment } = await startLaunchpadServer(root);
  expect(await getJson(port, "/api/setup/ssh")).toEqual({ available: false });
  const add = await fetch(`http://127.0.0.1:${port}/api/setup/ssh/keys`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ public_key: syntheticSshKey("laptop") }),
  });
  expect(add.status).toBe(404);
  expect(existsSync(join(environment.HOME, ".ssh"))).toBe(false);
}, platformTestTimeout(15_000));

test("hosted SSH access never writes a key for an unadmitted request", async () => {
  const root = await createLaunchpadGitFixture();
  tempRoots.push(root);
  const externalOrigin = "https://launchpad.builder.workspace.example.test";
  const { port, environment } = await startLaunchpadServer(root, {
    env: {
      ...hostedSshEnvironment(externalOrigin),
      LAZURIO_LAUNCHPAD_AUTH_CHECK_URL: `https://127.0.0.1:${await findFreePort()}/oauth2/auth`,
    },
  });
  const state = await getJson(port, "/api/setup/ssh");
  expect(state.available).toBe(true);
  expect(state.keys).toEqual([]);
  for (const path of ["/api/setup/ssh/keys", "/api/setup/ssh/keys/remove"]) {
    const forged = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: "POST",
      headers: {
        origin: externalOrigin,
        "sec-fetch-site": "same-origin",
        cookie: "__Secure-lazurio-sales-workspace=forged",
        "content-type": "application/json",
      },
      body: JSON.stringify({ public_key: syntheticSshKey("attacker") }),
    });
    expect(forged.status).toBe(403);
    expect((await forged.json()).error).toBe("mutating_request_forbidden");
  }
  expect(existsSync(join(environment.HOME, ".ssh", "authorized_keys"))).toBe(false);
}, platformTestTimeout(15_000));

test.skipIf(process.platform === "win32")("hosted SSH access adds, lists and removes keys for the admitted gateway session", async () => {
  const root = await createLaunchpadGitFixture();
  tempRoots.push(root);
  const keyPath = join(root, "fixture-key.pem"), certPath = join(root, "fixture-cert.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
    "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1",
    "-keyout", keyPath, "-out", certPath], { stdio: "ignore" });
  const gateway = Bun.serve({ hostname: "127.0.0.1", port: 0,
    tls: { key: await readFile(keyPath), cert: await readFile(certPath) },
    fetch(request) {
      const admitted = new URL(request.url).pathname === "/oauth2/auth"
        && request.headers.get("cookie") === "__Secure-lazurio-sales-workspace=valid-session";
      return new Response(null, { status: admitted ? 202 : 401 });
    },
  });
  try {
    const externalOrigin = "https://launchpad.builder.workspace.example.test";
    const stateRoot = `${root}-ssh-state`;
    const { port, environment } = await startLaunchpadServer(root, {
      env: {
        ...hostedSshEnvironment(externalOrigin),
        LAZURIO_LAUNCHPAD_STATE_ROOT: stateRoot,
        LAZURIO_LAUNCHPAD_AUTH_CHECK_URL: `https://127.0.0.1:${gateway.port}/oauth2/auth`,
        NODE_EXTRA_CA_CERTS: certPath,
      },
    });
    const post = (path, body) => fetch(`http://127.0.0.1:${port}${path}`, {
      method: "POST",
      headers: {
        origin: externalOrigin,
        "sec-fetch-site": "same-origin",
        cookie: "__Secure-lazurio-sales-workspace=valid-session",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const key = syntheticSshKey("matej@laptop");
    const added = await post("/api/setup/ssh/keys", { public_key: key });
    expect(added.status).toBe(200);
    const addedBody = await added.json();
    expect(addedBody).toMatchObject({ added: true, available: true });
    expect(addedBody.keys).toEqual([
      { type: "ssh-ed25519", fingerprint: addedBody.fingerprint, comment: "lazurio-launchpad matej@laptop", removable: true },
    ]);
    const authorizedKeys = join(environment.HOME, ".ssh", "authorized_keys");
    expect(await readFile(authorizedKeys, "utf8")).toContain(key.split(" ")[1]);

    const duplicate = await (await post("/api/setup/ssh/keys", { public_key: key })).json();
    expect(duplicate.added).toBe(false);
    const privateKey = await post("/api/setup/ssh/keys", { public_key: "-----BEGIN OPENSSH PRIVATE KEY-----" });
    expect(privateKey.status).toBe(400);
    expect((await privateKey.json()).error).toBe("ssh_key_private_material");

    const removed = await post("/api/setup/ssh/keys/remove", { fingerprint: addedBody.fingerprint });
    expect(removed.status).toBe(200);
    expect((await removed.json()).keys).toEqual([]);
    const audit = await readFile(join(stateRoot, "runtime", "audit", "ssh-access.jsonl"), "utf8");
    expect(audit.trim().split("\n").map((line) => JSON.parse(line).action)).toEqual(["add", "remove"]);
    expect(audit).not.toContain(key.split(" ")[1]);
  } finally {
    gateway.stop(true);
  }
}, platformTestTimeout(20_000));

test("GitHub login API answers only admitted POST requests", async () => {
  const root = await createLaunchpadGitFixture();
  const hostedState = `${root}-setup-state`;
  const ghConfig = `${root}-gh-config`;
  tempRoots.push(root, hostedState, ghConfig);
  const isolatedGitHub = { GH_CONFIG_DIR: ghConfig, GH_TOKEN: "", GITHUB_TOKEN: "" };

  const hosted = await startLaunchpadServer(root, {
    env: {
      ...isolatedGitHub,
      LAZURIO_WORKSPACE_PROFILE: "hosted",
      LAZURIO_ORGANIZATION_SLUG: "BetaCo",
      LAZURIO_TEAM_ID: "sales",
      LAZURIO_HOSTED_DOMAIN: "workspace.example.test",
      LAZURIO_LAUNCHPAD_STATE_ROOT: hostedState,
      LAZURIO_LAUNCHPAD_EXTERNAL_ORIGIN: "https://launchpad.builder.workspace.example.test",
      LAZURIO_LAUNCHPAD_AUTH_COOKIE_NAME: "__Secure-lazurio-sales-workspace",
      LAZURIO_LAUNCHPAD_AUTH_CHECK_URL: `https://127.0.0.1:${await findFreePort()}/oauth2/auth`,
    },
  });
  for (const path of ["/api/setup/github/status", "/api/setup/github/start", "/api/setup/github/session"]) {
    const forged = await fetch(`http://127.0.0.1:${hosted.port}${path}`, {
      method: "POST",
      headers: {
        origin: "https://launchpad.builder.workspace.example.test",
        "sec-fetch-site": "same-origin",
        cookie: "__Secure-lazurio-sales-workspace=forged",
        "content-type": "application/json",
      },
      body: "{}",
    });
    expect(forged.status).toBe(403);
    expect((await forged.json()).error).toBe("mutating_request_forbidden");
  }
  // A GET never carries the one-time code, even behind the gateway.
  expect((await fetch(`http://127.0.0.1:${hosted.port}/api/setup/github/session`)).status).toBe(405);
  hosted.server.kill();
  await hosted.server.exited;

  const local = await startLaunchpadServer(root, { env: isolatedGitHub });
  const crossSite = await fetch(`http://127.0.0.1:${local.port}/api/setup/github/status`, {
    method: "POST",
    headers: { origin: "https://attacker.example", "sec-fetch-site": "cross-site" },
  });
  expect(crossSite.status).toBe(403);
  const status = await postJson(local.port, "/api/setup/github/status", { organization: "BetaCo" });
  expect(status.schema_version).toBe("lazurio.launchpad.setup.github.v1");
  expect(status.machine.profile).toBe("local");
  expect(status.session).toBeNull();
  expect((await postJson(local.port, "/api/setup/github/session", {})).session).toBeNull();
  // Cancel needs the capability that only start hands to the starting page.
  expect((await postJson(local.port, "/api/setup/github/cancel", {}, 403)).error).toBe("session_capability_invalid");
  expect((await postJson(local.port, "/api/setup/github/status", { organization: "../x" }, 400)).error)
    .toBe("organization_login_invalid");
}, platformTestTimeout(30_000));

for (const state of ["planned", "corrupt", "conflicting"]) {
  test(`fresh hosted Launchpad distinguishes ${state} Organization state from an absent checkout`, async () => {
    const root = await createLaunchpadGitFixture();
    tempRoots.push(root);
    const organization = join(root, "organizations", "BetaCo_GEN3");
    if (state === "planned") {
      await rm(organization, { recursive: true });
      await writeJson(join(root, "launchpad.gen3.local.json"), {
        planned_organizations: [{ slug: "BetaCo", display_name: "Beta Co" }],
      });
    } else if (state === "corrupt") {
      await writeFile(join(organization, "company.gen3.json"), "{ broken");
    } else {
      const manifestPath = join(organization, "modules.manifest.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      manifest.company = "WrongCompany";
      await writeJson(manifestPath, manifest);
    }
    const startup = startLaunchpadServer(root, {
      env: {
        LAZURIO_WORKSPACE_PROFILE: "hosted",
        LAZURIO_ORGANIZATION_SLUG: "BetaCo",
        LAZURIO_TEAM_ID: "sales",
        LAZURIO_HOSTED_DOMAIN: "workspace.example.test",
        LAZURIO_LAUNCHPAD_EXTERNAL_ORIGIN: "https://launchpad.builder.workspace.example.test",
        LAZURIO_LAUNCHPAD_AUTH_COOKIE_NAME: "__Secure-lazurio-sales-workspace",
        LAZURIO_LAUNCHPAD_AUTH_CHECK_URL: `https://127.0.0.1:${await findFreePort()}/oauth2/auth`,
      },
    });
    if (state === "planned") {
      const { port } = await startup;
      const inventory = await getJson(port, "/api/apps");
      expect(inventory.apps).toEqual([]);
      expect(inventory.organizations).toMatchObject([{ slug: "BetaCo", status: "planned", path: null }]);
      expect((await getJson(port, "/health")).maintenance.total).toBe(0);
    } else {
      await expect(startup).rejects.toThrow("Hosted Workspace discovery failed");
    }
  });
}

function personalHostedEnvironment(stateRoot, authPort) {
  return {
    LAZURIO_WORKSPACE_PROFILE: "hosted",
    LAZURIO_HOSTED_SCOPE: "personal",
    // Frozen Machine/DNS slug; deliberately not the Personalspace login.
    LAZURIO_HOSTED_OWNER: "frozen-slug",
    LAZURIO_HOSTED_PERSONALSPACE: "exampleuser_GEN3",
    LAZURIO_HOSTED_DOMAIN: "lazurio.io",
    LAZURIO_LAUNCHPAD_STATE_ROOT: stateRoot,
    LAZURIO_LAUNCHPAD_EXTERNAL_ORIGIN: "https://launchpad.frozen-slug.lazurio.io",
    LAZURIO_LAUNCHPAD_AUTH_COOKIE_NAME: "__Secure-lazurio-personal",
    LAZURIO_LAUNCHPAD_AUTH_CHECK_URL: `https://127.0.0.1:${authPort}/oauth2/auth`,
  };
}

async function mountPersonalspace(root, login) {
  const space = join(root, "personalspace", `${login}_GEN3`);
  await mkdir(join(space, "workspace"), { recursive: true });
  await writeJson(join(space, "personal.gen3.json"), {
    schema_version: "humanandmachines.personal.gen3.v1",
    personal_generation: "gen3",
    owner: { github_username: login, display_name: `${login} Display`, type: "human" },
    repository: {
      github_repo: `${login}/${login}_GEN3`,
      mount_path: `personalspace/${login}_GEN3`,
      visibility: "private",
      mount_strategy: "doctor-managed-nested-repo",
    },
    privacy: { default_share: "private", agent_boundary: "personal-context-only", shared_outputs: "metadata-only" },
    modules_manifest_path: "modules.manifest.json",
    workspace_path: "workspace",
    gbrain: {
      path: "gbrain",
      repository: { github_repo: `${login}/${login}-gbrain`, visibility: "private", mount_strategy: "doctor-managed-nested-repo" },
      software: { github_repo: "Lazurio/gbrain", install_source: "github:Lazurio/gbrain" },
      default_shared: false,
      human_editor: "obsidian",
      agent_access: "mcp-only",
    },
    secrets: { path: "secrets", custody_pattern: "personalspace/<owner>_GEN3/secrets/<provider>/<scope>/<purpose>", git: "ignored" },
    shared_spaces: [],
  });
  await writeJson(join(space, "modules.manifest.json"), { personal_generation: "gen3", owner: login, module_slots: [] });
}

async function mountPersonalApp(root, login, {
  module = "notes",
  appId = "notes-v1",
  port,
  installed = false,
  serverSource = fixtureServerSource(),
}) {
  const moduleRoot = join(root, "personalspace", `${login}_GEN3`, "workspace", module);
  const appRoot = join(moduleRoot, "app", "v1");
  await mkdir(appRoot, { recursive: true });
  await writeJson(join(moduleRoot, "lazurio.module.json"), {
    schema_version: "lazurio.module.v1",
    id: module,
    company: login,
    tcp_port_policy: { mode: "single" },
    port_leases: [{ id: "main", host: "127.0.0.1", port }],
    apps: ["app/v1/package.json"],
    default_app: "app/v1/package.json",
  });
  await writeJson(join(appRoot, "package.json"), {
    name: `${login}-${module}`,
    version: "1.0.0",
    private: true,
    type: "module",
    ...(installed ? {} : { dependencies: { "fixture-not-installed": "1.0.0" } }),
    scripts: { dev: "bun server.mjs" },
    lazurio: {
      runtime: {
        schema_version: "lazurio.runtime.v1",
        id: appId,
        title: "Personal Notes",
        company: login,
        module,
        surface: "internal",
        dev_script: "dev",
        tags: ["personal"],
        listeners: [{
          id: "web",
          role: "entrypoint",
          lease: "main",
          protocol: "http",
          health: { kind: "http", path: "/health" },
        }],
      },
    },
  });
  await writeFile(join(appRoot, "server.mjs"), serverSource, "utf8");
  if (installed) await mkdir(join(appRoot, "node_modules"), { recursive: true });
}

// Hosted responses reach a remote browser: no loopback listener, internal URL
// or process diagnostics anywhere in the JSON, at any depth.
function expectNoInternalAddress(value, path = "$") {
  if (typeof value === "string") {
    const internal = /127\.\d{1,3}\.\d{1,3}\.\d{1,3}|localhost|\[::1\]|0\.0\.0\.0|http:\/\//i.test(value);
    expect({ path, value, internal }).toMatchObject({ internal: false });
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => expectNoInternalAddress(item, `${path}[${index}]`));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      expect({ path, key }).not.toMatchObject({
        key: expect.stringMatching(/^(details|log_excerpt|startup_log|stderr|stdout|stack)$/),
      });
      expectNoInternalAddress(item, `${path}.${key}`);
    }
  }
}

async function startTlsAuthGateway(root, cookieName) {
  const keyPath = join(root, "fixture-key.pem"), certPath = join(root, "fixture-cert.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
    "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1",
    "-keyout", keyPath, "-out", certPath], { stdio: "ignore" });
  const gateway = Bun.serve({ hostname: "127.0.0.1", port: 0,
    tls: { key: await readFile(keyPath), cert: await readFile(certPath) },
    fetch(request) {
      const admitted = new URL(request.url).pathname === "/oauth2/auth"
        && request.headers.get("cookie") === `${cookieName}=valid-session`;
      return new Response(null, { status: admitted ? 202 : 401 });
    },
  });
  return {
    gateway,
    env: {
      LAZURIO_LAUNCHPAD_AUTH_CHECK_URL: `https://127.0.0.1:${gateway.port}/oauth2/auth`,
      NODE_EXTRA_CA_CERTS: certPath,
    },
  };
}

async function expectPortClosed(port) {
  await expect(fetch(`http://127.0.0.1:${port}/health`)).rejects.toThrow();
}

test.skipIf(process.platform === "win32")("hosted personal owner can list and control canonical Apps without loopback URL disclosure", async () => {
  const root = await createLaunchpadGitFixture();
  const stateRoot = `${root}-personal-owner-state`;
  const keyPath = join(root, "fixture-key.pem"), certPath = join(root, "fixture-cert.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
    "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1",
    "-keyout", keyPath, "-out", certPath], { stdio: "ignore" });
  const gateway = Bun.serve({ hostname: "127.0.0.1", port: 0,
    tls: { key: await readFile(keyPath), cert: await readFile(certPath) },
    fetch(request) {
      const admitted = new URL(request.url).pathname === "/oauth2/auth"
        && request.headers.get("cookie") === "__Secure-lazurio-personal=valid-session";
      return new Response(null, { status: admitted ? 202 : 401 });
    },
  });
  tempRoots.push(root, stateRoot);
  await mountPersonalspace(root, "exampleuser");
  const appPort = await findFreePort();
  await mountPersonalApp(root, "exampleuser", { port: appPort });
  try {
    const externalOrigin = "https://launchpad.frozen-slug.lazurio.io";
    const { port } = await startLaunchpadServer(root, { env: {
      ...personalHostedEnvironment(stateRoot, gateway.port),
      LAZURIO_LAUNCHPAD_AUTH_CHECK_URL: `https://127.0.0.1:${gateway.port}/oauth2/auth`,
      NODE_EXTRA_CA_CERTS: certPath,
    } });
    const origin = `http://127.0.0.1:${port}`;
    const readHeaders = {
      cookie: "__Secure-lazurio-personal=valid-session",
      "sec-fetch-site": "same-origin",
    };
    const response = await fetch(`${origin}/api/personalspace`, { headers: readHeaders });
    expect(response.status).toBe(200);
    const personalspace = await response.json();
    const app = personalspace.spaces[0].apps[0];
    expect(app).toMatchObject({
      id: "personal--exampleuser_GEN3--notes-v1",
      url: "https://notes.frozen-slug.lazurio.io/",
      health_url: "https://notes.frozen-slug.lazurio.io/health",
    });
    expect(JSON.stringify(personalspace)).not.toContain(`http://127.0.0.1:${appPort}`);
    expectNoInternalAddress(personalspace);
    expect((await getJson(port, "/api/apps")).apps).toEqual([]);

    for (const headers of [
      {},
      { ...readHeaders, cookie: "__Secure-lazurio-personal=forged" },
      { ...readHeaders, origin: "https://evil.invalid" },
      { ...readHeaders, "sec-fetch-site": "cross-site", "sec-fetch-mode": "cors" },
    ]) {
      expect((await fetch(`${origin}/api/personalspace`, { headers })).status).toBe(403);
    }

    const health = await fetch(`${origin}/api/personalspace/apps/${encodeURIComponent(app.id)}/health`, {
      method: "POST",
      headers: {
        ...readHeaders,
        origin: externalOrigin,
        "content-type": "application/json",
      },
      body: "{}",
    });
    expect(health.status).toBe(200);
    const healthPayload = await health.json();
    expect(healthPayload).toMatchObject({
      url: "https://notes.frozen-slug.lazurio.io/",
      health_url: "https://notes.frozen-slug.lazurio.io/health",
      hosted_url_source: "workspace-identity",
    });
    expectNoInternalAddress(healthPayload);

    gateway.stop(true);
    expect((await fetch(`${origin}/api/personalspace`, { headers: readHeaders })).status).toBe(403);
  } finally {
    gateway.stop(true);
  }
}, platformTestTimeout(45_000));

test.skipIf(process.platform === "win32")("hosted personal gateway ensure opens the Module default only for the gateway-shaped subrequest and keeps every lifecycle answer public", async () => {
  const root = await createLaunchpadGitFixture();
  const stateRoot = `${root}-personal-ensure-state`;
  tempRoots.push(root, stateRoot);
  const cookie = "__Secure-lazurio-personal=valid-session";
  const { gateway, env: authEnv } = await startTlsAuthGateway(root, "__Secure-lazurio-personal");
  await mountPersonalspace(root, "exampleuser");
  const appPort = await findFreePort();
  const brokenPort = await findFreePort();
  await mountPersonalApp(root, "exampleuser", { port: appPort, installed: true });
  await mountPersonalApp(root, "exampleuser", {
    module: "broken",
    appId: "broken-v1",
    port: brokenPort,
    installed: true,
    serverSource: [
      "console.error(`crash-marker binding http://127.0.0.1:${process.env.LAZURIO_RUNTIME_PORT}/health`);",
      "process.exit(1);",
      "",
    ].join("\n"),
  });
  try {
    const externalOrigin = "https://launchpad.frozen-slug.lazurio.io";
    const { port } = await startLaunchpadServer(root, { env: {
      ...personalHostedEnvironment(stateRoot, gateway.port),
      ...authEnv,
    } });
    const origin = `http://127.0.0.1:${port}`;
    const appId = "personal--exampleuser_GEN3--notes-v1";
    // Exactly what the Machine gateway sets on its readiness subrequest; the
    // browser's own Fetch Metadata mode passes through as a lifecycle hint.
    const gatewayHeaders = (mode) => ({
      cookie,
      origin: externalOrigin,
      "sec-fetch-site": "same-origin",
      ...(mode ? { "sec-fetch-mode": mode } : {}),
    });
    const ensure = (headers, module = "notes") =>
      fetch(`${origin}/api/internal/hosted/modules/${module}/ensure`, { headers });
    const mutationHeaders = {
      cookie,
      origin: externalOrigin,
      "sec-fetch-site": "same-origin",
      "content-type": "application/json",
    };
    const lifecycle = async (action, method = "POST") => {
      const response = await fetch(`${origin}/api/personalspace/apps/${encodeURIComponent(appId)}/${action}`, {
        method,
        headers: method === "POST" ? mutationHeaders : { cookie, "sec-fetch-site": "same-origin" },
        ...(method === "POST" ? { body: "{}" } : {}),
      });
      const payload = await response.json();
      expectNoInternalAddress(payload);
      return { status: response.status, payload };
    };

    // A signed browser following a cross-site link (SameSite=Lax cookie, no
    // Origin) never reaches lifecycle: not via the Module route and not via a
    // personal App id on the Organization namespace.
    const crossSite = { cookie, "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate" };
    const crossSiteEnsure = await ensure(crossSite);
    expect(crossSiteEnsure.status).toBe(403);
    expect(await crossSiteEnsure.json()).toEqual({ error: "mutating_request_forbidden" });
    expect((await fetch(`${origin}/api/internal/hosted/apps/${appId}/ensure`, { headers: crossSite })).status)
      .toBe(403);
    const personalAppIdEnsure = await fetch(`${origin}/api/internal/hosted/apps/${appId}/ensure`, {
      headers: gatewayHeaders("navigate"),
    });
    expect(personalAppIdEnsure.status).toBe(404);
    expectNoInternalAddress(await personalAppIdEnsure.json());
    const unknownModule = await ensure(gatewayHeaders("navigate"), "unknown");
    expect(unknownModule.status).toBe(404);
    expectNoInternalAddress(await unknownModule.json());
    expect((await fetch(`${origin}/api/internal/hosted/modules/notes/ensure`, {
      method: "POST",
      headers: gatewayHeaders("navigate"),
    })).status).toBe(405);
    // Background requests are not an Open.
    expect((await ensure(gatewayHeaders("cors"))).status).toBe(503);
    await expectPortClosed(appPort);

    // A signed-in top-level navigation to the App hostname is an Open.
    expect((await ensure(gatewayHeaders("navigate"))).status).toBe(204);
    expect((await fetch(`http://127.0.0.1:${appPort}/health`)).status).toBe(200);
    expect((await ensure(gatewayHeaders("cors"))).status).toBe(204);

    const inventoryResponse = await fetch(`${origin}/api/personalspace`, {
      headers: { cookie, "sec-fetch-site": "same-origin" },
    });
    expect(inventoryResponse.status).toBe(200);
    const inventory = await inventoryResponse.json();
    expect(inventory.spaces[0].apps.map((app) => app.id).sort()).toEqual([
      "personal--exampleuser_GEN3--broken-v1",
      appId,
    ]);
    expectNoInternalAddress(inventory);

    expect(await lifecycle("health", "GET")).toMatchObject({ status: 200, payload: { status: "healthy" } });
    expect(await lifecycle("health")).toMatchObject({ status: 200, payload: { status: "healthy" } });
    // A real failing lifecycle route: the conflict carries its runtime
    // diagnostics internally, the hosted answer only the bounded shape.
    const conflict = await lifecycle("start");
    expect(conflict.status).toBeGreaterThanOrEqual(400);
    expect(Object.keys(conflict.payload).every((key) => ["error", "message", "app_id", "status"].includes(key)))
      .toBe(true);
    expect(conflict.payload.app_id).toBe(appId);
    expect(await lifecycle("restart")).toMatchObject({ status: 200 });
    expect(await lifecycle("logs", "GET")).toMatchObject({ status: 200, payload: { content_available: false } });
    expect(await lifecycle("stop")).toMatchObject({ status: 200 });
    await waitForPortVacancy(appPort);

    // Explicit Stop holds against background traffic until the next Open.
    expect((await ensure(gatewayHeaders("cors"))).status).toBe(503);
    await expectPortClosed(appPort);
    expect(await lifecycle("open")).toMatchObject({
      status: 200,
      payload: { url: "https://notes.frozen-slug.lazurio.io/" },
    });
    expect(await lifecycle("stop")).toMatchObject({ status: 200 });
    await waitForPortVacancy(appPort);
    expect((await ensure(gatewayHeaders("navigate"))).status).toBe(204);
    expect(await lifecycle("stop")).toMatchObject({ status: 200 });
    await waitForPortVacancy(appPort);
    const install = await lifecycle("install");
    expect([200, 409, 500]).toContain(install.status);

    // A start failure with a log tail containing a loopback URL.
    const brokenResponse = await fetch(
      `${origin}/api/personalspace/apps/${encodeURIComponent("personal--exampleuser_GEN3--broken-v1")}/start`,
      { method: "POST", headers: mutationHeaders, body: "{}" },
    );
    const brokenText = await brokenResponse.text();
    expect(brokenResponse.status).toBeGreaterThanOrEqual(400);
    expect(brokenText).not.toContain("crash-marker");
    expect(brokenText).not.toMatch(/127\.0\.0\.1|localhost/);
    const broken = JSON.parse(brokenText);
    expectNoInternalAddress(broken);
    expect(Object.keys(broken).every((key) => ["error", "message", "app_id", "status"].includes(key))).toBe(true);
    const brokenEnsure = await ensure(gatewayHeaders("navigate"), "broken");
    expect(brokenEnsure.status).toBe(503);
    const brokenEnsureText = await brokenEnsure.text();
    expect(brokenEnsureText).not.toContain("crash-marker");
    if (brokenEnsureText) expectNoInternalAddress(JSON.parse(brokenEnsureText));

    expect((await getJson(port, "/health")).maintenance).toMatchObject({ total: 2 });
  } finally {
    gateway.stop(true);
  }
}, platformTestTimeout(60_000));

test("hosted personal Launchpad refuses to start without its exact Personalspace", async () => {
  const root = await createLaunchpadGitFixture();
  const stateRoot = `${root}-personal-state`;
  tempRoots.push(root, stateRoot);
  // A Personalspace of the same slug but another folder is not the binding.
  await mountPersonalspace(root, "frozen-slug");
  await expect(startLaunchpadServer(root, {
    env: personalHostedEnvironment(stateRoot, await findFreePort()),
  })).rejects.toThrow("personalspace/exampleuser_GEN3 (LAZURIO_HOSTED_PERSONALSPACE) is not mounted, and the Personalspace mountpoint also holds personalspace/frozen-slug_GEN3");
});

test("hosted personal Launchpad serves a setup prompt until the owner clones the Personalspace", async () => {
  const root = await createLaunchpadGitFixture();
  const stateRoot = `${root}-personal-state`;
  const cli = `${root}-fake-t3.sh`;
  await writeFile(cli, `printf '{"credential":"G2RQZFN6MK77"}'\n`);
  tempRoots.push(root, stateRoot, cli);
  // A fresh personal Machine: nobody may create the owner's private repo.
  await rm(join(root, "personalspace", "exampleuser_GEN3"), { recursive: true, force: true });

  const { port } = await startLaunchpadServer(root, {
    env: {
      ...personalHostedEnvironment(stateRoot, await findFreePort()),
      LAZURIO_T3CODE_URL: "https://t3code.frozen-slug.lazurio.io/",
      LAZURIO_T3CODE_PAIRING_COMMAND: JSON.stringify(["/bin/sh", cli]),
    },
  });
  expect((await fetch(`http://127.0.0.1:${port}/`)).status).toBe(200);
  const inventory = await getJson(port, "/api/apps");
  expect(inventory).toMatchObject({
    ok: true,
    apps: [],
    organizations: [],
    hosted_personalspace: { state: "missing", mount_path: "personalspace/exampleuser_GEN3", discovery_issues: 0 },
  });
  const health = await getJson(port, "/health");
  expect(health).toMatchObject({ status: "ok", hosted_personalspace: { state: "missing", discovery_issues: 0 } });
  expect(health.maintenance.total).toBe(0);
  // The Chat/T3 Code entry is how the owner clones it; it stays available.
  expect((await getJson(port, "/api/chat")).available).toBe(true);

  // The owner clones their Personalspace; the periodic refresh picks it up.
  await mountPersonalspace(root, "exampleuser");
  let observed;
  const deadline = Date.now() + 25_000;
  do {
    observed = await getJson(port, "/health");
    if (observed.hosted_personalspace?.state === "mounted") break;
    await Bun.sleep(250);
  } while (Date.now() < deadline);
  expect(observed.hosted_personalspace).toEqual({ state: "mounted", discovery_issues: 0 });
  expect((await getJson(port, "/api/apps")).hosted_personalspace).toEqual({
    state: "mounted", mount_path: "personalspace/exampleuser_GEN3", discovery_issues: 0,
  });
}, platformTestTimeout(40_000));

test("hosted personal Launchpad refuses a present but invalid Personalspace", async () => {
  const root = await createLaunchpadGitFixture();
  const stateRoot = `${root}-personal-state`;
  tempRoots.push(root, stateRoot);
  await mountPersonalspace(root, "exampleuser");
  await writeFile(join(root, "personalspace", "exampleuser_GEN3", "personal.gen3.json"), "{ broken");
  await expect(startLaunchpadServer(root, {
    env: personalHostedEnvironment(stateRoot, await findFreePort()),
  })).rejects.toThrow("personalspace/exampleuser_GEN3 (LAZURIO_HOSTED_PERSONALSPACE) is not mounted; the folder exists");

  // An empty or unfinished checkout of the exact folder is present, not absent.
  await rm(join(root, "personalspace", "exampleuser_GEN3"), { recursive: true, force: true });
  await mkdir(join(root, "personalspace", "exampleuser_GEN3"), { recursive: true });
  await expect(startLaunchpadServer(root, {
    env: personalHostedEnvironment(stateRoot, await findFreePort()),
  })).rejects.toThrow("is not mounted; the folder exists");
});

test("hosted personal Launchpad refuses a valid Personalspace beside a foreign one", async () => {
  const root = await createLaunchpadGitFixture();
  const stateRoot = `${root}-personal-state`;
  tempRoots.push(root, stateRoot);
  await mountPersonalspace(root, "exampleuser");
  await mountPersonalspace(root, "foreign");
  await expect(startLaunchpadServer(root, {
    env: personalHostedEnvironment(stateRoot, await findFreePort()),
  })).rejects.toThrow(
    "personalspace/exampleuser_GEN3 (LAZURIO_HOSTED_PERSONALSPACE) is mounted, but the Personalspace mountpoint also holds personalspace/foreign_GEN3",
  );
  // A manifestless foreign folder is refused the same way.
  await rm(join(root, "personalspace", "foreign_GEN3"), { recursive: true, force: true });
  await mkdir(join(root, "personalspace", "foreign_GEN3"), { recursive: true });
  await expect(startLaunchpadServer(root, {
    env: personalHostedEnvironment(stateRoot, await findFreePort()),
  })).rejects.toThrow("is mounted, but the Personalspace mountpoint also holds personalspace/foreign_GEN3");
});

test("hosted personal Launchpad starts and reports per-app discovery failures in a valid Personalspace", async () => {
  const root = await createLaunchpadGitFixture();
  const stateRoot = `${root}-personal-state`;
  tempRoots.push(root, stateRoot);
  await mountPersonalspace(root, "exampleuser");
  // Two personal apps claiming the same lease port: an app-level failure that
  // isolates them, never a reason to stop serving the Machine.
  for (const module of ["notes", "journal"]) {
    const appDir = join(root, "personalspace", "exampleuser_GEN3", "workspace", module, "app", "v1");
    await mkdir(appDir, { recursive: true });
    await writeJson(join(appDir, "package.json"), {
      name: `exampleuser-${module}`,
      version: "1.0.0",
      packageManager: "bun@1.0.0",
      scripts: { dev: "bun run server.mjs" },
      companyascode: {
        app: {
          schema_version: "companyascode.launchpad_app.v1",
          id: `${module}-v1`,
          title: module,
          company: "exampleuser",
          module,
          surface: "internal",
          port: 41_150,
          host: "127.0.0.1",
          health_path: "/health",
          dev_script: "dev",
          tags: ["personal"],
        },
      },
    });
  }
  const { port } = await startLaunchpadServer(root, {
    env: personalHostedEnvironment(stateRoot, await findFreePort()),
  });
  const health = await getJson(port, "/health");
  expect(health.status).toBe("ok");
  expect(health.hosted_personalspace.state).toBe("mounted");
  expect(health.hosted_personalspace.discovery_issues).toBeGreaterThan(0);
  const inventory = await getJson(port, "/api/apps");
  expect(inventory.hosted_personalspace).toMatchObject({ state: "mounted", mount_path: "personalspace/exampleuser_GEN3" });
  expect(inventory.hosted_personalspace.discovery_issues).toBeGreaterThan(0);
});

test("hosted personal Launchpad starts and reports an invalid personal app manifest", async () => {
  const root = await createLaunchpadGitFixture();
  const stateRoot = `${root}-personal-state`;
  tempRoots.push(root, stateRoot);
  await mountPersonalspace(root, "exampleuser");
  const appDir = join(root, "personalspace", "exampleuser_GEN3", "workspace", "notes", "app", "v1");
  await mkdir(appDir, { recursive: true });
  await writeJson(join(appDir, "package.json"), {
    name: "exampleuser-notes",
    version: "1.0.0",
    packageManager: "bun@1.0.0",
    scripts: { dev: "bun run server.mjs" },
    companyascode: {
      app: {
        schema_version: "companyascode.launchpad_app.v1",
        id: "notes-v1",
        title: "notes",
        company: "exampleuser",
        module: "notes",
        surface: "not-a-surface",
        port: 41_160,
        host: "127.0.0.1",
        health_path: "/health",
        dev_script: "dev",
        tags: ["personal"],
      },
    },
  });
  const { server, port } = await startLaunchpadServer(root, {
    env: personalHostedEnvironment(stateRoot, await findFreePort()),
  });
  const health = await getJson(port, "/health");
  expect(health.status).toBe("ok");
  expect(health.hosted_personalspace.state).toBe("mounted");
  expect(health.hosted_personalspace.discovery_issues).toBeGreaterThan(0);
  const inventory = await getJson(port, "/api/apps");
  expect(inventory.hosted_personalspace).toMatchObject({ state: "mounted", mount_path: "personalspace/exampleuser_GEN3" });
  expect(inventory.hosted_personalspace.discovery_issues).toBe(health.hosted_personalspace.discovery_issues);
  // Logged once, before the startup announcement.
  server.kill();
  const stderr = await new Response(server.stderr).text();
  const logged = stderr.split("\n").filter((line) =>
    line.includes("hosted personal Personalspace discovery issue (non-fatal)")
    && line.includes("(invalid personal app manifest)"));
  expect(logged.length).toBeGreaterThan(0);
  expect(new Set(logged).size).toBe(logged.length);
});

test("hosted personal Launchpad refuses a malformed LAZURIO_HOSTED_PERSONALSPACE", async () => {
  const root = await createLaunchpadGitFixture();
  const stateRoot = `${root}-personal-state`;
  tempRoots.push(root, stateRoot);
  for (const folder of ["../exampleuser_GEN3", "exampleuser", ""]) {
    await expect(startLaunchpadServer(root, {
      env: { ...personalHostedEnvironment(stateRoot, await findFreePort()), LAZURIO_HOSTED_PERSONALSPACE: folder },
    })).rejects.toThrow("LAZURIO_HOSTED_PERSONALSPACE is required for LAZURIO_HOSTED_SCOPE=personal");
  }
});

test("hosted personal Launchpad never builds the Organization read model", async () => {
  const root = await createLaunchpadGitFixture();
  const stateRoot = `${root}-personal-state`;
  tempRoots.push(root, stateRoot);
  await mountPersonalspace(root, "exampleuser");
  // A corrupt Organization mount fails every Organization discovery (the
  // Organization-scope hosted startup rejects it). Personal scope never reads it.
  await writeFile(join(root, "organizations", "BetaCo_GEN3", "company.gen3.json"), "{ broken");
  const { port } = await startLaunchpadServer(root, {
    env: personalHostedEnvironment(stateRoot, await findFreePort()),
  });
  const inventory = await getJson(port, "/api/apps");
  expect(inventory).toMatchObject({ ok: true, apps: [], organizations: [], failures: [], warnings: [] });
  expect((await getJson(port, "/health")).maintenance.total).toBe(0);
  const gitRepos = await fetch(`http://127.0.0.1:${port}/api/git/repos`);
  expect(gitRepos.status).toBe(404);
  expect((await gitRepos.json()).error).toBe("organization_lane_unavailable");
  const orgRuntime = await fetch(`http://127.0.0.1:${port}/api/apps/betaco-hosted-deals-v1/health`);
  expect(orgRuntime.status).toBe(404);
});

test("hosted Launchpad keeps Team modules cold and derives their external URLs", async () => {
  const root = await createLaunchpadGitFixture();
  const stateRoot = `${root}-launchpad-state`;
  const appPort = await findFreePort();
  const manifestPath = join(root, "organizations", "BetaCo_GEN3", "modules.manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.module_slots.find((slot) => slot.path === "workspace/deals").teams = ["sales"];
  manifest.module_slots.find((slot) => slot.path === "workspace/knowledgebase").teams = ["sales"];
  await writeJson(manifestPath, manifest);
  await mkdir(join(root, "organizations", "BetaCo_GEN3", "workspace", "knowledgebase"), { recursive: true });
  const app = {
    id: "betaco-hosted-deals-v1",
    title: "Hosted Deals",
    company: "BetaCo",
    module: "deals",
    port: appPort,
  };
  const appRoot = join(root, "organizations", "BetaCo_GEN3", "workspace", "deals", "app", "v1");
  await createPackageApp({
    root,
    packagePath: "organizations/BetaCo_GEN3/workspace/deals/app/v1",
    app,
  });
  await writeFile(join(appRoot, "server.mjs"), fixtureServerSource(), "utf8");
  tempRoots.push(root, stateRoot);
  const { gateway, env: authEnv } = process.platform === "win32"
    ? { gateway: null, env: {} }
    : await startTlsAuthGateway(root, "__Secure-lazurio-sales-workspace");

  const { port, server } = await startLaunchpadServer(root, {
    env: {
      LAZURIO_WORKSPACE_PROFILE: "hosted",
      LAZURIO_ORGANIZATION_SLUG: "BetaCo",
      LAZURIO_TEAM_ID: "sales",
      LAZURIO_HOSTED_DOMAIN: "workspace.example.test",
      LAZURIO_LAUNCHPAD_STATE_ROOT: stateRoot,
      LAZURIO_LAUNCHPAD_EXTERNAL_ORIGIN: "https://launchpad.builder.workspace.example.test",
      LAZURIO_LAUNCHPAD_AUTH_COOKIE_NAME: "__Secure-lazurio-sales-workspace",
      LAZURIO_LAUNCHPAD_AUTH_CHECK_URL: `https://127.0.0.1:${await findFreePort()}/oauth2/auth`,
      ...authEnv,
    },
  });
  await Bun.sleep(100);
  await expect(fetch(`http://127.0.0.1:${appPort}/health`)).rejects.toThrow();

  const apps = await getJson(port, "/api/apps");
  expect(apps.apps).toEqual([
    expect.objectContaining({
      id: app.id,
      url: "https://deals.builder.workspace.example.test/",
      runtime: expect.objectContaining({ managed: false }),
    }),
  ]);
  expect((await getJson(port, "/health")).module_lifecycle).toBe("on-demand-v1");
  expect((await getJson(port, "/health")).maintenance).toEqual({
    schema_version: "lazurio.hosted_workspace_maintenance.v1",
    total: 1,
    healthy: 0,
    stopped: 1,
    starting: 0,
    degraded: 0,
    skipped: 1,
  });
  if (!gateway) return;
  try {
    // The Organization Team uses the same Module-keyed gateway contract as a
    // personal Machine; the App-id form stays available.
    const cookie = "__Secure-lazurio-sales-workspace=valid-session";
    const gatewayHeaders = (mode) => ({
      cookie,
      origin: "https://launchpad.builder.workspace.example.test",
      "sec-fetch-site": "same-origin",
      "sec-fetch-mode": mode,
    });
    const ensure = (headers, path = "modules/deals") =>
      fetch(`http://127.0.0.1:${port}/api/internal/hosted/${path}/ensure`, { headers });
    expect((await ensure({ cookie, "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate" })).status)
      .toBe(403);
    expect((await ensure(gatewayHeaders("navigate"), "modules/knowledgebase")).status).toBe(404);
    expect((await ensure(gatewayHeaders("cors"))).status).toBe(503);
    await expectPortClosed(appPort);
    expect((await ensure(gatewayHeaders("navigate"))).status).toBe(204);
    expect((await fetch(`http://127.0.0.1:${appPort}/health`)).status).toBe(200);
    expect((await ensure(gatewayHeaders("cors"), `apps/${app.id}`)).status).toBe(204);
    const stopped = await fetch(`http://127.0.0.1:${port}/api/apps/${app.id}/stop`, {
      method: "POST",
      headers: { ...gatewayHeaders("cors"), "content-type": "application/json" },
      body: "{}",
    });
    expect(stopped.status).toBe(200);
    await waitForPortVacancy(appPort);
  } finally {
    gateway.stop(true);
  }
}, platformTestTimeout(30_000));

test("instance-bound local shutdown rejects stale callers and stops the managed module process tree", async () => {
  const root = await createLaunchpadGitFixture();
  // A resident workspace has no framework checkout; the running Server owns it.
  for (const name of ["launchpad", "guide", "manual"]) {
    await rm(join(root, name), { recursive: true });
  }
  const appPort = await findFreePort();
  const app = {
    id: "betaco-session-shutdown-v1",
    title: "Session shutdown",
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
    join(root, "organizations", "BetaCo_GEN3", "workspace", "deals", "app", "v1", "server.mjs"),
    fixtureServerSource(),
    "utf8",
  );
  tempRoots.push(root);
  const { server, port, serverStateDirectory } = await startLaunchpadServer(root);
  const personalMissingSourceResponse = await fetch(
    `http://127.0.0.1:${port}/api/personalspace/apps/not-an-app/start`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    },
  );
  expect({ status: personalMissingSourceResponse.status, payload: await personalMissingSourceResponse.json() }).toEqual({
    status: 400,
    payload: expect.objectContaining({ error: "runtime_source_required" }),
  });
  await postJson(port, `/api/apps/${app.id}/start`, { source: { type: "main" } });
  await waitForHealth(appPort, server);
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
  await waitForPortVacancy(appPort);
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
    body: JSON.stringify({ source: { type: "main" } }),
  });
  expect(failedMutation.ok).toBe(false);
  expect((await getJson(port, "/api/apps")).apps.map((app) => app.id)).toContain("omegaco-cache-studio-v1");
});

test("reused agent entry refreshes the active Server inventory before printing its Organization URL", async () => {
  const root = await createLaunchpadGitFixture();
  tempRoots.push(root);
  const primary = await startLaunchpadServer(root);

  const stale = await getJson(primary.port, "/api/apps");
  expect(stale.organizations.map((organization) => organization.slug)).not.toContain("FreshCo");
  await createOrganization({
    root,
    orgPath: "organizations/FreshCo_GEN3",
    slug: "FreshCo",
    moduleSlots: [],
  });

  const reuse = Bun.spawn([
    "bun",
    "src/server.mjs",
    "--root",
    root,
    "--port",
    String(primary.port),
    "--reuse",
    "--agent-entry",
    "--organization",
    "FreshCo",
  ], {
    cwd: join(import.meta.dirname, ".."),
    env: primary.environment,
    stdout: "pipe",
    stderr: "pipe",
  });

  expect(await reuse.exited).toBe(0);
  expect(await new Response(reuse.stdout).text()).toContain(
    `LAZURIO_LAUNCHPAD_URL=http://127.0.0.1:${primary.port}/#/org/FreshCo`,
  );
  expect((await getJson(primary.port, "/api/apps")).organizations.map(
    (organization) => organization.slug,
  )).toContain("FreshCo");
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
      Bun.sleep(platformTestTimeout(5_000)).then(() => {
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
    Bun.sleep(platformTestTimeout(3_000)).then(() => "timeout"),
  ]);
  if (outcome === "timeout") launcher.kill();

  expect(outcome).not.toBe("timeout");
  expect(outcome).not.toBe(0);
  expect(await new Response(launcher.stderr).text()).toContain("Chybí hodnota pro --port");
});

test("organization branding prefers the current brand asset and rejects unsafe paths", async () => {
  const root = await createLaunchpadGitFixture();
  tempRoots.push(root);
  const orgRoot = join(root, "organizations", "OmegaCo_GEN3");
  await mkdir(join(orgRoot, "brand"), { recursive: true });
  await writeFile(join(orgRoot, "brand", "logo.png"), "current-logo");
  await mkdir(join(orgRoot, "launchpad", "app", "v1", "web"), { recursive: true });
  await writeFile(join(orgRoot, "launchpad", "app", "v1", "web", "launchpad-icon.png"), "legacy-logo");
  const external = join(root, "outside-brand");
  await mkdir(external);
  await writeFile(join(external, "logo.png"), "must-not-leak");
  const betaOrgRoot = join(root, "organizations", "BetaCo_GEN3");
  await symlink(external, join(betaOrgRoot, "brand"), process.platform === "win32" ? "junction" : "dir");
  await mkdir(join(betaOrgRoot, "launchpad", "app", "v1", "web"), { recursive: true });
  await writeFile(join(betaOrgRoot, "launchpad", "app", "v1", "web", "launchpad-icon.png"), "safe-legacy-logo");
  const { port } = await startLaunchpadServer(root);
  const apps = await getJson(port, "/api/apps");
  expect(apps.organizations.find(org => org.slug === "OmegaCo").logo_url).toBe("/api/organizations/OmegaCo/logo");
  expect(apps.organizations.find(org => org.slug === "BetaCo").logo_url).toBe("/api/organizations/BetaCo/logo");
  const response = await fetch(`http://127.0.0.1:${port}/api/organizations/OmegaCo/logo`);
  expect(response.status).toBe(200);
  expect(await response.text()).toBe("current-logo");
  const fallbackResponse = await fetch(`http://127.0.0.1:${port}/api/organizations/BetaCo/logo`);
  expect(fallbackResponse.status).toBe(200);
  expect(await fallbackResponse.text()).toBe("safe-legacy-logo");
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

test("agent entry inventory refresh is local-only", async () => {
  const root = await createLaunchpadGitFixture();
  tempRoots.push(root);
  const { port } = await startLaunchpadServer(root);

  const crossOrigin = await fetch(`http://127.0.0.1:${port}/api/lazurio/agent-entry-refresh`, {
    method: "POST",
    headers: { origin: "https://evil.invalid", "sec-fetch-site": "cross-site" },
  });
  expect(crossOrigin.status).toBe(403);
  expect(await crossOrigin.json()).toEqual({ error: "mutating_request_forbidden" });

  const wrongMethod = await fetch(`http://127.0.0.1:${port}/api/lazurio/agent-entry-refresh`);
  expect(wrongMethod.status).toBe(405);
});

test("Launchpad server forwards runtime source from POST body to worktree open", async () => {
  const root = await createLaunchpadGitFixture();
  tempRoots.push(root);
  const orgRoot = join(root, "organizations", "BetaCo_GEN3");
  const dealsRepo = join(orgRoot, "workspace", "deals");
  await initGitRepo(dealsRepo);
  const mainPort = await findFreePort();
  const companyPath = join(orgRoot, "company.gen3.json");
  const company = JSON.parse(await readFile(companyPath, "utf8"));
  company.module_port_pool = { start: mainPort, end: mainPort };
  await writeJson(companyPath, company);
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
  const packagePath = join(dealsRepo, "app", "v1", "package.json");
  const packageJson = JSON.parse(await readFile(packagePath, "utf8"));
  const legacyApp = packageJson.companyascode.app;
  delete packageJson.companyascode;
  packageJson.lazurio = {
    runtime: {
      schema_version: "lazurio.runtime.v1",
      id: legacyApp.id,
      title: legacyApp.title,
      company: legacyApp.company,
      module: legacyApp.module,
      surface: legacyApp.surface,
      dev_script: legacyApp.dev_script,
      tags: legacyApp.tags,
      listeners: [{
        id: "web",
        role: "entrypoint",
        lease: "main",
        protocol: "http",
        health: { kind: "http", path: legacyApp.health_path },
      }],
    },
  };
  await writeJson(packagePath, packageJson);
  await writeJson(join(dealsRepo, "lazurio.module.json"), {
    schema_version: "lazurio.module.v1",
    id: "deals",
    company: "BetaCo",
    tcp_port_policy: { mode: "single" },
    port_leases: [{ id: "main", host: "127.0.0.1", port: mainPort }],
    apps: ["app/v1/package.json"],
    default_app: "app/v1/package.json",
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
      const match = output.match(/Lazurio Launchpad běží na http:\/\/127\.0\.0\.1:(\d+)/);
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
function hostedSshEnvironment(externalOrigin) {
  return {
    LAZURIO_WORKSPACE_PROFILE: "hosted",
    LAZURIO_ORGANIZATION_SLUG: "BetaCo",
    LAZURIO_TEAM_ID: "sales",
    LAZURIO_HOSTED_DOMAIN: "workspace.example.test",
    LAZURIO_LAUNCHPAD_EXTERNAL_ORIGIN: externalOrigin,
    LAZURIO_LAUNCHPAD_AUTH_COOKIE_NAME: "__Secure-lazurio-sales-workspace",
  };
}

function syntheticSshKey(comment) {
  const name = Buffer.from("ssh-ed25519");
  const blob = Buffer.alloc(4 + name.length + 4 + 32);
  blob.writeUInt32BE(name.length, 0);
  name.copy(blob, 4);
  blob.writeUInt32BE(32, 4 + name.length);
  randomBytes(32).copy(blob, 8 + name.length);
  return `ssh-ed25519 ${blob.toString("base64")} ${comment}`;
}

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
  // The listener can answer /health before hosted inventory validation ends.
  // Wait for the post-validation startup announcement, otherwise a rejecting
  // child can look ready on Windows before its exit is observed.
  await readLaunchpadPort(server);
  await waitForHealth(port, server, env.LAZURIO_LAUNCHPAD_BASE_PATH ?? "/");
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

async function waitForHealth(port, server, basePath = "/") {
  // A cold Windows runner may need more than 15 s to start the detached Bun
  // server after Git-heavy fixture setup. This remains bounded by the enclosing
  // test timeout and still fails immediately when the child exits.
  const deadline = Date.now() + platformTestTimeout(10_000);
  while (Date.now() < deadline) {
    // Pokud server spadl při startu (např. port si mezi findFreePort a bindem
    // stihl vzít někdo jiný), neplýtvej celým readiness timeoutem ani nepokračuj proti
    // cizímu serveru — vypíš rovnou proč.
    if (server && server.exitCode !== null) {
      const stderr = server.stderr ? await new Response(server.stderr).text() : "";
      throw new Error(`launchpad server on ${port} exited early (code ${server.exitCode}): ${stderr.trim()}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}${basePath}health`);
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
  expect({ status: response.status, payload: await response.clone().json() }).toMatchObject({
    status: expectedStatus,
  });
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


test("changing the mount replaces the located same-root server using its previous API path", async () => {
  const root = await createLaunchpadGitFixture(); tempRoots.push(root);
  const primary = await startLaunchpadServer(root);
  const replacement = Bun.spawn(["bun", "src/server.mjs", "--root", root, "--port", String(primary.port), "--reuse"], {
    cwd: join(import.meta.dirname, ".."),
    env: { ...primary.environment, LAZURIO_LAUNCHPAD_BASE_PATH: "/launchpad/" },
    stdout: "ignore", stderr: "pipe",
  });
  servers.push(replacement);
  await waitForHealth(primary.port, replacement, "/launchpad/");
  expect(await waitForProcessExit(primary.server, 5000)).toBe(0);
  expect((await fetch(`http://127.0.0.1:${primary.port}/api/apps`)).status).toBe(404);
  const response = await fetch(`http://127.0.0.1:${primary.port}/launchpad/api/lazurio/server-identity`);
  expect((await response.json()).base_path).toBe("/launchpad/");
});
