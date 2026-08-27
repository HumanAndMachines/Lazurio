export function createServerShutdownStateAuthority() {
  let state = "starting";
  let activeMutations = 0;

  return {
    get state() {
      return state;
    },

    markRunning() {
      if (state !== "starting") {
        throw new Error(`Server cannot enter running state from ${state}.`);
      }
      state = "running";
    },

    enterMutation() {
      if (state !== "running") return { accepted: false, state };
      activeMutations += 1;
      let active = true;
      return {
        accepted: true,
        release() {
          if (!active) return;
          active = false;
          activeMutations -= 1;
        },
      };
    },

    requestShutdown() {
      if (state !== "running") {
        return { accepted: false, reason: "shutdown_in_progress", state };
      }
      if (activeMutations > 0) {
        return { accepted: false, reason: "server_busy", activeMutations };
      }
      state = "stopping";
      return { accepted: true };
    },
  };
}
