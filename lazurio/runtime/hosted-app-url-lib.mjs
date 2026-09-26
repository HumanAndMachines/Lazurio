import { createHash } from "node:crypto";

const organizationSlugPattern = /^[A-Za-z0-9][A-Za-z0-9-]*$/;
const dnsLabelPattern = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const dnsDomainPattern = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
// Hosted application hostnames follow decision 0146 and the Machines gateway
// label rules (Machines docs/workspace-application-entry.md, routes.mjs):
// single-dash-separated labels, Machine label <= 32, application label <= 63,
// gateway labels reserved.
const hostedLabelPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const hostedMachineLabelMax = 32;
const hostedApplicationLabelMax = 63;
const reservedHostedApplicationLabels = new Set(["launchpad", "oauth2", "api", "well-known"]);
// A hosted Workspace serves either one Organization Team (default) or the
// personal Machine of one human Principal (decisions 0153/0154/0155). The
// personal Machine/DNS slug is frozen at creation and never follows a later
// GitHub login rename, so the Personalspace is bound by its exact folder name,
// never by comparing the slug with the current login.
const hostedScopes = new Set(["organization", "personal"]);
const personalHostedDomain = "lazurio.io";
// personalspace/<github-login>_GEN3: one plain folder, no path separators.
const personalspaceFolderPattern = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})_GEN3$/;

export class HostedAppUrlError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "HostedAppUrlError";
    this.code = code;
    this.status = 409;
  }
}

export function parseWorkspaceProfile(value = "local") {
  const profile = String(value ?? "local").trim().toLowerCase() || "local";
  if (!["local", "hosted"].includes(profile)) {
    throw new Error("LAZURIO_WORKSPACE_PROFILE must be local or hosted.");
  }
  return profile;
}

export function parseHostedScope(value = "organization") {
  const scope = String(value ?? "organization").trim().toLowerCase() || "organization";
  if (!hostedScopes.has(scope)) {
    throw new Error("LAZURIO_HOSTED_SCOPE must be organization or personal.");
  }
  return scope;
}

export function hostedWorkspaceConfigurationFromEnvironment(env = process.env) {
  return createHostedWorkspaceConfiguration({
    profile: env.LAZURIO_WORKSPACE_PROFILE,
    scope: env.LAZURIO_HOSTED_SCOPE,
    owner: env.LAZURIO_HOSTED_OWNER,
    personalspace: env.LAZURIO_HOSTED_PERSONALSPACE,
    organizationSlug: env.LAZURIO_ORGANIZATION_SLUG,
    teamId: env.LAZURIO_TEAM_ID,
    domain: env.LAZURIO_HOSTED_DOMAIN,
    machine: env.LAZURIO_HOSTED_MACHINE,
    launchpadExternalOrigin: env.LAZURIO_LAUNCHPAD_EXTERNAL_ORIGIN,
  });
}

export function createHostedWorkspaceConfiguration({
  profile = "local",
  scope = "organization",
  owner = "",
  personalspace = "",
  organizationSlug = "",
  teamId = "",
  domain = "",
  machine = "",
  launchpadExternalOrigin = "",
} = {}) {
  const normalizedProfile = parseWorkspaceProfile(profile);
  if (normalizedProfile === "local") {
    return Object.freeze({
      profile: "local",
      scope: null,
      owner: null,
      personalspace: null,
      organization_slug: null,
      team_id: null,
      domain: null,
      machine: null,
      source: "local-loopback",
    });
  }

  const normalizedScope = parseHostedScope(scope);
  if (normalizedScope === "personal") {
    return createPersonalHostedConfiguration({
      owner,
      personalspace,
      organizationSlug,
      teamId,
      domain,
      machine,
      launchpadExternalOrigin,
    });
  }
  for (const [name, value] of [["LAZURIO_HOSTED_OWNER", owner], ["LAZURIO_HOSTED_PERSONALSPACE", personalspace]]) {
    if (String(value ?? "").trim() !== "") {
      throw new Error(`${name} is valid only with LAZURIO_HOSTED_SCOPE=personal.`);
    }
  }
  if (!organizationSlugPattern.test(organizationSlug)) {
    throw new Error("LAZURIO_ORGANIZATION_SLUG is required for the hosted Workspace profile.");
  }
  if (!dnsLabelPattern.test(teamId)) {
    throw new Error("LAZURIO_TEAM_ID must be a lowercase DNS-safe Team slug.");
  }
  if (!dnsDomainPattern.test(domain)) {
    throw new Error("LAZURIO_HOSTED_DOMAIN must be a lowercase DNS domain without scheme, path, port or wildcard.");
  }

  return Object.freeze({
    profile: "hosted",
    scope: "organization",
    owner: null,
    personalspace: null,
    organization_slug: organizationSlug,
    team_id: teamId,
    domain,
    machine: resolveHostedMachineLabel({ machine, launchpadExternalOrigin, domain }),
    source: "workspace-identity",
  });
}

