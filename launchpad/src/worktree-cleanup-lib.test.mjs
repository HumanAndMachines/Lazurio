import { afterAll, expect, test } from "bun:test";
import { existsSync } from "fs";
import { mkdir, readFile, rm, symlink, writeFile } from "fs/promises";
import { join } from "path";
import {
  applyWorktreeCleanup,
  cleanupJournalPath,
  inspectDurableWorktreeRuntimeUsage,
  inspectLocalOwnerSession,
  previewWorktreeCleanup,
  resolveMergedPullRequestEvidence,
} from "../../lazurio/runtime/worktree-cleanup-lib.mjs";
import { runGit as realRunGit } from "../../lazurio/runtime/git-lib.mjs";
import { buildWorktreeIndex } from "../../lazurio/runtime/worktree-lib.mjs";
import { acquireCreateLock, releaseCreateLock } from "../../scripts/worktree-create-lock.mjs";
import { supportsFileSymlinks } from "../../scripts/test-platform-capabilities.mjs";
import {
  applyWorktreeCleanupEnvironment,
  createWorktreeFromPlan,
  previewWorktreeCleanupEnvironment,
  publishWorktreeDraft,
} from "./worktree-actions-lib.mjs";
import { createRepositoryDbWorktreeFixture, runGit } from "./git-fixture-helpers.test.mjs";

const tempRoots = [];
const fileSymlinkTest = (await supportsFileSymlinks()) ? test : test.skip;
const runtimeIdle = async () => ({ verified: true, in_use: false, message: "fixture idle", details: [] });
// Vlastník environmentu podle sidecaru: mrtvý (žádný proces se session ID),
// živý (agent pracuje) nebo neověřitelný (cizí Mašina / chybějící locator).
const ownerDead = async () => ({ verified: true, alive: false, message: "fixture: vlastník mrtvý", details: [] });
const ownerAlive = async () => ({ verified: true, alive: true, message: "fixture: vlastník živý", details: ["pid=4242"] });
const ownerUnverified = async () => ({ verified: false, alive: false, message: "fixture: vlastníka nelze ověřit", details: [] });

afterAll(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
});

async function createCleanupFixture({ branch }) {
  const fixture = await createRepositoryDbWorktreeFixture();
  tempRoots.push(fixture.root);
  const created = await createWorktreeFromPlan({
    companiesRoot: fixture.root,
    repoKey: "BetaCo::mission-control",
    planPath: fixture.planPath,
    branch,
    createdBy: "cleanup-test-agent",
  });
  const worktreePath = join(fixture.root, created.worktree.path);
  const sidecarPath = join(fixture.root, created.worktree.sidecar_path);
  return { ...fixture, created, worktreePath, sidecarPath, branch };
}

async function findWorktreeRecord(fixture) {
  const index = await buildWorktreeIndex({
    companiesRoot: fixture.root,
    organization: "BetaCo",
    module: "mission-control",
  });
  const record = index.worktrees.find((worktree) => worktree.slug === fixture.branch);
  if (!record) throw new Error(`worktree ${fixture.branch} not found in index`);
  return record;
}

// Publikovaná práce + lokální drift po merge: dirty soubor a nepushnutý commit
// nad PR headem (přesně to, co squash merge v GitHubu nikdy neuvidí).
async function publishWithDrift(fixture) {
  await writeFile(join(fixture.worktreePath, "draft.md"), "published work\n");
  await publishWorktreeDraft({
    companiesRoot: fixture.root,
    repoKey: "BetaCo::mission-control",
    slug: fixture.branch,
    commitMessage: "feat: cleanup fixture draft",
  });
  const prHead = runGit(["rev-parse", "HEAD"], fixture.worktreePath);
  await writeFile(join(fixture.worktreePath, "after-merge.md"), "local only\n");
  runGit(["add", "after-merge.md"], fixture.worktreePath);
  runGit(["-c", "user.name=fixture", "-c", "user.email=fixture@example.com", "commit", "-m", "unpushed drift"], fixture.worktreePath);
  await writeFile(join(fixture.worktreePath, "dirty.md"), "uncommitted\n");
  return { prHead, localHead: runGit(["rev-parse", "HEAD"], fixture.worktreePath) };
}

function mergedEvidence({ prHead, checkedAt = new Date(), branch } = {}) {
  return {
    url: "https://github.com/BetaCo/mission-control/pull/7",
    state: "MERGED",
    head_sha: prHead,
    checked_at: checkedAt.toISOString(),
    ...(branch ? { branch } : {}),
  };
}

function recordingRunGit(log, { failOn = () => false } = {}) {
  return async (args, options) => {
    if (args[0] === "worktree" && ["remove", "prune"].includes(args[1])) {
      log.push({ args: [...args], cwd: options?.cwd });
      if (failOn(args, options)) {
        return { ok: false, stdout: "", stderr: "injected failure", exitCode: 1 };
      }
    }
    return realRunGit(args, options);
  };
}

// Přeruší apply po úspěšném remove_dependency: journal drží remove_edit a
// remove_sidecar pending, edit worktree i sidecar existují.
async function interruptAfterDependencyRemoval(fixture, worktree, { prEvidence = null, inspectOwnerSession = ownerDead } = {}) {
  const failingRunGit = recordingRunGit([], {
    failOn: (args, options) => args[1] === "remove" && !options?.cwd?.endsWith("db"),
  });
  const preview = await previewWorktreeCleanup({
    companiesRoot: fixture.root,
    worktree,
    inspectRuntimeUsage: runtimeIdle,
    inspectOwnerSession,
    prEvidence,
    runGitFn: failingRunGit,
  });
  expect(preview.state).toBe("ready_to_delete");
  await expect(applyWorktreeCleanup({
    companiesRoot: fixture.root,
    worktree,
    expectedFingerprint: preview.preview_fingerprint,
    inspectRuntimeUsage: runtimeIdle,
    inspectOwnerSession,
    prEvidence,
    runGitFn: failingRunGit,
  })).rejects.toMatchObject({ code: "cleanup_step_failed" });
  const journalPath = cleanupJournalPath({ companiesRoot: fixture.root, worktree });
  const journal = JSON.parse(await readFile(journalPath, "utf8"));
  expect(journal.steps.find((step) => step.id === "stop_runtime").status).toBe("completed");
  expect(journal.steps.find((step) => step.id === "remove_dependency:mission-control/db").status).toBe("completed");
  expect(journal.steps.find((step) => step.id === "remove_edit").status).toBe("pending");
  expect(existsSync(join(fixture.worktreePath, "db"))).toBe(false);
  return { preview, journalPath, journal };
}

