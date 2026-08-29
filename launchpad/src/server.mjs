import { randomUUID } from "node:crypto";
import { constants, existsSync, lstatSync, realpathSync } from "fs";
import { open, readFile } from "fs/promises";
import { createConnection } from "node:net";
import { isAbsolute, join, normalize, relative, resolve } from "path";
import {
  buildDoctorReportFromAppsResponse,
  buildLaunchpadAppsResponse,
  loadRootDoctorSchema,
} from "../../lazurio/runtime/diagnostics-lib.mjs";
import { runChildDoctorLane } from "../../lazurio/runtime/doctor-children-lib.mjs";
import { openBrowser } from "./browser-open-lib.mjs";
import {
  launchpadFallbackUrls,
  rollbackUnpublishedServerStartup,
  startLaunchpadWithPortPolicy,
} from "./server-startup-lib.mjs";
import {
  acquireServerLifetimeLock,
  acquireServerStartupLock,
} from "./server-lifetime-lock-lib.mjs";
import { APP_FILESYSTEM_ROOT, discoverLaunchpadApps } from "../../lazurio/runtime/discovery-lib.mjs";
import {
  GitApiError,
  buildGitApiResponse,
  buildPlansResponse,
  buildRepoChangesResponse,
  buildRepoResponse,
  buildWorktreesResponse,
} from "../../lazurio/runtime/git-api-lib.mjs";
import { RuntimeActionError, createRuntimeManager } from "../../lazurio/runtime/runtime-lib.mjs";
import { createGitStatusService } from "../../lazurio/runtime/git-status-lib.mjs";
import { readLazurioUpdateStatus, runLazurioUpdate } from "../../lazurio/runtime/lazurio-update-lib.mjs";
import { WorktreeActionError, createWorktreeFromPlan, publishWorktreeDraft } from "./worktree-actions-lib.mjs";
import { buildRecentModuleChanges } from "./recent-changes-lib.mjs";
import { buildNotifications } from "./notifications-lib.mjs";
import { buildMostUsedApps } from "../../lazurio/runtime/usage-lib.mjs";
import {
  buildPersonalspaceResponse,
  createPersonalspaceRuntimeManager,
  personalspaceDoctorCheck,
  resolveSpaceGbrainVault,
} from "../../lazurio/runtime/personalspace-runtime-lib.mjs";
import { GbrainAccessError, gbrainFile, gbrainSearch, gbrainTree } from "../../lazurio/runtime/gbrain-lib.mjs";
import { createGenerationSafeResponseCache } from "./apps-response-cache-lib.mjs";
import { createServerShutdownStateAuthority } from "./server-shutdown-state-lib.mjs";
import { LAZURIO_LAUNCHPAD_NAME } from "../../lazurio/runtime/launchpad-identity-lib.mjs";
import { readOrganizationLaunchpadTheme } from "./organization-theme-lib.mjs";
import { ModuleFolderActionError, createModuleFolderOpener } from "./module-folder-lib.mjs";
import {
  HostedAppUrlError,
  createHostedWorkspaceConfiguration,
  hostedLifecycleConfigurationId,
  projectHostedAppUrl,
  projectHostedRuntimePayload,
  requireHostedAppUrl,
  selectHostedWorkspaceApps,
  validateHostedWorkspaceBindings,
} from "./hosted-app-url-lib.mjs";
import {
  GIT_LOCAL_TIMEOUT_MS,
  resolveGitExecutableSync,
  safeGitCommandEnv,
} from "../../lazurio/runtime/git-lib.mjs";
import { createRequestTrustPolicy } from "./request-trust-lib.mjs";
import { launchpadEntryHash, launchpadEntryUrl } from "../../lazurio/runtime/deep-link-lib.mjs";
import {
  assertAvailableAgentEntryOrganization,
  parseLaunchpadServerArgs,
} from "./server-args-lib.mjs";
import { resolveLaunchpadStateRoot } from "./state-root-lib.mjs";
import {
  buildServerIdentity,
  classifyServerIdentity,
  computeServerInstallGeneration,
  computeServerRootId,
  resolveCanonicalServerRoot,
} from "../../lazurio/core/server-identity-lib.mjs";
import {
  readServerLocatorIfPresent,
  removeServerLocatorIfOwned,
  resolveServerStateDirectory,
  writeServerLocator,
} from "../../lazurio/core/server-locator-lib.mjs";

const defaultHost = "127.0.0.1";
const defaultPort = 4174;
const allowedHosts = new Set(["127.0.0.1", "localhost"]);
const safeApiMethods = new Set(["GET", "HEAD", "OPTIONS"]);
const explicitRuntimeSourceActions = new Set(["install", "repair", "start", "open", "stop", "restart", "switch"]);
const launchpadRoot = join(import.meta.dirname, "..");
const publicRoot = join(launchpadRoot, "public");
const options = parseLaunchpadServerArgs(Bun.argv.slice(2));
if (options.agentEntry) {
  launchpadEntryHash({
    organization: options.organization ?? null,
    personalspace: Boolean(options.personalspace),
  });
}
const selectedCompaniesRoot = resolve(options.root ?? process.env.WORKSPACE_ROOT ?? join(launchpadRoot, ".."));
const selectedCompaniesRootPath = realpathSync.native(selectedCompaniesRoot);
const canonicalCompaniesRoot = resolveCanonicalServerRoot(selectedCompaniesRoot);
const rootSourceRoot = selectedCompaniesRootPath;
const companiesRoot = canonicalCompaniesRoot;
const worktreeMountContextReadOnly = selectedCompaniesRootPath !== canonicalCompaniesRoot;
const lazurioCodeRoot = resolve(launchpadRoot, "..");
const configuredRuntimeRoot = resolve(process.env.LAZURIO_RUNTIME_ROOT ?? lazurioCodeRoot);
if (realpathSync.native(configuredRuntimeRoot) !== realpathSync.native(lazurioCodeRoot)) {
  throw new Error("LAZURIO_RUNTIME_ROOT musí přesně označovat Lazurio runtime, ze kterého běží Launchpad server.");
}
const launchpadRootId = computeServerRootId(canonicalCompaniesRoot);
const launchpadControlRootId = computeServerRootId(rootSourceRoot);
const launchpadInstallGeneration = computeServerInstallGeneration(lazurioCodeRoot);
const hostedWorkspace = createHostedWorkspaceConfiguration({
  profile: process.env.LAZURIO_WORKSPACE_PROFILE,
  organizationSlug: process.env.LAZURIO_ORGANIZATION_SLUG,
  teamId: process.env.LAZURIO_TEAM_ID,
  domain: process.env.LAZURIO_HOSTED_DOMAIN,
});
const launchpadLifecycleConfigurationId = hostedLifecycleConfigurationId(hostedWorkspace);
const launchpadServerIdentity = buildServerIdentity({
  rootId: launchpadRootId,
  controlRootId: launchpadControlRootId,
  installGeneration: launchpadInstallGeneration,
  lifecycleConfigurationId: launchpadLifecycleConfigurationId,
  instanceId: randomUUID(),
  pid: process.pid,
  startedAt: new Date().toISOString(),
  requestTrustProfile: hostedWorkspace.profile,
});
const host = options.host ?? defaultHost;
const port = Number(options.port ?? process.env.PORT ?? defaultPort);
const explicitPort = options.port !== undefined;
const principalEmail = resolvePrincipalEmail();
const launchpadStateRoot = resolveLaunchpadStateRoot({
  configuredStateRoot: process.env.LAZURIO_LAUNCHPAD_STATE_ROOT,
  hosted: hostedWorkspace.profile === "hosted",
  runtimeRoot: configuredRuntimeRoot,
  workspaceRoot: canonicalCompaniesRoot,
  // The one per-user Server keeps one operational store while its selected
  // control root moves between main and linked worktrees. A worktree-local
  // fallback would orphan runtime ownership.
  fallbackRoot: join(canonicalCompaniesRoot, "launchpad"),
});
// Machine coordination is deliberately independent from the supervisor's
// operational Launchpad state. Every supported entrypoint therefore resolves
// the same OS-standard per-user locator directory.
const serverStateDirectory = resolveServerStateDirectory();
const requestTrust = createRequestTrustPolicy({
  profile: hostedWorkspace.profile,
  hostedExternalOrigin: process.env.LAZURIO_LAUNCHPAD_EXTERNAL_ORIGIN,
  hostedAuthCheckUrl: process.env.LAZURIO_LAUNCHPAD_AUTH_CHECK_URL,
  hostedAuthCookieName: process.env.LAZURIO_LAUNCHPAD_AUTH_COOKIE_NAME,
});
const runtimeManager = createRuntimeManager({
  companiesRoot,
  launchpadRoot,
  stateRoot: launchpadStateRoot,
  lifecycleProfile: hostedWorkspace.profile,
  discover: (_root, discoveryOptions = {}) => discoverLaunchpadApps(rootSourceRoot, {
    ...discoveryOptions,
    organization_mount_root: companiesRoot,
    machine_context_root: companiesRoot,
  }),
});
function runWorkspaceUpdate() {
  return runLazurioUpdate({
    rootPath: companiesRoot,
    runtimeRoot: configuredRuntimeRoot,
    deps: {
      // Server je jediný vlastník app lifecycle. Dependency refresh po pullu
      // proto zastaví a obnoví přesně managed modul místo mutace živého procesu.
      refreshAppDependencies: ({ appId }) => runtimeManager.refreshDependencies(appId),
    },
  });
}
const moduleFolderOpener = createModuleFolderOpener({ companiesRoot, getAppsResponse: buildAppsResponse });
const gitStatusService = createGitStatusService();
// Delší než jeden render burst (sync + notifications + usage), kratší než
// 15s active-window poll: out-of-band pád runtime se nezadrží o další tick.
const appsResponseCacheTtlMs = 10_000;
const organizationLogoCandidates = [
  "launchpad/app/v1/web/launchpad-icon.png",
  "launchpad/app/v1/web/logo-square.png",
  "launchpad/app/v1/web/favicon.svg",
  "launchpad/app/v1/web/favicon.png",
];
const maxOrganizationLogoBytes = 2 * 1024 * 1024;
let organizationLogoPaths = new Map();
const appsResponseCache = createGenerationSafeResponseCache({
  build: () => buildAppsResponseUncached({ includeGit: false }),
  ttlMs: appsResponseCacheTtlMs,
  onCommit: ({ logoPaths }) => {
    organizationLogoPaths = logoPaths;
  },
});
// Personalspace lane (CAC-0048): úplně oddělený runtime manager pro osobní
// aplikace. Local-only (server běží jen na 127.0.0.1). Osobní data se nikdy
// nepropisují do org /api/apps ani /api/doctor shared výstupu.
const personalspaceRuntimeManager = createPersonalspaceRuntimeManager({
  companiesRoot,
  rootSourceRoot,
  launchpadRoot,
  stateRoot: launchpadStateRoot,
});
const serverShutdownState = createServerShutdownStateAuthority();