function createPersonalHostedConfiguration({
  owner,
  personalspace,
  organizationSlug,
  teamId,
  domain,
  machine,
  launchpadExternalOrigin,
}) {
  // A personal Machine holds no Organization repositories; an inherited
  // Organization or Team identity would silently widen its scope.
  const inherited = [
    ["LAZURIO_ORGANIZATION_SLUG", organizationSlug],
    ["LAZURIO_TEAM_ID", teamId],
  ].filter(([, value]) => String(value ?? "").trim() !== "").map(([name]) => name);
  if (inherited.length > 0) {
    throw new Error(
      `${inherited.join(" and ")} must not be set for LAZURIO_HOSTED_SCOPE=personal; a personal Machine serves no Organization.`,
    );
  }
  const normalizedOwner = String(owner ?? "").trim();
  if (!validHostedMachineLabel(normalizedOwner)) {
    throw new Error(
      `LAZURIO_HOSTED_OWNER is required for LAZURIO_HOSTED_SCOPE=personal and must be the frozen personal Machine slug: a lowercase single-dash DNS label of at most ${hostedMachineLabelMax} characters.`,
    );
  }
  const folder = String(personalspace ?? "").trim();
  if (!personalspaceFolderPattern.test(folder)) {
    throw new Error(
      "LAZURIO_HOSTED_PERSONALSPACE is required for LAZURIO_HOSTED_SCOPE=personal and must be the exact folder name under personalspace/ (<github-login>_GEN3, no path separators).",
    );
  }
  if (domain !== personalHostedDomain) {
    throw new Error(`LAZURIO_HOSTED_DOMAIN must be exactly ${personalHostedDomain} for LAZURIO_HOSTED_SCOPE=personal.`);
  }
  const resolvedMachine = resolveHostedMachineLabel({ machine, launchpadExternalOrigin, domain });
  if (resolvedMachine !== normalizedOwner) {
    throw new Error(
      `Personal hosted Machine ${resolvedMachine} must be named after its owner ${normalizedOwner} (https://launchpad.${normalizedOwner}.${domain}).`,
    );
  }
  return Object.freeze({
    profile: "hosted",
    scope: "personal",
    owner: normalizedOwner,
    personalspace: folder,
    organization_slug: null,
    team_id: null,
    domain,
    machine: resolvedMachine,
    source: "workspace-identity",
  });
}

// The Machine label is the <vm> part of https://<app>.<vm>.<domain>/. Machines
// hand it to the Launchpad unit either explicitly or through its own external
// origin, which must have the shape launchpad.<vm>.<domain>; both must agree.
function resolveHostedMachineLabel({ machine, launchpadExternalOrigin, domain }) {
  const explicit = String(machine ?? "").trim();
  if (explicit && !validHostedMachineLabel(explicit)) {
    throw new Error(
      `LAZURIO_HOSTED_MACHINE must be a lowercase single-dash DNS label of at most ${hostedMachineLabelMax} characters.`,
    );
  }
  const origin = String(launchpadExternalOrigin ?? "").trim();
  const derived = origin ? machineLabelFromLaunchpadOrigin(origin, domain) : null;
  if (origin && !derived) {
    throw new Error(
      "LAZURIO_LAUNCHPAD_EXTERNAL_ORIGIN must be https://launchpad.<machine>.<LAZURIO_HOSTED_DOMAIN> with a valid Machine label.",
    );
  }
  if (explicit && derived && explicit !== derived) {
    throw new Error(
      `LAZURIO_HOSTED_MACHINE ${explicit} does not match the Machine label ${derived} in LAZURIO_LAUNCHPAD_EXTERNAL_ORIGIN.`,
    );
  }
  const resolved = explicit || derived;
  if (!resolved) {
    throw new Error(
      "LAZURIO_HOSTED_MACHINE or LAZURIO_LAUNCHPAD_EXTERNAL_ORIGIN (https://launchpad.<machine>.<domain>) must identify the hosted Machine.",
    );
  }
  return resolved;
}