function expectPartialEnvironmentIntact(fixture, journalPath) {
  expect(existsSync(fixture.worktreePath)).toBe(true);
  expect(existsSync(fixture.sidecarPath)).toBe(true);
  expect(existsSync(journalPath)).toBe(true);
  expect(runGit(["worktree", "list", "--porcelain"], fixture.missionControlRepo)).toContain(fixture.branch);
}

function expectCanonicalUntouched(fixture, canonicalDbHead) {
  expect(runGit(["rev-parse", "HEAD"], fixture.repositoryDbRepo)).toBe(canonicalDbHead);
  expect(runGit(["status", "--porcelain=v1", "--untracked-files=normal"], fixture.repositoryDbRepo)).toBe("");
  expect(existsSync(join(fixture.repositoryDbRepo, ".git"))).toBe(true);
  expect(existsSync(join(fixture.missionControlRepo, ".git"))).toBe(true);
  expect(runGit(["branch", "--show-current"], fixture.missionControlRepo)).toBe("main");
}

test("živý vlastník je fail-closed ochrana: preview blokuje bez zápisu", async () => {
  const fixture = await createCleanupFixture({ branch: "CAC-0099-cleanup-fresh" });
  const worktree = await findWorktreeRecord(fixture);

  const preview = await previewWorktreeCleanup({
    companiesRoot: fixture.root,
    worktree,
    inspectRuntimeUsage: runtimeIdle,
    inspectOwnerSession: ownerAlive,
  });
  expect(preview.state).toBe("needs_attention");
  const codes = preview.blockers.map((blocker) => blocker.code);
  expect(codes).toContain("active_owner");
  expect(codes).toContain("not_eligible");
  expect(preview.owner).toMatchObject({ verified: true, alive: true });
  expect(existsSync(fixture.worktreePath)).toBe(true);
  expect(existsSync(fixture.sidecarPath)).toBe(true);

  // Neověřitelný vlastník (cizí Mašina, chybějící locator) není důkaz smrti.
  const unverified = await previewWorktreeCleanup({
    companiesRoot: fixture.root,
    worktree,
    inspectRuntimeUsage: runtimeIdle,
    inspectOwnerSession: ownerUnverified,
  });
  expect(unverified.state).toBe("needs_attention");
  expect(unverified.blockers.map((blocker) => blocker.code)).toContain("not_eligible");
  expect(unverified.blockers.map((blocker) => blocker.code)).not.toContain("active_owner");

  await expect(applyWorktreeCleanup({
    companiesRoot: fixture.root,
    worktree,
    expectedFingerprint: preview.preview_fingerprint,
    inspectRuntimeUsage: runtimeIdle,
    inspectOwnerSession: ownerAlive,
  })).rejects.toMatchObject({ code: "cleanup_not_ready" });
  expect(existsSync(fixture.worktreePath)).toBe(true);
});

test("preview bez runtime evidence je fail-closed; běžící runtime je drift, ne blocker", async () => {
  const fixture = await createCleanupFixture({ branch: "CAC-0099-cleanup-no-runtime" });
  const worktree = await findWorktreeRecord(fixture);

  const preview = await previewWorktreeCleanup({ companiesRoot: fixture.root, worktree, inspectOwnerSession: ownerDead });
  expect(preview.state).toBe("needs_attention");
  expect(preview.blockers.map((blocker) => blocker.code)).toContain("runtime_unverified");

  const inUse = await previewWorktreeCleanup({
    companiesRoot: fixture.root,
    worktree,
    inspectOwnerSession: ownerDead,
    inspectRuntimeUsage: async () => ({ verified: true, in_use: true, message: "běží", details: ["pid=123"] }),
  });
  expect(inUse.state).toBe("ready_to_delete");
  expect(inUse.drift.map((entry) => entry.code)).toContain("runtime_in_use");
  expect(inUse.steps[0]).toBe("stop_runtime");
});

test("opuštěný no-change environment (mrtvý vlastník) apply uklidí nested-first včetně sidecaru", async () => {
  const fixture = await createCleanupFixture({ branch: "CAC-0099-cleanup-happy" });
  const worktree = await findWorktreeRecord(fixture);
  const canonicalDbHead = runGit(["rev-parse", "HEAD"], fixture.repositoryDbRepo);
  const gitLog = [];
  const runGitFn = recordingRunGit(gitLog);

  const preview = await previewWorktreeCleanup({
    companiesRoot: fixture.root,
    worktree,
    inspectRuntimeUsage: runtimeIdle,
    inspectOwnerSession: ownerDead,
    runGitFn,
  });
  expect(preview.state).toBe("ready_to_delete");
  expect(preview.blockers).toEqual([]);
  expect(preview.eligibility.basis).toBe("abandoned_owner_dead");
  expect(preview.steps).toEqual(["stop_runtime", "remove_dependency:mission-control/db", "remove_edit", "remove_sidecar"]);
  expect(preview.preview_fingerprint).toMatch(/^[0-9a-f]{64}$/);
  expect(preview.branch_refs_kept[0].branch).toBe(fixture.branch);

  const applied = await applyWorktreeCleanup({
    companiesRoot: fixture.root,
    worktree,
    expectedFingerprint: preview.preview_fingerprint,
    inspectRuntimeUsage: runtimeIdle,
    inspectOwnerSession: ownerDead,
    runGitFn,
  });
  expect(applied.steps.map((step) => step.id)).toEqual([
    "stop_runtime",
    "remove_dependency:mission-control/db",
    "remove_edit",
    "remove_sidecar",
  ]);
  expect(applied.steps[0].status).toBe("skipped_not_running");
  expect(applied.steps.slice(1).every((step) => step.status === "completed")).toBe(true);
  expect(existsSync(fixture.worktreePath)).toBe(false);
  expect(existsSync(fixture.sidecarPath)).toBe(false);
  expect(existsSync(cleanupJournalPath({ companiesRoot: fixture.root, worktree }))).toBe(false);

  const { realpath } = await import("fs/promises");
  const removes = gitLog.filter((entry) => entry.args[1] === "remove");
  expect(removes.length).toBe(2);
  expect(removes[0].cwd).toBe(await realpath(join(fixture.orgRoot, "mission-control", "db")));
  expect(removes[1].cwd).toBe(await realpath(join(fixture.orgRoot, "mission-control")));

  expectCanonicalUntouched(fixture, canonicalDbHead);
  expect(runGit(["worktree", "list", "--porcelain"], fixture.repositoryDbRepo)).not.toContain(fixture.branch);
  expect(runGit(["rev-parse", "--verify", `refs/heads/${fixture.branch}`], fixture.missionControlRepo)).toMatch(/^[0-9a-f]{40}$/);
});

