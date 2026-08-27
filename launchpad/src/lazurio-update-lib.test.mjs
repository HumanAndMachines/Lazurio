import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import {
  acquireUpdateLock,
  classifyLazurioRepoUpdate,
  readLazurioUpdateStatus,
  runLazurioUpdate,
  updateManagedRepo,
} from "../../lazurio/runtime/lazurio-update-lib.mjs";
import {
  runGit as runGitAsync,
  runGitInPinnedTemporaryChild,
} from "../../lazurio/runtime/git-lib.mjs";
import {
  createLaunchpadGitFixture,
  initGitRepo,
  setOrganizationRepository,
  writeJson,
} from "./git-fixture-helpers.test.mjs";
import { buildRepositoryLocationIssue } from "../../lazurio/core/module-location-repair-contract-lib.mjs";

const cleanup = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function readPortableText(path) {
  return (await readFile(path, "utf8")).replace(/\r\n/g, "\n");
}

test("pure classifier has only current, updated and blocked outcomes", () => {
  const cases = [
    [{}, ["current", "already_current"]],
    [{ directoryOnly: true }, ["current", "directory_only"]],
    [{ mainRelation: "behind" }, ["updated", "fast_forward_available"]],
    [{ branch: "feature" }, ["updated", "main_checkout_required"]],
    [{ dirty: true }, ["updated", "local_changes_preserved"]],
    [{ mainRelation: "ahead" }, ["blocked", "local_main_commits"]],
    [{ mainRelation: "diverged" }, ["blocked", "main_diverged"]],
    [{ operation: "merge" }, ["blocked", "merge_in_progress"]],
    [{ operation: "rebase" }, ["blocked", "rebase_in_progress"]],
    [{ operation: "am" }, ["blocked", "am_in_progress"]],
    [{ detached: true }, ["blocked", "detached_head"]],
    [{ sparseOrHiddenIndex: true }, ["blocked", "hidden_index_state"]],
    [{ expectedBranch: "v3" }, ["blocked", "managed_branch_not_main"]],
  ];
  for (const [input, expected] of cases) {
    const result = classifyLazurioRepoUpdate(input);
    expect([result.state, result.reason]).toEqual(expected);
    expect(["current", "updated", "blocked"]).toContain(result.state);
  }
});

test("internal Organization scope is forwarded to the same inventory reconciler", async () => {
  const fixture = await repositoryFixture("organization-scope");
  const organizations = [{
    slug: "example-organization",
    display_name: "Example Organization",
    path: "organizations/ExampleOrganization_GEN3",
    status: "active",
    default_branch: "main",
    repository: "git@github.com:ExampleOrganization/ExampleOrganization_GEN3.git",
  }];
  const observedScopes = [];

  const report = await runLazurioUpdate({
    rootPath: fixture.working,
    runtimeRoot: join(fixture.sandbox, "runtime"),
    organizations,
    deps: {
      runId: "organization-scope",
      acquireLock: async () => ({ release: async () => {} }),
      buildInventory: async ({ organizations: scoped }) => {
        observedScopes.push(scoped);
        return { repos: [], warnings: [] };
      },
    },
  });

  expect(report.state).toBe("current");
  expect(observedScopes).toEqual([organizations]);
});

test("clean behind checkout fast-forwards and rerun is idempotent", async () => {
  const fixture = await repositoryFixture("behind");
  await addRemoteCommit(fixture, "remote.txt", "remote\n");

  const first = await update(fixture);
  expect(first).toMatchObject({ state: "updated", actions: expect.arrayContaining(["fast_forward"]) });
  expect(await branch(fixture.working)).toBe("main");
  expect(status(fixture.working)).toBe("");
  expect(await readPortableText(join(fixture.working, "remote.txt"))).toBe("remote\n");

  const second = await update(fixture);
  expect(second).toMatchObject({ state: "current", reason: "already_current" });
});

test("an exact markerless checkout fast-forwards to the reviewed commit that publishes its Module marker", async () => {
  const fixture = await repositoryFixture("marker-publication");
  await addRemoteFiles(fixture, {
    "lazurio.module.json": `${JSON.stringify({
      schema_version: "lazurio.module.v1",
      id: "studio",
      company: "TestCo",
    }, null, 2)}\n`,
  }, "publish Module marker");

  const result = await updateManagedRepo({
    ...descriptor(fixture),
    key: "TestCo::studio",
    repo_kind: "module",
    organization: "TestCo",
    module: "studio",
    repo_path: "organizations/TestCo_GEN3/workspace/studio",
  }, {
    runId: "marker-publication",
    deps: { installDependencies: async () => ({ ok: true }) },
  });

  expect(result).toMatchObject({ state: "updated", actions: expect.arrayContaining(["fast_forward"]) });
  expect(await Bun.file(join(fixture.working, "lazurio.module.json")).json()).toEqual({
    schema_version: "lazurio.module.v1",
    id: "studio",
    company: "TestCo",
  });
});

test("dependency refresh runs only for an updated package root", async () => {
  const plain = await repositoryFixture("plain-no-install");
  await addRemoteCommit(plain, "remote.txt", "remote\n");
  let plainInstalls = 0;
  const plainReport = await runRootUpdate(plain, {
    installDependencies: async () => { plainInstalls += 1; return { ok: true }; },
  });
  expect(plainReport.state).toBe("updated");
  expect(plainInstalls).toBe(0);

  const locked = await repositoryFixture("locked-install");
  await addRemoteFiles(locked, {
    "package.json": "{\"name\":\"fixture\",\"private\":true}\n",
    "bun.lock": "# fixture\n",
  }, "add frozen package");
  let lockedInstalls = 0;
  let installEnvironment = null;
  const previousWorkspaceRoot = process.env.COMPANIES_WORKSPACE_ROOT;
  process.env.COMPANIES_WORKSPACE_ROOT = "/stale/working/root";
  let lockedReport;
  try {
    lockedReport = await runRootUpdate(locked, {
      installDependencies: async ({ env }) => {
        lockedInstalls += 1;
        installEnvironment = env;
        return { ok: false, detail: "simulated frozen install failure" };
      },
    });
  } finally {
    if (previousWorkspaceRoot === undefined) delete process.env.COMPANIES_WORKSPACE_ROOT;
    else process.env.COMPANIES_WORKSPACE_ROOT = previousWorkspaceRoot;
  }
  expect(lockedInstalls).toBe(1);
  expect(installEnvironment.COMPANIES_WORKSPACE_ROOT).toBe(locked.working);
  expect(lockedReport.results[0]).toMatchObject({
    state: "blocked",
    reason: "dependency_refresh_failed",
    actions: ["fast_forward"],
    dependencies: [{ ok: false, detail: "simulated frozen install failure" }],
  });
  expect(status(locked.working)).toBe("");
  expect(runGit(locked.working, ["rev-parse", "HEAD"]))
    .toBe(runGit(locked.working, ["rev-parse", "refs/remotes/origin/main"]));
});

test("successful dependency refresh may not leave the checkout dirty", async () => {
  const fixture = await repositoryFixture("install-dirties-checkout");
  await addRemoteFiles(fixture, {
    "package.json": "{\"name\":\"fixture\",\"private\":true}\n",
    "bun.lock": "# fixture\n",
  }, "add package");

  const report = await runRootUpdate(fixture, {
    installDependencies: async ({ cwd }) => {
      await writeFile(join(cwd, "tracked.txt"), "postinstall mutation\n");
      return { ok: true };
    },
  });

  expect(report.results[0]).toMatchObject({
    state: "blocked",
    reason: "dependency_refresh_failed",
    actions: ["fast_forward", "dependencies_refreshed"],
    dependencies: expect.arrayContaining([
      expect.objectContaining({ ok: false, reason: "dependency_refresh_changed_checkout" }),
    ]),
  });
  expect(status(fixture.working)).toContain("tracked.txt");
});

test("dirty tracked, untracked and binary work is verified in a recovery stash and never restored", async () => {
  const fixture = await repositoryFixture("dirty");
  await addRemoteCommit(fixture, "remote.txt", "remote\n");
  await writeFile(join(fixture.working, "tracked.txt"), "local draft\n");
  await writeFile(join(fixture.working, "untracked.bin"), Buffer.from([0, 1, 2, 255]));

  const result = await update(fixture);
  expect(result).toMatchObject({
    state: "updated",
    reason: "local_changes_preserved",
    actions: expect.arrayContaining(["recovery_stash", "fast_forward"]),
  });
  expect(result.recovery_stash).toMatch(/^[0-9a-f]{40}$/);
  expect(status(fixture.working)).toBe("");
  expect(await readPortableText(join(fixture.working, "tracked.txt"))).toBe("tracked\n");
  expect(runGit(fixture.working, ["stash", "show", "--include-untracked", "--name-only", result.recovery_stash]))
    .toContain("untracked.bin");
  expect(runGit(fixture.working, ["stash", "list", "--format=%H"]))
    .toContain(result.recovery_stash);
});

test("registered canonical task worktrees are locally ignored before recovery stash verification", async () => {
  const fixture = await repositoryFixture("registered-worktree-ignore");
  const worktreeRelative = ".worktrees/root/DEV-6505-fixture";
  const worktreeRoot = join(fixture.working, ...worktreeRelative.split("/"));
  await mkdir(join(fixture.working, ".worktrees", "root"), { recursive: true });
  runGit(fixture.working, ["worktree", "add", "-b", "codex/DEV-6505-fixture", worktreeRoot, "HEAD"]);
  await writeFile(`${worktreeRoot}.worktree.json`, "{}\n");
  await addRemoteCommit(fixture, "remote.txt", "remote\n");

  expect(status(fixture.working)).toContain(".worktrees/");
  const result = await update(fixture);

  expect(result).toMatchObject({
    state: "updated",
    reason: "checkout_updated",
    actions: ["worktree_ignore_repaired", "fast_forward"],
    recovery_stash: null,
  });
  expect(status(fixture.working)).toBe("");
  expect(runGitResult(fixture.working, ["check-ignore", "--quiet", "--no-index", "--", ".worktrees/"]).status).toBe(1);
  expect(runGitResult(fixture.working, ["check-ignore", "--quiet", "--no-index", "--", worktreeRelative]).status).toBe(0);
  expect(runGitResult(fixture.working, ["check-ignore", "--quiet", "--no-index", "--", `${worktreeRelative}.worktree.json`]).status).toBe(0);
  const worktreeList = runGit(fixture.working, ["worktree", "list", "--porcelain"]);
  expect(worktreeList).toContain("branch refs/heads/codex/DEV-6505-fixture");
  expect(runGit(worktreeRoot, ["rev-parse", "HEAD"]))
    .toBe(runGit(fixture.working, ["rev-parse", "codex/DEV-6505-fixture"]));

  await writeFile(join(fixture.working, ".worktrees", "notes.txt"), "keep me\n");
  await writeFile(`${worktreeRoot}.worktree.json.unexpected`, "keep me too\n");
  const unknownData = await update(fixture);
  expect(unknownData).toMatchObject({
    state: "updated",
    reason: "local_changes_preserved",
    actions: ["recovery_stash"],
  });
  const stashedPaths = runGit(fixture.working, [
    "stash", "show", "--include-untracked", "--name-only", unknownData.recovery_stash,
  ]);
  expect(stashedPaths).toContain(".worktrees/notes.txt");
  expect(stashedPaths).toContain(".worktrees/root/DEV-6505-fixture.worktree.json.unexpected");
  expect(runGit(worktreeRoot, ["rev-parse", "HEAD"]))
    .toBe(runGit(fixture.working, ["rev-parse", "codex/DEV-6505-fixture"]));
});