if (!Number.isInteger(port) || port < 1024 || port > 65535) {
  console.error(`Neplatný port: ${options.port ?? process.env.PORT}`);
  process.exit(1);
}

if (!allowedHosts.has(host)) {
  console.error(`Neplatný host: ${host}. Launchpad v1 smí běžet jen na 127.0.0.1 nebo localhost.`);
  process.exit(1);
}

let startResult;
let serverLocator;
let hostedMaintenance = null;
let serverLifetimeLock;
let serverStartupLock;
let startupError;
try {
  await validateAgentEntryOrganization();
  // Serialize the complete locator decision. Without this short lease, a
  // launcher recovering Server A's missing locator could overwrite Server B's
  // locator after a concurrent control-root replacement completed.
  serverStartupLock = await withServerStateAccess(() => acquireServerStartupLock({
    stateDirectory: serverStateDirectory,
    instanceId: launchpadServerIdentity.instance_id,
  }));
  const existingLocator = await withServerStateAccess(() => readServerLocatorIfPresent({
    stateDirectory: serverStateDirectory,
  }));
  startResult = await startLaunchpadWithPortPolicy({
    requestedPort: port,
    host,
    explicitPort,
    shouldOpen: Boolean(options.open),
    shouldReuse: Boolean(options.open || options.reuse),
    locatedUrl: existingLocator?.origin ?? null,
    // The requested port is inspected naturally if bind reports EADDRINUSE.
    // Recovery only needs to search the fallback ports that could otherwise
    // remain hidden when the requested port has become free again.
    knownServerUrls: launchpadFallbackUrls({ host, startPort: port })
      .slice(options.open || options.reuse ? 0 : 1),
    startServer,
    inspectRunningLaunchpad: (url) => inspectRunningLaunchpad(url, {
      rootId: launchpadRootId,
      controlRootId: launchpadControlRootId,
      installGeneration: launchpadInstallGeneration,
      lifecycleConfigurationId: launchpadLifecycleConfigurationId,
    }),
    shutdownStaleLaunchpad: requestStaleLaunchpadShutdown,
    openExisting: openBrowser,
    acquireServerLease: async () => {
      serverLifetimeLock ??= await withServerStateAccess(() => acquireServerLifetimeLock({
        stateDirectory: serverStateDirectory,
        instanceId: launchpadServerIdentity.instance_id,
      }));
    },
  });
  if (startResult.mode === "reused") {
    const observation = await inspectRunningLaunchpad(startResult.url, {
      rootId: launchpadRootId,
      controlRootId: launchpadControlRootId,
      installGeneration: launchpadInstallGeneration,
      lifecycleConfigurationId: launchpadLifecycleConfigurationId,
    });
    if (observation.status !== "compatible") {
      throw new Error("Reused Lazurio Server no longer has the expected identity.");
    }
    await refreshReusedAgentEntryInventory(startResult.url);
    serverLocator = await withServerStateAccess(() => writeServerLocator({
      stateDirectory: serverStateDirectory,
      origin: startResult.url,
      identity: observation.identity,
    }));
  } else {
    const serverUrl = `http://${host}:${startResult.server.port}`;
    serverLocator = await withServerStateAccess(() => writeServerLocator({
      stateDirectory: serverStateDirectory,
      origin: serverUrl,
      identity: launchpadServerIdentity,
    }));
    serverShutdownState.markRunning();
    if (hostedWorkspace.profile === "hosted") {
      // The control plane and durable locator are ready before any Module
      // process. Discovery only schedules the exact Team set; the Runtime
      // Manager starts and repairs each Module independently.
      hostedMaintenance = await refreshHostedWorkspaceMaintenance({ warnSkipped: true });
    }
  }
} catch (error) {
  startupError = await abortUnpublishedStartup(error);
} finally {
  try {
    await serverStartupLock?.release();
  } catch (error) {
    if (!startupError) {
      startupError = await abortUnpublishedStartup(error);
    }
  }
}

async function abortUnpublishedStartup(originalError) {
  if (startResult?.mode !== "started") return originalError;
  return rollbackUnpublishedServerStartup({
    originalError,
    runtimeManager,
    server: startResult.server,
  });
}

async function validateAgentEntryOrganization() {
  if (!options.agentEntry || options.organization === undefined) return;
  const discovery = await discoverLaunchpadApps(rootSourceRoot, {
    organization: options.organization,
    organization_mount_root: companiesRoot,
    machine_context_root: companiesRoot,
  });
  assertAvailableAgentEntryOrganization(options, discovery.organizations ?? []);
}