function machineLabelFromLaunchpadOrigin(origin, domain) {
  let url;
  try {
    url = new URL(origin);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.search || url.hash
    || url.pathname !== "/" || (origin !== url.origin && origin !== `${url.origin}/`)) {
    return null;
  }
  const hostname = url.hostname.replace(/\.$/, "").toLowerCase();
  const suffix = `.${domain}`;
  if (!hostname.endsWith(suffix)) return null;
  const prefix = hostname.slice(0, -suffix.length);
  const match = prefix.match(/^launchpad\.([^.]+)$/);
  return match && validHostedMachineLabel(match[1]) ? match[1] : null;
}

function validHostedMachineLabel(label) {
  return typeof label === "string" && hostedLabelPattern.test(label) && label.length <= hostedMachineLabelMax;
}

function validHostedApplicationLabel(label) {
  return typeof label === "string"
    && hostedLabelPattern.test(label)
    && label.length <= hostedApplicationLabelMax
    && !reservedHostedApplicationLabels.has(label);
}

export function hostedLifecycleConfigurationId(configuration) {
  if (configuration?.profile !== "hosted") return null;
  if (configuration.scope === "personal") {
    return createHash("sha256").update(JSON.stringify({
      scope: "personal",
      owner: configuration.owner,
      personalspace: configuration.personalspace,
      domain: configuration.domain,
      machine: configuration.machine,
      routing: "application-hostname-v1",
    })).digest("hex");
  }
  // Organization scope keeps its original hash input byte-for-byte, so an
  // existing hosted Team Workspace keeps its lifecycle identity.
  return createHash("sha256").update(JSON.stringify({
    organization_slug: configuration.organization_slug,
    team_id: configuration.team_id,
    domain: configuration.domain,
    machine: configuration.machine,
    routing: "application-hostname-v1",
  })).digest("hex");
}

export function validateHostedWorkspaceBindings(
  configuration,
  { organizations = [], spaces = [] } = {},
) {
  if (configuration?.profile !== "hosted") return configuration;
  if (configuration.scope === "personal") {
    const space = boundPersonalspace(configuration, spaces);
    if (!space) {
      throw new Error(
        `Hosted personal Workspace Personalspace personalspace/${configuration.personalspace} (LAZURIO_HOSTED_PERSONALSPACE) is not mounted.`,
      );
    }
    if (space.config_valid !== true) {
      throw new Error(
        `Hosted personal Workspace Personalspace ${space.mount_path ?? space.dir_name} has an invalid personal.gen3.json.`,
      );
    }
    return configuration;
  }
  const organization = organizations.find(
    (candidate) => candidate?.slug === configuration.organization_slug,
  );
  if (!organization) {
    throw new Error(`Hosted Workspace Organization ${configuration.organization_slug} is not mounted.`);
  }
  if (!(organization.teams ?? []).some((team) => team?.slug === configuration.team_id)) {
    throw new Error(
      `Hosted Workspace Team ${configuration.team_id} does not belong to ${configuration.organization_slug}.`,
    );
  }
  return configuration;
}

// Hosted personal scope binding state for a running Launchpad. A personal
// Machine is handed to its owner before their private Personalspace repository
// is cloned, and no operator may create or read it (decision 0091). Both
// tolerated states require a clean Personalspace boundary: discovery inspected
// exactly the configured folder, no other folder sits in the mountpoint and
// discovery reports no boundary failure (unreadable mountpoint, a foreign or
// unrecognized space, an invalid owner space). On top of that, "mounted" means
// the configured folder is a valid owner-primary Personalspace and "missing"
// means it does not exist at all. Per-app and per-module failures inside a
// valid owner space (a port lease conflict, an invalid app manifest, a
// workspace symlink out of the space) and discovery warnings stay non-fatal, as
// before: they isolate the affected Apps and are returned as discovery_issues
// for reporting, and the Launchpad keeps serving.
const foreignPersonalspaceFailureCode = "foreign_or_unrecognized_personalspace_dir";