test("registered worktree paths are literal Git exclusions rather than wildcard patterns", async () => {
  const fixture = await repositoryFixture("registered-worktree-glob-literal");
  const worktreeRelative = ".worktrees/root/DEV-6505-[fixture]";
  const worktreeRoot = join(fixture.working, ...worktreeRelative.split("/"));
  const siblingData = join(fixture.working, ".worktrees", "root", "DEV-6505-f", "notes.txt");
  await mkdir(join(fixture.working, ".worktrees", "root"), { recursive: true });
  runGit(fixture.working, ["worktree", "add", "-b", "codex/DEV-6505-glob-fixture", worktreeRoot, "HEAD"]);
  await writeFile(`${worktreeRoot}.worktree.json`, "{}\n");
  await mkdir(join(fixture.working, ".worktrees", "root", "DEV-6505-f"), { recursive: true });
  await writeFile(siblingData, "keep me\n");

  const result = await update(fixture);

  expect(result).toMatchObject({
    state: "updated",
    reason: "local_changes_preserved",
    actions: ["worktree_ignore_repaired", "recovery_stash"],
  });
  const exclude = await readPortableText(join(fixture.working, ".git", "info", "exclude"));
  expect(exclude).toContain("/.worktrees/root/DEV-6505-\\[fixture\\]/");
  expect(runGit(fixture.working, [
    "stash", "show", "--include-untracked", "--name-only", result.recovery_stash,
  ])).toContain(".worktrees/root/DEV-6505-f/notes.txt");
  expect(runGit(worktreeRoot, ["rev-parse", "HEAD"]))
    .toBe(runGit(fixture.working, ["rev-parse", "codex/DEV-6505-glob-fixture"]));
});

test("registered worktree paths with line breaks fail closed before info/exclude mutation", async () => {
  const fixture = await repositoryFixture("registered-worktree-line-break");
  await mkdir(join(fixture.working, ".worktrees"), { recursive: true });
  await writeFile(join(fixture.working, ".worktrees", "notes.txt"), "keep me\n");
  const unsafePath = join(
    await realpath(fixture.working),
    ".worktrees",
    "root",
    "DEV-6505-fixture\ninjected",
  );

  const result = await updateManagedRepo(descriptor(fixture), {
    runId: "line-break-worktree",
    deps: {
      installDependencies: async () => ({ ok: true }),
      inspectLocalRepo: async () => ({
        ok: true,
        directoryOnly: false,
        branch: "main",
        head: "a".repeat(40),
        operation: null,
        dirtyPaths: [".worktrees/notes.txt"],
        sparseOrHiddenIndex: false,
      }),
      runGit: async (args, options) => args[0] === "worktree" && args[1] === "list"
        ? { ok: true, stdout: `worktree ${unsafePath}\0`, stderr: "", exitCode: 0 }
        : runGitAsync(args, options),
    },
  });

  expect(result).toMatchObject({
    state: "blocked",
    reason: "worktree_ignore_repair_failed",
  });
  expect(result.message).toContain("odřádkování");
  expect(await readPortableText(join(fixture.working, ".git", "info", "exclude")))
    .not.toContain("injected");
  expect(runGit(fixture.working, ["stash", "list", "--format=%H"])).toBe("");
  expect(status(fixture.working)).toContain(".worktrees/");
});

test("legacy blanket worktree ignore narrows before unknown data is recovery-stashed", async () => {
  const fixture = await repositoryFixture("legacy-blanket-worktree-ignore");
  const worktreeRelative = ".worktrees/root/DEV-6505-fixture";
  const worktreeRoot = join(fixture.working, ...worktreeRelative.split("/"));
  await mkdir(join(fixture.working, ".worktrees", "root"), { recursive: true });
  runGit(fixture.working, ["worktree", "add", "-b", "codex/DEV-6505-fixture", worktreeRoot, "HEAD"]);
  await writeFile(`${worktreeRoot}.worktree.json`, "{}\n");
  await writeFile(join(fixture.working, ".git", "info", "exclude"), "/.worktrees/\n");
  await writeFile(join(fixture.working, ".worktrees", "notes.txt"), "keep me\n");
  await writeFile(`${worktreeRoot}.worktree.json.unexpected`, "keep me too\n");

  expect(status(fixture.working)).toBe("");
  const result = await update(fixture);

  expect(result).toMatchObject({
    state: "updated",
    reason: "local_changes_preserved",
    actions: ["worktree_ignore_repaired", "recovery_stash"],
  });
  const exclude = await readPortableText(join(fixture.working, ".git", "info", "exclude"));
  expect(exclude.split("\n")).not.toContain("/.worktrees/");
  expect(exclude.split("\n")).toContain(`/${worktreeRelative}/`);
  expect(exclude.split("\n")).toContain(`/${worktreeRelative}.worktree.json`);
  const stashedPaths = runGit(fixture.working, [
    "stash", "show", "--include-untracked", "--name-only", result.recovery_stash,
  ]);
  expect(stashedPaths).toContain(".worktrees/notes.txt");
  expect(stashedPaths).toContain(".worktrees/root/DEV-6505-fixture.worktree.json.unexpected");
  expect(runGit(worktreeRoot, ["rev-parse", "HEAD"]))
    .toBe(runGit(fixture.working, ["rev-parse", "codex/DEV-6505-fixture"]));
});

test("legacy blanket worktree ignore is removed after its registered worktree is gone", async () => {
  const fixture = await repositoryFixture("legacy-blanket-without-worktree");
  await mkdir(join(fixture.working, ".worktrees"), { recursive: true });
  await writeFile(join(fixture.working, ".git", "info", "exclude"), "/.worktrees/\n");
  await writeFile(join(fixture.working, ".worktrees", "notes.txt"), "keep me\n");

  expect(status(fixture.working)).toBe("");
  const result = await update(fixture);

  expect(result).toMatchObject({
    state: "updated",
    reason: "local_changes_preserved",
    actions: ["worktree_ignore_repaired", "recovery_stash"],
  });
  expect(await readPortableText(join(fixture.working, ".git", "info", "exclude"))).toBe("");
  expect(runGit(fixture.working, [
    "stash", "show", "--include-untracked", "--name-only", result.recovery_stash,
  ])).toContain(".worktrees/notes.txt");
});

test("unregistered files under .worktrees remain user data and are recovery-stashed", async () => {
  const fixture = await repositoryFixture("unregistered-worktree-data");
  await mkdir(join(fixture.working, ".worktrees"), { recursive: true });
  await writeFile(join(fixture.working, ".worktrees", "notes.txt"), "keep me\n");
  await addRemoteCommit(fixture, "remote.txt", "remote\n");

  const result = await update(fixture);

  expect(result).toMatchObject({
    state: "updated",
    reason: "local_changes_preserved",
    actions: ["recovery_stash", "fast_forward"],
  });
  expect(runGit(fixture.working, ["stash", "show", "--include-untracked", "--name-only", result.recovery_stash]))
    .toContain(".worktrees/notes.txt");
  expect(runGitResult(fixture.working, ["check-ignore", "--quiet", "--no-index", "--", ".worktrees/"]).status).toBe(1);
});

test("an unverified recovery stash is labeled truthfully in the Codex handoff", async () => {
  const fixture = await repositoryFixture("unverified-stash-prompt");
  await writeFile(join(fixture.working, "unfinished.txt"), "unfinished\n");

  const result = await updateManagedRepo(descriptor(fixture), {
    runId: "unverified-stash-prompt",
    deps: {
      runGit: async (args, options) => {
        const gitResult = await runGitAsync(args, options);
        return args[0] === "stash" && args.includes("--name-only")
          ? { ...gitResult, stdout: "" }
          : gitResult;
      },
      installDependencies: async () => ({ ok: true }),
    },
  });

  expect(result).toMatchObject({
    state: "blocked",
    reason: "recovery_stash_unverified",
    actions: [],
    next_action: { kind: "codex" },
  });
  expect(result.recovery_stash).toMatch(/^[0-9a-f]{40}$/);
  expect(result.next_action.prompt).toContain("Neověřený recovery stash");
  expect(result.next_action.prompt).not.toContain("Ověřený recovery stash");
});

test("foreign stashes survive and the engine never uses destructive Git commands", async () => {
  const fixture = await repositoryFixture("foreign-stash");
  await writeFile(join(fixture.working, "foreign.txt"), "foreign draft\n");
  runGit(fixture.working, ["stash", "push", "--include-untracked", "--message", "foreign"]);
  const foreignStash = runGit(fixture.working, ["rev-parse", "refs/stash"]);
  await addRemoteCommit(fixture, "remote.txt", "remote\n");
  await writeFile(join(fixture.working, "tracked.txt"), "new local draft\n");
  const commands = [];

  const result = await updateManagedRepo(descriptor(fixture), {
    runId: "audit-run",
    deps: {
      runGit: async (args, options) => {
        commands.push(args);
        return runGitAsync(args, options);
      },
      installDependencies: async () => ({ ok: true }),
    },
  });

  expect(result.state).toBe("updated");
  const stashList = runGit(fixture.working, ["stash", "list", "--format=%H"]);
  expect(stashList).toContain(result.recovery_stash);
  expect(stashList).toContain(foreignStash);
  expect(commands.some(([command]) => ["push", "reset", "rebase", "merge"].includes(command))).toBe(false);
  expect(commands.some(([command, action]) => command === "stash" && ["pop", "apply", "drop", "clear"].includes(action))).toBe(false);
  const pull = commands.find(([command]) => command === "pull");
  expect(pull).toEqual(expect.arrayContaining(["--ff-only", "--no-rebase"]));
});

