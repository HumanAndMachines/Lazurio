import { afterAll, expect, test } from "bun:test";
import { existsSync } from "fs";
import { readFile, rm, symlink, writeFile } from "fs/promises";
import { join } from "path";
import {
  applyWorktreeCleanup,
  cleanupJournalPath,
  inspectDurableWorktreeRuntimeUsage,
  previewWorktreeCleanup,
} from "../../lazurio/runtime/worktree-cleanup-lib.mjs";
import { runGit as realRunGit } from "../../lazurio/runtime/git-lib.mjs";
import { buildWorktreeIndex } from "../../lazurio/runtime/worktree-lib.mjs";
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

async function setPlanStatus(fixture, { from, to }) {
  const planFile = join(fixture.orgRoot, fixture.planPath);
  const contents = await readFile(planFile, "utf8");
  if (!contents.includes(`status: ${from}`)) throw new Error(`plan fixture is not in status ${from}`);
  await writeFile(planFile, contents.replace(`status: ${from}`, `status: ${to}`));
  runGit(["add", "-A"], fixture.repositoryDbRepo);
  runGit(["commit", "-m", `plan ${to}`], fixture.repositoryDbRepo);
}

async function markPlanDone(fixture) {
  await setPlanStatus(fixture, { from: "in_progress", to: "done" });
}