async function refreshReusedAgentEntryInventory(origin) {
  if (!options.agentEntry || options.organization === undefined) return;
  let response;
  try {
    response = await fetch(new URL("/api/lazurio/agent-entry-refresh", origin), {
      method: "POST",
      signal: AbortSignal.timeout(5_000),
    });
  } catch (cause) {
    const error = new Error(
      "LAZURIO_LAUNCHPAD_AGENT_ENTRY_REFRESH_FAILED: Reused Lazurio Server neobnovil Organization inventory.",
      { cause },
    );
    error.code = "LAZURIO_LAUNCHPAD_AGENT_ENTRY_REFRESH_FAILED";
    throw error;
  }
  if (!response.ok) {
    const error = new Error(
      `LAZURIO_LAUNCHPAD_AGENT_ENTRY_REFRESH_FAILED: Reused Lazurio Server neobnovil Organization inventory (HTTP ${response.status}).`,
    );
    error.code = "LAZURIO_LAUNCHPAD_AGENT_ENTRY_REFRESH_FAILED";
    throw error;
  }
  const result = await response.json().catch(() => null);
  if (
    result?.schema_version !== "lazurio.launchpad.agent_entry_inventory.v1"
    || !Array.isArray(result.organizations)
  ) {
    const error = new Error(
      "LAZURIO_LAUNCHPAD_AGENT_ENTRY_REFRESH_FAILED: Reused Lazurio Server vrátil neplatný Organization inventory.",
    );
    error.code = "LAZURIO_LAUNCHPAD_AGENT_ENTRY_REFRESH_FAILED";
    throw error;
  }
  assertAvailableAgentEntryOrganization(options, result.organizations ?? []);
}

async function withServerStateAccess(action) {
  try {
    return await action();
  } catch (error) {
    if (!["EACCES", "EPERM"].includes(error?.code)) throw error;
    const permissionError = new Error(
      `LAZURIO_SERVER_STATE_PERMISSION_REQUIRED: Lazurio Server potřebuje zápis do ${serverStateDirectory}. `
      + "Task Agent má pro tuto jedinou OS-standard state cestu vyžádat scoped oprávnění sandboxu a příkaz zopakovat; locator nepřesměrovávej jinam.",
      { cause: error },
    );
    permissionError.code = "LAZURIO_SERVER_STATE_PERMISSION_REQUIRED";
    throw permissionError;
  }
}
if (startupError) {
  await serverLifetimeLock?.release();
  if (String(startupError?.code ?? "").startsWith("LAZURIO_")) {
    console.error(startupError.message);
    process.exit(1);
  }
  throw startupError;
}
if (startResult.mode === "reused") {
  const action = options.open ? "otevírám existující instanci" : "používám existující instanci bez otevření systémového browseru";
  console.log(`${LAZURIO_LAUNCHPAD_NAME} už běží na ${startResult.url}; ${action}.`);
  printAgentEntryUrl(startResult.url);
  process.exit(0);
}
const server = startResult.server;
const serverUrl = `http://${host}:${server.port}`;

console.log(`${LAZURIO_LAUNCHPAD_NAME} běží na ${serverUrl}`);
console.log(`Lazurio Root: ${rootSourceRoot}`);
console.log(`${LAZURIO_LAUNCHPAD_NAME} locator: ${serverLocator.path}`);
if (worktreeMountContextReadOnly) {
  console.warn("[launchpad] linked worktree používá canonical Root pouze jako read-only mount context");
}
if (hostedWorkspace.profile === "hosted") {
  console.log(
    `[launchpad] hosted Team workspace scheduled ${hostedMaintenance.total} Module(s); ${hostedMaintenance.skipped.length} invalid Module(s) remain isolated`,
  );
} else {
  console.log("[launchpad] local session profile ready; Module processes start only on explicit action");
}
printAgentEntryUrl(serverUrl);

if (options.open) {
  await openBrowser(serverUrl);
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => requestProcessSignalShutdown(signal));
}

const hostedMaintenanceRefreshTimer = hostedWorkspace.profile === "hosted"
  ? setInterval(() => {
      if (serverShutdownState.state !== "running") return;
      void refreshHostedWorkspaceMaintenance().catch((error) => {
        console.warn(`[launchpad] hosted Team inventory refresh failed: ${error.message}`);
      });
    }, 15_000)
  : null;
setInterval(() => {}, 2_147_483_647);

function printAgentEntryUrl(origin) {
  if (!options.agentEntry) return;
  const url = launchpadEntryUrl(origin, {
    organization: options.organization ?? null,
    personalspace: Boolean(options.personalspace),
  });
  console.log(`LAZURIO_LAUNCHPAD_URL=${url}`);
}

async function buildAppsResponse({ force = false } = {}) {
  const { response } = await appsResponseCache.get({ force });
  return response;
}

async function buildAppsResponseUncached({ includeGit = false } = {}) {
  const response = await buildLaunchpadAppsResponse({
    companiesRoot,
    rootSourceRoot,
    launchpadRoot,
    runtimeManager,
    gitStatusService,
    includeGit,
    organization: hostedWorkspace.profile === "hosted" ? hostedWorkspace.organization_slug : null,
    activeTeamId: hostedWorkspace.profile === "hosted" ? hostedWorkspace.team_id : null,
  });
  if (hostedWorkspace.profile === "hosted" && serverShutdownState.state === "running") {
    syncHostedWorkspaceMaintenance(response);
  }
  response.apps = response.apps.map((app) => projectHostedAppUrl(app, hostedWorkspace));
  const nextLogoPaths = new Map();
  await Promise.all((response.organizations ?? []).map(async (organization) => {
    const [logoPath, theme] = await Promise.all([
      Promise.resolve(resolveOrganizationLogoPath(organization)),
      readOrganizationLaunchpadTheme({ companiesRoot, organization }),
    ]);
    if (logoPath) {
      organization.logo_url = `/api/organizations/${encodeURIComponent(organization.slug)}/logo`;
      nextLogoPaths.set(organization.slug, logoPath);
    }
    if (theme) organization.theme = theme;
  }));
  return { response, logoPaths: nextLogoPaths };
}

async function refreshHostedWorkspaceMaintenance({ warnSkipped = false } = {}) {
  const inventory = await buildLaunchpadAppsResponse({
    companiesRoot,
    rootSourceRoot,
    launchpadRoot,
    runtimeManager: { appsWithRuntime: async (apps) => apps },
    includeGit: false,
    organization: hostedWorkspace.organization_slug,
    activeTeamId: hostedWorkspace.team_id,
  });
  const result = syncHostedWorkspaceMaintenance(inventory);
  hostedMaintenance = result;
  if (warnSkipped) {
    for (const skipped of result.skipped) {
      console.warn(
        `[launchpad] hosted Module ${skipped.module} remains isolated: ${skipped.failure_kind}`,
      );
    }
  }
  return result;
}

function syncHostedWorkspaceMaintenance(inventory) {
  validateHostedWorkspaceBindings(hostedWorkspace, inventory);
  const selected = selectHostedWorkspaceApps(hostedWorkspace, inventory);
  const maintenance = runtimeManager.maintainApps(selected.apps);
  return { ...maintenance, skipped: selected.skipped };
}

function resolveOrganizationLogoPath(organization) {
  if (!organization?.path) return null;
  const organizationRoot = resolve(companiesRoot, organization.path);
  let realOrganizationRoot;
  try {
    realOrganizationRoot = realpathSync(organizationRoot);
  } catch {
    return null;
  }
  for (const candidate of organizationLogoCandidates) {
    const logoPath = resolve(organizationRoot, candidate);
    try {
      const logoStats = lstatSync(logoPath);
      if (!logoStats.isFile() || logoStats.isSymbolicLink() || logoStats.size > maxOrganizationLogoBytes) continue;
      const realLogoPath = realpathSync(logoPath);
      const relativePath = relative(realOrganizationRoot, realLogoPath);
      if (relativePath && !relativePath.startsWith("..") && !isAbsolute(relativePath)) {
        return realLogoPath;
      }
    } catch {
      // Chybějící nebo nečitelný asset není blokátor; zkus další kandidát.
    }
  }
  return null;
}

