import { createHash } from "node:crypto";

const organizationSlugPattern = /^[A-Za-z0-9][A-Za-z0-9-]*$/;
const dnsLabelPattern = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const dnsDomainPattern = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

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

export function createHostedWorkspaceConfiguration({
  profile = "local",
  organizationSlug = "",
  teamId = "",
  domain = "",
} = {}) {
  const normalizedProfile = parseWorkspaceProfile(profile);
  if (normalizedProfile === "local") {
    return Object.freeze({
      profile: "local",
      organization_slug: null,
      team_id: null,
      domain: null,
      source: "local-loopback",
    });
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
    organization_slug: organizationSlug,
    team_id: teamId,
    domain,
    source: "workspace-identity",
  });
}

export function hostedLifecycleConfigurationId(configuration) {
  if (configuration?.profile !== "hosted") return null;
  return createHash("sha256").update(JSON.stringify({
    organization_slug: configuration.organization_slug,
    team_id: configuration.team_id,
    domain: configuration.domain,
  })).digest("hex");
}

export function validateHostedWorkspaceBindings(
  configuration,
  { organizations = [] } = {},
) {
  if (configuration?.profile !== "hosted") return configuration;
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

export function selectHostedWorkspaceApps(configuration, { apps = [], organizations = [] } = {}) {
  if (!validHostedContext(configuration)) return { apps: [], skipped: [] };
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
    if (target && dnsLabelPattern.test(module)) {
      selected.push(target);
      continue;
    }
    skipped.push({
      module,
      failure_kind: !dnsLabelPattern.test(module)
        ? "hosted_module_dns_label_invalid"
        : targetIds.length > 1
          ? "hosted_module_open_target_ambiguous"
          : "hosted_module_open_target_missing",
    });
  }
  return { apps: selected, skipped };
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

function hostedAppUrl(app, configuration) {
  if (
    !validHostedContext(configuration)
    || app?.company !== configuration.organization_slug
    || !appInHostedScope(app, configuration)
    || !dnsLabelPattern.test(app?.module ?? "")
  ) return null;
  return `https://${app.module}.${configuration.team_id}.${configuration.domain}/`;
}

function validHostedContext(configuration) {
  return configuration?.profile === "hosted"
    && organizationSlugPattern.test(configuration.organization_slug ?? "")
    && dnsLabelPattern.test(configuration.team_id ?? "")
    && dnsDomainPattern.test(configuration.domain ?? "");
}

function declarationInHostedScope(slot, configuration) {
  return slot?.status === "available"
    && slot?.ui_exposure === "module"
    && (slot.space === "root"
      || (slot.space === "workspace" && (slot.teams ?? []).includes(configuration.team_id)));
}

function appInHostedScope(app, configuration) {
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
