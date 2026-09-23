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
// workspace symlink out of the space) stay non-fatal, as before: they isolate
// the affected Apps and are reported, and the Launchpad keeps serving.
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
  return Object.freeze({
    state,
    folder: configuration.personalspace,
    mount_path: space?.mount_path ?? mount.mount_path,
    discovery_failures: Object.freeze(failures),
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
    hosted_url_source: configuration.source,
    ...(!hostedUrl ? { hosted_url_error: "hosted_app_url_unavailable" } : {}),
    runtime: app.runtime && typeof app.runtime === "object"
      ? { ...app.runtime, url: hostedUrl }
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
  };
  for (const key of ["runtime", "start", "started", "stop"]) {
    if (payload[key] && typeof payload[key] === "object" && !Array.isArray(payload[key])) {
      projected[key] = projectLifecycleUrls(payload[key], hostedUrl);
    }
  }
  return projected;
}
