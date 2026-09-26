import { afterAll, expect, test } from "bun:test";
import { tmpdir } from "os";
import { join } from "path";
import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import {
  attachLiveRepositoryPrivacy,
  buildPersonalspaceResponse,
  createPersonalspaceRuntimeManager,
  discoverGitHubCliExecutable,
  githubCliExecutableCandidates,
  inspectGitHubRepository,
  personalspaceRuntimeUrls,
  personalspaceDoctorCheck,
  projectHostedPersonalspaceResponse,
  resolveSpaceGbrainVault,
} from "../../lazurio/runtime/personalspace-runtime-lib.mjs";
import { GbrainAccessError } from "../../lazurio/runtime/gbrain-lib.mjs";

const tempRoots = [];
const privateRepoInspector = async (repo) => ({
  nameWithOwner: repo,
  visibility: "PRIVATE",
});

test("personalspace runtime uses the explicit mutable Launchpad state root", () => {
  const expectedManager = {};
  let received = null;
  const manager = createPersonalspaceRuntimeManager({
    companiesRoot: "/workspace",
    launchpadRoot: "/opt/lazurio-runtime/launchpad",
    stateRoot: "/home/builder/.local/state/lazurio/launchpad",
    lifecycleProfile: "hosted",
    hostedWorkspace: { profile: "hosted", scope: "personal" },
    createRuntimeManagerFn: (options) => {
      received = options;
      return expectedManager;
    },
  });
  expect(manager).toBe(expectedManager);
  expect(received).toMatchObject({
    companiesRoot: "/workspace",
    launchpadRoot: "/opt/lazurio-runtime/launchpad",
    stateRoot: "/home/builder/.local/state/lazurio/launchpad",
    lifecycleProfile: "hosted",
    hostedWorkspace: { profile: "hosted", scope: "personal" },
  });
  expect(typeof received.discover).toBe("function");
});

test("hosted personal scope exposes only canonical defaults with public HTTPS URLs", async () => {
  const { root } = await createFixture({ withApp: true });
  const launchpadRoot = join(root, "launchpad");
  const managerFor = (options) => createPersonalspaceRuntimeManager({
    companiesRoot: root,
    launchpadRoot,
    stateRoot: join(root, "state"),
    ...options,
  });

  // Localhost default: the App is listed with its loopback URL and resolvable.
  const localManager = managerFor({});
  const local = await buildPersonalspaceResponse({ companiesRoot: root, launchpadRoot, runtimeManager: localManager });
  expect(local.summary.app_count).toBe(1);
  const appId = local.spaces[0].apps?.[0]?.id ?? local.apps?.[0]?.id;
  expect(typeof appId).toBe("string");
  expect(JSON.stringify(local)).toContain("127.0.0.1:41100");

  // Hosted personal: no local override, the exact folder names the owner.
  await rm(join(root, "launchpad.gen3.local.json"));
  const configuration = {
    profile: "hosted",
    scope: "personal",
    owner: "exampleuser",
    personalspace: "exampleuser_GEN3",
    organization_slug: null,
    team_id: null,
    domain: "lazurio.io",
    machine: "exampleuser",
    source: "workspace-identity",
  };
  const hostedManager = managerFor({
    primarySpaceDir: "exampleuser_GEN3",
    lifecycleProfile: "hosted",
    hostedWorkspace: configuration,
  });
  const hosted = projectHostedPersonalspaceResponse(await buildPersonalspaceResponse({
    companiesRoot: root,
    launchpadRoot,
    primarySpaceDir: "exampleuser_GEN3",
    runtimeManager: hostedManager,
  }), configuration);
  expect(hosted.summary.space_count).toBe(1);
  expect(hosted.summary.app_count).toBe(1);
  expect(hosted.summary.invalid_app_count).toBe(0);
  expect(hosted.spaces[0].apps[0]).toMatchObject({
    id: appId,
    url: "https://notes.exampleuser.lazurio.io/",
    health_url: "https://notes.exampleuser.lazurio.io/health",
    hosted_url_source: "workspace-identity",
  });
  expect(JSON.stringify(hosted)).not.toContain("http://127.0.0.1:41100");
});

