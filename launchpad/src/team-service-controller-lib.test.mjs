import { expect, test } from "bun:test";
import {
  createTeamServiceController,
  jitteredDelay,
} from "../../lazurio/runtime/team-service-controller-lib.mjs";

test("catalog reconciliation starts asynchronously and respects global concurrency", async () => {
  const gates = [];
  let active = 0;
  let peak = 0;
  const controller = createTeamServiceController({
    services: serviceMap("one", "two", "three"),
    catalogRevision: "rev-1",
    concurrency: 2,
    ensureService: async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => gates.push(resolve));
      active -= 1;
      return { runtime: { status: "healthy" } };
    },
    sleep: () => new Promise(() => {}),
  });

  const initial = controller.start();
  expect(initial.total).toBe(3);
  expect(initial.pending + initial.starting).toBe(3);
  await flush();
  expect(active).toBe(2);
  expect(peak).toBe(2);

  gates.shift()();
  await flush();
  expect(active).toBe(2);
  while (gates.length > 0) gates.shift()();
  await flush();
  expect(controller.summary().healthy).toBe(3);
});

test("transient failures retry forever at the capped delay without finite exhaustion", async () => {
  const sleeps = [];
  let attempts = 0;
  const controller = createTeamServiceController({
    services: serviceMap("demo"),
    catalogRevision: "rev-2",
    retryDelaysMs: [10, 20],
    retryJitterRatio: 0,
    stableHealthyMs: 99_999,
    ensureService: async () => {
      attempts += 1;
      throw Object.assign(new Error(`transient-${attempts}`), { status: 500, code: "start_failed" });
    },
    sleep: (delay) => new Promise((resolve) => sleeps.push({ delay, resolve })),
  });

  controller.start();
  await flush();
  expect(controller.snapshot("demo")).toMatchObject({ status: "backoff", retry_delay_ms: 10, attempt: 1 });
  sleeps.shift().resolve();
  await flush();
  expect(controller.snapshot("demo")).toMatchObject({ status: "backoff", retry_delay_ms: 20, attempt: 2 });
  sleeps.shift().resolve();
  await flush();
  expect(controller.snapshot("demo")).toMatchObject({ status: "backoff", retry_delay_ms: 20, attempt: 3 });
  sleeps.shift().resolve();
  await flush();
  expect(controller.snapshot("demo")).toMatchObject({ status: "backoff", retry_delay_ms: 20, attempt: 4 });
  expect(attempts).toBe(4);
});

test("permanent failures block one service until explicit Retry", async () => {
  let fixed = false;
  const controller = createTeamServiceController({
    services: serviceMap("blocked", "healthy"),
    catalogRevision: "rev-3",
    ensureService: async (service) => {
      if (service.app_id === "blocked" && !fixed) {
        throw Object.assign(new Error("missing source"), { status: 404, code: "worktree_not_found" });
      }
      return { runtime: { status: "healthy" } };
    },
    sleep: () => new Promise(() => {}),
  });

  controller.start();
  await flush();
  expect(controller.snapshot("blocked")).toMatchObject({ status: "blocked", failure_kind: "worktree_not_found" });
  expect(controller.snapshot("healthy").status).toBe("healthy");

  fixed = true;
  controller.retry("blocked");
  await flush();
  expect(controller.snapshot("blocked").status).toBe("healthy");
});

test("explicit Retry overlapping an active attempt is not lost", async () => {
  let releaseFirst;
  let attempts = 0;
  const firstAttempt = new Promise((resolve) => { releaseFirst = resolve; });
  const controller = createTeamServiceController({
    services: serviceMap("demo"),
    catalogRevision: "rev-overlap",
    ensureService: async () => {
      attempts += 1;
      if (attempts === 1) await firstAttempt;
      return { runtime: { status: "healthy" } };
    },
    sleep: () => new Promise(() => {}),
  });

  controller.start();
  await flush();
  expect(controller.snapshot("demo").status).toBe("starting");
  controller.retry("demo");
  releaseFirst();
  await flush();
  await flush();

  expect(attempts).toBe(2);
  expect(controller.snapshot("demo")).toMatchObject({
    status: "healthy",
    trigger: "explicit-retry",
  });
});

test("explicit Retry replaces an older queued generation", async () => {
  let releaseFirst;
  const firstAttempt = new Promise((resolve) => { releaseFirst = resolve; });
  const attempts = [];
  const controller = createTeamServiceController({
    services: serviceMap("first", "queued"),
    catalogRevision: "rev-queued-overlap",
    concurrency: 1,
    ensureService: async (service) => {
      attempts.push(service.app_id);
      if (service.app_id === "first") await firstAttempt;
      return { runtime: { status: "healthy" } };
    },
    sleep: () => new Promise(() => {}),
  });

  controller.start();
  await flush();
  controller.retry("queued");
  releaseFirst();
  await flush();
  await flush();

  expect(attempts).toEqual(["first", "queued"]);
  expect(controller.snapshot("queued")).toMatchObject({
    status: "healthy",
    trigger: "explicit-retry",
  });
});

test("a catalog child exit re-enters capped backoff and keeps the immutable source", async () => {
  const sleeps = [];
  const controller = createTeamServiceController({
    services: serviceMap("demo"),
    catalogRevision: "rev-4",
    retryDelaysMs: [50],
    retryJitterRatio: 0,
    ensureService: async () => ({ runtime: { status: "healthy" } }),
    sleep: (delay) => new Promise((resolve) => sleeps.push({ delay, resolve })),
  });
  controller.start();
  await flush();
  expect(controller.snapshot("demo").status).toBe("healthy");

  controller.notifyExit("demo", { exitCode: 7 });
  expect(controller.snapshot("demo")).toMatchObject({
    status: "backoff",
    retry_delay_ms: 50,
    failure_kind: "catalog_child_exit",
    source: { type: "main" },
  });
});

test("jitter stays bounded around the configured capped delay", () => {
  expect(jitteredDelay(1_000, 0.2, () => 0)).toBe(800);
  expect(jitteredDelay(1_000, 0.2, () => 0.5)).toBe(1_000);
  expect(jitteredDelay(1_000, 0.2, () => 1)).toBe(1_200);
});

function serviceMap(...appIds) {
  return new Map(appIds.map((appId) => [appId, {
    app_id: appId,
    module_lease_key: `example/${appId}`,
    external_origin: `https://${appId}.example.test/`,
    source: { type: "main" },
  }]));
}

function flush() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