test("a remote redirected immediately before pull cannot inject a foreign descendant", async () => {
  const fixture = await repositoryFixture("remote-race");
  await addRemoteCommit(fixture, "expected.txt", "expected\n");
  const wrongRemote = join(fixture.sandbox, "wrong.git");
  const wrongContributor = join(fixture.sandbox, "wrong-contributor");
  runGit(fixture.sandbox, ["clone", fixture.remote, wrongContributor]);
  configure(wrongContributor);
  await writeFile(join(wrongContributor, "foreign.txt"), "foreign\n");
  runGit(wrongContributor, ["add", "foreign.txt"]);
  runGit(wrongContributor, ["commit", "-m", "foreign descendant"]);
  runGit(fixture.sandbox, ["init", "--bare", wrongRemote]);
  runGit(wrongContributor, ["remote", "set-url", "origin", wrongRemote]);
  runGit(wrongContributor, ["push", "-u", "origin", "main"]);
  let redirected = false;

  const result = await updateManagedRepo(descriptor(fixture), {
    runId: "remote-race",
    deps: {
      runGit: async (args, options) => {
        if (!redirected && args[0] === "pull") {
          redirected = true;
          runGit(fixture.working, ["remote", "set-url", "origin", wrongRemote]);
        }
        return runGitAsync(args, options);
      },
      installDependencies: async () => ({ ok: true }),
    },
  });

  expect(result).toMatchObject({ state: "blocked", reason: "post_update_verification_failed" });
  expect(await readPortableText(join(fixture.working, "expected.txt"))).toBe("expected\n");
  expect(existsSync(join(fixture.working, "foreign.txt"))).toBe(false);
});

test("a remote advance after fetch waits for the next run instead of changing the verified target", async () => {
  const fixture = await repositoryFixture("remote-advance");
  await addRemoteCommit(fixture, "expected.txt", "expected\n");
  let advanced = false;

  const result = await updateManagedRepo(descriptor(fixture), {
    runId: "remote-advance",
    deps: {
      runGit: async (args, options) => {
        if (!advanced && args[0] === "pull") {
          advanced = true;
          await writeFile(join(fixture.contributor, "later.txt"), "later\n");
          runGit(fixture.contributor, ["add", "later.txt"]);
          runGit(fixture.contributor, ["commit", "-m", "later remote advance"]);
          runGit(fixture.contributor, ["push", "origin", "main"]);
        }
        return runGitAsync(args, options);
      },
      installDependencies: async () => ({ ok: true }),
    },
  });

  expect(result.state).toBe("updated");
  expect(await readPortableText(join(fixture.working, "expected.txt"))).toBe("expected\n");
  expect(existsSync(join(fixture.working, "later.txt"))).toBe(false);
  const next = await update(fixture);
  expect(next.state).toBe("updated");
  expect(await readPortableText(join(fixture.working, "later.txt"))).toBe("later\n");
});

test("crash after verified stash preserves recovery and a rerun completes", async () => {
  const fixture = await repositoryFixture("crash-after-stash");
  await addRemoteCommit(fixture, "remote.txt", "remote\n");
  await writeFile(join(fixture.working, "tracked.txt"), "interrupted draft\n");
  const first = await runLazurioUpdate({
    rootPath: fixture.working,
    runtimeRoot: join(fixture.sandbox, "runtime"),
    deps: {
      runId: "crash-run",
      acquireLock: async () => ({ release: async () => {} }),
      buildInventory: async () => ({ repos: [], warnings: [] }),
      installDependencies: async () => ({ ok: true }),
      checkpoint: async (name) => {
        if (name === "after_stash") throw new Error("simulated crash");
      },
    },
  });
  expect(first).toMatchObject({ state: "blocked", results: [{ reason: "update_internal_error" }] });
  const preserved = runGit(fixture.working, ["rev-parse", "refs/stash"]);
  expect(preserved).toMatch(/^[0-9a-f]{40}$/);
  expect(status(fixture.working)).toBe("");

  const second = await runLazurioUpdate({
    rootPath: fixture.working,
    runtimeRoot: join(fixture.sandbox, "runtime"),
    deps: {
      runId: "retry-run",
      acquireLock: async () => ({ release: async () => {} }),
      buildInventory: async () => ({ repos: [], warnings: [] }),
      installDependencies: async () => ({ ok: true }),
    },
  });
  expect(second.state).toBe("updated");
  expect(runGit(fixture.working, ["stash", "list", "--format=%H"])).toContain(preserved);
  expect(await readPortableText(join(fixture.working, "remote.txt"))).toBe("remote\n");
});

test("crashes after switch or fast-forward remain recoverable by a plain rerun", async () => {
  for (const checkpointName of ["after_switch_main", "after_fast_forward"]) {
    const fixture = await repositoryFixture(`crash-${checkpointName}`);
    await addRemoteCommit(fixture, "remote.txt", "remote\n");
    if (checkpointName === "after_switch_main") runGit(fixture.working, ["switch", "-c", "agent/task"]);
    const first = await runLazurioUpdate({
      rootPath: fixture.working,
      runtimeRoot: join(fixture.sandbox, "runtime"),
      deps: {
        runId: checkpointName,
        acquireLock: async () => ({ release: async () => {} }),
        buildInventory: async () => ({ repos: [], warnings: [] }),
        installDependencies: async () => ({ ok: true }),
        checkpoint: async (name) => {
          if (name === checkpointName) throw new Error(`simulated ${name} crash`);
        },
      },
    });
    expect(first).toMatchObject({ state: "blocked", results: [{ reason: "update_internal_error" }] });

    const second = await runLazurioUpdate({
      rootPath: fixture.working,
      runtimeRoot: join(fixture.sandbox, "runtime"),
      deps: {
        runId: `${checkpointName}-retry`,
        acquireLock: async () => ({ release: async () => {} }),
        buildInventory: async () => ({ repos: [], warnings: [] }),
        installDependencies: async () => ({ ok: true }),
      },
    });
    expect(second.state).toBe(checkpointName === "after_fast_forward" ? "current" : "updated");
    expect(await branch(fixture.working)).toBe("main");
    expect(status(fixture.working)).toBe("");
    expect(await readPortableText(join(fixture.working, "remote.txt"))).toBe("remote\n");
  }
});

test("wrong primary branch returns to main without losing its commit", async () => {
  const fixture = await repositoryFixture("branch");
  runGit(fixture.working, ["switch", "-c", "agent/task"]);
  await writeFile(join(fixture.working, "feature.txt"), "feature\n");
  runGit(fixture.working, ["add", "feature.txt"]);
  runGit(fixture.working, ["commit", "-m", "feature"]);
  const featureHead = runGit(fixture.working, ["rev-parse", "HEAD"]);

  const result = await update(fixture);
  expect(result).toMatchObject({ state: "updated", actions: expect.arrayContaining(["switch_main"]) });
  expect(await branch(fixture.working)).toBe("main");
  expect(runGit(fixture.working, ["rev-parse", "agent/task"])).toBe(featureHead);
  expect(status(fixture.working)).toBe("");
});

test("local main commits and diverged history block with a Codex prompt", async () => {
  const ahead = await repositoryFixture("ahead");
  await writeFile(join(ahead.working, "ahead.txt"), "ahead\n");
  runGit(ahead.working, ["add", "ahead.txt"]);
  runGit(ahead.working, ["commit", "-m", "ahead"]);
  await writeFile(join(ahead.working, "unfinished.txt"), "unfinished\n");
  const aheadHead = runGit(ahead.working, ["rev-parse", "HEAD"]);
  const aheadResult = await update(ahead);
  const aheadStash = aheadResult.recovery_stash;
  expect(aheadResult).toMatchObject({
    state: "blocked",
    reason: "local_main_commits",
    actions: ["recovery_stash"],
    next_action: { kind: "codex" },
  });
  expect(aheadStash).toMatch(/^[0-9a-f]{40}$/);
  expect(aheadResult.next_action.prompt).toContain(ahead.working);
  expect(runGit(ahead.working, ["rev-parse", "HEAD"])).toBe(aheadHead);
  expect(status(ahead.working)).toBe("");
  expect(runGit(ahead.working, ["stash", "show", "--include-untracked", "--name-only", aheadStash]))
    .toContain("unfinished.txt");

  const diverged = await repositoryFixture("diverged");
  await writeFile(join(diverged.working, "local.txt"), "local\n");
  runGit(diverged.working, ["add", "local.txt"]);
  runGit(diverged.working, ["commit", "-m", "local"]);
  await addRemoteCommit(diverged, "remote.txt", "remote\n");
  const divergedResult = await update(diverged);
  expect(divergedResult).toMatchObject({ state: "blocked", reason: "main_diverged" });
});

test("an actual merge in progress blocks without changing Git state", async () => {
  const fixture = await repositoryFixture("merge-in-progress");
  runGit(fixture.working, ["switch", "-c", "conflict"]);
  await writeFile(join(fixture.working, "tracked.txt"), "branch version\n");
  runGit(fixture.working, ["add", "tracked.txt"]);
  runGit(fixture.working, ["commit", "-m", "branch conflict"]);
  runGit(fixture.working, ["switch", "main"]);
  await writeFile(join(fixture.working, "tracked.txt"), "main version\n");
  runGit(fixture.working, ["add", "tracked.txt"]);
  runGit(fixture.working, ["commit", "-m", "main conflict"]);
  const merge = runGitResult(fixture.working, ["merge", "conflict"]);
  expect(merge.status).not.toBe(0);
  const mergeHead = runGit(fixture.working, ["rev-parse", "MERGE_HEAD"]);

  const result = await update(fixture);
  expect(result).toMatchObject({ state: "blocked", reason: "merge_in_progress", next_action: { kind: "codex" } });
  expect(runGit(fixture.working, ["rev-parse", "MERGE_HEAD"])).toBe(mergeHead);
  expect(status(fixture.working)).toContain("UU tracked.txt");
});

test("actual rebase and git am operations stay blocked and untouched", async () => {
  const rebasing = await repositoryFixture("rebase-in-progress");
  await writeFile(join(rebasing.working, "tracked.txt"), "local main version\n");
  runGit(rebasing.working, ["add", "tracked.txt"]);
  runGit(rebasing.working, ["commit", "-m", "local main conflict"]);
  await addRemoteCommit(rebasing, "tracked.txt", "remote main version\n");
  const rebase = runGitResult(rebasing.working, ["pull", "--rebase", "origin", "main"]);
  expect(rebase.status).not.toBe(0);
  const rebaseHead = runGit(rebasing.working, ["rev-parse", "HEAD"]);
  const rebaseResult = await update(rebasing);
  expect(rebaseResult).toMatchObject({ state: "blocked", reason: "rebase_in_progress" });
  expect(runGit(rebasing.working, ["rev-parse", "HEAD"])).toBe(rebaseHead);

  const applying = await repositoryFixture("am-in-progress");
  await writeFile(join(applying.contributor, "tracked.txt"), "patch version\n");
  runGit(applying.contributor, ["add", "tracked.txt"]);
  runGit(applying.contributor, ["commit", "-m", "patch conflict"]);
  const patch = runGitResult(applying.contributor, ["format-patch", "-1", "--stdout"]);
  expect(patch.status).toBe(0);
  const patchPath = join(applying.sandbox, "conflict.patch");
  await writeFile(patchPath, patch.stdout);
  await writeFile(join(applying.working, "tracked.txt"), "working version\n");
  runGit(applying.working, ["add", "tracked.txt"]);
  runGit(applying.working, ["commit", "-m", "working conflict"]);
  const am = runGitResult(applying.working, ["am", patchPath]);
  expect(am.status).not.toBe(0);
  const amHead = runGit(applying.working, ["rev-parse", "HEAD"]);
  const amResult = await update(applying);
  expect(amResult).toMatchObject({ state: "blocked", reason: "am_in_progress" });
  expect(runGit(applying.working, ["rev-parse", "HEAD"])).toBe(amHead);
});