export function resolveHostedPersonalspaceBinding(configuration, discovery = {}) {
  if (configuration?.profile !== "hosted" || configuration.scope !== "personal") {
    throw new Error("Hosted Personalspace binding applies only to LAZURIO_HOSTED_SCOPE=personal.");
  }
  const label = `Hosted personal Workspace Personalspace personalspace/${configuration.personalspace} (LAZURIO_HOSTED_PERSONALSPACE)`;
  const mount = discovery.primary_space_mount;
  const expectedMountPath = `${discovery.mountpoint ?? "personalspace"}/${configuration.personalspace}`;
  // No filesystem evidence about exactly this folder is never a clean state.
  if (!mount || mount.mount_path !== expectedMountPath) {
    throw new Error(`${label} is not mounted; Personalspace discovery did not inspect the configured folder.`);
  }
  const space = boundPersonalspace(configuration, discovery.spaces);
  const state = space ? "mounted" : "missing";
  if (space) {
    validateHostedWorkspaceBindings(configuration, discovery);
  } else if (mount.present !== false) {
    throw new Error(`${label} is not mounted; the folder exists but is not a valid Personalspace of its declared owner.`);
  }
  const subject = space ? `${label} is mounted, but` : `${label} is not mounted, and`;
  const others = Array.isArray(mount.other_directories) ? mount.other_directories : [];
  if (others.length > 0) {
    throw new Error(
      `${subject} the Personalspace mountpoint also holds ${others.join(", ")}; a foreign or differently named Personalspace is never adopted or tolerated beside it (decision 0091).`,
    );
  }
  const failures = Array.isArray(discovery.failures) ? discovery.failures.map(String) : [];
  // Without the structured boundary subset every failure counts as boundary.
  const boundary = Array.isArray(discovery.boundary_failures)
    ? discovery.boundary_failures.map(String)
    : failures;
  const fatal = [...new Set([
    ...boundary,
    ...failures.filter((failure) => failure.includes(foreignPersonalspaceFailureCode)),
  ])];
  if (fatal.length > 0) {
    throw new Error(`${subject} the Personalspace boundary check failed: ${fatal.join("; ")}`);
  }
  // Non-fatal per-app/module issues and warnings, reported but never gating.
  const issues = Array.isArray(discovery.non_fatal_issues)
    ? discovery.non_fatal_issues.map(String)
    : [...new Set([
      ...failures.filter((failure) => !fatal.includes(failure)),
      ...(Array.isArray(discovery.warnings) ? discovery.warnings.map(String) : []),
      ...(Array.isArray(discovery.invalid_apps) ? discovery.invalid_apps : [])
        .flatMap((app) => (app?.manifest_issues ?? []).map((issue) => `${issue} (invalid personal app manifest)`)),
    ])];
  return Object.freeze({
    state,
    folder: configuration.personalspace,
    mount_path: space?.mount_path ?? mount.mount_path,
    discovery_issues: Object.freeze(issues),
  });
}

