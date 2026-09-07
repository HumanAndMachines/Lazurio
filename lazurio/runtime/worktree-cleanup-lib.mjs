import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, readFile, readdir, realpath, rename, rm, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve, win32 } from "node:path";
import { inspectCanonicalPathBoundary, isPathSameOrDescendant } from "../core/path-boundary-lib.mjs";
import { GIT_LOCAL_TIMEOUT_MS, runGit as defaultRunGit } from "./git-lib.mjs";
import { readGitOperationState } from "./git-status-lib.mjs";
import { readMissionControlPlanAt } from "./mission-control-plan-lib.mjs";
import {
  inspectRepositoryDbWorktreeBinding,
  readRequiredRepositoryDbWorktreeSlots,
} from "./repository-db-worktree-lib.mjs";

export const CLEANUP_PREVIEW_SCHEMA = "companiesascode.worktree_cleanup_preview.v1";
export const CLEANUP_APPLY_SCHEMA = "companiesascode.worktree_cleanup_apply.v1";
export const CLEANUP_JOURNAL_SCHEMA = "companiesascode.worktree_cleanup_journal.v1";

// PR evidence starší než toto okno je stale cache, ne živý důkaz (manual guard 11).
export const PR_EVIDENCE_FRESHNESS_MS = 15 * 60 * 1000;

const SHA = /^[0-9a-f]{40}$/;
const TERMINAL_PLAN_STATUSES = new Set(["done", "archived"]);

export class WorktreeCleanupError extends Error {
  constructor(message, { code = "worktree_cleanup_error", details = [] } = {}) {
    super(message);
    this.name = "WorktreeCleanupError";
    this.code = code;
    this.details = details;
  }
}

// Read-only eligibility snapshot pro přesně jeden Launchpadem vytvořený
// single-edit environment (DEV-6555 úzká lane). Nikdy nic nezapisuje;
// ready_to_delete znamená, že všechny povinné cleanup guardy právě prošly.
export async function previewWorktreeCleanup(options = {}) {
  const { preview } = await inspectCleanupEnvironment(options);
  return preview;
}

