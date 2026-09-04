import { afterAll, expect, test } from "bun:test";
import { tmpdir } from "os";
import { join } from "path";
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "fs/promises";
import { appPlacementResolverForOrganization, buildDoctorReportFromAppsResponse, buildEnvironmentChecks, buildLaunchpadAppsResponse, buildLaunchpadDoctorReport, bunRuntimeCheck, codexRuntimeCheck, developerToolUpdateChecks, lazurioUpdateCheck, nodeRuntimeCheck, runtimeAppStatus } from "../../lazurio/runtime/diagnostics-lib.mjs";
import {
  createLaunchpadGitFixture,
  createRepositoryDbWorktreeFixture,
  initGitRepo,
  runGit,
} from "./git-fixture-helpers.test.mjs";
import { createWorktreeFromPlan } from "./worktree-actions-lib.mjs";
import { buildGitInventory } from "../../lazurio/runtime/git-inventory-lib.mjs";
import { supportsFileSymlinks } from "../../scripts/test-platform-capabilities.mjs";

const tempRoots = [];
const fileSymlinkCapability = await supportsFileSymlinks();

afterAll(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
});

test("Bun Doctor check enforces the exact authority and gives an Agent handoff", () => {
  const current = bunRuntimeCheck({
    companiesRoot: "/fixture",
    bunExecutable: "/trusted/bun",
    requiredVersion: "1.4.0",
    run: () => ({ ok: true, stdout: "1.4.0", stderr: "" }),
  });
  const mismatch = bunRuntimeCheck({
    companiesRoot: "/fixture",
    bunExecutable: "/trusted/bun",
    requiredVersion: "1.4.0",
    run: () => ({ ok: true, stdout: "1.4.1", stderr: "" }),
  });

  expect(current).toMatchObject({ id: "platform.bun", status: "ok" });
  expect(mismatch).toMatchObject({ id: "platform.bun", status: "fail" });
  expect(mismatch.message).toContain("Principála");
  expect(mismatch.details).toEqual(expect.arrayContaining(["current: 1.4.1", "required: 1.4.0"]));
});

test("Node.js Doctor shares the Install Core version authority", () => {
  const supportedLts = nodeRuntimeCheck({
    companiesRoot: "/fixture",
    command: "/trusted/node",
    trustedExecutable: "/trusted/node",
    trustedCandidates: ["/trusted/node"],
    requiredRange: ">=22.12.0",
    run: () => ({ ok: true, stdout: "v24.19.0", stderr: "" }),
  });
  const supportedCurrent = nodeRuntimeCheck({
    companiesRoot: "/fixture",
    command: "/trusted/node",
    trustedExecutable: "/trusted/node",
    trustedCandidates: ["/trusted/node"],
    requiredRange: ">=22.12.0",
    run: () => ({ ok: true, stdout: "v26.5.0", stderr: "" }),
  });
  const incompatible = nodeRuntimeCheck({
    companiesRoot: "/fixture",
    command: "/trusted/node",
    trustedExecutable: "/trusted/node",
    trustedCandidates: ["/trusted/node"],
    requiredRange: ">=22.12.0",
    run: () => ({ ok: true, stdout: "v22.11.0", stderr: "" }),
  });
  const missing = nodeRuntimeCheck({
    companiesRoot: "/fixture",
    command: null,
    trustedExecutable: null,
    trustedCandidates: ["/trusted/node"],
    requiredRange: ">=22.12.0",
    run: () => {
      throw new Error("missing Node.js must not execute");
    },
  });

  expect(supportedLts).toMatchObject({ id: "platform.node", status: "ok" });
  expect(supportedCurrent).toMatchObject({ id: "platform.node", status: "ok" });
  expect(incompatible).toMatchObject({ id: "platform.node", status: "fail" });
  expect(incompatible.message).toContain(">=22.12.0");
  expect(missing).toMatchObject({ id: "platform.node", status: "fail" });
  expect(missing.message).toContain("není dostupný");
  expect(missing.links[0]?.url).toBe("https://nodejs.org/en/download");

  const installedButNotOnPath = nodeRuntimeCheck({
    companiesRoot: "/fixture",
    command: null,
    trustedExecutable: "/trusted/node",
    trustedCandidates: ["/trusted/node"],
    requiredRange: ">=22.12.0",
    run: () => {
      throw new Error("Node.js outside PATH must not execute");
    },
  });
  expect(installedButNotOnPath).toMatchObject({ id: "platform.node", status: "fail" });
  expect(installedButNotOnPath.message).toContain("nainstalovaný");

  const shadowed = nodeRuntimeCheck({
    companiesRoot: "/fixture",
    command: "/tmp/shadow/node",
    trustedExecutable: "/trusted/node",
    trustedCandidates: ["/trusted/node"],
    requiredRange: ">=22.12.0",
    run: () => {
      throw new Error("untrusted Node.js must not execute");
    },
  });
  expect(shadowed).toMatchObject({ id: "platform.node", status: "fail" });
  expect(shadowed.message).toContain("není ověřená");
});

test("Codex Doctor names the broken WinGet alias without accepting its target binary as ready", () => {
  const check = codexRuntimeCheck({
    companiesRoot: "C:\\Users\\Builder\\Lazurio",
    platform: "win32",
    architecture: "x64",
    environment: {
      Path: "C:\\Users\\Builder\\AppData\\Local\\Microsoft\\WinGet\\Packages\\OpenAI.Codex__DefaultSource",
      PATHEXT: ".EXE;.CMD",
    },
    resolvePathCommand: (command) => (
      command === "codex-x86_64-pc-windows-msvc"
        ? "C:\\Users\\Builder\\AppData\\Local\\Microsoft\\WinGet\\Packages\\OpenAI.Codex__DefaultSource\\codex-x86_64-pc-windows-msvc.exe"
        : null
    ),
    run: () => {
      throw new Error("target-specific candidate must not be executed");
    },
  });

  expect(check).toMatchObject({
    id: "platform.codex",
    status: "fail",
    severity: "required",
  });
  expect(check.message).toContain("target-specific");
  expect(check.message).toContain("příkaz codex chybí");
  expect(check.details).toContain("candidate_probe: not_run_untrusted_candidate");
  expect(check.details).toContain("next_action: ask_principal_before_official_codex_standalone_install");
  expect(check.links[0]?.url).toContain("openai/codex/blob/main/scripts/install/install.ps1");
});

test("Codex Doctor accepts only a working codex command as ready", () => {
  const check = codexRuntimeCheck({
    companiesRoot: "/fixture",
    platform: "linux",
    architecture: "x64",
    environment: { PATH: "/trusted" },
    resolvePathCommand: (command) => command === "codex" ? "/trusted/codex" : null,
    run: () => ({ ok: true, exitCode: 0, stdout: "codex-cli 0.147.0", stderr: "" }),
  });

  expect(check).toMatchObject({ id: "platform.codex", status: "ok", severity: "required" });
  expect(check.message).toContain("codex-cli 0.147.0");
});

test("tool update Doctor checks warn the Agent without running an updater", async () => {
  const checks = await developerToolUpdateChecks({
    inspectUpdates: async () => [
      {
        id: "github_cli",
        title: "GitHub CLI",
        required: true,
        update_policy: "principal_consent_required",
        status: "update_available",
        reason: "newer_official_release",
        current_version: "2.97.0",
        latest_version: "2.98.0",
        release_url: "https://github.com/cli/cli/releases/tag/v2.98.0",
      },
      {
        id: "codex",
        title: "Codex CLI",
        required: true,
        update_policy: "principal_consent_required",
        status: "not_available",
        reason: "executable_not_found_on_path",
        current_version: null,
        latest_version: null,
        release_url: null,
      },
      {
        id: "claude",
        title: "Claude Code",
        required: false,
        update_policy: "principal_consent_required",
        status: "not_available",
        reason: "executable_not_found_on_path",
        current_version: null,
        latest_version: null,
        release_url: null,
      },
    ],
  });

  expect(checks.map((check) => check.id)).toEqual([
    "platform.github_cli_update",
    "platform.codex_update",
  ]);
  expect(checks[0]).toMatchObject({ status: "warn", severity: "recommended" });
  expect(checks[0].message).toContain("požádat Principála o souhlas");
  expect(checks[0].details).toContain("next_action: ask_principal_before_update");
  expect(checks[1]).toMatchObject({ status: "fail", severity: "required" });
  expect(checks[1].message).toContain("není dostupný v PATH");
  expect(checks[1].message).toContain("Principála");
  expect(checks[1].details).toContain("next_action: ask_principal_before_install");
});

test("Lazurio update Doctor check je read-only a nemá stable/nightly kanály", async () => {
  const base = await mkdtemp(join(tmpdir(), "update-channel-check-"));
  tempRoots.push(base);
  const repo = join(base, "root");
  const remote = join(base, "remote.git");
  await initGitRepo(repo, { remotePath: remote });
  await writeFile(join(repo, ".gitignore"), "launchpad.gen3.local.json\n");
  runGit(["add", ".gitignore"], repo);
  runGit(["commit", "-m", "ExampleOrg root"], repo);
  runGit(["push", "origin", "main"], repo);

  const current = lazurioUpdateCheck(repo);
  expect(current.id).toBe("update.lazurio");
  expect(current.status).toBe("ok");
  expect(current.message).toContain("origin/main");
  expect(JSON.stringify(current)).not.toMatch(/stable|nightly|release tag/i);

  await writeFile(join(repo, "ahead.txt"), "ahead\n");
  runGit(["add", "ahead.txt"], repo);
  runGit(["commit", "-m", "local ahead"], repo);
  const ahead = lazurioUpdateCheck(repo);
  expect(ahead.status).toBe("warn");
  expect(ahead.message).toContain("Local main");
  expect(ahead.details.join(" ")).toContain("Codex");

  // Mimo main = warn s odkazem na worktree disciplínu.
  runGit(["checkout", "-b", "feature/apply"], repo);
  const wrongBranch = lazurioUpdateCheck(repo);
  expect(wrongBranch.status).toBe("warn");
  expect(wrongBranch.message).toContain("main");
});

test("Doctor warns for reclaimable module occupancy but fails legacy foreign ports", () => {
  expect(runtimeAppStatus({
    dependencies: { state: "needs_install" },
    runtime: { owner: "foreign-port", status: "unhealthy" },
  })).toBe("fail");
  const modulePath = "organizations/TestCompany/workspace/demo/lazurio.module.json";
  const moduleApp = {
    dependencies: { state: "ready" },
    runtime: {
      owner: "unknown-port",
      status: "unhealthy",
      port_owner: { pid: 42123 },
    },
    runtime_contract: { schema_version: "lazurio.runtime.v1" },
    module_contract: { schema_version: "lazurio.module.v1", module_path: modulePath },
    entrypoint_listener: {
      allocation: "static",
      port: 24101,
      claim: { mode: "exclusive" },
      module_lease: { source: modulePath },
    },
  };
  expect(runtimeAppStatus(moduleApp)).toBe("warn");
  expect(runtimeAppStatus({
    ...moduleApp,
    runtime: {
      owner: "foreign-port",
      status: "unhealthy",
      port_owner: { pid: 42124 },
    },
  })).toBe("warn");
  expect(runtimeAppStatus({
    ...moduleApp,
    runtime: { owner: "unknown-port", status: "unhealthy", port_owner: null },
  })).toBe("fail");
  expect(runtimeAppStatus({
    ...moduleApp,
    dependencies: { state: "unknown_package_manager" },
  })).toBe("fail");
});

test("runtime inventory does not duplicate per-app warnings and failures", () => {
  const report = buildDoctorReportFromAppsResponse({
    launchpad_root: { display_name: "Test root" },
    root: "/tmp/test-root",
    failures: [],
    warnings: [],
    apps: [
      {
        id: "testco-warning-v1",
        title: "Warning app",
        package_path: "organizations/TestCo/workspace/warning/app/v1/package.json",
        runtime_status: "stopped",
        runtime: { status: "stopped", owner: "none" },
        dependencies: { state: "needs_install", message: "Dependencies need install." },
      },
      {
        id: "testco-failure-v1",
        title: "Failure app",
        package_path: "organizations/TestCo/workspace/failure/app/v1/package.json",
        runtime_status: "stopped",
        runtime: { status: "stopped", owner: "none" },
        dependencies: { state: "missing_lockfile", message: "Lockfile is missing." },
      },
    ],
    organizations: [],
    port_overlaps: [],
  }, {
    childLane: { children: [], checks: [] },
  });
  const checks = new Map(report.checks.map((check) => [check.id, check]));

  expect(checks.get("launchpad.runtime")?.status).toBe("ok");
  expect(checks.get("launchpad.runtime.testco-warning-v1")?.status).toBe("warn");
  expect(checks.get("launchpad.runtime.testco-failure-v1")?.status).toBe("fail");
  expect(report.summary.warn).toBe(1);
  expect(report.summary.fail).toBe(1);
});

test("Doctor treats an older inactive version on the healthy default module lease as expected", () => {
  const older = doctorSharedVersionApp({
    id: "testco-deals-v1",
    title: "Deals v1",
    packageVersion: "v1",
    runtimeStatus: "unhealthy",
    owner: "foreign-port",
    failureKind: "port_owner_cwd_mismatch",
  });
  const current = doctorSharedVersionApp({
    id: "testco-deals-v2",
    title: "Deals v2",
    packageVersion: "v2",
    runtimeStatus: "healthy",
    owner: "adopted-port",
  });
  const apps = doctorSharedVersionFamily([older, current], current.id);
  const report = buildDoctorRuntimeReport(apps);
  const checks = new Map(report.checks.map((check) => [check.id, check]));

  expect(checks.get("launchpad.runtime")?.message).toContain("očekávaně neaktivní verze: 1");
  expect(checks.get("launchpad.runtime")?.message).not.toContain("unhealthy");
  expect(checks.get(`launchpad.runtime.${older.id}`)).toMatchObject({
    status: "ok",
    message: expect.stringContaining("zdravá výchozí verze Deals v2"),
  });
  expect(checks.get(`launchpad.runtime.${older.id}`)?.details).toContain(`active_version: ${current.id}`);
  expect(report.summary.warn).toBe(0);
});

test("Doctor accepts a managed healthy default with verified listener reconciliation", () => {
  const older = doctorSharedVersionApp({
    id: "testco-deals-v1",
    title: "Deals v1",
    packageVersion: "v1",
    runtimeStatus: "unhealthy",
    owner: "foreign-port",
    failureKind: "port_owner_cwd_mismatch",
  });
  const current = doctorSharedVersionApp({
    id: "testco-deals-v2",
    title: "Deals v2",
    packageVersion: "v2",
    runtimeStatus: "healthy",
    owner: "current-instance",
  });
  const report = buildDoctorRuntimeReport(
    doctorSharedVersionFamily([older, current], current.id),
  );
  const check = report.checks.find(
    (candidate) => candidate.id === `launchpad.runtime.${older.id}`,
  );

  expect(current.runtime.port_owner).toBeNull();
  expect(current.runtime.pid).not.toBe(older.runtime.port_owner.pid);
  expect(check).toMatchObject({
    status: "ok",
    message: expect.stringContaining("zdravá výchozí verze Deals v2"),
  });
});

test("Doctor keeps a managed default fail-closed without exact listener proof", () => {
  for (const fixture of [
    {
      name: "missing reconciliation",
      mutate: (current) => {
        current.runtime.listener_reconciliation = null;
      },
    },
    {
      name: "different listener owner",
      mutate: (current) => {
        current.runtime.listener_reconciliation.declared[0].pid = 99_001;
      },
    },
  ]) {
    const older = doctorSharedVersionApp({
      id: `testco-${fixture.name.replaceAll(" ", "-")}-v1`,
      title: "Deals v1",
      packageVersion: "v1",
      runtimeStatus: "unhealthy",
      owner: "foreign-port",
      failureKind: "port_owner_cwd_mismatch",
    });
    const current = doctorSharedVersionApp({
      id: `testco-${fixture.name.replaceAll(" ", "-")}-v2`,
      title: "Deals v2",
      packageVersion: "v2",
      runtimeStatus: "healthy",
      owner: "current-instance",
    });
    fixture.mutate(current);
    const report = buildDoctorRuntimeReport(
      doctorSharedVersionFamily([older, current], current.id),
    );
    const check = report.checks.find(
      (candidate) => candidate.id === `launchpad.runtime.${older.id}`,
    );
    expect(check?.status, fixture.name).toBe("warn");
  }
});