export function selectHostedWorkspaceApps(configuration, { apps = [], organizations = [] } = {}) {
  if (!validHostedContext(configuration)) return { apps: [], skipped: [] };
  if (configuration.scope === "personal") return selectPersonalHostedApps(configuration, apps);
  const candidates = apps.filter((app) =>
    app?.company === configuration.organization_slug
    && appInHostedScope(app, configuration)
    && typeof app?.module === "string"
  );
  const candidatesByModule = new Map();
  for (const app of candidates) {
    const group = candidatesByModule.get(app.module) ?? [];
    group.push(app);
    candidatesByModule.set(app.module, group);
  }
  const organization = organizations.find(
    (candidate) => candidate?.slug === configuration.organization_slug,
  );
  const declaredModules = (organization?.module_declarations ?? []).filter((slot) =>
    declarationInHostedScope(slot, configuration)
  );
  const representedModules = new Set();
  const modules = declaredModules.map((slot) => {
    // A repository slot is not the manifest-owned Module ID. Bind discovered
    // Apps to their declaration by catalog path before selecting the default.
    const group = typeof slot.path === "string"
      ? candidates.filter((app) => app.module_catalog_path === slot.path)
      : candidatesByModule.get(slot.slug) ?? [];
    const identities = [...new Set(group.map((app) => app.module))];
    for (const identity of identities) representedModules.add(identity);
    return {
      module: identities.length === 1 ? identities[0] : slot.slug,
      group: identities.length <= 1 ? group : [],
      declaredTargetId: slot.apps?.open_target_app_id ?? null,
    };
  });
  // Adding an Organization default must not retire existing candidate-only
  // Workspace modules. Keep the original candidate selection alongside it.
  for (const [module, group] of candidatesByModule) {
    if (!representedModules.has(module)) modules.push({ module, group, declaredTargetId: null });
  }

  const selected = [];
  const skipped = [];
  for (const { module, group, declaredTargetId } of modules.sort(
    (left, right) => left.module.localeCompare(right.module),
  )) {
    const targetIds = [...new Set(group
      .map((app) => app?.module_apps?.open_target_app_id)
      .filter((value) => typeof value === "string" && value !== ""))];
    const targetId = declaredTargetId ?? (targetIds.length === 1 ? targetIds[0] : null);
    const target = targetId
      ? group.find((app) => app.id === targetId)
      : null;
    if (target && validHostedApplicationLabel(module)) {
      selected.push(target);
      continue;
    }
    skipped.push({
      module,
      failure_kind: !validHostedApplicationLabel(module)
        ? "hosted_module_dns_label_invalid"
        : targetIds.length > 1
          ? "hosted_module_open_target_ambiguous"
          : "hosted_module_open_target_missing",
    });
  }
  return { apps: selected, skipped };
}

// Personal scope: every Module of the owner's Personalspace with exactly one
// declared default App. Organization Apps never qualify, whatever their
// placement, because a personal Machine carries no Organization boundary.
function selectPersonalHostedApps(configuration, apps) {
  const groups = new Map();
  for (const app of apps) {
    if (!personalAppOfOwner(app, configuration) || typeof app.module !== "string") continue;
    const group = groups.get(app.module) ?? [];
    group.push(app);
    groups.set(app.module, group);
  }
  const selected = [];
  const skipped = [];
  for (const [module, group] of [...groups].sort(([left], [right]) => left.localeCompare(right))) {
    const defaults = group.filter((app) => personalAppInHostedScope(app, configuration));
    if (defaults.length === 1 && validHostedApplicationLabel(module)) {
      selected.push(defaults[0]);
      continue;
    }
    skipped.push({
      module,
      failure_kind: !validHostedApplicationLabel(module)
        ? "hosted_module_dns_label_invalid"
        : defaults.length > 1
          ? "hosted_module_open_target_ambiguous"
          : "hosted_module_open_target_missing",
    });
  }
  return { apps: selected, skipped };
}

// The exact configured folder is the binding; the owner slug is a DNS name
// only and is never compared with the (renameable) GitHub login.
function boundPersonalspace(configuration, spaces) {
  return (spaces ?? []).find((space) =>
    space?.dir_name === configuration.personalspace
    && space.is_owner_primary === true) ?? null;
}

function personalAppOfOwner(app, configuration) {
  return app?.personal === true
    && app.surface_scope === "private"
    && app.space === configuration.personalspace;
}

function personalAppInHostedScope(app, configuration) {
  return personalAppOfOwner(app, configuration)
    && app.module_contract?.schema_version === "lazurio.module.v1"
    && app.module_contract.id === app.module
    && app.module_app?.declared === true
    && app.module_app.default === true
    && app.runtime_contract?.schema_version === "lazurio.runtime.v1";
}

export function requireHostedAppUrl(app, configuration) {
  if (configuration.profile !== "hosted") return null;
  const url = hostedAppUrl(app, configuration);
  if (url) return url;
  throw new HostedAppUrlError(
    "hosted_app_url_unavailable",
    `Hosted Team Workspace cannot derive an external URL for ${app?.id ?? "this App"}.`,
  );
}

export function projectHostedAppUrl(app, configuration) {
  if (configuration.profile !== "hosted") return app;
  const hostedUrl = hostedAppUrl(app, configuration);
  return {
    ...app,
    url: hostedUrl,
    ...(Object.hasOwn(app, "health_url")
      ? { health_url: projectHostedHealthUrl(app.health_url, hostedUrl) }
      : {}),
    hosted_url_source: configuration.source,
    ...(!hostedUrl ? { hosted_url_error: "hosted_app_url_unavailable" } : {}),
    runtime: app.runtime && typeof app.runtime === "object"
      ? projectLifecycleUrls(app.runtime, hostedUrl)
      : app.runtime,
  };
}

