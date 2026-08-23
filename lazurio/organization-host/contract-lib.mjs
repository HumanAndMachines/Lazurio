import { isAbsolute, relative, resolve, sep } from "node:path";

export const ORGANIZATION_HOST_ADAPTER_SCHEMA = "lazurio.organization_host.adapter.v1";
export const ORGANIZATION_HOST_READBACK_SCHEMA = "lazurio.organization_host.readback.v1";
export const ORGANIZATION_HOST_CONTRACT_VERSION = 1;

export const ORGANIZATION_HOST_OPERATIONS = Object.freeze([
  "validate",
  "plan",
  "apply",
  "readback",
  "rollback",
]);

export const ORGANIZATION_HOST_HEALTH_CHECKS = Object.freeze([
  "host",
  "workspace",
  "access",
  "runtime",
  "ingress",
  "storage",
]);

const READ_ONLY_OPERATIONS = new Set(["validate", "plan", "readback"]);
const MUTATION_OPERATIONS = new Set(["apply", "rollback"]);
const PROFILE_STATES = new Set(["legacy", "target", "declared"]);
const PIN_KINDS = new Set(["git-commit", "oci-digest", "package-version"]);
const HEALTH_STATUSES = new Set(["pass", "warn", "fail", "not-evaluated"]);
const REASON_CODE = /^[a-z][a-z0-9-]*$/u;
const COMPONENT_ID = /^[a-z][a-z0-9-]*$/u;
const PIN_VALUE = /^[A-Za-z0-9][A-Za-z0-9._+@:/-]*$/u;
const PACKAGE_VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?(?:\+[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/u;
const ADAPTER_ENTRYPOINT = /^(?!\.{1,2}(?:\/|$))[A-Za-z0-9._-]+(?:\/(?!\.{1,2}(?:\/|$))[A-Za-z0-9._-]+)*$/u;

const DECLARATION_KEYS = new Set([
  "schema_version",
  "contract_version",
  "profile_state",
  "topology",
  "runtime_pins",
  "health_checks",
  "logging",
  "recovery",
  "adapter",
  "custody",
]);

const READBACK_KEYS = new Set([
  "schema_version",
  "contract_version",
  "observed_at",
  "profile_state",
  "runtime_pins",
  "health",
  "recovery",
  "next_action",
]);

export function validateOrganizationHostAdapter(declaration) {
  const failures = [];
  if (!isRecord(declaration)) return ["declaration must be an object"];
  rejectUnknownKeys(declaration, DECLARATION_KEYS, "declaration", failures);
  if (declaration.schema_version !== ORGANIZATION_HOST_ADAPTER_SCHEMA) {
    failures.push("unsupported adapter schema_version");
  }
  if (declaration.contract_version !== ORGANIZATION_HOST_CONTRACT_VERSION) {
    failures.push("unsupported contract_version");
  }
  if (!PROFILE_STATES.has(declaration.profile_state)) failures.push("invalid profile_state");

  validateExactObject(declaration.topology, {
    host_kind: "organization-host",
    workspace_isolation: "per-team-runtime",
    workspace_privilege: "non-root",
    workspace_purpose: "private-development-only",
  }, "topology", failures);
  validateRuntimePins(declaration.runtime_pins, "runtime_pins", failures);
  validateExactSet(declaration.health_checks, ORGANIZATION_HOST_HEALTH_CHECKS, "health_checks", failures);
  validateExactObject(declaration.logging, {
    content: "metadata-only",
    secrets: "forbidden",
    retention: "organization-owned",
  }, "logging", failures);
  validateExactObject(declaration.recovery, {
    checkpoint_before_mutation: "required",
    restore_readback: "required",
    clean_rebuild: "required",
    rollback: "required",
  }, "recovery", failures);
  validateAdapter(declaration.adapter, failures);
  validateExactObject(declaration.custody, {
    desired_state: "organization-infra-repository",
    secrets: "organization-local-references-only",
    provider_state: "organization-owned",
    deploy_audit: "organization-infra-repository",
  }, "custody", failures);
  return failures;
}

export function validateOrganizationHostReadback(readback) {
  const failures = [];
  if (!isRecord(readback)) return ["readback must be an object"];
  rejectUnknownKeys(readback, READBACK_KEYS, "readback", failures);
  if (readback.schema_version !== ORGANIZATION_HOST_READBACK_SCHEMA) {
    failures.push("unsupported readback schema_version");
  }
  if (readback.contract_version !== ORGANIZATION_HOST_CONTRACT_VERSION) {
    failures.push("unsupported contract_version");
  }
  if (!isCanonicalUtcTimestamp(readback.observed_at)) failures.push("observed_at is invalid");
  if (!PROFILE_STATES.has(readback.profile_state)) failures.push("invalid profile_state");

  if (!Array.isArray(readback.runtime_pins) || readback.runtime_pins.length === 0) {
    failures.push("runtime_pins must be a non-empty array");
  } else {
    const seen = new Set();
    for (const [index, pin] of readback.runtime_pins.entries()) {
      const label = `runtime_pins[${index}]`;
      if (!isRecord(pin)) {
        failures.push(`${label} must be an object`);
        continue;
      }
      rejectUnknownKeys(
        pin,
        new Set(["component", "kind", "observation", "declared", "observed"]),
        label,
        failures,
      );
      if (!COMPONENT_ID.test(pin.component ?? "")) failures.push(`${label}.component is invalid`);
      if (seen.has(pin.component)) failures.push(`${label}.component is duplicated`);
      seen.add(pin.component);
      if (!PIN_KINDS.has(pin.kind)) failures.push(`${label}.kind is invalid`);
      if (!["observed", "missing", "not-evaluated"].includes(pin.observation)) {
        failures.push(`${label}.observation is invalid`);
      }
      validatePinValue(pin.kind, pin.declared, `${label}.declared`, failures);
      if (pin.observed !== null) validatePinValue(pin.kind, pin.observed, `${label}.observed`, failures);
      if (pin.observation === "observed" && pin.observed === null) {
        failures.push(`${label}.observation observed requires an observed value`);
      }
      if (["missing", "not-evaluated"].includes(pin.observation) && pin.observed !== null) {
        failures.push(`${label}.observation ${pin.observation} requires a null observed value`);
      }
    }
  }

  if (!isRecord(readback.health)) {
    failures.push("health must be an object");
  } else {
    rejectUnknownKeys(readback.health, new Set(["overall", "checks"]), "health", failures);
    if (!HEALTH_STATUSES.has(readback.health.overall)) failures.push("health.overall is invalid");
    if (!isRecord(readback.health.checks)) {
      failures.push("health.checks must be an object");
    } else {
      rejectUnknownKeys(
        readback.health.checks,
        new Set(ORGANIZATION_HOST_HEALTH_CHECKS),
        "health.checks",
        failures,
      );
      for (const id of ORGANIZATION_HOST_HEALTH_CHECKS) {
        if (!HEALTH_STATUSES.has(readback.health.checks[id])) {
          failures.push(`health.checks.${id} is invalid`);
        }
      }
      const statuses = ORGANIZATION_HOST_HEALTH_CHECKS.map((id) => readback.health.checks[id]);
      const expectedOverall = statuses.includes("fail")
        ? "fail"
        : statuses.includes("warn")
          ? "warn"
          : statuses.includes("not-evaluated")
            ? "not-evaluated"
            : "pass";
      if (readback.health.overall !== expectedOverall) {
        failures.push("health.overall does not match the individual checks");
      }
    }
  }

  validateEnumObject(readback.recovery, {
    checkpoint: new Set(["verified", "missing", "not-evaluated"]),
    restore: new Set(["verified", "stale", "missing", "not-evaluated"]),
    clean_rebuild: new Set(["verified", "missing", "not-evaluated"]),
    rollback: new Set(["verified", "missing", "not-evaluated"]),
  }, "recovery", failures);

  if (!isRecord(readback.next_action)) {
    failures.push("next_action must be an object");
  } else {
    rejectUnknownKeys(readback.next_action, new Set(["owner", "operation", "reason_code"]), "next_action", failures);
    if (readback.next_action.owner !== "organization-infra-repository") {
      failures.push("next_action.owner is invalid");
    }
    if (readback.next_action.operation !== null
      && !ORGANIZATION_HOST_OPERATIONS.includes(readback.next_action.operation)) {
      failures.push("next_action.operation is invalid");
    }
    if (!REASON_CODE.test(readback.next_action.reason_code ?? "")) {
      failures.push("next_action.reason_code is invalid");
    }
  }
  return failures;
}

export function buildOrganizationHostAdapterInvocation({
  declaration,
  infraRoot,
  operation,
  authorization = {},
}) {
  const failures = validateOrganizationHostAdapter(declaration);
  if (failures.length > 0) throw new Error(`invalid Organization Host adapter: ${failures.join("; ")}`);
  if (!ORGANIZATION_HOST_OPERATIONS.includes(operation)) {
    throw new Error(`unsupported Organization Host operation: ${String(operation)}`);
  }
  if (typeof infraRoot !== "string" || infraRoot.length === 0 || !isAbsolute(infraRoot)) {
    throw new Error("infraRoot must be an absolute path selected by the caller");
  }
  if (MUTATION_OPERATIONS.has(operation)) validateMutationAuthorization(authorization);
  const executable = resolveEntrypoint(infraRoot, declaration.adapter.entrypoint);
  return Object.freeze({
    executable,
    args: Object.freeze([operation, "--json"]),
    cwd: resolve(infraRoot),
    mode: READ_ONLY_OPERATIONS.has(operation) ? "read-only" : "mutation",
  });
}

export function resolveEntrypoint(infraRoot, entrypoint) {
  if (typeof entrypoint !== "string"
    || entrypoint.length === 0
    || !ADAPTER_ENTRYPOINT.test(entrypoint)
    || isAbsolute(entrypoint)
    || entrypoint.includes("\\")
    || entrypoint.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error("adapter.entrypoint must be a canonical relative path");
  }
  const root = resolve(infraRoot);
  const executable = resolve(root, entrypoint);
  const offset = relative(root, executable);
  if (offset === ".." || offset.startsWith(`..${sep}`) || isAbsolute(offset)) {
    throw new Error("adapter.entrypoint escapes the selected infra repository");
  }
  return executable;
}

function validateAdapter(adapter, failures) {
  if (!isRecord(adapter)) {
    failures.push("adapter must be an object");
    return;
  }
  rejectUnknownKeys(adapter, new Set(["interface_version", "transport", "entrypoint", "operations"]), "adapter", failures);
  if (adapter.interface_version !== 1) failures.push("adapter.interface_version is invalid");
  if (adapter.transport !== "stdio-json") failures.push("adapter.transport is invalid");
  try {
    resolveEntrypoint(resolve("organization-infra"), adapter.entrypoint);
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error));
  }
  if (!isRecord(adapter.operations)) {
    failures.push("adapter.operations must be an object");
    return;
  }
  rejectUnknownKeys(adapter.operations, new Set(ORGANIZATION_HOST_OPERATIONS), "adapter.operations", failures);
  for (const operation of ORGANIZATION_HOST_OPERATIONS) {
    const contract = adapter.operations[operation];
    if (!isRecord(contract)) {
      failures.push(`adapter.operations.${operation} must be an object`);
      continue;
    }
    const mutation = MUTATION_OPERATIONS.has(operation);
    const allowed = mutation ? new Set(["mode", "deploy_gate"]) : new Set(["mode"]);
    rejectUnknownKeys(contract, allowed, `adapter.operations.${operation}`, failures);
    if (contract.mode !== (mutation ? "mutation" : "read-only")) {
      failures.push(`adapter.operations.${operation}.mode is invalid`);
    }
    if (mutation && contract.deploy_gate !== "explicit") {
      failures.push(`adapter.operations.${operation}.deploy_gate is invalid`);
    }
  }
}

