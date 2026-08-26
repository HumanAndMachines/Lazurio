import {
  readServerLocatorIfPresent,
  resolveServerStateDirectory,
} from "./server-locator-lib.mjs";
import { isValidServerIdentity } from "./server-identity-lib.mjs";

export const MODULE_LIFECYCLE_REPORT_SCHEMA = "lazurio.module_lifecycle.report.v1";
export const MODULE_LIFECYCLE_ACTIONS = new Set(["status", "start", "open", "stop"]);

export async function runModuleLifecycle({
  action,
  selector = null,
  appPackage = null,
  confirmReplaceAppId = null,
  stateDirectory = resolveServerStateDirectory(),
  readLocator = readServerLocatorIfPresent,
  fetchFn = fetch,
} = {}) {
  if (!MODULE_LIFECYCLE_ACTIONS.has(action)) {
    throw new TypeError(`Unsupported Module lifecycle action: ${String(action)}`);
  }
  if (action !== "status" && selector === null) {
    throw new TypeError(`${action} requires an Organization/Module selector.`);
  }
  if (appPackage !== null && selector === null) {
    throw new TypeError("--app-package requires an Organization/Module selector.");
  }
  if (confirmReplaceAppId !== null && !["start", "open"].includes(action)) {
    throw new TypeError("--confirm-replace is supported only by start and open.");
  }

  const requestedSelector = selector === null ? null : parseModuleSelector(selector);
  const requestedPackage = appPackage === null ? null : normalizeAppPackage(appPackage);
  const base = {
    schema_version: MODULE_LIFECYCLE_REPORT_SCHEMA,
    action,
    selector: requestedSelector === null ? null : {
      ...requestedSelector,
      app_package: requestedPackage,
    },
  };

  let locator;
  try {
    locator = await readLocator({ stateDirectory });
  } catch (error) {
    return actionRequired(base, "server_locator_invalid", error.message);
  }
  if (!locator) {
    return actionRequired(
      base,
      "server_unavailable",
      "Lazurio Server neběží. Spusť nainstalovaný Lazurio Launchpad a příkaz zopakuj.",
    );
  }

  const server = await verifyLocatedServer({ locator, fetchFn });
  if (!server.ok) return actionRequired(base, server.reason, server.message);
  if (action !== "status" && server.identity.request_trust_profile !== "local") {
    return actionRequired(
      base,
      "hosted_lifecycle_requires_authenticated_surface",
      "Hosted Workspace lifecycle vyžaduje přihlášený Dashboard/Launchpad surface; lokální CLI nepřenáší browser session ani gateway identitu.",
      { server: serverSummary(locator, server.identity) },
    );
  }

  const inventory = await requestJson(fetchFn, new URL("/api/apps", locator.origin), {
    method: "GET",
  });
  if (!inventory.ok) {
    return failed(base, "server_inventory_unavailable", inventory.message, {
      server: serverSummary(locator, server.identity),
      http_status: inventory.status,
      result: inventory.payload,
    });
  }

  const apps = canonicalModuleApps(inventory.payload?.apps);
  if (action === "status" && requestedSelector === null) {
    return {
      ...base,
      status: "current",
      reason: "module_lifecycle_snapshot_ready",
      server: serverSummary(locator, server.identity),
      apps,
      app: null,
      http_status: 200,
      result: null,
      issues: [],
    };
  }

  const selected = selectModuleApp(apps, {
    selector: requestedSelector,
    appPackage: requestedPackage,
  });
  if (!selected.ok) {
    return actionRequired(base, selected.reason, selected.message, {
      server: serverSummary(locator, server.identity),
      apps: selected.candidates,
    });
  }

  if (action === "status") {
    return {
      ...base,
      status: "current",
      reason: "module_lifecycle_status_ready",
      server: serverSummary(locator, server.identity),
      apps: [],
      app: selected.app,
      http_status: 200,
      result: null,
      issues: [],
    };
  }

  const body = confirmReplaceAppId === null
    ? {}
    : { confirmed: true, replace_app_id: normalizeAppId(confirmReplaceAppId) };
  const response = await requestJson(
    fetchFn,
    new URL(`/api/apps/${encodeURIComponent(selected.app.app_id)}/${action}`, locator.origin),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  const report = {
    ...base,
    status: response.ok ? "completed" : response.status >= 400 && response.status < 500 ? "action_required" : "failed",
    reason: response.ok
      ? `module_lifecycle_${action}_completed`
      : response.payload?.failure_kind ?? response.payload?.error ?? "module_lifecycle_action_failed",
    server: serverSummary(locator, server.identity),
    apps: [],
    app: selected.app,
    http_status: response.status,
    result: response.payload,
    issues: response.ok ? [] : [{
      code: response.payload?.error ?? "module_lifecycle_action_failed",
      message: response.payload?.message ?? response.message,
      action: response.payload?.failure_kind === "cross_organization_takeover_confirmation_required"
        ? `Zopakuj příkaz s --confirm-replace ${response.payload?.replace_app_id ?? "<app-id>"} až po výslovném potvrzení uživatele.`
        : "Vyřeš uvedený problém a zopakuj stejný příkaz.",
    }],
  };
  return report;
}

export function moduleLifecycleExitCode(report) {
  if (report?.status === "current" || report?.status === "completed") return 0;
  if (report?.status === "action_required") return 3;
  return 1;
}

export function renderHumanModuleLifecycle(report) {
  if (report.status === "current" && report.selector === null) {
    return `Lazurio Module runtime: ${report.apps.length} explicitních aplikací · Server ${report.server.origin}`;
  }
  const target = report.app
    ? `${report.app.organization}/${report.app.module} (${report.app.title})`
    : report.selector
      ? `${report.selector.organization}/${report.selector.module}`
      : "Module runtime";
  if (["current", "completed"].includes(report.status)) {
    const url = report.result?.url ?? report.app?.runtime?.url ?? null;
    return `${target}: ${report.reason}${url ? ` · ${url}` : ""}`;
  }
  return `${target}: ${report.issues?.[0]?.message ?? report.reason}`;
}

export function parseModuleSelector(value) {
  if (typeof value !== "string") throw new TypeError("Module selector must be Organization/Module.");
  const segments = value.split("/");
  if (segments.length !== 2 || segments.some((segment) => !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(segment))) {
    throw new TypeError("Module selector musí mít bezpečný tvar Organization/Module.");
  }
  return { organization: segments[0], module: segments[1] };
}

function normalizeAppPackage(value) {
  if (
    typeof value !== "string"
    || value.startsWith("/")
    || value.includes("\\")
    || value.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
    || !value.endsWith("package.json")
  ) {
    throw new TypeError("--app-package musí být bezpečná relativní POSIX cesta končící package.json.");
  }
  return value;
}

function normalizeAppId(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value)) {
    throw new TypeError("--confirm-replace vyžaduje přesné bezpečné App id.");
  }
  return value;
}