async function serveOrganizationLogo(request, url, slug) {
  if (!await requestTrust.isTrustedWorkspaceRequest(request, url)) {
    return jsonResponse({ error: "cross_origin_logo_request_forbidden" }, 403);
  }
  const logoPath = organizationLogoPaths.get(slug);
  if (!logoPath) return notFound();
  let logoFile;
  try {
    const logoStats = lstatSync(logoPath);
    if (!logoStats.isFile() || logoStats.isSymbolicLink()) return notFound();
    logoFile = await open(logoPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const openedStats = await logoFile.stat();
    if (!openedStats.isFile() || openedStats.size > maxOrganizationLogoBytes) return notFound();
    const logoBytes = await logoFile.readFile();
    return new Response(logoBytes, {
      headers: {
        "content-type": contentType(logoPath),
        "cache-control": "no-store",
        "content-security-policy": "sandbox",
        "cross-origin-resource-policy": "same-origin",
        "x-content-type-options": "nosniff",
      },
    });
  } catch {
    return notFound();
  } finally {
    await logoFile?.close();
  }
}

function isMutatingApiRequest(request, url) {
  return url.pathname.startsWith("/api/") && !safeApiMethods.has(request.method);
}

async function worktreeMutationTouchesCanonicalMount(url) {
  if (url.pathname === "/api/lazurio/agent-entry-refresh") return false;
  if (!worktreeMountContextReadOnly) return false;
  const route = appRuntimeRoute(url.pathname);
  if (!route) return true;
  const app = (await buildAppsResponse()).apps.find((item) => item.id === route.appId);
  return app?.[APP_FILESYSTEM_ROOT] !== rootSourceRoot;
}

async function buildDoctorReport() {
  // Personalspace doctor check je metadata-only a osobní aplikace se nikdy
  // nemíchají do org appsResponse (CAC-0048).
  const [appsEnvelope, personalspaceResponse] = await Promise.all([
    // Doctor je oddělená background lane, ne first paint: zachovává plný Git
    // census i tehdy, když /api/apps používá levný includeGit:false snapshot.
    buildAppsResponseUncached({ includeGit: true }),
    buildPersonalspace({ verifyRepositoryPrivacy: true }),
  ]);
  const appsResponse = appsEnvelope.response;
  // Podřízené doctory se svolávají i v HTTP lane (decision 0118). Kdyby je
  // spouštěl jen CLI doctor, ukazoval by Launchpad jinou zelenou než terminál —
  // a jedna z těch dvou odpovědí by byla o kontrolách, které nikdo nespustil.
  //
  // ZNÁMÉ OMEZENÍ: invokace potomka je `spawnSync`, takže po dobu jeho běhu
  // blokuje event loop. Je to stejný tvar, jaký tahle lane už dnes používá pro
  // `git` a `gh repo view` (bounded timeout), a náklad je nulový, dokud žádný
  // mount doctora nedeklaruje. Až první deklarace vznikne, patří sem
  // asynchronní varianta invokace — ne kratší timeout, protože rozdílný limit
  // v CLI a v UI by znamenal dvě různé odpovědi o téže mašině.
  const schema = loadRootDoctorSchema();
  const childLane = await runChildDoctorLane({
    companiesRoot,
    companiesConfig: await readLaunchpadRootConfig(),
    schema,
  });
  return buildDoctorReportFromAppsResponse(appsResponse, {
    extraChecks: [personalspaceDoctorCheck(personalspaceResponse)],
    childLane,
    schema,
  });
}

async function readLaunchpadRootConfig() {
  const configPath = join(rootSourceRoot, "launchpad.gen3.json");
  if (!existsSync(configPath)) return null;
  try {
    return JSON.parse(await readFile(configPath, "utf8"));
  } catch {
    // Rozbitý root config nesmí shodit celou doctor lane: mountpointy pak
    // spadnou na výchozí `organizations` / `personalspace` a rozbitý JSON
    // hlásí vlastní kontrola discovery.
    return null;
  }
}

async function buildPersonalspace({ verifyRepositoryPrivacy = false } = {}) {
  return buildPersonalspaceResponse({
    companiesRoot,
    rootSourceRoot,
    launchpadRoot,
    runtimeManager: personalspaceRuntimeManager,
    profileEmail: principalEmail,
    verifyRepositoryPrivacy,
  });
}

function resolvePrincipalEmail() {
  try {
    const gitExecutable = resolveGitExecutableSync();
    if (!gitExecutable) return null;
    const result = Bun.spawnSync([gitExecutable, "config", "user.email"], {
      cwd: rootSourceRoot,
      stdout: "pipe",
      stderr: "pipe",
      env: safeGitCommandEnv(),
      windowsHide: true,
      timeout: GIT_LOCAL_TIMEOUT_MS,
    });
    if (result.exitCode !== 0) return null;
    const email = new TextDecoder().decode(result.stdout).trim();
    return email.length > 0 ? email : null;
  } catch {
    return null;
  }
}

// Panel „Poslední změny" (CAC-0044, step-006): per-modul poslední commity.
// Read-only, bounded git log; staví nad discovery apps z /api/apps.
async function buildRecentChangesResponse(company = null) {
  const appsResponse = await buildAppsResponse();
  const apps = company ? appsResponse.apps.filter((app) => app.company === company) : appsResponse.apps;
  return buildRecentModuleChanges({ companiesRoot, apps });
}

// Notifikace (CAC-0095): nástupce panelu „Poslední změny" — jedna změna =
// jedna položka s actorem, scope a payloadem. Company filtr je stejný jako
// u ostatních panelů: notifikace nikdy nepřekročí vybranou Organizaci.
async function buildNotificationsResponse(company = null) {
  const appsResponse = await buildAppsResponse();
  const apps = company ? appsResponse.apps.filter((app) => app.company === company) : appsResponse.apps;
  return buildNotifications({ companiesRoot, apps });
}

// Panel „Nejčastější" (CAC-0044, step-007): lokální usage tracking mimo Git.
async function buildMostUsedResponse(company = null) {
  const appsResponse = await buildAppsResponse();
  const apps = company ? appsResponse.apps.filter((app) => app.company === company) : appsResponse.apps;
  return buildMostUsedApps({ launchpadRoot: launchpadStateRoot, apps });
}

async function serveStatic(pathname) {
  if (pathname === "/lazurio-runtime/deep-link-lib.mjs") {
    const runtimeAsset = join(lazurioCodeRoot, "lazurio", "runtime", "deep-link-lib.mjs");
    if (!existsSync(runtimeAsset)) return notFound();
    return new Response(await readFile(runtimeAsset), {
      headers: {
        "content-type": contentType(runtimeAsset),
        "cache-control": "no-store",
      },
    });
  }
  const requestedPath = pathname === "/" ? "index.html" : pathname.slice(1);
  const absolutePath = resolve(publicRoot, requestedPath);
  const relativePath = relative(publicRoot, absolutePath);
  if (relativePath.startsWith("..") || relativePath === "" || normalize(relativePath).startsWith("..")) {
    return notFound();
  }

  if (!existsSync(absolutePath)) return notFound();
  return new Response(await readFile(absolutePath), {
    headers: {
      "content-type": contentType(absolutePath),
      "cache-control": "no-store",
    },
  });
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function notFound() {
  return jsonResponse({ error: "not_found" }, 404);
}

function runtimeErrorResponse(error, { app = null, configuration = hostedWorkspace } = {}) {
  if (error instanceof HostedAppUrlError) {
    return jsonResponse({ error: error.code, message: error.message }, error.status);
  }
  if (error instanceof RuntimeActionError) {
    const payload = {
      error: error.code,
      message: error.message,
      details: error.details,
      ...error.metadata,
    };
    return jsonResponse(
      projectHostedRuntimePayload(payload, app, configuration),
      error.status,
    );
  }
  return jsonResponse({ error: "launchpad_error", message: error.message }, 500);
}

function apiErrorResponse(error) {
  if (error instanceof WorktreeActionError) {
    return jsonResponse({ error: error.code, message: error.message, details: error.details ?? [] }, error.status);
  }
  if (error instanceof GitApiError) {
    return jsonResponse({ error: error.code, message: error.message, ...(error.metadata ?? {}) }, error.status);
  }
  return jsonResponse({ error: "launchpad_error", message: error.message }, 500);
}

function contentType(path) {
  if (path.endsWith(".html")) return "text/html; charset=utf-8";
  if (path.endsWith(".css")) return "text/css; charset=utf-8";
  if (path.endsWith(".js") || path.endsWith(".mjs")) return "text/javascript; charset=utf-8";
  if (path.endsWith(".json")) return "application/json; charset=utf-8";
  if (path.endsWith(".svg")) return "image/svg+xml";
  if (path.endsWith(".png")) return "image/png";
  if (path.endsWith(".ico")) return "image/x-icon";
  return "application/octet-stream";
}

async function inspectRunningLaunchpad(url, expected) {
  const current = await probeServerIdentity(url, "/api/lazurio/server-identity");
  if (current.status === "absent") return current;
  if (current.status === "probe_failed") return current;
  if (current.status === "unrecognized") return current;
  if (current.status === "found") {
    const status = classifyServerIdentity({ observed: current.identity, expected });
    if (status === "compatible" && await probeServerReadiness(url) !== "ready") {
      return { status: "not_ready", identity: current.identity };
    }
    return { status, identity: current.identity };
  }

  const legacy = await probeServerIdentity(url, "/api/launchpad/identity");
  if (legacy.status === "probe_failed") return legacy;
  if (legacy.status === "found") {
    const status = classifyServerIdentity({ legacyObserved: legacy.identity, expected });
    return { status, identity: legacy.identity };
  }
  return { status: "unrecognized" };
}

async function probeServerReadiness(url) {
  try {
    const response = await fetch(new URL("/health", url), { signal: AbortSignal.timeout(1_500) });
    if (!response.ok) return "not_ready";
    const health = await response.json().catch(() => null);
    return health?.status === "ok" ? "ready" : "not_ready";
  } catch {
    return "not_ready";
  }
}

async function probeServerIdentity(url, pathname) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetch(new URL(pathname, url), { signal: AbortSignal.timeout(1_500) });
      if (response.status === 404) return { status: "missing" };
      if (!response.ok) return { status: "probe_failed" };
      const identity = await response.json().catch(() => null);
      return identity ? { status: "found", identity } : { status: "unrecognized" };
    } catch (error) {
      if (isConnectionRefused(error)) return { status: "absent" };
      if (attempt === 1 && await confirmLoopbackListenerAbsent(url)) return { status: "absent" };
      if (attempt === 1) return { status: "unrecognized" };
    }
  }
  return { status: "unrecognized" };
}