test("Doctor keeps real shared-lease conflicts visible", () => {
  const cases = [
    {
      name: "different endpoint",
      older: { title: "Deals v1", port: 24_102 },
      current: { title: "Deals v2", port: 24_103 },
    },
    {
      name: "different app lineage",
      older: { title: "Deals Catalog v1" },
      current: { title: "Deals Editor v2" },
    },
  ];

  for (const fixture of cases) {
    const older = doctorSharedVersionApp({
      id: `testco-${fixture.name.replaceAll(" ", "-")}-v1`,
      title: fixture.older.title,
      packageVersion: "v1",
      port: fixture.older.port,
      runtimeStatus: "unhealthy",
      owner: "foreign-port",
      failureKind: "port_owner_cwd_mismatch",
    });
    const current = doctorSharedVersionApp({
      id: `testco-${fixture.name.replaceAll(" ", "-")}-v2`,
      title: fixture.current.title,
      packageVersion: "v2",
      port: fixture.current.port,
      runtimeStatus: "healthy",
      owner: "adopted-port",
    });
    const report = buildDoctorRuntimeReport(doctorSharedVersionFamily([older, current], current.id));
    const check = report.checks.find((candidate) => candidate.id === `launchpad.runtime.${older.id}`);
    expect(check?.status, fixture.name).toBe("warn");
  }

  const rollback = doctorSharedVersionApp({
    id: "testco-rollback-v1",
    title: "Deals v1",
    packageVersion: "v1",
    runtimeStatus: "healthy",
    owner: "adopted-port",
  });
  const selected = doctorSharedVersionApp({
    id: "testco-rollback-v2",
    title: "Deals v2",
    packageVersion: "v2",
    runtimeStatus: "unhealthy",
    owner: "foreign-port",
    failureKind: "port_owner_cwd_mismatch",
  });
  const rollbackReport = buildDoctorRuntimeReport(
    doctorSharedVersionFamily([rollback, selected], selected.id),
  );
  expect(rollbackReport.checks.find(
    (candidate) => candidate.id === `launchpad.runtime.${selected.id}`,
  )?.status).toBe("warn");
});

test("discovery preserves Git inventory warnings without duplicating worktree warnings", () => {
  const report = buildDoctorReportFromAppsResponse({
    launchpad_root: { display_name: "Test root" },
    root: "/tmp/test-root",
    failures: [],
    warnings: ["discovery warning", "git inventory warning", "worktree warning"],
    discovery_warnings: ["discovery warning"],
    git_inventory_warnings: ["git inventory warning"],
    git_worktree_warnings: ["worktree warning"],
    apps: [],
    organizations: [],
    port_overlaps: [],
  }, {
    childLane: { children: [], checks: [] },
  });
  const discovery = report.checks.find((check) => check.id === "launchpad.discovery");

  expect(discovery?.status).toBe("warn");
  expect(discovery?.details).toContain("discovery warning");
  expect(discovery?.details).toContain("git inventory warning");
  expect(discovery?.details).not.toContain("worktree warning");
});

test("first-paint apps response can skip the global Git census", async () => {
  const root = await createCompaniesWorkspaceFixture();
  const response = await buildLaunchpadAppsResponse({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    runtimeManager: { appsWithRuntime: async (apps) => apps },
    gitStatusService: {
      readStatuses() {
        throw new Error("Git census must not run during first paint");
      },
    },
    includeGit: false,
  });

  expect(response.apps.every((app) => app.git === undefined)).toBe(true);
  expect(response.warnings.some((warning) => warning.startsWith("git:"))).toBe(false);
});

test("explicit module presentation hides historical owners and keeps human descriptions", async () => {
  const root = await createCompaniesWorkspaceFixture();
  const companyRoot = join(root, "organizations", "CatalogCo_GEN3");
  await mkdir(join(companyRoot, "manual"), { recursive: true });
  await mkdir(join(companyRoot, "company", "colleagues"), { recursive: true });
  await writeJson(join(companyRoot, "company.gen3.json"), {
    organization_generation: "gen3",
    company: { slug: "CatalogCo", display_name: "Catalog Co", github_org: "CatalogCo" },
    teams: [{ slug: "office", display_name: "Office", default: true }],
  });
  await writeJson(join(companyRoot, "modules.manifest.json"), {
    organization_generation: "gen3",
    company: "CatalogCo",
    github_org: "CatalogCo",
    module_slots: [
      {
        path: "workspace/current",
        slug: "current",
        name: "Aktivní modul",
        description: "Srozumitelný popis modulu.",
        required_roles: ["*"],
        teams: ["office"],
        git: { url: "git@github.com:CatalogCo/current.git", branch: "main" },
        status: "active",
      },
      {
        path: "workspace/history",
        slug: "history",
        name: "Historický owner",
        required_roles: ["*"],
        teams: ["office"],
        git: { url: "git@github.com:CatalogCo/history.git", branch: "main" },
        status: "active",
        ui_exposure: "diagnostics-only",
      },
    ],
  });
  await writeJson(join(companyRoot, "TODO.tasks.json"), {});
  await writeJson(join(companyRoot, "DONE.tasks.json"), {});
  await writeJson(join(companyRoot, "ISSUES.open.json"), {});

  const response = await buildLaunchpadAppsResponse({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    runtimeManager: { appsWithRuntime: async (apps) => apps },
  });
  const organization = response.organizations.find((item) => item.slug === "CatalogCo");
  const modules = organization?.teams.flatMap((team) => team.modules) ?? [];

  expect(modules).toEqual([
    expect.objectContaining({
      slug: "current",
      name: "Aktivní modul",
      description: "Srozumitelný popis modulu.",
    }),
  ]);
  expect(organization?.module_declarations).toContainEqual(
    expect.objectContaining({ slug: "history", ui_exposure: "diagnostics-only" }),
  );
});

test("module presentation metadata enriches an app without overriding its own description", () => {
  const resolvePlacement = appPlacementResolverForOrganization({
    path: "organizations/CatalogCo_GEN3",
    teams: [{ slug: "office", default: true }],
    module_declarations: [{
      path: "workspace/current",
      space: "workspace",
      teams: ["office"],
      description: "Popis z katalogu modulu.",
    }],
  });

  expect(resolvePlacement({
    package_path: "organizations/CatalogCo_GEN3/workspace/current/app/v1/package.json",
  })).toMatchObject({ description: "Popis z katalogu modulu." });
  expect(resolvePlacement({
    package_path: "organizations/CatalogCo_GEN3/workspace/current/app/v1/package.json",
    description: "Popis přímo z aplikace.",
  })).toMatchObject({ description: "Popis přímo z aplikace." });
});

test("apps response materializes HTTPS endpoints from the module-owned lease", async () => {
  const root = await createCompaniesWorkspaceFixture();
  const companyRoot = join(root, "organizations", "SecureCo_GEN3");
  const appRoot = join(companyRoot, "workspace", "secure", "app", "v1");
  await mkdir(join(companyRoot, "manual"), { recursive: true });
  await mkdir(join(companyRoot, "company", "colleagues"), { recursive: true });
  await mkdir(appRoot, { recursive: true });
  await writeJson(join(companyRoot, "company.gen3.json"), {
    organization_generation: "gen3",
    company: { slug: "SecureCo", display_name: "Secure Co", github_org: "SecureCo" },
    module_port_pool: { start: 5400, end: 5499 },
    teams: [{ slug: "workspace", display_name: "Workspace", default: true }],
  });
  await writeJson(join(companyRoot, "modules.manifest.json"), {
    organization_generation: "gen3",
    company: "SecureCo",
    github_org: "SecureCo",
    module_slots: [
      {
        path: "workspace/secure",
        teams: ["workspace"],
        git: { url: "git@github.com:SecureCo/secure.git", branch: "main" },
      },
      {
        path: "workspace/planned",
        teams: ["workspace"],
      },
    ],
  });
  await writeJson(join(appRoot, "package.json"), {
    name: "@secureco/secure",
    private: true,
    scripts: { dev: "bun server.mjs" },
    lazurio: {
      runtime: {
        schema_version: "lazurio.runtime.v1",
        id: "secureco-secure",
        title: "Secure",
        company: "SecureCo",
        module: "secure",
        surface: "internal",
        dev_script: "dev",
        tags: ["secure"],
        listeners: [{
          id: "web",
          role: "entrypoint",
          lease: "main",
          protocol: "https",
          health: { kind: "http", path: "/health" },
        }],
      },
    },
  });
  await writeJson(join(companyRoot, "workspace", "secure", "lazurio.module.json"), {
    schema_version: "lazurio.module.v1",
    id: "secure",
    company: "SecureCo",
    tcp_port_policy: { mode: "exception", reason: "The optional local editor owns a second listener." },
    port_leases: [
      { id: "main", host: "127.0.0.1", port: 5450 },
      { id: "editor", host: "127.0.0.1", port: 5451 },
    ],
    apps: ["app/v1/package.json"],
    default_app: "app/v1/package.json",
  });

  const response = await buildLaunchpadAppsResponse({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    runtimeManager: { appsWithRuntime: async (apps) => apps },
    includeGit: false,
  });
  expect(response.apps[0]).toMatchObject({
    url: "https://127.0.0.1:5450",
    health_url: "https://127.0.0.1:5450/health",
    module_app: {
      package: "app/v1/package.json",
      declared: true,
      default: true,
    },
    module_apps: {
      state: "declared",
      open_target_app_id: "secureco-secure",
      open_target_source: "declared-default",
    },
    module_catalog_path: "workspace/secure",
    module_open_target: true,
    editor: {
      status: "read_only",
      label: "Pouze pro čtení",
      listener: { host: "127.0.0.1", port: 5451 },
      component_path: "launchpad/components/editor/v2",
    },
  });
  const secureModule = response.organizations
    .find((organization) => organization.slug === "SecureCo")
    ?.teams.flatMap((team) => team.modules)
    .find((module) => module.path === "workspace/secure");
  expect(secureModule?.apps).toMatchObject({
    state: "declared",
    default_app: {
      package_path: "app/v1/package.json",
      app_id: "secureco-secure",
      record: "valid",
    },
    open_target_app_id: "secureco-secure",
  });
  const plannedModule = response.organizations
    .find((organization) => organization.slug === "SecureCo")
    ?.teams.flatMap((team) => team.modules)
    .find((module) => module.path === "workspace/planned");
  expect(plannedModule).toMatchObject({ status: "planned_slot" });
  expect(plannedModule?.apps).toBeUndefined();
  expect(response.port_policy_issues).toEqual([]);
  const report = buildDoctorReportFromAppsResponse(response);
  const check = report.checks.find((item) => item.id === "launchpad.port_ownership");
  expect(check?.status).toBe("ok");
  const appCheck = report.checks.find((item) => item.id === "launchpad.runtime.secureco-secure");
  expect(appCheck?.details).toContain("editor: read-only (known limitation)");

  const sharedEditorRoot = join(root, "launchpad", "components", "editor", "v2");
  await mkdir(join(sharedEditorRoot, "lib"), { recursive: true });
  await mkdir(join(sharedEditorRoot, "public"), { recursive: true });
  await writeFile(join(sharedEditorRoot, "lib", "astro-integration.ts"), "// fixture\n", "utf8");
  await writeFile(join(sharedEditorRoot, "lib", "create-server.ts"), "// fixture\n", "utf8");
  await writeFile(join(sharedEditorRoot, "public", "index.html"), "<!doctype html>\n", "utf8");
  await writeFile(join(sharedEditorRoot, "public", "app.js"), "// fixture\n", "utf8");
  await writeFile(join(sharedEditorRoot, "public", "styles.css"), "/* fixture */\n", "utf8");
  await writeJson(join(sharedEditorRoot, "component.json"), {
    schema_version: "lazurio.knowledgebase.editor.component.v2",
    entrypoints: {
      astro_integration: "lib/astro-integration.ts",
      server: "lib/create-server.ts",
    },
    public_files: ["public/index.html", "public/app.js", "public/styles.css"],
  });
  const readyResponse = await buildLaunchpadAppsResponse({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    runtimeManager: { appsWithRuntime: async (apps) => apps },
    includeGit: false,
  });
  expect(readyResponse.apps[0]?.editor).toMatchObject({
    status: "ready",
    label: "Editor připraven",
  });

  await writeJson(join(sharedEditorRoot, "component.json"), {
    schema_version: "lazurio.knowledgebase.editor.component.v2",
    entrypoints: {
      astro_integration: "lib/astro-integration.ts",
      server: "lib/create-server.ts",
    },
    public_files: ["public/index.html", "public/app.js"],
  });
  const incompleteManifestResponse = await buildLaunchpadAppsResponse({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    runtimeManager: { appsWithRuntime: async (apps) => apps },
    includeGit: false,
  });
  expect(incompleteManifestResponse.apps[0]?.editor?.status).toBe("read_only");

  await writeJson(join(sharedEditorRoot, "component.json"), {
    schema_version: "lazurio.knowledgebase.editor.component.v2",
    entrypoints: {
      astro_integration: "lib/astro-integration.ts",
      server: "lib/create-server.ts",
    },
    public_files: ["public/index.html", "public/app.js", "public/styles.css"],
  });
  await rm(join(sharedEditorRoot, "public", "styles.css"));
  const missingAssetResponse = await buildLaunchpadAppsResponse({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    runtimeManager: { appsWithRuntime: async (apps) => apps },
    includeGit: false,
  });
  expect(missingAssetResponse.apps[0]?.editor?.status).toBe("read_only");
});

test("Doctor treats Organization port policy violations as hard errors", () => {
  const report = buildDoctorReportFromAppsResponse({
    launchpad_root: { display_name: "Test root" },
    root: "/tmp/test-root",
    failures: [],
    warnings: [],
    apps: [],
    organizations: [],
    port_policy_issues: ["Example/demo má port lease, ale jeho Organizace nemá module_port_pool"],
  });
  const check = report.checks.find((item) => item.id === "launchpad.port_ownership");
  expect(check?.status).toBe("fail");
  expect(check?.details.join("\n")).toContain("nemá module_port_pool");
});

test("Doctor warns on local cross-Organization overlap without remapping ports", () => {
  const report = buildDoctorReportFromAppsResponse({
    launchpad_root: { display_name: "Test root" },
    root: "/tmp/test-root",
    failures: [],
    warnings: [],
    apps: [],
    organizations: [],
    port_overlaps: [{
      host: "127.0.0.1",
      port: 5401,
      classification: "cross-organization-lease",
      conflict: false,
      owners: [
        { app_id: "alpha-app", company: "Alpha", package_path: "organizations/Alpha/app/package.json" },
        { app_id: "beta-app", company: "Beta", package_path: "organizations/Beta/app/package.json" },
      ],
    }],
    organization_port_pool_overlaps: [{
      start: 5400,
      end: 5499,
      organizations: [{ company: "Alpha" }, { company: "Beta" }],
    }],
  });
  const check = report.checks.find((item) => item.id === "launchpad.port_ownership");
  expect(check?.status).toBe("warn");
  expect(check?.message).toContain("převzetí živé aplikace vyžaduje potvrzení");
});

test("Doctor reportuje deklarovaný port overlap jako hard failure", () => {
  const report = buildDoctorReportFromAppsResponse({
    launchpad_root: { display_name: "Test root" },
    root: "/tmp/test-root",
    failures: [],
    warnings: [],
    apps: [],
    organizations: [],
    port_overlaps: [{
      host: "127.0.0.1",
      port: 5392,
      classification: "declared-conflict",
      conflict: true,
      owners: [
        { app_id: "alpha-app", listener_id: "web", package_path: "organizations/Alpha/workspace/app/package.json" },
        { app_id: "beta-app", listener_id: "web", package_path: "organizations/Beta/workspace/app/package.json" },
      ],
    }],
  });
  const check = report.checks.find((item) => item.id === "launchpad.port_ownership");

  expect(check?.status).toBe("fail");
  expect(check?.message).toContain("1 kolizní listener");
  expect(check?.message).toContain("deklarace musí být opravena");
  expect(check?.details).toEqual([
    "127.0.0.1:5392 [declared-conflict]: alpha-app#web (organizations/Alpha/workspace/app/package.json), beta-app#web (organizations/Beta/workspace/app/package.json)",
  ]);
});