async function verifyLocatedServer({ locator, fetchFn }) {
  const response = await requestJson(fetchFn, new URL("/api/lazurio/server-identity", locator.origin), {
    method: "GET",
  });
  if (!response.ok) {
    return {
      ok: false,
      reason: "server_unavailable",
      message: "Lazurio Server locator existuje, ale jeho Server není dostupný.",
    };
  }
  const identity = response.payload;
  if (
    !isValidServerIdentity(identity)
    || identity.root_id !== locator.root_id
    || identity.control_root_id !== locator.control_root_id
    || identity.instance_id !== locator.instance_id
    || identity.install_generation !== locator.install_generation
  ) {
    return {
      ok: false,
      reason: "server_identity_mismatch",
      message: "Lazurio Server neodpovídá přesné instanci publikované v per-user locatoru.",
    };
  }
  return { ok: true, identity };
}

async function requestJson(fetchFn, url, options) {
  let response;
  try {
    response = await fetchFn(url, {
      ...options,
      signal: AbortSignal.timeout(5_000),
    });
  } catch (error) {
    return { ok: false, status: 0, payload: null, message: error.message };
  }
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    return {
      ok: false,
      status: response.status,
      payload: null,
      message: `Lazurio Server vrátil neplatný JSON (HTTP ${response.status}).`,
    };
  }
  return {
    ok: response.ok,
    status: response.status,
    payload,
    message: payload?.message ?? `Lazurio Server vrátil HTTP ${response.status}.`,
  };
}

