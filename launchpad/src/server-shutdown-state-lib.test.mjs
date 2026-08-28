import { expect, test } from "bun:test";
import { createServerShutdownStateAuthority } from "./server-shutdown-state-lib.mjs";

test("an active agent-entry refresh mutation deterministically excludes shutdown", async () => {
  const authority = createServerShutdownStateAuthority();
  authority.markRunning();
  let finishRefresh;
  const refreshMayFinish = new Promise((resolve) => {
    finishRefresh = resolve;
  });
  let announceRefresh;
  const refreshStarted = new Promise((resolve) => {
    announceRefresh = resolve;
  });

  const refresh = (async () => {
    const admission = authority.enterMutation();
    expect(admission.accepted).toBe(true);
    announceRefresh();
    await refreshMayFinish;
    admission.release();
  })();

  await refreshStarted;
  expect(authority.requestShutdown()).toEqual({
    accepted: false,
    reason: "server_busy",
    activeMutations: 1,
  });

  finishRefresh();
  await refresh;
  expect(authority.requestShutdown()).toEqual({ accepted: true });
  expect(authority.enterMutation()).toEqual({ accepted: false, state: "stopping" });
});

test("signal drain closes admission before waiting for active mutations", () => {
  const authority = createServerShutdownStateAuthority();
  authority.markRunning();
  const active = authority.enterMutation();
  expect(active.accepted).toBe(true);

  expect(authority.beginShutdownDrain()).toEqual({ accepted: true, activeMutations: 1 });
  expect(authority.enterMutation()).toEqual({ accepted: false, state: "draining" });
  expect(authority.finishShutdownDrain()).toEqual({
    accepted: false,
    reason: "server_busy",
    activeMutations: 1,
  });

  active.release();
  expect(authority.finishShutdownDrain()).toEqual({ accepted: true });
  expect(authority.enterMutation()).toEqual({ accepted: false, state: "stopping" });
});

test("a second signal can force a draining authority into stopping", () => {
  const authority = createServerShutdownStateAuthority();
  authority.markRunning();
  const active = authority.enterMutation();
  expect(authority.beginShutdownDrain()).toEqual({ accepted: true, activeMutations: 1 });
  expect(authority.forceShutdown()).toEqual({ accepted: true, interruptedMutations: 1 });
  expect(authority.enterMutation()).toEqual({ accepted: false, state: "stopping" });
  active.release();
});