test("personalspace runtime discovery reads tracked config from the selected Root source", async () => {
  const { root, dir } = await createFixture({ withGbrain: false });
  const selectedRoot = await mkdtemp(join(tmpdir(), "ps-selected-root-"));
  tempRoots.push(selectedRoot);
  await writeJson(join(root, "launchpad.gen3.json"), {
    workspace_generation: "gen3",
    personalspace_mountpoint: "missing-personalspace",
  });
  await writeJson(join(selectedRoot, "launchpad.gen3.json"), {
    workspace_generation: "gen3",
    personalspace_mountpoint: "personalspace",
  });
  await writeJson(join(dir, "workspace", "notes", "app", "v1", "package.json"), {
    name: "exampleuser-notes-v1",
    private: true,
    scripts: { dev: "bun server.mjs" },
    companyascode: {
      app: {
        schema_version: "companyascode.launchpad_app.v1",
        id: "notes-v1",
        title: "Notes",
        company: "exampleuser",
        module: "notes",
        surface: "internal",
        port: 41_100,
        host: "127.0.0.1",
        health_path: "/health",
        dev_script: "dev",
        tags: ["personal"],
      },
    },
  });

  let discover;
  createPersonalspaceRuntimeManager({
    companiesRoot: root,
    rootSourceRoot: selectedRoot,
    launchpadRoot: join(root, "launchpad"),
    createRuntimeManagerFn: (options) => {
      discover = options.discover;
      return {};
    },
  });
  const result = await discover();
  expect(result.apps).toHaveLength(1);
  expect(result.apps[0].id).toContain("notes-v1");
});

test("personalspace runtime URLs preserve HTTPS and bracket IPv6 loopback", () => {
  expect(personalspaceRuntimeUrls({
    host: "::1",
    port: 5443,
    health_path: "/health",
    entrypoint_listener: { protocol: "https" },
  })).toEqual({
    url: "https://[::1]:5443",
    health_url: "https://[::1]:5443/health",
  });
});

afterAll(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
});