test("merged práce (vč. squash) s dirty/unpushed driftem je eligible i bez důkazu o vlastníkovi a apply drift zahodí", async () => {
  const fixture = await createCleanupFixture({ branch: "CAC-0099-cleanup-merged" });
  const { prHead, localHead } = await publishWithDrift(fixture);
  const worktree = await findWorktreeRecord(fixture);
  const canonicalDbHead = runGit(["rev-parse", "HEAD"], fixture.repositoryDbRepo);
  expect(localHead).not.toBe(prHead);

  // Bez evidence a s neověřitelným vlastníkem není co uklízet.
  const withoutEvidence = await previewWorktreeCleanup({
    companiesRoot: fixture.root,
    worktree,
    inspectRuntimeUsage: runtimeIdle,
    inspectOwnerSession: ownerUnverified,
  });
  expect(withoutEvidence.state).toBe("needs_attention");
  expect(withoutEvidence.blockers.map((blocker) => blocker.code)).toEqual(["not_eligible"]);

  const stale = await previewWorktreeCleanup({
    companiesRoot: fixture.root,
    worktree,
    inspectRuntimeUsage: runtimeIdle,
    inspectOwnerSession: ownerUnverified,
    prEvidence: mergedEvidence({ prHead, checkedAt: new Date(Date.now() - 60 * 60 * 1000) }),
  });
  expect(stale.blockers.map((blocker) => blocker.code)).toContain("pr_evidence_stale");

  const foreignHead = await previewWorktreeCleanup({
    companiesRoot: fixture.root,
    worktree,
    inspectRuntimeUsage: runtimeIdle,
    inspectOwnerSession: ownerUnverified,
    prEvidence: mergedEvidence({ prHead: "0".repeat(40) }),
  });
  expect(foreignHead.blockers.map((blocker) => blocker.code)).toContain("pr_evidence_mismatch");

  const otherBranch = await previewWorktreeCleanup({
    companiesRoot: fixture.root,
    worktree,
    inspectRuntimeUsage: runtimeIdle,
    inspectOwnerSession: ownerUnverified,
    prEvidence: mergedEvidence({ prHead, branch: "CAC-0099-someone-else" }),
  });
  expect(otherBranch.blockers.map((blocker) => blocker.code)).toContain("pr_evidence_mismatch");

  // PR head je předek lokálního HEAD (squash merge + lokální drift) → merged.
  const evidence = mergedEvidence({ prHead });
  const ready = await previewWorktreeCleanup({
    companiesRoot: fixture.root,
    worktree,
    inspectRuntimeUsage: runtimeIdle,
    inspectOwnerSession: ownerUnverified,
    prEvidence: evidence,
  });
  expect(ready.state).toBe("ready_to_delete");
  expect(ready.eligibility.basis).toBe("merged");
  expect(ready.drift.map((entry) => entry.code)).toEqual(expect.arrayContaining(["edit_dirty", "edit_unpushed"]));

  const applied = await applyWorktreeCleanup({
    companiesRoot: fixture.root,
    worktree,
    expectedFingerprint: ready.preview_fingerprint,
    inspectRuntimeUsage: runtimeIdle,
    inspectOwnerSession: ownerUnverified,
    prEvidence: evidence,
  });
  expect(applied.eligibility.basis).toBe("merged");
  expect(existsSync(fixture.worktreePath)).toBe(false);
  expect(existsSync(fixture.sidecarPath)).toBe(false);
  // Remote branch i lokální branch ref zůstávají; jen worktree kopie je pryč.
  expect(runGit(["rev-parse", "--verify", `refs/heads/${fixture.branch}`], fixture.missionControlRepo)).toBe(localHead);
  expect(runGit(["ls-remote", "--heads", "origin", fixture.branch], fixture.missionControlRepo)).toContain(prHead);
  expectCanonicalUntouched(fixture, canonicalDbHead);
});