// Jediná pravda cleanup guardů pro fresh preview i journal resume. Bez
// `resumeJournal` je to read-only preview. S ním se tytéž guardy přepočítají
// nad rozpracovaným environmentem: už odstraněné members se prokazují
// journalem (absence + neregistrace), všechno ostatní — Mission Control plán,
// sidecar handoff/disposition, edit registrace/HEAD/čistota, dependency
// množina, runtime a PR evidence — se čte znovu ze živého stavu a identita
// (sidecar otisk, worktree cesta, exact HEAD) musí sedět na journal.
async function inspectCleanupEnvironment({
  companiesRoot,
  worktree,
  resumeJournal = null,
  inspectRuntimeUsage = null,
  prEvidence = null,
  runGitFn = defaultRunGit,
  now = () => new Date(),
} = {}) {
  if (!companiesRoot) throw new Error("previewWorktreeCleanup requires companiesRoot");
  if (!worktree || typeof worktree !== "object") throw new Error("previewWorktreeCleanup requires a worktree index record");

  const generatedAt = now().toISOString();
  const organizationRoot = resolve(companiesRoot, worktree.organization_path);
  const sidecarPath = resolve(companiesRoot, worktree.sidecar_path);
  const worktreePath = resolve(companiesRoot, worktree.path);
  const journalPath = cleanupJournalPath({ companiesRoot, worktree });
  const blockers = [];
  const environment = {
    organization: worktree.organization ?? null,
    slug: worktree.slug ?? null,
    module: worktree.module ?? null,
    worktree_path: worktree.path ?? null,
    sidecar_path: worktree.sidecar_path ?? null,
    branch: null,
    plan_code: null,
  };
  const snapshot = {
    sidecar: null,
    worktreeRealPath: null,
    edit: null,
    plan: null,
    handoffState: null,
    runtime: null,
    dependencies: [],
    fingerprint: null,
  };
  const base = (state, extra = {}) => ({
    preview: {
      schema_version: CLEANUP_PREVIEW_SCHEMA,
      generated_at: generatedAt,
      environment,
      state,
      blockers,
      steps: [],
      branch_refs_kept: [],
      preview_fingerprint: null,
      journal: null,
      ...extra,
    },
    snapshot,
  });
  const editRemoved = journalStepCompleted(resumeJournal, "remove_edit");

  // 1) Sidecar: běžný soubor uvnitř Organization rootu s validním kontraktem.
  //    Při resume musí být bajt po bajtu ten, se kterým cleanup začal.
  const sidecar = await readCleanupSidecar({ organizationRoot, sidecarPath, blockers });
  if (!sidecar) return base("invalid");
  snapshot.sidecar = sidecar;
  environment.branch = sidecar.metadata.branch ?? null;
  environment.plan_code = sidecar.metadata.mission_control_plan_code ?? null;
  if (resumeJournal && sidecar.sha256 !== resumeJournal.environment.sidecar_sha256) {
    blockers.push(blocker(
      "cleanup_journal_environment_mismatch",
      "Sidecar se od zahájení cleanupu změnil; journal se neaplikuje na jiný obsah.",
    ));
    return base("needs_attention");
  }
  const editMember = sidecar.editMember;
  const dependencyMembers = sidecar.dependencyMembers;

  // 2) Worktree cesta: existující běžný adresář bez symlink/junction úniku.
  //    Po dokončeném remove_edit je jedinou pravdou o cestě journal; návrat
  //    adresáře na tutéž cestu je cizí obsah, který cleanup nesmí zasáhnout.
  let worktreeRealPath;
  if (editRemoved) {
    if (existsSync(worktreePath)) {
      blockers.push(blocker(
        "cleanup_journal_environment_mismatch",
        `Worktree cesta ${worktree.path} po dokončeném remove_edit znovu existuje; cleanup se neobnoví.`,
      ));
      return base("needs_attention");
    }
    worktreeRealPath = resumeJournal.environment.worktree_real_path;
  } else {
    if (!existsSync(worktreePath)) {
      blockers.push(blocker("worktree_missing", `Worktree cesta ${worktree.path} neexistuje; kandidát na repair/prune, ne běžný cleanup.`));
      return base("missing_path");
    }
    const worktreeBoundary = await inspectWorktreeDirectory({ organizationRoot, worktreePath });
    if (!worktreeBoundary.ok) {
      blockers.push(blocker("containment_invalid", worktreeBoundary.message));
      return base("invalid");
    }
    worktreeRealPath = worktreeBoundary.realPath;
    if (resumeJournal && !samePath(worktreeRealPath, resumeJournal.environment.worktree_real_path)) {
      blockers.push(blocker(
        "cleanup_journal_environment_mismatch",
        "Journal identita nesedí na aktuální worktree cestu; cleanup se neobnoví.",
      ));
      return base("needs_attention");
    }
  }
  snapshot.worktreeRealPath = worktreeRealPath;

  // 3) Journal z předchozího nedokončeného apply: preview jej pravdivě ukáže,
  //    ale ready_to_delete z něj nikdy neodvodí — dokončení patří apply resume,
  //    který tuto funkci volá znovu s `resumeJournal`.
  if (!resumeJournal) {
    const journal = await readCleanupJournal({ journalPath });
    if (journal.state === "invalid") {
      blockers.push(blocker("cleanup_journal_invalid", journal.message));
      return base("invalid", { journal: journal.summary });
    }
    if (journal.state === "present") {
      blockers.push(blocker(
        "cleanup_incomplete",
        "Předchozí cleanup apply nedoběhl; zbývající kroky dokončí opakovaný apply stejného environmentu.",
        journal.value.steps.filter((step) => step.status !== "completed").map((step) => step.id),
      ));
      return base("needs_attention", { journal: journal.summary });
    }
  }

  // 4) Edit member: exact registrace u owner repa, clean včetně untracked,
  //    žádná probíhající Git operace, branch odpovídá sidecaru. Owner repo se
  //    odvozuje z Git registru samotného worktree a musí ležet uvnitř
  //    Organization rootu (root_repo i module worktrees mají různé ownery).
  //    Po dokončeném remove_edit nese exact HEAD i ownera journal.
  const edit = editRemoved
    ? {
        blockers: [],
        head: resumeJournal.environment.edit_head,
        ownerRoot: resumeJournal.environment.owner_root,
        remoteRefsContainHead: false,
      }
    : await inspectEditWorktree({
        organizationRoot,
        worktreePath,
        worktreeRealPath,
        branch: sidecar.metadata.branch,
        runGitFn,
      });
  blockers.push(...edit.blockers);
  if (resumeJournal && !editRemoved && edit.head && edit.head !== resumeJournal.environment.edit_head) {
    blockers.push(blocker(
      "cleanup_journal_environment_mismatch",
      "Exact HEAD edit worktree se od zahájení cleanupu změnil; journal se neaplikuje.",
    ));
  }
  snapshot.edit = edit;

  // 5) Zachování práce: buď žádná změna nikdy nevznikla, nebo čerstvý
  //    exact-head PR/disposition důkaz (manual guard 9). Hodnotí se živě,
  //    dokud edit worktree existuje; po jeho odstranění drží potvrzený důkaz
  //    journal a preview fingerprint.
  if (edit.head && !editRemoved) {
    blockers.push(...evaluateHeadPreservation({
      editMember,
      editHead: edit.head,
      remoteRefsContainHead: edit.remoteRefsContainHead,
      prEvidence,
      now,
    }));
  }

  // 6) Terminal plán nebo explicitní abandon + writer sign-off.
  const plan = await readMissionControlPlanAt({
    companiesRoot,
    organizationPath: worktree.organization_path,
    planPath: sidecar.metadata.mission_control_plan_path,
  });
  if (!plan) {
    blockers.push(blocker("plan_missing", `Mission Control plán ${sidecar.metadata.mission_control_plan_path} neexistuje; ownership nelze ověřit.`));
  } else if (!TERMINAL_PLAN_STATUSES.has(plan.status) && editMember.disposition !== "abandoned") {
    blockers.push(blocker(
      "plan_not_terminal",
      `Mission Control plán ${plan.code} je ve stavu ${plan.status ?? "unknown"}; cleanup vyžaduje done/archived plán nebo explicitně abandoned edit member.`,
    ));
  }
  const handoffState = sidecar.metadata.recovery_handoff?.state ?? null;
  if (handoffState !== "completed" && !["merged", "abandoned"].includes(editMember.disposition)) {
    blockers.push(blocker(
      "active_writer",
      `Recovery handoff je ve stavu ${handoffState ?? "missing"} a edit disposition je ${editMember.disposition}; environment nemá writer sign-off.`,
    ));
  }
  snapshot.plan = plan;
  snapshot.handoffState = handoffState;

  // 7) Runtime: bez ověřeného „nic environment nepoužívá" se nemaže.
  const runtime = await resolveRuntimeEvidence({ inspectRuntimeUsage, environment, worktreeRealPath });
  if (!runtime.verified) {
    blockers.push(blocker("runtime_unverified", runtime.message, runtime.details));
  } else if (runtime.in_use) {
    blockers.push(blocker("runtime_in_use", runtime.message, runtime.details));
  }
  snapshot.runtime = runtime;

  // 8) Dependency members: exact detached binding u kanonického ownera —
  //    zároveň reverse-order teardown dry-run (manual guard 12).
  const dependencies = await inspectDependencyMembers({
    organizationRoot,
    worktreePath,
    metadata: sidecar.metadata,
    dependencyMembers,
    blockers,
    journal: resumeJournal,
    editRemoved,
    runGitFn,
  });
  snapshot.dependencies = dependencies;

  const steps = planCleanupSteps({ dependencies, editMember });
  // Při resume se otisk počítá nad tímtéž důkazem, který volající potvrdil
  // (journal drží normalizovanou PR evidenci preview); čerstvost živé PR
  // evidence hlídá krok 5. Fresh preview otiskne evidenci volajícího.
  const fingerprint = computePreviewFingerprint({
    sidecarSha256: sidecar.sha256,
    worktreeRealPath,
    editHead: edit.head,
    planStatus: plan?.status ?? null,
    disposition: editMember.disposition,
    handoffState,
    dependencies,
    runtime,
    prEvidence: resumeJournal ? (resumeJournal.pr_evidence ?? null) : prEvidence,
  });
  snapshot.fingerprint = fingerprint;

  return base(blockers.length > 0 ? "needs_attention" : "ready_to_delete", {
    steps: steps.map((step) => step.id),
    branch_refs_kept: [{
      branch: sidecar.metadata.branch,
      note: "Branch ref zůstává zachovaný; případné smazání větve je samostatné rozhodnutí mimo cleanup environmentu.",
    }],
    preview_fingerprint: fingerprint,
  });
}