// Přeruší apply po úspěšném remove_dependency: journal drží remove_edit a
// remove_sidecar pending, edit worktree i sidecar existují.
async function interruptAfterDependencyRemoval(fixture, worktree, { prEvidence = null } = {}) {
  const failingRunGit = recordingRunGit([], {
    failOn: (args, options) => args[1] === "remove" && !options?.cwd?.endsWith("db"),
  });
  const preview = await previewWorktreeCleanup({
    companiesRoot: fixture.root,
    worktree,
    inspectRuntimeUsage: runtimeIdle,
    prEvidence,
    runGitFn: failingRunGit,
  });
  expect(preview.state).toBe("ready_to_delete");
  await expect(applyWorktreeCleanup({
    companiesRoot: fixture.root,
    worktree,
    expectedFingerprint: preview.preview_fingerprint,
    inspectRuntimeUsage: runtimeIdle,
    prEvidence,
    runGitFn: failingRunGit,
  })).rejects.toMatchObject({ code: "cleanup_step_failed" });
  const journalPath = cleanupJournalPath({ companiesRoot: fixture.root, worktree });
  const journal = JSON.parse(await readFile(journalPath, "utf8"));
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

async function signOffSidecar(fixture, { disposition = "active", handoffState = "completed" } = {}) {
  const sidecar = JSON.parse(await readFile(fixture.sidecarPath, "utf8"));
  sidecar.recovery_handoff = {
    state: handoffState,
    summary: "Cleanup fixture sign-off.",
    blocker: null,
    next_action: "Ukliď environment.",
    updated_at: new Date().toISOString(),
  };
  sidecar.members = sidecar.members.map((member) =>
    member.role === "edit" ? { ...member, disposition } : member,
  );
  await writeFile(fixture.sidecarPath, `${JSON.stringify(sidecar, null, 2)}\n`);
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

test("preview čerstvého environmentu jmenuje writer a plan blockery bez zápisu", async () => {
  const fixture = await createCleanupFixture({ branch: "CAC-0099-cleanup-fresh" });
  const worktree = await findWorktreeRecord(fixture);

  const preview = await previewWorktreeCleanup({
    companiesRoot: fixture.root,
    worktree,
    inspectRuntimeUsage: runtimeIdle,
  });

  expect(preview.state).toBe("needs_attention");
  const codes = preview.blockers.map((blocker) => blocker.code);
  expect(codes).toContain("plan_not_terminal");
  expect(codes).toContain("active_writer");
  expect(existsSync(fixture.worktreePath)).toBe(true);
  expect(existsSync(fixture.sidecarPath)).toBe(true);
});

test("preview bez runtime evidence je fail-closed needs_attention", async () => {
  const fixture = await createCleanupFixture({ branch: "CAC-0099-cleanup-no-runtime" });
  await markPlanDone(fixture);
  await signOffSidecar(fixture);
  const worktree = await findWorktreeRecord(fixture);

  const preview = await previewWorktreeCleanup({ companiesRoot: fixture.root, worktree });
  expect(preview.state).toBe("needs_attention");
  expect(preview.blockers.map((blocker) => blocker.code)).toContain("runtime_unverified");

  const inUse = await previewWorktreeCleanup({
    companiesRoot: fixture.root,
    worktree,
    inspectRuntimeUsage: async () => ({ verified: true, in_use: true, message: "běží", details: ["pid=123"] }),
  });
  expect(inUse.blockers.map((blocker) => blocker.code)).toContain("runtime_in_use");
});

test("no-change environment je ready_to_delete a apply uklidí nested-first včetně sidecaru", async () => {
  const fixture = await createCleanupFixture({ branch: "CAC-0099-cleanup-happy" });
  await markPlanDone(fixture);
  await signOffSidecar(fixture);
  const worktree = await findWorktreeRecord(fixture);
  const canonicalDbHead = runGit(["rev-parse", "HEAD"], fixture.repositoryDbRepo);
  const gitLog = [];
  const runGitFn = recordingRunGit(gitLog);

  const preview = await previewWorktreeCleanup({
    companiesRoot: fixture.root,
    worktree,
    inspectRuntimeUsage: runtimeIdle,
    runGitFn,
  });
  expect(preview.state).toBe("ready_to_delete");
  expect(preview.blockers).toEqual([]);
  expect(preview.steps).toEqual(["remove_dependency:mission-control/db", "remove_edit", "remove_sidecar"]);
  expect(preview.preview_fingerprint).toMatch(/^[0-9a-f]{64}$/);
  expect(preview.branch_refs_kept[0].branch).toBe(fixture.branch);

  const applied = await applyWorktreeCleanup({
    companiesRoot: fixture.root,
    worktree,
    expectedFingerprint: preview.preview_fingerprint,
    inspectRuntimeUsage: runtimeIdle,
    runGitFn,
  });

  expect(applied.steps.map((step) => step.id)).toEqual([
    "remove_dependency:mission-control/db",
    "remove_edit",
    "remove_sidecar",
  ]);
  expect(applied.steps.every((step) => step.status === "completed")).toBe(true);
  expect(existsSync(fixture.worktreePath)).toBe(false);
  expect(existsSync(fixture.sidecarPath)).toBe(false);
  expect(existsSync(cleanupJournalPath({ companiesRoot: fixture.root, worktree }))).toBe(false);

  // Nested-first pořadí: dependency remove běží z canonical db repa dřív než
  // edit remove z owner module repa.
  const { realpath } = await import("fs/promises");
  const removes = gitLog.filter((entry) => entry.args[1] === "remove");
  expect(removes.length).toBe(2);
  expect(removes[0].cwd).toBe(join(fixture.orgRoot, "mission-control", "db"));
  expect(removes[1].cwd).toBe(await realpath(join(fixture.orgRoot, "mission-control")));

  // Canonical repository-db checkout, data i branch refs zůstávají beze změny.
  expect(runGit(["rev-parse", "HEAD"], fixture.repositoryDbRepo)).toBe(canonicalDbHead);
  expect(runGit(["status", "--porcelain=v1", "--untracked-files=normal"], fixture.repositoryDbRepo)).toBe("");
  expect(runGit(["worktree", "list", "--porcelain"], fixture.repositoryDbRepo)).not.toContain(fixture.branch);
  expect(runGit(["rev-parse", "--verify", `refs/heads/${fixture.branch}`], fixture.missionControlRepo)).toMatch(/^[0-9a-f]{40}$/);
});

test("publikovaná práce vyžaduje čerstvý exact-head PR důkaz a s MERGED evidencí projde", async () => {
  const fixture = await createCleanupFixture({ branch: "CAC-0099-cleanup-merged" });
  await writeFile(join(fixture.worktreePath, "draft.md"), "published work\n");
  await publishWorktreeDraft({
    companiesRoot: fixture.root,
    repoKey: "BetaCo::mission-control",
    slug: fixture.branch,
    commitMessage: "feat: cleanup fixture draft",
  });
  await markPlanDone(fixture);
  await signOffSidecar(fixture, { disposition: "merged" });
  const worktree = await findWorktreeRecord(fixture);
  const editHead = runGit(["rev-parse", "HEAD"], fixture.worktreePath);

  const withoutEvidence = await previewWorktreeCleanup({
    companiesRoot: fixture.root,
    worktree,
    inspectRuntimeUsage: runtimeIdle,
  });
  expect(withoutEvidence.state).toBe("needs_attention");
  expect(withoutEvidence.blockers.map((blocker) => blocker.code)).toContain("pr_evidence_missing");

  const staleEvidence = await previewWorktreeCleanup({
    companiesRoot: fixture.root,
    worktree,
    inspectRuntimeUsage: runtimeIdle,
    prEvidence: {
      url: "https://github.com/BetaCo/mission-control/pull/1",
      state: "MERGED",
      head_sha: editHead,
      checked_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    },
  });
  expect(staleEvidence.blockers.map((blocker) => blocker.code)).toContain("pr_evidence_stale");

  const wrongHead = await previewWorktreeCleanup({
    companiesRoot: fixture.root,
    worktree,
    inspectRuntimeUsage: runtimeIdle,
    prEvidence: {
      url: "https://github.com/BetaCo/mission-control/pull/1",
      state: "MERGED",
      head_sha: "0".repeat(40),
      checked_at: new Date().toISOString(),
    },
  });
  expect(wrongHead.blockers.map((blocker) => blocker.code)).toContain("pr_evidence_mismatch");

  const freshEvidence = {
    url: "https://github.com/BetaCo/mission-control/pull/1",
    state: "MERGED",
    head_sha: editHead,
    checked_at: new Date().toISOString(),
  };
  const ready = await previewWorktreeCleanup({
    companiesRoot: fixture.root,
    worktree,
    inspectRuntimeUsage: runtimeIdle,
    prEvidence: freshEvidence,
  });
  expect(ready.state).toBe("ready_to_delete");

  const applied = await applyWorktreeCleanup({
    companiesRoot: fixture.root,
    worktree,
    expectedFingerprint: ready.preview_fingerprint,
    inspectRuntimeUsage: runtimeIdle,
    prEvidence: freshEvidence,
  });
  expect(applied.steps.every((step) => step.status === "completed")).toBe(true);
  expect(existsSync(fixture.worktreePath)).toBe(false);
});

test("dirty edit worktree a lokální commit bez důkazu blokují apply beze změny na disku", async () => {
  const fixture = await createCleanupFixture({ branch: "CAC-0099-cleanup-dirty" });
  await markPlanDone(fixture);
  await signOffSidecar(fixture);
  await writeFile(join(fixture.worktreePath, "untracked.md"), "rozdělaná práce\n");
  const worktree = await findWorktreeRecord(fixture);

  const preview = await previewWorktreeCleanup({
    companiesRoot: fixture.root,
    worktree,
    inspectRuntimeUsage: runtimeIdle,
  });
  expect(preview.state).toBe("needs_attention");
  expect(preview.blockers.map((blocker) => blocker.code)).toContain("edit_dirty");

  await expect(applyWorktreeCleanup({
    companiesRoot: fixture.root,
    worktree,
    expectedFingerprint: preview.preview_fingerprint ?? "missing",
    inspectRuntimeUsage: runtimeIdle,
  })).rejects.toMatchObject({ code: "cleanup_not_ready" });
  expect(existsSync(fixture.worktreePath)).toBe(true);
  expect(existsSync(join(fixture.worktreePath, "db"))).toBe(true);
  expect(existsSync(fixture.sidecarPath)).toBe(true);
});

test("apply odmítne stale preview fingerprint po nezávislé změně sidecaru", async () => {
  const fixture = await createCleanupFixture({ branch: "CAC-0099-cleanup-stale" });
  await markPlanDone(fixture);
  await signOffSidecar(fixture);
  const worktree = await findWorktreeRecord(fixture);

  const preview = await previewWorktreeCleanup({
    companiesRoot: fixture.root,
    worktree,
    inspectRuntimeUsage: runtimeIdle,
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
  })).rejects.toMatchObject({ code: "cleanup_stale_preview" });
  expect(existsSync(fixture.worktreePath)).toBe(true);
  expect(existsSync(fixture.sidecarPath)).toBe(true);
});

test("partial failure nechá pravdivý journal a resume dokončí jen zbývající kroky", async () => {
  const fixture = await createCleanupFixture({ branch: "CAC-0099-cleanup-resume" });
  await markPlanDone(fixture);
  await signOffSidecar(fixture);
  const worktree = await findWorktreeRecord(fixture);
  const journalPath = cleanupJournalPath({ companiesRoot: fixture.root, worktree });
  const gitLog = [];
  const failingRunGit = recordingRunGit(gitLog, {
    failOn: (args, options) => args[1] === "remove" && !options?.cwd?.endsWith("db"),
  });

  const preview = await previewWorktreeCleanup({
    companiesRoot: fixture.root,
    worktree,
    inspectRuntimeUsage: runtimeIdle,
    runGitFn: failingRunGit,
  });
  expect(preview.state).toBe("ready_to_delete");

  await expect(applyWorktreeCleanup({
    companiesRoot: fixture.root,
    worktree,
    expectedFingerprint: preview.preview_fingerprint,
    inspectRuntimeUsage: runtimeIdle,
    runGitFn: failingRunGit,
  })).rejects.toMatchObject({ code: "cleanup_step_failed" });

  const journal = JSON.parse(await readFile(journalPath, "utf8"));
  expect(journal.steps.find((step) => step.id === "remove_dependency:mission-control/db").status).toBe("completed");
  expect(journal.steps.find((step) => step.id === "remove_edit").status).toBe("pending");
  expect(existsSync(join(fixture.worktreePath, "db"))).toBe(false);
  expect(existsSync(fixture.worktreePath)).toBe(true);

  // Preview nad rozpracovaným journalem pravdivě hlásí cleanup_incomplete.
  const midPreview = await previewWorktreeCleanup({
    companiesRoot: fixture.root,
    worktree,
    inspectRuntimeUsage: runtimeIdle,
  });
  expect(midPreview.state).toBe("needs_attention");
  expect(midPreview.blockers.map((blocker) => blocker.code)).toContain("cleanup_incomplete");
  expect(midPreview.journal.remaining_steps).toEqual(["remove_edit", "remove_sidecar"]);

  // Resume znovu vyžaduje runtime evidenci: mezitím spuštěný environment
  // destruktivní krok zablokuje bez zásahu.
  await expect(applyWorktreeCleanup({
    companiesRoot: fixture.root,
    worktree,
    expectedFingerprint: preview.preview_fingerprint,
    inspectRuntimeUsage: async () => ({ verified: true, in_use: true, message: "app běží", details: [] }),
  })).rejects.toMatchObject({ code: "cleanup_runtime_in_use" });
  expect(existsSync(fixture.worktreePath)).toBe(true);
  await expect(applyWorktreeCleanup({
    companiesRoot: fixture.root,
    worktree,
    expectedFingerprint: preview.preview_fingerprint,
  })).rejects.toMatchObject({ code: "cleanup_runtime_unverified" });
  expect(existsSync(fixture.worktreePath)).toBe(true);

  // Resume je vázaný na přesně původní preview fingerprint.
  await expect(applyWorktreeCleanup({
    companiesRoot: fixture.root,
    worktree,
    expectedFingerprint: "2".repeat(64),
    inspectRuntimeUsage: runtimeIdle,
  })).rejects.toMatchObject({ code: "cleanup_stale_preview" });
  expect(existsSync(fixture.worktreePath)).toBe(true);

  const resumeLog = [];
  const applied = await applyWorktreeCleanup({
    companiesRoot: fixture.root,
    worktree,
    expectedFingerprint: preview.preview_fingerprint,
    inspectRuntimeUsage: runtimeIdle,
    runGitFn: recordingRunGit(resumeLog),
  });
  expect(applied.steps.map((step) => step.status)).toEqual(["completed", "completed", "completed"]);
  expect(existsSync(fixture.worktreePath)).toBe(false);
  expect(existsSync(fixture.sidecarPath)).toBe(false);
  expect(existsSync(journalPath)).toBe(false);
  // Dokončený dependency krok se při resume neopakuje jako destruktivní remove.
  expect(resumeLog.filter((entry) => entry.args[1] === "remove").length).toBe(1);
});

test("resume odmítne znovu aktivovaný Mission Control plán a nic neodstraní", async () => {
  const fixture = await createCleanupFixture({ branch: "CAC-0099-cleanup-reactivated" });
  await markPlanDone(fixture);
  await signOffSidecar(fixture);
  const worktree = await findWorktreeRecord(fixture);
  const { preview, journalPath } = await interruptAfterDependencyRemoval(fixture, worktree);

  // Plán se po přerušení cleanupu vrátil do práce; sidecar i journal
  // fingerprint jsou beze změny — právě scénář z exact-head review.
  await setPlanStatus(fixture, { from: "done", to: "in_progress" });

  await expect(applyWorktreeCleanup({
    companiesRoot: fixture.root,
    worktree,
    expectedFingerprint: preview.preview_fingerprint,
    inspectRuntimeUsage: runtimeIdle,
  })).rejects.toMatchObject({
    code: "cleanup_not_ready",
    details: expect.arrayContaining([expect.stringContaining("in_progress")]),
  });
  expectPartialEnvironmentIntact(fixture, journalPath);
  const journalAfter = JSON.parse(await readFile(journalPath, "utf8"));
  expect(journalAfter.steps.find((step) => step.id === "remove_edit").status).toBe("pending");
  expect(journalAfter.preview_fingerprint).toBe(preview.preview_fingerprint);

  // Návrat plánu do terminálního stavu resume znovu odemkne se stejným
  // potvrzeným fingerprintem — guard je živý, ne trvale zaseknutý.
  await setPlanStatus(fixture, { from: "in_progress", to: "done" });
  const applied = await applyWorktreeCleanup({
    companiesRoot: fixture.root,
    worktree,
    expectedFingerprint: preview.preview_fingerprint,
    inspectRuntimeUsage: runtimeIdle,
  });
  expect(applied.steps.map((step) => step.status)).toEqual(["completed", "completed", "completed"]);
  expect(existsSync(fixture.worktreePath)).toBe(false);
  expect(existsSync(fixture.sidecarPath)).toBe(false);
  expect(existsSync(journalPath)).toBe(false);
});

test("resume odmítne drift identity: změněný sidecar i obsah vrácený na odstraněnou dependency cestu", async () => {
  const fixture = await createCleanupFixture({ branch: "CAC-0099-cleanup-identity" });
  await markPlanDone(fixture);
  await signOffSidecar(fixture);
  const worktree = await findWorktreeRecord(fixture);
  const { preview, journalPath, journal } = await interruptAfterDependencyRemoval(fixture, worktree);

  // Něco se na cestu odstraněného dependency memberu vrátilo (gitignorovaná
  // cesta — remove_edit by ji tiše smazal).
  const { mkdir } = await import("fs/promises");
  const dependencyStep = journal.steps.find((step) => step.kind === "remove_dependency");
  await mkdir(dependencyStep.target_real_path, { recursive: true });
  await writeFile(join(dependencyStep.target_real_path, "notes.md"), "cizí obsah\n");
  await expect(applyWorktreeCleanup({
    companiesRoot: fixture.root,
    worktree,
    expectedFingerprint: preview.preview_fingerprint,
    inspectRuntimeUsage: runtimeIdle,
  })).rejects.toMatchObject({ code: "cleanup_journal_environment_mismatch" });
  expectPartialEnvironmentIntact(fixture, journalPath);
  expect(existsSync(join(dependencyStep.target_real_path, "notes.md"))).toBe(true);
  await rm(dependencyStep.target_real_path, { recursive: true, force: true });

  // Sidecar upravený po zahájení cleanupu (i jen last_touched) journal nepřijme.
  const sidecar = JSON.parse(await readFile(fixture.sidecarPath, "utf8"));
  sidecar.last_touched = new Date().toISOString();
  await writeFile(fixture.sidecarPath, `${JSON.stringify(sidecar, null, 2)}\n`);
  await expect(applyWorktreeCleanup({
    companiesRoot: fixture.root,
    worktree,
    expectedFingerprint: preview.preview_fingerprint,
    inspectRuntimeUsage: runtimeIdle,
  })).rejects.toMatchObject({ code: "cleanup_journal_environment_mismatch" });
  expectPartialEnvironmentIntact(fixture, journalPath);
});

test("resume publikované práce znovu vyžaduje čerstvou exact-head PR evidenci", async () => {
  const fixture = await createCleanupFixture({ branch: "CAC-0099-cleanup-resume-pr" });
  await writeFile(join(fixture.worktreePath, "draft.md"), "published work\n");
  await publishWorktreeDraft({
    companiesRoot: fixture.root,
    repoKey: "BetaCo::mission-control",
    slug: fixture.branch,
    commitMessage: "feat: cleanup resume fixture draft",
  });
  await markPlanDone(fixture);
  await signOffSidecar(fixture, { disposition: "merged" });
  const worktree = await findWorktreeRecord(fixture);
  const editHead = runGit(["rev-parse", "HEAD"], fixture.worktreePath);
  const evidence = (checkedAt) => ({
    url: "https://github.com/BetaCo/mission-control/pull/2",
    state: "MERGED",
    head_sha: editHead,
    checked_at: checkedAt.toISOString(),
  });
  const { preview, journalPath, journal } = await interruptAfterDependencyRemoval(fixture, worktree, {
    prEvidence: evidence(new Date()),
  });
  expect(journal.pr_evidence).toMatchObject({ state: "MERGED", head_sha: editHead });

  // Bez evidence nebo se stale evidencí resume neprokáže zachování práce.
  await expect(applyWorktreeCleanup({
    companiesRoot: fixture.root,
    worktree,
    expectedFingerprint: preview.preview_fingerprint,
    inspectRuntimeUsage: runtimeIdle,
  })).rejects.toMatchObject({
    code: "cleanup_not_ready",
    details: expect.arrayContaining([expect.stringContaining("PR/disposition důkaz")]),
  });
  expectPartialEnvironmentIntact(fixture, journalPath);
  await expect(applyWorktreeCleanup({
    companiesRoot: fixture.root,
    worktree,
    expectedFingerprint: preview.preview_fingerprint,
    inspectRuntimeUsage: runtimeIdle,
    prEvidence: evidence(new Date(Date.now() - 60 * 60 * 1000)),
  })).rejects.toMatchObject({ code: "cleanup_not_ready" });
  expectPartialEnvironmentIntact(fixture, journalPath);

  // Čerstvě znovu ověřená evidence (jiný checked_at než v preview) resume
  // dokončí: fingerprint je vázaný na journalem potvrzený důkaz, čerstvost
  // hlídá živý guard.
  const applied = await applyWorktreeCleanup({
    companiesRoot: fixture.root,
    worktree,
    expectedFingerprint: preview.preview_fingerprint,
    inspectRuntimeUsage: runtimeIdle,
    prEvidence: evidence(new Date()),
  });
  expect(applied.steps.map((step) => step.status)).toEqual(["completed", "completed", "completed"]);
  expect(existsSync(fixture.worktreePath)).toBe(false);
  expect(existsSync(journalPath)).toBe(false);
});

test("required slot bez sidecar memberu blokuje cleanup fail-closed", async () => {
  const fixture = await createCleanupFixture({ branch: "CAC-0099-cleanup-slotless" });
  await markPlanDone(fixture);
  await signOffSidecar(fixture);
  const sidecar = JSON.parse(await readFile(fixture.sidecarPath, "utf8"));
  sidecar.members = sidecar.members.filter((member) => member.role !== "dependency");
  await writeFile(fixture.sidecarPath, `${JSON.stringify(sidecar, null, 2)}\n`);
  const worktree = await findWorktreeRecord(fixture);

  const preview = await previewWorktreeCleanup({
    companiesRoot: fixture.root,
    worktree,
    inspectRuntimeUsage: runtimeIdle,
  });
  expect(preview.state).toBe("needs_attention");
  expect(preview.blockers.map((blocker) => blocker.code)).toContain("member_shape_invalid");
});

test("tamper journal cesty mimo environment resume odmítne bez destrukce", async () => {
  const fixture = await createCleanupFixture({ branch: "CAC-0099-cleanup-tamper" });
  await markPlanDone(fixture);
  await signOffSidecar(fixture);
  const worktree = await findWorktreeRecord(fixture);
  const journalPath = cleanupJournalPath({ companiesRoot: fixture.root, worktree });
  const failingRunGit = recordingRunGit([], {
    failOn: (args, options) => args[1] === "remove" && !options?.cwd?.endsWith("db"),
  });
  const preview = await previewWorktreeCleanup({
    companiesRoot: fixture.root,
    worktree,
    inspectRuntimeUsage: runtimeIdle,
    runGitFn: failingRunGit,
  });
  await expect(applyWorktreeCleanup({
    companiesRoot: fixture.root,
    worktree,
    expectedFingerprint: preview.preview_fingerprint,
    inspectRuntimeUsage: runtimeIdle,
    runGitFn: failingRunGit,
  })).rejects.toMatchObject({ code: "cleanup_step_failed" });

  const journal = JSON.parse(await readFile(journalPath, "utf8"));
  journal.environment.owner_root = "/tmp/dev6555-attacker";
  await writeFile(journalPath, `${JSON.stringify(journal, null, 2)}\n`);

  await expect(applyWorktreeCleanup({
    companiesRoot: fixture.root,
    worktree,
    expectedFingerprint: preview.preview_fingerprint,
    inspectRuntimeUsage: runtimeIdle,
  })).rejects.toMatchObject({ code: "cleanup_journal_invalid" });
  expect(existsSync(fixture.worktreePath)).toBe(true);
  expect(existsSync(fixture.sidecarPath)).toBe(true);
});

test("action lane dokončí journal i po odstraněném edit worktree", async () => {
  const fixture = await createCleanupFixture({ branch: "CAC-0099-cleanup-tail" });
  await markPlanDone(fixture);
  await signOffSidecar(fixture);
  const worktree = await findWorktreeRecord(fixture);
  const journalPath = cleanupJournalPath({ companiesRoot: fixture.root, worktree });
  const failingRunGit = recordingRunGit([], {
    failOn: (args, options) => args[1] === "remove" && !options?.cwd?.endsWith("db"),
  });
  const preview = await previewWorktreeCleanup({
    companiesRoot: fixture.root,
    worktree,
    inspectRuntimeUsage: runtimeIdle,
    runGitFn: failingRunGit,
  });
  await expect(applyWorktreeCleanup({
    companiesRoot: fixture.root,
    worktree,
    expectedFingerprint: preview.preview_fingerprint,
    inspectRuntimeUsage: runtimeIdle,
    runGitFn: failingRunGit,
  })).rejects.toMatchObject({ code: "cleanup_step_failed" });

  // Simulace pádu po provedeném remove_edit, ale před zápisem completed:
  // worktree je pryč, journal drží remove_edit completed a remove_sidecar pending.
  runGit(["worktree", "remove", fixture.worktreePath], fixture.missionControlRepo);
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
  });
  expect(applied.steps.find((step) => step.id === "remove_sidecar").status).toBe("completed");
  expect(existsSync(fixture.sidecarPath)).toBe(false);
  expect(existsSync(journalPath)).toBe(false);
});