test("hierarchy is sequential and excludes root-space db and productionspace", async () => {
  const calls = [];
  const missionControl = repo("alpha::mission-control", "root_repo", "alpha", "mission-control", null);
  missionControl.slot_path = "mission-control";
  const database = repo("alpha::db", "root_repo", "alpha", "db", null);
  database.slot_path = "mission-control/db";
  database.expected_branch = "v3";
  const inventory = {
    repos: [
      repo("beta::root", "organization_root", "beta", "root"),
      repo("alpha::root", "organization_root", "alpha", "root"),
      repo("alpha::module", "module", "alpha", "module", "workspace"),
      missionControl,
      database,
      repo("alpha::production", "module", "alpha", "production", "productionspace"),
    ],
    warnings: [],
  };
  const report = await runLazurioUpdate({
    rootPath: "/working",
    runtimeRoot: "/runtime",
    deps: {
      runId: "hierarchy",
      acquireLock: async () => ({ release: async () => {} }),
      buildInventory: async () => inventory,
      updateRepo: async (item) => {
        calls.push(item.key);
        return { ...identity(item), state: "current", reason: "already_current", message: "current" };
      },
    },
  });
  expect(report.state).toBe("current");
  expect(calls).toEqual(["lazurio::root", "alpha::root", "alpha::mission-control", "alpha::module", "beta::root"]);
  expect(JSON.stringify(report)).not.toContain("alpha::db");
  expect(JSON.stringify(report)).not.toContain("alpha::production");
});

test("scoped convergence materializes accessible Modules and reports inaccessible siblings", async () => {
  const root = await mkdtemp(join(tmpdir(), "lazurio-update-partial-access-"));
  cleanup.push(root);
  const organization = repo("Example::root", "organization_root", "Example", "root");
  organization.absolute_path = join(root, "organizations", "Example_GEN3");
  const available = repo("Example::available", "module", "Example", "available", "workspace");
  available.absolute_path = join(organization.absolute_path, "workspace", "available");
  available.slot_path = "workspace/available";
  const privateModule = repo("Example::private", "module", "Example", "private", "workspace");
  privateModule.absolute_path = join(organization.absolute_path, "workspace", "private");
  privateModule.slot_path = "workspace/private";
  const calls = [];

  const report = await runLazurioUpdate({
    rootPath: root,
    runtimeRoot: join(root, "..", "runtime"),
    organizations: [{ slug: "Example", path: "organizations/Example_GEN3" }],
    deps: {
      runId: "partial-access",
      acquireLock: async () => ({ release: async () => {} }),
      buildInventory: async () => ({ repos: [organization, available, privateModule], warnings: [] }),
      updateRepo: async (item) => ({
        ...identity(item),
        state: "current",
        reason: "already_current",
        message: "current",
      }),
      materializeRepo: async ({ repo: item }) => {
        calls.push(item.key);
        return item.key === available.key
          ? { ok: true, outcome: "materialized", head: "a".repeat(40) }
          : {
              ok: false,
              outcome: "missing_access",
              code: "materialization_source_unavailable",
              message: "private",
            };
      },
      discoverApps: async () => ({ apps: [], failures: [] }),
    },
  });

  expect(calls).toEqual([available.key, privateModule.key]);
  expect(report.state).toBe("blocked");
  expect(report.results.find((result) => result.repo_key === available.key)).toMatchObject({
    state: "updated",
    reason: "module_materialized",
  });
  expect(report.results.find((result) => result.repo_key === privateModule.key)).toMatchObject({
    state: "blocked",
    reason: "materialization_source_unavailable",
    next_action: { kind: "github_access" },
  });
});

test("updated Module refreshes each manifest-declared app package once through the Server lifecycle seam", async () => {
  const root = await mkdtemp(join(tmpdir(), "lazurio-update-app-dependencies-"));
  cleanup.push(root);
  const organizationRoot = join(root, "organizations", "TestCo");
  const moduleRoot = join(organizationRoot, "workspace", "mission-control");
  const appRoot = join(moduleRoot, "app", "v3");
  await mkdir(appRoot, { recursive: true });
  await writeJson(join(appRoot, "package.json"), {
    name: "test-mission-control",
    dependencies: { fixture: "1.0.0" },
  });
  await writeFile(join(appRoot, "bun.lock"), "# fixture\n");
  const organization = repo("TestCo::root", "organization_root", "TestCo", "root");
  organization.absolute_path = organizationRoot;
  const module = repo("TestCo::mission-control", "module", "TestCo", "mission-control", "workspace");
  module.absolute_path = moduleRoot;
  const inventory = { repos: [organization, module], warnings: [] };
  const calls = [];
  const head = "a".repeat(40);

  const report = await runLazurioUpdate({
    rootPath: root,
    runtimeRoot: join(root, "..", "runtime"),
    deps: {
      runId: "app-package-refresh",
      acquireLock: async () => ({ release: async () => {} }),
      buildInventory: async () => inventory,
      updateRepo: async (item) => ({
        ...identity(item),
        state: item.key === module.key ? "updated" : "current",
        reason: item.key === module.key ? "checkout_updated" : "already_current",
        message: "fixture",
        head,
        actions: item.key === module.key ? ["fast_forward"] : [],
      }),
      discoverApps: async () => ({
        apps: [
          { id: "test-mc-ui", package_path: "organizations/TestCo/workspace/mission-control/app/v3/package.json" },
          { id: "test-mc-api", package_path: "organizations/TestCo/workspace/mission-control/app/v3/package.json" },
        ],
        failures: [],
      }),
      refreshAppDependencies: async ({ appId, cwd, repo: owner }) => {
        calls.push({ appId, cwd, repoKey: owner.key });
        return { refresh_strategy: "clean_repair", mode: "clean" };
      },
      inspectLocalRepo: async () => ({ ok: true, branch: "main", dirtyPaths: [], head }),
      runGit: async (args) => args[0] === "rev-parse"
        ? { ok: true, stdout: head, stderr: "", exitCode: 0 }
        : { ok: false, stdout: "", stderr: "unexpected", exitCode: 1 },
    },
  });

  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({ appId: "test-mc-api", repoKey: module.key });
  expect(calls[0].cwd.endsWith(join("organizations", "TestCo", "workspace", "mission-control", "app", "v3"))).toBe(true);
  expect(report.results.find((result) => result.repo_key === module.key)).toMatchObject({
    state: "updated",
    actions: ["fast_forward", "dependencies_clean_repaired"],
    dependencies: [{
      ok: true,
      package_path: "app/v3",
      app_id: "test-mc-api",
      strategy: "clean_repair",
    }],
  });
});

test("updated Organization-level repository refreshes its manifest-declared App package", async () => {
  const root = await mkdtemp(join(tmpdir(), "lazurio-update-root-repo-app-dependencies-"));
  cleanup.push(root);
  const organizationRoot = join(root, "organizations", "TestCo");
  const missionControlRoot = join(organizationRoot, "mission-control");
  const appRoot = join(missionControlRoot, "app", "v3");
  await mkdir(appRoot, { recursive: true });
  await writeJson(join(appRoot, "package.json"), {
    name: "test-root-mission-control",
    dependencies: { fixture: "1.0.0" },
  });
  await writeFile(join(appRoot, "bun.lock"), "# fixture\n");
  const organization = repo("TestCo::root", "organization_root", "TestCo", "root");
  organization.absolute_path = organizationRoot;
  const missionControl = repo("TestCo::mission-control", "root_repo", "TestCo", "mission-control");
  missionControl.absolute_path = missionControlRoot;
  missionControl.slot_path = "mission-control";
  const inventory = { repos: [organization, missionControl], warnings: [] };
  const calls = [];
  const head = "b".repeat(40);

  const report = await runLazurioUpdate({
    rootPath: root,
    runtimeRoot: join(root, "..", "runtime"),
    deps: {
      runId: "root-repo-app-package-refresh",
      acquireLock: async () => ({ release: async () => {} }),
      buildInventory: async () => inventory,
      updateRepo: async (item) => ({
        ...identity(item),
        state: item.key === missionControl.key ? "updated" : "current",
        reason: item.key === missionControl.key ? "checkout_updated" : "already_current",
        message: "fixture",
        head,
        actions: item.key === missionControl.key ? ["fast_forward"] : [],
      }),
      discoverApps: async () => ({
        apps: [
          { id: "test-root-mc-ui", package_path: "organizations/TestCo/mission-control/app/v3/package.json" },
          { id: "test-root-mc-api", package_path: "organizations/TestCo/mission-control/app/v3/package.json" },
        ],
        failures: [],
      }),
      refreshAppDependencies: async ({ appId, cwd, repo: owner }) => {
        calls.push({ appId, cwd, repoKey: owner.key });
        return { refresh_strategy: "clean_repair", mode: "clean" };
      },
      inspectLocalRepo: async () => ({ ok: true, branch: "main", dirtyPaths: [], head }),
      runGit: async (args) => args[0] === "rev-parse"
        ? { ok: true, stdout: head, stderr: "", exitCode: 0 }
        : { ok: false, stdout: "", stderr: "unexpected", exitCode: 1 },
    },
  });

  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({ appId: "test-root-mc-api", repoKey: missionControl.key });
  expect(calls[0].cwd.endsWith(join("organizations", "TestCo", "mission-control", "app", "v3"))).toBe(true);
  expect(report.results.find((result) => result.repo_key === missionControl.key)).toMatchObject({
    state: "updated",
    actions: ["fast_forward", "dependencies_clean_repaired"],
    dependencies: [{
      ok: true,
      package_path: "app/v3",
      app_id: "test-root-mc-api",
      strategy: "clean_repair",
    }],
  });
});

