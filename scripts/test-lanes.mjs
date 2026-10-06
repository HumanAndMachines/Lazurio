// Versioned CI test lanes. `bun run check` stays the full suite: Ubuntu runs
// it on every pull request that is not docs-only and on every push to main.
// A lane is an explicit, reviewed subset of it:
//
// - windows: test files that run only on Windows or drive a real Windows OS
//   adapter (PowerShell and cmd shims, taskkill and process identity, `Path`,
//   junctions, long paths, Git for Windows process trees). Windows support is
//   being wound down, so the rest of the suite proves itself on Ubuntu only;
//   simulated `platform: "win32"` cases already run there.
// - docs: tests whose input is tracked documentation Markdown. A docs-only
//   pull request (scripts/ci-change-scope.mjs) runs this lane instead of the
//   full suite, together with the agent skill mirror Doctor.
//
// A listed file that no longer exists fails the lane instead of silently
// shrinking it, and Bun fails a name pattern that matches no test. Each file
// runs in its own Bun process, as the Windows Launchpad runner always has.
import { existsSync } from "node:fs";
import { join } from "node:path";

const repositoryRoot = join(import.meta.dir, "..");
const laneTestTimeoutMs = 60_000;

export const testLanes = Object.freeze({
  windows: Object.freeze([
    { file: "launchpad/src/windows-shortcut-installer.test.mjs" },
    { file: "launchpad/src/windows-launchers.test.mjs" },
    { file: "launchpad/src/windows-system-path-lib.test.mjs" },
    { file: "lazurio/core/tool-invocation-lib.test.mjs" },
    { file: "lazurio/core/toolchain-lib.test.mjs" },
    { file: "lazurio/core/install-core-lib.test.mjs" },
    { file: "lazurio/cli-install.test.mjs" },
    { file: "launchpad/src/git-lib.test.mjs" },
    { file: "launchpad/src/git-inventory-lib.test.mjs" },
    { file: "launchpad/src/git-materialization-lib.test.mjs" },
    { file: "lazurio/core/git-materialization-lib.test.mjs" },
    { file: "launchpad/src/dependency-install-lib.test.mjs" },
    { file: "scripts/agent-skills-entrypoint.test.mjs" },
    { file: "launchpad/src/agent-skills-entrypoint-lib.test.mjs" },
    { file: "scripts/gen2-local-preservation.test.mjs" },
    { file: "lazurio/search.test.mjs" },
    { file: "launchpad/src/module-runtime-lock-lib.test.mjs" },
    { file: "launchpad/src/mission-control-plan-lib.test.mjs" },
    { file: "lazurio/core/path-boundary-lib.test.mjs" },
    { file: "distribution/updater.test.mjs" },
    { file: "launchpad/src/worktree-actions-lib.test.mjs", namePattern: "Windows" },
    { file: "launchpad/src/runtime-lib.test.mjs", namePattern: "Windows" },
  ]),
  docs: Object.freeze([
    { file: "scripts/task-agent-terminology.test.mjs" },
    { file: "scripts/public-example-boundary.test.mjs" },
    { file: "launchpad/src/guide-content-lib.test.mjs" },
    { file: "scripts/lazurio-module-inventory.test.mjs" },
    { file: "scripts/gen2-local-preservation.test.mjs" },
    { file: "distribution/build.test.mjs" },
  ]),
});

export function laneInvocations(lane, { root = repositoryRoot, lanes = testLanes } = {}) {
  const entries = Object.hasOwn(lanes, lane) ? lanes[lane] : null;
  if (!entries) {
    throw new Error(`Unknown test lane "${lane}"; known lanes: ${Object.keys(lanes).join(", ")}.`);
  }
  const missing = entries.filter(({ file }) => !existsSync(join(root, file)));
  if (missing.length > 0) {
    throw new Error(
      `Test lane "${lane}" lists files that do not exist: ${missing.map(({ file }) => file).join(", ")}.`,
    );
  }
  return entries.map(({ file, namePattern }) => {
    // Package tests run from their package root, as in `bun run check`.
    const packageRoot = ["lazurio", "launchpad"].find((name) => file.startsWith(`${name}/`));
    return {
      file,
      cwd: packageRoot ? join(root, packageRoot) : root,
      args: [
        "test",
        "--timeout",
        String(laneTestTimeoutMs),
        ...(namePattern ? ["--test-name-pattern", namePattern] : []),
        join(root, file),
      ],
    };
  });
}

async function runLane(lane) {
  const failures = [];
  for (const invocation of laneInvocations(lane)) {
    const child = Bun.spawn([process.execPath, ...invocation.args], {
      cwd: invocation.cwd,
      env: process.env,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    const exitCode = await child.exited;
    if (exitCode !== 0) failures.push(`${invocation.file} (exit ${exitCode})`);
  }
  if (failures.length > 0) {
    console.error(`[test-lanes] ${lane}: ${failures.length} file(s) failed:\n  ${failures.join("\n  ")}`);
    return 1;
  }
  return 0;
}

if (import.meta.main) {
  const lane = process.argv[2];
  try {
    process.exitCode = await runLane(lane);
  } catch (error) {
    console.error(`[test-lanes] ${error.message}`);
    process.exitCode = 1;
  }
}
