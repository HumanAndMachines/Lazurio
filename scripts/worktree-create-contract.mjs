export const PLAN_CODE_PATTERN = /^[A-Z]{2,6}-[0-9]{4}$/;
export const SURFACE_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
export const ENVIRONMENT_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const ENVIRONMENT_NAME_MAX_LENGTH = 64;

const VALUE_OPTIONS = new Set([
  "plan",
  "name",
  "branch",
  "purpose",
  "surface",
  "agent-label",
  "created-by",
  "task-agent-id",
  "thread-id",
  "repository",
]);

export function parseWorktreeCreateArgs(argv) {
  const options = { dryRun: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (!arg.startsWith("--")) {
      throw new Error(`neznámý argument: ${arg}`);
    }
    const key = arg.slice(2);
    if (!VALUE_OPTIONS.has(key)) {
      throw new Error(`neznámý argument: ${arg}`);
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`neúplný argument: ${arg}`);
    }
    options[key] = value;
    index += 1;
  }
  if (options.surface && !SURFACE_PATTERN.test(options.surface)) {
    throw new Error(`--surface má neplatný formát: ${options.surface}`);
  }
  if (Object.hasOwn(options, "name") && !isEnvironmentName(options.name)) {
    throw new Error(
      `--name musí být kebab-case (malá písmena, číslice a jednoduché pomlčky) do ${ENVIRONMENT_NAME_MAX_LENGTH} znaků: ${options.name}`,
    );
  }
  if (
    options["task-agent-id"]
    && options["thread-id"]
    && options["task-agent-id"] !== options["thread-id"]
  ) {
    throw new Error("--task-agent-id a legacy --thread-id si odporují");
  }
  return options;
}

export function isEnvironmentName(value) {
  return typeof value === "string"
    && value.length <= ENVIRONMENT_NAME_MAX_LENGTH
    && ENVIRONMENT_NAME_PATTERN.test(value);
}

// Environment ID je adresář i sidecar prefix v `.worktrees/root`. Environment
// patří jednomu pull requestu, ne celému plánu: bez --name je to basename
// kanonického plan souboru, každý další pull request téhož plánu dostane
// `<KOD>-<name>`. Plán tak smí vlastnit víc environmentů najednou.
export function planEnvironmentId({ planBasename, planCode, name = null }) {
  return name ? `${planCode}-${name}` : planBasename;
}

export function isPlanEnvironmentId(environmentId, { planBasename, planCode }) {
  if (typeof environmentId !== "string" || !PLAN_CODE_PATTERN.test(planCode ?? "")) return false;
  if (environmentId === planBasename) return true;
  const prefix = `${planCode}-`;
  return environmentId.startsWith(prefix) && isEnvironmentName(environmentId.slice(prefix.length));
}
