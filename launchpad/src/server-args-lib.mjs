export function parseLaunchpadServerArgs(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--open") {
      parsed.open = true;
      continue;
    }
    if (arg === "--reuse") {
      parsed.reuse = true;
      continue;
    }
    if (arg === "--agent-entry") {
      parsed.agentEntry = true;
      continue;
    }
    if (arg === "--personalspace") {
      parsed.personalspace = true;
      continue;
    }
    if (arg.startsWith("--organization=")) {
      parsed.organization = requiredValue(arg.slice("--organization=".length), "--organization");
      continue;
    }
    if (arg === "--organization") {
      parsed.organization = requiredFollowingValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg.startsWith("--port=")) {
      parsed.port = arg.slice("--port=".length);
      continue;
    }
    if (arg === "--port") {
      parsed.port = requiredFollowingValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg.startsWith("--host=")) {
      parsed.host = arg.slice("--host=".length);
      continue;
    }
    if (arg === "--host") {
      parsed.host = requiredFollowingValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg.startsWith("--root=")) {
      parsed.root = arg.slice("--root=".length);
      continue;
    }
    if (arg === "--root") {
      parsed.root = requiredFollowingValue(args, index, arg);
      index += 1;
    }
  }
  if (parsed.organization !== undefined && parsed.personalspace) {
    throw new Error("--organization a --personalspace se vzájemně vylučují.");
  }
  if ((parsed.organization !== undefined || parsed.personalspace) && !parsed.agentEntry) {
    throw new Error("--organization a --personalspace vyžadují interní --agent-entry kontrakt.");
  }
  return parsed;
}

export function assertAvailableAgentEntryOrganization(options, organizations) {
  if (!options?.agentEntry || options.organization === undefined) return;

  const exact = organizations.find(
    (organization) => organization?.slug === options.organization,
  );
  if (exact) return;

  const caseInsensitive = organizations.find(
    (organization) => typeof organization?.slug === "string"
      && organization.slug.toLowerCase() === options.organization.toLowerCase(),
  );
  const error = new Error(
    caseInsensitive
      ? `LAZURIO_LAUNCHPAD_ORGANIZATION_NOT_FOUND: Organization slug "${options.organization}" nemá přesný casing; použij "${caseInsensitive.slug}".`
      : `LAZURIO_LAUNCHPAD_ORGANIZATION_NOT_FOUND: Organization "${options.organization}" není v tomto Lazurio rootu dostupná.`,
  );
  error.code = "LAZURIO_LAUNCHPAD_ORGANIZATION_NOT_FOUND";
  throw error;
}

// Refresh cadences of a running Server. Production always keeps these
// defaults; the variables exist so real-process tests can prove a refresh
// without waiting 10-15 s of wall time.
export function launchpadRefreshIntervals(environment) {
  return {
    appsCacheTtlMs: positiveMilliseconds(environment, "LAZURIO_LAUNCHPAD_APPS_CACHE_TTL_MS", 10_000),
    hostedRefreshIntervalMs: positiveMilliseconds(environment, "LAZURIO_LAUNCHPAD_HOSTED_REFRESH_MS", 15_000),
  };
}

function positiveMilliseconds(environment, name, fallback) {
  const raw = environment?.[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} musí být kladný celý počet milisekund.`);
  }
  return value;
}

function requiredFollowingValue(args, index, name) {
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`Chybí hodnota pro ${name}.`);
  }
  return value;
}

function requiredValue(value, name) {
  if (value === "") throw new Error(`Chybí hodnota pro ${name}.`);
  return value;
}