test("Doctor accepts one shared module-version lease", () => {
  const report = buildDoctorReportFromAppsResponse({
    launchpad_root: {}, root: "/tmp/test-root", failures: [], warnings: [], apps: [], organizations: [],
    port_overlaps: [{
      host: "127.0.0.1",
      port: 5287,
      classification: "module-version-lease",
      conflict: false,
      module_lease: "one/design-system#entrypoint",
      owners: [
        { app_id: "one-design-system", listener_id: "web", package_path: "organizations/One/package.json" },
        { app_id: "two-design-system", listener_id: "web", package_path: "organizations/Two/package.json" },
      ],
    }],
  });
  const check = report.checks.find((item) => item.id === "launchpad.port_ownership");
  expect(check?.status).toBe("ok");
  expect(check?.message).toContain("module-version lease");
});

test("doctor report obsahuje platform, git a gitignore checks", async () => {
  const root = await createCompaniesWorkspaceFixture();
  const report = await buildLaunchpadDoctorReport({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
  });
  const checks = new Map(report.checks.map((check) => [check.id, check]));

  expect(checks.get("platform.bun")?.status).toBe("ok");
  expect(checks.get("platform.bun_path")?.status).toBe("ok");
  expect(checks.get("platform.bun_package_runner")?.status).toBe("ok");
  expect(checks.get("platform.git")?.status).toBe("ok");
  expect(checks.has("platform.github_cli")).toBe(true);
  expect(checks.has("platform.github_auth")).toBe(true);
  expect(checks.has("platform.node")).toBe(true);
  expect(checks.has("platform.codex")).toBe(true);
  expect(checks.get("git.root")?.status).toBe("ok");
  expect(checks.get("git.worktree")?.status).toBe("ok");
  expect(checks.get("gitignore.protection")?.status).toBe("ok");
  expect(checks.get("launchpad.discovery")?.status).toBe("ok");
});

test("Doctor launchpad.discovery failuje na Organization cross-file identitě", async () => {
  const root = await createCompaniesWorkspaceFixture();
  const companyRoot = join(root, "organizations", "BrokenIdentity_GEN3");
  await mkdir(join(companyRoot, "manual"), { recursive: true });
  await mkdir(join(companyRoot, "company", "colleagues"), { recursive: true });
  await writeJson(join(companyRoot, "company.gen3.json"), {
    organization_generation: "gen3",
    company: {
      slug: "BrokenIdentity",
      display_name: "Broken Identity",
      github_org: "CorrectGithubOrg",
    },
    teams: [{ slug: "workspace", display_name: "Hlavní Team", default: true }],
  });
  await writeJson(join(companyRoot, "modules.manifest.json"), {
    organization_generation: "gen3",
    company: "OtherIdentity",
    github_org: "WrongGithubOrg",
    module_slots: [],
  });

  const report = await buildLaunchpadDoctorReport({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    runtimeManager: { appsWithRuntime: async (apps) => apps },
  });
  const discoveryCheck = report.checks.find((check) => check.id === "launchpad.discovery");

  expect(discoveryCheck?.status).toBe("fail");
  expect(discoveryCheck?.details.some((detail) => detail.includes("organization_modules_identity_conflict"))).toBe(true);
});

test("Doctor failuje, když manifestovaný modul kanonicky uniká do jiné Organization", async () => {
  const root = await createCompaniesWorkspaceFixture();
  const companyRoot = join(root, "organizations", "EscapingOrg_GEN3");
  const foreignPath = join(root, "organizations", "ForeignOrg_GEN3", "workspace", "shared");
  await mkdir(join(companyRoot, "manual"), { recursive: true });
  await mkdir(join(companyRoot, "company", "colleagues"), { recursive: true });
  await mkdir(foreignPath, { recursive: true });
  await writeJson(join(companyRoot, "company.gen3.json"), {
    organization_generation: "gen3",
    company: { slug: "EscapingOrg", display_name: "Escaping Org", github_org: "EscapingOrg" },
    teams: [{ slug: "workspace", display_name: "Hlavní Team", default: true }],
  });
  await writeJson(join(companyRoot, "modules.manifest.json"), {
    organization_generation: "gen3",
    company: "EscapingOrg",
    github_org: "EscapingOrg",
    module_slots: [
      { path: "../ForeignOrg_GEN3/workspace/shared", teams: ["workspace"], git: { url: "git@github.com:ForeignOrg/shared.git" } },
    ],
  });

  const report = await buildLaunchpadDoctorReport({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    runtimeManager: { appsWithRuntime: async (apps) => apps },
  });
  const discoveryCheck = report.checks.find((check) => check.id === "launchpad.discovery");

  expect(discoveryCheck?.status).toBe("fail");
  expect(discoveryCheck?.details.some((detail) => detail.includes("modules_manifest_slot_0_path_invalid"))).toBe(true);
}, 10_000);

test("template mounty nejsou kontrolované Organization-private gitignore probami", async () => {
  const root = await createTemplateMountFixture();
  const report = await buildLaunchpadDoctorReport({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
  });
  const checks = new Map(report.checks.map((check) => [check.id, check]));

  expect(checks.get("gitignore.protection")?.status).toBe("ok");
});

test("marker template mounty drží stejný Git mount gate jako Organizace", async () => {
  const root = await mkdtemp(join(tmpdir(), "companiesascode-template-git-mount-"));
  tempRoots.push(root);
  run(["git", "init"], root);
  // Marker template mount, který neexistuje jako Git checkout, musí git.mounts propadnout —
  // stejné gate jako u firmy, i když se nepočítá do organizations.
  const checks = buildEnvironmentChecks({
    companiesRoot: root,
    companies: [],
    templateMounts: [
      { slug: "OrganizationTemplate", path: "organizations/OrganizationTemplate_GEN3", status: "mounted", organization_kind: "template" },
    ],
  });
  const mountsCheck = checks.find((check) => check.id === "git.mounts");

  expect(mountsCheck.status).toBe("fail");
  expect(
    mountsCheck.details.some(
      (detail) => detail.includes("organizations/OrganizationTemplate_GEN3") && detail.includes("organization template"),
    ),
  ).toBe(true);
});

test("planned marker template mount se v git.mounts přeskočí jako planned Organizace", async () => {
  const root = await mkdtemp(join(tmpdir(), "companiesascode-template-planned-"));
  tempRoots.push(root);
  run(["git", "init"], root);
  // Planned template slot ještě nemá mount (decision 0024) → git.mounts ho nesmí kontrolovat.
  const checks = buildEnvironmentChecks({
    companiesRoot: root,
    companies: [],
    templateMounts: [
      { slug: "OrganizationTemplate", path: "organizations/OrganizationTemplate_GEN3", status: "planned", organization_kind: "template" },
    ],
  });
  const mountsCheck = checks.find((check) => check.id === "git.mounts");

  expect(mountsCheck.status).toBe("ok");
});

test("public apps projection hides unmaterialized protected slots while Doctor retains them", async () => {
  const root = await createCompaniesWorkspaceFixture();
  const companyRoot = join(root, "organizations", "OmegaCo_GEN3");
  await mkdir(join(companyRoot, "manual"), { recursive: true });
  await mkdir(join(companyRoot, "company", "colleagues"), { recursive: true });
  await writeJson(join(root, "launchpad.gen3.json"), {
    launchpad_root: {
      slug: "test-companies",
      display_name: "Test Companies",
      root_role: "companies-root",
    },
  });
  await writeJson(join(companyRoot, "company.gen3.json"), {
    organization_generation: "gen3",
    company: { slug: "OmegaCo", display_name: "OmegaCo", github_org: "OmegaCo" },
    workspaces: [
      { slug: "workspace", display_name: "OmegaCo Workspace", path: "workspace" },
      { slug: "productionspace", display_name: "OmegaCo Productionspace", path: "productionspace" },
    ],
    productionspace: {
      status: "candidate-boundary",
    },
  });
  await writeJson(join(companyRoot, "modules.manifest.json"), {
    organization_generation: "gen3",
    company: "OmegaCo",
    github_org: "OmegaCo",
    module_slots: [
      {
        path: "modules/knowledgebase",
        workspace: "workspace",
        category: "knowledge",
        default_access: "role_based",
        repo: "git@github.com:OmegaCo/knowledgebase.git",
        branch: "main",
      },
      {
        path: "modules/invoices",
        workspace: "workspace",
        category: "business",
        launchpad_port: 5308,
      },
      {
        path: "productionspace/monorepo",
        workspace: "productionspace",
        classification: "productionspace-candidate",
        category: "engineering",
        default_access: "role_based",
        required_roles: ["engineering"],
        repo: "git@github.com:OmegaCo/monorepo.git",
        branch: "main",
      },
    ],
  });
  await writeJson(join(companyRoot, "TODO.tasks.json"), {});
  await writeJson(join(companyRoot, "DONE.tasks.json"), {});
  await writeJson(join(companyRoot, "ISSUES.open.json"), {});

  const response = await buildLaunchpadAppsResponse({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    runtimeManager: { appsWithRuntime: async (apps) => apps },
  });

  const org = response.organizations.find((item) => item.slug === "OmegaCo");
  expect(org?.workspaces[0]).toMatchObject({
    slug: "workspace",
    modules: [
      {
        slug: "invoices",
        path: "modules/invoices",
        category: "business",
        launchpad_port: 5308,
        // slot bez repo deklarace → planned_slot (decision 0042)
        status: "planned_slot",
      },
    ],
  });
  expect(org?.productionspace).toMatchObject({
    slug: "productionspace",
    display_name: "OmegaCo Productionspace",
    status: "candidate-boundary",
    systems: [],
  });
  const publicPayload = JSON.stringify(response);
  expect(publicPayload).not.toContain("modules/knowledgebase");
  expect(publicPayload).not.toContain("productionspace/monorepo");
  // productionspace ve workspaces[] a workspace:"productionspace" hodnoty jsou
  // 0041 konflikty — hlásí je doctor jako warn, ne failure.
  expect(org?.workspace_conformance_issues?.some((issue) => issue.includes("workspaces[] obsahuje productionspace"))).toBe(true);
  const report = await buildLaunchpadDoctorReport({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    runtimeManager: { appsWithRuntime: async (apps) => apps },
  });
  const declarationCheck = report.checks.find((check) => check.id === "launchpad.workspace_declarations");
  expect(declarationCheck?.status).toBe("fail");
  expect(declarationCheck?.details.join("\n")).toContain("modules/knowledgebase");
  expect(declarationCheck?.details.join("\n")).toContain("productionspace/monorepo");
  expect(declarationCheck?.details.some((detail) => detail.includes("decision 0041"))).toBe(true);
  expect(declarationCheck?.details.some((detail) => detail.startsWith("blocker: "))).toBe(true);
  expect(declarationCheck?.details.some((detail) => detail.startsWith("warning: "))).toBe(true);
  expect(declarationCheck?.details.some((detail) => detail.startsWith("info: "))).toBe(true);
});

test("unmaterialized protected slot issues stay Doctor-only and cannot redden or leak through public readiness", async () => {
  const root = await createCompaniesWorkspaceFixture();
  const companyRoot = join(root, "organizations", "PrivateCo_GEN3");
  await mkdir(join(companyRoot, "manual"), { recursive: true });
  await mkdir(join(companyRoot, "company", "colleagues"), { recursive: true });
  await writeJson(join(root, "launchpad.gen3.json"), {
    launchpad_root: { slug: "test-companies", display_name: "Test Companies", root_role: "companies-root" },
  });
  const protectedSlot = {
    slug: "private-studio",
    path: "workspace/private-legacy",
    workspace: "workspace",
    default_access: "role_based",
    required_roles: ["private-builders"],
    repo: "git@github.com:PrivateCo/private-canonical.git",
    branch: "main",
  };
  await writeJson(join(companyRoot, "company.gen3.json"), {
    organization_generation: "gen3",
    company: { slug: "PrivateCo", display_name: "PrivateCo", github_org: "PrivateCo" },
    workspaces: [{ slug: "workspace", path: "workspace" }],
    modules: [protectedSlot],
  });
  await writeJson(join(companyRoot, "modules.manifest.json"), {
    organization_generation: "gen3",
    company: "PrivateCo",
    github_org: "PrivateCo",
    module_slots: [protectedSlot],
  });
  await writeJson(join(companyRoot, "TODO.tasks.json"), {});
  await writeJson(join(companyRoot, "DONE.tasks.json"), {});
  await writeJson(join(companyRoot, "ISSUES.open.json"), {});

  const response = await buildLaunchpadAppsResponse({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    runtimeManager: { appsWithRuntime: async (apps) => apps },
  });
  const org = response.organizations.find((item) => item.slug === "PrivateCo");
  const publicPayload = JSON.stringify(org);

  expect(org?.space_readiness?.blocking_slots).toEqual([]);
  expect((org?.workspaces ?? []).flatMap((workspace) => workspace.modules)).toEqual([]);
  for (const privateValue of [
    "private-studio",
    "workspace/private-legacy",
    "workspace/private-canonical",
    "private-builders",
    "lazurio repair module-location",
  ]) {
    expect(publicPayload).not.toContain(privateValue);
  }

  const report = await buildLaunchpadDoctorReport({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    runtimeManager: { appsWithRuntime: async (apps) => apps },
  });
  const declarationCheck = report.checks.find((check) => check.id === "launchpad.workspace_declarations");
  expect(declarationCheck?.details.join("\n")).toContain("workspace/private-legacy");
  expect(declarationCheck?.details.join("\n")).toContain("private-canonical");
});

test("materialized protected rename drift stays as one quarantined tile and makes the summary blocking", async () => {
  const root = await createCompaniesWorkspaceFixture();
  const companyRoot = join(root, "organizations", "OmegaCo_GEN3");
  const legacyPath = join(companyRoot, "workspace", "legacy");
  await mkdir(join(companyRoot, "manual"), { recursive: true });
  await mkdir(join(companyRoot, "company", "colleagues"), { recursive: true });
  await mkdir(legacyPath, { recursive: true });
  await writeJson(join(legacyPath, "lazurio.module.json"), {
    schema_version: "lazurio.module.v1",
    id: "studio",
    company: "OmegaCo",
  });
  const slot = {
    slug: "studio",
    path: "workspace/canonical",
    workspace: "workspace",
    default_access: "role_based",
    repo: "git@github.com:OmegaCo/canonical.git",
    branch: "main",
  };
  await writeJson(join(companyRoot, "company.gen3.json"), {
    organization_generation: "gen3",
    company: { slug: "OmegaCo", display_name: "OmegaCo", github_org: "OmegaCo" },
    workspaces: [{ slug: "workspace", path: "workspace" }],
    modules: [slot],
  });
  await writeJson(join(companyRoot, "modules.manifest.json"), {
    organization_generation: "gen3",
    company: "OmegaCo",
    github_org: "OmegaCo",
    module_slots: [slot],
  });
  await writeJson(join(companyRoot, "TODO.tasks.json"), {});
  await writeJson(join(companyRoot, "DONE.tasks.json"), {});
  await writeJson(join(companyRoot, "ISSUES.open.json"), {});

  const response = await buildLaunchpadAppsResponse({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    runtimeManager: { appsWithRuntime: async (apps) => apps },
  });

  const org = response.organizations.find((item) => item.slug === "OmegaCo");
  const tiles = (org?.workspaces ?? []).flatMap((workspace) => workspace.modules);
  expect(tiles).toHaveLength(1);
  expect(tiles[0]).toMatchObject({
    slug: "studio",
    path: "workspace/canonical",
    status: "quarantined",
    readiness: {
      severity: "blocking",
      reason: "repository_location_mismatch",
      next_action: {
        kind: "repair_module_location",
        command: "lazurio repair module-location --org OmegaCo --module studio",
      },
    },
  });
  expect(org?.space_readiness?.blocking_slots).toEqual([
    expect.objectContaining({
      slug: "studio",
      found_path: "workspace/legacy",
      expected_path: "workspace/canonical",
    }),
  ]);
  expect(org?.space_readiness?.blocking_slots).toHaveLength(1);
  expect(response.ok).toBe(true);
});