test("invalid App blocks only its changed Module while a valid sibling still refreshes", async () => {
  const root = await mkdtemp(join(tmpdir(), "lazurio-update-invalid-app-"));
  cleanup.push(root);
  const organizationRoot = join(root, "organizations", "TestCo");
  const invalidModuleRoot = join(organizationRoot, "workspace", "invalid-module");
  const validModuleRoot = join(organizationRoot, "workspace", "valid-module");
  const invalidAppRoot = join(invalidModuleRoot, "app", "v1");
  const validAppRoot = join(validModuleRoot, "app", "v1");
  await mkdir(invalidAppRoot, { recursive: true });
  await mkdir(validAppRoot, { recursive: true });
  await writeJson(join(invalidAppRoot, "package.json"), { name: "invalid-app" });
  await writeJson(join(validAppRoot, "package.json"), {
    name: "valid-app",
    dependencies: { fixture: "1.0.0" },
  });
  await writeFile(join(validAppRoot, "bun.lock"), "# fixture\n");

  const organization = repo("TestCo::root", "organization_root", "TestCo", "root");
  organization.absolute_path = organizationRoot;
  const invalidModule = repo("TestCo::invalid-module", "module", "TestCo", "invalid-module", "workspace");
  invalidModule.absolute_path = invalidModuleRoot;
  const validModule = repo("TestCo::valid-module", "module", "TestCo", "valid-module", "workspace");
  validModule.absolute_path = validModuleRoot;
  const head = "b".repeat(40);
  const refreshed = [];

  const report = await runLazurioUpdate({
    rootPath: root,
    runtimeRoot: join(root, "..", "runtime"),
    deps: {
      runId: "invalid-app-isolation",
      acquireLock: async () => ({ release: async () => {} }),
      buildInventory: async () => ({ repos: [organization, invalidModule, validModule], warnings: [] }),
      updateRepo: async (item) => ({
        ...identity(item),
        state: item.repo_kind === "module" ? "updated" : "current",
        reason: item.repo_kind === "module" ? "checkout_updated" : "already_current",
        message: "fixture",
        head,
        actions: item.repo_kind === "module" ? ["fast_forward"] : [],
      }),
      discoverApps: async () => ({
        apps: [{
          id: "valid-app-v1",
          package_path: "organizations/TestCo/workspace/valid-module/app/v1/package.json",
        }],
        invalid_apps: [{
          id: "invalid-app-v1",
          package_path: "organizations/TestCo/workspace/invalid-module/app/v1/package.json",
          manifest_issues: ["lazurio.runtime.listeners chybí"],
        }],
        failures: [],
      }),
      refreshPackageDependencies: async ({ cwd }) => {
        refreshed.push(cwd);
        return { ok: true, refresh_strategy: "ensure" };
      },
      inspectLocalRepo: async () => ({ ok: true, branch: "main", dirtyPaths: [], head }),
      runGit: async (args) => args[0] === "rev-parse"
        ? { ok: true, stdout: head, stderr: "", exitCode: 0 }
        : { ok: false, stdout: "", stderr: "unexpected", exitCode: 1 },
    },
  });

  expect(refreshed).toHaveLength(1);
  expect(refreshed[0].endsWith(join("organizations", "TestCo", "workspace", "valid-module", "app", "v1"))).toBe(true);
  expect(report.results.find((result) => result.repo_key === invalidModule.key)).toMatchObject({
    state: "blocked",
    reason: "dependency_refresh_failed",
    dependencies: [{
      ok: false,
      app_id: "invalid-app-v1",
      reason: "invalid_app_manifest",
    }],
  });
  expect(report.results.find((result) => result.repo_key === validModule.key)).toMatchObject({
    state: "updated",
    dependencies: [{ ok: true, app_id: "valid-app-v1" }],
  });
});

test("fresh Organization manifest materializes its new Workspace Module while excluded scopes stay byte-identical", async () => {
  const root = await createLaunchpadGitFixture();
  cleanup.push(root);
  await rm(join(root, "organizations", "OmegaCo_GEN3"), { recursive: true, force: true });
  const organizationRoot = join(root, "organizations", "BetaCo_GEN3");
  const organizationRemote = join(root, "remotes", "beta-root.git");
  const moduleRemote = join(root, "remotes", "new-module.git");
  const declaredModuleRemote = "git@github.com:BetaCo/new-module.git";
  const excludedSlots = [
    {
      slug: "warehouse",
      path: "workspace/warehouse",
      git: { url: "git@github.com:BetaCo/warehouse.git", branch: "main" },
    },
    {
      slug: "warehouse-data",
      path: "workspace/warehouse/db",
      source_of_truth: "repository-db:v3",
      git: { url: "git@github.com:BetaCo/warehouse-data.git", branch: "v3" },
    },
    {
      path: "productionspace/firmware",
      repo: join(root, "remotes", "firmware.git"),
      branch: "main",
    },
    {
      path: "mission-control/db",
      space: "root",
      git: { url: join(root, "remotes", "mission-control-data.git"), branch: "v3" },
    },
  ];
  await writeJson(join(organizationRoot, "modules.manifest.json"), {
    organization_generation: "gen3",
    company: "BetaCo",
    github_org: "BetaCo",
    module_slots: excludedSlots,
  });
  await writeFile(
    join(organizationRoot, ".gitignore"),
    "/workspace/*/\n/productionspace/\n/mission-control/db/\n/.worktrees/\n",
  );
  await initGitRepo(organizationRoot, { remotePath: organizationRemote });
  await setOrganizationRepository({
    root,
    orgPath: "organizations/BetaCo_GEN3",
    repo: organizationRemote,
  });
  runGit(organizationRoot, ["add", "."]);
  runGit(organizationRoot, ["commit", "-m", "organization baseline"]);
  runGit(organizationRoot, ["push", "origin", "main"]);
  runGit(root, ["--git-dir", organizationRemote, "symbolic-ref", "HEAD", "refs/heads/main"]);

  const source = join(root, "sources", "new-module");
  await mkdir(join(root, "sources"), { recursive: true });
  await initGitRepo(source, { remotePath: moduleRemote });
  const contributor = join(root, "contributors", "beta-root");
  await mkdir(join(root, "contributors"), { recursive: true });
  runGit(root, ["clone", organizationRemote, contributor]);
  configure(contributor);
  await writeJson(join(contributor, "modules.manifest.json"), {
    organization_generation: "gen3",
    company: "BetaCo",
    github_org: "BetaCo",
    module_slots: [
      ...excludedSlots,
      {
        path: "workspace/new-module",
        teams: ["workspace"],
        git: { url: declaredModuleRemote, branch: "main" },
      },
    ],
  });
  runGit(contributor, ["add", "modules.manifest.json"]);
  runGit(contributor, ["commit", "-m", "declare new Workspace Module"]);
  runGit(contributor, ["push", "origin", "main"]);

  const excludedPaths = [
    join(organizationRoot, "productionspace", "firmware"),
    join(organizationRoot, "mission-control", "db"),
    join(organizationRoot, "workspace", "warehouse", "db"),
    join(organizationRoot, ".worktrees", "task"),
    join(root, "personalspace", "owner"),
  ];
  await initGitRepo(excludedPaths[0]);
  await initGitRepo(excludedPaths[1], { branch: "v3" });
  await initGitRepo(excludedPaths[2], { branch: "v3" });
  await mkdir(excludedPaths[3], { recursive: true });
  await mkdir(excludedPaths[4], { recursive: true });
  await writeFile(join(excludedPaths[3], "marker.bin"), Buffer.from([0, 7, 255]));
  await writeFile(join(excludedPaths[4], "marker.bin"), Buffer.from([1, 8, 254]));
  const beforeExcluded = await Promise.all(excludedPaths.map(snapshotPath));

  const report = await runLazurioUpdate({
    rootPath: root,
    runtimeRoot: join(root, "..", "runtime"),
    deps: {
      runId: "fresh-manifest",
      acquireLock: async () => ({ release: async () => {} }),
      updateRepo: async (item, context) => item.key === "lazurio::root" || item.key === "BetaCo::warehouse"
        ? { ...identity(item), state: "current", reason: "already_current", message: "current" }
        : updateManagedRepo(item, context),
      installDependencies: async () => ({ ok: true }),
      materializationDeps: {
        run: async (args, options) => {
          const mappedArgs = args.map((value) =>
            value === declaredModuleRemote ? moduleRemote : value
          );
          return runGitAsync(mappedArgs, options);
        },
        runPinnedChild: async (args, options) => {
          const mappedArgs = args.map((value) =>
            value === declaredModuleRemote ? moduleRemote : value
          );
          const result = await runGitInPinnedTemporaryChild(mappedArgs, options);
          if (!result.ok || args[0] !== "clone") return result;
          const stagingPath = join(options.cwd, result.child_name);
          const restored = await runGitAsync(["remote", "set-url", "origin", declaredModuleRemote], {
            cwd: stagingPath,
          });
          return restored.ok ? result : restored;
        },
      },
    },
  });

  expect(report.state).toBe("updated");
  expect(report.results.find((item) => item.repo_key === "BetaCo::root").state).toBe("updated");
  expect(report.results.find((item) => item.repo_key === "BetaCo::new-module"))
    .toMatchObject({ state: "updated", reason: "module_materialized" });
  expect(await readFile(join(organizationRoot, "workspace", "new-module", "README.md"), "utf8"))
    .toContain("# main");
  expect(await Promise.all(excludedPaths.map(snapshotPath))).toEqual(beforeExcluded);
  expect(JSON.stringify(report)).not.toContain("mission-control-data");
  expect(JSON.stringify(report)).not.toContain("firmware");
  expect(JSON.stringify(report)).not.toContain("warehouse-data");
});

test("blocked parent defers descendants while safe sibling continues", async () => {
  const alphaMissionControl = repo("alpha::mission-control", "root_repo", "alpha", "mission-control");
  alphaMissionControl.slot_path = "mission-control";
  const betaMissionControl = repo("beta::mission-control", "root_repo", "beta", "mission-control");
  betaMissionControl.slot_path = "mission-control";
  const inventory = {
    repos: [
      repo("alpha::root", "organization_root", "alpha", "root"),
      alphaMissionControl,
      repo("alpha::module", "module", "alpha", "module", "workspace"),
      repo("beta::root", "organization_root", "beta", "root"),
      betaMissionControl,
      repo("beta::module", "module", "beta", "module", "workspace"),
    ],
    warnings: [],
  };
  const calls = [];
  const report = await runLazurioUpdate({
    rootPath: "/working",
    runtimeRoot: "/runtime",
    deps: {
      runId: "parents",
      acquireLock: async () => ({ release: async () => {} }),
      buildInventory: async () => inventory,
      updateRepo: async (item) => {
        calls.push(item.key);
        if (item.key === "alpha::root") return { ...identity(item), state: "blocked", reason: "main_diverged", message: "blocked" };
        return { ...identity(item), state: "updated", reason: "checkout_updated", message: "updated" };
      },
    },
  });
  expect(calls).toEqual(["lazurio::root", "alpha::root", "beta::root", "beta::mission-control", "beta::module"]);
  expect(report.results.find((item) => item.repo_key === "alpha::mission-control"))
    .toMatchObject({ state: "blocked", reason: "parent_blocked" });
  expect(report.results.find((item) => item.repo_key === "alpha::module"))
    .toMatchObject({ state: "blocked", reason: "parent_blocked" });
  expect(report.results.find((item) => item.repo_key === "beta::mission-control").state).toBe("updated");
  expect(report.results.find((item) => item.repo_key === "beta::module").state).toBe("updated");
  expect(report.state).toBe("blocked");
});