// Destruktivní apply přesně jednoho environmentu. Volající drží canonical
// Organization worktree lock (stejný jako create lane); tato funkce znovu
// načte živý stav, odmítne jakýkoli drift proti preview a maže výhradně
// sidecarem vlastněné members nested-first s idempotentním journalem.
export async function applyWorktreeCleanup({
  companiesRoot,
  worktree,
  expectedFingerprint,
  inspectRuntimeUsage = null,
  prEvidence = null,
  runGitFn = defaultRunGit,
  now = () => new Date(),
} = {}) {
  if (typeof expectedFingerprint !== "string" || expectedFingerprint.trim() === "") {
    throw new WorktreeCleanupError("Cleanup apply vyžaduje preview_fingerprint z čerstvého preview.", {
      code: "cleanup_fingerprint_required",
    });
  }
  const organizationRoot = resolve(companiesRoot, worktree.organization_path);
  const journalPath = cleanupJournalPath({ companiesRoot, worktree });
  const journal = await readCleanupJournal({ journalPath });
  if (journal.state === "invalid") {
    throw new WorktreeCleanupError(journal.message, { code: "cleanup_journal_invalid" });
  }

  if (journal.state === "present") {
    return resumeCleanupFromJournal({
      companiesRoot,
      worktree,
      organizationRoot,
      journalPath,
      journal: journal.value,
      expectedFingerprint,
      inspectRuntimeUsage,
      prEvidence,
      runGitFn,
      now,
    });
  }

  const { preview, snapshot } = await inspectCleanupEnvironment({
    companiesRoot,
    worktree,
    inspectRuntimeUsage,
    prEvidence,
    runGitFn,
    now,
  });
  if (preview.state !== "ready_to_delete") {
    throw new WorktreeCleanupError(
      `Environment není ready_to_delete (${preview.state}): ${preview.blockers.map((item) => item.code).join(", ") || "unknown"}.`,
      { code: "cleanup_not_ready", details: preview.blockers.flatMap((item) => [item.message, ...item.details]) },
    );
  }
  if (preview.preview_fingerprint !== expectedFingerprint) {
    throw new WorktreeCleanupError(
      "Živý stav environmentu se od preview změnil; vyžádej nové preview a potvrď aktuální fingerprint.",
      { code: "cleanup_stale_preview" },
    );
  }

  // Journal vzniká z téhož živého snapshotu, který právě prošel guardy a dal
  // potvrzený fingerprint — žádná druhá re-derivace members, HEADu ani ownera.
  const { sidecar, edit, dependencies, worktreeRealPath } = snapshot;
  const timestamp = now().toISOString();
  const journalValue = {
    schema_version: CLEANUP_JOURNAL_SCHEMA,
    created_at: timestamp,
    updated_at: timestamp,
    preview_fingerprint: expectedFingerprint,
    pr_evidence: normalizePrEvidence(prEvidence),
    environment: {
      organization: worktree.organization,
      slug: worktree.slug,
      branch: sidecar.metadata.branch,
      worktree_real_path: worktreeRealPath,
      owner_root: edit.ownerRoot,
      sidecar_path: resolve(companiesRoot, worktree.sidecar_path),
      sidecar_sha256: sidecar.sha256,
      edit_head: edit.head,
    },
    steps: [
      ...dependencies.map((dependency) => ({
        id: `remove_dependency:${dependency.member.slot_path}`,
        kind: "remove_dependency",
        slot_path: dependency.member.slot_path,
        repo_path: dependency.member.repo_path,
        base_sha: dependency.member.base_sha,
        source_path: dependency.sourcePath,
        target_real_path: dependency.targetRealPath,
        status: "pending",
      })),
      { id: "remove_edit", kind: "remove_edit", status: "pending" },
      { id: "remove_sidecar", kind: "remove_sidecar", status: "pending" },
    ],
  };
  await writeFile(journalPath, `${JSON.stringify(journalValue, null, 2)}\n`, { encoding: "utf8", flag: "wx" });

  return executeCleanupJournal({
    companiesRoot,
    worktree,
    organizationRoot,
    journalPath,
    journal: journalValue,
    inspectRuntimeUsage,
    runGitFn,
    now,
  });
}

async function resumeCleanupFromJournal({
  companiesRoot,
  worktree,
  organizationRoot,
  journalPath,
  journal,
  expectedFingerprint,
  inspectRuntimeUsage,
  prEvidence,
  runGitFn,
  now,
}) {
  // Resume je pokračování přesně toho apply, jehož preview volající potvrdil.
  // Jiný fingerprint znamená požadavek na jiný environment stav — fail-closed.
  if (journal.preview_fingerprint !== expectedFingerprint) {
    throw new WorktreeCleanupError(
      "Rozpracovaný cleanup journal patří jinému preview fingerprintu; potvrď přesně původní preview, nebo journal vyřeš vědomě.",
      { code: "cleanup_stale_preview" },
    );
  }
  await assertJournalPathsWithinEnvironment({ organizationRoot, journal });

  // Po odstranění všech worktree members zbývá nejvýš sidecar; když už ani ten
  // není (pád mezi unlinkem a zápisem journalu), není co znovu hodnotit —
  // dokončení jen uzavře journal bez destruktivního kroku.
  const remaining = journal.steps.filter((step) => step.status !== "completed");
  const sidecarPath = resolve(companiesRoot, worktree.sidecar_path);
  const onlySidecarRemains = remaining.every((step) => step.kind === "remove_sidecar");
  if (remaining.length === 0 || (onlySidecarRemains && !existsSync(sidecarPath))) {
    return executeCleanupJournal({
      companiesRoot,
      worktree,
      organizationRoot,
      journalPath,
      journal,
      inspectRuntimeUsage,
      runGitFn,
      now,
    });
  }

  // Manuál: apply znovu přepočítá všechny guardy těsně před mutací — i při
  // resume. Journal fingerprint říká, co volající potvrdil; živý eligibility
  // snapshot (plán, handoff, edit, dependency množina, runtime, PR evidence)
  // musí i teď projít a dát přesně tentýž otisk. Jinak se žádný krok nespustí.
  const { preview, snapshot } = await inspectCleanupEnvironment({
    companiesRoot,
    worktree,
    resumeJournal: journal,
    inspectRuntimeUsage,
    prEvidence,
    runGitFn,
    now,
  });
  if (preview.state !== "ready_to_delete") {
    throw new WorktreeCleanupError(
      `Živý eligibility snapshot blokuje resume cleanupu (${preview.state}): ${preview.blockers.map((item) => item.code).join(", ") || "unknown"}.`,
      {
        code: resumeBlockerCode(preview.blockers),
        details: preview.blockers.flatMap((item) => [item.message, ...item.details]),
      },
    );
  }
  if (snapshot.fingerprint !== journal.preview_fingerprint) {
    throw new WorktreeCleanupError(
      "Živý stav environmentu už neodpovídá potvrzenému preview fingerprintu journalu; cleanup se neobnoví.",
      { code: "cleanup_stale_preview" },
    );
  }
  return executeCleanupJournal({
    companiesRoot,
    worktree,
    organizationRoot,
    journalPath,
    journal,
    inspectRuntimeUsage,
    runGitFn,
    now,
  });
}