function isConnectionRefused(error) {
  let candidate = error;
  const visited = new Set();
  while (candidate && typeof candidate === "object" && !visited.has(candidate)) {
    visited.add(candidate);
    if (["ECONNREFUSED", "ConnectionRefused"].includes(candidate.code)) return true;
    candidate = candidate.cause;
  }
  return false;
}

async function confirmLoopbackListenerAbsent(origin) {
  const target = new URL(origin);
  return new Promise((resolveAbsent) => {
    const socket = createConnection({
      host: target.hostname,
      port: Number(target.port),
    });
    let settled = false;
    const finish = (absent) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolveAbsent(absent);
    };
    socket.setTimeout(500, () => finish(false));
    socket.once("connect", () => finish(false));
    socket.once("error", (error) => finish(isConnectionRefused(error)));
  });
}

async function requestStaleLaunchpadShutdown(url, observation) {
  const instanceId = observation?.identity?.instance_id;
  if (typeof instanceId !== "string") return false;
  try {
    const response = await fetch(new URL("/api/lazurio/server-shutdown", url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ instance_id: instanceId }),
      signal: AbortSignal.timeout(2_000),
    });
    if (!response.ok) return false;
    const result = await response.json().catch(() => null);
    return result?.stopping === true && result?.instance_id === instanceId;
  } catch {
    return false;
  }
}

function appRuntimeRoute(pathname) {
  const match = pathname.match(/^\/api\/apps\/([^/]+)\/(health|install|repair|start|switch|open|stop|restart|logs)$/);
  if (!match) return null;
  return {
    appId: decodeURIComponent(match[1]),
    action: match[2],
  };
}

function moduleFolderRoute(pathname) {
  return pathname === "/api/modules/open-folder";
}

async function handleModuleFolderRoute(request) {
  if (request.method !== "POST") return jsonResponse({ error: "method_not_allowed" }, 405);
  try {
    const contentType = request.headers.get("content-type") ?? "";
    if (!contentType.includes("application/json")) {
      throw new ModuleFolderActionError(400, "invalid_module_folder_request", "Request body musí být application/json.");
    }
    let payload;
    try {
      payload = await request.json();
    } catch {
      throw new ModuleFolderActionError(400, "invalid_module_folder_request", "Request body musí být validní JSON.");
    }
    return jsonResponse(await moduleFolderOpener.open({
      organization: payload?.organization,
      modulePath: payload?.module_path,
    }));
  } catch (error) {
    if (error instanceof ModuleFolderActionError) {
      return jsonResponse({ error: error.code, message: error.message }, error.status);
    }
    return jsonResponse({ error: "folder_open_failed", message: "Složku modulu se nepodařilo otevřít." }, 500);
  }
}

// Personalspace runtime akce (CAC-0048) — stejné akce jako org, ale přes
// oddělený personalspace runtime manager. Osobní app id má prefix personal--.
function personalAppRuntimeRoute(pathname) {
  const match = pathname.match(/^\/api\/personalspace\/apps\/([^/]+)\/(health|install|repair|start|stop|restart|logs|open)$/);
  if (!match) return null;
  return {
    appId: decodeURIComponent(match[1]),
    action: match[2],
  };
}

// Gbrain read-only browser API (CAC-0048) — BOUNDED na vault daného prostoru.
// Local-only (server běží jen na 127.0.0.1). Žádný obsah do logů.
function gbrainRoute(pathname) {
  const match = pathname.match(/^\/api\/personalspace\/([^/]+)\/gbrain\/(tree|note|search)$/);
  if (!match) return null;
  return {
    space: decodeURIComponent(match[1]),
    resource: match[2],
  };
}

function gbrainErrorResponse(error) {
  if (error instanceof GbrainAccessError) {
    return jsonResponse({ error: error.code, message: error.message }, error.status);
  }
  return jsonResponse({ error: "gbrain_error", message: error.message }, 500);
}

async function handleGbrainRoute(request, url, route) {
  if (request.method !== "GET") return jsonResponse({ error: "method_not_allowed" }, 405);
  try {
    const vault = await resolveSpaceGbrainVault({
      companiesRoot,
      rootSourceRoot,
      spaceDirName: route.space,
    });
    if (route.resource === "tree") {
      return jsonResponse({ space: route.space, source_rel: vault.source_rel, mode: vault.mode, ...(await gbrainTree(vault.vaultRoot)) });
    }
    if (route.resource === "note") {
      const path = url.searchParams.get("path");
      if (!path) return jsonResponse({ error: "missing_path", message: "Chybí parametr path." }, 400);
      return jsonResponse({ space: route.space, ...(await gbrainFile(vault.vaultRoot, path)) });
    }
    if (route.resource === "search") {
      const query = url.searchParams.get("q") ?? url.searchParams.get("query") ?? "";
      return jsonResponse({ space: route.space, ...(await gbrainSearch(vault.vaultRoot, query)) });
    }
    return notFound();
  } catch (error) {
    return gbrainErrorResponse(error);
  }
}