test("one renamed module is quarantined while Sync still updates its healthy sibling", async () => {
  const organization = repo("alpha::root", "organization_root", "alpha", "root");
  organization.organization_path = "organizations/Alpha_GEN3";
  const healthy = repo("alpha::healthy", "module", "alpha", "healthy", "workspace");
  const message = "workspace/legacy: repository mount basename legacy must exactly match GitHub repository canonical";
  const issue = buildRepositoryLocationIssue({
    organization: "alpha",
    organizationPath: "organizations/Alpha_GEN3",
    module: "renamed",
    path: "workspace/legacy",
    expectedPath: "workspace/canonical",
    message,
    sources: ["modules.manifest.json#module_slots"],
  });
  const inventory = {
    repos: [organization, healthy],
    warnings: [message],
    inventory_issues: [issue],
  };
  const calls = [];

  const report = await runLazurioUpdate({
    rootPath: "/working",
    runtimeRoot: "/runtime",
    deps: {
      runId: "slot-quarantine",
      acquireLock: async () => ({ release: async () => {} }),
      buildInventory: async () => inventory,
      updateRepo: async (item) => {
        calls.push(item.key);
        return {
          ...identity(item),
          state: item.key === healthy.key ? "updated" : "current",
          reason: item.key === healthy.key ? "checkout_updated" : "already_current",
          message: "fixture",
          actions: [],
        };
      },
      discoverApps: async () => ({ apps: [], failures: [] }),
    },
  });

  expect(calls).toEqual(["lazurio::root", organization.key, healthy.key]);
  expect(report.results.find((item) => item.repo_key === healthy.key)).toMatchObject({ state: "updated" });
  expect(report.results.filter((item) => item.reason === "repository_location_mismatch")).toHaveLength(1);
  expect(report.results.find((item) => item.reason === "repository_location_mismatch")).toMatchObject({
    repo_key: "alpha::renamed::inventory",
    organization: "alpha",
    module: "renamed",
    state: "blocked",
    next_action: {
      kind: "repair_module_location",
      command: "lazurio repair module-location --org alpha --module renamed",
      prompt: expect.stringContaining("--apply --expect <fingerprint>"),
    },
  });
  expect(report.results.some((item) => item.reason === "inventory_unavailable")).toBe(false);
  expect(report.state).toBe("blocked");
});

test("slot collection conflicts never block healthy modules in the same or another Organization", async () => {
  const alphaRoot = repo("alpha::root", "organization_root", "alpha", "root");
  const alphaHealthy = repo("alpha::healthy", "module", "alpha", "healthy", "workspace");
  const betaRoot = repo("beta::root", "organization_root", "beta", "root");
  const betaHealthy = repo("beta::healthy", "module", "beta", "healthy", "workspace");
  const conflictIssues = ["workspace/a", "workspace/b"].map((path) => ({
    schema_version: "lazurio.organization_issue.v1",
    severity: "blocking",
    scope: "module_slot",
    status: "quarantined",
    code: "slot_collection_ambiguous",
    organization: "alpha",
    organization_path: "organizations/Alpha_GEN3",
    module: "shared",
    path,
    expected_path: null,
    message: `alpha shared identity conflicts at ${path}`,
    sources: ["git_inventory"],
    next_action: {
      kind: "agent_review",
      label: "Vyřešit s Codexem",
      prompt: `Review ${path} without guessing.`,
    },
  }));
  const inventory = {
    repos: [alphaRoot, alphaHealthy, betaRoot, betaHealthy],
    warnings: conflictIssues.map((issue) => issue.message),
    inventory_issues: conflictIssues,
  };
  const calls = [];

  const report = await runLazurioUpdate({
    rootPath: "/working",
    runtimeRoot: "/runtime",
    deps: {
      runId: "collection-conflict-isolation",
      acquireLock: async () => ({ release: async () => {} }),
      buildInventory: async () => inventory,
      updateRepo: async (item) => {
        calls.push(item.key);
        return {
          ...identity(item),
          state: item.repo_kind === "module" ? "updated" : "current",
          reason: item.repo_kind === "module" ? "checkout_updated" : "already_current",
          message: "fixture",
          actions: [],
        };
      },
      discoverApps: async () => ({ apps: [], failures: [] }),
    },
  });

  expect(calls).toEqual([
    "lazurio::root",
    alphaRoot.key,
    alphaHealthy.key,
    betaRoot.key,
    betaHealthy.key,
  ]);
  expect(calls.some((key) => key.includes("shared"))).toBe(false);
  expect(report.results.filter((item) => item.reason === "slot_collection_ambiguous"))
    .toHaveLength(2);
  expect(report.results.find((item) => item.repo_key === alphaHealthy.key)?.state).toBe("updated");
  expect(report.results.find((item) => item.repo_key === betaHealthy.key)?.state).toBe("updated");
  expect(report.results.some((item) => item.reason === "inventory_unavailable")).toBe(false);
});

test("Sync replaces pre-cutover slot diagnostics with the final inventory snapshot", async () => {
  const organization = repo("alpha::root", "organization_root", "alpha", "root");
  organization.organization_path = "organizations/Alpha_GEN3";
  const initialMessage = "workspace/legacy still follows the old declaration";
  const finalMessage = "workspace/legacy was observed after the canonical manifest cutover";
  const initialIssue = buildRepositoryLocationIssue({
    organization: "alpha",
    organizationPath: "organizations/Alpha_GEN3",
    module: "renamed",
    path: "workspace/legacy",
    expectedPath: "workspace/canonical",
    message: initialMessage,
  });
  const finalIssue = buildRepositoryLocationIssue({
    organization: "alpha",
    organizationPath: "organizations/Alpha_GEN3",
    module: "renamed",
    path: "workspace/legacy-after-cutover",
    expectedPath: "workspace/canonical",
    message: finalMessage,
  });
  const snapshots = [
    { repos: [organization], warnings: [initialMessage], inventory_issues: [initialIssue] },
    { repos: [organization], warnings: [finalMessage], inventory_issues: [finalIssue] },
  ];
  let inventoryRead = 0;

  const report = await runLazurioUpdate({
    rootPath: "/working",
    runtimeRoot: "/runtime",
    deps: {
      runId: "slot-cutover-snapshots",
      acquireLock: async () => ({ release: async () => {} }),
      buildInventory: async () => snapshots[Math.min(inventoryRead++, snapshots.length - 1)],
      updateRepo: async (item) => ({
        ...identity(item),
        state: "current",
        reason: "already_current",
        message: "fixture",
        actions: [],
      }),
      discoverApps: async () => ({ apps: [], failures: [] }),
    },
  });

  const slotIssues = report.results.filter((item) => item.reason === "repository_location_mismatch");
  expect(slotIssues).toHaveLength(1);
  expect(slotIssues[0]).toMatchObject({
    path: "organizations/Alpha_GEN3/workspace/legacy-after-cutover",
    next_action: { prompt: expect.stringContaining(finalMessage) },
  });
  expect(JSON.stringify(slotIssues[0])).not.toContain(initialMessage);
  expect(report.warnings).toEqual([]);
});

test("manifest cutover never clones over an unverified legacy checkout from the initial snapshot", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "lazurio-cutover-no-clone-"));
  cleanup.push(sandbox);
  const legacyPath = join(sandbox, "organizations", "Alpha_GEN3", "workspace", "legacy");
  const canonicalPath = join(sandbox, "organizations", "Alpha_GEN3", "workspace", "canonical");
  await mkdir(legacyPath, { recursive: true });
  await writeFile(join(legacyPath, "local-data.txt"), "preserve me\n");
  const organization = repo("alpha::root", "organization_root", "alpha", "root");
  organization.organization_path = "organizations/Alpha_GEN3";
  const legacy = repo("alpha::renamed", "module", "alpha", "renamed", "workspace");
  Object.assign(legacy, {
    absolute_path: legacyPath,
    repo_path: "organizations/Alpha_GEN3/workspace/legacy",
    slot_path: "workspace/legacy",
  });
  const canonical = { ...legacy,
    absolute_path: canonicalPath,
    repo_path: "organizations/Alpha_GEN3/workspace/canonical",
    slot_path: "workspace/canonical",
  };
  const snapshots = [
    { repos: [organization, legacy], warnings: [], inventory_issues: [] },
    { repos: [organization, canonical], warnings: [], inventory_issues: [] },
  ];
  let inventoryRead = 0;
  let materializations = 0;

  const report = await runLazurioUpdate({
    rootPath: sandbox,
    runtimeRoot: "/runtime",
    deps: {
      runId: "cutover-no-clone",
      acquireLock: async () => ({ release: async () => {} }),
      buildInventory: async () => snapshots[Math.min(inventoryRead++, snapshots.length - 1)],
      updateRepo: async (item) => ({
        ...identity(item),
        state: item.key === organization.key ? "updated" : "current",
        reason: item.key === organization.key ? "checkout_updated" : "already_current",
        message: "fixture",
        actions: [],
      }),
      materializeRepo: async () => {
        materializations += 1;
        throw new Error("must not clone");
      },
      discoverApps: async () => ({ apps: [], failures: [] }),
    },
  });

  expect(materializations).toBe(0);
  expect(existsSync(canonicalPath)).toBe(false);
  expect(await readFile(join(legacyPath, "local-data.txt"), "utf8")).toBe("preserve me\n");
  expect(report.results).toContainEqual(expect.objectContaining({
    repo_key: "alpha::renamed",
    reason: "repository_transition_unverified",
    next_action: expect.objectContaining({
      kind: "repair_module_location",
      prompt: expect.stringContaining("Sync nevytvořil druhý clone"),
    }),
  }));
});

