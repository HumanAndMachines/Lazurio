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
  if (configuration?.profile !== "hosted") return { apps: [], skipped: [] };
  const candidates = apps.filter((app) =>
    app?.company === configuration.organization_slug
    && app?.space === "workspace"
    && (app?.teams ?? []).includes(configuration.team_id)
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
    slot?.space === "workspace"
    && slot?.status === "available"
    && slot?.ui_exposure === "module"
    && slot?.launchpad_section !== "organization"
    && (slot?.teams ?? []).includes(configuration.team_id)
  );
  const modules = declaredModules.length > 0
    ? declaredModules.map((slot) => ({
        module: slot.slug,
        group: candidatesByModule.get(slot.slug) ?? [],
        declaredTargetId: slot.apps?.open_target_app_id ?? null,
      }))
    : [...candidatesByModule].map(([module, group]) => ({
        module,
        group,
        declaredTargetId: null,
      }));

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
    configuration.profile !== "hosted"
    || app?.company !== configuration.organization_slug
    || app?.space !== "workspace"
    || !(app?.teams ?? []).includes(configuration.team_id)
    || !dnsLabelPattern.test(app?.module ?? "")
  ) return null;
  return `https://${app.module}.${configuration.team_id}.${configuration.domain}/`;
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
