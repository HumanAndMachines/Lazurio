import { join } from "node:path";

export function launchpadTestTimeout(platform) {
  // Git-heavy filesystem tests regularly need just over 15 seconds on the
  // shared Windows runner. Keep the per-test bound, but leave enough headroom
  // that ordinary runner variance does not become a false product failure.
  return platform === "win32" ? 30_000 : 5_000;
}

export function launchpadTestGroups({
  platform,
  requestedTests,
  discoveredTests,
  testRoot,
}) {
  if (platform !== "win32" || requestedTests.length > 0) {
    return [requestedTests];
  }

  const testGroups = discoveredTests
    .filter((path) => path.endsWith(".test.mjs"))
    .sort()
    .map((path) => [join(testRoot, path)]);
  if (testGroups.length === 0) {
    throw new Error(`No Launchpad test files were discovered under ${testRoot}`);
  }
  return testGroups;
}