function validateMutationAuthorization(authorization) {
  const selector = authorization.organizationSelector;
  if (typeof selector !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(selector)) {
    throw new Error("mutation requires an explicit Organization selector");
  }
  if (authorization.planOwnedWorktree !== true) {
    throw new Error("mutation requires a plan-owned worktree");
  }
  if (authorization.reviewedDiff !== true) {
    throw new Error("mutation requires a reviewed diff");
  }
  if (authorization.deployGate !== "explicit") {
    throw new Error("mutation requires an explicit deploy gate");
  }
}

function validateRuntimePins(pins, label, failures) {
  if (!Array.isArray(pins) || pins.length === 0) {
    failures.push(`${label} must be a non-empty array`);
    return;
  }
  const seen = new Set();
  for (const [index, pin] of pins.entries()) {
    const pinLabel = `${label}[${index}]`;
    if (!isRecord(pin)) {
      failures.push(`${pinLabel} must be an object`);
      continue;
    }
    rejectUnknownKeys(pin, new Set(["component", "kind", "value"]), pinLabel, failures);
    if (!COMPONENT_ID.test(pin.component ?? "")) failures.push(`${pinLabel}.component is invalid`);
    if (seen.has(pin.component)) failures.push(`${pinLabel}.component is duplicated`);
    seen.add(pin.component);
    if (!PIN_KINDS.has(pin.kind)) failures.push(`${pinLabel}.kind is invalid`);
    validatePinValue(pin.kind, pin.value, `${pinLabel}.value`, failures);
  }
}