test("an Organization-fatal contract blocks only that Organization readiness while a sibling stays healthy", async () => {
  const root = await createCompaniesWorkspaceFixture();
  for (const [directory, slug] of [["BrokenCo_GEN3", "BrokenCo"], ["HealthyCo_GEN3", "HealthyCo"]]) {
    const organizationRoot = join(root, "organizations", directory);
    await mkdir(join(organizationRoot, "manual"), { recursive: true });
    await mkdir(join(organizationRoot, "company", "colleagues"), { recursive: true });
    await writeJson(join(organizationRoot, "company.gen3.json"), {
      organization_generation: "gen3",
      company: { slug, display_name: slug, github_org: slug },
      workspaces: [{ slug: "workspace", path: "workspace", default: true }],
    });
    await writeJson(join(organizationRoot, "modules.manifest.json"), {
      organization_generation: "gen3",
      company: slug === "BrokenCo" ? "DifferentCo" : slug,
      github_org: slug,
      module_slots: slug === "HealthyCo"
        ? [{ slug: "studio", path: "workspace/studio", git: { url: "git@github.com:HealthyCo/studio.git", branch: "main" } }]
        : [{ slug: "untrusted", path: "workspace/untrusted", git: { url: "git@github.com:BrokenCo/untrusted.git", branch: "main" } }],
    });
    await writeJson(join(organizationRoot, "TODO.tasks.json"), {});
    await writeJson(join(organizationRoot, "DONE.tasks.json"), {});
    await writeJson(join(organizationRoot, "ISSUES.open.json"), {});
  }
  const healthyApp = join(root, "organizations", "HealthyCo_GEN3", "workspace", "studio", "app", "v1");
  await mkdir(healthyApp, { recursive: true });
  await writeJson(join(healthyApp, "package.json"), {
    name: "healthyco-studio-v1",
    private: true,
    scripts: { dev: "bun server.mjs" },
    companyascode: {
      app: {
        schema_version: "companyascode.launchpad_app.v1",
        id: "healthyco-studio-v1",
        title: "Healthy Studio",
        company: "HealthyCo",
        module: "studio",
        surface: "internal",
        port: 5521,
        host: "127.0.0.1",
        health_path: "/health",
        dev_script: "dev",
      },
    },
  });

  const response = await buildLaunchpadAppsResponse({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    runtimeManager: { appsWithRuntime: async (apps) => apps },
  });
  const broken = response.organizations.find((organization) => organization.slug === "BrokenCo");
  const healthy = response.organizations.find((organization) => organization.slug === "HealthyCo");

  expect(response.apps.map((app) => app.id)).toEqual(["healthyco-studio-v1"]);
  expect(broken).toBeUndefined();
  expect(response.failures.join("\n")).toContain("organization_modules_identity_conflict");
  expect(healthy?.space_readiness?.blocking_slots).toEqual([]);
});

test("case-preserving productionspace mount uses explicit lowercase ID and fails closed without it", async () => {
  const root = await createCompaniesWorkspaceFixture();
  const companyRoot = join(root, "organizations", "HumanAndMachine-ai_GEN3");
  await mkdir(join(companyRoot, "manual"), { recursive: true });
  await mkdir(join(companyRoot, "company", "colleagues"), { recursive: true });
  await writeJson(join(companyRoot, "company.gen3.json"), {
    organization_generation: "gen3",
    company: {
      slug: "HumanAndMachine-ai",
      display_name: "Human and Machine",
      github_org: "HumanAndMachine-ai",
    },
    productionspace: { status: "active" },
  });
  const manifestPath = join(companyRoot, "modules.manifest.json");
  const manifest = {
    company: "HumanAndMachine-ai",
    github_org: "HumanAndMachine-ai",
    module_slots: [{
      slug: "buddy-gen2",
      name: "Buddy runtime",
      path: "productionspace/Buddy_GEN2",
      space: "productionspace",
      git: { url: "git@github.com:HumanAndMachine-ai/Buddy_GEN2.git", branch: "main" },
    }],
  };
  await writeJson(manifestPath, manifest);

  const valid = await buildLaunchpadAppsResponse({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    runtimeManager: { appsWithRuntime: async (apps) => apps },
  });
  expect(valid.organizations[0]?.productionspace?.systems[0]).toMatchObject({
    slug: "buddy-gen2",
    name: "Buddy runtime",
    path: "productionspace/Buddy_GEN2",
  });

  delete manifest.module_slots[0].slug;
  await writeJson(manifestPath, manifest);
  const invalidCompanyConfig = await Bun.file(join(companyRoot, "company.gen3.json")).json();
  invalidCompanyConfig.modules = [{
    slug: "buddy-gen2",
    path: "productionspace/Buddy_GEN2",
    space: "productionspace",
  }];
  await writeJson(join(companyRoot, "company.gen3.json"), invalidCompanyConfig);
  const invalid = await buildLaunchpadAppsResponse({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    runtimeManager: { appsWithRuntime: async (apps) => apps },
  });
  expect(invalid.organizations[0]?.productionspace?.systems ?? []).toEqual([]);
  expect(invalid.failures).toEqual([]);
  expect(invalid.organizations[0]?.space_readiness?.blocking_slots).toEqual(expect.arrayContaining([
    expect.objectContaining({
      scope: "module_slot",
      path: "productionspace/Buddy_GEN2",
      next_action: expect.objectContaining({ kind: "agent_review" }),
    }),
  ]));
});

test("apps read model uses modules.manifest.json as the sole normalized repository inventory", async () => {
  const root = await createCompaniesWorkspaceFixture();
  const companyRoot = join(root, "organizations", "ProjectionCo_GEN3");
  await mkdir(join(companyRoot, "manual"), { recursive: true });
  await mkdir(join(companyRoot, "company", "colleagues"), { recursive: true });
  await writeJson(join(companyRoot, "company.gen3.json"), {
    organization_generation: "gen3",
    company: { slug: "ProjectionCo", display_name: "Projection Co", github_org: "ProjectionCo" },
    teams: [{ slug: "workspace", display_name: "Workspace", default: true }],
    modules: [
      { slug: "shared", path: "workspace/bar", teams: ["workspace"] },
      { slug: "healthy-config", path: "workspace/healthy-config", teams: ["workspace"] },
    ],
  });
  await writeJson(join(companyRoot, "modules.manifest.json"), {
    company: "ProjectionCo",
    github_org: "ProjectionCo",
    module_slots: [
      { slug: "shared", path: "workspace/foo", teams: ["workspace"] },
      { slug: "healthy-manifest", path: "workspace/healthy-manifest", teams: ["workspace"] },
    ],
  });

  const response = await buildLaunchpadAppsResponse({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    runtimeManager: { appsWithRuntime: async (apps) => apps },
  });
  const modules = response.organizations[0]?.teams[0]?.modules ?? [];

  expect(modules.map((module) => module.slug).sort()).toEqual([
    "healthy-manifest",
    "shared",
  ]);
  expect(response.failures).toEqual([]);
  expect(response.organizations[0]?.space_readiness?.blocking_slots).toEqual([]);
});

test("apps read model rejects live casing drift and treats productionspace candidates as ordering only", async () => {
  const root = await createCompaniesWorkspaceFixture();
  const companyRoot = join(root, "organizations", "CandidateCo_GEN3");
  await mkdir(join(companyRoot, "manual"), { recursive: true });
  await mkdir(join(companyRoot, "company", "colleagues"), { recursive: true });
  await mkdir(join(companyRoot, "workspace", "Dashboard"), { recursive: true });
  await writeJson(join(companyRoot, "company.gen3.json"), {
    organization_generation: "gen3",
    company: { slug: "CandidateCo", display_name: "Candidate Co", github_org: "CandidateCo" },
    teams: [{ slug: "workspace", display_name: "Workspace", default: true }],
    productionspace: {
      status: "active",
      candidate_modules: ["productionspace/dashboard", "productionspace/Buddy_GEN2"],
    },
  });
  await writeJson(join(companyRoot, "modules.manifest.json"), {
    company: "CandidateCo",
    github_org: "CandidateCo",
    module_slots: [
      { slug: "dashboard-workspace", path: "workspace/dashboard", teams: ["workspace"] },
      { slug: "dashboard", path: "productionspace/Dashboard", space: "productionspace" },
    ],
  });

  const response = await buildLaunchpadAppsResponse({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    runtimeManager: { appsWithRuntime: async (apps) => apps },
  });
  const organization = response.organizations[0];

  expect(organization?.teams[0]?.modules ?? []).toEqual([]);
  expect(organization?.productionspace?.systems.map((system) => system.slug)).toEqual(["dashboard"]);
  expect(organization?.workspace_conformance_issues.join("\n")).toContain(
    'productionspace candidate "productionspace/dashboard" neodpovídá přesnému psaní',
  );
  expect(organization?.workspace_conformance_issues.join("\n")).toContain(
    'productionspace candidate "productionspace/Buddy_GEN2" nemá odpovídající deklarovaný',
  );
});

test("Doctor blokuje konfliktní space, ale productionspace zůstane read-only", async () => {
  const root = await createCompaniesWorkspaceFixture();
  const companyRoot = join(root, "organizations", "OmegaCo_GEN3");
  await mkdir(join(companyRoot, "manual"), { recursive: true });
  await mkdir(join(companyRoot, "company", "colleagues"), { recursive: true });
  await mkdir(join(companyRoot, "productionspace"), { recursive: true });
  await writeJson(join(root, "launchpad.gen3.json"), {
    launchpad_root: {
      slug: "test-companies",
      display_name: "Test Companies",
      root_role: "companies-root",
    },
  });
  await writeJson(join(companyRoot, "company.gen3.json"), {
    organization_generation: "gen3",
    company: { slug: "OmegaCo", display_name: "OmegaCo", github_org: "OmegaCo" },
    workspaces: [
      {
        slug: "workspace",
        display_name: "OmegaCo Workspace",
        default: true,
      },
    ],
    productionspace: { status: "active" },
  });
  await writeJson(join(companyRoot, "modules.manifest.json"), {
    organization_generation: "gen3",
    company: "OmegaCo",
    github_org: "OmegaCo",
    module_slots: [
      {
        path: "productionspace/",
        space: "workspace",
        category: "boundary",
        default_access: "restricted",
        required_roles: ["engineering"],
        git: {
          url: "git@github.com:OmegaCo/productionspace.git",
          branch: "main",
        },
      },
    ],
  });
  await writeJson(join(companyRoot, "TODO.tasks.json"), {});
  await writeJson(join(companyRoot, "DONE.tasks.json"), {});
  await writeJson(join(companyRoot, "ISSUES.open.json"), {});

  const response = await buildLaunchpadAppsResponse({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    runtimeManager: { appsWithRuntime: async (apps) => apps },
  });
  const org = response.organizations.find((item) => item.slug === "OmegaCo");
  expect(org).toBeUndefined();
  expect(response.failures.join("\n")).toContain("modules_manifest_slot_0_path_invalid");

  const report = await buildLaunchpadDoctorReport({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    runtimeManager: { appsWithRuntime: async (apps) => apps },
  });
  const discoveryCheck = report.checks.find((check) => check.id === "launchpad.discovery");
  expect(discoveryCheck?.status).toBe("fail");
  expect(discoveryCheck?.details.join("\n")).toContain("modules_manifest_slot_0_path_invalid");
});

test("public projection hides protected missing_access while Doctor stays fail-closed", async () => {
  const root = await createCompaniesWorkspaceFixture();
  const companyRoot = join(root, "organizations", "AccessCo_GEN3");
  await mkdir(join(companyRoot, "manual"), { recursive: true });
  await mkdir(join(companyRoot, "company", "colleagues"), { recursive: true });
  await writeJson(join(root, "launchpad.gen3.json"), {
    launchpad_root: { slug: "test-companies", display_name: "Test Companies", root_role: "companies-root" },
  });
  await writeJson(join(companyRoot, "company.gen3.json"), {
    organization_generation: "gen3",
    company: { slug: "AccessCo", display_name: "Access Co", github_org: "AccessCo" },
    workspaces: [{ slug: "workspace", display_name: "Workspace", default: true }],
  });
  await writeJson(join(companyRoot, "modules.manifest.json"), {
    organization_generation: "gen3",
    company: "AccessCo",
    github_org: "AccessCo",
    module_slots: [
      {
        path: "workspace/restricted",
        category: "finance",
        default_access: "restricted",
        required_roles: ["finance"],
        git: { url: "git@github.com:AccessCo/restricted.git", branch: "main" },
      },
      {
        path: "workspace/required",
        category: "knowledge",
        default_access: "expected",
        required_roles: ["*"],
        git: { url: "git@github.com:AccessCo/required.git", branch: "main" },
      },
      {
        path: "workspace/future",
        category: "planning",
        default_access: "role_based",
        required_roles: ["builder"],
      },
      {
        path: "workspace/unknown",
        category: "finance",
        default_access: "role_based",
        required_roles: ["finance"],
        git: { url: "git@github.com:AccessCo/unknown.git", branch: "main" },
      },
    ],
  });
  await writeJson(join(companyRoot, "TODO.tasks.json"), {});
  await writeJson(join(companyRoot, "DONE.tasks.json"), {});
  await writeJson(join(companyRoot, "ISSUES.open.json"), {});

  const response = await buildLaunchpadAppsResponse({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    runtimeManager: { appsWithRuntime: async (apps) => apps },
  });
  const slots = response.organizations[0].workspaces[0].modules;
  expect(slots.map((slot) => slot.slug)).toEqual(["required"]);
  expect(slots.find((slot) => slot.slug === "required")?.readiness).toMatchObject({
    severity: "blocking",
    reason: "unexpected_missing_access",
  });
  const publicPayload = JSON.stringify(response);
  expect(publicPayload).not.toContain("workspace/restricted");
  expect(publicPayload).not.toContain("workspace/future");
  expect(publicPayload).not.toContain("workspace/unknown");

  const report = await buildLaunchpadDoctorReport({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    runtimeManager: { appsWithRuntime: async (apps) => apps },
  });
  const declarationCheck = report.checks.find((check) => check.id === "launchpad.workspace_declarations");
  expect(declarationCheck?.status).toBe("fail");
  expect(declarationCheck?.message).toContain("3 blokátory");
  expect(declarationCheck?.details.join("\n")).toContain("workspace/required");
  expect(declarationCheck?.details.join("\n")).toContain("workspace/unknown");
  expect(declarationCheck?.details.join("\n")).toContain("workspace/restricted");
});