test("opuštěný rozpracovaný environment s driftem a běžícím procesem: stop → kill → uklizeno; bez stopperu fail-closed", async () => {
  const fixture = await createCleanupFixture({ branch: "CAC-0099-cleanup-abandoned" });
  await writeFile(join(fixture.worktreePath, "wip.md"), "rozdělaná práce\n");
  runGit(["add", "wip.md"], fixture.worktreePath);
  runGit(["-c", "user.name=fixture", "-c", "user.email=fixture@example.com", "commit", "-m", "wip never pushed"], fixture.worktreePath);
  await writeFile(join(fixture.worktreePath, "db", "scratch.txt"), "dirty dependency\n");
  const worktree = await findWorktreeRecord(fixture);
  const canonicalDbHead = runGit(["rev-parse", "HEAD"], fixture.repositoryDbRepo);

  // Reálný fixture proces „aplikace" běžící z worktree; lifecycle vlastník
  // ho zastaví SIGTERM → grace → SIGKILL. Cleanup lib sám nic nezabíjí.
  const child = Bun.spawn(["bun", "-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], {
    cwd: fixture.worktreePath,
    stdout: "ignore",
    stderr: "ignore",
  });
  const alive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return error?.code !== "ESRCH";
    }
  };
  let exited = false;
  child.exited.then(() => { exited = true; });
  const runtimeFromProcess = async () => (!exited && alive(child.pid)
    ? { verified: true, in_use: true, message: "fixture App běží", details: [`pid=${child.pid}`] }
    : { verified: true, in_use: false, message: "fixture App neběží", details: [] });
  const stopCalls = [];
  const stopWithGraceThenKill = async ({ environment }) => {
    stopCalls.push(environment.slug);
    child.kill("SIGTERM");
    const grace = Date.now() + 300;
    while (!exited && Date.now() < grace) await Bun.sleep(20);
    if (!exited) child.kill("SIGKILL");
    await child.exited;
    return { stopped: 1, attempted: 1 };
  };

  try {
    const preview = await previewWorktreeCleanup({
      companiesRoot: fixture.root,
      worktree,
      inspectRuntimeUsage: runtimeFromProcess,
      inspectOwnerSession: ownerDead,
    });
    expect(preview.state).toBe("ready_to_delete");
    expect(preview.eligibility.basis).toBe("abandoned_owner_dead");
    expect(preview.drift.map((entry) => entry.code)).toEqual(
      expect.arrayContaining(["edit_unpushed", "runtime_in_use", "dependency_dirty"]),
    );

    // Doctor/CLI lane bez lifecycle stopperu: běžící runtime je fail-closed
    // a nic se nesmaže (žádný cizí proces se nezabíjí).
    await expect(applyWorktreeCleanup({
      companiesRoot: fixture.root,
      worktree,
      expectedFingerprint: preview.preview_fingerprint,
      inspectRuntimeUsage: runtimeFromProcess,
      inspectOwnerSession: ownerDead,
    })).rejects.toMatchObject({ code: "cleanup_runtime_in_use" });
    expect(alive(child.pid)).toBe(true);
    expect(existsSync(fixture.worktreePath)).toBe(true);
    const journalPath = cleanupJournalPath({ companiesRoot: fixture.root, worktree });
    expect(JSON.parse(await readFile(journalPath, "utf8")).steps[0]).toMatchObject({ id: "stop_runtime", status: "pending" });

    // Launchpad lane se stopperem: resume téhož journalu zastaví proces a dokončí.
    const applied = await applyWorktreeCleanup({
      companiesRoot: fixture.root,
      worktree,
      expectedFingerprint: preview.preview_fingerprint,
      inspectRuntimeUsage: runtimeFromProcess,
      stopRuntimeUsage: stopWithGraceThenKill,
      inspectOwnerSession: ownerDead,
    });
    expect(stopCalls).toEqual([fixture.branch]);
    expect(exited).toBe(true);
    expect(applied.steps.map((step) => step.id)).toEqual([
      "stop_runtime",
      "remove_dependency:mission-control/db",
      "remove_edit",
      "remove_sidecar",
    ]);
    expect(applied.steps[0].status).toBe("completed");
    expect(existsSync(fixture.worktreePath)).toBe(false);
    expect(existsSync(fixture.sidecarPath)).toBe(false);
    expect(existsSync(journalPath)).toBe(false);
    expectCanonicalUntouched(fixture, canonicalDbHead);
    expect(runGit(["worktree", "list", "--porcelain"], fixture.repositoryDbRepo)).not.toContain(fixture.branch);
    // Nepushnutý commit zůstal jen v branch refu ownera — obnovený agent navazuje z GitHubu.
    expect(runGit(["rev-parse", "--verify", `refs/heads/${fixture.branch}`], fixture.missionControlRepo)).toMatch(/^[0-9a-f]{40}$/);
  } finally {
    if (!exited) child.kill("SIGKILL");
  }
});

test("po zastavení managed runtime zbývající cizí proces cleanup nezabíjí a končí fail-closed", async () => {
  const fixture = await createCleanupFixture({ branch: "CAC-0099-cleanup-foreign-process" });
  const worktree = await findWorktreeRecord(fixture);
  const stopCalls = [];
  const preview = await previewWorktreeCleanup({
    companiesRoot: fixture.root,
    worktree,
    inspectRuntimeUsage: async () => ({ verified: true, in_use: true, message: "neznámý proces", details: ["pid=999999"] }),
    inspectOwnerSession: ownerDead,
  });
  expect(preview.state).toBe("ready_to_delete");
  await expect(applyWorktreeCleanup({
    companiesRoot: fixture.root,
    worktree,
    expectedFingerprint: preview.preview_fingerprint,
    inspectRuntimeUsage: async () => ({ verified: true, in_use: true, message: "neznámý proces", details: ["pid=999999"] }),
    stopRuntimeUsage: async ({ environment }) => { stopCalls.push(environment.slug); return { stopped: 0, attempted: 0 }; },
    inspectOwnerSession: ownerDead,
  })).rejects.toMatchObject({ code: "cleanup_runtime_in_use" });
  expect(stopCalls).toEqual([fixture.branch]);
  expect(existsSync(fixture.worktreePath)).toBe(true);
  expect(existsSync(join(fixture.worktreePath, "db"))).toBe(true);
  expect(existsSync(fixture.sidecarPath)).toBe(true);
});

test("chráněné cíle: main checkout, canonical repository-db ani cizí nested checkout se nikdy nemažou", async () => {
  const fixture = await createCleanupFixture({ branch: "CAC-0099-cleanup-protected" });
  const worktree = await findWorktreeRecord(fixture);
  const canonicalDbHead = runGit(["rev-parse", "HEAD"], fixture.repositoryDbRepo);

  // 1) Záznam ukazující na main checkout modulu (cesta mimo .worktrees lane).
  const mainRecord = {
    ...worktree,
    path: `${worktree.organization_path}/mission-control`,
  };
  const mainPreview = await previewWorktreeCleanup({
    companiesRoot: fixture.root,
    worktree: mainRecord,
    inspectRuntimeUsage: runtimeIdle,
    inspectOwnerSession: ownerDead,
  });
  expect(mainPreview.state).toBe("invalid");
  expect(mainPreview.blockers.map((blocker) => blocker.code)).toContain("protected_target");
  await expect(applyWorktreeCleanup({
    companiesRoot: fixture.root,
    worktree: mainRecord,
    expectedFingerprint: "1".repeat(64),
    inspectRuntimeUsage: runtimeIdle,
    inspectOwnerSession: ownerDead,
  })).rejects.toMatchObject({ code: "cleanup_not_ready" });

  // 2) Nested checkout cizího ownera na dependency cestě: registrovaný
  //    linked worktree canonical db nahradí klon jiného repa.
  const dependencyPath = join(fixture.worktreePath, "db");
  runGit(["worktree", "remove", dependencyPath], fixture.repositoryDbRepo);
  const foreignRepo = join(fixture.root, "foreign-owner");
  await mkdir(foreignRepo, { recursive: true });
  runGit(["init", "-q", "-b", "main"], foreignRepo);
  await writeFile(join(foreignRepo, "README.md"), "foreign\n");
  runGit(["add", "README.md"], foreignRepo);
  runGit(["-c", "user.name=fixture", "-c", "user.email=fixture@example.com", "commit", "-q", "-m", "foreign"], foreignRepo);
  runGit(["worktree", "add", "--detach", dependencyPath], foreignRepo);

  const foreignPreview = await previewWorktreeCleanup({
    companiesRoot: fixture.root,
    worktree,
    inspectRuntimeUsage: runtimeIdle,
    inspectOwnerSession: ownerDead,
  });
  expect(foreignPreview.state).toBe("needs_attention");
  expect(foreignPreview.blockers.map((blocker) => blocker.code)).toContain("protected_target");
  await expect(applyWorktreeCleanup({
    companiesRoot: fixture.root,
    worktree,
    expectedFingerprint: foreignPreview.preview_fingerprint,
    inspectRuntimeUsage: runtimeIdle,
    inspectOwnerSession: ownerDead,
  })).rejects.toMatchObject({ code: "cleanup_not_ready" });
  expect(existsSync(join(dependencyPath, "README.md"))).toBe(true);
  expect(runGit(["worktree", "list", "--porcelain"], foreignRepo)).toContain("db");
  expect(existsSync(fixture.worktreePath)).toBe(true);
  expectCanonicalUntouched(fixture, canonicalDbHead);
});