test("poškozený journal je fail-closed blocker bez destrukce", async () => {
  const fixture = await createCleanupFixture({ branch: "CAC-0099-cleanup-journal" });
  await markPlanDone(fixture);
  await signOffSidecar(fixture);
  const worktree = await findWorktreeRecord(fixture);
  const journalPath = cleanupJournalPath({ companiesRoot: fixture.root, worktree });
  await writeFile(journalPath, "{ not json");

  const preview = await previewWorktreeCleanup({
    companiesRoot: fixture.root,
    worktree,
    inspectRuntimeUsage: runtimeIdle,
  });
  expect(preview.state).toBe("invalid");
  expect(preview.blockers.map((blocker) => blocker.code)).toContain("cleanup_journal_invalid");

  await expect(applyWorktreeCleanup({
    companiesRoot: fixture.root,
    worktree,
    expectedFingerprint: "0".repeat(64),
    inspectRuntimeUsage: runtimeIdle,
  })).rejects.toMatchObject({ code: "cleanup_journal_invalid" });
  expect(existsSync(fixture.worktreePath)).toBe(true);
});

fileSymlinkTest("symlink swap dependency cesty po preview selže zavřeně bez zásahu mimo environment", async () => {
  const fixture = await createCleanupFixture({ branch: "CAC-0099-cleanup-swap" });
  await markPlanDone(fixture);
  await signOffSidecar(fixture);
  const worktree = await findWorktreeRecord(fixture);

  const preview = await previewWorktreeCleanup({
    companiesRoot: fixture.root,
    worktree,
    inspectRuntimeUsage: runtimeIdle,
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
  })).rejects.toMatchObject({ code: "cleanup_not_ready" });

  // Canonical repository-db za symlinkem zůstal nedotčený.
  expect(existsSync(join(fixture.repositoryDbRepo, ".git"))).toBe(true);
  expect(runGit(["status", "--porcelain=v1", "--untracked-files=normal"], fixture.repositoryDbRepo)).toBe("");
});