test("Hosted Doctor requires missing Workspace modules only in their declared Team", async () => {
  const root = await createCompaniesWorkspaceFixture();
  const companyRoot = join(root, "organizations", "TeamCo_GEN3");
  await mkdir(join(companyRoot, "manual"), { recursive: true });
  await mkdir(join(companyRoot, "company", "colleagues"), { recursive: true });
  await writeJson(join(root, "launchpad.gen3.json"), {
    launchpad_root: { slug: "test-companies", display_name: "Test Companies", root_role: "companies-root" },
  });
  await writeJson(join(companyRoot, "company.gen3.json"), {
    organization_generation: "gen3",
    company: { slug: "TeamCo", display_name: "Team Co", github_org: "TeamCo" },
    teams: [
      { slug: "management", display_name: "Management", default: true },
      { slug: "technical", display_name: "Technical" },
    ],
  });
  await writeJson(join(companyRoot, "modules.manifest.json"), {
    organization_generation: "gen3",
    company: "TeamCo",
    github_org: "TeamCo",
    module_slots: [
      {
        path: "workspace/device-catalog",
        teams: ["technical"],
        default_access: "expected",
        required_roles: ["*"],
        git: { url: "git@github.com:TeamCo/device-catalog.git", branch: "main" },
      },
    ],
  });
  await writeJson(join(companyRoot, "TODO.tasks.json"), {});
  await writeJson(join(companyRoot, "DONE.tasks.json"), {});
  await writeJson(join(companyRoot, "ISSUES.open.json"), {});

  const managementResponse = await buildLaunchpadAppsResponse({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    runtimeManager: { appsWithRuntime: async (apps) => apps },
    activeTeamId: "management",
  });
  expect(managementResponse.organizations[0].module_declarations[0]).toMatchObject({
    status: "missing_access",
    readiness: { severity: "neutral", reason: "team_not_assigned" },
  });
  expect(managementResponse.organizations[0].space_readiness.blocking_slots).toEqual([]);

  const managementDoctor = await buildLaunchpadDoctorReport({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    runtimeManager: { appsWithRuntime: async (apps) => apps },
    activeTeamId: "management",
  });
  expect(
    managementDoctor.checks.find((check) => check.id === "launchpad.workspace_declarations")?.status,
  ).toBe("ok");

  for (const activeTeamId of ["technical", "unknown-team", null]) {
    const report = await buildLaunchpadDoctorReport({
      companiesRoot: root,
      launchpadRoot: join(root, "launchpad"),
      runtimeManager: { appsWithRuntime: async (apps) => apps },
      activeTeamId,
    });
    const declarationCheck = report.checks.find(
      (check) => check.id === "launchpad.workspace_declarations",
    );
    expect(declarationCheck?.status).toBe("fail");
    expect(declarationCheck?.details.join("\n")).toContain("workspace/device-catalog");
  }
});

test("Hosted Doctor keeps a teamless required Workspace module fail-closed", async () => {
  const root = await createCompaniesWorkspaceFixture();
  const companyRoot = join(root, "organizations", "SharedCo_GEN3");
  await mkdir(join(companyRoot, "manual"), { recursive: true });
  await mkdir(join(companyRoot, "company", "colleagues"), { recursive: true });
  await writeJson(join(root, "launchpad.gen3.json"), {
    launchpad_root: { slug: "test-companies", display_name: "Test Companies", root_role: "companies-root" },
  });
  await writeJson(join(companyRoot, "company.gen3.json"), {
    organization_generation: "gen3",
    company: { slug: "SharedCo", display_name: "Shared Co", github_org: "SharedCo" },
    teams: [
      { slug: "management", display_name: "Management", default: true },
      { slug: "technical", display_name: "Technical" },
    ],
  });
  await writeJson(join(companyRoot, "modules.manifest.json"), {
    organization_generation: "gen3",
    company: "SharedCo",
    github_org: "SharedCo",
    module_slots: [
      {
        path: "workspace/shared-required",
        default_access: "expected",
        required_roles: ["*"],
        git: { url: "git@github.com:SharedCo/shared-required.git", branch: "main" },
      },
    ],
  });
  await writeJson(join(companyRoot, "TODO.tasks.json"), {});
  await writeJson(join(companyRoot, "DONE.tasks.json"), {});
  await writeJson(join(companyRoot, "ISSUES.open.json"), {});

  const response = await buildLaunchpadAppsResponse({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    runtimeManager: { appsWithRuntime: async (apps) => apps },
    activeTeamId: "management",
  });
  expect(response.organizations[0].module_declarations[0]).toMatchObject({
    teams: ["workspace"],
    status: "missing_access",
    readiness: { severity: "blocking", reason: "unexpected_missing_access" },
  });

  const report = await buildLaunchpadDoctorReport({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    runtimeManager: { appsWithRuntime: async (apps) => apps },
    activeTeamId: "management",
  });
  const declarationCheck = report.checks.find(
    (check) => check.id === "launchpad.workspace_declarations",
  );
  expect(declarationCheck?.status).toBe("fail");
  expect(declarationCheck?.details.join("\n")).toContain("workspace/shared-required");
});

test("materialized-state projection does not turn local role hints into UI access grants", async () => {
  const root = await createCompaniesWorkspaceFixture();
  const companyRoot = join(root, "organizations", "AccessCo_GEN3");
  await mkdir(join(companyRoot, "manual"), { recursive: true });
  await mkdir(join(companyRoot, "company", "colleagues"), { recursive: true });
  await writeJson(join(root, "launchpad.gen3.json"), {
    launchpad_root: { slug: "test-companies", display_name: "Test Companies", root_role: "companies-root" },
  });
  await writeJson(join(root, "launchpad.gen3.local.json"), {
    personalspace_owner: "exampleuser",
    organization_roles: { AccessCo: ["sales"] },
  });
  await writeJson(join(companyRoot, "company.gen3.json"), {
    organization_generation: "gen3",
    company: { slug: "AccessCo", display_name: "Access Co", github_org: "AccessCo" },
    workspaces: [{ slug: "workspace", display_name: "Workspace", default: true }],
  });
  await writeJson(join(companyRoot, "modules.manifest.json"), {
    organization_generation: "gen3",
    company: "AccessCo",
    github_org: "AccessCo",
    module_slots: [
      {
        path: "workspace/finance",
        category: "finance",
        default_access: "restricted",
        required_roles: ["finance"],
        git: { url: "git@github.com:AccessCo/finance.git", branch: "main" },
      },
      {
        path: "workspace/sales",
        category: "sales",
        default_access: "role_based",
        required_roles: ["sales"],
        git: { url: "git@github.com:AccessCo/sales.git", branch: "main" },
      },
      {
        path: "workspace/everyone",
        category: "knowledge",
        default_access: "role_based",
        required_roles: ["*"],
        git: { url: "git@github.com:AccessCo/everyone.git", branch: "main" },
      },
    ],
  });
  await writeJson(join(companyRoot, "TODO.tasks.json"), {});
  await writeJson(join(companyRoot, "DONE.tasks.json"), {});
  await writeJson(join(companyRoot, "ISSUES.open.json"), {});

  const response = await buildLaunchpadAppsResponse({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    runtimeManager: { appsWithRuntime: async (apps) => apps },
  });
  const slots = response.organizations[0].workspaces[0].modules;
  expect(slots.map((slot) => slot.slug)).toEqual(["everyone"]);
  expect(slots[0]?.readiness.severity).toBe("blocking");
  const declarations = response.organizations[0].module_declarations;
  expect(declarations.find((slot) => slot.slug === "finance")?.readiness).toMatchObject({
    severity: "neutral",
    reason: "role_not_entitled",
  });
  expect(declarations.find((slot) => slot.slug === "sales")?.readiness.severity).toBe("blocking");
  expect(declarations.find((slot) => slot.slug === "everyone")?.readiness.severity).toBe("blocking");
  const publicPayload = JSON.stringify(response);
  expect(publicPayload).not.toContain("workspace/finance");
  expect(publicPayload).not.toContain("workspace/sales");
});

test("Mission Control app/code a data jsou root sloty mimo Team dlaždice", async () => {
  const root = await createCompaniesWorkspaceFixture();
  const companyRoot = join(root, "organizations", "OmegaCo_GEN3");
  await mkdir(join(companyRoot, "manual"), { recursive: true });
  await mkdir(join(companyRoot, "company", "colleagues"), { recursive: true });
  await writeJson(join(root, "launchpad.gen3.json"), {
    launchpad_root: {
      slug: "test-companies",
      display_name: "Test Companies",
      root_role: "companies-root",
    },
  });
  await writeJson(join(companyRoot, "company.gen3.json"), {
    organization_generation: "gen3",
    company: { slug: "OmegaCo", display_name: "OmegaCo", github_org: "OmegaCo" },
    workspaces: [{ slug: "workspace", display_name: "OmegaCo Workspace", default: true }],
    layers: [{ path: "mission-control", kind: "root-docs", ownership: "manual" }],
  });
  await writeJson(join(companyRoot, "modules.manifest.json"), {
    organization_generation: "gen3",
    company: "OmegaCo",
    github_org: "OmegaCo",
    module_slots: [
      // Physical root placement is sufficient; manifest need not repeat space.
      { path: "mission-control", git: { url: "git@github.com:OmegaCo/mission-control.git", branch: "main" } },
      { path: "mission-control/db", space: "root", category: "planning-data", git: { url: "git@github.com:OmegaCo/mission-control-data.git", branch: "v3" } },
      { path: "workspace/wiki", space: "workspace", workspace: "workspace" },
    ],
  });
  await writeJson(join(companyRoot, "TODO.tasks.json"), {});
  await writeJson(join(companyRoot, "DONE.tasks.json"), {});
  await writeJson(join(companyRoot, "ISSUES.open.json"), {});
  const missionControlApp = join(companyRoot, "mission-control", "app", "v3");
  await mkdir(missionControlApp, { recursive: true });
  await writeJson(join(missionControlApp, "package.json"), {
    name: "omegaco-mission-control-v3",
    private: true,
    type: "module",
    scripts: { dev: "bun server.mjs" },
    companyascode: {
      app: {
        schema_version: "companyascode.launchpad_app.v1",
        id: "omegaco-mission-control-v3",
        title: "Mission Control",
        company: "OmegaCo",
        module: "mission-control",
        surface: "internal",
        port: 5293,
        host: "127.0.0.1",
        health_path: "/health",
        dev_script: "dev",
        tags: ["mission-control"],
      },
    },
  });

  const response = await buildLaunchpadAppsResponse({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    runtimeManager: { appsWithRuntime: async (apps) => apps },
  });

  const org = response.organizations.find((item) => item.slug === "OmegaCo");
  const tilePaths = (org?.workspaces ?? []).flatMap((workspace) => workspace.modules.map((module) => module.path));
  expect(org?.organization_modules.map((module) => module.path)).toEqual(["mission-control"]);
  const missionControl = org?.module_declarations.find(
    (slot) => slot.path === "mission-control",
  );
  const missionControlData = org?.module_declarations.find(
    (slot) => slot.path === "mission-control/db",
  );

  expect(tilePaths).toEqual(["workspace/wiki"]);
  expect(tilePaths).not.toContain("mission-control");
  expect(tilePaths).not.toContain("mission-control/db");
  expect(missionControl).toMatchObject({
    space: "root",
    workspace: null,
    status: "available",
  });
  expect(missionControlData).toMatchObject({
    space: "root",
    workspace: null,
    status: "missing_access",
  });
  expect(org?.space_readiness?.blocking_slots.map((slot) => slot.path)).toEqual([
    "mission-control/db",
  ]);
  expect(
    response.apps.find((app) => app.id === "omegaco-mission-control-v3"),
  ).toMatchObject({ space: "root", teams: [], workspace: null });
  expect(org?.team_access).toMatchObject({
    authority: "github",
    status: "not_evaluated",
    memberships: [],
  });
  expect(JSON.stringify(org)).not.toContain("module_declarations");

  const report = await buildLaunchpadDoctorReport({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    runtimeManager: { appsWithRuntime: async (apps) => apps },
  });
  const declarationCheck = report.checks.find((check) => check.id === "launchpad.workspace_declarations");
  expect(declarationCheck?.status).toBe("fail");
  expect(declarationCheck?.details.join("\n")).toContain("mission-control/db");
});

test("AVALTAR-like standalone Mission Control repository-db zůstává jen v diagnostice", async () => {
  const root = await createCompaniesWorkspaceFixture();
  const companyRoot = join(root, "organizations", "AVALTAR-HAM_GEN3");
  await mkdir(join(companyRoot, "manual"), { recursive: true });
  await mkdir(join(companyRoot, "company", "colleagues"), { recursive: true });
  await writeJson(join(root, "launchpad.gen3.json"), {
    launchpad_root: {
      slug: "test-companies",
      display_name: "Test Companies",
      root_role: "companies-root",
    },
  });
  await writeJson(join(companyRoot, "company.gen3.json"), {
    organization_generation: "gen3",
    company: { slug: "AVALTAR-HAM", display_name: "AVALTAR", github_org: "AVALTAR-HAM" },
    workspaces: [{ slug: "workspace", display_name: "Workspace", default: true }],
    layers: [{ path: "mission-control", kind: "root-docs", ownership: "manual" }],
    modules: [{ path: "workspace/knowledgebase", teams: ["workspace"] }],
  });
  await writeJson(join(companyRoot, "modules.manifest.json"), {
    organization_generation: "gen3",
    company: "AVALTAR-HAM",
    github_org: "AVALTAR-HAM",
    module_slots: [
      {
        path: "mission-control/db",
        slug: "mission-control-data",
        category: "planning-data",
        default_access: "expected",
        required_roles: ["*"],
        source_of_truth: "repository-db:v3",
        space: "root",
        status: "planned_slot",
      },
      {
        path: "workspace/knowledgebase",
        space: "workspace",
        teams: ["workspace"],
        source_of_truth: "repository-db:v3",
      },
    ],
  });
  await writeJson(join(companyRoot, "TODO.tasks.json"), {});
  await writeJson(join(companyRoot, "DONE.tasks.json"), {});
  await writeJson(join(companyRoot, "ISSUES.open.json"), {});
  const missionControlApp = join(companyRoot, "mission-control", "app", "v3");
  await mkdir(missionControlApp, { recursive: true });
  await writeJson(join(missionControlApp, "package.json"), {
    name: "avaltar-mission-control-v3",
    private: true,
    type: "module",
    scripts: { dev: "bun server.mjs" },
    companyascode: {
      app: {
        schema_version: "companyascode.launchpad_app.v1",
        id: "avaltar-mission-control-v3",
        title: "Mission Control",
        company: "AVALTAR-HAM",
        module: "mission-control",
        surface: "internal",
        port: 5293,
        host: "127.0.0.1",
        health_path: "/health",
        dev_script: "dev",
        tags: ["mission-control"],
      },
    },
  });

  const response = await buildLaunchpadAppsResponse({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    runtimeManager: { appsWithRuntime: async (apps) => apps },
  });
  const org = response.organizations.find((item) => item.slug === "AVALTAR-HAM");
  const workspaceModules = (org?.workspaces ?? []).flatMap((workspace) => workspace.modules);
  const dataDeclaration = org?.module_declarations.find(
    (slot) => slot.path === "mission-control/db",
  );

  expect(workspaceModules.map((module) => module.path)).toEqual(["workspace/knowledgebase"]);
  expect(workspaceModules).toHaveLength(1);
  expect(dataDeclaration).toMatchObject({
    path: "mission-control/db",
    ui_exposure: "diagnostics-only",
    status: "planned_slot",
  });
  expect(response.apps.map((app) => app.id)).toContain("avaltar-mission-control-v3");

  const gitInventory = await buildGitInventory({ companiesRoot: root });
  expect(gitInventory.planned).toContainEqual(
    expect.objectContaining({
      organization: "AVALTAR-HAM",
      slot_path: "mission-control/db",
    }),
  );

  const report = await buildLaunchpadDoctorReport({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    runtimeManager: { appsWithRuntime: async (apps) => apps },
  });
  const declarationCheck = report.checks.find(
    (check) => check.id === "launchpad.workspace_declarations",
  );
  expect(declarationCheck?.details.join("\n")).toContain("mission-control/db");
});