test("apply odmítne stale preview fingerprint po nezávislé změně sidecaru", async () => {
  const fixture = await createCleanupFixture({ branch: "CAC-0099-cleanup-stale" });
  const worktree = await findWorktreeRecord(fixture);

  const preview = await previewWorktreeCleanup({
    companiesRoot: fixture.root,
    worktree,
    inspectRuntimeUsage: runtimeIdle,
    inspectOwnerSession: ownerDead,
  });
  expect(preview.state).toBe("ready_to_delete");

  const sidecar = JSON.parse(await readFile(fixture.sidecarPath, "utf8"));
  sidecar.last_touched = new Date().toISOString();
  await writeFile(fixture.sidecarPath, `${JSON.stringify(sidecar, null, 2)}\n`);

  await expect(applyWorktreeCleanup({
    companiesRoot: fixture.root,
    worktree,
    expectedFingerprint: preview.preview_fingerprint,
    inspectRuntimeUsage: runtimeIdle,
    inspectOwnerSession: ownerDead,
  })).rejects.toMatchObject({ code: "cleanup_stale_preview" });
  expect(existsSync(fixture.worktreePath)).toBe(true);
  expect(existsSync(fixture.sidecarPath)).toBe(true);
});

test("partial failure nechá pravdivý journal a resume dokončí jen zbývající kroky", async () => {
  const fixture = await createCleanupFixture({ branch: "CAC-0099-cleanup-resume" });
  const worktree = await findWorktreeRecord(fixture);
  const { preview, journalPath } = await interruptAfterDependencyRemoval(fixture, worktree);
  expect(existsSync(fixture.worktreePath)).toBe(true);

  // Preview nad rozpracovaným journalem pravdivě hlásí cleanup_incomplete.
  const midPreview = await previewWorktreeCleanup({
    companiesRoot: fixture.root,
    worktree,
    inspectRuntimeUsage: runtimeIdle,
    inspectOwnerSession: ownerDead,
  });
  expect(midPreview.state).toBe("needs_attention");
  expect(midPreview.blockers.map((blocker) => blocker.code)).toContain("cleanup_incomplete");
  expect(midPreview.journal.remaining_steps).toEqual(["remove_edit", "remove_sidecar"]);

  // Bez runtime evidence resume neběží; runtime, které se mezitím objevilo
  // (start je při journalu zakázaný), blokuje destruktivní krok.
  await expect(applyWorktreeCleanup({
    companiesRoot: fixture.root,
    worktree,
    expectedFingerprint: preview.preview_fingerprint,
    inspectOwnerSession: ownerDead,
  })).rejects.toMatchObject({ code: "cleanup_runtime_unverified" });
  await expect(applyWorktreeCleanup({
    companiesRoot: fixture.root,
    worktree,
    expectedFingerprint: preview.preview_fingerprint,
    inspectRuntimeUsage: async () => ({ verified: true, in_use: true, message: "app běží", details: [] }),
    inspectOwnerSession: ownerDead,
  })).rejects.toMatchObject({ code: "cleanup_runtime_in_use" });
  expectPartialEnvironmentIntact(fixture, journalPath);

  // Resume je vázaný na přesně původní preview fingerprint.
  await expect(applyWorktreeCleanup({
    companiesRoot: fixture.root,
    worktree,
    expectedFingerprint: "2".repeat(64),
    inspectRuntimeUsage: runtimeIdle,
    inspectOwnerSession: ownerDead,
  })).rejects.toMatchObject({ code: "cleanup_stale_preview" });
  expectPartialEnvironmentIntact(fixture, journalPath);

  const resumeLog = [];
  const applied = await applyWorktreeCleanup({
    companiesRoot: fixture.root,
    worktree,
    expectedFingerprint: preview.preview_fingerprint,
    inspectRuntimeUsage: runtimeIdle,
    inspectOwnerSession: ownerDead,
    runGitFn: recordingRunGit(resumeLog),
  });
  expect(applied.steps.map((step) => step.status)).toEqual(["completed", "completed", "completed", "completed"]);
  expect(existsSync(fixture.worktreePath)).toBe(false);
  expect(existsSync(fixture.sidecarPath)).toBe(false);
  expect(existsSync(journalPath)).toBe(false);
  // Dokončený dependency krok se při resume neopakuje jako destruktivní remove.
  expect(resumeLog.filter((entry) => entry.args[1] === "remove").length).toBe(1);
});

test("resume odmítne znovu živého vlastníka a nic neodstraní; po jeho smrti dokončí", async () => {
  const fixture = await createCleanupFixture({ branch: "CAC-0099-cleanup-reactivated" });
  const worktree = await findWorktreeRecord(fixture);
  const { preview, journalPath } = await interruptAfterDependencyRemoval(fixture, worktree);

  // Agent se mezitím obnovil (živý proces se session ID sidecaru); journal a
  // fingerprint jsou beze změny — resume musí fail-closed odmítnout.
  await expect(applyWorktreeCleanup({
    companiesRoot: fixture.root,
    worktree,
    expectedFingerprint: preview.preview_fingerprint,
    inspectRuntimeUsage: runtimeIdle,
    inspectOwnerSession: ownerAlive,
  })).rejects.toMatchObject({
    code: "cleanup_active_owner",
    details: expect.arrayContaining([expect.stringContaining("živý")]),
  });
  expectPartialEnvironmentIntact(fixture, journalPath);
  const journalAfter = JSON.parse(await readFile(journalPath, "utf8"));
  expect(journalAfter.steps.find((step) => step.id === "remove_edit").status).toBe("pending");
  expect(journalAfter.preview_fingerprint).toBe(preview.preview_fingerprint);

  // Neověřitelný vlastník také nestačí (abandoned větev vyžaduje důkaz smrti).
  await expect(applyWorktreeCleanup({
    companiesRoot: fixture.root,
    worktree,
    expectedFingerprint: preview.preview_fingerprint,
    inspectRuntimeUsage: runtimeIdle,
    inspectOwnerSession: ownerUnverified,
  })).rejects.toMatchObject({ code: "cleanup_not_ready" });
  expectPartialEnvironmentIntact(fixture, journalPath);

  const applied = await applyWorktreeCleanup({
    companiesRoot: fixture.root,
    worktree,
    expectedFingerprint: preview.preview_fingerprint,
    inspectRuntimeUsage: runtimeIdle,
    inspectOwnerSession: ownerDead,
  });
  expect(applied.steps.map((step) => step.status)).toEqual(["completed", "completed", "completed", "completed"]);
  expect(existsSync(fixture.worktreePath)).toBe(false);
  expect(existsSync(journalPath)).toBe(false);
});

