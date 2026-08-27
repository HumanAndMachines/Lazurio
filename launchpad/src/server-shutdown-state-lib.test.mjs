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