test("root Design System zůstává mimo výchozí Team a Doctor hlídá jeho checkout", async () => {
  const root = await createCompaniesWorkspaceFixture();
  const companyRoot = join(root, "organizations", "OmegaCo_GEN3");
  await mkdir(join(companyRoot, "manual"), { recursive: true });
  await mkdir(join(companyRoot, "company", "colleagues"), { recursive: true });
  await writeJson(join(root, "launchpad.gen3.json"), {
    launchpad_root: {
      slug: "test-companies",
      display_name: "Test Companies",
      root_role: "companies-root",
    },
  });
  await writeJson(join(companyRoot, "company.gen3.json"), {
    organization_generation: "gen3",
    company: { slug: "OmegaCo", display_name: "OmegaCo", github_org: "OmegaCo" },
    workspaces: [{ slug: "workspace", display_name: "OmegaCo Workspace", default: true }],
    layers: [{ path: "design-system", kind: "design-system", ownership: "manual" }],
  });
  await writeJson(join(companyRoot, "modules.manifest.json"), {
    organization_generation: "gen3",
    company: "OmegaCo",
    github_org: "OmegaCo",
    module_slots: [
      {
        path: "design-system",
        space: "root",
        category: "brand",
        default_access: "expected",
        required_roles: ["*"],
        git: {
          url: "git@github.com:OmegaCo/design-system.git",
          branch: "main",
        },
      },
      { path: "workspace/wiki", space: "workspace", workspace: "workspace" },
    ],
  });
  await writeJson(join(companyRoot, "TODO.tasks.json"), {});
  await writeJson(join(companyRoot, "DONE.tasks.json"), {});
  await writeJson(join(companyRoot, "ISSUES.open.json"), {});

  const response = await buildLaunchpadAppsResponse({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    runtimeManager: { appsWithRuntime: async (apps) => apps },
  });

  const org = response.organizations.find((item) => item.slug === "OmegaCo");
  const workspacePaths = (org?.workspaces ?? []).flatMap((workspace) =>
    workspace.modules.map((module) => module.path),
  );
  const designSystem = org?.module_declarations.find(
    (slot) => slot.path === "design-system",
  );

  expect(workspacePaths).toEqual(["workspace/wiki"]);
  expect(designSystem).toMatchObject({
    path: "design-system",
    space: "root",
    workspace: null,
    status: "missing_access",
    readiness: {
      severity: "blocking",
      reason: "unexpected_missing_access",
    },
  });
  expect(org?.space_readiness?.blocking_slots).toContainEqual(
    expect.objectContaining({ path: "design-system" }),
  );

  const report = await buildLaunchpadDoctorReport({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    runtimeManager: { appsWithRuntime: async (apps) => apps },
  });
  const declarationCheck = report.checks.find(
    (check) => check.id === "launchpad.workspace_declarations",
  );
  expect(declarationCheck?.status).toBe("fail");
  const details = declarationCheck?.details.join("\n") ?? "";
  expect(details).toContain("design-system");
});