// Journal je editovatelný lokální soubor; resume proto každou cestu, kterou by
// destruktivní krok použil, znovu prokáže uvnitř environment hranic. Tamper
// nebo drift je fail-closed konec, nikdy zásah mimo Organization root.
async function assertJournalPathsWithinEnvironment({ organizationRoot, journal }) {
  const organizationRealPath = await realpathOrNull(organizationRoot);
  const organizationLexicalPath = resolve(organizationRoot);
  const environment = journal.environment ?? {};
  const issues = [];
  if (!organizationRealPath) issues.push("Organization root nelze kanonicky rozbalit");
  // Journal drží mix kanonických (realpath) a lexikálních absolutních cest;
  // obě formy se prokazují proti téže Organization hranici.
  const insideOrganization = (value) =>
    typeof value === "string"
    && organizationRealPath
    && (
      isPathSameOrDescendant(organizationRealPath, value)
      || isPathSameOrDescendant(organizationLexicalPath, value)
    );
  if (!insideOrganization(environment.worktree_real_path) || samePath(environment.worktree_real_path, organizationRealPath)) {
    issues.push("worktree_real_path neleží uvnitř Organization rootu");
  }
  if (!insideOrganization(environment.owner_root)) issues.push("owner_root neleží uvnitř Organization rootu");
  if (!insideOrganization(environment.sidecar_path) || samePath(environment.sidecar_path, organizationRealPath)) {
    issues.push("sidecar_path neleží uvnitř Organization rootu");
  }
  if (!SHA.test(environment.edit_head ?? "")) issues.push("edit_head není exact SHA");
  if (typeof environment.sidecar_sha256 !== "string" || !/^[0-9a-f]{64}$/.test(environment.sidecar_sha256)) {
    issues.push("sidecar_sha256 není platný otisk");
  }
  for (const step of journal.steps ?? []) {
    if (step.kind !== "remove_dependency") continue;
    if (!insideOrganization(step.source_path)) issues.push(`source_path kroku ${step.id} neleží uvnitř Organization rootu`);
    if (
      typeof step.target_real_path !== "string"
      || !isPathSameOrDescendant(environment.worktree_real_path ?? "", step.target_real_path)
    ) {
      issues.push(`target_real_path kroku ${step.id} neleží uvnitř edit worktree`);
    }
    if (!SHA.test(step.base_sha ?? "")) issues.push(`base_sha kroku ${step.id} není exact SHA`);
  }
  if (issues.length > 0) {
    throw new WorktreeCleanupError(
      `Cleanup journal neprokázal environment hranice: ${issues.join("; ")}.`,
      { code: "cleanup_journal_invalid", details: issues },
    );
  }
}

async function executeCleanupJournal({
  companiesRoot,
  worktree,
  organizationRoot,
  journalPath,
  journal,
  inspectRuntimeUsage,
  runGitFn,
  now,
}) {
  const results = [];
  for (const step of journal.steps) {
    if (step.status === "completed") {
      results.push({ id: step.id, status: "completed" });
      continue;
    }
    // Runtime brána těsně před každým destruktivním krokem: mezi preview,
    // resume a jednotlivými kroky mohl někdo environment spustit. Neúplná
    // evidence je blocker, nikdy důvod proces ukončit.
    if (step.kind !== "remove_sidecar") {
      const runtime = await resolveRuntimeEvidence({
        inspectRuntimeUsage,
        environment: { slug: journal.environment.slug, organization: journal.environment.organization },
        worktreeRealPath: journal.environment.worktree_real_path,
      });
      if (!runtime.verified || runtime.in_use) {
        throw new WorktreeCleanupError(
          `Runtime evidence blokuje krok ${step.id}: ${runtime.message}`,
          { code: runtime.verified ? "cleanup_runtime_in_use" : "cleanup_runtime_unverified", details: runtime.details },
        );
      }
    }
    const outcome = await executeCleanupStep({
      companiesRoot,
      worktree,
      organizationRoot,
      journal,
      step,
      runGitFn,
    });
    step.status = "completed";
    step.completed_at = now().toISOString();
    journal.updated_at = step.completed_at;
    await rewriteJournal({ journalPath, journal });
    results.push({ id: step.id, status: outcome });
  }

  await rm(journalPath, { force: true });
  return {
    schema_version: CLEANUP_APPLY_SCHEMA,
    action: "cleanup_worktree",
    applied_at: now().toISOString(),
    environment: journal.environment,
    steps: results,
    branch_refs_kept: [{
      branch: journal.environment.branch,
      note: "Branch ref zůstává zachovaný; případné smazání větve je samostatné rozhodnutí mimo cleanup environmentu.",
    }],
    journal_removed: true,
  };
}

async function executeCleanupStep({ companiesRoot, worktree, organizationRoot, journal, step, runGitFn }) {
  if (step.kind === "remove_dependency") {
    return executeRemoveDependencyStep({ journal, step, runGitFn });
  }
  if (step.kind === "remove_edit") {
    return executeRemoveEditStep({ journal, runGitFn });
  }
  if (step.kind === "remove_sidecar") {
    return executeRemoveSidecarStep({ organizationRoot, journal });
  }
  throw new WorktreeCleanupError(`Neznámý cleanup krok ${step.kind}.`, { code: "cleanup_journal_invalid" });
}

async function executeRemoveDependencyStep({ journal, step, runGitFn }) {
  const targetPath = step.target_real_path;
  const registered = await ownerRegistrationForPath({
    ownerRoot: step.source_path,
    targetPath,
    runGitFn,
  });
  if (!existsSync(targetPath) && !registered.found) {
    return "skipped_already_absent";
  }
  if (existsSync(targetPath)) {
    const entry = await lstat(targetPath);
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new WorktreeCleanupError(
        `Dependency cesta ${step.repo_path} už není běžný adresář; cleanup se zastavil bez zásahu.`,
        { code: "cleanup_path_swapped" },
      );
    }
    const [head, porcelain, branch] = await Promise.all([
      runGitFn(["rev-parse", "HEAD"], { cwd: targetPath, timeoutMs: GIT_LOCAL_TIMEOUT_MS }),
      runGitFn(["status", "--porcelain=v1", "--untracked-files=normal"], { cwd: targetPath, timeoutMs: GIT_LOCAL_TIMEOUT_MS }),
      runGitFn(["branch", "--show-current"], { cwd: targetPath, timeoutMs: GIT_LOCAL_TIMEOUT_MS }),
    ]);
    const details = [];
    if (!head.ok || head.stdout !== step.base_sha) details.push("HEAD neodpovídá journalem zaznamenanému base_sha");
    if (!branch.ok || branch.stdout !== "") details.push("binding už není detached");
    if (!porcelain.ok || porcelain.stdout !== "") details.push("binding není clean včetně untracked souborů");
    if (!registered.found || !registered.detachedAt(step.base_sha)) details.push("binding není exact detached registrace kanonického ownera");
    if (details.length > 0) {
      throw new WorktreeCleanupError(
        `Dependency member ${step.repo_path} neodpovídá journal evidenci: ${details.join("; ")}.`,
        { code: "cleanup_step_precondition_failed", details },
      );
    }
    const removed = await runGitFn(["worktree", "remove", targetPath], {
      cwd: step.source_path,
      timeoutMs: GIT_LOCAL_TIMEOUT_MS,
    });
    if (!removed.ok) {
      throw new WorktreeCleanupError(
        `Dependency worktree ${step.repo_path} nelze odstranit: ${removed.stderr || removed.error || removed.stdout}.`,
        { code: "cleanup_step_failed" },
      );
    }
  }
  await runGitFn(["worktree", "prune", "--expire", "now"], { cwd: step.source_path, timeoutMs: GIT_LOCAL_TIMEOUT_MS });
  const readback = await ownerRegistrationForPath({ ownerRoot: step.source_path, targetPath, runGitFn });
  if (existsSync(targetPath) || readback.found) {
    throw new WorktreeCleanupError(
      `Dependency worktree ${step.repo_path} po odstranění stále existuje nebo zůstal registrovaný.`,
      { code: "cleanup_readback_failed" },
    );
  }
  return "completed";
}

