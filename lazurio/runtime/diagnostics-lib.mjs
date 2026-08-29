import { existsSync } from "fs";
import { readFile, readdir } from "fs/promises";
import { basename, dirname, join, posix } from "path";
import {
  discoverLaunchpadApps,
  organizationRelativePathIssue,
  readJson,
} from "./discovery-lib.mjs";
import { buildGitApiResponse, compactGitSummaryForApp } from "./git-api-lib.mjs";
import { inspectRequiredDependencies } from "./dependency-install-lib.mjs";
import {
  createRuntimeManager,
  resolveBunExecutable,
  runtimeListenerHasStaticLease,
  runtimeUrlHost,
} from "./runtime-lib.mjs";
import { buildWorktreeIndex } from "./worktree-lib.mjs";
import {
  GIT_LOCAL_TIMEOUT_MS,
  resolveGitExecutableSync,
  safeGitCommandEnv,
} from "./git-lib.mjs";
import { agentSkillsEntrypointsDoctorCheck } from "./agent-skills-entrypoint-lib.mjs";
import { runChildDoctorLane } from "./doctor-children-lib.mjs";
import {
  DOCTOR_REPORT_SCHEMA_VERSION_V3,
  buildAggregateReport,
  buildSummary,
  flattenChecks,
  loadDoctorReportSchema,
  validateDoctorReport,
} from "./doctor-surface-lib.mjs";
import {
  isCanonicalOrganizationRepositorySlotPath,
  isOrganizationRootSlotDescendantPath,
  isOrganizationRootSlotPath,
  isOrganizationSlotContainerPath,
  normalizeOrganizationSlotPath,
  organizationRepositorySlotCollectionIssues,
  organizationSlotCatalogPresentation,
  organizationSlotPathScope,
  organizationSlotProjectsToLocalMachine,
  organizationSlotRepositoryBranch,
  organizationSlotRepositoryId,
  organizationSlotRepositoryRemote,
  organizationSlotScope,
  organizationSlotTeams,
  organizationSlotWorkspace,
} from "../core/organization-slot-scope-lib.mjs";
import {
  normalizeModuleManifest,
  resolveModuleApplications,
} from "../core/module-contract-lib.mjs";
import {
  classifyBunRuntime,
  readRequiredBunVersion,
} from "../core/toolchain-lib.mjs";
import {
  DEVELOPER_TOOL_UPDATE_POLICY,
  inspectDeveloperToolUpdates,
} from "../core/tool-update-lib.mjs";
import { inspectDirectoryWithinCanonicalBoundary } from "../core/path-boundary-lib.mjs";
import { readOrganizationRoot } from "../core/organization-root-reader-lib.mjs";

const supportedPlatforms = {
  darwin: "macOS",
  win32: "Windows",
  linux: "Linux",
};

const rootGitignoreProbePaths = [
  "launchpad/runtime/probe.json",
  "launchpad/logs/probe.log",
  "logs/probe.log",
];

const companyGitignoreProbePaths = [
  "company/colleagues/example/private/probe.txt",
  "company/colleagues/example/archive/probe.txt",
  "company/colleagues/example/archiv/probe.txt",
];

const worktreePackageLockfileNames = ["bun.lock", "bun.lockb", "package-lock.json", "pnpm-lock.yaml", "yarn.lock"];
const worktreeSupportedPackageManagers = new Set(["bun"]);

let cachedDoctorReportSchema = null;

export async function buildLaunchpadAppsResponse({
  companiesRoot = join(import.meta.dirname, "..", ".."),
  rootSourceRoot = companiesRoot,
  launchpadRoot = join(companiesRoot, "launchpad"),
  runtimeManager = createRuntimeManager({ companiesRoot, launchpadRoot }),
  gitStatusService = null,
  allowMissingOrganizations = false,
  includeGit = true,
  organization = null,
  activeTeamId = null,
  includePrivateDiagnostics = false,
} = {}) {
  const discovery = await discoverLaunchpadApps(rootSourceRoot, {
    allowMissingOrganizations,
    organization,
    organization_mount_root: companiesRoot,
    machine_context_root: companiesRoot,
  });
  const companiesConfig = await readCompaniesConfig(rootSourceRoot);
  const organizationSpaces = Array.isArray(discovery.organizations)
    ? await Promise.all(
        discovery.organizations.map(async (organization) => ({
          organization,
          spaces: await readOrganizationSpaces(
            companiesRoot,
            organization,
            discovery.local_config,
            (discovery.organization_issues ?? []).filter(
              (issue) => issue.organization === organization.slug,
            ),
            activeTeamId,
          ),
        })),
      )
    : [];
  const organizations = organizationSpaces.map(({ organization, spaces }) => {
    // module_declarations je interní resolver plumbing, ne API kontrakt.
    const { module_declarations, ...allSpaces } = spaces;
    const diagnosticSpaces = includePrivateDiagnostics
      ? allSpaces
      : projectOrganizationDiagnostics(allSpaces, module_declarations);
    const publicSpaces = projectActiveTeamSpaces(diagnosticSpaces, activeTeamId);
    const publicOrganization = {
      slug: organization.slug,
      display_name: organization.display_name,
      path: organization.path,
      repository: organization.repository ?? null,
      git_url: organization.git_url ?? null,
      default_branch: organization.default_branch ?? "main",
      module_port_pool: organization.module_port_pool ?? null,
      generation: organization.generation ?? null,
      migration_marker: organization.migration_marker ?? null,
      materialization: organization.materialization ?? null,
      // Kanonický klíč organization_type; workspace_type je deprecated GEN2 alias.
      organization_type: organization.organization_type ?? organization.workspace_type ?? null,
      // mounted (default) | planned — planned Organizace ještě nemá mount (decision 0024).
      status: organization.status ?? "mounted",
      discovery_source: organization.discovery_source ?? "registry",
      // GEN3 organization model: Organization-root modules, flat Workspace
      // modules grouped N:M by Team, and a read-only Productionspace boundary.
      ...publicSpaces,
    };
    // Doctor potřebuje i vnořené deklarace, které nejsou UI dlaždice.
    // Non-enumerable vlastnost zůstane v interním read modelu pro Doctor, ale
    // neunikne do JSON /api/apps kontraktu.
    Object.defineProperty(publicOrganization, "module_declarations", {
      value: module_declarations,
      enumerable: false,
    });
    return publicOrganization;
  });
  const companies = organizations;
  // Module šablony jsou informační sken templates/<owner>/<template> (scan-first,
  // decision 0042) — ne registry a ne vynucený Git mount. Doctor je jen ukazuje;
  // nepřítomnost je prostě prázdný seznam, nikdy failure.
  const templates = (discovery.module_templates ?? []).map((template) => ({
    slug: template.slug,
    owner: template.owner ?? null,
    path: template.path,
    discovery_source: template.discovery_source ?? "filesystem",
  }));
  const companyNames = new Map(companies.map((company) => [company.slug, company.display_name]));
  // Physical Organization-relative path is the authority for the top-level
  // Organization / Workspace / Productionspace section. Manifest declarations
  // enrich Workspace apps with their N:M Team intent; they never move an app
  // across a physical boundary or grant live access.
  const placementResolvers = new Map(
    organizationSpaces.map(({ organization, spaces }) => [
      organization.path,
      appPlacementResolverForOrganization({
        path: organization.path,
        module_declarations: spaces.module_declarations,
        teams: spaces.teams,
      }),
    ]),
  );
  const apps = await runtimeManager.appsWithRuntime(discovery.apps.map((app) => {
    const protocol = app.entrypoint_listener?.protocol === "https" ? "https" : "http";
    const hasEndpoint = typeof app.host === "string" && Number.isInteger(app.port);
    return {
      ...app,
      company_display_name: companyNames.get(app.company) ?? app.company,
      ...appPlacementFor(placementResolvers, app),
      url: hasEndpoint ? `${protocol}://${runtimeUrlHost(app.host)}:${app.port}` : null,
      health_url: hasEndpoint ? `${protocol}://${runtimeUrlHost(app.host)}:${app.port}${app.health_path}` : null,
    };
  }));
  const invalidApps = (discovery.invalid_apps ?? []).map((app) => ({
    ...app,
    company_display_name: companyNames.get(app.company) ?? app.company,
    ...appPlacementFor(placementResolvers, app),
    url: null,
    health_url: null,
    dependencies: {
      state: "invalid_manifest",
      message: `Manifest aplikace není validní: ${app.manifest_issues.join("; ")}`,
      can_start: false,
      can_install: false,
    },
    dependency_status: "invalid_manifest",
    runtime: {
      status: "stopped",
      message: "Aplikace s nevalidním runtime manifestem se nespouští; oprav lazurio.runtime nebo read-compatible legacy manifest.",
    },
    runtime_status: "stopped",
  }));
  const visibleApps = [...apps, ...invalidApps];
  await attachModuleApplicationProjections({
    companiesRoot,
    organizations,
    apps: visibleApps,
  });
  const gitContext = includeGit
    ? await buildGitContext({ companiesRoot, gitStatusService })
    : { reposByKey: new Map(), warnings: [] };
  const appsWithGit = includeGit
    ? visibleApps.map((app) => ({
        ...app,
        git: compactGitSummaryForApp(gitContext.reposByKey.get(gitRepoKeyForApp(app))),
      }))
    : visibleApps;
  const publicApps = appsWithGit
    .filter((app) => appVisibleForActiveTeam(app, activeTeamId))
    .map((app) => projectActiveTeamApp(app, activeTeamId));
  // Template mounty (organization_kind=template) jsou validované, ale vyloučené z
  // runtime akcí, business přehledů i org počtů. Drží se v oddělených polích, aby
  // je žádný konzument organizations/apps nezapočítal; Doctor je jen označí.
  const templateMounts = (discovery.template_mounts ?? []).map((mount) => ({
    slug: mount.slug,
    display_name: mount.display_name ?? mount.slug,
    path: mount.path,
    organization_kind: "template",
    organization_type: mount.organization_type ?? "organization-template",
    // Status se musí zachovat: planned template slot (decision 0024) ještě nemá
    // mount a Git mount gate ho musí přeskočit stejně jako u planned Organizace.
    status: mount.status ?? "mounted",
    discovery_source: mount.discovery_source ?? "registry",
  }));
  const templateApps = discovery.template_apps ?? [];
  const hiddenProtectedPaths = organizationSpaces.flatMap(({ spaces }) =>
    (spaces.module_declarations ?? [])
      .filter((slot) => !organizationSlotProjectsToLocalMachine(slot))
      .map((slot) => slot.path),
  );
  const discoveryFailures = includePrivateDiagnostics
    ? discovery.failures
    : projectDiagnosticMessages(discovery.failures, hiddenProtectedPaths);
  const discoveryWarnings = includePrivateDiagnostics
    ? (discovery.warnings ?? [])
    : projectDiagnosticMessages(discovery.warnings, hiddenProtectedPaths);

  return {
    schema_version: "companiesascode.launchpad.apps.v1",
    generated_at: new Date().toISOString(),
    launchpad_root: workspaceSummary(companiesConfig),
    companies_workspace: workspaceSummary(companiesConfig),
    // `root` remains the base for every Organization, Personalspace and
    // package path in this response. A selected linked worktree controls only
    // tracked Root source/config and is exposed separately, so consumers never
    // resolve canonical mount paths against an empty worktree mount folder.
    root: companiesRoot,
    control_root: rootSourceRoot,
    ok: discoveryFailures.length === 0,
    summary: {
      app_count: apps.length,
      invalid_app_count: invalidApps.length,
      organization_count: companies.length,
      company_count: companies.length,
      port_overlap_count: discovery.port_overlaps?.length ?? 0,
      module_listener_drift_count: discovery.module_listener_drifts?.length ?? 0,
      port_policy_issue_count: discovery.port_policy_issues?.length ?? 0,
      organization_port_pool_overlap_count: discovery.organization_port_pool_overlaps?.length ?? 0,
      template_mount_count: templateMounts.length,
      template_app_count: templateApps.length,
      failure_count: discoveryFailures.length,
      warning_count: discoveryWarnings.length,
    },
    organizations,
    companies,
    templates,
    template_mounts: templateMounts,
    template_apps: templateApps,
    apps: publicApps,
    port_overlaps: discovery.port_overlaps ?? [],
    module_listener_drifts: discovery.module_listener_drifts ?? [],
    module_contracts: discovery.module_contracts ?? [],
    port_policy_issues: discovery.port_policy_issues ?? [],
    organization_port_pool_overlaps: discovery.organization_port_pool_overlaps ?? [],
    failures: discoveryFailures,
    // Doctor musí umět oddělit vlastní discovery nálezy od Git/worktree
    // diagnostiky. Veřejné `warnings` zůstávají kompatibilní kombinovaný stream
    // pro stávající API konzumenty; discovery check ale nesmí stejný sidecar
    // vykázat podruhé vedle `git.worktrees.contract`.
    discovery_warnings: discoveryWarnings,
    warnings: [...discoveryWarnings, ...gitContext.warnings],
  };
}

function projectActiveTeamSpaces(spaces, activeTeamId) {
  if (typeof activeTeamId !== "string" || activeTeamId.length === 0) return spaces;
  const teams = (spaces.teams ?? []).filter((team) => team.slug === activeTeamId);
  return {
    ...spaces,
    teams,
    // Deprecated alias zůstává přesnou projekcí stejného aktivního Teamu.
    workspaces: teams,
  };
}

function projectActiveTeamApp(app, activeTeamId) {
  if (typeof activeTeamId !== "string" || activeTeamId.length === 0) return app;
  if (app.space !== "workspace") return app;
  const teams = (app.teams ?? []).filter((team) => team === activeTeamId);
  return {
    ...app,
    teams,
    workspace: teams.length > 0 ? activeTeamId : null,
  };
}

function appVisibleForActiveTeam(app, activeTeamId) {
  if (typeof activeTeamId !== "string" || activeTeamId.length === 0) return true;
  if (app.space !== "workspace") return true;
  return (app.teams ?? []).includes(activeTeamId);
}