function validatePinValue(kind, value, label, failures) {
  if (!PIN_VALUE.test(value ?? "")) {
    failures.push(`${label} is invalid`);
    return;
  }
  if (kind === "git-commit" && !/^[0-9a-f]{40,64}$/u.test(value)) {
    failures.push(`${label} is not an exact Git commit`);
  }
  if (kind === "oci-digest" && !/^sha256:[0-9a-f]{64}$/u.test(value)) {
    failures.push(`${label} is not an exact OCI digest`);
  }
  if (kind === "package-version" && !PACKAGE_VERSION.test(value)) {
    failures.push(`${label} is not an exact package version`);
  }
}

function validateExactObject(value, expected, label, failures) {
  if (!isRecord(value)) {
    failures.push(`${label} must be an object`);
    return;
  }
  rejectUnknownKeys(value, new Set(Object.keys(expected)), label, failures);
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (value[key] !== expectedValue) failures.push(`${label}.${key} is invalid`);
  }
}

function validateEnumObject(value, expected, label, failures) {
  if (!isRecord(value)) {
    failures.push(`${label} must be an object`);
    return;
  }
  rejectUnknownKeys(value, new Set(Object.keys(expected)), label, failures);
  for (const [key, choices] of Object.entries(expected)) {
    if (!choices.has(value[key])) failures.push(`${label}.${key} is invalid`);
  }
}

function validateExactSet(value, expected, label, failures) {
  if (!Array.isArray(value)) {
    failures.push(`${label} must be an array`);
    return;
  }
  const actual = new Set(value);
  const expectedSet = new Set(expected);
  if (actual.size !== value.length
    || actual.size !== expectedSet.size
    || [...expectedSet].some((item) => !actual.has(item))) {
    failures.push(`${label} must contain each required item exactly once`);
  }
}

function rejectUnknownKeys(value, allowed, label, failures) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) failures.push(`${label}.${key} is not allowed`);
  }
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isCanonicalUtcTimestamp(value) {
  if (typeof value !== "string"
    || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{3})?Z$/u.test(value)) {
    return false;
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return false;
  return new Date(parsed).toISOString() === (value.includes(".") ? value : value.replace("Z", ".000Z"));
}
