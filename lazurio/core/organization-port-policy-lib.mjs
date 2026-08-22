const PORT_POOL_KEYS = new Set(["start", "end"]);

export function normalizeOrganizationPortPool({
  manifest,
  source = "Organization manifest",
} = {}) {
  const candidate = manifest?.module_port_pool;
  if (candidate === undefined || candidate === null) {
    return { pool: null, issues: [] };
  }

  const label = `${source}#module_port_pool`;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return { pool: null, issues: [`${label} musí být object`] };
  }

  const issues = [];
  for (const key of Object.keys(candidate)) {
    if (!PORT_POOL_KEYS.has(key)) issues.push(`${label}.${key} není povolené pole`);
  }
  for (const key of ["start", "end"]) {
    const value = candidate[key];
    if (!Number.isInteger(value) || value < 1024 || value > 65_535) {
      issues.push(`${label}.${key} musí být číslo 1024-65535`);
    }
  }
  if (Number.isInteger(candidate.start)
    && Number.isInteger(candidate.end)
    && candidate.start > candidate.end) {
    issues.push(`${label}.start nesmí být větší než end`);
  }

  return {
    pool: issues.length === 0
      ? { start: candidate.start, end: candidate.end }
      : null,
    issues,
  };
}

export function validateModuleLeasesAgainstOrganizationPools({ modules, organizations }) {
  const issues = [];
  const organizationsBySlug = new Map(
    (organizations ?? [])
      .filter((organization) => organization?.organization_kind !== "template")
      .map((organization) => [organization.slug, organization]),
  );
  const owners = new Map();
  const moduleSources = new Map();

  for (const module of modules ?? []) {
    const moduleKey = `${module.company}/${module.id}`;
    const priorSource = moduleSources.get(moduleKey);
    if (priorSource && priorSource !== module.module_path) {
      issues.push(`${moduleKey} má více module-root manifestů: ${priorSource} a ${module.module_path}`);
      continue;
    }
    moduleSources.set(moduleKey, module.module_path);

    const leases = module.port_leases ?? [];
    if (leases.length === 0) continue;
    const organization = organizationsBySlug.get(module.company);
    // Root-local and Personalspace surfaces also own their exact listener in
    // lazurio.module.json, but they are outside the Organization allocation
    // policy. Organization-scoped discovery separately guarantees that a
    // module's company matches its mount, so an absent Organization here is a
    // deliberate non-Organization scope rather than an escape hatch.
    if (!organization) continue;
    const pool = organization?.module_port_pool;
    const source = organization?.module_port_pool_source
      ?? `${organization?.path ?? module.company}/Organization manifest#module_port_pool`;
    if (!pool) {
      issues.push(`${moduleKey} má port lease, ale jeho Organizace nemá module_port_pool`);
      continue;
    }

    for (const lease of leases) {
      if (lease.port < pool.start || lease.port > pool.end) {
        issues.push(
          `${module.module_path}: lease ${lease.id} port ${lease.port} leží mimo Organization pool ${pool.start}-${pool.end} (${source})`,
        );
      }
      const ownerKey = `${module.company}/${lease.port}`;
      const owner = owners.get(ownerKey);
      if (owner && (
        owner.module !== module.id
        || owner.source !== module.module_path
        || owner.lease !== lease.id
      )) {
        issues.push(
          `port ${lease.port} je v ${module.company} deklarovaný dvakrát: `
          + `${owner.module}/${owner.lease} (${owner.source}) a `
          + `${module.id}/${lease.id} (${module.module_path})`,
        );
      } else {
        owners.set(ownerKey, {
          company: module.company,
          module: module.id,
          lease: lease.id,
          source: module.module_path,
        });
      }
    }
  }
  return issues;
}

export function findLocalOrganizationPortPoolOverlaps(organizations) {
  const pools = (organizations ?? [])
    .filter((organization) => organization?.organization_kind !== "template")
    .filter((organization) => organization?.module_port_pool)
    .map((organization) => ({
      company: organization.slug,
      path: organization.path ?? null,
      ...organization.module_port_pool,
    }))
    .sort((left, right) => left.start - right.start || left.end - right.end || left.company.localeCompare(right.company));

  const overlaps = [];
  for (let leftIndex = 0; leftIndex < pools.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < pools.length; rightIndex += 1) {
      const left = pools[leftIndex];
      const right = pools[rightIndex];
      if (right.start > left.end) break;
      overlaps.push({
        classification: "local-organization-pool-overlap",
        start: Math.max(left.start, right.start),
        end: Math.min(left.end, right.end),
        organizations: [left, right],
      });
    }
  }
  return overlaps;
}

export function nextFreeModulePort({ pool, company, modules }) {
  if (!pool) throw new Error(`Organizace ${company} nemá module_port_pool`);
  const used = new Set(
    (modules ?? [])
      .filter((module) => module.company === company)
      .flatMap((module) => module.port_leases ?? [])
      .map((lease) => lease.port),
  );
  for (let port = pool.start; port <= pool.end; port += 1) {
    if (!used.has(port)) return port;
  }
  throw new Error(`Module port pool ${pool.start}-${pool.end} pro ${company} je vyčerpaný`);
}