export function projectHostedRuntimePayload(payload, app, configuration) {
  if (configuration.profile !== "hosted" || !payload || typeof payload !== "object" || Array.isArray(payload)) {
    return payload;
  }
  const hostedUrl = hostedAppUrl(app, configuration);
  return {
    ...projectLifecycleUrls(payload, hostedUrl),
    hosted_url_source: configuration.source,
    ...(!hostedUrl ? { hosted_url_error: "hosted_app_url_unavailable" } : {}),
  };
}

// The browser origin of one hosted application (decision 0146): the module
// slug is the application label on the Machine's own hostname. Team scope is
// not part of the name; it decides only whether the Launchpad exposes the App.
export function hostedApplicationOrigin(app, configuration) {
  if (!validHostedContext(configuration)) return null;
  if (configuration.scope === "personal") {
    return personalAppOfOwner(app, configuration) && validHostedApplicationLabel(app?.module)
      ? `https://${app.module}.${configuration.machine}.${configuration.domain}`
      : null;
  }
  if (
    app?.company !== configuration.organization_slug
    || !validHostedApplicationLabel(app?.module)
  ) return null;
  return `https://${app.module}.${configuration.machine}.${configuration.domain}`;
}

function hostedAppUrl(app, configuration) {
  if (!appInHostedScope(app, configuration)) return null;
  const origin = hostedApplicationOrigin(app, configuration);
  return origin ? `${origin}/` : null;
}

function validHostedContext(configuration) {
  if (configuration?.profile === "hosted" && configuration.scope === "personal") {
    return validHostedMachineLabel(configuration.owner)
      && configuration.machine === configuration.owner
      && personalspaceFolderPattern.test(configuration.personalspace ?? "")
      && configuration.domain === personalHostedDomain
      && configuration.organization_slug === null
      && configuration.team_id === null
      && dnsDomainPattern.test(configuration.domain ?? "");
  }
  return configuration?.profile === "hosted"
    && organizationSlugPattern.test(configuration.organization_slug ?? "")
    && dnsLabelPattern.test(configuration.team_id ?? "")
    && dnsDomainPattern.test(configuration.domain ?? "")
    && validHostedMachineLabel(configuration.machine);
}

function declarationInHostedScope(slot, configuration) {
  return slot?.status === "available"
    && slot?.ui_exposure === "module"
    && (slot.space === "root"
      || (slot.space === "workspace" && (slot.teams ?? []).includes(configuration.team_id)));
}

function appInHostedScope(app, configuration) {
  if (configuration?.scope === "personal") return personalAppInHostedScope(app, configuration);
  if (app?.space === "workspace") return (app.teams ?? []).includes(configuration.team_id);
  if (app?.space !== "root") return false;
  const projection = app.module_apps;
  const declaration = projection?.declaration;
  // Root/UI-organization placement alone grants nothing. Only the declared
  // default of an available local module may acquire a hosted lifecycle/URL.
  // Organization-section Workspace modules retain their original Team intent.
  return declarationInHostedScope(declaration, configuration)
    && projection.state === "declared"
    && projection.open_target_source === "declared-default"
    && projection.open_target_app_id === app.id
    && app.module_open_target === true
    && declaration.path === app.module_catalog_path
    && typeof declaration.path === "string" && declaration.path.length > 0
    && projection.contract_path === `${app.organization_path}/${declaration.path}/lazurio.module.json`
    && app.module_contract?.schema_version === "lazurio.module.v1"
    && app.module_contract.id === app.module
    && app.module_contract.company === app.company
    && app.module_app?.declared === true
    && app.module_app.default === true
    && app.runtime_contract?.schema_version === "lazurio.runtime.v1";
}

