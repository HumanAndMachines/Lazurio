const observedSchemaVersion = "lazurio.team_service_observed.v1";

export function createTeamServiceController({
  services,
  catalogRevision,
  ensureService,
  classifyError = defaultErrorClassification,
  concurrency = 4,
  retryDelaysMs = [1_000, 5_000, 30_000, 120_000],
  retryJitterRatio = 0.2,
  stableHealthyMs = 30_000,
  random = Math.random,
  sleep = defaultSleep,
  now = () => Date.now(),
} = {}) {
  if (!(services instanceof Map)) throw new Error("Team service controller requires a services Map.");
  if (typeof ensureService !== "function") throw new Error("Team service controller requires ensureService.");
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error("Team service controller concurrency must be a positive integer.");
  if (!Array.isArray(retryDelaysMs) || retryDelaysMs.length === 0
    || retryDelaysMs.some((delay) => !Number.isFinite(delay) || delay < 0)) {
    throw new Error("Team service controller retryDelaysMs must contain non-negative delays.");
  }
  if (!Number.isFinite(retryJitterRatio) || retryJitterRatio < 0 || retryJitterRatio > 1) {
    throw new Error("Team service controller retryJitterRatio must be between 0 and 1.");
  }

  const entries = new Map([...services].map(([appId, service]) => [appId, {
    service,
    generation: 0,
    attempts: 0,
    running: false,
    queued: false,
    observed: observedState(service, catalogRevision, {
      status: "pending",
      updatedAt: now(),
    }),
  }]));
  const queue = [];
  let active = 0;
  let stopped = false;

  function start() {
    for (const entry of entries.values()) enqueue(entry, "catalog-boot");
    return summary();
  }

  function retry(appId) {
    const entry = requireEntry(appId);
    entry.generation += 1;
    entry.attempts = 0;
    entry.observed = observedState(entry.service, catalogRevision, {
      status: "pending",
      trigger: "explicit-retry",
      updatedAt: now(),
    });
    enqueue(entry, "explicit-retry");
    return snapshot(appId);
  }

  function notifyExit(appId, { exitCode = null } = {}) {
    const entry = entries.get(appId);
    if (!entry || stopped) return null;
    entry.generation += 1;
    entry.running = false;
    entry.queued = false;
    scheduleBackoff(entry, {
      trigger: "child-exit",
      error: `Catalog child exited${exitCode === null ? "" : ` with code ${exitCode}`}.`,
      failureKind: "catalog_child_exit",
    });
    return snapshot(appId);
  }

  function snapshot(appId) {
    const entry = entries.get(appId);
    return entry ? structuredClone(entry.observed) : null;
  }

  function summary() {
    const results = [...entries.values()].map((entry) => structuredClone(entry.observed));
    return {
      schema_version: "lazurio.team_service_controller.v1",
      catalog_revision: catalogRevision,
      total: results.length,
      pending: results.filter((result) => result.status === "pending").length,
      starting: results.filter((result) => result.status === "starting").length,
      healthy: results.filter((result) => result.status === "healthy").length,
      backoff: results.filter((result) => result.status === "backoff").length,
      blocked: results.filter((result) => result.status === "blocked").length,
      services: results,
    };
  }

  function stop() {
    stopped = true;
    queue.splice(0);
    for (const entry of entries.values()) {
      entry.generation += 1;
      entry.queued = false;
    }
  }

  function enqueue(entry, trigger) {
    if (stopped || entry.running || entry.queued) return;
    entry.queued = true;
    queue.push({ entry, trigger, generation: entry.generation });
    drain();
  }

  function drain() {
    while (!stopped && active < concurrency && queue.length > 0) {
      const item = queue.shift();
      item.entry.queued = false;
      if (item.generation !== item.entry.generation || item.entry.running) continue;
      active += 1;
      item.entry.running = true;
      void run(item).finally(() => {
        item.entry.running = false;
        active -= 1;
        drain();
      });
    }
  }

  async function run({ entry, trigger, generation }) {
    if (stopped || generation !== entry.generation) return;
    entry.observed = observedState(entry.service, catalogRevision, {
      status: "starting",
      trigger,
      attempt: entry.attempts + 1,
      updatedAt: now(),
    });
    try {
      const result = await ensureService(entry.service, {
        trigger,
        attempt: entry.attempts + 1,
      });
      if (stopped || generation !== entry.generation) return;
      entry.observed = observedState(entry.service, catalogRevision, {
        status: "healthy",
        trigger,
        attempt: entry.attempts + 1,
        updatedAt: now(),
        runtime: result?.runtime ?? result ?? null,
      });
      scheduleStableReset(entry, generation);
    } catch (error) {
      if (stopped || generation !== entry.generation) return;
      const classification = classifyError(error, entry.service);
      const failureKind = classification.failure_kind
        ?? error?.code
        ?? error?.metadata?.failure_kind
        ?? "catalog_service_failed";
      if (classification.permanent === true) {
        entry.attempts += 1;
        entry.observed = observedState(entry.service, catalogRevision, {
          status: "blocked",
          trigger,
          attempt: entry.attempts,
          updatedAt: now(),
          error: error?.message ?? String(error),
          failureKind,
        });
        return;
      }
      scheduleBackoff(entry, {
        trigger,
        error: error?.message ?? String(error),
        failureKind,
      });
    }
  }

  function scheduleBackoff(entry, { trigger, error, failureKind }) {
    if (stopped) return;
    entry.attempts += 1;
    const delayIndex = Math.min(entry.attempts - 1, retryDelaysMs.length - 1);
    const delayMs = jitteredDelay(retryDelaysMs[delayIndex], retryJitterRatio, random);
    const generation = entry.generation;
    const observedAt = now();
    entry.observed = observedState(entry.service, catalogRevision, {
      status: "backoff",
      trigger,
      attempt: entry.attempts,
      updatedAt: observedAt,
      nextRetryAt: observedAt + delayMs,
      retryDelayMs: delayMs,
      error,
      failureKind,
    });
    void sleep(delayMs).then(() => {
      if (stopped || generation !== entry.generation || entry.observed.status !== "backoff") return;
      enqueue(entry, "catalog-retry");
    });
  }

  function scheduleStableReset(entry, generation) {
    void sleep(stableHealthyMs).then(() => {
      if (stopped || generation !== entry.generation || entry.observed.status !== "healthy") return;
      entry.attempts = 0;
    });
  }

  function requireEntry(appId) {
    const entry = entries.get(appId);
    if (!entry) throw new Error(`App ${appId} is not present in the Team service catalog.`);
    return entry;
  }

  return {
    start,
    retry,
    notifyExit,
    snapshot,
    summary,
    stop,
  };
}

export function jitteredDelay(baseMs, ratio, random = Math.random) {
  if (baseMs === 0 || ratio === 0) return baseMs;
  const sample = Math.min(1, Math.max(0, Number(random())));
  return Math.max(0, Math.round(baseMs * (1 + ratio * ((sample * 2) - 1))));
}

function observedState(service, catalogRevision, {
  status,
  trigger = null,
  attempt = 0,
  updatedAt,
  nextRetryAt = null,
  retryDelayMs = null,
  error = null,
  failureKind = null,
  runtime = null,
}) {
  return {
    schema_version: observedSchemaVersion,
    catalog_revision: catalogRevision,
    app_id: service.app_id,
    module_lease_key: service.module_lease_key,
    source: service.source,
    status,
    trigger,
    attempt,
    updated_at: new Date(updatedAt).toISOString(),
    next_retry_at: nextRetryAt === null ? null : new Date(nextRetryAt).toISOString(),
    retry_delay_ms: retryDelayMs,
    last_error: error,
    failure_kind: failureKind,
    runtime,
  };
}

function defaultErrorClassification(error) {
  return { permanent: Number(error?.status) >= 400 && Number(error?.status) < 500 };
}

function defaultSleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
