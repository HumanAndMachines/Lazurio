const maxFallbackAttempts = 20;
const maxStaleRebindAttempts = 100;
const staleRebindDelayMs = 100;

export function launchpadFallbackUrls({ host = "127.0.0.1", startPort }) {
  return Array.from(
    { length: Math.min(maxFallbackAttempts, 65_536 - startPort) },
    (_, index) => `http://${host}:${startPort + index}`,
  );
}

export async function startLaunchpadWithPortPolicy({
  requestedPort,
  host = "127.0.0.1",
  explicitPort,
  shouldOpen,
  shouldReuse = shouldOpen,
  locatedUrl = null,
  knownServerUrls = [],
  startServer,
  inspectRunningLaunchpad = async () => ({ status: "unrecognized" }),
  shutdownStaleLaunchpad = async () => false,
  openExisting = async () => {},
  waitBeforeStaleRebind = () => new Promise((resolve) => setTimeout(resolve, staleRebindDelayMs)),
}) {
  let locatedObservation = null;
  if (!locatedUrl) {
    const recovered = await findKnownServer({
      urls: knownServerUrls,
      inspectRunningLaunchpad,
    });
    locatedUrl = recovered?.url ?? null;
    locatedObservation = recovered?.observation ?? null;
  }
  if (locatedUrl) {
    const located = locatedObservation ?? await inspectRunningLaunchpad(locatedUrl);
    if (located?.status === "compatible") {
      if (!shouldReuse) {
        throw serverConflict(
          "LAZURIO_SERVER_ALREADY_RUNNING",
          `Lazurio Server pro tento root už běží na ${locatedUrl}.`,
        );
      }
      if (shouldOpen) await openExisting(locatedUrl);
      return { mode: "reused", url: locatedUrl };
    }
    if (located?.status === "stale_install") {
      const shutdownAccepted = await shutdownStaleLaunchpad(locatedUrl, located);
      if (!shutdownAccepted) {
        throw serverConflict(
          "LAZURIO_STALE_SERVER_STOP_FAILED",
          `Starší Lazurio Server pro tento root na ${locatedUrl} se nepodařilo bezpečně zastavit.`,
        );
      }
      await waitForLocatedServerDrain({
        locatedUrl,
        inspectRunningLaunchpad,
        waitBeforeStaleRebind,
      });
    } else if (located?.status === "foreign_root") {
      throw serverConflict(
        "LAZURIO_SERVER_OTHER_ROOT_RUNNING",
        `Na této Mašině už běží Lazurio Server pro jiný Root na ${locatedUrl}. Nejdřív jej zastav.`,
      );
    } else if (located?.status === "legacy_same_root" || located?.status === "protocol_incompatible") {
      throw serverConflict(
        "LAZURIO_SERVER_UPGRADE_REQUIRED",
        `Na ${locatedUrl} běží nekompatibilní Lazurio Server stejného rootu. Zastav ho a spusť Launchpad znovu.`,
      );
    } else if (located?.status === "probe_failed" || located?.status === "unrecognized") {
      throw serverConflict(
        "LAZURIO_SERVER_PROBE_FAILED",
        `Server zapsaný pro tento root na ${locatedUrl} nešlo bezpečně identifikovat; další Server se nespustí.`,
      );
    }
  }

  let candidatePort = requestedPort;

  for (let attempt = 0; attempt < maxFallbackAttempts; attempt += 1) {
    try {
      return { mode: "started", server: startServer(candidatePort) };
    } catch (error) {
      if (!isAddressInUse(error)) throw error;

      const candidateUrl = `http://${host}:${candidatePort}`;
      const observation = await inspectRunningLaunchpad(candidateUrl);
      if (observation?.status === "compatible") {
        if (!shouldReuse) {
          throw serverConflict(
            "LAZURIO_SERVER_ALREADY_RUNNING",
            `Lazurio Server pro tento root už běží na ${candidateUrl}.`,
            error,
          );
        }
        if (shouldOpen) await openExisting(candidateUrl);
        return { mode: "reused", url: candidateUrl };
      }
      if (observation?.status === "stale_install") {
        const shutdownAccepted = await shutdownStaleLaunchpad(candidateUrl, observation);
        if (!shutdownAccepted) {
          throw serverConflict(
            "LAZURIO_STALE_SERVER_STOP_FAILED",
            `Starší Lazurio Server pro tento root na ${candidateUrl} se nepodařilo bezpečně zastavit.`,
            error,
          );
        }
        return startAfterStaleShutdown({
          candidatePort,
          candidateUrl,
          startServer,
          waitBeforeStaleRebind,
          originalError: error,
        });
      }
      if (observation?.status === "legacy_same_root" || observation?.status === "protocol_incompatible") {
        throw serverConflict(
          "LAZURIO_SERVER_UPGRADE_REQUIRED",
          `Na ${candidateUrl} běží nekompatibilní Lazurio Server stejného rootu. Zastav ho a spusť Launchpad znovu.`,
          error,
        );
      }
      if (observation?.status === "probe_failed") {
        throw serverConflict(
          "LAZURIO_SERVER_PROBE_FAILED",
          `Proces na ${candidateUrl} nešlo bezpečně identifikovat; další Server se nespustí.`,
          error,
        );
      }

      if (explicitPort || candidatePort >= 65_535) throw error;
      candidatePort += 1;
    }
  }

  const error = new Error(`Launchpad nenašel volný port po ${maxFallbackAttempts} pokusech od ${requestedPort}.`);
  error.code = "EADDRINUSE";
  throw error;
}

async function findKnownServer({ urls, inspectRunningLaunchpad }) {
  const seen = new Set();
  for (const url of urls) {
    if (seen.has(url)) continue;
    seen.add(url);
    const observation = await inspectRunningLaunchpad(url);
    if ([
      "compatible",
      "stale_install",
      "foreign_root",
      "legacy_same_root",
      "protocol_incompatible",
    ].includes(observation?.status)) {
      return { url, observation };
    }
  }
  return null;
}

async function waitForLocatedServerDrain({
  locatedUrl,
  inspectRunningLaunchpad,
  waitBeforeStaleRebind,
}) {
  for (let attempt = 0; attempt < maxStaleRebindAttempts; attempt += 1) {
    await waitBeforeStaleRebind();
    const observation = await inspectRunningLaunchpad(locatedUrl);
    if (observation?.status === "absent") return;
  }
  throw serverConflict(
    "LAZURIO_STALE_SERVER_DRAIN_TIMEOUT",
    `Starší Lazurio Server neuvolnil ${locatedUrl}; další Server se záměrně nespustil.`,
  );
}

async function startAfterStaleShutdown({
  candidatePort,
  candidateUrl,
  startServer,
  waitBeforeStaleRebind,
  originalError,
}) {
  for (let attempt = 0; attempt < maxStaleRebindAttempts; attempt += 1) {
    await waitBeforeStaleRebind();
    try {
      return { mode: "started", server: startServer(candidatePort) };
    } catch (error) {
      if (!isAddressInUse(error)) throw error;
    }
  }
  throw serverConflict(
    "LAZURIO_STALE_SERVER_DRAIN_TIMEOUT",
    `Starší Lazurio Server neuvolnil ${candidateUrl}; Server na jiném portu se záměrně nespustil.`,
    originalError,
  );
}

function serverConflict(code, message, cause) {
  const error = new Error(message, { cause });
  error.code = code;
  return error;
}

function isAddressInUse(error) {
  return error?.code === "EADDRINUSE" || String(error?.message ?? error).includes("EADDRINUSE");
}