test("resume odmítne drift identity: změněný sidecar i obsah vrácený na odstraněnou dependency cestu", async () => {
  const fixture = await createCleanupFixture({ branch: "CAC-0099-cleanup-identity" });
  const worktree = await findWorktreeRecord(fixture);
  const { preview, journalPath, journal } = await interruptAfterDependencyRemoval(fixture, worktree);

  const dependencyStep = journal.steps.find((step) => step.kind === "remove_dependency");
  await mkdir(dependencyStep.target_real_path, { recursive: true });
  await writeFile(join(dependencyStep.target_real_path, "notes.md"), "cizí obsah\n");
  await expect(applyWorktreeCleanup({
    companiesRoot: fixture.root,
    worktree,
    expectedFingerprint: preview.preview_fingerprint,
    inspectRuntimeUsage: runtimeIdle,
    inspectOwnerSession: ownerDead,
  })).rejects.toMatchObject({ code: "cleanup_journal_environment_mismatch" });
  expectPartialEnvironmentIntact(fixture, journalPath);
  expect(existsSync(join(dependencyStep.target_real_path, "notes.md"))).toBe(true);
  await rm(dependencyStep.target_real_path, { recursive: true, force: true });

  const sidecar = JSON.parse(await readFile(fixture.sidecarPath, "utf8"));
  sidecar.last_touched = new Date().toISOString();
  await writeFile(fixture.sidecarPath, `${JSON.stringify(sidecar, null, 2)}\n`);
  await expect(applyWorktreeCleanup({
    companiesRoot: fixture.root,
    worktree,
    expectedFingerprint: preview.preview_fingerprint,
    inspectRuntimeUsage: runtimeIdle,
    inspectOwnerSession: ownerDead,
  })).rejects.toMatchObject({ code: "cleanup_journal_environment_mismatch" });
  expectPartialEnvironmentIntact(fixture, journalPath);
});

test("resume merged práce po >15 min dokončí s journalem potvrzenou evidencí", async () => {
  const fixture = await createCleanupFixture({ branch: "CAC-0099-cleanup-resume-pr" });
  const { prHead } = await publishWithDrift(fixture);
  const worktree = await findWorktreeRecord(fixture);
  const evidence = mergedEvidence({ prHead });
  const { preview, journalPath, journal } = await interruptAfterDependencyRemoval(fixture, worktree, {
    prEvidence: evidence,
    inspectOwnerSession: ownerUnverified,
  });
  expect(journal.eligibility).toMatchObject({ basis: "merged", pr_evidence: { state: "MERGED", head_sha: prHead } });

  // Bez znovu dodané evidence resume neprokáže merged ani mrtvého vlastníka.
  await expect(applyWorktreeCleanup({
    companiesRoot: fixture.root,
    worktree,
    expectedFingerprint: preview.preview_fingerprint,
    inspectRuntimeUsage: runtimeIdle,
    inspectOwnerSession: ownerUnverified,
  })).rejects.toMatchObject({ code: "cleanup_not_ready" });
  expectPartialEnvironmentIntact(fixture, journalPath);

  // Čerstvě znovu ověřená evidence (jiný checked_at) resume dokončí: otisk je
  // vázaný na journalem potvrzený důkaz, čerstvost hlídá živý guard.
  const applied = await applyWorktreeCleanup({
    companiesRoot: fixture.root,
    worktree,
    expectedFingerprint: preview.preview_fingerprint,
    inspectRuntimeUsage: runtimeIdle,
    inspectOwnerSession: ownerUnverified,
    prEvidence: mergedEvidence({ prHead }),
  });
  expect(applied.steps.every((step) => step.status === "completed")).toBe(true);
  expect(existsSync(fixture.worktreePath)).toBe(false);
  expect(existsSync(journalPath)).toBe(false);
});

test("tamper journal cesty mimo environment resume odmítne bez destrukce", async () => {
  const fixture = await createCleanupFixture({ branch: "CAC-0099-cleanup-tamper" });
  const worktree = await findWorktreeRecord(fixture);
  const { preview, journalPath } = await interruptAfterDependencyRemoval(fixture, worktree);

  const journal = JSON.parse(await readFile(journalPath, "utf8"));
  journal.environment.owner_root = "/tmp/dev6555-attacker";
  await writeFile(journalPath, `${JSON.stringify(journal, null, 2)}\n`);
  await expect(applyWorktreeCleanup({
    companiesRoot: fixture.root,
    worktree,
    expectedFingerprint: preview.preview_fingerprint,
    inspectRuntimeUsage: runtimeIdle,
    inspectOwnerSession: ownerDead,
  })).rejects.toMatchObject({ code: "cleanup_journal_invalid" });

  // Journal, který by za worktree prohlásil owner (main) checkout, je neplatný.
  const original = JSON.parse(await readFile(journalPath, "utf8"));
  original.environment.owner_root = journal.environment.worktree_real_path;
  await writeFile(journalPath, `${JSON.stringify(original, null, 2)}\n`);
  await expect(applyWorktreeCleanup({
    companiesRoot: fixture.root,
    worktree,
    expectedFingerprint: preview.preview_fingerprint,
    inspectRuntimeUsage: runtimeIdle,
    inspectOwnerSession: ownerDead,
  })).rejects.toMatchObject({ code: "cleanup_journal_invalid" });
  expect(existsSync(fixture.worktreePath)).toBe(true);
  expect(existsSync(fixture.sidecarPath)).toBe(true);
});