test("Doctor vynucuje root slot contract a Mission Control app/data pár", async () => {
  const root = await createCompaniesWorkspaceFixture();
  const companyRoot = join(root, "organizations", "OmegaCo_GEN3");
  await mkdir(join(companyRoot, "manual"), { recursive: true });
  await mkdir(join(companyRoot, "company", "colleagues"), { recursive: true });
  await writeJson(join(root, "launchpad.gen3.json"), {
    launchpad_root: {
      slug: "test-companies",
      display_name: "Test Companies",
      root_role: "companies-root",
    },
  });
  await writeJson(join(companyRoot, "company.gen3.json"), {
    organization_generation: "gen3",
    company: { slug: "OmegaCo", display_name: "OmegaCo", github_org: "OmegaCo" },
    workspaces: [{ slug: "workspace", display_name: "OmegaCo Workspace", default: true }],
    layers: [
      { path: "design-system", kind: "design-system", ownership: "manual" },
      { path: "infra", kind: "infra", ownership: "manual" },
      { path: "mission-control/", kind: "root-docs", ownership: "manual" },
    ],
    modules: [
      {
        slug: "infra",
        path: "infra",
        repo: "git@github.com:OmegaCo/infra.git",
        category: "engineering",
        source_of_truth: "git-native",
        access: { default: "expected", roles: ["*"] },
      },
    ],
  });
  const manifestPath = join(companyRoot, "modules.manifest.json");
  await writeJson(manifestPath, {
    organization_generation: "gen3",
    company: "OmegaCo",
    github_org: "OmegaCo",
    module_slots: [
      // Nevalidní legacy deklarace: Doctor ji bezpečně zobrazí v rootu, ale
      // blokuje ji kvůli chybějícímu explicitnímu scope a checkout údajům.
      { path: "design-system", space: "workspace", workspace: "brand" },
      {
        path: "mission-control",
        space: "root",
        repo: "git@github.com:WrongOrg/wrong-mission-control.git",
        branch: "legacy",
        git: {
          url: "git@github.com:OmegaCo/mission-control.git",
          branch: "main",
        },
      },
      { path: "workspace/wiki", space: "workspace", workspace: "workspace" },
    ],
  });
  await writeJson(join(companyRoot, "TODO.tasks.json"), {});
  await writeJson(join(companyRoot, "DONE.tasks.json"), {});
  await writeJson(join(companyRoot, "ISSUES.open.json"), {});

  const response = await buildLaunchpadAppsResponse({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    runtimeManager: { appsWithRuntime: async (apps) => apps },
  });
  const org = response.organizations.find((item) => item.slug === "OmegaCo");
  const workspacePaths = (org?.workspaces ?? []).flatMap((workspace) =>
    workspace.modules.map((module) => module.path),
  );
  const designSystem = org?.module_declarations.find(
    (slot) => slot.path === "design-system",
  );

  expect(workspacePaths).toEqual(["workspace/wiki"]);
  expect(designSystem).toMatchObject({
    space: "root",
    workspace: null,
  });

  const report = await buildLaunchpadDoctorReport({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    runtimeManager: { appsWithRuntime: async (apps) => apps },
  });
  const declarationCheck = report.checks.find(
    (check) => check.id === "launchpad.workspace_declarations",
  );
  const details = declarationCheck?.details.join("\n") ?? "";
  expect(declarationCheck?.status).toBe("fail");
  expect(details).toContain('design-system musí explicitně deklarovat space: "root"');
  expect(details).toContain(
    "design-system nesmí deklarovat Team/Workspace membership (workspace)",
  );
  expect(details).toContain("design-system musí deklarovat git.url a git.branch");
  expect(details).toContain(
    "mission-control nesmí deklarovat legacy checkout souřadnice (repo, branch)",
  );
  expect(details).toContain(
    'root layer path "mission-control/" není kanonický; použij "mission-control"',
  );
  expect(details).toContain("chybí mission-control/db");
  expect(details).toContain(
    "company.gen3.json: root vrstva infra nemá odpovídající modules.manifest.json slot",
  );

  const manifest = await Bun.file(manifestPath).json();
  manifest.module_slots.splice(2, 0, {
    path: "mission-control/db",
    space: "root",
    teams: ["workspace"],
    git: {
      url: "git@github.com:OmegaCo/mission-control-data.git",
      branch: "main",
    },
  });
  await Bun.write(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const reportWithData = await buildLaunchpadDoctorReport({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    runtimeManager: { appsWithRuntime: async (apps) => apps },
  });
  const dataDeclarationCheck = reportWithData.checks.find(
    (check) => check.id === "launchpad.workspace_declarations",
  );
  const dataDetails = dataDeclarationCheck?.details.join("\n") ?? "";
  expect(dataDeclarationCheck?.status).toBe("fail");
  expect(dataDetails).toContain(
    "mission-control/db nesmí deklarovat Team/Workspace membership (teams)",
  );
  expect(dataDetails).toContain(
    'mission-control/db musí používat větev "v3", deklarována je "main"',
  );
  expect(dataDetails).not.toContain("chybí mission-control/db");

  const companyConfig = await Bun.file(join(companyRoot, "company.gen3.json")).json();
  companyConfig.layers = companyConfig.layers.filter(
    (layer) => layer.path !== "design-system",
  );
  await writeJson(join(companyRoot, "company.gen3.json"), companyConfig);
  const reportWithoutDesignLayer = await buildLaunchpadDoctorReport({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    runtimeManager: { appsWithRuntime: async (apps) => apps },
  });
  const missingLayerCheck = reportWithoutDesignLayer.checks.find(
    (check) => check.id === "launchpad.workspace_declarations",
  );
  expect(missingLayerCheck?.details.join("\n")).toContain(
    "modules.manifest.json: root slot design-system nemá odpovídající vrstvu v legacy compatibility projection company.gen3.json",
  );
});

test("planned root slot rozliší in-tree compatibility adresář od nested checkoutu", async () => {
  const root = await createCompaniesWorkspaceFixture();
  const companyRoot = join(root, "organizations", "OmegaCo_GEN3");
  await mkdir(join(companyRoot, "manual"), { recursive: true });
  await mkdir(join(companyRoot, "company", "colleagues"), { recursive: true });
  await writeJson(join(root, "launchpad.gen3.json"), {
    launchpad_root: {
      slug: "test-companies",
      display_name: "Test Companies",
      root_role: "companies-root",
    },
  });
  await writeJson(join(companyRoot, "company.gen3.json"), {
    organization_generation: "gen3",
    company: { slug: "OmegaCo", display_name: "OmegaCo", github_org: "OmegaCo" },
    workspaces: [{ slug: "workspace", display_name: "OmegaCo Workspace", default: true }],
    layers: [{ path: "design-system", kind: "design-system", ownership: "manual" }],
  });
  const manifestPath = join(companyRoot, "modules.manifest.json");
  const manifest = {
    organization_generation: "gen3",
    company: "OmegaCo",
    github_org: "OmegaCo",
    module_slots: [
      {
        path: "design-system",
        space: "root",
        status: "planned_slot",
      },
    ],
  };
  await writeJson(manifestPath, manifest);
  await writeJson(join(companyRoot, "TODO.tasks.json"), {});
  await writeJson(join(companyRoot, "DONE.tasks.json"), {});
  await writeJson(join(companyRoot, "ISSUES.open.json"), {});

  const doctor = async () => {
    const report = await buildLaunchpadDoctorReport({
      companiesRoot: root,
      launchpadRoot: join(root, "launchpad"),
      runtimeManager: { appsWithRuntime: async (apps) => apps },
    });
    return report.checks.find(
      (check) => check.id === "launchpad.workspace_declarations",
    );
  };

  const plannedCheck = await doctor();
  expect(plannedCheck?.status).toBe("ok");

  manifest.module_slots[0].git = {
    url: "git@github.com:OmegaCo/design-system.git",
    branch: "main",
  };
  await writeJson(manifestPath, manifest);
  const partialCoordinatesCheck = await doctor();
  expect(partialCoordinatesCheck?.status).toBe("fail");
  expect(partialCoordinatesCheck?.details.join("\n")).toContain(
    "planned root slot design-system nesmí deklarovat git",
  );

  delete manifest.module_slots[0].git;
  await writeJson(manifestPath, manifest);
  await mkdir(join(companyRoot, "design-system"), { recursive: true });
  const inTreeCompatibilityCheck = await doctor();
  expect(inTreeCompatibilityCheck?.status).toBe("ok");

  await mkdir(join(companyRoot, "design-system", ".git"), { recursive: true });
  const materializedWithoutCoordinatesCheck = await doctor();
  expect(materializedWithoutCoordinatesCheck?.status).toBe("fail");
  expect(materializedWithoutCoordinatesCheck?.details.join("\n")).toContain(
    'materializovaný root slot design-system nesmí zůstat status: "planned_slot"',
  );

  manifest.module_slots[0].git = {
    url: "git@github.com:OmegaCo/design-system.git",
    branch: "main",
  };
  await writeJson(manifestPath, manifest);
  const materializedWithCoordinatesCheck = await doctor();
  expect(materializedWithCoordinatesCheck?.status).toBe("fail");
  expect(materializedWithCoordinatesCheck?.details.join("\n")).toContain(
    'materializovaný root slot design-system nesmí zůstat status: "planned_slot"',
  );
  expect(materializedWithCoordinatesCheck?.details.join("\n")).not.toContain(
    "planned root slot design-system nesmí deklarovat git",
  );

  manifest.module_slots[0].status = "inactive";
  await writeJson(manifestPath, manifest);
  const stagedCheckoutCheck = await doctor();
  expect(stagedCheckoutCheck?.status).toBe("ok");
});

test("trackovaná Organization root vrstva není samostatný repository slot", async () => {
  const root = await createCompaniesWorkspaceFixture();
  const companyRoot = join(root, "organizations", "OmegaCo_GEN3");
  await mkdir(join(companyRoot, "manual"), { recursive: true });
  await mkdir(join(companyRoot, "company", "colleagues"), { recursive: true });
  await mkdir(join(companyRoot, "design-system"), { recursive: true });
  await writeFile(join(companyRoot, "design-system", "README.md"), "# In-tree Design System\n");
  await writeJson(join(companyRoot, "company.gen3.json"), {
    organization_generation: "gen3",
    company: { slug: "OmegaCo", display_name: "OmegaCo", github_org: "OmegaCo" },
    layers: [{ path: "design-system", kind: "design-system", ownership: "override" }],
  });
  await writeJson(join(companyRoot, "modules.manifest.json"), {
    organization_generation: "gen3",
    company: "OmegaCo",
    github_org: "OmegaCo",
    module_slots: [],
  });
  await writeJson(join(companyRoot, "TODO.tasks.json"), {});
  await writeJson(join(companyRoot, "DONE.tasks.json"), {});
  await writeJson(join(companyRoot, "ISSUES.open.json"), {});
  run(["git", "init"], companyRoot);
  run(["git", "add", "."], companyRoot);
  run([
    "git",
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.com",
    "commit",
    "-m",
    "Organization root",
  ], companyRoot);

  const report = await buildLaunchpadDoctorReport({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    runtimeManager: { appsWithRuntime: async (apps) => apps },
  });
  const declarationCheck = report.checks.find(
    (check) => check.id === "launchpad.workspace_declarations",
  );
  expect(declarationCheck?.details.join("\n") ?? "").not.toContain(
    "root vrstva design-system nemá odpovídající modules.manifest.json slot",
  );

  await mkdir(join(companyRoot, "design-system", ".git"), { recursive: true });
  const nestedCheckoutReport = await buildLaunchpadDoctorReport({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    runtimeManager: { appsWithRuntime: async (apps) => apps },
  });
  const nestedCheckoutCheck = nestedCheckoutReport.checks.find(
    (check) => check.id === "launchpad.workspace_declarations",
  );
  expect(nestedCheckoutCheck?.details.join("\n") ?? "").toContain(
    "root vrstva design-system nemá odpovídající modules.manifest.json slot",
  );
});

test("Gitlink Organization root vrstvy vyžaduje samostatný repository slot", async () => {
  const root = await createCompaniesWorkspaceFixture();
  const companyRoot = join(root, "organizations", "OmegaCo_GEN3");
  const designSystemRoot = join(companyRoot, "design-system");
  await mkdir(join(companyRoot, "manual"), { recursive: true });
  await mkdir(join(companyRoot, "company", "colleagues"), { recursive: true });
  await mkdir(designSystemRoot, { recursive: true });
  await writeFile(join(designSystemRoot, "README.md"), "# Nested Design System\n");
  await writeJson(join(companyRoot, "company.gen3.json"), {
    organization_generation: "gen3",
    company: { slug: "OmegaCo", display_name: "OmegaCo", github_org: "OmegaCo" },
    layers: [{ path: "design-system", kind: "design-system", ownership: "override" }],
  });
  await writeJson(join(companyRoot, "modules.manifest.json"), {
    organization_generation: "gen3",
    company: "OmegaCo",
    github_org: "OmegaCo",
    module_slots: [],
  });
  await writeJson(join(companyRoot, "TODO.tasks.json"), {});
  await writeJson(join(companyRoot, "DONE.tasks.json"), {});
  await writeJson(join(companyRoot, "ISSUES.open.json"), {});
  run(["git", "init"], designSystemRoot);
  run(["git", "add", "."], designSystemRoot);
  run([
    "git",
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.com",
    "commit",
    "-m",
    "Nested Design System",
  ], designSystemRoot);
  run(["git", "init"], companyRoot);
  run(["git", "add", "."], companyRoot);
  run([
    "git",
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.com",
    "commit",
    "-m",
    "Organization root",
  ], companyRoot);

  const report = await buildLaunchpadDoctorReport({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    runtimeManager: { appsWithRuntime: async (apps) => apps },
  });
  const declarationCheck = report.checks.find(
    (check) => check.id === "launchpad.workspace_declarations",
  );
  expect(declarationCheck?.details.join("\n") ?? "").toContain(
    "root vrstva design-system nemá odpovídající modules.manifest.json slot",
  );
});

test("app sekci určí fyzická cesta, manifest doplní N:M Team intent a sdílený modul může být jednou v Organizaci", async () => {
  const root = await createCompaniesWorkspaceFixture();
  const companyRoot = join(root, "organizations", "AlfaCo_GEN3");
  await mkdir(join(companyRoot, "manual"), { recursive: true });
  await mkdir(join(companyRoot, "company", "colleagues"), { recursive: true });
  await writeJson(join(root, "launchpad.gen3.json"), {
    launchpad_root: {
      slug: "test-companies",
      display_name: "Test Companies",
      root_role: "companies-root",
    },
  });
  await writeJson(join(companyRoot, "company.gen3.json"), {
    organization_generation: "gen3",
    company: { slug: "AlfaCo", display_name: "AlfaCo", github_org: "AlfaCo" },
    workspaces: [
      { slug: "workspace", display_name: "AlfaCo Workspace", default: true },
      { slug: "sidebrand", display_name: "SideBrand" },
    ],
  });
  await writeJson(join(companyRoot, "modules.manifest.json"), {
    organization_generation: "gen3",
    company: "AlfaCo",
    github_org: "AlfaCo",
    module_slots: [
      {
        path: "workspace/sidebrand-shop",
        teams: ["sidebrand", "workspace"],
        git: { url: "git@github.com:AlfaCo/sidebrand-shop.git", branch: "main" },
      },
      {
        path: "workspace/wiki",
        git: { url: "git@github.com:AlfaCo/wiki.git", branch: "main" },
      },
      {
        path: "workspace/knowledgebase",
        name: "AlfaCo Knowledgebase",
        teams: ["workspace", "sidebrand"],
        launchpad_section: "organization",
        git: { url: "git@github.com:AlfaCo/knowledgebase.git", branch: "main" },
      },
    ],
  });
  await writeJson(join(companyRoot, "TODO.tasks.json"), {});
  await writeJson(join(companyRoot, "DONE.tasks.json"), {});
  await writeJson(join(companyRoot, "ISSUES.open.json"), {});
  const shopApp = join(companyRoot, "workspace", "sidebrand-shop", "app", "v1");
  const wikiApp = join(companyRoot, "workspace", "wiki", "app", "v1");
  const knowledgebaseApp = join(companyRoot, "workspace", "knowledgebase", "app", "v1");
  for (const [dir, id, port] of [
    [shopApp, "sidebrand-shop-v1", 5511],
    [wikiApp, "alfaco-wiki-v1", 5512],
    [knowledgebaseApp, "alfaco-knowledgebase-v1", 5513],
  ]) {
    await mkdir(dir, { recursive: true });
    await writeJson(join(dir, "package.json"), {
      name: id,
      private: true,
      type: "module",
      scripts: { dev: "bun server.mjs" },
      companyascode: {
        app: {
          schema_version: "companyascode.launchpad_app.v1",
          id,
          title: id,
          company: "AlfaCo",
          surface: "internal",
          port,
          host: "127.0.0.1",
          health_path: "/",
          dev_script: "dev",
          tags: ["test"],
        },
      },
    });
  }

  const response = await buildLaunchpadAppsResponse({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    runtimeManager: { appsWithRuntime: async (apps) => apps },
  });

  const placementByAppId = new Map(response.apps.map((app) => [app.id, app]));
  expect(placementByAppId.get("sidebrand-shop-v1")).toMatchObject({
    space: "workspace",
    teams: ["sidebrand", "workspace"],
    workspace: "sidebrand",
  });
  // Chybějící Team deklarace = default Team se slugem "workspace"; fyzická
  // sekce zůstává Workspace v obou případech.
  expect(placementByAppId.get("alfaco-wiki-v1")).toMatchObject({
    space: "workspace",
    teams: ["workspace"],
    workspace: "workspace",
  });
  expect(placementByAppId.get("alfaco-knowledgebase-v1")).toMatchObject({
    space: "root",
    teams: [],
    workspace: null,
  });
  const teams = new Map(response.organizations[0].teams.map((team) => [team.slug, team]));
  expect(teams.get("sidebrand")?.modules.map((module) => module.slug)).toContain("sidebrand-shop");
  expect(teams.get("workspace")?.modules.map((module) => module.slug)).toContain("sidebrand-shop");
  expect(teams.get("sidebrand")?.modules.map((module) => module.slug)).not.toContain("knowledgebase");
  expect(teams.get("workspace")?.modules.map((module) => module.slug)).not.toContain("knowledgebase");
  expect(response.organizations[0].organization_modules).toContainEqual(
    expect.objectContaining({
      slug: "knowledgebase",
      name: "AlfaCo Knowledgebase",
      path: "workspace/knowledgebase",
      space: "workspace",
      launchpad_section: "organization",
    }),
  );
  const hostedResponse = await buildLaunchpadAppsResponse({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    runtimeManager: { appsWithRuntime: async (apps) => apps },
    activeTeamId: "sidebrand",
  });
  expect(hostedResponse.organizations[0].teams.map((team) => team.slug)).toEqual(["sidebrand"]);
  expect(hostedResponse.organizations[0].workspaces.map((team) => team.slug)).toEqual(["sidebrand"]);
  expect(hostedResponse.apps.find((app) => app.id === "sidebrand-shop-v1")).toMatchObject({
    teams: ["sidebrand"],
    workspace: "sidebrand",
  });
  expect(hostedResponse.apps.map((app) => app.id)).not.toContain("alfaco-wiki-v1");
  expect(hostedResponse.apps.map((app) => app.id)).toContain("alfaco-knowledgebase-v1");
  const report = await buildLaunchpadDoctorReport({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    runtimeManager: { appsWithRuntime: async (apps) => apps },
  });
  const declarationCheck = report.checks.find((check) => check.id === "launchpad.workspace_declarations");
  expect(declarationCheck?.status).toBe("ok");
});

test("invalid_manifest appka je viditelná v apps response a doctor ji hlásí jako warn (decision 0043)", async () => {
  const root = await createCompaniesWorkspaceFixture();
  const companyRoot = join(root, "organizations", "BrokenCo");
  await mkdir(join(companyRoot, "manual"), { recursive: true });
  await mkdir(join(companyRoot, "company", "colleagues"), { recursive: true });
  await writeJson(join(root, "launchpad.gen3.json"), {
    launchpad_root: {
      slug: "test-companies",
      display_name: "Test Companies",
      root_role: "companies-root",
    },
  });
  await writeJson(join(companyRoot, "company.gen3.json"), {
    organization_generation: "gen3",
    company: { slug: "BrokenCo", display_name: "Broken Co", github_org: "BrokenCo" },
  });
  await writeJson(join(companyRoot, "modules.manifest.json"), {
    company: "BrokenCo",
    github_org: "BrokenCo",
    module_slots: [],
  });
  await writeJson(join(companyRoot, "TODO.tasks.json"), {});
  await writeJson(join(companyRoot, "DONE.tasks.json"), {});
  await writeJson(join(companyRoot, "ISSUES.open.json"), {});
  const goodApp = join(companyRoot, "modules", "good", "app", "v1");
  const brokenApp = join(companyRoot, "modules", "broken", "app", "v1");
  await mkdir(goodApp, { recursive: true });
  await mkdir(brokenApp, { recursive: true });
  await writeJson(join(goodApp, "package.json"), {
    name: "good-app",
    private: true,
    type: "module",
    scripts: { dev: "bun server.mjs" },
    companyascode: {
      app: {
        schema_version: "companyascode.launchpad_app.v1",
        id: "brokenco-good-v1",
        title: "Good v1",
        company: "BrokenCo",
        surface: "internal",
        port: 5601,
        host: "127.0.0.1",
        health_path: "/",
        dev_script: "dev",
        tags: ["test"],
      },
    },
  });
  await writeJson(join(brokenApp, "package.json"), {
    name: "broken-app",
    private: true,
    type: "module",
    scripts: {},
    companyascode: {
      app: {
        schema_version: "companyascode.launchpad_app.v1",
        id: "brokenco-broken-v1",
        title: "Broken v1",
        company: "BrokenCo",
        surface: "internal",
        port: 99, // mimo povolený rozsah
        host: "127.0.0.1",
        health_path: "bez-lomitka",
        dev_script: "dev",
        tags: ["test"],
      },
    },
  });

  const response = await buildLaunchpadAppsResponse({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    runtimeManager: { appsWithRuntime: async (apps) => apps },
  });

  expect(response.ok).toBe(true);
  expect(response.summary.failure_count).toBe(0);
  expect(response.summary.app_count).toBe(1);
  expect(response.summary.invalid_app_count).toBe(1);
  const broken = response.apps.find((app) => app.id === "brokenco-broken-v1");
  expect(broken).toMatchObject({
    manifest_state: "invalid_manifest",
    dependency_status: "invalid_manifest",
    runtime_status: "stopped",
  });
  expect(broken.dependencies.can_start).toBe(false);

  const report = await buildLaunchpadDoctorReport({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    runtimeManager: { appsWithRuntime: async (apps) => apps },
  });
  // Nevalidní manifest smí discovery check jen degradovat na warn, ne fail…
  const discoveryCheck = report.checks.find((check) => check.id === "launchpad.discovery");
  expect(discoveryCheck?.status).toBe("warn");
  // …a runtime diagnostika běží dál pro všechny appky včetně té nevalidní.
  const appCheck = report.checks.find((check) => check.id === "launchpad.runtime.brokenco-broken-v1");
  expect(appCheck?.status).toBe("warn");
  const goodCheck = report.checks.find((check) => check.id === "launchpad.runtime.brokenco-good-v1");
  expect(goodCheck).toBeDefined();
});

test("CAC-0042: Doctor reportuje worktree problémy bez cleanup rozhodování", async () => {
  const root = await createLaunchpadGitFixture();
  tempRoots.push(root);
  const orgRoot = join(root, "organizations", "BetaCo_GEN3");
  await mkdir(join(orgRoot, ".claude", "worktrees", "legacy-agent"), { recursive: true });
  await mkdir(join(orgRoot, ".codex-tmp"), { recursive: true });

  const activePath = join(orgRoot, ".worktrees", "workspace", "deals", "CAC-0042-doctor-active");
  const stalePath = join(orgRoot, ".worktrees", "workspace", "deals", "CAC-0042-doctor-stale");
  const orphanPath = join(orgRoot, ".worktrees", "workspace", "deals", "CAC-0042-doctor-orphan");
  const missingPlanPath = join(orgRoot, ".worktrees", "workspace", "deals", "CAC-0042-doctor-missing-plan");
  await initGitRepo(activePath, { branch: "CAC-0042-doctor-active" });
  await initGitRepo(stalePath, { branch: "CAC-0042-doctor-stale" });
  await initGitRepo(orphanPath, { branch: "CAC-0042-doctor-orphan" });
  await initGitRepo(missingPlanPath, { branch: "CAC-0042-doctor-missing-plan" });
  await writeFile(
    join(orgRoot, "mission-control", "plans", "2026", "07", "CAC-0042-doctor-active.yaml"),
    "dev_code: CAC-0042\ntitle: Doctor active worktree\nstatus: in_progress\n",
  );
  await writeFile(
    join(orgRoot, "mission-control", "plans", "2026", "07", "CAC-0042-doctor-stale.yaml"),
    "dev_code: CAC-0042\ntitle: Doctor stale worktree\nstatus: in_progress\n",
  );
  await writeJson(join(orgRoot, ".worktrees", "workspace", "deals", "CAC-0042-doctor-active.worktree.json"), {
    schema_version: "companiesascode.worktree.v1",
    branch: "CAC-0042-doctor-active",
    mission_control_plan_code: "CAC-0042",
    mission_control_plan_path: "mission-control/plans/2026/07/CAC-0042-doctor-active.yaml",
    worktree_path: ".worktrees/workspace/deals/CAC-0042-doctor-active",
    created_at: new Date().toISOString(),
    created_by: "examplebuddy-buddy",
    status: "pr_open",
  });
  await mkdir(join(activePath, "app", "v1"), { recursive: true });
  await writeJson(join(activePath, "app", "v1", "package.json"), {
    private: true,
    packageManager: "bun@1.3.14",
    dependencies: { demo: "1.0.0" },
  });
  await writeFile(join(activePath, "app", "v1", "bun.lock"), "", "utf8");
  await mkdir(join(activePath, "app", "v1", "node_modules", "other"), { recursive: true });
  await writeJson(join(activePath, "app", "v1", "node_modules", "other", "package.json"), {
    name: "other",
    version: "1.0.0",
  });
  const foreignAuthorityRoot = join(root, "foreign-worktree-authority");
  await mkdir(foreignAuthorityRoot, { recursive: true });
  await writeJson(join(foreignAuthorityRoot, "package.json"), {
    private: true,
    dependencies: { leaked: "1.0.0" },
  });
  await writeFile(join(foreignAuthorityRoot, "package-lock.json"), "{}\n", "utf8");
  await mkdir(join(foreignAuthorityRoot, "secret-customer-project"));
  await symlink(
    foreignAuthorityRoot,
    join(stalePath, "app"),
    process.platform === "win32" ? "junction" : "dir",
  );
  run(["git", "add", "app"], stalePath);
  run(["git", "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "add escaped app fixture"], stalePath);
  if (fileSymlinkCapability) {
    await mkdir(join(activePath, "app", "v2"), { recursive: true });
    await symlink(
      join(foreignAuthorityRoot, "package.json"),
      join(activePath, "app", "v2", "package.json"),
      "file",
    );
    await mkdir(join(activePath, "app", "v3"), { recursive: true });
    await writeJson(join(activePath, "app", "v3", "package.json"), {
      private: true,
      packageManager: "bun@1.3.14",
    });
    await symlink(
      join(foreignAuthorityRoot, "package-lock.json"),
      join(activePath, "app", "v3", "package-lock.json"),
      "file",
    );
  }
  await mkdir(join(activePath, "app", "v4"), { recursive: true });
  await writeJson(join(activePath, "app", "v4", "package.json"), {
    private: true,
    packageManager: "bun@1.3.14",
  });
  await writeFile(join(activePath, "app", "v4", "package-lock.json"), "{}\n", "utf8");
  await mkdir(join(activePath, "app", "v5"), { recursive: true });
  await writeJson(join(activePath, "app", "v5", "package.json"), {
    private: true,
  });
  await writeJson(join(orgRoot, ".worktrees", "workspace", "deals", "CAC-0042-doctor-stale.worktree.json"), {
    schema_version: "companiesascode.worktree.v1",
    branch: "CAC-0042-doctor-stale",
    mission_control_plan_code: "CAC-0042",
    mission_control_plan_path: "mission-control/plans/2026/07/CAC-0042-doctor-stale.yaml",
    worktree_path: ".worktrees/workspace/deals/CAC-0042-doctor-stale",
    created_at: "2000-01-01T00:00:00.000Z",
    created_by: "examplebuddy-buddy",
    status: "active",
  });
  await writeJson(join(orgRoot, ".worktrees", "workspace", "deals", "CAC-0042-doctor-missing-plan.worktree.json"), {
    schema_version: "companiesascode.worktree.v1",
    branch: "CAC-0042-doctor-missing-plan",
    mission_control_plan_code: "CAC-0042",
    mission_control_plan_path: "mission-control/plans/2026/07/CAC-0042-doctor-missing-plan.yaml",
    worktree_path: ".worktrees/workspace/deals/CAC-0042-doctor-missing-plan",
    created_at: new Date().toISOString(),
    created_by: "examplebuddy-buddy",
    status: "active",
  });

  const report = await buildLaunchpadDoctorReport({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    runtimeManager: { appsWithRuntime: async (apps) => apps },
  });
  const checks = new Map(report.checks.map((check) => [check.id, check]));

  expect(checks.get("git.worktrees.inventory")?.status).toBe("ok");
  expect(checks.get("git.worktrees.inventory")?.message).toContain("4 worktrees");
  expect(checks.get("git.worktrees.inventory")?.details).toEqual(expect.arrayContaining([
    "owned: 2",
    "orphan_missing_plan: 1",
    "orphan_missing_file: 1",
    "stale: 0",
  ]));
  expect(checks.get("git.worktrees.contract")?.status).toBe("warn");
  expect(checks.get("git.worktrees.contract")?.details.join("\n")).toContain(".claude/worktrees");
  expect(checks.get("git.worktrees.contract")?.details.join("\n")).toContain(
    "invalid_location: organizations/BetaCo_GEN3/.codex-tmp — Prázdná nepovolená legacy worktree složka. Doctor ji nezměnil.",
  );
  expect(checks.get("git.worktrees.contract")?.details.join("\n")).toContain(
    "invalid_location_state: organizations/BetaCo_GEN3/.codex-tmp — agent_action: prázdnou přesnou cestu lze odstranit pomocí rmdir",
  );
  expect(checks.get("git.worktrees.contract")?.details.join("\n")).toContain(
    "invalid_location_state: organizations/BetaCo_GEN3/.claude/worktrees — agent_action:",
  );
  expect(checks.get("git.worktrees.contract")?.details.join("\n")).toContain("CAC-0042-doctor-orphan");
  expect(checks.get("git.worktrees.contract")?.details.join("\n")).toContain("CAC-0042-doctor-missing-plan");
  expect(checks.get("git.worktrees.contract")?.details.join("\n")).not.toContain("cleanup_candidate:");
  expect(checks.get("git.worktrees.contract")?.message).toBe(
    "Worktree kontrakt: 2 neplatná umístění, 2 problémy vlastnictví a 6 metadatových upozornění nad 4 worktrees.",
  );
  expect(checks.get("git.worktrees.contract")?.details.join("\n")).toContain("Sidecar nemá conversation_origin");
  expect(checks.get("git.worktrees.contract")?.details.join("\n")).not.toContain("[object Object]");
  expect(checks.get("launchpad.discovery")?.details.join("\n")).not.toContain("Sidecar nemá conversation_origin");
  expect(checks.has("git.worktrees.cleanup")).toBe(false);
  expect(checks.get("git.worktrees.dependencies")?.status).toBe("warn");
  expect(checks.get("git.worktrees.dependencies")?.details).toEqual(expect.arrayContaining([
    "checked_worktrees: 2",
    "skipped_declared_inactive_worktrees: 0",
    `checked_packages: ${fileSymlinkCapability ? 6 : 4}`,
    "ready: 1",
    "needs_install: 1",
    `dependency_boundary_invalid: ${fileSymlinkCapability ? 3 : 1}`,
    "unknown_package_manager: 1",
  ]));
  expect(checks.get("git.worktrees.dependencies")?.details.join("\n")).toContain("CAC-0042-doctor-active/app/v1");
  expect(checks.get("git.worktrees.dependencies")?.details.join("\n")).toContain("bun install");
  expect(checks.get("git.worktrees.dependencies")?.details.join("\n")).toContain("missing: demo");
  if (fileSymlinkCapability) {
    expect(checks.get("git.worktrees.dependencies")?.details.join("\n")).toContain("CAC-0042-doctor-active/app/v2");
    expect(checks.get("git.worktrees.dependencies")?.details.join("\n")).toContain("CAC-0042-doctor-active/app/v3");
  }
  expect(checks.get("git.worktrees.dependencies")?.details.join("\n")).toContain("CAC-0042-doctor-active/app/v4");
  expect(checks.get("git.worktrees.dependencies")?.details.join("\n")).toContain("mismatches package-lock.json (npm)");
  expect(checks.get("git.worktrees.dependencies")?.details.join("\n")).toContain("CAC-0042-doctor-stale");
  expect(checks.get("git.worktrees.dependencies")?.details.join("\n")).not.toContain("secret-customer-project");
});

test("worktree dependency Doctor follows the configured Organization mountpoint", async () => {
  const root = await createLaunchpadGitFixture();
  tempRoots.push(root);
  await rename(join(root, "organizations"), join(root, "orgs"));
  await writeJson(join(root, "launchpad.gen3.json"), {
    workspace_generation: "gen3",
    organization_mountpoint: "orgs",
    launchpad_root: { slug: "test-root", display_name: "Test Root", root_role: "launchpad-root" },
  });
  const orgRoot = join(root, "orgs", "BetaCo_GEN3");
  const worktreeSlug = "CAC-0042-custom-mountpoint";
  const worktreePath = join(orgRoot, ".worktrees", "workspace", "deals", worktreeSlug);
  await initGitRepo(worktreePath, { branch: worktreeSlug });
  await writeJson(join(worktreePath, "package.json"), {
    name: "custom-mountpoint-fixture",
    private: true,
  });
  await writeFile(
    join(orgRoot, "mission-control", "plans", "2026", "07", `${worktreeSlug}.yaml`),
    `dev_code: CAC-0042\ntitle: Custom mountpoint worktree\nstatus: in_progress\n`,
  );
  await writeJson(join(orgRoot, ".worktrees", "workspace", "deals", `${worktreeSlug}.worktree.json`), {
    schema_version: "companiesascode.worktree.v1",
    branch: worktreeSlug,
    mission_control_plan_code: "CAC-0042",
    mission_control_plan_path: `mission-control/plans/2026/07/${worktreeSlug}.yaml`,
    worktree_path: `.worktrees/workspace/deals/${worktreeSlug}`,
    created_at: new Date().toISOString(),
    created_by: "fixture-agent",
    status: "active",
  });

  const report = await buildLaunchpadDoctorReport({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    runtimeManager: { appsWithRuntime: async (apps) => apps },
    runChildDoctors: false,
  });
  const dependencies = report.checks.find((check) => check.id === "git.worktrees.dependencies");

  expect(dependencies?.status).toBe("ok");
  expect(dependencies?.details).toEqual(expect.arrayContaining([
    "checked_worktrees: 1",
    "skipped_declared_inactive_worktrees: 0",
    "checked_packages: 1",
    "ready: 1",
  ]));
});

test("worktree dependency Doctor proves the exact repository-db member and rejects sidecar drift", async () => {
  const fixture = await createRepositoryDbWorktreeFixture({ port: 25422 });
  tempRoots.push(fixture.root);
  const branch = "CAC-0099-doctor-binding";
  const created = await createWorktreeFromPlan({
    companiesRoot: fixture.root,
    repoKey: "BetaCo::mission-control",
    planPath: fixture.planPath,
    branch,
  });
  const report = await buildLaunchpadDoctorReport({
    companiesRoot: fixture.root,
    launchpadRoot: join(fixture.root, "launchpad"),
    runtimeManager: { appsWithRuntime: async (apps) => apps },
    runChildDoctors: false,
  });
  const dependencies = report.checks.find((check) => check.id === "git.worktrees.dependencies");
  expect(dependencies?.details).toEqual(expect.arrayContaining([
    "checked_repository_db_bindings: 1",
    "repository_db_ready: 1",
    "repository_db_binding_invalid: 0",
  ]));

  const sidecarPath = join(
    fixture.orgRoot,
    ".worktrees",
    "root",
    "mission-control",
    `${created.worktree.slug}.worktree.json`,
  );
  const sidecar = JSON.parse(await readFile(sidecarPath, "utf8"));
  sidecar.members.find((member) => member.role === "dependency").base_sha = "0".repeat(40);
  await writeFile(sidecarPath, `${JSON.stringify(sidecar, null, 2)}\n`);
  const driftedReport = await buildLaunchpadDoctorReport({
    companiesRoot: fixture.root,
    launchpadRoot: join(fixture.root, "launchpad"),
    runtimeManager: { appsWithRuntime: async (apps) => apps },
    runChildDoctors: false,
  });
  const drifted = driftedReport.checks.find((check) => check.id === "git.worktrees.dependencies");
  expect(drifted?.status).toBe("warn");
  expect(drifted?.details).toEqual(expect.arrayContaining([
    "repository_db_ready: 0",
    "repository_db_binding_invalid: 1",
  ]));
  expect(drifted?.details.join("\n")).toContain("binding HEAD neodpovídá sidecar base_sha");
});

test("worktree dependency Doctor reports a legacy sidecar without module_path", async () => {
  const fixture = await createRepositoryDbWorktreeFixture({ port: 25424 });
  tempRoots.push(fixture.root);
  const created = await createWorktreeFromPlan({
    companiesRoot: fixture.root,
    repoKey: "BetaCo::mission-control",
    planPath: fixture.planPath,
    branch: "CAC-0099-doctor-legacy-sidecar",
  });
  const sidecarPath = join(
    fixture.orgRoot,
    ".worktrees",
    "root",
    "mission-control",
    `${created.worktree.slug}.worktree.json`,
  );
  const sidecar = JSON.parse(await readFile(sidecarPath, "utf8"));
  delete sidecar.module_path;
  await writeFile(sidecarPath, `${JSON.stringify(sidecar, null, 2)}\n`);

  const report = await buildLaunchpadDoctorReport({
    companiesRoot: fixture.root,
    launchpadRoot: join(fixture.root, "launchpad"),
    runtimeManager: { appsWithRuntime: async (apps) => apps },
    runChildDoctors: false,
  });
  const dependencies = report.checks.find((check) => check.id === "git.worktrees.dependencies");
  expect(dependencies?.status).toBe("warn");
  expect(dependencies?.details).toEqual(expect.arrayContaining([
    "repository_db_ready: 0",
    "repository_db_binding_invalid: 1",
  ]));
  expect(dependencies?.details.join("\n")).toContain("module_path");
});

if (fileSymlinkCapability) {
  test("worktree dependency Doctor rejects a canonical repository-db owner replaced by a symlink", async () => {
    const fixture = await createRepositoryDbWorktreeFixture({ port: 25423 });
    tempRoots.push(fixture.root);
    await createWorktreeFromPlan({
      companiesRoot: fixture.root,
      repoKey: "BetaCo::mission-control",
      planPath: fixture.planPath,
      branch: "CAC-0099-doctor-owner-boundary",
    });

    const movedOwner = join(fixture.orgRoot, "mission-control", "db-owner-moved");
    await rename(fixture.repositoryDbRepo, movedOwner);
    await symlink(movedOwner, fixture.repositoryDbRepo, "dir");

    const report = await buildLaunchpadDoctorReport({
      companiesRoot: fixture.root,
      launchpadRoot: join(fixture.root, "launchpad"),
      runtimeManager: { appsWithRuntime: async (apps) => apps },
      runChildDoctors: false,
    });
    const dependencies = report.checks.find((check) => check.id === "git.worktrees.dependencies");
    expect(dependencies?.status).toBe("warn");
    expect(dependencies?.details).toEqual(expect.arrayContaining([
      "repository_db_ready: 0",
      "repository_db_binding_invalid: 1",
    ]));
    expect(dependencies?.details.join("\n")).toContain("Kanonický owner checkout není běžný adresář");
  });
}

function buildDoctorRuntimeReport(apps) {
  return buildDoctorReportFromAppsResponse({
    launchpad_root: { display_name: "Test root" },
    root: "/tmp/test-root",
    failures: [],
    warnings: [],
    apps,
    organizations: [],
    port_overlaps: [],
  }, {
    childLane: { children: [], checks: [] },
  });
}

function doctorSharedVersionFamily(apps, openTargetAppId) {
  const sharedPortOwners = apps.map((app) => ({
    app_id: app.id,
    company: app.company,
    module: app.module,
    host: app.host,
    port: app.port,
    lease_id: "main",
  }));
  return apps.map((app) => ({
    ...app,
    module_apps: {
      state: "declared",
      contract_path: app.module_contract.module_path,
      open_target_app_id: openTargetAppId,
      open_target_source: "declared-default",
    },
    module_open_target: app.id === openTargetAppId,
    shared_port_owners: sharedPortOwners,
  }));
}

function doctorSharedVersionApp({
  id,
  title,
  packageVersion,
  port = 24_102,
  runtimeStatus,
  owner,
  failureKind = null,
}) {
  const modulePath = "organizations/TestCo_GEN3/workspace/deals/lazurio.module.json";
  const listenerPid = 42_123;
  const managed = owner === "current-instance";
  return {
    id,
    title,
    company: "TestCo",
    module: "deals",
    host: "127.0.0.1",
    port,
    package_path: `organizations/TestCo_GEN3/workspace/deals/app/${packageVersion}/package.json`,
    dependencies: { state: "ready" },
    runtime_status: runtimeStatus,
    runtime: {
      status: runtimeStatus,
      owner,
      pid: managed ? 42_124 : listenerPid,
      managed,
      controllable: managed,
      failure_kind: failureKind,
      port_owner: managed
        ? null
        : { pid: listenerPid, cwd_matches: owner !== "foreign-port" },
      listener_reconciliation: managed
        ? {
            status: "ok",
            declared: [{
              listener_id: "web",
              host: "127.0.0.1",
              port,
              status: "observed",
              pid: null,
              observed_endpoints: [`127.0.0.1:${port}`],
            }],
          }
        : null,
    },
    runtime_contract: { schema_version: "lazurio.runtime.v1" },
    module_contract: { schema_version: "lazurio.module.v1", module_path: modulePath },
    entrypoint_listener: {
      id: "web",
      lease: "main",
      host: "127.0.0.1",
      allocation: "static",
      port,
      claim: { mode: "exclusive" },
      module_lease: { id: "main", source: modulePath },
    },
  };
}

async function createCompaniesWorkspaceFixture() {
  const root = await mkdtemp(join(tmpdir(), "companiesascode-diagnostics-"));
  tempRoots.push(root);
  await mkdir(join(root, "launchpad"), { recursive: true });
  await mkdir(join(root, "guide"), { recursive: true });
  await mkdir(join(root, "manual"), { recursive: true });
  await mkdir(join(root, "organizations"), { recursive: true });
  await writeJson(join(root, "launchpad.gen3.json"), {
    launchpad_root: {
      slug: "test-companies",
      display_name: "Test Companies",
      root_role: "companies-root",
    },
  });
  await writeFile(
    join(root, ".gitignore"),
    [
      "launchpad/runtime/",
      "launchpad/logs/",
      "logs/",
      "",
    ].join("\n"),
    "utf8",
  );
  run(["git", "init"], root);
  run(["git", "add", "."], root);
  run(["git", "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "init"], root);
  return root;
}

async function createTemplateMountFixture() {
  const root = await mkdtemp(join(tmpdir(), "companiesascode-template-mount-"));
  const templateCheckout = await mkdtemp(join(tmpdir(), "mission-control-template-checkout-"));
  tempRoots.push(root, templateCheckout);
  const templatePath = join(root, "templates", "TemplatesBetaCo", "MissionControlTemplate");
  await mkdir(join(root, "launchpad"), { recursive: true });
  await mkdir(join(root, "guide"), { recursive: true });
  await mkdir(join(root, "manual"), { recursive: true });
  await mkdir(join(root, "organizations"), { recursive: true });
  await mkdir(join(root, "templates", "TemplatesBetaCo"), { recursive: true });
  await writeFile(join(templateCheckout, "README.md"), "# MissionControlTemplate\n", "utf8");
  run(["git", "init"], templateCheckout);
  run(["git", "add", "."], templateCheckout);
  run(["git", "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "template init"], templateCheckout);
  await symlink(templateCheckout, templatePath, process.platform === "win32" ? "junction" : "dir");
  // Scan-first: module šablony jsou informační sken templates/*/*, ne registry.
  await writeJson(join(root, "launchpad.gen3.json"), {
    launchpad_root: {
      slug: "test-companies",
      display_name: "Test Companies",
      root_role: "companies-root",
    },
  });
  await writeFile(
    join(root, ".gitignore"),
    [
      "launchpad/runtime/",
      "launchpad/logs/",
      "logs/",
      "templates/TemplatesBetaCo/",
      "",
    ].join("\n"),
    "utf8",
  );
  run(["git", "init"], root);
  run(["git", "add", ".gitignore", "launchpad.gen3.json"], root);
  run(["git", "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "init"], root);
  return root;
}

async function writeJson(path, data) {
  await writeFile(path, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function run(command, cwd) {
  const result = Bun.spawnSync(command, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(new TextDecoder().decode(result.stderr));
  }
}