function projectLifecycleUrls(payload, hostedUrl) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
  const projected = {
    ...payload,
    ...(Object.hasOwn(payload, "url") ? { url: payload.url ? hostedUrl : null } : {}),
    ...(Object.hasOwn(payload, "health_url")
      ? { health_url: projectHostedHealthUrl(payload.health_url, hostedUrl) }
      : {}),
  };
  for (const key of ["runtime", "start", "started", "stop"]) {
    if (payload[key] && typeof payload[key] === "object" && !Array.isArray(payload[key])) {
      projected[key] = projectLifecycleUrls(payload[key], hostedUrl);
    }
  }
  return projected;
}

// A projected URL is exactly the public origin plus a path: query and
// fragment never cross, and a path that names another address fails closed.
function projectHostedHealthUrl(healthUrl, hostedUrl) {
  if (!healthUrl || !hostedUrl) return null;
  try {
    const path = safeHostedPublicPath(new URL(healthUrl).pathname);
    return path ? `${new URL(hostedUrl).origin}${path}` : null;
  } catch {
    return null;
  }
}

// Fail-closed public projection of hosted JSON. A hosted browser reaches this
// server only through the gateway, so nothing about the Machine's internal
// network or process output may leave it. The projection is an allowlist:
// - URL fields (`url`, `*_url`) survive only when their origin is exactly one
//   of this Machine's derived public HTTPS origins; anything else is null;
// - `host` fields are always null (the public origin is the only address);
// - every other string is free text: every URL of any scheme, IPv4/IPv6
//   literal and dotted host:port is replaced by a neutral token, public or not;
// - message fields are one bounded line without log tails or control chars;
// - diagnostics that may carry log output are dropped.
// Owner note content (gbrain) is deliberately outside this projection.
const hostedRedactionToken = "[redacted]";
const hostedOmittedKeys = new Set(["details", "log_excerpt", "startup_log", "stderr", "stdout", "stack"]);
const hostedMessageKeys = new Set(["message", "last_error"]);
const hostedMessageMaxLength = 300;
const hostedFreeTextPatterns = [
  // Any URL, any scheme.
  /[a-z][a-z0-9+.-]*:\/\/[^\s"'<>`]*/gi,
  // Bracketed IPv6 literal, optional port.
  /\[[0-9a-f:.%a-z]*:[0-9a-f:.%a-z]*\](?::\d{1,5})?/gi,
  // IPv4 literal, optional port.
  /(?<![\d.])\d{1,3}(?:\.\d{1,3}){3}(?::\d{1,5})?(?!\.?\d)/g,
  // Dotted hostname or localhost with a port.
  /(?<![\w.-])(?:(?:[a-z0-9-]+\.)+[a-z0-9-]+|localhost):\d{1,5}(?!\d)/gi,
  /(?<![\w.-])(?:[a-z0-9-]+\.)*localhost(?![\w-])/gi,
];
// Bare IPv6 literal (compressed "::" or full eight groups), optional %zone.
const hostedBareIpv6Pattern = /(?<![\w:])[0-9a-f]{0,4}(?::[0-9a-f]{0,4}){2,7}(?:%[\w.-]+)?(?![\w:])/gi;
// Line/paragraph separators and every C0/C1 control character.
const hostedLineBreakPattern = /[\r\n\u0085\u2028\u2029]/;
const hostedControlPattern = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;

// The exact public HTTPS origins a hosted response may name: the selected
// Apps' derived origins plus explicit gateway origins (Launchpad, T3).
export function hostedPublicOrigins(configuration, apps = [], extraOrigins = []) {
  const origins = new Set();
  if (configuration?.profile !== "hosted") return origins;
  for (const app of apps) {
    const url = app ? hostedAppUrl(app, configuration) : null;
    if (url) origins.add(new URL(url).origin);
  }
  for (const candidate of extraOrigins) {
    const origin = publicHttpsOrigin(candidate);
    if (origin) origins.add(origin);
  }
  return origins;
}

export function projectHostedPublicJson(value, configuration, allowedOrigins = new Set()) {
  if (configuration?.profile !== "hosted") return value;
  return sanitizeHostedValue(value, null, allowedOrigins);
}

// Errors cross the hosted boundary only in this bounded shape: no details,
// metadata, logs or stack, and one redacted line of message.
export function projectHostedErrorPayload({ error, message, app_id: appId, status } = {}) {
  return {
    error: typeof error === "string" && /^[a-z0-9_.-]{1,80}$/i.test(error) ? error : "launchpad_error",
    message: boundedHostedMessage(message),
    ...(typeof appId === "string" && /^[A-Za-z0-9_.-]{1,200}$/.test(appId) ? { app_id: appId } : {}),
    ...(typeof status === "string" && /^[a-z_-]{1,40}$/.test(status) ? { status } : {}),
  };
}

export function redactHostedInternalText(value) {
  const redacted = redactHostedLiterals(String(value));
  if (!/%[0-9a-f]{2}/i.test(redacted)) return redacted;
  // Percent-encoding must not smuggle an address past the literal patterns:
  // when the ASCII-decoded text still names one, return its redacted form.
  const decoded = decodeHostedAscii(redacted);
  const redactedDecoded = redactHostedLiterals(decoded);
  return redactedDecoded === decoded ? redacted : redactedDecoded;
}

function redactHostedLiterals(text) {
  let result = text;
  for (const pattern of hostedFreeTextPatterns) result = result.replace(pattern, hostedRedactionToken);
  return result.replace(hostedBareIpv6Pattern, (candidate) =>
    candidate.includes("::") || candidate.split(":").length === 8 ? hostedRedactionToken : candidate);
}

// Lenient, bounded ASCII percent-decoding (never throws); addresses are ASCII.
function decodeHostedAscii(text) {
  let decoded = text;
  for (let round = 0; round < 3; round += 1) {
    const next = decoded.replace(/%([0-7][0-9a-f])/gi, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)));
    if (next === decoded) break;
    decoded = next;
  }
  return decoded;
}