async function executeRemoveEditStep({ journal, runGitFn }) {
  const targetPath = journal.environment.worktree_real_path;
  const ownerRoot = journal.environment.owner_root;
  const registered = await ownerRegistrationForPath({ ownerRoot, targetPath, runGitFn });
  if (!existsSync(targetPath) && !registered.found) {
    return "skipped_already_absent";
  }
  if (existsSync(targetPath)) {
    const entry = await lstat(targetPath);
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new WorktreeCleanupError(
        "Edit worktree cesta už není běžný adresář; cleanup se zastavil bez zásahu.",
        { code: "cleanup_path_swapped" },
      );
    }
    const [head, porcelain] = await Promise.all([
      runGitFn(["rev-parse", "HEAD"], { cwd: targetPath, timeoutMs: GIT_LOCAL_TIMEOUT_MS }),
      runGitFn(["status", "--porcelain=v1", "--untracked-files=normal"], { cwd: targetPath, timeoutMs: GIT_LOCAL_TIMEOUT_MS }),
    ]);
    const details = [];
    if (!head.ok || head.stdout !== journal.environment.edit_head) details.push("HEAD neodpovídá journalem zaznamenanému stavu");
    if (!porcelain.ok || porcelain.stdout !== "") details.push("edit worktree není clean včetně untracked souborů");
    if (!registered.found || !registered.usesBranch(journal.environment.branch)) details.push("edit worktree není exact registrace owner repa");
    if (details.length > 0) {
      throw new WorktreeCleanupError(
        `Edit worktree neodpovídá journal evidenci: ${details.join("; ")}.`,
        { code: "cleanup_step_precondition_failed", details },
      );
    }
    const removed = await runGitFn(["worktree", "remove", targetPath], {
      cwd: ownerRoot,
      timeoutMs: GIT_LOCAL_TIMEOUT_MS,
    });
    if (!removed.ok) {
      throw new WorktreeCleanupError(
        `Edit worktree nelze odstranit: ${removed.stderr || removed.error || removed.stdout}.`,
        { code: "cleanup_step_failed" },
      );
    }
  }
  await runGitFn(["worktree", "prune", "--expire", "now"], { cwd: ownerRoot, timeoutMs: GIT_LOCAL_TIMEOUT_MS });
  const readback = await ownerRegistrationForPath({ ownerRoot, targetPath, runGitFn });
  if (existsSync(targetPath) || readback.found) {
    throw new WorktreeCleanupError(
      "Edit worktree po odstranění stále existuje nebo zůstal registrovaný.",
      { code: "cleanup_readback_failed" },
    );
  }
  return "completed";
}

async function executeRemoveSidecarStep({ organizationRoot, journal }) {
  const sidecarPath = journal.environment.sidecar_path;
  if (!existsSync(sidecarPath)) return "skipped_already_absent";
  const entry = await lstat(sidecarPath);
  if (!entry.isFile() || entry.isSymbolicLink()) {
    throw new WorktreeCleanupError("Sidecar už není běžný soubor; cleanup se zastavil bez zásahu.", {
      code: "cleanup_path_swapped",
    });
  }
  const boundary = await inspectCanonicalPathBoundary({ rootPath: organizationRoot, targetPath: sidecarPath });
  if (!boundary.ok) {
    throw new WorktreeCleanupError("Sidecar opouští Organization root; cleanup se zastavil bez zásahu.", {
      code: "cleanup_path_swapped",
    });
  }
  const raw = await readFile(sidecarPath, "utf8");
  if (sha256(raw) !== journal.environment.sidecar_sha256) {
    throw new WorktreeCleanupError(
      "Sidecar se od zahájení cleanupu změnil; journal se neaplikuje na jiný obsah.",
      { code: "cleanup_journal_environment_mismatch" },
    );
  }
  await unlink(sidecarPath);
  return "completed";
}

// Konzervativní durable runtime evidence pro Doctor/CLI lane: čte runtime
// state soubory Launchpadu a fail-closed blokuje na jakémkoli záznamu, který
// environment referuje a jehož proces může stále žít. Nic neukončuje —
// neúplný ownership důkaz je blocker, ne důvod proces zabít (DEV-6555).
export async function inspectDurableWorktreeRuntimeUsage({
  stateRoot,
  worktree,
  processAlive = defaultProcessAlive,
} = {}) {
  const appStateRoot = join(stateRoot, "runtime", "apps");
  let entries;
  try {
    entries = await readdir(appStateRoot);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { verified: true, in_use: false, message: "Žádný durable runtime stav environment nereferuje.", details: [] };
    }
    return {
      verified: false,
      in_use: false,
      message: `Durable runtime stav nelze přečíst: ${error.message}`,
      details: [],
    };
  }
  const details = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    let state;
    try {
      state = JSON.parse(await readFile(join(appStateRoot, entry), "utf8"));
    } catch {
      return {
        verified: false,
        in_use: false,
        message: `Durable runtime stav ${entry} nejde přečíst; runtime použití environmentu nelze vyloučit.`,
        details: [entry],
      };
    }
    if (state?.runtime_source?.type !== "worktree" || state.runtime_source.slug !== worktree.slug) continue;
    if (state.status === "stopped") continue;
    const pid = Number.isInteger(state.pid) ? state.pid : null;
    if (pid !== null && !(await processAlive(pid))) continue;
    details.push(`${entry}: status=${state.status ?? "unknown"}, pid=${pid ?? "unknown"}`);
  }
  if (details.length > 0) {
    return {
      verified: true,
      in_use: true,
      message: "Durable runtime stav referuje tento worktree a proces může stále běžet.",
      details,
    };
  }
  return { verified: true, in_use: false, message: "Žádný durable runtime stav environment nereferuje.", details: [] };
}

export function cleanupJournalPath({ companiesRoot, worktree }) {
  const sidecarPath = resolve(companiesRoot, worktree.sidecar_path);
  return join(dirname(sidecarPath), `${worktree.slug}.cleanup.journal.json`);
}