async function handlePersonalRuntimeRoute(request, route) {
  try {
    const runtimeOptions = request.method === "POST"
      ? await runtimeRequestOptions(request, {
          requireSource: explicitRuntimeSourceActions.has(route.action),
        })
      : {};
    if (route.action === "health" && (request.method === "GET" || request.method === "POST")) {
      return jsonResponse(await personalspaceRuntimeManager.health(route.appId, runtimeOptions));
    }
    if (route.action === "logs" && request.method === "GET") {
      return jsonResponse(await personalspaceRuntimeManager.logs(route.appId));
    }
    if ((route.action === "install" || route.action === "repair") && request.method === "POST") {
      return jsonResponse(await personalspaceRuntimeManager.install(route.appId, { action: route.action, ...runtimeOptions }));
    }
    if (route.action === "start" && request.method === "POST") {
      return jsonResponse(await personalspaceRuntimeManager.start(route.appId, runtimeOptions));
    }
    // One-click open chain (ensure install → ensure start → wait healthy → URL)
    // v oddělené personalspace lane — GEN2-minimal dlaždice ho volá klikem na
    // celou kartu (stejný kontrakt jako firemní /api/apps/<id>/open).
    if (route.action === "open" && request.method === "POST") {
      return jsonResponse(await personalspaceRuntimeManager.open(route.appId, runtimeOptions));
    }
    if (route.action === "stop" && request.method === "POST") {
      return jsonResponse(await personalspaceRuntimeManager.stop(route.appId, runtimeOptions));
    }
    if (route.action === "restart" && request.method === "POST") {
      return jsonResponse(await personalspaceRuntimeManager.restart(route.appId, runtimeOptions));
    }
    return jsonResponse({ error: "method_not_allowed" }, 405);
  } catch (error) {
    return runtimeErrorResponse(error);
  }
}

function gitApiRoute(pathname) {
  if (pathname === "/api/git/repos") return { kind: "repos" };
  if (pathname === "/api/git/pull-all") return { kind: "pull_all" };
  if (pathname === "/api/git/worktrees") return { kind: "worktrees" };
  if (pathname === "/api/mission-control/plans") return { kind: "plans" };
  const createWorktreeMatch = pathname.match(/^\/api\/git\/repos\/([^/]+)\/worktrees\/create$/);
  if (createWorktreeMatch) return { kind: "create_worktree", repoKey: decodeURIComponent(createWorktreeMatch[1]) };
  const publishWorktreeMatch = pathname.match(/^\/api\/git\/repos\/([^/]+)\/worktrees\/([^/]+)\/publish$/);
  if (publishWorktreeMatch) {
    return {
      kind: "publish_worktree",
      repoKey: decodeURIComponent(publishWorktreeMatch[1]),
      slug: decodeURIComponent(publishWorktreeMatch[2]),
    };
  }
  const changesMatch = pathname.match(/^\/api\/git\/repos\/([^/]+)\/changes$/);
  if (changesMatch) return { kind: "repo_changes", repoKey: decodeURIComponent(changesMatch[1]) };
  const autostashPullMatch = pathname.match(/^\/api\/git\/repos\/([^/]+)\/pull-autostash$/);
  if (autostashPullMatch) return { kind: "repo_autostash_pull", repoKey: decodeURIComponent(autostashPullMatch[1]) };
  const pullMatch = pathname.match(/^\/api\/git\/repos\/([^/]+)\/pull$/);
  if (pullMatch) return { kind: "repo_pull", repoKey: decodeURIComponent(pullMatch[1]) };
  const repoMatch = pathname.match(/^\/api\/git\/repos\/([^/]+)$/);
  if (repoMatch) return { kind: "repo", repoKey: decodeURIComponent(repoMatch[1]) };
  return null;
}

async function handleGitApiRoute(request, url, route) {
  try {
    if (route.kind === "create_worktree") {
      if (request.method !== "POST") return jsonResponse({ error: "method_not_allowed" }, 405);
      const payload = await jsonRequestPayload(request, "worktree_create_request");
      return jsonResponse(await appsResponseCache.runMutation(() =>
        createWorktreeFromPlan({
          companiesRoot,
          repoKey: route.repoKey,
          planPath: payload.planPath,
          branch: payload.branch,
          createdBy: payload.createdBy,
          conversationOrigin: payload.conversationOrigin,
          recoveryHandoff: payload.recoveryHandoff,
        })));
    }
    if (route.kind === "publish_worktree") {
      if (request.method !== "POST") return jsonResponse({ error: "method_not_allowed" }, 405);
      const payload = await jsonRequestPayload(request, "worktree_publish_request");
      return jsonResponse(await appsResponseCache.runMutation(() =>
        publishWorktreeDraft({
          companiesRoot,
          repoKey: route.repoKey,
          slug: route.slug,
          commitMessage: payload.commitMessage,
          publisher: payload.publisher,
          conversationOrigin: payload.conversationOrigin,
        })));
    }
    if (route.kind === "repo_pull") {
      if (request.method !== "POST") return jsonResponse({ error: "method_not_allowed" }, 405);
      return jsonResponse(await appsResponseCache.runMutation(() =>
        gitStatusService.withRemoteRefreshPaused(() =>
          runWorkspaceUpdate())));
    }
    if (route.kind === "repo_autostash_pull") {
      if (request.method !== "POST") return jsonResponse({ error: "method_not_allowed" }, 405);
      return jsonResponse(await appsResponseCache.runMutation(() =>
        gitStatusService.withRemoteRefreshPaused(() =>
          runWorkspaceUpdate())));
    }
    if (route.kind === "pull_all") {
      if (request.method !== "POST") return jsonResponse({ error: "method_not_allowed" }, 405);
      return jsonResponse(await appsResponseCache.runMutation(() =>
        gitStatusService.withRemoteRefreshPaused(() =>
          runWorkspaceUpdate())));
    }
    if (request.method !== "GET") return jsonResponse({ error: "method_not_allowed" }, 405);
    if (route.kind === "repos") {
      const allowRemoteRefresh = !worktreeMountContextReadOnly;
      return jsonResponse(await buildGitApiResponse({
        companiesRoot,
        organization: url.searchParams.get("company"),
        refresh: allowRemoteRefresh && url.searchParams.get("refresh") === "1",
        statusService: gitStatusService,
        allowRemoteRefresh,
      }));
    }
    if (route.kind === "repo") {
      const allowRemoteRefresh = !worktreeMountContextReadOnly;
      return jsonResponse(
        await buildRepoResponse({
          companiesRoot,
          repoKey: route.repoKey,
          refresh: allowRemoteRefresh && url.searchParams.get("refresh") === "1",
          statusService: gitStatusService,
          allowRemoteRefresh,
        }),
      );
    }
    if (route.kind === "repo_changes") {
      return jsonResponse(await buildRepoChangesResponse({ companiesRoot, repoKey: route.repoKey }));
    }
    if (route.kind === "worktrees") {
      return jsonResponse(
        await buildWorktreesResponse({
          companiesRoot,
          organization: url.searchParams.get("organization"),
          module: url.searchParams.get("module"),
        }),
      );
    }
    if (route.kind === "plans") {
      return jsonResponse(
        await buildPlansResponse({
          companiesRoot,
          organization: url.searchParams.get("organization"),
          module: url.searchParams.get("module"),
        }),
      );
    }
    return notFound();
  } catch (error) {
    return apiErrorResponse(error);
  }
}

async function jsonRequestPayload(request, code) {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    throw new WorktreeActionError("Request body musí být application/json.", { status: 400, code: `invalid_${code}` });
  }
  const text = await request.text();
  try {
    const payload = JSON.parse(text || "{}");
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("payload must be object");
    return payload;
  } catch {
    throw new WorktreeActionError("Request body musí být validní JSON object.", { status: 400, code: `invalid_${code}` });
  }
}