test("action lane dokončí journal i po odstraněném edit worktree", async () => {
  const fixture = await createCleanupFixture({ branch: "CAC-0099-cleanup-tail" });
  const worktree = await findWorktreeRecord(fixture);
  const { preview, journalPath } = await interruptAfterDependencyRemoval(fixture, worktree);

  // Simulace pádu po provedeném remove_edit, ale před zápisem completed.
  runGit(["worktree", "remove", "--force", fixture.worktreePath], fixture.missionControlRepo);
  runGit(["worktree", "prune", "--expire", "now"], fixture.missionControlRepo);
  const journal = JSON.parse(await readFile(journalPath, "utf8"));
  journal.steps.find((step) => step.id === "remove_edit").status = "completed";
  await writeFile(journalPath, `${JSON.stringify(journal, null, 2)}\n`);

  const applied = await applyWorktreeCleanupEnvironment({
    companiesRoot: fixture.root,
    repoKey: "BetaCo::mission-control",
    slug: fixture.branch,
    expectedFingerprint: preview.preview_fingerprint,
    inspectRuntimeUsage: runtimeIdle,
    inspectOwnerSession: ownerDead,
    runGhFn: null,
  });
  expect(applied.steps.find((step) => step.id === "remove_sidecar").status).toBe("completed");
  expect(existsSync(fixture.sidecarPath)).toBe(false);
  expect(existsSync(journalPath)).toBe(false);
});

test("poškozený journal je fail-closed blocker bez destrukce", async () => {
  const fixture = await createCleanupFixture({ branch: "CAC-0099-cleanup-journal" });
  const worktree = await findWorktreeRecord(fixture);
  const journalPath = cleanupJournalPath({ companiesRoot: fixture.root, worktree });
  await writeFile(journalPath, "{ not json");

  const preview = await previewWorktreeCleanup({
    companiesRoot: fixture.root,
    worktree,
    inspectRuntimeUsage: runtimeIdle,
    inspectOwnerSession: ownerDead,
  });
  expect(preview.state).toBe("invalid");
  expect(preview.blockers.map((blocker) => blocker.code)).toContain("cleanup_journal_invalid");

  await expect(applyWorktreeCleanup({
    companiesRoot: fixture.root,
    worktree,
    expectedFingerprint: "0".repeat(64),
    inspectRuntimeUsage: runtimeIdle,
    inspectOwnerSession: ownerDead,
  })).rejects.toMatchObject({ code: "cleanup_journal_invalid" });
  expect(existsSync(fixture.worktreePath)).toBe(true);
});

fileSymlinkTest("symlink swap dependency cesty po preview selže zavřeně bez zásahu mimo environment", async () => {
  const fixture = await createCleanupFixture({ branch: "CAC-0099-cleanup-swap" });
  const worktree = await findWorktreeRecord(fixture);

  const preview = await previewWorktreeCleanup({
    companiesRoot: fixture.root,
    worktree,
    inspectRuntimeUsage: runtimeIdle,
    inspectOwnerSession: ownerDead,
  });
  expect(preview.state).toBe("ready_to_delete");

  // Útočný swap: dependency path nahradí symlink na canonical repository-db.
  const dependencyPath = join(fixture.worktreePath, "db");
  runGit(["worktree", "remove", dependencyPath], fixture.repositoryDbRepo);
  await symlink(fixture.repositoryDbRepo, dependencyPath);

  await expect(applyWorktreeCleanup({
    companiesRoot: fixture.root,
    worktree,
    expectedFingerprint: preview.preview_fingerprint,
    inspectRuntimeUsage: runtimeIdle,
    inspectOwnerSession: ownerDead,
  })).rejects.toMatchObject({ code: "cleanup_not_ready" });

  expect(existsSync(join(fixture.repositoryDbRepo, ".git"))).toBe(true);
  expect(runGit(["status", "--porcelain=v1", "--untracked-files=normal"], fixture.repositoryDbRepo)).toBe("");
});

test("action lane serializuje cleanup s create lockem a mapuje chyby na WorktreeActionError", async () => {
  const fixture = await createCleanupFixture({ branch: "CAC-0099-cleanup-action" });

  const preview = await previewWorktreeCleanupEnvironment({
    companiesRoot: fixture.root,
    repoKey: "BetaCo::mission-control",
    slug: fixture.branch,
    inspectRuntimeUsage: runtimeIdle,
    inspectOwnerSession: ownerDead,
    runGhFn: null,
  });
  expect(preview.state).toBe("ready_to_delete");

  await expect(applyWorktreeCleanupEnvironment({
    companiesRoot: fixture.root,
    repoKey: "BetaCo::mission-control",
    slug: fixture.branch,
    expectedFingerprint: "1".repeat(64),
    inspectRuntimeUsage: runtimeIdle,
    inspectOwnerSession: ownerDead,
    runGhFn: null,
  })).rejects.toMatchObject({ code: "cleanup_stale_preview", status: 409 });

  await expect(applyWorktreeCleanupEnvironment({
    companiesRoot: fixture.root,
    repoKey: "BetaCo::mission-control",
    slug: fixture.branch,
    expectedFingerprint: preview.preview_fingerprint,
    inspectRuntimeUsage: runtimeIdle,
    inspectOwnerSession: ownerAlive,
    runGhFn: null,
  })).rejects.toMatchObject({ code: "cleanup_not_ready", status: 409 });

  // Souběh: probíhající create (držený canonical lock) cleanup odmítne bez
  // destrukce; po uvolnění locku apply proběhne.
  const lockPath = join(fixture.orgRoot, ".worktrees", ".worktree-create.lock");
  const held = await acquireCreateLock({ lockPath, primaryRoot: fixture.orgRoot, branch: "CAC-0099-other", planCode: "CAC-0099" });
  expect(held.ok).toBe(true);
  await expect(applyWorktreeCleanupEnvironment({
    companiesRoot: fixture.root,
    repoKey: "BetaCo::mission-control",
    slug: fixture.branch,
    expectedFingerprint: preview.preview_fingerprint,
    inspectRuntimeUsage: runtimeIdle,
    inspectOwnerSession: ownerDead,
    runGhFn: null,
  })).rejects.toMatchObject({ code: "worktree_create_in_progress", status: 409 });
  expect(existsSync(fixture.worktreePath)).toBe(true);
  await releaseCreateLock(held.lock);

  const applied = await applyWorktreeCleanupEnvironment({
    companiesRoot: fixture.root,
    repoKey: "BetaCo::mission-control",
    slug: fixture.branch,
    expectedFingerprint: preview.preview_fingerprint,
    inspectRuntimeUsage: runtimeIdle,
    inspectOwnerSession: ownerDead,
    runGhFn: null,
  });
  expect(applied.action).toBe("cleanup_worktree");
  expect(existsSync(lockPath)).toBe(false);
  expect(existsSync(fixture.worktreePath)).toBe(false);
});