async function readCleanupSidecar({ organizationRoot, sidecarPath, blockers }) {
  let entry;
  try {
    entry = await lstat(sidecarPath);
  } catch {
    blockers.push(blocker("sidecar_missing", "Sidecar neexistuje; environment bez evidence se neuklízí."));
    return null;
  }
  if (!entry.isFile() || entry.isSymbolicLink()) {
    blockers.push(blocker("sidecar_invalid", "Sidecar není běžný soubor."));
    return null;
  }
  const boundary = await inspectCanonicalPathBoundary({ rootPath: organizationRoot, targetPath: sidecarPath });
  if (!boundary.ok) {
    blockers.push(blocker("containment_invalid", "Sidecar opouští Organization root."));
    return null;
  }
  let raw;
  let metadata;
  try {
    raw = await readFile(sidecarPath, "utf8");
    metadata = JSON.parse(raw);
  } catch (error) {
    blockers.push(blocker("sidecar_invalid", `Sidecar nejde přečíst: ${error.message}`));
    return null;
  }
  const issues = [];
  if (metadata?.schema_version !== "companiesascode.worktree.v1") issues.push("schema_version musí být companiesascode.worktree.v1");
  if (typeof metadata?.branch !== "string" || metadata.branch.trim() === "") issues.push("branch chybí");
  if (typeof metadata?.mission_control_plan_code !== "string") issues.push("mission_control_plan_code chybí");
  if (typeof metadata?.mission_control_plan_path !== "string") issues.push("mission_control_plan_path chybí");
  if (typeof metadata?.module_path !== "string" || metadata.module_path.trim() === "") issues.push("module_path chybí");
  const members = Array.isArray(metadata?.members) ? metadata.members : [];
  const editMembers = members.filter((member) => member?.role === "edit");
  const dependencyMembers = members.filter((member) => member?.role === "dependency");
  if (members.length === 0) issues.push("sidecar nemá members evidenci");
  if (editMembers.length !== 1 || editMembers[0]?.repo_path !== ".") {
    issues.push("úzká cleanup lane vyžaduje právě jeden edit member s repo_path \".\"");
  }
  if (members.length !== editMembers.length + dependencyMembers.length) {
    issues.push("members obsahují nepodporovanou roli mimo edit/dependency");
  }
  if (editMembers.length === 1 && editMembers[0].branch !== metadata.branch) {
    issues.push("edit member branch neodpovídá sidecar branch");
  }
  if (issues.length > 0) {
    blockers.push(blocker("sidecar_invalid", "Sidecar neodpovídá cleanup kontraktu.", issues));
    return null;
  }
  return { raw, metadata, sha256: sha256(raw), editMember: editMembers[0], dependencyMembers };
}

async function inspectWorktreeDirectory({ organizationRoot, worktreePath }) {
  let entry;
  try {
    entry = await lstat(worktreePath);
  } catch {
    return { ok: false, message: "Worktree cestu nelze přečíst." };
  }
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    return { ok: false, message: "Worktree cesta není běžný adresář." };
  }
  const boundary = await inspectCanonicalPathBoundary({ rootPath: organizationRoot, targetPath: worktreePath });
  if (!boundary.ok || !boundary.targetRealPath) {
    return { ok: false, message: "Worktree cesta opouští Organization root." };
  }
  return { ok: true, realPath: await realpath(boundary.targetRealPath) };
}

async function inspectEditWorktree({ organizationRoot, worktreePath, worktreeRealPath, branch, runGitFn }) {
  const blockers = [];
  const [topLevel, currentBranch, head, porcelain, operation, remoteContains] = await Promise.all([
    runGitFn(["rev-parse", "--show-toplevel"], { cwd: worktreePath, timeoutMs: GIT_LOCAL_TIMEOUT_MS }),
    runGitFn(["branch", "--show-current"], { cwd: worktreePath, timeoutMs: GIT_LOCAL_TIMEOUT_MS }),
    runGitFn(["rev-parse", "HEAD"], { cwd: worktreePath, timeoutMs: GIT_LOCAL_TIMEOUT_MS }),
    runGitFn(["status", "--porcelain=v1", "--untracked-files=normal"], { cwd: worktreePath, timeoutMs: GIT_LOCAL_TIMEOUT_MS }),
    readGitOperationState({ absolute_path: worktreePath }),
    runGitFn(["branch", "-r", "--contains", "HEAD"], { cwd: worktreePath, timeoutMs: GIT_LOCAL_TIMEOUT_MS }),
  ]);
  const topLevelRealPath = topLevel.ok ? await realpathOrNull(topLevel.stdout) : null;
  if (!topLevel.ok || !samePath(topLevelRealPath, worktreeRealPath)) {
    blockers.push(blocker("edit_not_registered", "Worktree cesta není exact Git top-level."));
  }
  if (!currentBranch.ok || currentBranch.stdout !== branch) {
    blockers.push(blocker("edit_branch_mismatch", `Edit worktree musí být na branchi ${branch}.`));
  }
  if (!porcelain.ok || porcelain.stdout !== "") {
    blockers.push(blocker("edit_dirty", "Edit worktree není clean včetně untracked souborů."));
  }
  if (operation) {
    blockers.push(blocker("edit_git_operation", `V edit worktree probíhá Git operace ${operation.kind}.`));
  }
  const owner = await resolveEditOwnerRoot({ organizationRoot, worktreePath, runGitFn });
  if (!owner.ok) {
    blockers.push(blocker("edit_not_registered", owner.message));
  } else {
    const registration = await ownerRegistrationForPath({
      ownerRoot: owner.root,
      targetPath: worktreeRealPath,
      runGitFn,
    });
    if (!registration.found || !registration.usesBranch(branch)) {
      blockers.push(blocker("edit_not_registered", "Edit worktree není exact registrace svého owner repa."));
    }
  }
  const editHead = head.ok && SHA.test(head.stdout) ? head.stdout : null;
  if (!editHead) {
    blockers.push(blocker("edit_head_unknown", "Exact HEAD edit worktree nelze určit."));
  }
  return {
    blockers,
    head: editHead,
    ownerRoot: owner.ok ? owner.root : null,
    remoteRefsContainHead: remoteContains.ok && remoteContains.stdout.trim() !== "",
  };
}

// Owner repo worktree se čte z Git registru samotného worktree; sidecar cestu
// ownera nedrží a hádání podle repo_kind by vytvořilo druhou pravdu. Owner
// musí kanonicky ležet uvnitř Organization rootu (nebo jím přímo být).
async function resolveEditOwnerRoot({ organizationRoot, worktreePath, runGitFn }) {
  const commonDir = await runGitFn(["rev-parse", "--path-format=absolute", "--git-common-dir"], {
    cwd: worktreePath,
    timeoutMs: GIT_LOCAL_TIMEOUT_MS,
  });
  if (!commonDir.ok || commonDir.stdout.trim() === "") {
    return { ok: false, message: "Owner repo edit worktree nelze z Git registru určit." };
  }
  const ownerRoot = dirname(resolve(commonDir.stdout.trim()));
  const [ownerRealPath, organizationRealPath] = await Promise.all([
    realpathOrNull(ownerRoot),
    realpathOrNull(organizationRoot),
  ]);
  if (
    !ownerRealPath
    || !organizationRealPath
    || !isPathSameOrDescendant(organizationRealPath, ownerRealPath)
  ) {
    return { ok: false, message: "Owner repo edit worktree leží mimo Organization root." };
  }
  return { ok: true, root: ownerRealPath };
}