export async function buildLaunchpadDoctorReport(options = {}) {
  const appsResponse = await buildLaunchpadAppsResponse({
    ...options,
    includePrivateDiagnostics: true,
  });
  const environmentChecks = buildEnvironmentChecks({
    companiesRoot: appsResponse.root,
    companies: appsResponse.companies,
    // Module šablony (templates/*/*) jsou informační sken — žádná Git mount gate.
    // Marker template mounty (organization_kind=template) se nepočítají jako
    // Organizace, ale drží stejné strukturální Git mount gates (řádný Git checkout).
    templateMounts: appsResponse.template_mounts,
  });
  const toolUpdateChecks = options.checkToolUpdates
    ? await developerToolUpdateChecks({
        inspectUpdates: options.inspectDeveloperToolUpdates ?? inspectDeveloperToolUpdates,
      })
    : [];
  // Personalspace doctor check (CAC-0048) — METADATA ONLY (počty, validita,
  // gbrain mount stav). Nikdy nečte obsah osobních modulů ani gbrain zápisů a
  // osobní aplikace se NIKDY nemíchají do org appsResponse. Selhání personalspace
  // discovery nesmí shodit celý org doctor → izolované do skip/warn.
  const worktreeChecks = await buildWorktreeDoctorChecks({ companiesRoot: appsResponse.root });
  const personalspaceChecks = await buildPersonalspaceDoctorChecks({
    companiesRoot: appsResponse.root,
    rootSourceRoot: options.rootSourceRoot ?? appsResponse.control_root ?? appsResponse.root,
    launchpadRoot: options.launchpadRoot,
  });
  const agentSkillsChecks = [
    await agentSkillsEntrypointsDoctorCheck({
      companiesRoot: appsResponse.root,
      mounts: [
        ...(appsResponse.organizations ?? []),
        ...(appsResponse.template_mounts ?? []),
      ],
      agentCapabilityMode:
        options.agentCapabilityMode
        ?? process.env.COMPANYASCODE_AGENT_CAPABILITY_MODE
        ?? "claude-compatible",
    }),
  ];
  // Podřízené doctory namountovaných rep (decision 0118). Root nese jen
  // standardizované kontroly; vlastní kontrola Organizace patří do jejího repa.
  const schema = loadRootDoctorSchema();
  const childLane = await runChildDoctorLane({
    companiesRoot: appsResponse.root,
    companiesConfig: await readCompaniesConfig(
      options.rootSourceRoot ?? appsResponse.control_root ?? appsResponse.root,
    ),
    schema,
    enabled: options.runChildDoctors !== false,
  });
  return buildDoctorReportFromAppsResponse(appsResponse, {
    environmentChecks,
    extraChecks: [
      ...toolUpdateChecks,
      ...worktreeChecks,
      ...personalspaceChecks,
      ...agentSkillsChecks,
    ],
    childLane,
    schema,
  });
}

/**
 * Schéma surfacu je KONTRAKT DODANÝ S KÓDEM, ne per-root konfigurace: čte se ze
 * zdrojového `lazurio/schemas/`, stejně jako runtime schémata v
 * `discovery-lib.mjs` — nikdy z diagnostikovaného rootu, protože ten může být
 * fixture nebo cizí checkout, a schéma přinesené kontrolovaným stromem by
 * znamenalo, že se subjekt kontroly měří vlastním metrem. Když chybí, root nemá
 * čím validovat ani vlastní report, ani reporty dětí, a to je vada instalace.
 */
export function loadRootDoctorSchema() {
  if (!cachedDoctorReportSchema) {
    cachedDoctorReportSchema = loadDoctorReportSchema(join(import.meta.dirname, ".."));
  }
  return cachedDoctorReportSchema;
}

// Oddělený od org appsResponse: personalspace má vlastní lane. Dynamický import,
// aby se personalspace runtime moduly nenatahovaly, když se doctor volá jen na
// org kontrolu, a aby případná chyba lane zůstala izolovaná.
async function buildPersonalspaceDoctorChecks({ companiesRoot, rootSourceRoot = companiesRoot, launchpadRoot }) {
  try {
    const { buildPersonalspaceResponse, personalspaceDoctorCheck } = await import("./personalspace-runtime-lib.mjs");
    const personalspaceResponse = await buildPersonalspaceResponse({
      companiesRoot,
      rootSourceRoot,
      launchpadRoot: launchpadRoot ?? join(companiesRoot, "launchpad"),
      verifyRepositoryPrivacy: true,
    });
    return [personalspaceDoctorCheck(personalspaceResponse)];
  } catch (error) {
    return [
      {
        id: "launchpad.personalspace",
        // Nikoli `not_applicable`: personalspace lane spadla, takže o osobním
        // prostoru nevíme NIC. To je nepozorování a zelenou kazit musí.
        status: "blocked",
        severity: "local-state",
        title: "Personalspace",
        message: `Personalspace kontrola se nedala provést (${error.message}).`,
        paths: ["personalspace"],
        links: [],
        details: [],
        blocked_reason: `Personalspace lane skončila chybou: ${error.message}`,
        remedy:
          "Oprav personalspace mount (personal.gen3.json, gbrain mount) a spusť doctor znovu.",
      },
    ];
  }
}

async function buildWorktreeDoctorChecks({ companiesRoot }) {
  try {
    const index = await buildWorktreeIndex({ companiesRoot });
    return [
      worktreeInventoryCheck(index),
      worktreeContractCheck(index),
      await worktreeDependencyCheck({ companiesRoot, index }),
    ];
  } catch (error) {
    return [
      {
        id: "git.worktrees.inventory",
        status: "warn",
        severity: "local-state",
        title: "Worktree inventory",
        message: `Worktree inventory nejde načíst (${error.message}).`,
        paths: ["organizations"],
        links: [],
        details: [error.stack ?? error.message],
      },
      blockedCheck({
        id: "git.worktrees.contract",
        title: "Worktree kontrakt",
        message: "Worktree contract kontroly se nedaly provést, protože inventory nejde načíst.",
        paths: ["organizations"],
        blockedReason: `Worktree inventory nejde načíst: ${error.message}`,
        remedy: "Oprav worktree inventory (sidecary, umístění) a spusť doctor znovu.",
      }),
      blockedCheck({
        id: "git.worktrees.dependencies",
        title: "Worktree dependency readiness",
        message: "Worktree dependency kontroly se nedaly provést, protože inventory nejde načíst.",
        paths: ["organizations"],
        blockedReason: `Worktree inventory nejde načíst: ${error.message}`,
        remedy: "Oprav worktree inventory (sidecary, umístění) a spusť doctor znovu.",
      }),
    ];
  }
}

function worktreeInventoryCheck(index) {
  const worktrees = index.worktrees ?? [];
  const ownershipCounts = countBy(worktrees.map((worktree) => worktree.ownership_status ?? "unknown"));
  const lifecycleCounts = countBy(worktrees.map((worktree) => worktree.status ?? "unknown"));
  const details = [
    `total: ${worktrees.length}`,
    `owned: ${ownershipCounts.owned ?? 0}`,
    `orphan_missing_plan: ${ownershipCounts.orphan_missing_plan ?? 0}`,
    `orphan_missing_file: ${ownershipCounts.orphan_missing_file ?? 0}`,
    `invalid: ${ownershipCounts.invalid ?? 0}`,
    `active: ${lifecycleCounts.active ?? 0}`,
    `stale: ${lifecycleCounts.stale ?? 0}`,
    `invalid_locations: ${(index.invalid_locations ?? []).length}`,
    "dependency_readiness: worktree runtime sources reuse Launchpad dependency checks when selected",
  ];
  return {
    id: "git.worktrees.inventory",
    status: "ok",
    severity: "local-state",
    title: "Worktree inventory",
    message: `Worktree inventory: ${worktrees.length} worktrees, ${(index.invalid_locations ?? []).length} invalid locations.`,
    paths: ["organizations/*/.worktrees"],
    links: [],
    details,
  };
}

function worktreeContractCheck(index) {
  const details = [];
  for (const location of index.invalid_locations ?? []) {
    details.push(`invalid_location: ${location.path} — ${location.message}`);
  }
  for (const worktree of index.worktrees ?? []) {
    if (worktree.ownership_status !== "owned") {
      details.push(`${worktree.ownership_status}: ${worktree.slug} (${worktree.path}) — ${worktree.message}`);
    }
    if (worktree.status === "stale") {
      details.push(`cleanup_candidate: ${worktree.slug} (${worktree.path}) — stale owned worktree without local draft/PR signal`);
    } else if (worktree.ownership_status === "owned" && worktree.status && !["active"].includes(worktree.status)) {
      details.push(`cleanup_candidate: ${worktree.slug} (${worktree.path}) — status ${worktree.status}`);
    }
  }
  for (const warning of index.warnings ?? []) {
    details.push(`warning: ${formatGitWarning(warning)}`);
  }

  return {
    id: "git.worktrees.contract",
    status: details.length > 0 ? "warn" : "ok",
    severity: "local-state",
    title: "Worktree kontrakt",
    message:
      details.length > 0
        ? `Worktree kontrakt má ${formatCount(details.length, "varování", "varování", "varování")}: ownership/orphan/stale cleanup.`
        : "Worktree kontrakt je čistý: žádné orphany, invalid locations ani cleanup kandidáti.",
    paths: ["organizations/*/.worktrees", "organizations/*/.claude/worktrees", "organizations/*/.pr-worktrees"],
    links: [],
    details,
  };
}

async function worktreeDependencyCheck({ companiesRoot, index }) {
  const ownedWorktrees = (index.worktrees ?? []).filter((worktree) => worktree.ownership_status === "owned");
  const records = [];
  for (const worktree of ownedWorktrees) {
    const absoluteWorktreePath = join(companiesRoot, worktree.path);
    const packageDiscovery = await worktreePackageRoots({
      companiesRoot,
      worktree,
      absoluteWorktreePath,
    });
    if (!packageDiscovery.ok) {
      records.push({
        state: "dependency_boundary_invalid",
        worktree,
        detail: `dependency_boundary_invalid: ${worktree.slug} (${worktree.path}) — ${packageDiscovery.detail}`,
      });
      continue;
    }
    const packageRoots = packageDiscovery.roots;
    if (packageRoots.length === 0) {
      records.push({
        state: "no_package",
        worktree,
        detail: `no_package: ${worktree.slug} (${worktree.path})`,
      });
      continue;
    }
    for (const packageRoot of packageRoots) {
      records.push(await worktreePackageReadiness({
        worktree,
        packageRoot,
        absoluteWorktreePath: packageDiscovery.worktree_root,
      }));
    }
  }

  const counts = countBy(records.map((record) => record.state));
  const packageRecords = records.filter((record) => record.state !== "no_package");
  const warningStates = new Set(["needs_install", "dependency_boundary_invalid", "missing_lockfile", "unknown_package_manager", "invalid_package_json"]);
  const warnings = records.filter((record) => warningStates.has(record.state));
  const details = [
    `checked_worktrees: ${ownedWorktrees.length}`,
    `checked_packages: ${packageRecords.length}`,
    `ready: ${counts.ready ?? 0}`,
    `needs_install: ${counts.needs_install ?? 0}`,
    `dependency_boundary_invalid: ${counts.dependency_boundary_invalid ?? 0}`,
    `missing_lockfile: ${counts.missing_lockfile ?? 0}`,
    `unknown_package_manager: ${counts.unknown_package_manager ?? 0}`,
    `invalid_package_json: ${counts.invalid_package_json ?? 0}`,
    `no_package: ${counts.no_package ?? 0}`,
    ...warnings.map((record) => record.detail),
  ];

  return {
    id: "git.worktrees.dependencies",
    status: warnings.length > 0 ? "warn" : "ok",
    severity: "local-state",
    title: "Worktree dependency readiness",
    message:
      warnings.length > 0
        ? `Worktree dependency readiness má ${formatCount(warnings.length, "varování", "varování", "varování")}.`
        : `Worktree dependency readiness je čistá pro ${formatCount(packageRecords.length, "package", "packages", "packages")}.`,
    paths: ["organizations/*/.worktrees/*/*/*/package.json", "organizations/*/.worktrees/*/*/*/app/*/package.json"],
    links: [],
    details,
  };
}

async function worktreePackageRoots({ companiesRoot, worktree, absoluteWorktreePath }) {
  if (typeof worktree.organization_path !== "string" || worktree.organization_path === "") {
    return { ok: false, detail: "Worktree nemá přesný owning Organization path." };
  }
  const organizationRoot = join(companiesRoot, worktree.organization_path);
  const organizationBoundary = await inspectDirectoryWithinCanonicalBoundary({
    // Inventory already carries the exact auto-discovered Organization path.
    // Anchor it to its actual configured mountpoint instead of assuming the
    // historical `organizations/` basename.
    rootPath: dirname(organizationRoot),
    targetPath: organizationRoot,
  });
  if (!organizationBoundary.ok || !organizationBoundary.targetRealPath) {
    return { ok: false, detail: "Organization owner root nelze bezpečně ukotvit." };
  }
  const worktreeBoundary = await inspectDirectoryWithinCanonicalBoundary({
    rootPath: organizationRoot,
    rootRealPath: organizationBoundary.targetRealPath,
    targetPath: absoluteWorktreePath,
  });
  if (!worktreeBoundary.ok || !worktreeBoundary.targetRealPath) {
    return { ok: false, detail: "Worktree odkazuje mimo owning Organization." };
  }
  const canonicalWorktreePath = worktreeBoundary.targetRealPath;
  const roots = [];
  if (existsSync(join(canonicalWorktreePath, "package.json"))) {
    roots.push({ absolute_dir: canonicalWorktreePath, relative_dir: "." });
  }
  const appRoot = join(canonicalWorktreePath, "app");
  if (!existsSync(appRoot)) {
    return { ok: true, roots, worktree_root: canonicalWorktreePath };
  }
  const appBoundary = await inspectDirectoryWithinCanonicalBoundary({
    rootPath: canonicalWorktreePath,
    rootRealPath: canonicalWorktreePath,
    targetPath: appRoot,
  });
  if (!appBoundary.ok || !appBoundary.targetRealPath) {
    return { ok: false, detail: "app/ odkazuje mimo přesný worktree; Doctor jej neprošel." };
  }
  const canonicalAppRoot = appBoundary.targetRealPath;
  if (existsSync(join(canonicalAppRoot, "package.json"))) {
    roots.push({ absolute_dir: canonicalAppRoot, relative_dir: "app" });
  }
  let entries;
  try {
    entries = await readdir(canonicalAppRoot, { withFileTypes: true });
  } catch (error) {
    return { ok: false, detail: `app/ nejde bezpečně vypsat: ${error instanceof Error ? error.message : String(error)}` };
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const absoluteDir = join(canonicalAppRoot, entry.name);
    const childBoundary = await inspectDirectoryWithinCanonicalBoundary({
      rootPath: canonicalWorktreePath,
      rootRealPath: canonicalWorktreePath,
      targetPath: absoluteDir,
    });
    if (!childBoundary.ok || !childBoundary.targetRealPath) {
      return { ok: false, detail: `app/${entry.name} odkazuje mimo přesný worktree; Doctor jej neprošel.` };
    }
    if (existsSync(join(childBoundary.targetRealPath, "package.json"))) {
      roots.push({ absolute_dir: childBoundary.targetRealPath, relative_dir: `app/${entry.name}` });
    }
  }
  return { ok: true, roots, worktree_root: canonicalWorktreePath };
}

