import { join } from "node:path";

export function launchpadTestTimeout(platform) {
  // Git fixture suites create, push, relocate and clean real repositories. Give
  // those subprocesses time to exit normally so Bun does not kill them at the
  // old 5/15 s boundaries and turn forced teardown into misleading EBUSY errors.
  return platform === "win32" ? 30_000 : 10_000;
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