test("action lane bez explicitní evidence hledá MERGED PR podle head branche přes gh", async () => {
  const fixture = await createCleanupFixture({ branch: "CAC-0099-cleanup-gh" });
  const { prHead } = await publishWithDrift(fixture);
  // Owner repo má GitHub origin; gh lookup se odvozuje z něj, ne ze sidecaru.
  runGit(["remote", "set-url", "origin", "git@github.com:BetaCo/mission-control.git"], fixture.missionControlRepo);
  const ghCalls = [];
  const runGhFn = async (args) => {
    ghCalls.push(args);
    return {
      ok: true,
      stdout: JSON.stringify([{
        url: "https://github.com/BetaCo/mission-control/pull/9",
        state: "MERGED",
        headRefOid: prHead,
        headRefName: fixture.branch,
        mergedAt: new Date().toISOString(),
      }]),
      stderr: "",
    };
  };
  const preview = await previewWorktreeCleanupEnvironment({
    companiesRoot: fixture.root,
    repoKey: "BetaCo::mission-control",
    slug: fixture.branch,
    inspectRuntimeUsage: runtimeIdle,
    inspectOwnerSession: ownerUnverified,
    runGhFn,
  });
  expect(ghCalls[0]).toEqual(expect.arrayContaining(["pr", "list", "--repo", "BetaCo/mission-control", "--head", fixture.branch, "--state", "merged"]));
  expect(preview.state).toBe("ready_to_delete");
  expect(preview.eligibility.basis).toBe("merged");

  // Nedostupné gh (síť/auth) není falešný důkaz.
  const offline = await previewWorktreeCleanupEnvironment({
    companiesRoot: fixture.root,
    repoKey: "BetaCo::mission-control",
    slug: fixture.branch,
    inspectRuntimeUsage: runtimeIdle,
    inspectOwnerSession: ownerUnverified,
    runGhFn: async () => ({ ok: false, stdout: "", stderr: "gh: not logged in" }),
  });
  expect(offline.state).toBe("needs_attention");
  expect(offline.blockers.map((blocker) => blocker.code)).toContain("not_eligible");

  expect(await resolveMergedPullRequestEvidence({
    ownerRoot: fixture.missionControlRepo,
    branch: fixture.branch,
    runGhFn: async () => ({ ok: true, stdout: "[]", stderr: "" }),
  })).toBeNull();
});

test("lokální důkaz vlastníka: session ID v env běžícího procesu, jiná Mašina nebo chybějící locator jsou unverified", async () => {
  const origin = {
    machine_ref: "fixture-machine",
    surface: "claude-code",
    agent_label: "Claude Code",
    thread_id: "thread-123",
    thread_locator_status: "captured",
    local_only: true,
  };
  const processes = [
    { pid: 10, env: { CLAUDE_CODE_SESSION_ID: "thread-999" } },
    { pid: 11, env: { CODEX_THREAD_ID: "thread-123" } },
  ];
  const alive = await inspectLocalOwnerSession({
    conversationOrigin: origin,
    machineRef: "fixture-machine",
    platform: "linux",
    listProcessEnvironments: async () => processes,
  });
  expect(alive).toMatchObject({ verified: true, alive: true, details: ["pid=11: CODEX_THREAD_ID=thread-123"] });

  const dead = await inspectLocalOwnerSession({
    conversationOrigin: origin,
    machineRef: "fixture-machine",
    platform: "linux",
    listProcessEnvironments: async () => [processes[0]],
  });
  expect(dead).toMatchObject({ verified: true, alive: false });

  const otherMachine = await inspectLocalOwnerSession({
    conversationOrigin: origin,
    machineRef: "another-machine",
    listProcessEnvironments: async () => processes,
  });
  expect(otherMachine.verified).toBe(false);

  const noLocator = await inspectLocalOwnerSession({
    conversationOrigin: { ...origin, thread_locator_status: "unavailable", thread_id: null },
    machineRef: "fixture-machine",
    listProcessEnvironments: async () => processes,
  });
  expect(noLocator.verified).toBe(false);

  const automation = await inspectLocalOwnerSession({
    conversationOrigin: { ...origin, thread_locator_status: "not_applicable", thread_id: null },
    machineRef: "fixture-machine",
  });
  expect(automation).toMatchObject({ verified: true, alive: false });

  const unsupported = await inspectLocalOwnerSession({
    conversationOrigin: origin,
    machineRef: "fixture-machine",
    platform: "win32",
    listProcessEnvironments: async () => null,
  });
  expect(unsupported.verified).toBe(false);
});

test("durable runtime evidence blokuje na živém záznamu a pouští mrtvý", async () => {
  const fixture = await createCleanupFixture({ branch: "CAC-0099-cleanup-durable" });
  const stateRoot = join(fixture.root, "launchpad");
  const appStateDir = join(stateRoot, "runtime", "apps");
  await mkdir(appStateDir, { recursive: true });

  const record = (status, pid) => JSON.stringify({
    status,
    app_id: "betaco-mission-control-v3",
    runtime_source: { type: "worktree", slug: fixture.branch },
    pid,
  });

  await writeFile(join(appStateDir, "one.json"), record("healthy", process.pid));
  const live = await inspectDurableWorktreeRuntimeUsage({
    stateRoot,
    worktree: { slug: fixture.branch },
  });
  expect(live).toMatchObject({ verified: true, in_use: true });

  await writeFile(join(appStateDir, "one.json"), record("stopped", process.pid));
  const stopped = await inspectDurableWorktreeRuntimeUsage({
    stateRoot,
    worktree: { slug: fixture.branch },
  });
  expect(stopped).toMatchObject({ verified: true, in_use: false });

  await writeFile(join(appStateDir, "one.json"), "{ not json");
  const unreadable = await inspectDurableWorktreeRuntimeUsage({
    stateRoot,
    worktree: { slug: fixture.branch },
  });
  expect(unreadable.verified).toBe(false);
});