function evaluateHeadPreservation({ editMember, editHead, remoteRefsContainHead, prEvidence, now }) {
  if (editHead === editMember.base_sha) return [];
  const evidence = normalizePrEvidence(prEvidence);
  if (!evidence) {
    return [blocker(
      "pr_evidence_missing",
      "Edit worktree nese změny; cleanup vyžaduje čerstvý exact-head PR/disposition důkaz (MERGED, nebo CLOSED + abandoned).",
    )];
  }
  const blockers = [];
  if (evidence.head_sha !== editHead) {
    blockers.push(blocker("pr_evidence_mismatch", "PR evidence neodpovídá exact HEADu edit worktree."));
  }
  const ageMs = now().getTime() - Date.parse(evidence.checked_at);
  if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > PR_EVIDENCE_FRESHNESS_MS) {
    blockers.push(blocker("pr_evidence_stale", "PR evidence není čerstvá; stale cache není důkaz."));
  }
  if (evidence.state === "MERGED") {
    // Merged exact-head PR je sám o sobě remote zachování práce.
  } else if (evidence.state === "CLOSED") {
    if (editMember.disposition !== "abandoned") {
      blockers.push(blocker("pr_evidence_mismatch", "CLOSED PR vyžaduje explicitní abandoned disposition edit memberu."));
    }
    if (!remoteRefsContainHead) {
      blockers.push(blocker("edit_head_unpreserved", "Exact HEAD není zachovaný na žádném remote refu; CLOSED PR sám o sobě není důkaz bezpečí."));
    }
  } else {
    blockers.push(blocker("pr_evidence_mismatch", `PR stav ${evidence.state} není terminální důkaz (očekává se MERGED nebo CLOSED).`));
  }
  return blockers;
}

function normalizePrEvidence(prEvidence) {
  if (!prEvidence || typeof prEvidence !== "object") return null;
  const { url, state, head_sha: headSha, checked_at: checkedAt } = prEvidence;
  if (typeof url !== "string" || typeof state !== "string" || typeof headSha !== "string" || typeof checkedAt !== "string") {
    return null;
  }
  if (!SHA.test(headSha)) return null;
  return { url, state: state.toUpperCase(), head_sha: headSha, checked_at: checkedAt };
}

async function resolveRuntimeEvidence({ inspectRuntimeUsage, environment, worktreeRealPath }) {
  if (typeof inspectRuntimeUsage !== "function") {
    return {
      verified: false,
      in_use: false,
      message: "Runtime evidence chybí; bez ověřeného runtime stavu se environment nemaže.",
      details: [],
    };
  }
  try {
    const usage = await inspectRuntimeUsage({ environment, worktreeRealPath });
    if (!usage || typeof usage !== "object" || typeof usage.verified !== "boolean" || typeof usage.in_use !== "boolean") {
      return {
        verified: false,
        in_use: false,
        message: "Runtime evidence nemá kanonický tvar { verified, in_use }.",
        details: [],
      };
    }
    return {
      verified: usage.verified,
      in_use: usage.in_use,
      message: usage.message ?? (usage.in_use ? "Runtime environment používá." : "Runtime environment nepoužívá."),
      details: Array.isArray(usage.details) ? usage.details : [],
    };
  } catch (error) {
    return {
      verified: false,
      in_use: false,
      message: `Runtime evidence selhala: ${error instanceof Error ? error.message : String(error)}`,
      details: [],
    };
  }
}

// Dependency množina se hodnotí živě proti aktuálně required slotům. Při
// resume (`journal`) navíc: každý member musí mít journal teardown krok; už
// dokončený krok se prokazuje absencí cesty i registrace (návrat obsahu na
// gitignorovanou cestu by remove_edit tiše smazal); nedokončený krok se
// hodnotí stejně jako ve fresh preview. Po odstraněném edit worktree už
// module contract nejde číst, proto se required sloty znovu nečtou — všechny
// dependency kroky musí být v takovém journalu completed.
async function inspectDependencyMembers({
  organizationRoot,
  worktreePath,
  metadata,
  dependencyMembers,
  blockers,
  journal = null,
  editRemoved = false,
  runGitFn = defaultRunGit,
}) {
  const journalSteps = new Map(
    (journal?.steps ?? [])
      .filter((step) => step.kind === "remove_dependency")
      .map((step) => [step.slot_path, step]),
  );
  let requirementsBySlot = new Map();
  if (!editRemoved) {
    const requirements = await readRequiredRepositoryDbWorktreeSlots({
      organizationRoot,
      moduleCheckoutRoot: worktreePath,
      moduleSlotPath: metadata.module_path,
      moduleId: metadata.module,
    });
    if (!requirements.ok) {
      blockers.push(blocker("dependency_binding_not_ready", requirements.message, requirements.details));
      return [];
    }
    requirementsBySlot = new Map(requirements.dependencies.map((dependency) => [dependency.slot_path, dependency]));
    // Symetrický fail-closed: každý aktivní required slot musí mít právě jeden
    // sidecar member. Slot deklarovaný až po create nemá v environmentu ověřenou
    // evidenci a případný ručně přidaný checkout na jeho (gitignorované) cestě
    // by teardown mohl tiše zasáhnout.
    for (const dependency of requirements.dependencies) {
      const matching = dependencyMembers.filter((member) => member?.slot_path === dependency.slot_path);
      if (matching.length !== 1) {
        blockers.push(blocker(
          "member_shape_invalid",
          `Required repository-db slot ${dependency.slot_path} nemá právě jeden sidecar dependency member; environment neodpovídá aktuální deklaraci.`,
        ));
      }
    }
  }
  const dependencies = [];
  for (const member of dependencyMembers) {
    const step = journal ? journalSteps.get(member.slot_path) : null;
    if (journal && !step) {
      blockers.push(blocker(
        "cleanup_journal_environment_mismatch",
        `Dependency member ${member.slot_path} nemá v journalu teardown krok; cleanup se neobnoví.`,
      ));
      continue;
    }
    if (step?.status === "completed") {
      const registration = await ownerRegistrationForPath({
        ownerRoot: step.source_path,
        targetPath: step.target_real_path,
        runGitFn,
      });
      if (existsSync(step.target_real_path) || registration.found) {
        blockers.push(blocker(
          "cleanup_journal_environment_mismatch",
          `Dependency member ${member.slot_path} po dokončeném kroku znovu existuje nebo je registrovaný u ownera; cleanup se neobnoví.`,
        ));
        continue;
      }
      dependencies.push({
        member,
        dependency: null,
        sourcePath: step.source_path,
        targetRealPath: step.target_real_path,
        head: step.base_sha,
      });
      continue;
    }
    if (editRemoved) {
      blockers.push(blocker(
        "cleanup_journal_environment_mismatch",
        `Dependency member ${member.slot_path} má nedokončený krok po odstraněném edit worktree; journal neodpovídá pořadí teardownu.`,
      ));
      continue;
    }
    const dependency = requirementsBySlot.get(member.slot_path);
    if (!dependency) {
      blockers.push(blocker(
        "member_shape_invalid",
        `Dependency member ${member.slot_path} neodpovídá žádnému aktivnímu required repository-db slotu; cleanup nezná jeho autoritu.`,
      ));
      continue;
    }
    const inspection = await inspectRepositoryDbWorktreeBinding({
      organizationRoot,
      editWorktreeRoot: worktreePath,
      dependency,
      member,
    });
    if (!inspection.ok) {
      blockers.push(blocker("dependency_binding_not_ready", inspection.message, inspection.details));
      continue;
    }
    dependencies.push({
      member,
      dependency,
      sourcePath: resolve(organizationRoot, dependency.slot_path),
      targetRealPath: inspection.target_path,
      head: inspection.head,
    });
  }
  return dependencies;
}