function canonicalModuleApps(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((app) =>
      typeof app?.id === "string"
      && typeof app?.company === "string"
      && typeof app?.module === "string"
      && app?.module_app?.declared === true
      && app?.module_app?.state === "explicit"
      && typeof app?.module_app?.package === "string")
    .map((app) => ({
      app_id: app.id,
      title: typeof app.title === "string" ? app.title : app.id,
      organization: app.company,
      module: app.module,
      app_package: app.module_app.package,
      default: app.module_app.default === true,
      host: typeof app.host === "string" ? app.host : null,
      port: Number.isInteger(app.port) ? app.port : null,
      url: typeof app.url === "string" ? app.url : null,
      dependencies: projectDependencies(app.dependencies),
      runtime: projectRuntime(app.runtime),
      shared_port_owners: Array.isArray(app.shared_port_owners)
        ? app.shared_port_owners.map((owner) => ({
          app_id: owner?.app_id ?? null,
          organization: owner?.company ?? null,
          host: owner?.host ?? null,
          port: Number.isInteger(owner?.port) ? owner.port : null,
        }))
        : [],
    }))
    .sort((left, right) =>
      left.organization.localeCompare(right.organization)
      || left.module.localeCompare(right.module)
      || left.app_package.localeCompare(right.app_package));
}

function projectDependencies(value) {
  return {
    state: typeof value?.state === "string" ? value.state : "unknown",
    can_start: value?.can_start === true,
    message: typeof value?.message === "string" ? value.message : null,
  };
}

function projectRuntime(value) {
  return {
    status: typeof value?.status === "string" ? value.status : "unknown",
    owner: typeof value?.owner === "string" ? value.owner : null,
    controllable: value?.controllable === true,
    pid: Number.isInteger(value?.pid) ? value.pid : null,
    url: typeof value?.url === "string" ? value.url : null,
  };
}

function selectModuleApp(apps, { selector, appPackage }) {
  const candidates = apps.filter((app) =>
    app.organization.toLowerCase() === selector.organization.toLowerCase()
    && app.module.toLowerCase() === selector.module.toLowerCase());
  if (candidates.length === 0) {
    return {
      ok: false,
      reason: "module_app_not_found",
      message: `Aktivní Lazurio Server nemá explicitní App kontrakt pro ${selector.organization}/${selector.module}.`,
      candidates: [],
    };
  }
  if (appPackage !== null) {
    const explicit = candidates.find((app) => app.app_package === appPackage);
    return explicit
      ? { ok: true, app: explicit }
      : {
        ok: false,
        reason: "module_app_package_not_found",
        message: `${selector.organization}/${selector.module} nedeklaruje App ${appPackage}.`,
        candidates,
      };
  }
  const defaults = candidates.filter((app) => app.default === true);
  if (defaults.length !== 1) {
    return {
      ok: false,
      reason: "module_default_app_unavailable",
      message: `${selector.organization}/${selector.module} musí mít právě jednu Core-projektovanou default App.`,
      candidates,
    };
  }
  return { ok: true, app: defaults[0] };
}

function serverSummary(locator, identity) {
  return {
    state: "ready",
    origin: locator.origin,
    instance_id: identity.instance_id,
    root_id: identity.root_id,
    install_generation: identity.install_generation,
    request_trust_profile: identity.request_trust_profile ?? "unknown",
  };
}

function actionRequired(base, reason, message, extra = {}) {
  const action = reason === "server_unavailable"
    ? "Spusť nainstalovaný Lazurio Launchpad a zopakuj stejný příkaz."
    : reason === "hosted_lifecycle_requires_authenticated_surface"
      ? "Proveď lifecycle akci v přihlášeném Dashboardu nebo hosted Launchpadu."
      : "Spusť diagnostiku Lazurio a zopakuj stejný příkaz.";
  return {
    ...base,
    status: "action_required",
    reason,
    server: extra.server ?? {
      state: "unavailable",
      origin: null,
      instance_id: null,
      root_id: null,
      install_generation: null,
      request_trust_profile: "unknown",
    },
    apps: extra.apps ?? [],
    app: null,
    http_status: 0,
    result: null,
    issues: [{ code: reason, message, action }],
  };
}

function failed(base, reason, message, extra = {}) {
  return {
    ...base,
    status: "failed",
    reason,
    server: extra.server,
    apps: [],
    app: null,
    http_status: extra.http_status ?? 0,
    result: extra.result ?? null,
    issues: [{ code: reason, message, action: "Spusť diagnostiku Lazurio a zopakuj stejný příkaz." }],
  };
}