async function writeJson(path, data) {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function personalConfig(username) {
  return {
    schema_version: "humanandmachines.personal.gen3.v1",
    personal_generation: "gen3",
    owner: { github_username: username, display_name: username, type: "human" },
    buddy: {
      slug: `${username}-buddy`,
      path: "buddy",
      repository: {
        github_repo: `${username}/${username}-buddy`,
        visibility: "private",
        mount_strategy: "doctor-managed-nested-repo",
      },
      runtime: {
        github_repo: "HumanAndMachines/Lazurio",
        deployment_target: "owner-dedicated-personalspace-vps",
        local_execution: "forbidden",
      },
      hermes: {
        software_repo: "NousResearch/hermes-agent",
        profile_format: "hermes-profile-distribution",
        profile_path: "buddy",
      },
      display_name: "Demo Buddy",
      application: { name: "Demo chat", type: "web", url: "https://chat.example.test/" },
      recurring_tasks: {
        "synthetic-check": { title: "Syntetická kontrola", schedule_label: "Podle testu" },
      },
      gbrain_path: "gbrain",
    },
    repository: {
      github_repo: `${username}/${username}_GEN3`,
      mount_path: `personalspace/${username}_GEN3`,
      visibility: "private",
      mount_strategy: "doctor-managed-nested-repo",
    },
    privacy: { default_share: "private", agent_boundary: "personal-context-only", shared_outputs: "metadata-only" },
    modules_manifest_path: "modules.manifest.json",
    workspace_path: "workspace",
    gbrain: {
      path: "gbrain",
      repository: {
        github_repo: `${username}/${username}-gbrain`,
        visibility: "private",
        mount_strategy: "doctor-managed-nested-repo",
      },
      software: {
        github_repo: "garrytan/gbrain",
        install_source: "github:garrytan/gbrain",
      },
      default_shared: false,
      human_editor: "obsidian",
      agent_access: "mcp-only",
    },
    secrets: { path: "secrets", custody_pattern: "personalspace/<owner>_GEN3/secrets/<provider>/<scope>/<purpose>", git: "ignored" },
    shared_spaces: [],
  };
}

async function createFixture({ withGbrain = true, sharedSpace = false, withApp = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "ps-runtime-"));
  tempRoots.push(root);
  await mkdir(join(root, "launchpad", "schemas"), { recursive: true });
  const realSchemas = join(import.meta.dirname, "..", "..", "lazurio", "schemas");
  for (const name of ["personal.gen3.schema.json", "launchpad-app.schema.json"]) {
    await writeFile(join(root, "launchpad", "schemas", name), await Bun.file(join(realSchemas, name)).text(), "utf8");
  }
  await writeJson(join(root, "launchpad.gen3.json"), {
    workspace_generation: "gen3",
    organization_mountpoint: "organizations",
    personalspace_mountpoint: "personalspace",
  });
  // Scan-first: primární vlastník mašiny žije v gitignored per-machine override,
  // ne v trackovaném sdíleném configu (osobní data do shared repu nepatří).
  await writeJson(join(root, "launchpad.gen3.local.json"), { personalspace_owner: "exampleuser" });
  const dir = join(root, "personalspace", "exampleuser_GEN3");
  await mkdir(join(dir, "workspace"), { recursive: true });
  await writeJson(join(dir, "personal.gen3.json"), personalConfig("exampleuser"));
  await writeJson(join(dir, "modules.manifest.json"), { personal_generation: "gen3", owner: "exampleuser", module_slots: [] });
  if (withApp) {
    await writeJson(join(dir, "workspace", "notes", "lazurio.module.json"), {
      schema_version: "lazurio.module.v1",
      id: "notes",
      company: "exampleuser",
      tcp_port_policy: { mode: "single" },
      port_leases: [{ id: "main", host: "127.0.0.1", port: 41_100 }],
      apps: ["app/v1/package.json"],
      default_app: "app/v1/package.json",
    });
    const appDir = join(dir, "workspace", "notes", "app", "v1");
    await mkdir(appDir, { recursive: true });
    await writeJson(join(appDir, "package.json"), {
      name: "exampleuser-notes-v1",
      version: "1.0.0",
      packageManager: "bun@1.0.0",
      scripts: { dev: "bun run server.mjs" },
      lazurio: {
        runtime: {
          schema_version: "lazurio.runtime.v1",
          id: "notes-v1",
          title: "Osobní poznámky",
          company: "exampleuser",
          module: "notes",
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
  }
  if (withGbrain) {
    await mkdir(join(dir, "gbrain"), { recursive: true });
    await writeFile(join(dir, "gbrain", "index.md"), "# soukromá poznámka jen pro mě", "utf8");
  }
  // Zakázaný cizí prostor jiného Kolegy s lokálně přítomným gbrain vaultem →
  // discovery ho podle decision 0091 nesmí vrátit.
  if (sharedSpace) {
    const otherDir = join(root, "personalspace", "kolega_GEN3");
    await mkdir(join(otherDir, "workspace"), { recursive: true });
    await writeJson(join(otherDir, "personal.gen3.json"), personalConfig("kolega"));
    await writeJson(join(otherDir, "modules.manifest.json"), { personal_generation: "gen3", owner: "kolega", module_slots: [] });
    await mkdir(join(otherDir, "gbrain"), { recursive: true });
    await writeFile(join(otherDir, "gbrain", "index.md"), "# cizí soukromá poznámka", "utf8");
  }
  return { root, dir };
}

test("buildPersonalspaceResponse vrací prostory + summary, metadata-only", async () => {
  const { root } = await createFixture();
  const response = await buildPersonalspaceResponse({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    profileEmail: "owner@example.com",
  });
  expect(response.ok).toBe(true);
  expect(response.summary.space_count).toBe(1);
  expect(response.spaces[0].owner).toBe("exampleuser");
  expect(response.spaces[0].is_owner_primary).toBe(true);
  expect(response.spaces[0].buddy).toMatchObject({
    slug: "exampleuser-buddy",
    display_name: "Demo Buddy",
    application: { name: "Demo chat", type: "web", url: "https://chat.example.test/" },
    recurring_tasks: [{ id: "synthetic-check", title: "Syntetická kontrola", schedule_label: "Podle testu" }],
  });
  expect(response.profile).toEqual({
    display_name: "exampleuser",
    email: "owner@example.com",
    github_username: "exampleuser",
    avatar_url: "https://github.com/exampleuser.png?size=128",
    settings_url: "https://github.com/settings/profile",
  });
  // Odpověď NIKDY nenese obsah gbrain zápisů.
  expect(JSON.stringify(response)).not.toContain("soukromá poznámka");
});

test("hosted personal Machine: the exact Personalspace folder names the owner without a local override", async () => {
  const { root } = await createFixture({ withGbrain: true });
  await rm(join(root, "launchpad.gen3.local.json"));
  const withoutFolder = await buildPersonalspaceResponse({ companiesRoot: root, launchpadRoot: join(root, "launchpad") });
  expect(withoutFolder.summary.space_count).toBe(0);
  expect(withoutFolder.warnings.join("\n")).toContain("personalspace_owner");

  const response = await buildPersonalspaceResponse({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    primarySpaceDir: "exampleuser_GEN3",
  });
  expect(response.primary_owner).toBe("exampleuser");
  expect(response.summary.space_count).toBe(1);
  expect(response.spaces[0].is_owner_primary).toBe(true);
  expect(response.warnings.join("\n")).not.toContain("personalspace_owner");
  const vault = await resolveSpaceGbrainVault({
    companiesRoot: root,
    primarySpaceDir: "exampleuser_GEN3",
    spaceDirName: "exampleuser_GEN3",
  });
  expect(vault.vaultRoot).toBe(join(root, "personalspace", "exampleuser_GEN3", "gbrain"));
});

test("personalspaceDoctorCheck je metadata-only a nikdy neobsahuje obsah zápisů", async () => {
  const { root } = await createFixture();
  const response = await buildPersonalspaceResponse({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    verifyRepositoryPrivacy: true,
    inspectRepository: privateRepoInspector,
  });
  const check = personalspaceDoctorCheck(response);
  expect(check.id).toBe("launchpad.personalspace");
  expect(["ok", "warn", "fail", "not_applicable", "blocked"]).toContain(check.status);
  // Detaily nesou jen počty/validitu/gbrain mode, ne obsah.
  expect(JSON.stringify(check)).not.toContain("soukromá poznámka");
  expect(check.details.join(" ")).toContain("Principálův");
  expect(check.details.join(" ")).toContain("gbrain repo živě ověřeno private");
});

test("personalspaceDoctorCheck = not_applicable, když není žádný osobní prostor", async () => {
  const root = await mkdtemp(join(tmpdir(), "ps-empty-"));
  tempRoots.push(root);
  await writeJson(join(root, "launchpad.gen3.json"), { workspace_generation: "gen3", personalspace_mountpoint: "personalspace" });
  await mkdir(join(root, "launchpad", "schemas"), { recursive: true });
  const realSchemas = join(import.meta.dirname, "..", "..", "lazurio", "schemas");
  for (const name of ["personal.gen3.schema.json", "launchpad-app.schema.json"]) {
    await writeFile(join(root, "launchpad", "schemas", name), await Bun.file(join(realSchemas, name)).text(), "utf8");
  }
  const response = await buildPersonalspaceResponse({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    verifyRepositoryPrivacy: true,
    inspectRepository: privateRepoInspector,
  });
  const check = personalspaceDoctorCheck(response);
  // Chybějící osobní prostor je FAKT o topologii, ne nezměřená kontrola
  // (decision 0118): zelenou nekazí, ale musí říct, kdo ho vlastní.
  expect(check.status).toBe("not_applicable");
  expect(check.not_applicable_reason).toBe("no_such_mount");
  expect(check.owner.length).toBeGreaterThan(0);
});

test("personalspaceDoctorCheck = not_applicable (no_such_mount) na sdílené týmové Mašině", () => {
  // Týmová Mašina nemá osobního vlastníka: kontrola nečte žádný prostor a
  // nekazí zelenou, i kdyby odpověď nějaká data nesla.
  for (const response of [{}, { mountpoint: "personalspace", spaces: [{ config_valid: false }], failures: ["x"] }]) {
    const check = personalspaceDoctorCheck(response, { teamMachine: true });
    expect(check.id).toBe("launchpad.personalspace");
    expect(check.status).toBe("not_applicable");
    expect(check.not_applicable_reason).toBe("no_such_mount");
    expect(check.message).toContain("sdílená týmová Mašina");
    expect(check.message).toContain("osobního vlastníka");
    expect(check.details).toEqual([]);
    expect(check.owner.length).toBeGreaterThan(0);
  }
  // Bez volby zůstává dosavadní chování.
  expect(personalspaceDoctorCheck({ spaces: [], failures: [], warnings: [] }).message)
    .toBe("Na této mašině není namountovaný žádný osobní prostor.");
});

test("Doctor fail-closed odmítne public gbrain repo i při private deklaraci v manifestu", async () => {
  const { root } = await createFixture();
  const response = await buildPersonalspaceResponse({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    verifyRepositoryPrivacy: true,
    inspectRepository: async (repo) => ({
      nameWithOwner: repo,
      visibility: repo.endsWith("-gbrain") ? "PUBLIC" : "PRIVATE",
    }),
  });
  const check = personalspaceDoctorCheck(response);
  expect(check.status).toBe("fail");
  expect(check.details.join(" ")).toContain("gbrain repo NENÍ private");
  expect(check.details.join(" ")).toContain("live visibility: public");
});

test("Doctor fail-closed odmítne repo, jehož live GitHub metadata nejdou ověřit", async () => {
  const { root } = await createFixture();
  const response = await buildPersonalspaceResponse({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    verifyRepositoryPrivacy: true,
    inspectRepository: async () => {
      throw new Error("offline");
    },
  });
  const check = personalspaceDoctorCheck(response);
  expect(check.status).toBe("fail");
  expect(check.details.join(" ")).toContain("repo privacy nelze živě ověřit");
});

test("legacy Personalspace bez deklarovaného gbrain repa není označený jako privacy-checked", async () => {
  const [space] = await attachLiveRepositoryPrivacy([{
    mount_path: "personalspace/exampleuser_GEN3",
    config_valid: true,
    github_repo: "exampleuser/exampleuser_GEN3",
    gbrain: { exists: true, mode: "legacy" },
    module_summary: {},
  }], { inspectRepository: privateRepoInspector });

  expect(space.live_repository_privacy_checked).toBe(false);
  expect(space.repository_privacy_missing_roles).toEqual(["gbrain"]);
  expect(space.repository_privacy_checks).toEqual([{
    role: "owner",
    github_repo: "exampleuser/exampleuser_GEN3",
    status: "private",
    visibility: "private",
  }]);

  const check = personalspaceDoctorCheck({
    mountpoint: "personalspace",
    spaces: [space],
    failures: [],
    warnings: [],
    summary: { app_count: 0 },
  });
  expect(check.status).toBe("fail");
  expect(check.details.join(" ")).toContain("chybí deklarovaný gbrain repository binding");
});

test("live GitHub privacy probe používá bounded shell-free gh příkaz", async () => {
  let observed;
  const info = await inspectGitHubRepository("exampleuser/exampleuser-gbrain", {
    cwd: "/tmp/example",
    ghExecutable: "gh",
    spawnSync: (command, options) => {
      observed = { command, options };
      return {
        exitCode: 0,
        stdout: new TextEncoder().encode(JSON.stringify({
          nameWithOwner: "exampleuser/exampleuser-gbrain",
          visibility: "PRIVATE",
        })),
      };
    },
  });
  expect(info.visibility).toBe("PRIVATE");
  expect(observed.command).toEqual([
    "gh",
    "repo",
    "view",
    "exampleuser/exampleuser-gbrain",
    "--json",
    "nameWithOwner,visibility",
  ]);
  expect(observed.options).toMatchObject({
    cwd: "/tmp/example",
    timeout: 10_000,
    windowsHide: true,
  });
  expect(observed.options.env.GH_PROMPT_DISABLED).toBe("1");
});

test("Windows scheduled privacy probe hledá gh.exe v deterministickém PATH, Program Files a LOCALAPPDATA pořadí", () => {
  const env = {
    ProgramW6432: "C:\\Program Files",
    ProgramFiles: "C:\\Program Files",
    "ProgramFiles(x86)": "C:\\Program Files (x86)",
    LOCALAPPDATA: "C:\\Users\\builder\\AppData\\Local",
  };
  const fallbackCandidates = githubCliExecutableCandidates({ platform: "win32", env });
  expect(fallbackCandidates).toEqual([
    "C:\\Program Files\\GitHub CLI\\gh.exe",
    "C:\\Program Files (x86)\\GitHub CLI\\gh.exe",
    "C:\\Users\\builder\\AppData\\Local\\Programs\\GitHub CLI\\bin\\gh.exe",
    "C:\\Users\\builder\\AppData\\Local\\Programs\\GitHub CLI\\gh.exe",
  ]);

  const pathExecutable = "C:\\Tools\\GitHub CLI\\gh.exe";
  const pathFirst = discoverGitHubCliExecutable({
    platform: "win32",
    env,
    which: (command) => command === "gh.exe" ? pathExecutable : null,
    pathExists: () => true,
  });
  expect(pathFirst.executable).toBe(pathExecutable);
  expect(pathFirst.source).toBe("PATH");

  const stalePathFallsBack = discoverGitHubCliExecutable({
    platform: "win32",
    env,
    which: () => "C:\\Removed\\gh.exe",
    pathExists: (candidate) => candidate === fallbackCandidates[0],
  });
  expect(stalePathFallsBack).toMatchObject({
    executable: fallbackCandidates[0],
    source: "Program Files",
  });

  const localExecutable = fallbackCandidates[2];
  const installedFallback = discoverGitHubCliExecutable({
    platform: "win32",
    env,
    which: () => null,
    pathExists: (candidate) => candidate === localExecutable,
  });
  expect(installedFallback.executable).toBe(localExecutable);
  expect(installedFallback.source).toBe("LOCALAPPDATA");
  expect(installedFallback.searched).toEqual([
    "PATH:gh.exe",
    "PATH:gh",
    ...fallbackCandidates,
  ]);

  const trailingLocalRoot = discoverGitHubCliExecutable({
    platform: "win32",
    env: { LOCALAPPDATA: `${env.LOCALAPPDATA}\\` },
    which: () => null,
    pathExists: (candidate) => candidate.endsWith("\\bin\\gh.exe"),
  });
  expect(trailingLocalRoot.source).toBe("LOCALAPPDATA");
});

test("Windows scheduled privacy probe hlásí bounded diagnostiku, když gh.exe chybí", async () => {
  const discovery = discoverGitHubCliExecutable({
    platform: "win32",
    env: {
      ProgramFiles: "C:\\Program Files",
      LOCALAPPDATA: "C:\\Users\\builder\\AppData\\Local",
    },
    which: () => null,
    pathExists: () => false,
  });

  expect(discovery.executable).toBeNull();
  await expect(inspectGitHubRepository("exampleuser/exampleuser-gbrain", {
    ghDiscovery: discovery,
  })).rejects.toThrow("PATH:gh.exe");
  await expect(inspectGitHubRepository("exampleuser/exampleuser-gbrain", {
    ghDiscovery: discovery,
  })).rejects.toThrow("C:\\Program Files\\GitHub CLI\\gh.exe");
});

test("POSIX privacy probe zachová shell-free PATH spawn i bez Bun.which", () => {
  expect(discoverGitHubCliExecutable({
    platform: "linux",
    which: () => null,
    pathExists: () => false,
  })).toEqual({
    executable: "gh",
    source: "PATH-fallback",
    searched: ["PATH:gh"],
  });
});

test("Doctor nikdy nečte privátní Buddy presentation warnings", () => {
  const privateDetail = "buddy.recurring_tasks[0].id therapy-session je duplicitní";
  const check = personalspaceDoctorCheck({
    mountpoint: "personalspace",
    spaces: [],
    failures: [],
    warnings: [],
    presentation_warnings: [privateDetail],
    summary: { app_count: 0 },
  });

  expect(check.status).toBe("not_applicable");
  expect(JSON.stringify(check)).not.toContain(privateDetail);
});

test("personalspace Doctor zpřístupní kanonický důvod failure pro problems panel", () => {
  const check = personalspaceDoctorCheck({
    mountpoint: "personalspace",
    spaces: [{ mount_path: "personalspace/otherowner_GEN3", config_valid: true, module_summary: {} }],
    failures: ["personal.gen3.json není validní"],
    warnings: [],
    summary: { app_count: 0 },
  });

  expect(check.status).toBe("fail");
  expect(check.details).toContain("failure: personal.gen3.json není validní");
});

test("personalspace Doctor neudělá skip při failure bez materializovaného prostoru", () => {
  const check = personalspaceDoctorCheck({
    mountpoint: "personalspace",
    spaces: [],
    failures: ["personalspace mount nejde přečíst"],
    warnings: [],
    summary: { app_count: 0 },
  });

  expect(check.status).toBe("fail");
  expect(check.details).toContain("failure: personalspace mount nejde přečíst");
});

test("personalspace Doctor vypíše kód nerozpoznaného cizího adresáře", async () => {
  const { root } = await createFixture();
  await mkdir(join(root, "personalspace", "foreign-vault"), { recursive: true });
  const response = await buildPersonalspaceResponse({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
  });
  const check = personalspaceDoctorCheck(response);

  expect(check.status).toBe("fail");
  expect(check.details.join(" ")).toContain("foreign_or_unrecognized_personalspace_dir");
  expect(check.details.join(" ")).toContain("personalspace/foreign-vault");
  expect(response.spaces.map((space) => space.dir_name)).toEqual(["exampleuser_GEN3"]);
});

test("resolveSpaceGbrainVault vrací vault root jen pro validní prostor s existujícím vaultem", async () => {
  const { root } = await createFixture({ withGbrain: true });
  const vault = await resolveSpaceGbrainVault({ companiesRoot: root, spaceDirName: "exampleuser_GEN3" });
  expect(vault.vaultRoot).toBe(join(root, "personalspace", "exampleuser_GEN3", "gbrain"));
  expect(vault.mode).toBe("canonical");
});

test("gbrain resolution uses the same selected Root config as Personalspace listing", async () => {
  const { root } = await createFixture({ withGbrain: true });
  const selectedRoot = await mkdtemp(join(tmpdir(), "ps-gbrain-selected-root-"));
  tempRoots.push(selectedRoot);
  await writeJson(join(root, "launchpad.gen3.json"), {
    workspace_generation: "gen3",
    organization_mountpoint: "organizations",
    personalspace_mountpoint: "missing-personalspace",
  });
  await writeJson(join(selectedRoot, "launchpad.gen3.json"), {
    workspace_generation: "gen3",
    organization_mountpoint: "organizations",
    personalspace_mountpoint: "personalspace",
  });

  const vault = await resolveSpaceGbrainVault({
    companiesRoot: root,
    rootSourceRoot: selectedRoot,
    spaceDirName: "exampleuser_GEN3",
  });
  expect(vault.vaultRoot).toBe(join(root, "personalspace", "exampleuser_GEN3", "gbrain"));
});

test("resolveSpaceGbrainVault odmítne neznámý prostor a chybějící vault", async () => {
  const { root } = await createFixture({ withGbrain: false });
  await expect(resolveSpaceGbrainVault({ companiesRoot: root, spaceDirName: "neexistuje_GEN3" })).rejects.toThrow(GbrainAccessError);
  // Prostor existuje, ale vault ne → vault_not_found.
  await expect(resolveSpaceGbrainVault({ companiesRoot: root, spaceDirName: "exampleuser_GEN3" })).rejects.toThrow(/vault/);
});

test("resolveSpaceGbrainVault cizí Personalspace vůbec nenajde (decision 0091)", async () => {
  const { root } = await createFixture({ withGbrain: true, sharedSpace: true });
  let error;
  try {
    await resolveSpaceGbrainVault({ companiesRoot: root, spaceDirName: "kolega_GEN3" });
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(GbrainAccessError);
  expect(error.status).toBe(404);
  expect(error.code).toBe("space_not_found");
  // Vlastní primární prostor zůstává přístupný.
  const vault = await resolveSpaceGbrainVault({ companiesRoot: root, spaceDirName: "exampleuser_GEN3" });
  expect(vault.vaultRoot).toBe(join(root, "personalspace", "exampleuser_GEN3", "gbrain"));
});

test("the Launchpad server binds every Personalspace lane to the hosted folder", async () => {
  const server = await Bun.file(join(import.meta.dirname, "server.mjs")).text();
  expect(server).toContain("const hostedPersonalspaceDir = personalHostedScope ? hostedWorkspace.personalspace : undefined;");
  // Personal Apps runtime, /api/personalspace and gbrain.
  expect(server.match(/primarySpaceDir: hostedPersonalspaceDir,/g)?.length).toBe(4);
  expect(server).toContain("projectHostedPersonalspaceResponse(response, hostedWorkspace)");
  expect(server).toContain("personalspaceRuntimeManager.maintainApps(selected.apps)");
  expect(server).not.toContain("personalspaceListsApps");
});