test("action lane drží canonical create lock a mapuje cleanup chyby na WorktreeActionError", async () => {
  const fixture = await createCleanupFixture({ branch: "CAC-0099-cleanup-action" });
  await markPlanDone(fixture);
  await signOffSidecar(fixture);

  const preview = await previewWorktreeCleanupEnvironment({
    companiesRoot: fixture.root,
    repoKey: "BetaCo::mission-control",
    slug: fixture.branch,
    inspectRuntimeUsage: runtimeIdle,
  });
  expect(preview.state).toBe("ready_to_delete");

  await expect(applyWorktreeCleanupEnvironment({
    companiesRoot: fixture.root,
    repoKey: "BetaCo::mission-control",
    slug: fixture.branch,
    expectedFingerprint: "1".repeat(64),
    inspectRuntimeUsage: runtimeIdle,
  })).rejects.toMatchObject({ code: "cleanup_stale_preview", status: 409 });

  const applied = await applyWorktreeCleanupEnvironment({
    companiesRoot: fixture.root,
    repoKey: "BetaCo::mission-control",
    slug: fixture.branch,
    expectedFingerprint: preview.preview_fingerprint,
    inspectRuntimeUsage: runtimeIdle,
  });
  expect(applied.action).toBe("cleanup_worktree");
  expect(existsSync(join(fixture.orgRoot, ".worktrees", ".worktree-create.lock"))).toBe(false);
  expect(existsSync(fixture.worktreePath)).toBe(false);
});

test("durable runtime evidence blokuje na živém záznamu a pouští mrtvý", async () => {
  const fixture = await createCleanupFixture({ branch: "CAC-0099-cleanup-durable" });
  const stateRoot = join(fixture.root, "launchpad");
  const appStateDir = join(stateRoot, "runtime", "apps");
  const { mkdir } = await import("fs/promises");
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