test("pre-cutover structured location issue also blocks clone when the stable marker becomes unreadable", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "lazurio-cutover-issue-no-clone-"));
  cleanup.push(sandbox);
  const legacyPath = join(sandbox, "organizations", "Alpha_GEN3", "workspace", "legacy");
  const canonicalPath = join(sandbox, "organizations", "Alpha_GEN3", "workspace", "canonical");
  await mkdir(legacyPath, { recursive: true });
  await writeFile(join(legacyPath, "local-data.txt"), "preserve issue evidence\n");
  const organization = repo("alpha::root", "organization_root", "alpha", "root");
  organization.organization_path = "organizations/Alpha_GEN3";
  const canonical = repo("alpha::renamed", "module", "alpha", "renamed", "workspace");
  Object.assign(canonical, {
    absolute_path: canonicalPath,
    repo_path: "organizations/Alpha_GEN3/workspace/canonical",
    slot_path: "workspace/canonical",
  });
  const message = "old manifest already expects canonical remote while checkout remains in legacy";
  const issue = buildRepositoryLocationIssue({
    organization: "alpha",
    organizationPath: "organizations/Alpha_GEN3",
    module: "renamed",
    path: "workspace/legacy",
    expectedPath: "workspace/canonical",
    message,
  });
  const snapshots = [
    { repos: [organization], warnings: [message], inventory_issues: [issue] },
    { repos: [organization, canonical], warnings: [], inventory_issues: [] },
  ];
  let inventoryRead = 0;
  let materializations = 0;

  const report = await runLazurioUpdate({
    rootPath: sandbox,
    runtimeRoot: "/runtime",
    deps: {
      runId: "cutover-issue-no-clone",
      acquireLock: async () => ({ release: async () => {} }),
      buildInventory: async () => snapshots[Math.min(inventoryRead++, snapshots.length - 1)],
      updateRepo: async (item) => ({
        ...identity(item),
        state: item.key === organization.key ? "updated" : "current",
        reason: item.key === organization.key ? "checkout_updated" : "already_current",
        message: "fixture",
        actions: [],
      }),
      materializeRepo: async () => {
        materializations += 1;
        throw new Error("must not clone");
      },
      discoverApps: async () => ({ apps: [], failures: [] }),
    },
  });

  expect(materializations).toBe(0);
  expect(existsSync(canonicalPath)).toBe(false);
  expect(await readFile(join(legacyPath, "local-data.txt"), "utf8")).toBe("preserve issue evidence\n");
  expect(report.results).toContainEqual(expect.objectContaining({
    repo_key: "alpha::renamed",
    reason: "repository_transition_unverified",
  }));
});

test("any contained pre-cutover module issue blocks a duplicate clone after manifest repair", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "lazurio-cutover-slot-issue-no-clone-"));
  cleanup.push(sandbox);
  const organizationRoot = join(sandbox, "organizations", "Alpha_GEN3");
  const legacyPath = join(organizationRoot, "workspace", "legacy");
  const canonicalPath = join(organizationRoot, "workspace", "canonical");
  await mkdir(legacyPath, { recursive: true });
  await writeFile(join(legacyPath, "local-data.txt"), "preserve non-location evidence\n");
  const organization = repo("alpha::root", "organization_root", "alpha", "root");
  Object.assign(organization, {
    organization_path: "organizations/Alpha_GEN3",
    absolute_path: organizationRoot,
  });
  const canonical = repo("alpha::renamed", "module", "alpha", "renamed", "workspace");
  Object.assign(canonical, {
    organization_path: "organizations/Alpha_GEN3",
    absolute_path: canonicalPath,
    repo_path: "organizations/Alpha_GEN3/workspace/canonical",
    slot_path: "workspace/canonical",
  });
  const initialIssue = {
    schema_version: "lazurio.organization_issue.v1",
    severity: "blocking",
    scope: "module_slot",
    status: "quarantined",
    code: "slot_branch_invalid",
    organization: "alpha",
    organization_path: "organizations/Alpha_GEN3",
    module: "renamed",
    path: "workspace/legacy",
    expected_path: null,
    message: "legacy slot declared a non-main branch before the manifest repair",
  };
  const snapshots = [
    { repos: [organization], warnings: [], inventory_issues: [initialIssue] },
    { repos: [organization, canonical], warnings: [], inventory_issues: [] },
  ];
  let inventoryRead = 0;
  let materializations = 0;

  const report = await runLazurioUpdate({
    rootPath: sandbox,
    runtimeRoot: "/runtime",
    deps: {
      runId: "cutover-slot-issue-no-clone",
      acquireLock: async () => ({ release: async () => {} }),
      buildInventory: async () => snapshots[Math.min(inventoryRead++, snapshots.length - 1)],
      updateRepo: async (item) => ({
        ...identity(item),
        state: item.key === organization.key ? "updated" : "current",
        reason: item.key === organization.key ? "checkout_updated" : "already_current",
        message: "fixture",
        actions: [],
      }),
      materializeRepo: async () => {
        materializations += 1;
        throw new Error("must not clone");
      },
      discoverApps: async () => ({ apps: [], failures: [] }),
    },
  });

  expect(materializations).toBe(0);
  expect(existsSync(canonicalPath)).toBe(false);
  expect(await readFile(join(legacyPath, "local-data.txt"), "utf8"))
    .toBe("preserve non-location evidence\n");
  expect(report.results).toContainEqual(expect.objectContaining({
    repo_key: "alpha::renamed",
    reason: "repository_transition_unverified",
    next_action: expect.objectContaining({
      kind: "repair_module_location",
      prompt: expect.stringContaining("Sync nevytvořil druhý clone"),
    }),
  }));
});

test("case-only and unreadable pre-cutover evidence both block a duplicate clone", async () => {
  for (const variant of ["case-only", "unreadable"]) {
    const sandbox = await mkdtemp(join(tmpdir(), `lazurio-cutover-${variant}-no-clone-`));
    cleanup.push(sandbox);
    const organizationRoot = join(sandbox, "organizations", "Alpha_GEN3");
    const legacyPath = join(organizationRoot, "workspace", "legacy");
    const canonicalPath = join(organizationRoot, "workspace", "canonical");
    await mkdir(legacyPath, { recursive: true });
    await writeFile(join(legacyPath, "local-data.txt"), `preserve ${variant} evidence\n`);
    const organization = repo("alpha::root", "organization_root", "alpha", "root");
    Object.assign(organization, {
      organization_path: "organizations/Alpha_GEN3",
      absolute_path: organizationRoot,
    });
    const canonical = repo("alpha::renamed", "module", "alpha", "renamed", "workspace");
    Object.assign(canonical, {
      organization_path: "organizations/Alpha_GEN3",
      absolute_path: canonicalPath,
      repo_path: "organizations/Alpha_GEN3/workspace/canonical",
      slot_path: "workspace/canonical",
    });
    const initialIssue = {
      schema_version: "lazurio.organization_issue.v1",
      severity: "blocking",
      scope: "module_slot",
      status: "quarantined",
      code: variant === "case-only" ? "slot_path_casing_mismatch" : "slot_branch_invalid",
      organization: "alpha",
      organization_path: "organizations/Alpha_GEN3",
      module: "renamed",
      path: variant === "case-only" ? "workspace/Legacy" : "workspace/legacy",
      expected_path: null,
      message: `${variant} legacy evidence before manifest repair`,
    };
    const snapshots = [
      { repos: [organization], warnings: [], inventory_issues: [initialIssue] },
      { repos: [organization, canonical], warnings: [], inventory_issues: [] },
    ];
    let inventoryRead = 0;
    let materializations = 0;
    const lstatPath = async (path) => {
      if (variant === "unreadable" && path === legacyPath) {
        throw Object.assign(new Error("simulated EACCES"), { code: "EACCES" });
      }
      return lstat(path);
    };

    const report = await runLazurioUpdate({
      rootPath: sandbox,
      runtimeRoot: "/runtime",
      deps: {
        runId: `cutover-${variant}-no-clone`,
        acquireLock: async () => ({ release: async () => {} }),
        buildInventory: async () => snapshots[Math.min(inventoryRead++, snapshots.length - 1)],
        lstatPath,
        updateRepo: async (item) => ({
          ...identity(item),
          state: item.key === organization.key ? "updated" : "current",
          reason: item.key === organization.key ? "checkout_updated" : "already_current",
          message: "fixture",
          actions: [],
        }),
        materializeRepo: async () => {
          materializations += 1;
          throw new Error("must not clone");
        },
        discoverApps: async () => ({ apps: [], failures: [] }),
      },
    });

    expect(materializations).toBe(0);
    expect(existsSync(canonicalPath)).toBe(false);
    expect(await readFile(join(legacyPath, "local-data.txt"), "utf8"))
      .toBe(`preserve ${variant} evidence\n`);
    expect(report.results).toContainEqual(expect.objectContaining({
      repo_key: "alpha::renamed",
      reason: "repository_transition_unverified",
    }));
  }
});

test("two real inventory Sync runs never clone beside an unassigned legacy checkout after restart", async () => {
  const root = await createLaunchpadGitFixture();
  cleanup.push(root);
  const organizationRoot = join(root, "organizations", "OmegaCo_GEN3");
  const legacyPath = join(organizationRoot, "workspace", "legacy");
  const canonicalPath = join(organizationRoot, "workspace", "canonical");
  await mkdir(join(legacyPath, ".git"), { recursive: true });
  await writeFile(join(legacyPath, "local-data.txt"), "keep across syncs\n");
  const manifestPath = join(organizationRoot, "modules.manifest.json");
  const manifest = await Bun.file(manifestPath).json();
  manifest.module_slots.push({
    slug: "renamed",
    path: "workspace/canonical",
    teams: ["workspace"],
    git: { url: "git@github.com:OmegaCo/canonical.git", branch: "main" },
  });
  await writeJson(manifestPath, manifest);
  const materializationAttempts = [];
  const updateRepo = async (item) => ({
    ...identity(item),
    state: "current",
    reason: "already_current",
    message: "fixture",
    actions: [],
  });

  for (const runId of ["persistent-suspect-1", "persistent-suspect-2"]) {
    const report = await runLazurioUpdate({
      rootPath: root,
      runtimeRoot: "/runtime",
      deps: {
        runId,
        acquireLock: async () => ({ release: async () => {} }),
        updateRepo,
        materializeRepo: async ({ repo }) => {
          materializationAttempts.push(repo.key);
          return { ok: true, head: null };
        },
        discoverApps: async () => ({ apps: [], failures: [] }),
      },
    });
    expect(report.results).toContainEqual(expect.objectContaining({
      repo_key: "OmegaCo::renamed::inventory",
      reason: "repository_transition_unverified",
    }));
    expect(existsSync(canonicalPath)).toBe(false);
    expect(await readFile(join(legacyPath, "local-data.txt"), "utf8")).toBe("keep across syncs\n");
  }
  expect(materializationAttempts).not.toContain("OmegaCo::renamed");
});