function planCleanupSteps({ dependencies, editMember }) {
  return [
    ...dependencies.map((dependency) => ({ id: `remove_dependency:${dependency.member.slot_path}` })),
    { id: "remove_edit", branch: editMember.branch },
    { id: "remove_sidecar" },
  ];
}

function computePreviewFingerprint({
  sidecarSha256,
  worktreeRealPath,
  editHead,
  planStatus,
  disposition,
  handoffState,
  dependencies,
  runtime,
  prEvidence,
}) {
  return sha256(JSON.stringify({
    v: 1,
    sidecar: sidecarSha256,
    worktree: pathKey(worktreeRealPath),
    edit_head: editHead,
    plan_status: planStatus,
    disposition,
    handoff: handoffState,
    dependencies: dependencies.map((dependency) => ({
      slot: dependency.member.slot_path,
      head: dependency.head,
      target: pathKey(dependency.targetRealPath),
    })),
    runtime: { verified: runtime.verified, in_use: runtime.in_use },
    pr: normalizePrEvidence(prEvidence),
  }));
}

async function readCleanupJournal({ journalPath }) {
  if (!existsSync(journalPath)) return { state: "absent" };
  let value;
  try {
    const entry = await lstat(journalPath);
    if (!entry.isFile() || entry.isSymbolicLink()) {
      return { state: "invalid", message: "Cleanup journal není běžný soubor." };
    }
    value = JSON.parse(await readFile(journalPath, "utf8"));
  } catch (error) {
    return { state: "invalid", message: `Cleanup journal nejde přečíst: ${error.message}` };
  }
  if (
    value?.schema_version !== CLEANUP_JOURNAL_SCHEMA
    || !value.environment
    || !Array.isArray(value.steps)
    || value.steps.some((step) => !step?.id || !step?.kind || !["pending", "completed"].includes(step?.status))
    || (value.pr_evidence != null && normalizePrEvidence(value.pr_evidence) === null)
  ) {
    return { state: "invalid", message: "Cleanup journal neodpovídá schema kontraktu." };
  }
  return {
    state: "present",
    value,
    summary: {
      created_at: value.created_at,
      updated_at: value.updated_at,
      completed_steps: value.steps.filter((step) => step.status === "completed").map((step) => step.id),
      remaining_steps: value.steps.filter((step) => step.status !== "completed").map((step) => step.id),
    },
  };
}

async function rewriteJournal({ journalPath, journal }) {
  // Přepis běží výhradně pod canonical create lockem; staging + rename drží
  // journal čitelný i při přerušení mezi kroky. Nečitelný journal je pro
  // resume fail-closed blocker, nikdy důvod krok tiše zopakovat.
  const staging = `${journalPath}.staging`;
  await writeFile(staging, `${JSON.stringify(journal, null, 2)}\n`, "utf8");
  await rm(journalPath, { force: true });
  await rename(staging, journalPath);
}

async function ownerRegistrationForPath({ ownerRoot, targetPath, runGitFn }) {
  const listed = await runGitFn(["worktree", "list", "--porcelain", "-z"], {
    cwd: ownerRoot,
    timeoutMs: GIT_LOCAL_TIMEOUT_MS,
  });
  if (!listed.ok) return { found: false, usesBranch: () => false, detachedAt: () => false };
  for (const fields of parseWorktreePorcelain(listed.stdout)) {
    const worktreeField = fields.find((field) => field.startsWith("worktree "));
    if (!worktreeField) continue;
    const reportedPath = await realpathOrNull(worktreeField.slice("worktree ".length));
    if (!samePath(reportedPath, targetPath)) continue;
    return {
      found: true,
      usesBranch: (branch) => fields.includes(`branch refs/heads/${branch}`),
      detachedAt: (headSha) => fields.includes("detached") && fields.includes(`HEAD ${headSha}`),
    };
  }
  return { found: false, usesBranch: () => false, detachedAt: () => false };
}

function parseWorktreePorcelain(porcelain) {
  if (!porcelain.includes("\0")) {
    return porcelain.split("\n\n").filter(Boolean).map((block) => block.split("\n"));
  }
  const records = [];
  let current = [];
  for (const field of porcelain.split("\0")) {
    if (field === "") {
      if (current.length > 0) records.push(current);
      current = [];
    } else {
      current.push(field);
    }
  }
  if (current.length > 0) records.push(current);
  return records;
}

function blocker(code, message, details = []) {
  return { code, message, details };
}

function journalStepCompleted(journal, stepId) {
  return Boolean(journal?.steps?.some((step) => step?.id === stepId && step?.status === "completed"));
}

// Kód chyby resume podle povahy blockerů: drift identity journalu má přednost,
// čistě runtime nález si nechá svůj specifický kód (consumer ví, že má App
// zastavit), všechno ostatní je obecné „environment už není eligible".
function resumeBlockerCode(blockers) {
  const codes = new Set(blockers.map((item) => item.code));
  if (codes.has("cleanup_journal_environment_mismatch")) return "cleanup_journal_environment_mismatch";
  if (codes.size === 1 && codes.has("runtime_in_use")) return "cleanup_runtime_in_use";
  if (codes.size === 1 && codes.has("runtime_unverified")) return "cleanup_runtime_unverified";
  return "cleanup_not_ready";
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function samePath(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  if (process.platform === "win32") {
    return win32.resolve(left).toLowerCase() === win32.resolve(right).toLowerCase();
  }
  return resolve(left) === resolve(right);
}

function pathKey(path) {
  if (process.platform === "win32") {
    return win32.resolve(path).replaceAll("\\", "/").toLowerCase();
  }
  return resolve(path);
}

async function realpathOrNull(path) {
  try {
    return await realpath(path);
  } catch {
    return null;
  }
}

async function defaultProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    return true;
  }
}