async function handleRuntimeRoute(request, route) {
  let hostedProjectionApp = null;
  try {
    const runtimeOptions = request.method === "POST"
      ? await runtimeRequestOptions(request, {
          requireSource: hostedWorkspace.profile === "local" && explicitRuntimeSourceActions.has(route.action),
        })
      : {};
    hostedProjectionApp = hostedWorkspace.profile === "hosted"
      ? (await buildAppsResponse()).apps.find((app) => app.id === route.appId) ?? null
      : { id: route.appId };
    if (hostedWorkspace.profile === "hosted" && !hostedProjectionApp) {
      throw new RuntimeActionError(
        404,
        "app_not_found",
        "Aplikace není dostupná v aktivním Team Workspace.",
      );
    }
    if (route.action === "health" && (request.method === "GET" || request.method === "POST")) {
      return jsonResponse(projectHostedRuntimePayload(
        await runtimeManager.health(route.appId, runtimeOptions),
        hostedProjectionApp,
        hostedWorkspace,
      ));
    }
    if (route.action === "logs" && request.method === "GET") {
      return jsonResponse(await runtimeManager.logs(route.appId, runtimeOptions));
    }
    if ((route.action === "install" || route.action === "repair") && request.method === "POST") {
      return jsonResponse(projectHostedRuntimePayload(
        await appsResponseCache.runMutation(() =>
          runtimeManager.install(route.appId, { action: route.action, ...runtimeOptions })),
        hostedProjectionApp,
        hostedWorkspace,
      ));
    }
    if (route.action === "start" && request.method === "POST") {
      return jsonResponse(projectHostedRuntimePayload(
        await appsResponseCache.runMutation(() => runtimeManager.start(route.appId, runtimeOptions)),
        hostedProjectionApp,
        hostedWorkspace,
      ));
    }
    if (route.action === "switch" && request.method === "POST") {
      return jsonResponse(projectHostedRuntimePayload(
        await appsResponseCache.runMutation(() => runtimeManager.switchApp(route.appId, runtimeOptions)),
        hostedProjectionApp,
        hostedWorkspace,
      ));
    }
    // One-click builder chain (CAC-0044): ensure install → ensure start → URL.
    if (route.action === "open" && request.method === "POST") {
      if (hostedProjectionApp) requireHostedAppUrl(hostedProjectionApp, hostedWorkspace);
      return jsonResponse(projectHostedRuntimePayload(
        await appsResponseCache.runMutation(() => runtimeManager.open(route.appId, runtimeOptions)),
        hostedProjectionApp,
        hostedWorkspace,
      ));
    }
    if (route.action === "stop" && request.method === "POST") {
      return jsonResponse(projectHostedRuntimePayload(
        await appsResponseCache.runMutation(() => runtimeManager.stop(route.appId, runtimeOptions)),
        hostedProjectionApp,
        hostedWorkspace,
      ));
    }
    if (route.action === "restart" && request.method === "POST") {
      return jsonResponse(projectHostedRuntimePayload(
        await appsResponseCache.runMutation(() => runtimeManager.restart(route.appId, runtimeOptions)),
        hostedProjectionApp,
        hostedWorkspace,
      ));
    }
    return jsonResponse({ error: "method_not_allowed" }, 405);
  } catch (error) {
    return runtimeErrorResponse(error, { app: hostedProjectionApp, configuration: hostedWorkspace });
  }
}

async function runtimeRequestOptions(request, { requireSource = false } = {}) {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    if (requireSource) throw runtimeSourceRequiredError();
    return {};
  }
  const text = await request.text();
  if (!text.trim()) {
    if (requireSource) throw runtimeSourceRequiredError();
    return {};
  }
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new RuntimeActionError(400, "invalid_runtime_request", "Runtime request body musí být validní JSON.");
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new RuntimeActionError(400, "invalid_runtime_request", "Runtime request body musí být JSON object.");
  }
  if (requireSource && !payload.source) throw runtimeSourceRequiredError();
  return {
    ...(payload.source ? { source: payload.source } : {}),
    ...(typeof payload.replace_app_id === "string" ? { replace_app_id: payload.replace_app_id } : {}),
    ...(payload.confirmed === true ? { confirmed: true } : {}),
  };
}

function runtimeSourceRequiredError() {
  return new RuntimeActionError(
    400,
    "runtime_source_required",
    "Lokální runtime akce musí explicitně určit zdroj main nebo konkrétní worktree.",
  );
}

async function handleServerShutdown(request) {
  const payload = await request.json().catch(() => null);
  if (!payload || payload.instance_id !== launchpadServerIdentity.instance_id) {
    return jsonResponse({
      error: "server_instance_mismatch",
      message: "Server shutdown musí potvrdit přesnou běžící instanci.",
    }, 409);
  }
  const shutdown = serverShutdownState.requestShutdown();
  if (!shutdown.accepted && shutdown.reason === "shutdown_in_progress") {
    return jsonResponse({
      error: "server_shutdown_in_progress",
      message: "Lazurio Server už se zastavuje.",
    }, 409);
  }
  if (!shutdown.accepted) {
    return jsonResponse({
      error: "server_busy",
      message: "Lazurio Server právě dokončuje mutující operaci; shutdown opakuj po jejím skončení.",
    }, 409);
  }

  setTimeout(() => void beginServerShutdownCleanup(), 50);
  return jsonResponse({
    schema_version: "lazurio.server.shutdown.v1",
    instance_id: launchpadServerIdentity.instance_id,
    stopping: true,
  });
}

let serverShutdownCleanupPromise = null;
function beginServerShutdownCleanup() {
  serverShutdownCleanupPromise ??= completeServerShutdown();
  return serverShutdownCleanupPromise;
}

async function completeServerShutdown() {
  console.error(`[lazurio] stopping Server instance ${launchpadServerIdentity.instance_id}\n`);
  if (hostedMaintenanceRefreshTimer) clearInterval(hostedMaintenanceRefreshTimer);
  let failed = false;
  try {
    await server.stop(true);
  } catch (error) {
    failed = true;
    console.error(`[lazurio] Server listener cleanup failed: ${error.message}`);
  }
  for (const [label, manager] of [
    ["Organization", runtimeManager],
    ["Personalspace", personalspaceRuntimeManager],
  ]) {
    try {
      const stopped = await manager.shutdown();
      if (stopped.failed > 0) {
        failed = true;
        console.error(`[lazurio] ${label} child cleanup failed for ${stopped.failed} runtime(s)`);
      }
    } catch (error) {
      failed = true;
      console.error(`[lazurio] ${label} child cleanup failed: ${error.message}`);
    }
  }
  try {
    await withServerStateAccess(() => removeServerLocatorIfOwned({
      stateDirectory: serverStateDirectory,
      instanceId: launchpadServerIdentity.instance_id,
    }));
  } catch (error) {
    failed = true;
    console.error(`[lazurio] Server locator cleanup failed: ${error.message}`);
  }
  try {
    await serverLifetimeLock?.release();
  } catch (error) {
    failed = true;
    console.error(`[lazurio] Server lifetime lease cleanup failed: ${error.message}`);
  }
  process.exit(failed ? 1 : 0);
}

let processSignalShutdownPending = false;
function requestProcessSignalShutdown(signal) {
  if (processSignalShutdownPending) {
    if (serverShutdownState.state !== "stopping") {
      const forced = serverShutdownState.forceShutdown();
      console.error(`[lazurio] second ${signal} forced Server shutdown with ${forced.interruptedMutations ?? 0} active mutation(s)`);
      void beginServerShutdownCleanup();
    }
    return;
  }
  if (serverShutdownState.state === "stopping") return;
  processSignalShutdownPending = true;
  const drain = serverShutdownState.beginShutdownDrain();
  if (!drain.accepted) return;
  console.error(`[lazurio] ${signal} requested Server shutdown; draining ${drain.activeMutations} active mutation(s)`);
  const requestWhenIdle = () => {
    if (serverShutdownState.state === "stopping") return;
    const shutdown = serverShutdownState.finishShutdownDrain();
    if (shutdown.accepted) {
      console.error(`[lazurio] ${signal} drain complete; stopping Server`);
      void beginServerShutdownCleanup();
      return;
    }
    if (shutdown.reason === "server_busy") {
      setTimeout(requestWhenIdle, 50);
    }
  };
  requestWhenIdle();
}