test("updated Organization with failed refresh never replays its stale pre-cutover slot issue", async () => {
  const organization = repo("alpha::root", "organization_root", "alpha", "root");
  organization.organization_path = "organizations/Alpha_GEN3";
  const staleMessage = "old manifest points at workspace/legacy";
  const staleIssue = buildRepositoryLocationIssue({
    organization: "alpha",
    organizationPath: "organizations/Alpha_GEN3",
    module: "renamed",
    path: "workspace/legacy",
    expectedPath: "workspace/canonical",
    message: staleMessage,
  });
  let inventoryRead = 0;

  const report = await runLazurioUpdate({
    rootPath: "/working",
    runtimeRoot: "/runtime",
    deps: {
      runId: "failed-post-cutover-refresh",
      acquireLock: async () => ({ release: async () => {} }),
      buildInventory: async () => {
        if (inventoryRead++ === 0) {
          return { repos: [organization], warnings: [staleMessage], inventory_issues: [staleIssue] };
        }
        throw new Error("fresh manifest temporarily unreadable");
      },
      updateRepo: async (item) => ({
        ...identity(item),
        state: item.key === organization.key ? "updated" : "current",
        reason: item.key === organization.key ? "checkout_updated" : "already_current",
        message: "fixture",
        actions: [],
      }),
      discoverApps: async () => ({ apps: [], failures: [] }),
    },
  });

  expect(report.results.filter((item) => item.reason === "repository_location_mismatch")).toEqual([]);
  expect(report.results).toContainEqual(expect.objectContaining({
    repo_key: "alpha::inventory",
    reason: "inventory_unavailable",
  }));
  expect(JSON.stringify(report)).not.toContain(staleMessage);
});

test("inventory failure blocks instead of silently reporting current", async () => {
  const calls = [];
  const report = await runLazurioUpdate({
    rootPath: "/working",
    runtimeRoot: "/runtime",
    deps: {
      runId: "inventory-failure",
      acquireLock: async () => ({ release: async () => {} }),
      buildInventory: async () => { throw new Error("invalid manifest"); },
      updateRepo: async (item) => {
        calls.push(item.key);
        return { ...identity(item), state: "current", reason: "already_current", message: "current" };
      },
    },
  });
  expect(calls).toEqual(["lazurio::root"]);
  expect(report).toMatchObject({ state: "blocked", summary: { blocked: 1 } });
  expect(report.results.at(-1)).toMatchObject({ repo_key: "lazurio::inventory", reason: "inventory_unavailable" });
  expect(report.warnings.join(" ")).toContain("invalid manifest");
});

test("a dead-process lock is recovered once so the same command can be rerun", async () => {
  const rootPath = await mkdtemp(join(tmpdir(), "lazurio-stale-lock-root-"));
  cleanup.push(rootPath);
  const digest = createHash("sha256").update(rootPath).digest("hex").slice(0, 20);
  const lockPath = join(tmpdir(), `lazurio-update-${digest}.lock`);
  cleanup.push(lockPath);
  await writeFile(lockPath, JSON.stringify({
    root: rootPath,
    run_id: "dead-run",
    pid: 2_147_483_647,
    started_at: "2026-08-20T00:00:00.000Z",
  }));

  const lock = await acquireUpdateLock({
    rootPath,
    runId: "rerun",
    now: () => new Date("2026-08-20T12:00:00.000Z"),
  });
  expect(lock.path).toBe(lockPath);
  await lock.release();
  expect(existsSync(lockPath)).toBe(false);
});

test("runtime inside the working root blocks before lock or Git mutation", async () => {
  let locked = false;
  const report = await runLazurioUpdate({
    rootPath: "/workspace/Lazurio",
    runtimeRoot: "/workspace/Lazurio",
    deps: { acquireLock: async () => { locked = true; return { release: async () => {} }; } },
  });
  expect(report).toMatchObject({ state: "blocked", results: [{ reason: "runtime_not_isolated" }] });
  expect(locked).toBe(false);
});

test("GET-first status is no-fetch and exposes a Codex prompt for cached ahead main", async () => {
  const fixture = await repositoryFixture("local-status");
  await writeFile(join(fixture.working, "ahead.txt"), "ahead\n");
  runGit(fixture.working, ["add", "ahead.txt"]);
  runGit(fixture.working, ["commit", "-m", "ahead"]);
  const commands = [];

  const report = await readLazurioUpdateStatus({
    rootPath: fixture.working,
    deps: {
      buildInventory: async () => ({ repos: [], warnings: [] }),
      runGit: async (args, options) => {
        commands.push(args);
        return runGitAsync(args, options);
      },
    },
  });

  expect(report).toMatchObject({
    state: "blocked",
    checked_remote: false,
    reason: "local_main_commits",
    next_action: { kind: "codex", prompt: expect.stringContaining(fixture.working) },
  });
  expect(commands.some(([command]) => ["fetch", "pull", "push"].includes(command))).toBe(false);
});

test("GET-first status includes a mounted Organization-level repository", async () => {
  const root = await mkdtemp(join(tmpdir(), "lazurio-update-root-repo-status-"));
  cleanup.push(root);
  const organizationRoot = join(root, "organizations", "TestCo");
  const missionControlRoot = join(organizationRoot, "mission-control");
  await mkdir(missionControlRoot, { recursive: true });
  const organization = repo("TestCo::root", "organization_root", "TestCo", "root");
  organization.absolute_path = organizationRoot;
  const missionControl = repo("TestCo::mission-control", "root_repo", "TestCo", "mission-control");
  missionControl.absolute_path = missionControlRoot;
  missionControl.slot_path = "mission-control";

  const report = await readLazurioUpdateStatus({
    rootPath: root,
    deps: {
      buildInventory: async () => ({ repos: [organization, missionControl], warnings: [] }),
      inspectLocalRepo: async (item) => item.key === missionControl.key
        ? { ok: false, reason: "local_main_commits", detail: "fixture" }
        : { ok: true, directoryOnly: true, dirtyPaths: [] },
    },
  });

  expect(report).toMatchObject({
    state: "blocked",
    checked_remote: false,
    reason: "local_main_commits",
    repo_key: missionControl.key,
  });
});

test("GET-first status keeps Sync available when one module has an isolated repair", async () => {
  const message = "workspace/legacy must move to workspace/canonical";
  const issue = buildRepositoryLocationIssue({
    organization: "alpha",
    organizationPath: "organizations/Alpha_GEN3",
    module: "renamed",
    path: "workspace/legacy",
    expectedPath: "workspace/canonical",
    message,
  });

  const report = await readLazurioUpdateStatus({
    rootPath: "/working",
    deps: {
      buildInventory: async () => ({ repos: [], warnings: [message], inventory_issues: [issue] }),
      inspectLocalRepo: async () => ({ ok: true, directoryOnly: true, dirtyPaths: [] }),
    },
  });

  expect(report).toMatchObject({
    state: "current",
    checked_remote: false,
    reason: "explicit_sync_required",
    isolated_issue_count: 1,
  });
});

async function repositoryFixture(name) {
  const sandbox = await mkdtemp(join(tmpdir(), `lazurio-update-${name}-`));
  cleanup.push(sandbox);
  const remote = join(sandbox, "remote.git");
  const seed = join(sandbox, "seed");
  const working = join(sandbox, "working");
  const contributor = join(sandbox, "contributor");
  runGit(sandbox, ["init", "--bare", remote]);
  runGit(sandbox, ["clone", remote, seed]);
  configure(seed);
  runGit(seed, ["switch", "-c", "main"]);
  await writeFile(join(seed, "tracked.txt"), "tracked\n");
  runGit(seed, ["add", "tracked.txt"]);
  runGit(seed, ["commit", "-m", "initial"]);
  runGit(seed, ["push", "-u", "origin", "main"]);
  runGit(sandbox, ["--git-dir", remote, "symbolic-ref", "HEAD", "refs/heads/main"]);
  runGit(sandbox, ["clone", remote, working]);
  runGit(sandbox, ["clone", remote, contributor]);
  configure(working);
  configure(contributor);
  return { sandbox, remote, seed, working, contributor };
}

async function addRemoteCommit(fixture, path, content) {
  await writeFile(join(fixture.contributor, path), content);
  runGit(fixture.contributor, ["add", path]);
  runGit(fixture.contributor, ["commit", "-m", `remote ${path}`]);
  runGit(fixture.contributor, ["push", "origin", "main"]);
}

async function addRemoteFiles(fixture, files, message) {
  for (const [path, content] of Object.entries(files)) {
    await writeFile(join(fixture.contributor, path), content);
  }
  runGit(fixture.contributor, ["add", ...Object.keys(files)]);
  runGit(fixture.contributor, ["commit", "-m", message]);
  runGit(fixture.contributor, ["push", "origin", "main"]);
}

async function update(fixture) {
  return updateManagedRepo(descriptor(fixture), { runId: "test-run", deps: { installDependencies: async () => ({ ok: true }) } });
}

async function runRootUpdate(fixture, deps = {}) {
  return runLazurioUpdate({
    rootPath: fixture.working,
    runtimeRoot: join(fixture.sandbox, "runtime"),
    deps: {
      runId: "root-update-test",
      acquireLock: async () => ({ release: async () => {} }),
      buildInventory: async () => ({ repos: [], warnings: [] }),
      ...deps,
    },
  });
}

function descriptor(fixture) {
  return {
    key: "test::root",
    repo_kind: "organization_root",
    organization: "test",
    module: "root",
    repo_path: "organizations/Test",
    absolute_path: fixture.working,
    expected_branch: "main",
    repo: fixture.remote,
  };
}

function repo(key, repoKind, organization, module, workspace = null) {
  return {
    key,
    repo_kind: repoKind,
    organization,
    module,
    workspace,
    repo_path: `/working/${key}`,
    absolute_path: process.cwd(),
    expected_branch: "main",
  };
}

function identity(item) {
  return {
    repo_key: item.key,
    repo_kind: item.repo_kind,
    organization: item.organization,
    module: item.module,
    path: item.repo_path,
  };
}

function configure(cwd) {
  runGit(cwd, ["config", "user.name", "Lazurio Test"]);
  runGit(cwd, ["config", "user.email", "lazurio@example.test"]);
}

function status(cwd) {
  return runGit(cwd, ["status", "--porcelain=v1", "--untracked-files=all"]);
}

async function snapshotPath(path) {
  if (existsSync(join(path, ".git"))) {
    return {
      head: runGit(path, ["rev-parse", "HEAD"]),
      status: status(path),
      marker: await readFile(join(path, "README.md"), "utf8"),
    };
  }
  return { marker: Buffer.from(await readFile(join(path, "marker.bin"))).toString("hex") };
}

async function branch(cwd) {
  return runGit(cwd, ["branch", "--show-current"]);
}

function runGit(cwd, args) {
  const result = runGitResult(cwd, args);
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function runGitResult(cwd, args) {
  return spawnSync("git", args, { cwd, encoding: "utf8", shell: false });
}