async function worktreePackageReadiness({ worktree, packageRoot, absoluteWorktreePath }) {
  const packageRelativePath = packageRoot.relative_dir === "." ? "package.json" : `${packageRoot.relative_dir}/package.json`;
  const label = packageRoot.relative_dir === "." ? worktree.slug : `${worktree.slug}/${packageRoot.relative_dir}`;
  const packageBoundary = await inspectDirectoryWithinCanonicalBoundary({
    rootPath: absoluteWorktreePath,
    rootRealPath: absoluteWorktreePath,
    targetPath: packageRoot.absolute_dir,
    allowTargetEqual: true,
  });
  if (!packageBoundary.ok || !packageBoundary.targetRealPath) {
    return {
      state: "dependency_boundary_invalid",
      worktree,
      package_path: packageRelativePath,
      detail: `dependency_boundary_invalid: ${label} (${worktree.path}/${packageRelativePath}) — package root změnil owner boundary před čtením.`,
    };
  }
  const lockfile = await firstExistingWorktreeLockfile(packageBoundary.targetRealPath);
  const dependencyInspection = await inspectRequiredDependencies({
    cwd: packageBoundary.targetRealPath,
    boundaryRoot: absoluteWorktreePath,
    lockfile: lockfile?.path ?? null,
  });
  if (!dependencyInspection.ok) {
    const invalidPackage = ["package_json_missing", "package_json_invalid"].includes(dependencyInspection.reason);
    return {
      state: invalidPackage ? "invalid_package_json" : "dependency_boundary_invalid",
      worktree,
      package_path: packageRelativePath,
      detail: `${invalidPackage ? "invalid_package_json" : "dependency_boundary_invalid"}: ${label} (${worktree.path}/${packageRelativePath}) — ${dependencyInspection.detail}`,
    };
  }

  const packageJson = dependencyInspection.package_json;
  const manager = detectWorktreePackageManager({ packageJson, lockfile });
  let state = "ready";
  let action = "ready";
  if (!lockfile && (manager.supported || manager.lockfile_missing === true)) {
    if (dependencyInspection.missing_required_dependencies.length > 0) {
      state = "missing_lockfile";
      action = "commitni lockfile odpovídající packageManager; Doctor bez něj nenabízí Install";
    } else {
      action = "ready; bez podporovaného lockfilu Doctor nenabízí Install ani Repair";
    }
  } else if (!manager.supported) {
    state = "unknown_package_manager";
    action = manager.lockfile_mismatch
      ? `packageManager ${manager.name ?? "unknown"} mismatches ${lockfile?.path ?? "lockfile"} (${lockfile?.package_manager ?? "unknown"})`
      : `unsupported package manager ${manager.name ?? "unknown"}`;
  } else if (dependencyInspection.missing_required_dependencies.length > 0) {
    state = "needs_install";
    action = `${manager.install_command.join(" ")} (missing: ${dependencyInspection.missing_required_dependencies.join(", ")})`;
  }

  return {
    state,
    worktree,
    package_path: packageRelativePath,
    detail: `${state}: ${label} (${worktree.path}/${packageRelativePath}) — ${action}`,
  };
}

async function firstExistingWorktreeLockfile(packageRoot) {
  for (const name of worktreePackageLockfileNames) {
    const absolutePath = join(packageRoot, name);
    if (!existsSync(absolutePath)) continue;
    return {
      path: name,
      absolute_path: absolutePath,
      package_manager: worktreePackageManagerForLockfile(name),
    };
  }
  return null;
}

function detectWorktreePackageManager({ packageJson, lockfile }) {
  const declared = typeof packageJson.packageManager === "string" ? packageJson.packageManager.trim() : "";
  if (declared) {
    const name = worktreePackageManagerName(declared);
    const lockfileMismatch = Boolean(lockfile) && lockfile.package_manager !== name;
    const supported = worktreeSupportedPackageManagers.has(name) && !lockfileMismatch;
    return {
      name,
      source: "packageManager",
      supported,
      lockfile_mismatch: lockfileMismatch,
      install_command: supported ? [name, "install", "--frozen-lockfile"] : null,
    };
  }
  if (lockfile) {
    return {
      name: lockfile.package_manager,
      source: `lockfile:${lockfile.path}`,
      supported: worktreeSupportedPackageManagers.has(lockfile.package_manager),
      install_command: worktreeSupportedPackageManagers.has(lockfile.package_manager) ? [lockfile.package_manager, "install", "--frozen-lockfile"] : null,
    };
  }
  return {
    name: "bun",
    source: "missing_lockfile",
    supported: false,
    lockfile_missing: true,
    install_command: null,
  };
}

function worktreePackageManagerName(value) {
  if (!value) return null;
  if (value.startsWith("@")) {
    const parts = value.split("@").filter(Boolean);
    return parts.length >= 2 ? `@${parts[0]}` : value;
  }
  return value.split("@")[0];
}

function worktreePackageManagerForLockfile(name) {
  return (
    {
      "bun.lock": "bun",
      "bun.lockb": "bun",
      "package-lock.json": "npm",
      "pnpm-lock.yaml": "pnpm",
      "yarn.lock": "yarn",
    }[name] ?? "unknown"
  );
}