function startServer(startPort) {
  return Bun.serve({
    hostname: host,
    port: startPort,
    idleTimeout: 120,
    async fetch(request) {
      const url = new URL(request.url);
      let workspaceTrustDecision;
      const evaluateWorkspaceRequest = () => {
        workspaceTrustDecision ??= requestTrust.evaluateWorkspaceRequest(request, url);
        return workspaceTrustDecision;
      };
      let mutationAdmission = null;
      try {
        if (url.pathname.startsWith("/api/personalspace") && !requestTrust.isTrustedLocalRequest(request, url)) {
          return jsonResponse({ error: "personalspace_request_forbidden" }, 403);
        }
        if (url.pathname === "/api/lazurio/server-shutdown" && request.method === "POST") {
          if (!requestTrust.isTrustedLocalRequest(request, url)) {
            return jsonResponse({ error: "server_shutdown_forbidden" }, 403);
          }
          return handleServerShutdown(request);
        }
        if (isMutatingApiRequest(request, url)) {
          const trustDecision = await evaluateWorkspaceRequest();
          if (!trustDecision.trusted) {
            console.warn(`[lazurio] mutating request rejected: ${trustDecision.reason}`);
            return jsonResponse({ error: "mutating_request_forbidden" }, 403);
          }
          if (await worktreeMutationTouchesCanonicalMount(url)) {
            return jsonResponse({
              error: "worktree_mount_context_read_only",
              message: "Linked worktree smí canonical Lazurio Root používat jen jako read-only mount context.",
            }, 409);
          }
        }
        if (moduleFolderRoute(url.pathname) && !requestTrust.isTrustedLocalRequest(request, url)) {
          return jsonResponse({ error: "module_folder_request_forbidden" }, 403);
        }
        if (isMutatingApiRequest(request, url)) {
          mutationAdmission = serverShutdownState.enterMutation();
          if (!mutationAdmission.accepted) {
            return jsonResponse({ error: "server_shutdown_in_progress" }, 503);
          }
        }
        if (url.pathname === "/api/lazurio/agent-entry-refresh") {
          if (!requestTrust.isTrustedLocalRequest(request, url)) {
            return jsonResponse({ error: "agent_entry_refresh_forbidden" }, 403);
          }
          if (request.method !== "POST") return jsonResponse({ error: "method_not_allowed" }, 405);
          const { response } = await appsResponseCache.refreshPublished();
          return jsonResponse({
            schema_version: "lazurio.launchpad.agent_entry_inventory.v1",
            organizations: (response.organizations ?? []).map(({ slug }) => ({ slug })),
          });
        }
        // Personalspace lane (CAC-0048) — kontroluj PŘED generickými /api/apps
        // a /api/... routami, ať se osobní prostor nikdy nesmíchá s org lane.
        const personalRuntimeRoute = personalAppRuntimeRoute(url.pathname);
        // Keep the response inside this try/finally until the routed operation
        // actually settles. Returning a bare Promise would run finally early
        // and let control-root replacement observe a false zero-mutation drain.
        if (personalRuntimeRoute) return await handlePersonalRuntimeRoute(request, personalRuntimeRoute);
        const gbrainMatch = gbrainRoute(url.pathname);
        if (gbrainMatch) return await handleGbrainRoute(request, url, gbrainMatch);
        if (url.pathname === "/api/personalspace") return jsonResponse(await buildPersonalspace());
        const organizationLogoMatch = url.pathname.match(/^\/api\/organizations\/([^/]+)\/logo$/);
        if (organizationLogoMatch) {
          return await serveOrganizationLogo(request, url, decodeURIComponent(organizationLogoMatch[1]));
        }

        const runtimeRoute = appRuntimeRoute(url.pathname);
        if (runtimeRoute) return await handleRuntimeRoute(request, runtimeRoute);
        if (moduleFolderRoute(url.pathname)) return await handleModuleFolderRoute(request);
        const gitRoute = gitApiRoute(url.pathname);
        if (gitRoute) return await handleGitApiRoute(request, url, gitRoute);
        if (url.pathname === "/api/lazurio/server-identity" && request.method === "GET") {
          if (!requestTrust.isTrustedLocalRequest(request, url)) {
            return jsonResponse({ error: "identity_request_forbidden" }, 403);
          }
          return jsonResponse(launchpadServerIdentity);
        }
        // Root identity is metadata-only and local. Relaunch uses the hashed
        // canonical root to avoid opening another Organization/Personalspace
        // instance that happens to own the same port.
        if (url.pathname === "/api/launchpad/identity" && request.method === "GET") {
          if (!requestTrust.isTrustedLocalRequest(request, url)) {
            return jsonResponse({ error: "identity_request_forbidden" }, 403);
          }
          return jsonResponse({
            schema_version: "companiesascode.launchpad.identity.v1",
            root_id: launchpadRootId,
          });
        }
        // GET je čistě lokální snapshot: žádný fetch, credentials ani mutace.
        // Teprve explicitní POST prochází společným mutation trust gatem výš.
        if (url.pathname === "/api/update/status" && request.method === "GET") {
          return jsonResponse(await readLazurioUpdateStatus({ rootPath: companiesRoot }));
        }
        if (url.pathname === "/api/update" && request.method === "POST") {
          const result = await appsResponseCache.runMutation(() =>
            gitStatusService.withRemoteRefreshPaused(() =>
              runWorkspaceUpdate()));
          return jsonResponse(result);
        }
        if (url.pathname === "/api/apps") return jsonResponse(await buildAppsResponse());
        // Jediná explicitní Sync mutace: tentýž engine jako `lazurio update`,
        // potom čerstvá lokální projekce pro UI. Onboarding nových Organization
        // rootů podle GitHub grantů zůstává samostatná access Sync lane.
        if (url.pathname === "/api/sync" && request.method === "POST") {
          const update = await appsResponseCache.runMutation(() =>
            gitStatusService.withRemoteRefreshPaused(() =>
              runWorkspaceUpdate()));
          const response = await buildAppsResponse({ force: true });
          return jsonResponse({
            ...response,
            action: "sync",
            synced_at: response.generated_at,
            update,
          });
        }
        if (url.pathname === "/api/doctor") return jsonResponse(await buildDoctorReport());
        if (url.pathname === "/api/recent-changes") return jsonResponse(await buildRecentChangesResponse(url.searchParams.get("company")));
        if (url.pathname === "/api/notifications") return jsonResponse(await buildNotificationsResponse(url.searchParams.get("company")));
        if (url.pathname === "/api/most-used") return jsonResponse(await buildMostUsedResponse(url.searchParams.get("company")));
        if (url.pathname === "/health") {
          const maintenance = hostedWorkspace.profile === "hosted"
            ? runtimeManager.maintenanceSummary()
            : null;
          return serverShutdownState.state === "running"
            ? jsonResponse({
                status: "ok",
                ...(maintenance
                  ? {
                      maintenance: {
                        schema_version: maintenance.schema_version,
                        total: maintenance.total,
                        healthy: maintenance.healthy,
                        starting: maintenance.starting,
                        degraded: maintenance.degraded,
                        skipped: hostedMaintenance?.skipped?.length ?? 0,
                      },
                    }
                  : {}),
              })
            : jsonResponse({ status: serverShutdownState.state }, 503);
        }
        return await serveStatic(url.pathname);
      } catch (error) {
        return jsonResponse({ error: "launchpad_error", message: error.message }, 500);
      } finally {
        mutationAdmission?.release?.();
      }
    },
  });
}