function boundedHostedMessage(value) {
  // A log tail or anything after a line break never belongs to the message.
  const firstLine = String(value ?? "").split(hostedLineBreakPattern, 1)[0]
    .replace(/\s*(?:Poslední log|Last log):.*$/i, "");
  const redacted = redactHostedInternalText(firstLine)
    .replace(hostedControlPattern, " ")
    .replace(/\s+/g, " ")
    .trim();
  return redacted.length > hostedMessageMaxLength
    ? `${redacted.slice(0, hostedMessageMaxLength - 1)}…`
    : redacted;
}

function sanitizeHostedValue(value, key, allowedOrigins) {
  if (key === "host") return null;
  if (typeof value === "string") {
    if (key === "url" || key?.endsWith("_url")) return allowlistedHostedUrl(value, allowedOrigins);
    return hostedMessageKeys.has(key) ? boundedHostedMessage(value) : redactHostedInternalText(value);
  }
  if (Array.isArray(value)) return value.map((item) => sanitizeHostedValue(item, null, allowedOrigins));
  if (value && typeof value === "object") {
    const projected = {};
    for (const [entryKey, entryValue] of Object.entries(value)) {
      if (hostedOmittedKeys.has(entryKey)) continue;
      projected[entryKey] = sanitizeHostedValue(entryValue, entryKey, allowedOrigins);
    }
    return projected;
  }
  return value;
}

function allowlistedHostedUrl(value, allowedOrigins) {
  try {
    const url = new URL(value);
    if (url.username || url.password || !allowedOrigins.has(url.origin)) return null;
    const path = safeHostedPublicPath(url.pathname);
    return path ? `${url.origin}${path}` : null;
  } catch {
    return null;
  }
}

function publicHttpsOrigin(candidate) {
  try {
    const url = new URL(candidate);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    const hostname = url.hostname.replace(/^\[(.*)\]$/, "$1");
    // Only DNS names qualify; an address literal is never a public origin here.
    if (/^[\d.]+$/.test(hostname) || hostname.includes(":") || hostname === "localhost"
      || hostname.endsWith(".localhost")) return null;
    return url.origin;
  } catch {
    return null;
  }
}

// The path of a projected URL, or null when its decoded form carries a URL,
// scheme, address literal, host:port or control character.
function safeHostedPublicPath(pathname) {
  if (typeof pathname !== "string" || !pathname.startsWith("/")) return null;
  let decoded = pathname;
  try {
    for (let round = 0; round < 3; round += 1) {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    }
  } catch {
    return null;
  }
  if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029\\]|%[0-9a-f]{2}/i.test(decoded)) return null;
  if (/[a-z][a-z0-9+.-]*:\//i.test(decoded)) return null;
  return redactHostedInternalText(decoded) === decoded ? pathname : null;
}