async function safeReadDir(path) {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function buildGitContext({ companiesRoot, gitStatusService = null }) {
  try {
    const gitResponse = await buildGitApiResponse({
      companiesRoot,
      statusService: gitStatusService,
      // /api/apps is the cheap discovery/runtime lane. Only the focused browser
      // asks /api/git/repos to schedule a network refresh.
      allowRemoteRefresh: false,
    });
    return {
      reposByKey: new Map(gitResponse.repos.map((repo) => [repo.key, repo])),
      warnings: gitResponse.warnings.map((warning) => `git: ${formatGitWarning(warning)}`),
    };
  } catch (error) {
    return {
      reposByKey: new Map(),
      warnings: [`git: stav repozitářů nejde načíst (${error.message})`],
    };
  }
}

function formatGitWarning(warning) {
  if (typeof warning === "string") return warning;
  if (!warning || typeof warning !== "object") return String(warning ?? "neznámé Git varování");
  const location = typeof warning.path === "string"
    ? warning.path
    : [warning.organization, warning.slug].filter(Boolean).join("/");
  const message = typeof warning.message === "string"
    ? warning.message
    : "Git metadata obsahují nepojmenované varování.";
  return location ? `${location}: ${message}` : message;
}

function gitRepoKeyForApp(app) {
  if (!app?.company || !app?.module) return null;
  return `${app.company}::${app.module}`;
}

/**
 * Root doctor report na společném surfacu v3 (decision 0118).
 *
 * `childLane` je výstup `runChildDoctorLane`. Když ho volající nepředá, report
 * NENÍ tiše bez potomků — nese `blocked` kontrolu, že se podřízené doctory
 * nespouštěly. Fail-closed default je tu schválně: zapomenuté napojení lane by
 * jinak vypadalo přesně jako root, pod kterým žádný mount doctora nedeklaruje.
 */
export function buildDoctorReportFromAppsResponse(
  appsResponse,
  { environmentChecks = [], extraChecks = [], childLane = null, schema = null } = {},
) {
  const lane = childLane ?? unwiredChildLane();
  const checks = [
    ...environmentChecks,
    discoveryCheck(appsResponse),
    portOverlapCheck(appsResponse),
    workspaceDeclarationCheck(appsResponse),
    ...runtimeChecks(appsResponse),
    // Additivní checks (např. personalspace, CAC-0048) — nikdy nemění org
    // appsResponse, jen se přidají do reportu.
    ...extraChecks,
    ...lane.checks,
  ];
  const report = buildAggregateReport({
    scope: {
      type: "launchpad_root",
      path: ".",
      name: appsResponse.launchpad_root.display_name,
      absolute_path: appsResponse.root,
    },
    checks,
    children: lane.children,
  });
  return withSelfConformanceCheck(report, schema);
}

function unwiredChildLane() {
  return {
    children: [],
    checks: [
      {
        id: "doctor.children",
        status: "blocked",
        severity: "required",
        title: "Podřízené doctory",
        message: "Tenhle běh podřízené doctory vůbec nesvolával.",
        paths: ["organizations", "personalspace"],
        links: [],
        details: [],
        blocked_reason:
          "Volající nepředal výstup lane podřízených doctorů, takže o mountech nevíme nic.",
        remedy: "Zavolej `runChildDoctorLane` a jeho výsledek předej jako `childLane`.",
      },
    ],
  };
}

/**
 * Root doctor je sám producentem surfacu, takže se měří vlastním metrem: hotový
 * report se validuje proti `schemas/doctor-report.schema.json`. Bez toho by root
 * mohl vydávat report, který se tváří jako v3 a žádný konzument ho nepřijme —
 * a poznalo by se to až u konzumenta.
 *
 * Kontrola se přidává AŽ po validaci a souhrn se přepočítá, aby se nevalidovala
 * sama sebou. Vlastní tvar téhle kontroly hlídá `doctor-surface-conformance.test.mjs`.
 */
function withSelfConformanceCheck(report, schema) {
  if (!schema) return report;
  const failures = validateDoctorReport(report, { schema, label: "doctor" });
  const check = failures.length === 0
    ? {
      id: "doctor.self_conformance",
      status: "ok",
      severity: "required",
      title: "Konformita reportu",
      message: `Report odpovídá ${DOCTOR_REPORT_SCHEMA_VERSION_V3}.`,
      paths: ["lazurio/schemas/doctor-report.schema.json"],
      links: [],
      details: [],
    }
    : {
      id: "doctor.self_conformance",
      status: "fail",
      severity: "required",
      title: "Konformita reportu",
      message:
        `Report root doctora neodpovídá společnému surfacu doctorů `
        + `(${failures.length} porušení schématu).`,
      paths: ["lazurio/schemas/doctor-report.schema.json"],
      links: [],
      details: failures.slice(0, 25),
    };
  // Schválně NE přes `buildAggregateReport`: ten za každého rozbitého potomka
  // syntetizuje `doctor.child.N`, a druhý průchod nad reportem, který ty checky
  // už nese, by je zdvojil — jedna vada by se v panelu ukázala dvakrát.
  const checks = [...report.checks, check];
  const nested = (report.children ?? []).flatMap(
    (child) => (child.report ? flattenChecks(child.report) : []),
  );
  return {
    ...report,
    summary: buildSummary([...checks, ...nested]),
    checks,
  };
}

export function buildEnvironmentChecks({ companiesRoot, companies = [], templateMounts = [] }) {
  const toolChecks = platformChecks(companiesRoot);
  const gitAvailable = toolChecks.some((check) => check.id === "platform.git" && check.status === "ok");
  if (!gitAvailable) {
    return [
      ...toolChecks,
      blockedCheck({
        id: "git.root",
        title: "Git root",
        message: "Git kontroly se nedaly provést, protože Git není dostupný.",
        paths: ["."],
        blockedReason: "Spustitelný `git` se na téhle mašině nenašel.",
        remedy: "Nainstaluj Git a spusť doctor znovu.",
      }),
      blockedCheck({
        id: "gitignore.protection",
        title: ".gitignore ochrana",
        message: ".gitignore kontroly se nedaly provést, protože Git není dostupný.",
        paths: [".gitignore"],
        blockedReason: "Spustitelný `git` se na téhle mašině nenašel.",
        remedy: "Nainstaluj Git a spusť doctor znovu.",
      }),
    ];
  }

  const repoMounts = uniqueRepoMounts({ companies, templateMounts });
  return [
    ...toolChecks,
    gitRootCheck(companiesRoot),
    gitWorktreeCheck(companiesRoot),
    lazurioUpdateCheck(companiesRoot),
    gitSubmodulesCheck(companiesRoot),
    gitRepoMountsCheck(companiesRoot, repoMounts),
    gitignoreProtectionCheck(companiesRoot, repoMounts),
  ];
}

async function readCompaniesConfig(companiesRoot) {
  const configPath = join(companiesRoot, "launchpad.gen3.json");
  if (!existsSync(configPath)) return null;
  return readJson(configPath);
}

async function attachModuleApplicationProjections({ companiesRoot, organizations, apps }) {
  for (const organization of organizations) {
    const declarations = Array.isArray(organization.module_declarations)
      ? organization.module_declarations
      : [];
    const modules = declarations.filter(
      (slot) => slot.ui_exposure === "module" && slot.space !== "productionspace",
    );
    const moduleRootPaths = declarations.map((slot) => posix.join(organization.path, slot.path));
    for (const slot of modules) {
      // Without a local checkout neither lazurio.module.json nor its absence
      // was observed. Do not turn an unavailable/planned Module into the
      // materially different legacy-missing contract state.
      if (slot.status !== "available") continue;
      const moduleRootPath = posix.join(organization.path, slot.path);
      const contractPath = posix.join(moduleRootPath, "lazurio.module.json");
      const absoluteContractPath = join(companiesRoot, contractPath);
      let module = null;
      let contractIssues = [];
      let observedContractPath = null;
      if (existsSync(absoluteContractPath)) {
        observedContractPath = contractPath;
        try {
          const normalized = normalizeModuleManifest({
            manifest: await readJson(absoluteContractPath),
            modulePath: contractPath,
          });
          module = normalized.module;
          contractIssues = normalized.issues;
        } catch (error) {
          contractIssues = [`${contractPath}: lazurio.module.json nejde přečíst: ${error.message}`];
        }
      }
      const projection = resolveModuleApplications({
        module,
        moduleRootPath,
        moduleRootPaths,
        contractPath: observedContractPath,
        contractIssues,
        apps,
      });
      slot.apps = projection;

      const appProjection = {
        state: projection.state,
        contract_path: projection.contract_path,
        open_target_app_id: projection.open_target_app_id,
        open_target_source: projection.open_target_source,
      };
      const itemByPackagePath = new Map(
        projection.items.map((item) => [posix.join(moduleRootPath, item.package_path), item]),
      );
      for (const app of apps) {
        const packagePath = String(app.package_path ?? "").replace(/\\/g, "/");
        const item = itemByPackagePath.get(packagePath);
        if (!item) continue;
        app.module_apps = appProjection;
        app.module_catalog_path = slot.path;
        app.module_open_target = projection.open_target_app_id === app.id;
      }
    }
  }
}

// Reads the normalized Organization resource to expose the three physical
// boundaries: Organization root, flat Workspace, and Productionspace. Workspace
// modules are additionally projected into N:M Teams. GitHub is the access
// authority; until a live membership adapter exists, the API says explicitly
// that Builder Team membership was not evaluated.
async function readOrganizationSpaces(
  companiesRoot,
  organization,
  localConfig = null,
  organizationIssues = [],
  activeTeamId = null,
) {
  const organizationReadinessBlockers = organizationIssues
    .filter((issue) => issue.scope === "organization")
    .map((issue) => ({
      slug: organization.slug,
      path: issue.path ?? organization.path,
      status: issue.status ?? "quarantined",
      scope: "organization",
      message: issue.message,
      reason: issue.code ?? "organization_contract_invalid",
      found_path: issue.path ?? null,
      expected_path: issue.expected_path ?? null,
      next_action: issue.next_action ?? null,
    }));
  const empty = {
    organization_modules: [],
    teams: [],
    workspaces: [],
    productionspace: null,
    team_access: unevaluatedTeamAccess(),
    module_declarations: [],
    space_readiness: { blocking_slots: organizationReadinessBlockers },
  };
  const invalidatesSubordinateProjection = organizationIssues.some((issue) =>
    issue.scope === "organization" && issue.blocks_subordinate_projection === true
  );
  // Organization-fatal identity/boundary/config issue means its manifest is
  // not a trustworthy owner for subordinate slot state. Keep exactly the
  // scoped Organization blocker; do not manufacture additional missing-access
  // tiles from the same rejected declaration.
  if (invalidatesSubordinateProjection) return empty;
  if (organization.status === "planned" || !organization.path) return empty;
  const organizationRoot = join(companiesRoot, organization.path);
  const resolution = readOrganizationRoot({ organizationRoot });
  if (
    resolution.state === "conflict"
    || resolution.resource_count !== 1
  ) return empty;
  const resource = resolution.resource;
  const legacyExtensions = resource.extensions?.legacy ?? {};
  const config = {
    governance: resource.governance,
    teams: resource.teams,
    layers: resource.layers,
    task_sources: resource.task_sources,
    doctor: resource.doctor,
    module_port_pool: resource.module_port_pool,
    workspaces: legacyExtensions.workspaces,
    productionspace: legacyExtensions.productionspace,
    modules: [],
  };
  const principalRoles = localConfig?.organization_roles?.[organization.slug];
  const canonicalTeams = Array.isArray(config?.teams) ? config.teams : null;
  const legacyWorkspaces = Array.isArray(config?.workspaces) ? config.workspaces : [];
  const declared = canonicalTeams ?? legacyWorkspaces;
  // Hosted Team Workspace carries one already-validated Team identity. Scope
  // readiness to it only when the Organization itself declares that Team;
  // an unknown value must remain fail-closed instead of hiding every module.
  const declaredActiveTeamId = typeof activeTeamId === "string"
    && declared.some((team) => team?.slug === activeTeamId)
      ? activeTeamId
      : null;
  const productionspaceConfig = config?.productionspace ?? null;
  const productionBoundary = legacyWorkspaces.find(
    (workspace) => workspace.slug === "productionspace" || workspace.path === "productionspace",
  );
  const manifest = { module_slots: resource.repository_inventory ?? [] };
  const manifestSlots = manifest.module_slots;
  const companyModules = [];
  const ambiguousSlots = ambiguousOrganizationRepositorySlots(manifestSlots, companyModules);
  const issueForSlot = (slot) => organizationIssues.find((issue) =>
    (issue.module && issue.module === slot.slug)
    || (issue.path && issue.path === slot.path)
  ) ?? null;
  const readModelEligible = (slot) =>
    !ambiguousSlots.has(slot)
    && typeof slot?.path === "string"
    && organizationRelativePathIssue({ organizationRoot, path: slot.path }) === null;
  const moduleSlots = manifestSlots
    .filter(readModelEligible)
    .map(normalizeModuleSlot)
    .filter(Boolean)
    .map((slot) => moduleSlotWithReadiness(
      organizationRoot,
      slot,
      principalRoles,
      issueForSlot(slot),
      declaredActiveTeamId,
    ));
  // Legacy compatibility fields live only in the normalized extension bag;
  // repository inventory remains modules.manifest.json-owned.
  const manifestPaths = new Set(moduleSlots.map((slot) => slot.path));
  const configOnlyModules = companyModules
    .filter(readModelEligible)
    .map(normalizeModuleSlot)
    .filter(Boolean)
    .filter((slot) => !manifestPaths.has(slot.path))
    .map((slot) => moduleSlotWithReadiness(
      organizationRoot,
      slot,
      principalRoles,
      issueForSlot(slot),
      declaredActiveTeamId,
    ));
  const moduleDeclarations = [...moduleSlots, ...configOnlyModules];
  // Manifest je inventory/sync autorita, ne access grant. Chráněný slot bez
  // lokálního checkoutu proto zůstává dostupný Doctoru a explicitní sync lane,
  // ale nesmí se promítnout do veřejného /api/apps modelu, health summary ani
  // UI copy. Materializovaný checkout je poslední známý offline stav této
  // mašiny a bez TTL zůstává viditelný; úspěšný online sync chybějící checkout
  // nejdřív materializuje a tím jej v dalším readu přirozeně zpřístupní.
  const projectedModuleDeclarations = moduleDeclarations.filter((slot) =>
    organizationSlotProjectsToLocalMachine(slot, {
      // A quarantined rename/transfer slot is still materialized on this
      // machine, only at its observed legacy path. Keep that one tile and its
      // blocker visible even for role-based modules; hiding it would make the
      // organization summary falsely green while the checkout still exists.
      materialized: moduleSlotIsMaterializedHere(organizationRoot, slot),
    })
  );
  const attachedProjectedIssues = new Set(
    projectedModuleDeclarations
      .map((slot) => slot.repository_issue)
      .filter(Boolean),
  );
  const rawModuleDeclarations = [...manifestSlots, ...companyModules];
  const slotIssueReadinessBlockers = organizationIssues
    .filter((issue) => issue.scope === "module_slot" && !attachedProjectedIssues.has(issue))
    .flatMap((issue) => {
      const matchingSlots = rawDeclarationsForIssue(rawModuleDeclarations, issue);
      if (matchingSlots.length === 0) return [];
      const materialized = issueIsMaterializedHere(organizationRoot, issue, matchingSlots);
      // Multiple declarations for one issue are privacy-sensitive ambiguity:
      // every candidate must independently project to this machine.
      if (!matchingSlots.every((slot) =>
        organizationSlotProjectsToLocalMachine(slot, { materialized })
      )) return [];
      return [{
        slug: issue.module ?? issue.path ?? "invalid-slot",
        path: issue.path ?? null,
        status: issue.status ?? "quarantined",
        scope: "module_slot",
        message: issue.message,
        reason: issue.code ?? "module_slot_invalid",
        found_path: issue.path ?? null,
        expected_path: issue.expected_path ?? null,
        next_action: issue.next_action ?? null,
      }];
    });
  // Vnořený child slot i explicitní repository-db slot jsou technické mounty
  // pro Doctor/search/publish flow, ne samostatné Launchpad module dlaždice.
  // Diagnostics-only klasifikace je záměrně nezávislá na přítomnosti parent
  // slotu (AVALTAR může dočasně deklarovat jen mission-control/db). Pro resolver
  // a Doctor (module_declarations) slot zůstává.
  const declarationPaths = projectedModuleDeclarations.map((slot) => slot.path);
  const isNestedChildSlot = (slot) =>
    declarationPaths.some((path) => path !== slot.path && slot.path.startsWith(`${path}/`));
  const tileModules = projectedModuleDeclarations.filter(
    (slot) => slot.ui_exposure === "module" && !isNestedChildSlot(slot),
  );
  // Fyzická repository boundary zůstává autoritou pro runtime a Git operace.
  // Sdílený Workspace modul se ale smí explicitně prezentovat jednou v sekci
  // Organizace, aby se stejná dlaždice neopakovala v každém Teamu.
  const organizationModules = tileModules.filter(
    (slot) => slot.space === "root" || slot.launchpad_section === "organization",
  );
  const workspaceModules = tileModules.filter(
    (slot) => slot.space === "workspace" && slot.launchpad_section !== "organization",
  );
  const teamSlugs = new Set([
    ...declared.filter((team) => team !== productionBoundary).map((team) => team.slug).filter(Boolean),
    ...workspaceModules.flatMap((slot) => slot.teams ?? []),
  ]);
  if (teamSlugs.size === 0 && workspaceModules.length > 0) teamSlugs.add("workspace");

  const declaredBySlug = new Map(declared.map((team) => [team.slug, team]));
  const teams = [...teamSlugs].map((slug) => {
    const team = declaredBySlug.get(slug) ?? { slug };
    return {
      slug,
      display_name: team.display_name ?? humanizeSlug(slug),
      description: team.description ?? null,
      path: team.path ?? "workspace",
      default: team.default === true || (declared.length === 0 && slug === "workspace"),
      modules: workspaceModules.filter((slot) => (slot.teams ?? []).includes(slug)),
    };
  });
  // Deprecated API alias for older clients. Its entries now carry Team
  // semantics; new UI consumes `teams` and labels the physical layer Workspace.
  const workspaces = teams;

  const productionSystems = productionspaceSystems({
    moduleSlots: tileModules,
    productionspaceConfig,
  }).map((slot) => slot.readiness
    ? slot
    : moduleSlotWithReadiness(organizationRoot, slot, principalRoles));
  const productionspace =
    productionBoundary || productionspaceConfig || productionSystems.length > 0
      ? {
          slug: productionBoundary?.slug ?? "productionspace",
          display_name: productionBoundary?.display_name ?? "Productionspace",
          status: productionspaceConfig?.status ?? "candidate-boundary",
          systems: productionSystems,
        }
      : null;

  return {
    organization_modules: organizationModules,
    teams,
    workspaces,
    productionspace,
    team_access: unevaluatedTeamAccess(),
    module_declarations: moduleDeclarations,
    space_readiness: {
      blocking_slots: deduplicateReadinessBlockers([
        ...organizationReadinessBlockers,
        ...projectedModuleDeclarations
          .filter((slot) => slot.readiness?.severity === "blocking")
          .map((slot) => ({
            slug: slot.slug,
            path: slot.path,
            status: slot.status,
            scope: "module_slot",
            message: slot.readiness.message,
            reason: slot.readiness.reason,
            found_path: slot.repository_issue?.path ?? null,
            expected_path: slot.repository_issue?.expected_path ?? null,
            next_action: slot.readiness.next_action ?? null,
          })),
        ...slotIssueReadinessBlockers,
      ]),
    },
    workspace_conformance_issues: workspaceConformanceIssues({
      declared,
      productionBoundary,
      manifest,
      config,
    }),
    root_slot_contract_issues: rootSlotContractIssues(
      manifest,
      config,
      organizationRoot,
    ),
    slot_scope_contract_issues: slotScopeContractIssues(manifest, config),
  };
}

function deduplicateReadinessBlockers(blockers) {
  const unique = new Map();
  for (const blocker of blockers) {
    const key = [
      blocker.scope,
      blocker.scope === "module_slot" ? blocker.slug ?? blocker.path : blocker.path ?? blocker.slug,
      blocker.reason,
    ].join("\0");
    if (!unique.has(key)) unique.set(key, blocker);
  }
  return [...unique.values()];
}

function moduleSlotIsMaterializedHere(organizationRoot, slot) {
  if (slot?.status === "available") return true;
  if (slot?.status !== "quarantined") return false;
  return issueIsMaterializedHere(organizationRoot, slot?.repository_issue, [slot]);
}

function rawDeclarationsForIssue(rawSlots, issue) {
  const normalizedIssuePath = normalizeOrganizationSlotPath(issue?.path);
  const exact = rawSlots.filter((slot) =>
    normalizedIssuePath
    && normalizeOrganizationSlotPath(slot?.path) === normalizedIssuePath
  );
  if (exact.length > 0) return exact;
  if (typeof issue?.module !== "string") return [];
  return rawSlots.filter((slot) => {
    const path = normalizeOrganizationSlotPath(slot?.path);
    return path && organizationSlotRepositoryId(slot, path) === issue.module;
  });
}

function issueIsMaterializedHere(organizationRoot, issue, matchingSlots = []) {
  const candidatePaths = [
    issue?.path,
    ...(Array.isArray(issue?.observed_paths) ? issue.observed_paths : []),
    ...matchingSlots.map((slot) => slot?.path),
  ];
  return [...new Set(candidatePaths.filter((path) => typeof path === "string"))]
    .some((path) =>
      organizationRelativePathIssue({ organizationRoot, path }) === null
      && existsSync(join(organizationRoot, path))
    );
}

function ambiguousOrganizationRepositorySlots(manifestSlots, companyModules) {
  const ambiguous = new Set();
  const normalizedEntries = (slots) => slots.flatMap((slot) => {
    if (!slot || typeof slot.path !== "string") return [];
    const path = normalizeOrganizationSlotPath(slot.path);
    if (!path || !isCanonicalOrganizationRepositorySlotPath(path)) return [];
    const id = isCanonicalOrganizationRepositorySlotPath(slot.path)
      ? organizationSlotRepositoryId(slot, path)
      : null;
    return [{ slot, path, id }];
  });
  const markRepeated = (entries, keyForEntry) => {
    const groups = new Map();
    for (const entry of entries) {
      const key = keyForEntry(entry);
      if (key === null) continue;
      groups.set(key, [...(groups.get(key) ?? []), entry]);
    }
    for (const group of groups.values()) {
      if (group.length > 1) group.forEach(({ slot }) => ambiguous.add(slot));
    }
  };

  const manifestEntries = normalizedEntries(manifestSlots);
  const companyEntries = normalizedEntries(companyModules);
  for (const entries of [manifestEntries, companyEntries]) {
    markRepeated(entries, ({ path }) => path.toLowerCase());
    markRepeated(entries, ({ id }) => id);
  }

  const combined = [...manifestEntries, ...companyEntries];
  for (const keyForEntry of [({ path }) => path.toLowerCase(), ({ id }) => id]) {
    const groups = new Map();
    for (const entry of combined) {
      const key = keyForEntry(entry);
      if (key === null) continue;
      groups.set(key, [...(groups.get(key) ?? []), entry]);
    }
    for (const group of groups.values()) {
      const projections = new Set(group.map(({ path, id }) => `${path}\0${id}`));
      if (projections.size > 1) group.forEach(({ slot }) => ambiguous.add(slot));
    }
  }
  return ambiguous;
}

function unevaluatedTeamAccess() {
  return {
    authority: "github",
    status: "not_evaluated",
    memberships: [],
    reason: "github_team_membership_adapter_not_connected",
    message: "Členství Buildera v Teamech zatím Launchpad živě neověřuje. Manifest určuje přiřazení modulů; skutečný přístup vždy určuje GitHub.",
  };
}

// Konflikt deklarace vs. realita hlásí doctor (decision 0041 bod 4); jde o
// transition warningy, ne hard failures.
function workspaceConformanceIssues({ declared, productionBoundary, manifest, config }) {
  const issues = [];
  if (productionBoundary) {
    issues.push(
      "legacy compatibility projection company.gen3.json: workspaces[] obsahuje productionspace — rezervovaný slug nesmí být Workspace (decision 0041 bod 6)",
    );
  }
  const defaults = declared.filter((workspace) => workspace !== productionBoundary && workspace.default === true);
  if (defaults.length > 1) {
    issues.push("legacy compatibility projection company.gen3.json: workspaces[] deklaruje víc než jeden default Workspace");
  }
  const rawSlots = [
    ...(Array.isArray(manifest?.module_slots) ? manifest.module_slots : []).map((slot) => ({
      source: "modules.manifest.json",
      slot,
    })),
    ...(Array.isArray(config?.modules) ? config.modules : []).map((slot) => ({
      source: "legacy compatibility projection company.gen3.json",
      slot,
    })),
  ];
  for (const { source, slot } of rawSlots) {
    if (!slot || typeof slot.path !== "string") continue;
    const rawPath = slot.path.replace(/\\/g, "/");
    const path = normalizeOrganizationSlotPath(rawPath);
    if (!path) continue;
    if (path !== rawPath) {
      issues.push(
        `${source}: slot path "${rawPath}" není kanonický; použij "${path}"`,
      );
    }
    if (slot.workspace === "productionspace") {
      issues.push(
        path.startsWith("productionspace/")
          ? `${source}: slot ${path} deklaruje workspace "productionspace" — rezervovaný slug nesmí být hodnota workspace; productionspace slot určuje cesta (decision 0041 bod 6)`
          : `${source}: slot ${path} deklaruje workspace "productionspace" mimo productionspace/ — productionspace není Workspace (decision 0041 bod 6)`,
      );
    }
    if (slot.workspace && slot.workspace !== "productionspace" && path.startsWith("productionspace/")) {
      issues.push(
        `${source}: slot ${path} leží v productionspace/, ale deklaruje workspace "${slot.workspace}" (decision 0041 bod 6)`,
      );
    }
    if (slot.launchpad_section !== undefined) {
      if (slot.launchpad_section !== "organization") {
        issues.push(
          `${source}: slot ${path} má neplatnou launchpad_section ${JSON.stringify(slot.launchpad_section)}; podporovaná hodnota je "organization"`,
        );
      } else if (organizationSlotPathScope(path) !== "workspace") {
        issues.push(
          `${source}: launchpad_section "organization" je prezentační výjimka pouze pro sdílený workspace modul`,
        );
      }
    }
  }
  const productionSlotPaths = rawSlots
    .map(({ slot }) => typeof slot?.path === "string" ? normalizeOrganizationSlotPath(slot.path) : null)
    .filter((path) => path?.startsWith("productionspace/"));
  for (const candidate of Array.isArray(config?.productionspace?.candidate_modules)
    ? config.productionspace.candidate_modules
    : []) {
    if (typeof candidate !== "string") {
      issues.push("legacy compatibility projection company.gen3.json: productionspace.candidate_modules[] musí být cesta deklarovaného productionspace slotu");
      continue;
    }
    if (productionSlotPaths.includes(candidate)) continue;
    const caseMatch = productionSlotPaths.find(
      (path) => path.toLowerCase() === candidate.toLowerCase(),
    );
    issues.push(
      caseMatch
        ? `legacy compatibility projection company.gen3.json: productionspace candidate "${candidate}" neodpovídá přesnému psaní deklarovaného slotu "${caseMatch}"`
        : `legacy compatibility projection company.gen3.json: productionspace candidate "${candidate}" nemá odpovídající deklarovaný productionspace slot`,
    );
  }
  return issues;
}

function slotScopeContractIssues(manifest, config) {
  const issues = [];
  const manifestSlots = Array.isArray(manifest?.module_slots) ? manifest.module_slots : [];
  const companyModules = Array.isArray(config?.modules) ? config.modules : [];
  issues.push(
    ...organizationRepositorySlotCollectionIssues(manifestSlots).map(
      (issue) => `modules.manifest.json: module_slots ${issue}`,
    ),
    ...organizationRepositorySlotCollectionIssues(companyModules).map(
      (issue) => `legacy compatibility projection company.gen3.json: modules ${issue}`,
    ),
    ...organizationRepositorySlotCollectionIssues(
      [...manifestSlots, ...companyModules],
      { allowEquivalentDuplicates: true },
    ).map(
      (issue) => `modules.manifest.json + legacy compatibility projection company.gen3.json: nejednoznačná repo projekce — ${issue}`,
    ),
  );
  const rawSlots = [
    ...manifestSlots.map((slot) => ({
      source: "modules.manifest.json",
      slot,
    })),
    ...companyModules.map((slot) => ({
      source: "legacy compatibility projection company.gen3.json",
      slot,
    })),
  ];
  for (const { source, slot } of rawSlots) {
    if (!slot || typeof slot.path !== "string") continue;
    const path = normalizeOrganizationSlotPath(slot.path);
    if (isOrganizationSlotContainerPath(path)) {
      issues.push(
        `${source}: slot ${path} je Organization kontejner, ne repozitářový slot; použij workspace/<slug>, modules/<slug> nebo productionspace/<slug>`,
      );
      continue;
    }
    if (isOrganizationRootSlotDescendantPath(path)) {
      issues.push(
        `${source}: slot ${path} je uvnitř rezervované Organization root boundary; samostatné root sloty jsou jen design-system, infra, mission-control a mission-control/db`,
      );
      continue;
    }
    if (!isCanonicalOrganizationRepositorySlotPath(slot.path)) {
      issues.push(
        `${source}: slot path ${JSON.stringify(slot.path)} není kanonická podporovaná Organization-relative repo boundary`,
      );
      continue;
    }
    if (organizationSlotRepositoryId(slot, path) === null) {
      issues.push(
        `${source}: slot ${path} potřebuje explicitní stabilní lowercase slug, protože jej nelze bezpečně odvodit z repository basename`,
      );
      continue;
    }
    if (slot.space === undefined) continue;
    const pathScope = organizationSlotPathScope(path);
    if (!pathScope || pathScope === "root" || slot.space === pathScope) continue;
    issues.push(
      `${source}: slot ${path} musí podle path boundary deklarovat space: "${pathScope}", ne "${slot.space}"`,
    );
  }
  return issues;
}

function organizationOwnsRootLayer(organizationRoot, path) {
  const absolutePath = join(organizationRoot, path);
  if (!existsSync(absolutePath) || existsSync(join(absolutePath, ".git"))) return false;

  const indexEntries = runGit(["ls-files", "--stage", "--", path], organizationRoot);
  if (!indexEntries.ok || indexEntries.stdout.trim().length === 0) return false;

  return indexEntries.stdout
    .split("\n")
    .filter(Boolean)
    .every((entry) => !entry.startsWith("160000 "));
}

// Organization root checkout boundaries mají přísnější kontrakt než běžné
// Team moduly: scope musí být explicitní, aktivní slot musí nést přesné checkout
// souřadnice a Mission Control app/data deklarace tvoří jeden pár.
function rootSlotContractIssues(manifest, config, organizationRoot) {
  const issues = [];
  const rootLayerPaths = new Set(["design-system", "infra", "mission-control"]);
  const slots = Array.isArray(manifest?.module_slots) ? manifest.module_slots : [];
  const rootSlots = slots
    .filter((slot) => slot && typeof slot.path === "string")
    .map((slot) => ({
      slot,
      rawPath: slot.path.replace(/\\/g, "/"),
      path: normalizeOrganizationSlotPath(slot.path),
    }))
    .filter(({ path }) => isOrganizationRootSlotPath(path));
  const declaredPaths = new Set(rootSlots.map(({ path }) => path));

  for (const { slot, rawPath, path } of rootSlots) {
    if (rawPath !== path) {
      issues.push(
        `modules.manifest.json: root slot path "${rawPath}" není kanonický; použij "${path}"`,
      );
    }
    if (slot.space !== "root") {
      issues.push(
        `modules.manifest.json: root slot ${path} musí explicitně deklarovat space: "root"`,
      );
    }

    const membershipFields = ["workspace", "workspaces", "teams"].filter((field) =>
      Object.prototype.hasOwnProperty.call(slot, field),
    );
    if (membershipFields.length > 0) {
      issues.push(
        `modules.manifest.json: root slot ${path} nesmí deklarovat Team/Workspace membership (${membershipFields.join(", ")})`,
      );
    }

    const legacyCheckoutFields = ["repo", "repository", "branch"].filter((field) =>
      Object.prototype.hasOwnProperty.call(slot, field),
    );
    if (legacyCheckoutFields.length > 0) {
      issues.push(
        `modules.manifest.json: root slot ${path} nesmí deklarovat legacy checkout souřadnice (${legacyCheckoutFields.join(", ")}); používej výhradně git.url a git.branch`,
      );
    }

    const gitUrl = typeof slot.git?.url === "string" ? slot.git.url.trim() : "";
    const gitBranch = typeof slot.git?.branch === "string" ? slot.git.branch.trim() : "";
    // A tracked compatibility directory inside the Organization root is not a
    // materialized root-slot checkout. Doctor-managed nested repos and Git
    // worktrees both expose their own .git entry (directory or file).
    const nestedCheckoutExists = existsSync(join(organizationRoot, path, ".git"));
    const checkoutCoordinatesStarted = slot.git !== undefined;
    if (slot.status === "planned_slot" && nestedCheckoutExists) {
      issues.push(
        `modules.manifest.json: materializovaný root slot ${path} nesmí zůstat status: "planned_slot"; odstraň status a ponech nebo doplň celé git.url i git.branch`,
      );
    } else if (slot.status === "planned_slot" && checkoutCoordinatesStarted) {
      issues.push(
        `modules.manifest.json: planned root slot ${path} nesmí deklarovat git; s checkout souřadnicemi už jde o aktivní nebo missing-access slot`,
      );
    } else if (slot.status !== "planned_slot") {
      const missingCoordinates = [
        ...(gitUrl ? [] : ["git.url"]),
        ...(gitBranch ? [] : ["git.branch"]),
      ];
      if (missingCoordinates.length > 0) {
        issues.push(
          `modules.manifest.json: materializovaný nebo checkoutem rozepsaný root slot ${path} musí deklarovat ${missingCoordinates.join(" a ")}; bez checkout údajů smí být jen nematerializovaný status: "planned_slot"`,
        );
      }
    }
    if (path === "mission-control/db" && gitBranch && gitBranch !== "v3") {
      issues.push(
        `modules.manifest.json: root slot mission-control/db musí používat větev "v3", deklarována je "${gitBranch}"`,
      );
    }
  }

  const missionControlDeclared = declaredPaths.has("mission-control");
  const missionControlDataDeclared = declaredPaths.has("mission-control/db");
  if (missionControlDeclared !== missionControlDataDeclared) {
    const missingPath = missionControlDeclared ? "mission-control/db" : "mission-control";
    issues.push(
      `modules.manifest.json: Mission Control app/data boundary musí deklarovat oba root sloty; chybí ${missingPath} (během migrace smí mít protějšek status: "planned_slot")`,
    );
  }

  for (const slot of Array.isArray(config?.modules) ? config.modules : []) {
    if (!slot || typeof slot.path !== "string") continue;
    const path = normalizeOrganizationSlotPath(slot.path);
    if (!isOrganizationRootSlotPath(path)) continue;
    issues.push(
      `legacy compatibility projection company.gen3.json: root slot ${path} nesmí být v modules[]; deklaruj ho v modules.manifest.json/module_slots[]`,
    );
  }

  const rootLayers = (Array.isArray(config?.layers) ? config.layers : [])
    .filter((layer) => typeof layer?.path === "string")
    .map((layer) => ({
      rawPath: layer.path.replace(/\\/g, "/"),
      path: normalizeOrganizationSlotPath(layer.path),
    }))
    .filter(({ path }) => rootLayerPaths.has(path));
  const declaredLayerPaths = new Set(rootLayers.map(({ path }) => path));
  for (const { rawPath, path } of rootLayers) {
    if (rawPath === path) continue;
    issues.push(
      `legacy compatibility projection company.gen3.json: root layer path "${rawPath}" není kanonický; použij "${path}"`,
    );
  }
  for (const path of declaredLayerPaths) {
    const trackedByOrganization = organizationOwnsRootLayer(organizationRoot, path);
    if (!declaredPaths.has(path) && !trackedByOrganization) {
      issues.push(
        `legacy compatibility projection company.gen3.json: root vrstva ${path} nemá odpovídající modules.manifest.json slot`,
      );
    }
  }
  for (const path of declaredPaths) {
    if (!rootLayerPaths.has(path) || declaredLayerPaths.has(path)) continue;
    issues.push(
      `modules.manifest.json: root slot ${path} nemá odpovídající vrstvu v legacy compatibility projection company.gen3.json`,
    );
  }

  return issues;
}

// Readiness stavu module slotu (decision 0042): available = mount existuje,
// missing_access = deklarované repo bez lokálního checkoutu (typicky chybějící
// GitHub přístup nebo zatím nespuštěný doctor sync), planned_slot = slot bez
// repo deklarace.
function moduleSlotStatus(organizationRoot, slot) {
  if (existsSync(join(organizationRoot, slot.path))) return "available";
  return slot.repo ? "missing_access" : "planned_slot";
}

function moduleSlotWithReadiness(
  organizationRoot,
  slot,
  principalRoles = null,
  organizationIssue = null,
  activeTeamId = null,
) {
  if (organizationIssue) {
    return {
      ...slot,
      status: "quarantined",
      repository_issue: organizationIssue,
      readiness: {
        severity: "blocking",
        reason: organizationIssue.code,
        message: organizationIssue.message,
        next_action: organizationIssue.next_action ?? null,
      },
    };
  }
  const status = moduleSlotStatus(organizationRoot, slot);
  return {
    ...slot,
    status,
    readiness: classifyModuleSlotReadiness(slot, status, principalRoles, activeTeamId),
  };
}

function projectOrganizationDiagnostics(spaces, moduleDeclarations) {
  const hiddenPaths = (moduleDeclarations ?? [])
    .filter((slot) => !organizationSlotProjectsToLocalMachine(slot))
    .map((slot) => slot.path);
  return {
    ...spaces,
    workspace_conformance_issues: projectDiagnosticMessages(
      spaces.workspace_conformance_issues,
      hiddenPaths,
    ),
    root_slot_contract_issues: projectDiagnosticMessages(
      spaces.root_slot_contract_issues,
      hiddenPaths,
    ),
    slot_scope_contract_issues: projectDiagnosticMessages(
      spaces.slot_scope_contract_issues,
      hiddenPaths,
    ),
  };
}

function projectDiagnosticMessages(messages = [], hiddenPaths = []) {
  if (!Array.isArray(messages) || hiddenPaths.length === 0) return messages ?? [];
  return messages.filter((message) =>
    typeof message !== "string"
    || !hiddenPaths.some((path) => typeof path === "string" && message.includes(path)),
  );
}

// Status popisuje fyzickou materializaci, readiness její dopad pro aktuální
// prostor. Dokud Doctor nemá autoritativní principal-scoped ACL důkaz, je
// role-based chybějící checkout fail-closed. UI umí přijmout kanonicky
// doloženou neutral severity, ale lokální odhad z GitHub tokenu ji nevyrábí.
function classifyModuleSlotReadiness(
  slot,
  status,
  principalRoles = null,
  activeTeamId = null,
) {
  if (status === "available") {
    return { severity: "ok", reason: "available", message: "Checkout modulu je dostupný." };
  }
  if (status === "planned_slot") {
    return { severity: "neutral", reason: "planned", message: "Slot je plánovaný a zatím nemá repozitář." };
  }
  if (status === "missing_access") {
    if (
      slot.space === "workspace"
      && typeof activeTeamId === "string"
      // `organizationSlotTeams` uses `workspace` as the compatibility
      // fallback for a declaration without Team scope. Such a required slot
      // stays shared/fail-closed on every concrete Hosted Team Workspace.
      && !(slot.teams ?? []).includes("workspace")
      && !(slot.teams ?? []).includes(activeTeamId)
    ) {
      return {
        severity: "neutral",
        reason: "team_not_assigned",
        message: "Checkout není deklarovaný pro aktivní Team tohoto Hosted Workspace.",
      };
    }
    const accessRestricted = ["role_based", "restricted", "private"].includes(slot.default_access);
    const requiredRoles = Array.isArray(slot.required_roles) ? slot.required_roles : [];
    const hasPrincipalRoleEvidence = Array.isArray(principalRoles);
    const principalIsEntitled = requiredRoles.includes("*")
      || (hasPrincipalRoleEvidence && requiredRoles.some((role) => principalRoles.includes(role)));
    if (accessRestricted && hasPrincipalRoleEvidence && requiredRoles.length > 0 && !principalIsEntitled) {
      return {
        severity: "neutral",
        reason: "role_not_entitled",
        message: "Checkout podle lokálně deklarovaných rolí tohoto Principála není očekávaný.",
      };
    }
    return {
      severity: "blocking",
      reason: accessRestricted
        ? "access_entitlement_unknown"
        : "unexpected_missing_access",
      message: slot.default_access === "expected"
        ? "Modul má být dostupný každému kolegovi, ale checkout chybí."
        : "Checkout chybí a access kontrola nedoložila očekávané omezení role nebo ACL.",
    };
  }
  return { severity: "blocking", reason: "unknown_status", message: `Neznámý stav slotu: ${status}.` };
}

// Top-level placement is a physical boundary. Manifest declarations only add
// N:M Team intent to Workspace apps; GitHub remains the live access authority.
export function appPlacementResolverForOrganization(company) {
  const declarations = Array.isArray(company.module_declarations) ? company.module_declarations : [];
  const defaultTeam = company.teams?.find((team) => team.default)?.slug
    ?? company.teams?.[0]?.slug
    ?? "workspace";
  return (app) => {
    // path.relative na Windows vrací backslashe; deklarace jsou POSIX.
    const packagePath = String(app.package_path ?? "").replace(/\\/g, "/");
    const prefix = `${company.path}/`;
    if (!packagePath.startsWith(prefix)) {
      return { space: "workspace", teams: [defaultTeam], workspace: defaultTeam };
    }
    const organizationRelativePath = packagePath.slice(prefix.length);
    const [boundary] = organizationRelativePath.split("/");
    if (boundary === "productionspace") {
      return { space: "productionspace", teams: [], workspace: "productionspace" };
    }
    if (boundary !== "workspace" && boundary !== "modules") {
      return { space: "root", teams: [], workspace: null };
    }
    let match = null;
    for (const declaration of declarations) {
      if (
        organizationRelativePath === declaration.path ||
        organizationRelativePath.startsWith(`${declaration.path}/`)
      ) {
        if (!match || declaration.path.length > match.path.length) match = declaration;
      }
    }
    if (match?.space === "workspace" && match.launchpad_section === "organization") {
      return {
        space: "root",
        teams: [],
        workspace: null,
        description: app.description ?? match.description ?? null,
      };
    }
    const teams = match?.space === "workspace" && match.teams?.length > 0
      ? match.teams
      : [defaultTeam];
    return {
      space: "workspace",
      teams,
      workspace: teams[0],
      description: app.description ?? match?.description ?? null,
    };
  };
}

function appPlacementFor(placementResolvers, app) {
  const resolver = placementResolvers.get(app.organization_path);
  return resolver
    ? resolver(app)
    : { space: "workspace", teams: ["workspace"], workspace: "workspace" };
}

function normalizeModuleSlot(slot) {
  if (!slot || typeof slot !== "object" || typeof slot.path !== "string" || slot.path.trim() === "") {
    return null;
  }
  if (!isCanonicalOrganizationRepositorySlotPath(slot.path)) return null;
  const path = normalizeOrganizationSlotPath(slot.path);
  if (
    !path
    || isOrganizationSlotContainerPath(path)
    || isOrganizationRootSlotDescendantPath(path)
  ) {
    return null;
  }
  const slug = organizationSlotRepositoryId(slot, path);
  if (slug === null) return null;
  const space = organizationSlotScope(slot, path);
  const teams = organizationSlotTeams(slot, path);
  const workspace = organizationSlotWorkspace(slot, path);
  const launchpadSection = slot.launchpad_section === "organization" ? "organization" : null;
  const catalogPresentation = organizationSlotCatalogPresentation(slot, path);
  if (space !== "root" && !workspace) return null;
  const repo = organizationSlotRepositoryRemote(slot, path);
  const branch = organizationSlotRepositoryBranch(slot, path);
  return {
    slug,
    name: slot.name ?? humanizeSlug(
      space === "root"
        ? path.split("/").filter((segment) => !["workspace", "modules", "productionspace"].includes(segment)).join("-")
        : slug,
    ),
    path,
    space,
    teams,
    workspace,
    launchpad_section: launchpadSection,
    category: slot.category ?? null,
    description: catalogPresentation.description,
    default_access: slot.default_access ?? null,
    required_roles: Array.isArray(slot.required_roles) ? slot.required_roles : [],
    classification: slot.classification ?? null,
    launchpad_port: slot.launchpad_port ?? null,
    repo,
    branch,
    ui_exposure: catalogPresentation.ui_exposure,
  };
}

function productionspaceSystems({ moduleSlots, productionspaceConfig }) {
  const productionSlots = moduleSlots.filter((slot) => slot.space === "productionspace");
  const byPath = new Map(productionSlots.map((slot) => [slot.path, slot]));
  const orderedPaths = Array.isArray(productionspaceConfig?.candidate_modules)
    ? productionspaceConfig.candidate_modules.filter((path) => typeof path === "string")
    : [];
  // candidate_modules je jen pořadí deklarovaných slotů, ne druhý source of
  // truth schopný syntetizovat vlastní repo ID nebo mount.
  const ordered = orderedPaths.map((path) => byPath.get(path)).filter(Boolean);
  for (const slot of productionSlots) {
    if (!ordered.some((item) => item.path === slot.path)) ordered.push(slot);
  }
  return ordered;
}

function humanizeSlug(slug) {
  if (!slug) return "";
  return String(slug)
    .split(/[-_]/)
    .map((word, index) => (index === 0 ? word.charAt(0).toUpperCase() + word.slice(1) : word))
    .join(" ");
}

function platformChecks(companiesRoot) {
  const platformName = supportedPlatforms[process.platform];
  const bunExecutable = resolveBunExecutable();
  const gitExecutable = resolveGitExecutableSync();
  return [
    {
      id: "platform.os",
      status: platformName ? "ok" : "fail",
      severity: "required",
      title: "Operační systém",
      message: platformName
        ? `${platformName} je podporovaný OS pro Lazurio Root.`
        : `Nepodporovaný OS ${process.platform}.`,
      paths: [],
      links: [],
      details: [`platform: ${process.platform}`, `arch: ${process.arch}`],
    },
    bunRuntimeCheck({ companiesRoot, bunExecutable }),
    commandCheck({
      id: "platform.git",
      title: "Git",
      command: gitExecutable,
      args: ["--version"],
      cwd: companiesRoot,
      okMessage: (result) => result.stdout,
      failMessage: "Git nebyl nalezen ani neprošel validací executable kandidáta.",
      env: safeGitCommandEnv(),
    }),
  ];
}

export function bunRuntimeCheck({
  companiesRoot,
  bunExecutable = resolveBunExecutable(),
  requiredVersion = readRequiredBunVersion({ root: join(import.meta.dirname, "..") }),
  run = runCommand,
} = {}) {
  const result = bunExecutable
    ? run(bunExecutable, ["--version"], { cwd: companiesRoot })
    : { ok: false, stdout: "", error: "Bun executable nebyl nalezen." };
  if (!result.ok) {
    return {
      id: "platform.bun",
      status: "fail",
      severity: "required",
      title: "Bun runtime",
      message: "Bun nebyl nalezen ani neprošel validací executable kandidáta.",
      paths: ["package.json"],
      links: [],
      details: [`required: ${requiredVersion}`, result.error ?? result.stderr ?? "unknown failure"],
    };
  }

  const runtime = classifyBunRuntime({
    currentVersion: result.stdout.trim(),
    requiredVersion,
  });
  const current = runtime.status === "current";
  return {
    id: "platform.bun",
    status: current ? "ok" : "fail",
    severity: "required",
    title: "Bun runtime",
    message: current
      ? `Bun ${runtime.current_version} odpovídá Lazurio toolchain autoritě.`
      : `Bun ${runtime.current_version} neodpovídá požadované verzi ${runtime.required_version}; Agent musí nejdřív požádat Principála o souhlas s aktualizací.`,
    paths: ["package.json"],
    links: [],
    details: [
      `command: ${bunExecutable} --version`,
      `current: ${runtime.current_version}`,
      `required: ${runtime.required_version}`,
    ],
  };
}

export async function developerToolUpdateChecks({
  inspectUpdates = inspectDeveloperToolUpdates,
} = {}) {
  let observations;
  try {
    observations = await inspectUpdates();
  } catch {
    return [toolCurrencyUnknownCheck({
      id: "developer_tools",
      title: "Vývojové nástroje",
      currentVersion: null,
      reason: "tool_update_probe_failed",
    })];
  }
  return observations
    .filter((observation) => observation.required || observation.status !== "not_available")
    .map(toolUpdateDoctorCheck);
}

function toolUpdateDoctorCheck(observation) {
  const id = `platform.${observation.id}_update`;
  const details = [
    `installed: ${observation.current_version ?? "unresolved"}`,
    `latest: ${observation.latest_version ?? "unresolved"}`,
    `update_policy: ${DEVELOPER_TOOL_UPDATE_POLICY}`,
  ];
  const links = observation.release_url
    ? [{ label: "Oficiální release", kind: "external", url: observation.release_url }]
    : [];
  if (observation.status === "update_available") {
    return {
      id,
      status: "warn",
      severity: "recommended",
      title: `${observation.title} · aktualizace`,
      message: `${observation.title} ${observation.current_version} má novější oficiální verzi ${observation.latest_version}. Agent ji nesmí instalovat automaticky; musí nejdřív požádat Principála o souhlas.`,
      paths: [],
      links,
      details: [...details, "next_action: ask_principal_before_update"],
    };
  }
  if (observation.status === "current") {
    return {
      id,
      status: "ok",
      severity: "recommended",
      title: `${observation.title} · aktualizace`,
      message: `${observation.title} ${observation.current_version} nemá podle oficiálního release zdroje novější stabilní verzi.`,
      paths: [],
      links,
      details,
    };
  }
  if (observation.status === "not_available") {
    return {
      id,
      status: "warn",
      severity: "recommended",
      title: `${observation.title} · dostupnost`,
      message: `${observation.title} není dostupný v PATH. Může chybět nebo být nainstalovaný mimo PATH; Agent musí před instalací nebo změnou PATH nejdřív požádat Principála o souhlas.`,
      paths: [],
      links: [],
      details: [...details, "next_action: ask_principal_before_install"],
    };
  }
  return toolCurrencyUnknownCheck({
    id: observation.id,
    title: observation.title,
    currentVersion: observation.current_version,
    reason: observation.reason,
  });
}

function toolCurrencyUnknownCheck({ id, title, currentVersion, reason }) {
  return {
    id: `platform.${id}_update`,
    status: "warn",
    severity: "recommended",
    title: `${title} · aktualizace`,
    message: `Aktuálnost ${title} se nepodařilo spolehlivě ověřit; Doctor nebude stav hádat ani nic měnit.`,
    paths: [],
    links: [],
    details: [
      `installed: ${currentVersion ?? "unresolved"}`,
      "latest: unresolved",
      `reason: ${reason}`,
      `update_policy: ${DEVELOPER_TOOL_UPDATE_POLICY}`,
    ],
  };
}

function commandCheck({ id, title, command, args, cwd, okMessage, failMessage, env }) {
  const result = command
    ? runCommand(command, args, { cwd, env })
    : {
        ok: false,
        exitCode: null,
        stdout: "",
        stderr: "",
        error: "Executable resolver nevrátil žádného validního kandidáta.",
      };
  return {
    id,
    status: result.ok ? "ok" : "fail",
    severity: "required",
    title,
    message: result.ok ? okMessage(result) : failMessage,
    paths: [],
    links: [],
    details: result.ok
      ? [`command: ${command} ${args.join(" ")}`]
      : [`command: ${command ?? "<missing>"} ${args.join(" ")}`, result.stderr || result.error || "Příkaz selhal."],
  };
}

function gitRootCheck(companiesRoot) {
  const result = runGit(["rev-parse", "--show-toplevel"], companiesRoot);
  return {
    id: "git.root",
    status: result.ok ? "ok" : "fail",
    severity: "required",
    title: "Git root",
    message: result.ok ? `Git root: ${result.stdout}` : "Lazurio Root není použitelný Git repo.",
    paths: ["."],
    links: [],
    details: result.ok ? [] : [result.stderr || result.error || "git rev-parse selhal"],
  };
}

function gitWorktreeCheck(companiesRoot) {
  const result = runGit(["status", "--porcelain=v1"], companiesRoot);
  if (!result.ok) {
    return {
      id: "git.worktree",
      status: "fail",
      severity: "required",
      title: "Git worktree",
      message: "Git worktree stav nejde přečíst.",
      paths: ["."],
      links: [],
      details: [result.stderr || result.error || "git status selhal"],
    };
  }

  const dirtyLines = result.stdout.split("\n").filter(Boolean);
  return {
    id: "git.worktree",
    status: dirtyLines.length > 0 ? "warn" : "ok",
    severity: "local-state",
    title: "Git worktree",
    message: dirtyLines.length > 0
      ? `Working tree má ${formatCount(dirtyLines.length, "změnu", "změny", "změn")}.`
      : "Working tree je čistý.",
    paths: ["."],
    links: [],
    details: dirtyLines.slice(0, 20),
  };
}

// Read-only kontrola stejného invariantu jako jediný `lazurio update`. Čte
// pouze lokální refs; nikdy nefetchuje ani nemutuje a nevytváří stable/nightly
// kanál jako druhou update autoritu (decision 0129).
export function lazurioUpdateCheck(companiesRoot) {
  const base = {
    id: "update.lazurio",
    severity: "local-state",
    title: "Lazurio update",
    paths: ["."],
    links: [],
  };

  const branch = runGit(["branch", "--show-current"], companiesRoot);
  if (!branch.ok || branch.stdout !== "main") {
    return {
      ...base,
      status: "warn",
      message: branch.ok && branch.stdout
        ? `Root checkout je na branchi ${branch.stdout}; lazurio update zachová její commity a vrátí primární checkout na main.`
        : "Root checkout je detached nebo nečitelný; bezpečný další krok určí lazurio update, případně připraví Codex prompt.",
      details: ["Kontrakt: primární checkout zůstává na main; veškerá práce patří do task/PR worktrees."],
    };
  }

  const originMain = runGit(["rev-parse", "--verify", "origin/main^{commit}"], companiesRoot);
  if (!originMain.ok) {
    return {
      ...base,
      status: "warn",
      message: "Lokální snapshot origin/main chybí; přesný vzdálený stav ověří až explicitní lazurio update.",
      details: ["Doctor je GET/read-only a záměrně nefetchuje."],
    };
  }

  const relation = runGit(["rev-list", "--left-right", "--count", `HEAD...${originMain.stdout}`], companiesRoot);
  if (!relation.ok) {
    return {
      ...base,
      status: "warn",
      message: "Vztah local main a lokálního snapshotu origin/main nejde ověřit.",
      details: [relation.stderr || relation.error || "git rev-list selhal"],
    };
  }
  const [ahead, behind] = relation.stdout.split(/\s+/).map((value) => Number(value));
  if (ahead > 0 && behind > 0) {
    return {
      ...base,
      status: "warn",
      message: `Root má diverged historii: ${ahead} lokálních a ${behind} vzdálených commitů v posledním snapshotu.`,
      details: ["lazurio update vrátí přesný Codex prompt; žádný reset --hard."],
    };
  }
  if (ahead > 0) {
    return {
      ...base,
      status: "warn",
      message: `Local main obsahuje ${ahead} ${ahead === 1 ? "commit" : "commitů"} mimo poslední origin/main.`,
      details: ["lazurio update historii nepřepíše a předá stav Codexu."],
    };
  }
  if (behind > 0) {
    return {
      ...base,
      status: "warn",
      message: `Lazurio root je podle lokálního snapshotu ${behind} ${behind === 1 ? "commit" : "commitů"} pozadu — spusť lazurio update.`,
      details: [],
    };
  }
  return {
    ...base,
    status: "ok",
    message: "Lazurio root je clean main na posledním lokálním snapshotu origin/main.",
    details: ["GitHub se ověřuje jen explicitním lazurio update, ne Doctorem."],
  };
}

function gitSubmodulesCheck(companiesRoot) {
  const paths = gitmodulePaths(companiesRoot);
  if (paths.length === 0) {
    return {
      id: "git.submodules",
      status: "ok",
      severity: "required",
      title: "Git submoduly",
      message: "Workspace nemá deklarované submoduly.",
      paths: [".gitmodules"],
      links: [],
      details: [],
    };
  }

  const failures = [];
  const warnings = [];
  for (const path of paths) {
    const absolutePath = join(companiesRoot, path);
    if (!existsSync(absolutePath)) {
      failures.push(`${path}: chybí mountpoint`);
      continue;
    }
    const repoCheck = runGit(["rev-parse", "--is-inside-work-tree"], absolutePath);
    if (!repoCheck.ok || repoCheck.stdout !== "true") {
      failures.push(`${path}: není použitelný Git checkout`);
      continue;
    }
    const status = runGit(["status", "--porcelain=v1"], absolutePath);
    if (!status.ok) {
      failures.push(`${path}: nejde přečíst git status`);
      continue;
    }
    const dirtyLines = status.stdout.split("\n").filter(Boolean);
    if (dirtyLines.length > 0) {
      warnings.push(`${path}: ${formatCount(dirtyLines.length, "změna", "změny", "změn")}`);
    }
  }

  return {
    id: "git.submodules",
    status: failures.length > 0 ? "fail" : warnings.length > 0 ? "warn" : "ok",
    severity: "required",
    title: "Git submoduly",
    message:
      failures.length > 0
        ? "Některé deklarované submoduly nejsou použitelné."
        : warnings.length > 0
          ? "Některé deklarované submoduly mají lokální změny."
          : `Submoduly jsou použitelné: ${paths.length}`,
    paths: [".gitmodules", ...paths],
    links: [],
    details: [...failures, ...warnings],
  };
}

function gitRepoMountsCheck(companiesRoot, repoMounts) {
  if (repoMounts.length === 0) {
    return {
      id: "git.mounts",
      status: "ok",
      severity: "required",
      title: "Organization Git mountpointy",
      message: "V launchpad.gen3.json nejsou deklarované žádné organization mountpointy.",
      paths: ["launchpad.gen3.json"],
      links: [],
      details: [],
    };
  }

  const failures = [];
  for (const mount of repoMounts) {
    const absolutePath = join(companiesRoot, mount.path);
    if (!existsSync(absolutePath)) {
      failures.push(`${mount.path}: chybí ${mount.kind}`);
      continue;
    }
    const result = runGit(["rev-parse", "--is-inside-work-tree"], absolutePath);
    if (!result.ok || result.stdout !== "true") {
      failures.push(`${mount.path}: ${mount.kind} není Git checkout`);
    }
  }

  return {
    id: "git.mounts",
    status: failures.length > 0 ? "fail" : "ok",
    severity: "required",
    title: "Organization Git mountpointy",
    message: failures.length > 0
      ? "Některé organization mountpointy nejsou Git checkouty."
      : `Organization mountpointy jsou Git checkouty: ${repoMounts.length}`,
    paths: ["launchpad.gen3.json", ...repoMounts.map((mount) => mount.path)],
    links: [],
    details: failures,
  };
}

function gitignoreProtectionCheck(companiesRoot, repoMounts) {
  const failures = [];
  for (const path of rootGitignoreProbePaths) {
    if (!isIgnored(companiesRoot, path)) {
      failures.push(`root: ${path} není chráněné .gitignore`);
    }
  }

  for (const mount of repoMounts) {
    if (mount.kind !== "organization") continue;
    const absolutePath = join(companiesRoot, mount.path);
    if (!existsSync(absolutePath)) continue;
    for (const path of companyGitignoreProbePaths) {
      if (!isIgnored(absolutePath, path)) {
        failures.push(`${mount.path}: ${path} není chráněné .gitignore`);
      }
    }
  }

  return {
    id: "gitignore.protection",
    status: failures.length > 0 ? "fail" : "ok",
    severity: "required",
    title: ".gitignore ochrana",
    message: failures.length > 0
      ? "Některé runtime, log, private nebo archive cesty nejsou chráněné."
      : ".gitignore chrání runtime, log, private a archive cesty.",
    paths: [".gitignore", ...repoMounts.map((mount) => `${mount.path}/.gitignore`)],
    links: [],
    details: failures,
  };
}

function uniqueRepoMounts({ companies, templateMounts = [] }) {
  const mounts = [];
  const seen = new Set();
  for (const company of companies) {
    // Planned Organizace (decision 0024) ještě nemá mount; Git kontroly ji přeskakují.
    if (company.status === "planned") continue;
    addMount(mounts, seen, {
      kind: "organization",
      path: company.path,
    });
  }
  // Module šablony (templates/*/*) se do Git mount gate úmyslně NEpřidávají — jsou
  // informační (scan-first, decision 0042), ne vynucené required-for-first-client
  // mounty. Marker template mounty (organization_kind=template) naopak drží stejné
  // Git mount gates jako firma — musí být řádný Git checkout — ale nepočítají se jako org.
  for (const mount of templateMounts) {
    if (mount.status === "planned") continue;
    addMount(mounts, seen, {
      kind: "organization template",
      template_type: "organization",
      path: mount.path,
    });
  }
  return mounts;
}

function addMount(mounts, seen, mount) {
  if (!mount.path || seen.has(mount.path)) return;
  seen.add(mount.path);
  mounts.push(mount);
}

function gitmodulePaths(cwd) {
  if (!existsSync(join(cwd, ".gitmodules"))) return [];
  const result = runGit(["config", "--file", ".gitmodules", "--get-regexp", "path"], cwd);
  if (!result.ok) return [];
  return result.stdout
    .split("\n")
    .map((line) => line.trim().split(/\s+/).at(-1))
    .filter(Boolean);
}

function isIgnored(cwd, path) {
  return runGit(["check-ignore", "-q", "--", path], cwd).ok;
}

function runGit(args, cwd) {
  const executable = resolveGitExecutableSync();
  if (!executable) {
    return {
      ok: false,
      exitCode: null,
      stdout: "",
      stderr: "",
      error: "Git executable was not found or failed validation.",
    };
  }
  return runCommand(executable, args, { cwd, env: safeGitCommandEnv() });
}

function runCommand(command, args, { cwd, env } = {}) {
  try {
    const result = Bun.spawnSync([command, ...args], {
      cwd,
      ...(env ? { env } : {}),
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
      timeout: GIT_LOCAL_TIMEOUT_MS,
    });
    return {
      ok: result.exitCode === 0,
      exitCode: result.exitCode,
      stdout: decodeOutput(result.stdout).trim(),
      stderr: decodeOutput(result.stderr).trim(),
    };
  } catch (error) {
    return {
      ok: false,
      exitCode: null,
      stdout: "",
      stderr: "",
      error: error.message,
    };
  }
}

function decodeOutput(output) {
  if (!output) return "";
  return new TextDecoder().decode(output);
}

/**
 * Kontrola, která MĚLA běžet a nešla pozorovat (decision 0118). Není to
 * `not_applicable`: předmět kontroly tu je, jen se k němu doctor nedostal —
 * a nepozorování kazí zelenou vždy. `remedy` je povinná schválně: `blocked` bez
 * ní je tichá díra s hezčím jménem.
 */
function blockedCheck({ id, title, message, paths, blockedReason, remedy }) {
  return {
    id,
    status: "blocked",
    severity: "required",
    title,
    message,
    paths,
    links: [],
    details: [],
    blocked_reason: blockedReason,
    remedy,
  };
}

function workspaceSummary(companiesConfig) {
  const workspace = companiesConfig?.launchpad_root ?? companiesConfig?.companies_workspace ?? {};
  return {
    slug: workspace.slug ?? "unknown",
    display_name: workspace.display_name ?? "Lazurio Root",
    root_role: workspace.root_role ?? "launchpad-root",
  };
}

function discoveryCheck(appsResponse) {
  // Starší/ručně sestavené fixtures předávají jen `warnings`; nový apps
  // response drží zvlášť přesné discovery warnings, aby se Git/worktree nález
  // nepromítl do dvou nezávislých Doctor checks.
  const warnings = appsResponse.discovery_warnings ?? appsResponse.warnings ?? [];
  const warningCount = warnings.length;
  const status = appsResponse.failures.length > 0 ? "fail" : warningCount > 0 ? "warn" : "ok";
  // Template mounty jsou validované, ale mimo runtime/business/counts. V Doctor
  // reportu je jen označíme jako template, ať je jasné, že mount existuje a prošel
  // gates, ale záměrně se nespouští a nepočítá se do org přehledů.
  const templateMounts = appsResponse.template_mounts ?? [];
  const templateDetails = templateMounts.map(
    (mount) => `template mount ${mount.path ?? mount.slug} (organization_kind=template): validovaný, mimo runtime/business/counts`,
  );
  return {
    id: "launchpad.discovery",
    status,
    severity: "required",
    title: "Launchpad discovery",
    message:
      status === "ok"
        ? `Launchpad discovery našel ${formatCount(appsResponse.apps.length, "aplikaci", "aplikace", "aplikací")}`
        : status === "warn"
          ? `Launchpad discovery našel ${formatCount(appsResponse.apps.length, "aplikaci", "aplikace", "aplikací")} s ${formatCount(warningCount, "varováním", "varováními", "varováními")}`
          : "Launchpad discovery kontroly selhaly",
    paths: ["launchpad.gen3.json", "launchpad", "organizations"],
    links: [],
    details: [...appsResponse.failures, ...warnings, ...templateDetails],
  };
}

// Doctor i Launchpad čtou stejný owner-aware listener index. Uvnitř jedné
// Organization smí port sdílet jen verze/worktrees stejného module listener
// lease. Oddělené Organizations mohou zachovat stejné číslo; na jednom hostu
// je jejich runtime one-at-a-time a takeover je vždy potvrzený. Port se nikdy
// nepřemapovává.
function portOverlapCheck(appsResponse) {
  const overlaps = appsResponse.port_overlaps ?? [];
  const policyIssues = appsResponse.port_policy_issues ?? [];
  const poolOverlaps = appsResponse.organization_port_pool_overlaps ?? [];
  const moduleDrifts = appsResponse.module_listener_drifts ?? [];
  const conflicts = overlaps.filter((overlap) => overlap.conflict !== false);
  const moduleVersions = overlaps.filter((overlap) => overlap.classification === "module-version-lease");
  const crossOrganizations = overlaps.filter((overlap) => overlap.classification === "cross-organization-lease");
  const details = overlaps.map(({ host = "127.0.0.1", port, classification, claim_group: claimGroup, owners = [] }) => {
    const labels = owners.map((owner) => {
      const listener = owner.listener_id ? `#${owner.listener_id}` : "";
      return `${owner.app_id}${listener} (${owner.package_path})`;
    }).join(", ");
    const claim = claimGroup ? ` group=${claimGroup}` : "";
    return `${host}:${port} [${classification ?? "legacy-overlap"}${claim}]: ${labels}`;
  });
  details.push(...policyIssues);
  details.push(...poolOverlaps.map(({ start, end, organizations = [] }) =>
    `lokální Organization pooly se překrývají na ${start}-${end}: ${organizations.map((item) => item.company).join(", ")}; souběh je možný jen mimo skutečně kolidující module leases`,
  ));
  details.push(...moduleDrifts.map((drift) => {
    const declarations = (drift.declarations ?? [])
      .map(({ endpoint, owners = [] }) => `${endpoint} (${owners.map((owner) => owner.app_id).join(", ")})`)
      .join("; ");
    return `${drift.module_lease}: verze modulu deklarují rozdílné listenery: ${declarations}`;
  }));
  const status = conflicts.length > 0
    || policyIssues.length > 0
    || moduleDrifts.length > 0
    ? "fail"
    : crossOrganizations.length > 0 || poolOverlaps.length > 0
      ? "warn"
      : "ok";
  return {
    id: "launchpad.port_ownership",
    status,
    severity: "runtime",
    title: "Runtime listener claims",
    message: status === "ok"
      ? moduleVersions.length > 0
        ? `${formatCount(moduleVersions.length, "sdílený module-version lease", "sdílené module-version leases", "sdílených module-version leases")}; žádný konflikt.`
        : "Deklarované runtime listenery nemají konflikt ani drift module lease."
      : status === "warn"
        ? `${formatCount(crossOrganizations.length, "skutečný cross-Organization překryv", "skutečné cross-Organization překryvy", "skutečných cross-Organization překryvů")} a ${formatCount(poolOverlaps.length, "lokální překryv poolů", "lokální překryvy poolů", "lokálních překryvů poolů")}; porty zůstávají pevné a převzetí živé aplikace vyžaduje potvrzení.`
        : `${formatCount(conflicts.length, "kolizní listener", "kolizní listenery", "kolizních listenerů")}, ${formatCount(moduleDrifts.length, "drift mezi verzemi", "drifty mezi verzemi", "driftů mezi verzemi")} a ${formatCount(policyIssues.length, "chyba port policy", "chyby port policy", "chyb port policy")}; deklarace musí být opravena.`,
    paths: ["organizations", "lazurio.module.json"],
    links: [],
    details,
  };
}

// Doctor kontrola manifest-declared Workspace groupingu (decision 0041): hlásí
// konflikty deklarace vs. realita a shrnuje readiness stavy module slotů
// (available / missing_access / planned_slot, decision 0042).
function workspaceDeclarationCheck(appsResponse) {
  const details = [];
  const statusCounts = { available: 0, missing_access: 0, planned_slot: 0 };
  let conformanceIssueCount = 0;
  let blockingSlotCount = 0;
  for (const organization of appsResponse.organizations ?? []) {
    for (const issue of organization.workspace_conformance_issues ?? []) {
      details.push(`warning: ${organization.path}: ${issue}`);
      conformanceIssueCount += 1;
    }
    for (const issue of organization.root_slot_contract_issues ?? []) {
      details.push(`blocker: ${organization.path}: ${issue}`);
      blockingSlotCount += 1;
    }
    for (const issue of organization.slot_scope_contract_issues ?? []) {
      details.push(`blocker: ${organization.path}: ${issue}`);
      blockingSlotCount += 1;
    }
    const slots = Array.isArray(organization.module_declarations)
      ? organization.module_declarations
      : [
          ...(organization.workspaces ?? []).flatMap((workspace) => workspace.modules ?? []),
          ...(organization.productionspace?.systems ?? []),
        ];
    for (const slot of slots) {
      if (slot.status && statusCounts[slot.status] !== undefined) statusCounts[slot.status] += 1;
      if (slot.ui_exposure === "diagnostics-only") {
        details.push(
          `info: ${organization.path}/${slot.path}: diagnostics-only data repo (${slot.status ?? "unknown"})`,
        );
      }
      if (slot.readiness?.severity === "blocking") {
        blockingSlotCount += 1;
        details.push(`blocker: ${organization.path}/${slot.path}: ${slot.readiness.message}`);
      }
    }
  }
  details.push(
    `info: module slots: available ${statusCounts.available}, missing_access ${statusCounts.missing_access}, planned_slot ${statusCounts.planned_slot}`,
  );
  return {
    id: "launchpad.workspace_declarations",
    status: blockingSlotCount > 0 ? "fail" : conformanceIssueCount > 0 ? "warn" : "ok",
    severity: "required",
    title: "Workspace deklarace",
    message:
      blockingSlotCount > 0
        ? `Manifestované sloty mají ${formatCount(blockingSlotCount, "blokátor", "blokátory", "blokátorů")}; detaily rozlišují blocker, warning a info.`
        : conformanceIssueCount > 0
        ? `Manifest deklarace mají ${formatCount(conformanceIssueCount, "konflikt", "konflikty", "konfliktů")} s decision 0041; detaily rozlišují warning a info.`
        : "Fyzické sekce odpovídají cestám; Workspace Team grouping jede z manifest deklarací (decision 0041).",
    paths: ["organizations"],
    links: [],
    details,
  };
}

function runtimeChecks(appsResponse) {
  if (appsResponse.failures.length > 0) {
    return [
      {
        id: "launchpad.runtime",
        status: "blocked",
        severity: "runtime",
        title: "Launchpad runtime",
        message: "Runtime diagnostika se nedala provést, protože discovery není validní.",
        paths: ["launchpad"],
        links: [],
        details: [],
        blocked_reason:
          `Discovery skončila s ${appsResponse.failures.length} chybami, takže runtime stav `
          + "aplikací nešel změřit.",
        remedy: "Oprav nálezy kontroly `launchpad.discovery` a spusť doctor znovu.",
      },
    ];
  }

  return [
    runtimeSummaryCheck(appsResponse.apps),
    ...appsResponse.apps.map(runtimeAppCheck),
  ];
}

function runtimeSummaryCheck(apps) {
  const counts = countBy(apps.map((app) => app.runtime_status ?? "unknown"));
  return {
    id: "launchpad.runtime",
    // Tento check potvrzuje, že runtime inventory šlo změřit. Závažnost každé
    // aplikace vlastní přesně jeden `launchpad.runtime.<app-id>` check; kopie
    // nejhoršího child statusu by jednu příčinu započítala do souhrnu dvakrát.
    status: "ok",
    severity: "runtime",
    title: "Launchpad runtime",
    message: `Runtime: ${runtimeCountMessage(counts)}`,
    paths: ["launchpad/runtime", "launchpad/logs"],
    links: [],
    details: [],
  };
}

function runtimeAppCheck(app) {
  const runtime = app.runtime ?? {};
  const dependencies = app.dependencies ?? runtime.dependencies ?? {};
  return {
    id: `launchpad.runtime.${app.id}`,
    status: runtimeAppStatus(app),
    severity: "runtime",
    title: app.title,
    message: dependencies.state && dependencies.state !== "ready"
      ? dependencies.message
      : (runtime.message ?? runtimeLabel(runtime.status)),
    paths: [app.package_path, runtime.log_path].filter(Boolean),
    links: [],
    details: [
      `status: ${runtime.status ?? "unknown"}`,
      `dependency: ${dependencies.state ?? "unknown"}`,
      `install: ${dependencies.install_command_display ?? "-"}`,
      `owner: ${runtime.owner ?? "unknown"}`,
      `pid: ${runtime.pid ?? "-"}`,
      `port: ${app.port ?? "-"}`,
      `health: ${app.health_url ?? "-"}`,
    ],
  };
}

export function runtimeAppStatus(app) {
  const runtime = app.runtime ?? {};
  const dependencyState = app.dependencies?.state ?? runtime.dependencies?.state;
  if (["missing_package", "dependency_boundary_invalid", "missing_lockfile", "unknown_package_manager"].includes(dependencyState)) return "fail";
  // Live occupancy of a valid module-owned static lease is diagnostic only:
  // Start/Open reclaims it under the OS-level module mutex. Legacy or otherwise
  // non-authoritative apps still fail because they have no takeover authority.
  if (runtime.owner === "unknown-port" || runtime.owner === "foreign-port") {
    const ownerPid = runtime.port_owner?.pid;
    const reclaimable = runtimeListenerHasStaticLease(app, app.entrypoint_listener)
      && Number.isInteger(ownerPid)
      && ownerPid > 0;
    return reclaimable ? "warn" : "fail";
  }
  // Nevalidní manifest je scoped attention stav (decision 0043), ne root fail.
  if (dependencyState === "invalid_manifest") return "warn";
  if (dependencyState === "needs_install") return "warn";
  if (runtime.status === "unhealthy") return "warn";
  if (runtime.status === "starting" || runtime.status === "unknown") return "warn";
  return "ok";
}

// Souhrn se odvozuje JEDINOU funkcí surfacu (`buildSummary`/`summarizeStatus`
// v doctor-surface-lib.mjs), aby root nemohl mít vlastní představu o tom, co
// znamená zelená. Lokální kopie odvození tu proto schválně není.

function countBy(values) {
  const counts = {};
  for (const value of values) {
    counts[value] = (counts[value] ?? 0) + 1;
  }
  return counts;
}

function runtimeCountMessage(counts) {
  const order = ["healthy", "starting", "stopped", "unhealthy", "unknown"];
  return order
    .filter((status) => counts[status] > 0)
    .map((status) => `${status}: ${counts[status]}`)
    .join(", ") || "žádné aplikace";
}

function runtimeLabel(status) {
  return (
    {
      healthy: "Aplikace odpovídá.",
      starting: "Aplikace startuje.",
      stopped: "Aplikace neběží.",
      unhealthy: "Aplikace je v runtime problému.",
      unknown: "Runtime stav není známý.",
    }[status] ?? "Runtime stav není známý."
  );
}

function formatCount(count, one, few, many) {
  if (count === 1) return `${count} ${one}`;
  if (count >= 2 && count <= 4) return `${count} ${few}`;
  return `${count} ${many}`;
}
