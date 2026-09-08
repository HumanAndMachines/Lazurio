import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, readFile, readdir, realpath, rename, rm, unlink, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join, relative, resolve, sep, win32 } from "node:path";
import { inspectCanonicalPathBoundary, isPathSameOrDescendant } from "../core/path-boundary-lib.mjs";
import { GIT_LOCAL_TIMEOUT_MS, runGit as defaultRunGit } from "./git-lib.mjs";
import { readGitOperationState } from "./git-status-lib.mjs";
import { readRequiredRepositoryDbWorktreeSlots } from "./repository-db-worktree-lib.mjs";

export const CLEANUP_PREVIEW_SCHEMA = "companiesascode.worktree_cleanup_preview.v1";
export const CLEANUP_APPLY_SCHEMA = "companiesascode.worktree_cleanup_apply.v1";
export const CLEANUP_JOURNAL_SCHEMA = "companiesascode.worktree_cleanup_journal.v1";

// PR evidence starší než toto okno je stale cache, ne živý důkaz.
export const PR_EVIDENCE_FRESHNESS_MS = 15 * 60 * 1000;

const SHA = /^[0-9a-f]{40}$/;
// Env proměnné, kterými harnessy nesou identitu relace Task Agenta (viz
// manual/worktree-management.md, tabulka conversation_origin).
const OWNER_SESSION_ENV_NAMES = [
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_SESSION_ID",
  "CODEX_THREAD_ID",
  "CODEX_SESSION_ID",
  "LAZURIO_TASK_AGENT_ID",
];

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
// ready_to_delete znamená, že environment je task-owned zahoditelná kopie,
// jejíž práce je merged v GitHubu nebo jejíž vlastník je prokazatelně mrtvý,
// a že žádný chráněný cíl (main checkout, canonical repository-db,
// personalspace, cizí checkout) není v dosahu teardownu.
export async function previewWorktreeCleanup(options = {}) {
  const { preview } = await inspectCleanupEnvironment(options);
  return preview;
}

// Jediná pravda cleanup guardů pro fresh preview i journal resume. Bez
// `resumeJournal` je to read-only preview. S ním se tytéž guardy přepočítají
// nad rozpracovaným environmentem: už odstraněné members se prokazují
// journalem (absence + neregistrace), všechno ostatní — vlastník, PR evidence,
// edit registrace/HEAD, dependency množina, runtime — se čte znovu ze živého
// stavu a identita (sidecar otisk, worktree cesta) musí sedět na journal.
async function inspectCleanupEnvironment({
  companiesRoot,
  worktree,
  resumeJournal = null,
  inspectRuntimeUsage = null,
  inspectOwnerSession = inspectLocalOwnerSession,
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
  const drift = [];
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
    owner: null,
    eligibility: null,
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
      drift,
      eligibility: snapshot.eligibility,
      owner: snapshot.owner,
      runtime: snapshot.runtime,
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

  // 2) Worktree cesta: task-owned kanonická `.worktrees/` cesta uvnitř
  //    Organization rootu, běžný adresář bez symlink/junction úniku. Cokoli
  //    jiného (main checkout, Organization root, cizí umístění) je chráněný
  //    cíl. Po dokončeném remove_edit je jedinou pravdou o cestě journal.
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
    if (!isTaskOwnedWorktreeLocation({ organizationRoot, worktreePath })) {
      blockers.push(blocker(
        "protected_target",
        `Cesta ${worktree.path} není task-owned worktree v kanonické .worktrees/ lane; cleanup ji nikdy nemaže.`,
      ));
      return base("invalid");
    }
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

  // 4) Edit member: exact linked registrace u owner repa na sidecar branchi;
  //    owner leží uvnitř Organization rootu a worktree není owner sám (main
  //    checkout). Dirty/untracked/unpushed/Git operace nejsou blocker —
  //    worktree je zahoditelná kopie — ale pravdivě se hlásí jako drift.
  const edit = editRemoved
    ? {
        blockers: [],
        drift: [],
        head: resumeJournal.environment.edit_head,
        ownerRoot: resumeJournal.environment.owner_root,
        remoteRefsContainHead: null,
      }
    : await inspectEditWorktree({
        organizationRoot,
        worktreePath,
        worktreeRealPath,
        branch: sidecar.metadata.branch,
        runGitFn,
      });
  blockers.push(...edit.blockers);
  drift.push(...edit.drift);
  snapshot.edit = edit;

  // 5) Vlastník: živý agent (sidecar conversation_origin + běžící proces s
  //    touž session identitou) je fail-closed ochrana. Běžící aplikace není
  //    důkaz vlastníka — tu řeší runtime krok apply.
  const owner = await resolveOwnerSession({
    inspectOwnerSession,
    metadata: sidecar.metadata,
    environment,
    worktreeRealPath,
  });
  snapshot.owner = owner;
  if (owner.alive) {
    blockers.push(blocker("active_owner", owner.message, owner.details));
  }

  // 6) Eligibility: merged v GitHubu (i squash — PR head patří této branchi,
  //    merge commit nemusí být předek), explicitní abandoned disposition, nebo
  //    prokazatelně mrtvý vlastník. Stáří samo nikdy nestačí.
  const eligibility = editRemoved
    ? {
        basis: resumeJournal.eligibility?.basis ?? null,
        pr: resumeJournal.eligibility?.pr_evidence ?? null,
        details: ["basis převzat z journalu po dokončeném remove_edit"],
      }
    : await evaluateEligibility({
        editMember,
        editHead: edit.head,
        branch: sidecar.metadata.branch,
        worktreePath,
        owner,
        prEvidence,
        runGitFn,
        now,
        blockers,
      });
  snapshot.eligibility = eligibility;
  if (!eligibility.basis) {
    blockers.push(blocker(
      "not_eligible",
      "Environment není dokončený ani prokazatelně opuštěný: chybí čerstvý MERGED důkaz z GitHubu, explicitní abandoned disposition i důkaz mrtvého vlastníka.",
      eligibility.details,
    ));
  }

  // 7) Runtime: bez čitelné evidence se nemaže (nelze bezpečně zastavit).
  //    Běžící managed App není blocker — apply ji zastaví jako první krok.
  const runtime = await resolveRuntimeEvidence({ inspectRuntimeUsage, environment, worktreeRealPath });
  snapshot.runtime = runtime;
  if (!runtime.verified) {
    blockers.push(blocker("runtime_unverified", runtime.message, runtime.details));
  } else if (runtime.in_use) {
    drift.push(driftEntry("runtime_in_use", runtime.message, runtime.details));
  }

  // 8) Dependency members a nested kopie: každý nested checkout musí být
  //    linked worktree kanonického ownera daného slotu uvnitř edit worktree
  //    — pak jde odstranit i dirty. Cizí owner je chráněný cíl.
  const dependencies = await inspectDependencyMembers({
    organizationRoot,
    worktreePath,
    metadata: sidecar.metadata,
    dependencyMembers,
    blockers,
    drift,
    journal: resumeJournal,
    editRemoved,
    runGitFn,
  });
  snapshot.dependencies = dependencies;

  const steps = planCleanupSteps({ dependencies, editMember });
  // Otisk drží identitu a eligibility, ne drift ani runtime: drift se
  // zahazuje a runtime se v apply záměrně mění (stop). Při resume se PR
  // evidence bere z journalu (to, co volající potvrdil).
  const fingerprint = computePreviewFingerprint({
    sidecarSha256: sidecar.sha256,
    worktreeRealPath,
    editHead: edit.head,
    eligibility,
    owner,
    dependencies,
    prEvidence: resumeJournal ? (resumeJournal.eligibility?.pr_evidence ?? null) : prEvidence,
  });
  snapshot.fingerprint = fingerprint;

  return base(blockers.length > 0 ? "needs_attention" : "ready_to_delete", {
    steps: steps.map((step) => step.id),
    branch_refs_kept: [{
      branch: sidecar.metadata.branch,
      note: "Branch ref i otevřený PR zůstávají zachované; obnovený agent navazuje z GitHubu.",
    }],
    preview_fingerprint: fingerprint,
  });
}

// Destruktivní apply přesně jednoho environmentu. Volající drží canonical
// Organization worktree lock (stejný jako create lane); tato funkce znovu
// načte živý stav, odmítne jakýkoli drift identity proti preview, zastaví
// runtime vlastněný environmentem a maže výhradně sidecarem vlastněné
// members nested-first s idempotentním journalem.
export async function applyWorktreeCleanup({
  companiesRoot,
  worktree,
  expectedFingerprint,
  inspectRuntimeUsage = null,
  stopRuntimeUsage = null,
  inspectOwnerSession = inspectLocalOwnerSession,
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
  const execution = { companiesRoot, worktree, organizationRoot, journalPath, inspectRuntimeUsage, stopRuntimeUsage, runGitFn, now };

  if (journal.state === "present") {
    return resumeCleanupFromJournal({
      ...execution,
      journal: journal.value,
      expectedFingerprint,
      inspectOwnerSession,
      prEvidence,
    });
  }

  const { preview, snapshot } = await inspectCleanupEnvironment({
    companiesRoot,
    worktree,
    inspectRuntimeUsage,
    inspectOwnerSession,
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
  const { sidecar, edit, dependencies, worktreeRealPath, eligibility } = snapshot;
  const timestamp = now().toISOString();
  const journalValue = {
    schema_version: CLEANUP_JOURNAL_SCHEMA,
    created_at: timestamp,
    updated_at: timestamp,
    preview_fingerprint: expectedFingerprint,
    eligibility: {
      basis: eligibility.basis,
      pr_evidence: normalizePrEvidence(prEvidence),
    },
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
      { id: "stop_runtime", kind: "stop_runtime", status: "pending" },
      ...dependencies.map((dependency) => ({
        id: `remove_dependency:${dependency.slotPath}`,
        kind: "remove_dependency",
        slot_path: dependency.slotPath,
        repo_path: dependency.repoPath,
        source_path: dependency.sourcePath,
        target_real_path: dependency.targetRealPath,
        status: "pending",
      })),
      { id: "remove_edit", kind: "remove_edit", status: "pending" },
      { id: "remove_sidecar", kind: "remove_sidecar", status: "pending" },
    ],
  };
  await writeFile(journalPath, `${JSON.stringify(journalValue, null, 2)}\n`, { encoding: "utf8", flag: "wx" });

  return executeCleanupJournal({ ...execution, journal: journalValue });
}

async function resumeCleanupFromJournal({
  companiesRoot,
  worktree,
  organizationRoot,
  journalPath,
  journal,
  expectedFingerprint,
  inspectRuntimeUsage,
  stopRuntimeUsage,
  inspectOwnerSession,
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
  const execution = { companiesRoot, worktree, organizationRoot, journalPath, journal, inspectRuntimeUsage, stopRuntimeUsage, runGitFn, now };

  // Po odstranění všech worktree members zbývá nejvýš sidecar; když už ani ten
  // není (pád mezi unlinkem a zápisem journalu), není co znovu hodnotit —
  // dokončení jen uzavře journal bez destruktivního kroku.
  const remaining = journal.steps.filter((step) => step.status !== "completed");
  const sidecarPath = resolve(companiesRoot, worktree.sidecar_path);
  const onlySidecarRemains = remaining.every((step) => step.kind === "remove_sidecar");
  if (remaining.length === 0 || (onlySidecarRemains && !existsSync(sidecarPath))) {
    return executeCleanupJournal(execution);
  }

  // Manuál: apply znovu přepočítá všechny guardy těsně před mutací — i při
  // resume. Journal fingerprint říká, co volající potvrdil; živý eligibility
  // snapshot (vlastník, eligibility, edit, dependency množina, runtime) musí
  // i teď projít a dát přesně tentýž otisk. Jinak se žádný krok nespustí.
  const { preview, snapshot } = await inspectCleanupEnvironment({
    companiesRoot,
    worktree,
    resumeJournal: journal,
    inspectRuntimeUsage,
    inspectOwnerSession,
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
  return executeCleanupJournal(execution);
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
  if (!isTaskOwnedWorktreeLocation({ organizationRoot: organizationRealPath ?? organizationRoot, worktreePath: environment.worktree_real_path ?? "" })) {
    issues.push("worktree_real_path není kanonická .worktrees/ lane");
  }
  if (!insideOrganization(environment.owner_root)) issues.push("owner_root neleží uvnitř Organization rootu");
  if (samePath(environment.owner_root, environment.worktree_real_path)) issues.push("owner_root je totožný s worktree (main checkout)");
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
      || samePath(step.target_real_path, environment.worktree_real_path)
    ) {
      issues.push(`target_real_path kroku ${step.id} neleží uvnitř edit worktree`);
    }
    if (samePath(step.target_real_path, step.source_path)) issues.push(`target kroku ${step.id} je kanonický owner checkout`);
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
  stopRuntimeUsage,
  runGitFn,
  now,
}) {
  const results = [];
  const runtimeEnvironment = { slug: journal.environment.slug, organization: journal.environment.organization };
  for (const step of journal.steps) {
    if (step.status === "completed") {
      results.push({ id: step.id, status: "completed" });
      continue;
    }
    // Runtime brána těsně před každým destruktivním krokem: dokud journal
    // existuje, Launchpad start worktree App odmítá; co přesto běží, musí být
    // zastavené krokem stop_runtime. Cokoli neznámého původu je blocker,
    // nikdy důvod zabít cizí proces.
    if (!["remove_sidecar", "stop_runtime"].includes(step.kind)) {
      const runtime = await resolveRuntimeEvidence({
        inspectRuntimeUsage,
        environment: runtimeEnvironment,
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
      inspectRuntimeUsage,
      stopRuntimeUsage,
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
    eligibility: journal.eligibility ?? null,
    steps: results,
    branch_refs_kept: [{
      branch: journal.environment.branch,
      note: "Branch ref i otevřený PR zůstávají zachované; obnovený agent navazuje z GitHubu.",
    }],
    journal_removed: true,
  };
}

async function executeCleanupStep({ organizationRoot, journal, step, inspectRuntimeUsage, stopRuntimeUsage, runGitFn }) {
  if (step.kind === "stop_runtime") {
    return executeStopRuntimeStep({ journal, inspectRuntimeUsage, stopRuntimeUsage });
  }
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

// Stop → grace → kill provádí lifecycle vlastník (Launchpad runtime manager)
// výhradně pro procesy, které sám spustil z tohoto worktree. Cleanup lib nic
// nezabíjí: po zastavení znovu čte durable evidenci a zbytek neznámého původu
// je fail-closed blocker.
async function executeStopRuntimeStep({ journal, inspectRuntimeUsage, stopRuntimeUsage }) {
  const environment = { slug: journal.environment.slug, organization: journal.environment.organization };
  const worktreeRealPath = journal.environment.worktree_real_path;
  const before = await resolveRuntimeEvidence({ inspectRuntimeUsage, environment, worktreeRealPath });
  if (!before.verified) {
    throw new WorktreeCleanupError(`Runtime evidence chybí; environment nelze bezpečně zastavit: ${before.message}`, {
      code: "cleanup_runtime_unverified",
      details: before.details,
    });
  }
  if (!before.in_use) return "skipped_not_running";
  if (typeof stopRuntimeUsage !== "function") {
    throw new WorktreeCleanupError(
      "Environment má běžící runtime a tato lane neumí zastavit jeho procesy; použij Launchpad cleanup apply.",
      { code: "cleanup_runtime_in_use", details: before.details },
    );
  }
  let stopResult;
  try {
    stopResult = await stopRuntimeUsage({ environment, worktreeRealPath });
  } catch (error) {
    throw new WorktreeCleanupError(
      `Zastavení runtime selhalo: ${error instanceof Error ? error.message : String(error)}`,
      { code: "cleanup_runtime_stop_failed" },
    );
  }
  const after = await resolveRuntimeEvidence({ inspectRuntimeUsage, environment, worktreeRealPath });
  if (!after.verified || after.in_use) {
    throw new WorktreeCleanupError(
      `Po zastavení managed runtime environment stále něco používá; cizí proces cleanup nezabíjí: ${after.message}`,
      { code: after.verified ? "cleanup_runtime_in_use" : "cleanup_runtime_unverified", details: after.details },
    );
  }
  return stopResult && typeof stopResult === "object" && Number(stopResult.stopped) > 0 ? "completed" : "completed_nothing_managed";
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
    // Identita, ne čistota: cíl musí být linked worktree kanonického ownera
    // uvnitř edit worktree. Dirty nebo posunutý HEAD je zahoditelný drift.
    const owner = await resolveGitOwnerRoot({ path: targetPath, runGitFn });
    if (!owner.ok || !samePath(owner.root, await realpathOrNull(step.source_path)) || !registered.found) {
      throw new WorktreeCleanupError(
        `Dependency cesta ${step.repo_path} není linked worktree kanonického ownera ${step.slot_path}; chráněný cíl se nemaže.`,
        { code: "cleanup_step_precondition_failed" },
      );
    }
    if (samePath(targetPath, owner.root)) {
      throw new WorktreeCleanupError("Dependency cesta je kanonický owner checkout; cleanup se zastavil bez zásahu.", {
        code: "cleanup_step_precondition_failed",
      });
    }
    const removed = await runGitFn(["worktree", "remove", "--force", targetPath], {
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
    if (samePath(targetPath, await realpathOrNull(ownerRoot))) {
      throw new WorktreeCleanupError("Edit worktree cesta je owner (main) checkout; cleanup se zastavil bez zásahu.", {
        code: "cleanup_step_precondition_failed",
      });
    }
    if (!registered.found || !registered.usesBranch(journal.environment.branch)) {
      throw new WorktreeCleanupError(
        "Edit worktree není exact linked registrace owner repa na sidecar branchi; chráněný cíl se nemaže.",
        { code: "cleanup_step_precondition_failed" },
      );
    }
    // --force: dirty/untracked/unpushed drift se podle rozhodnutí zahazuje;
    // vše hodnotné žije v GitHub Draft PR. Nested dočasné kopie uvnitř
    // worktree odcházejí s ním.
    const removed = await runGitFn(["worktree", "remove", "--force", targetPath], {
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
// state soubory Launchpadu a hlásí každý záznam, který environment referuje
// a jehož proces může stále žít. Nic neukončuje — zastavení patří lifecycle
// vlastníkovi (runtime manager), který procesy sám spustil.
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

// Lokální důkaz živého vlastníka: sidecar conversation_origin (machine_ref,
// harness surface, thread_id) + běžící proces této Mašiny, který nese touž
// session identitu v env. Cizí Mašina, chybějící locator nebo nečitelný
// process list = unverified (fail-closed pro abandon větev). Běžící aplikace
// vlastníka nedokazuje; cwd procesů se proto záměrně nehodnotí.
export async function inspectLocalOwnerSession({
  conversationOrigin,
  machineRef = hostname(),
  platform = process.platform,
  listProcessEnvironments = defaultListProcessEnvironments,
} = {}) {
  const origin = conversationOrigin && typeof conversationOrigin === "object" ? conversationOrigin : null;
  if (!origin) {
    return { verified: false, alive: false, message: "Sidecar nemá conversation_origin; vlastníka nelze ověřit.", details: [] };
  }
  if (origin.thread_locator_status === "not_applicable") {
    return { verified: true, alive: false, message: "Environment nemá Task Agent relaci (not_applicable); vlastník není živý proces.", details: [] };
  }
  if (typeof origin.machine_ref !== "string" || origin.machine_ref.trim() === "" || origin.machine_ref !== machineRef) {
    return {
      verified: false,
      alive: false,
      message: `Sidecar patří Mašině ${origin.machine_ref ?? "unknown"}, ne ${machineRef}; vlastníka nelze lokálně ověřit.`,
      details: [],
    };
  }
  const threadId = typeof origin.thread_id === "string" ? origin.thread_id.trim() : "";
  if (origin.thread_locator_status !== "captured" || threadId === "") {
    return { verified: false, alive: false, message: "Sidecar nemá zachycený thread locator; vlastníka nelze ověřit.", details: [] };
  }
  let processes;
  try {
    processes = await listProcessEnvironments({ platform });
  } catch (error) {
    return {
      verified: false,
      alive: false,
      message: `Seznam procesů nejde přečíst: ${error instanceof Error ? error.message : String(error)}`,
      details: [],
    };
  }
  if (!processes) {
    return { verified: false, alive: false, message: `Platforma ${platform} neumí ověřit session procesy; vlastníka nelze ověřit.`, details: [] };
  }
  const matches = [];
  for (const entry of processes) {
    for (const name of OWNER_SESSION_ENV_NAMES) {
      if (entry.env?.[name] === threadId) {
        matches.push(`pid=${entry.pid}: ${name}=${threadId}`);
        break;
      }
    }
  }
  if (matches.length > 0) {
    return { verified: true, alive: true, message: `Vlastník ${origin.surface ?? "agent"} (${threadId}) má živý proces na této Mašině.`, details: matches };
  }
  return { verified: true, alive: false, message: `Žádný proces této Mašiny nenese session ${threadId}; vlastník je mrtvý.`, details: [] };
}

// Explicitní GitHub důkaz merged práce pro branch, včetně squash: hledá se PR
// podle head branch, ne podle ancestor merge commitu. Volající dodá runner
// `gh`; selhání sítě/auth vrací null (žádný důkaz), nikdy falešný MERGED.
export async function resolveMergedPullRequestEvidence({
  ownerRoot,
  branch,
  runGhFn,
  runGitFn = defaultRunGit,
  now = () => new Date(),
} = {}) {
  if (typeof runGhFn !== "function" || !ownerRoot || typeof branch !== "string" || branch.trim() === "") return null;
  const remote = await runGitFn(["remote", "get-url", "origin"], { cwd: ownerRoot, timeoutMs: GIT_LOCAL_TIMEOUT_MS });
  const coordinate = remote.ok ? githubCoordinateFromRemote(remote.stdout.trim()) : null;
  if (!coordinate) return null;
  let result;
  try {
    result = await runGhFn([
      "pr", "list",
      "--repo", coordinate,
      "--head", branch,
      "--state", "merged",
      "--limit", "5",
      "--json", "url,state,headRefOid,mergedAt,headRefName",
    ]);
  } catch {
    return null;
  }
  if (!result?.ok) return null;
  let list;
  try {
    list = JSON.parse(result.stdout);
  } catch {
    return null;
  }
  const merged = Array.isArray(list)
    ? list.find((item) => item?.state === "MERGED" && item?.headRefName === branch && SHA.test(item?.headRefOid ?? ""))
    : null;
  if (!merged) return null;
  return {
    url: merged.url,
    state: "MERGED",
    head_sha: merged.headRefOid,
    branch,
    merged_at: merged.mergedAt ?? null,
    checked_at: now().toISOString(),
  };
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

// Task-owned worktree žije výhradně v `<organization>/.worktrees/<lane>/...`
// nebo v `.worktrees/root/...` Lazurio rootu. Cokoli mimo (main checkout,
// personalspace, productionspace checkout, cizí umístění) cleanup nezná.
function isTaskOwnedWorktreeLocation({ organizationRoot, worktreePath }) {
  if (typeof worktreePath !== "string" || worktreePath === "") return false;
  const relativePath = relative(resolve(organizationRoot), resolve(worktreePath));
  if (relativePath === "" || relativePath.startsWith("..") || win32.isAbsolute(relativePath) || relativePath.startsWith("/")) return false;
  const segments = relativePath.split(/[\\/]/);
  return segments.length >= 3 && segments[0] === ".worktrees" && segments.every((segment) => segment !== "" && segment !== "..");
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
  const drift = [];
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
    blockers.push(blocker("edit_branch_mismatch", `Edit worktree musí být na branchi ${branch}; jiná branch znamená neznámou identitu.`));
  }
  if (!porcelain.ok || porcelain.stdout !== "") {
    drift.push(driftEntry("edit_dirty", "Edit worktree má necommitnuté nebo untracked změny; apply je zahodí (vše hodnotné žije v GitHub Draft PR)."));
  }
  if (operation) {
    drift.push(driftEntry("edit_git_operation", `V edit worktree je rozpracovaná Git operace ${operation.kind}; apply ji zahodí.`));
  }
  const owner = await resolveEditOwnerRoot({ organizationRoot, worktreePath, runGitFn });
  if (!owner.ok) {
    blockers.push(blocker("edit_not_registered", owner.message));
  } else if (samePath(owner.root, worktreeRealPath)) {
    blockers.push(blocker("protected_target", "Worktree cesta je owner (main) checkout; cleanup ji nikdy nemaže."));
  } else {
    const registration = await ownerRegistrationForPath({
      ownerRoot: owner.root,
      targetPath: worktreeRealPath,
      runGitFn,
    });
    if (!registration.found || !registration.usesBranch(branch)) {
      blockers.push(blocker("edit_not_registered", "Edit worktree není exact linked registrace svého owner repa na sidecar branchi."));
    }
  }
  const editHead = head.ok && SHA.test(head.stdout) ? head.stdout : null;
  if (!editHead) {
    blockers.push(blocker("edit_head_unknown", "Exact HEAD edit worktree nelze určit."));
  }
  const remoteRefsContainHead = remoteContains.ok && remoteContains.stdout.trim() !== "";
  if (editHead && !remoteRefsContainHead) {
    drift.push(driftEntry("edit_unpushed", "Exact HEAD edit worktree není na žádném remote refu; nepushnuté commity apply zahodí."));
  }
  return {
    blockers,
    drift,
    head: editHead,
    ownerRoot: owner.ok ? owner.root : null,
    remoteRefsContainHead,
  };
}

// Owner repo worktree se čte z Git registru samotného worktree; sidecar cestu
// ownera nedrží a hádání podle repo_kind by vytvořilo druhou pravdu. Owner
// musí kanonicky ležet uvnitř Organization rootu (nebo jím přímo být).
async function resolveEditOwnerRoot({ organizationRoot, worktreePath, runGitFn }) {
  const owner = await resolveGitOwnerRoot({ path: worktreePath, runGitFn });
  if (!owner.ok) return { ok: false, message: "Owner repo edit worktree nelze z Git registru určit." };
  const organizationRealPath = await realpathOrNull(organizationRoot);
  if (!organizationRealPath || !isPathSameOrDescendant(organizationRealPath, owner.root)) {
    return { ok: false, message: "Owner repo edit worktree leží mimo Organization root." };
  }
  return owner;
}

async function resolveGitOwnerRoot({ path, runGitFn }) {
  const commonDir = await runGitFn(["rev-parse", "--path-format=absolute", "--git-common-dir"], {
    cwd: path,
    timeoutMs: GIT_LOCAL_TIMEOUT_MS,
  });
  if (!commonDir.ok || commonDir.stdout.trim() === "") return { ok: false, root: null };
  const ownerRealPath = await realpathOrNull(dirname(resolve(commonDir.stdout.trim())));
  if (!ownerRealPath) return { ok: false, root: null };
  return { ok: true, root: ownerRealPath };
}

async function resolveOwnerSession({ inspectOwnerSession, metadata, environment, worktreeRealPath }) {
  if (typeof inspectOwnerSession !== "function") {
    return { verified: false, alive: false, message: "Owner session evidence chybí; vlastníka nelze ověřit.", details: [] };
  }
  try {
    const session = await inspectOwnerSession({
      conversationOrigin: metadata.conversation_origin ?? null,
      recoveryHandoff: metadata.recovery_handoff ?? null,
      environment,
      worktreeRealPath,
    });
    if (!session || typeof session !== "object" || typeof session.verified !== "boolean" || typeof session.alive !== "boolean") {
      return { verified: false, alive: false, message: "Owner session evidence nemá kanonický tvar { verified, alive }.", details: [] };
    }
    return {
      verified: session.verified,
      alive: session.alive,
      message: session.message ?? (session.alive ? "Vlastník environmentu má živý proces." : "Vlastník environmentu nemá živý proces."),
      details: Array.isArray(session.details) ? session.details : [],
    };
  } catch (error) {
    return {
      verified: false,
      alive: false,
      message: `Owner session evidence selhala: ${error instanceof Error ? error.message : String(error)}`,
      details: [],
    };
  }
}

async function evaluateEligibility({ editMember, editHead, branch, worktreePath, owner, prEvidence, runGitFn, now, blockers }) {
  const details = [];
  const evidence = normalizePrEvidence(prEvidence);
  let pr = null;
  if (evidence) {
    const ageMs = now().getTime() - Date.parse(evidence.checked_at);
    const fresh = Number.isFinite(ageMs) && ageMs >= 0 && ageMs <= PR_EVIDENCE_FRESHNESS_MS;
    if (evidence.state === "MERGED") {
      if (!fresh) {
        blockers.push(blocker("pr_evidence_stale", "MERGED evidence není čerstvá; stale cache není důkaz."));
      } else if (evidence.branch && evidence.branch !== branch) {
        blockers.push(blocker("pr_evidence_mismatch", `MERGED evidence patří branchi ${evidence.branch}, ne ${branch}.`));
      } else if (!(await headBelongsToBranch({ headSha: evidence.head_sha, editHead, branch, worktreePath, runGitFn }))) {
        blockers.push(blocker("pr_evidence_mismatch", "MERGED evidence neodpovídá této branchi: PR head není předek exact HEAD ani tip origin branche."));
      } else {
        pr = evidence;
        return { basis: "merged", pr, details: [`MERGED ${evidence.url} (head ${evidence.head_sha.slice(0, 12)})`] };
      }
    } else {
      details.push(`PR evidence ${evidence.state} není důkaz dokončení`);
    }
  } else {
    details.push("žádná čerstvá MERGED evidence z GitHubu");
  }
  if (editMember.disposition === "abandoned") {
    return { basis: "abandoned_explicit", pr: evidence, details: ["edit member má explicitní abandoned disposition"] };
  }
  if (owner.verified && !owner.alive) {
    return { basis: "abandoned_owner_dead", pr: evidence, details: [owner.message] };
  }
  details.push(owner.verified ? owner.message : `vlastníka nelze ověřit: ${owner.message}`);
  return { basis: null, pr: evidence, details };
}

// Squash merge nezanechá merge commit v historii branche; důkazem je PR
// s touto head branchí. PR head proto musí být exact HEAD, jeho předek
// (lokální drift po merge), nebo tip remote branche.
async function headBelongsToBranch({ headSha, editHead, branch, worktreePath, runGitFn }) {
  if (headSha === editHead) return true;
  const ancestor = await runGitFn(["merge-base", "--is-ancestor", headSha, "HEAD"], { cwd: worktreePath, timeoutMs: GIT_LOCAL_TIMEOUT_MS });
  if (ancestor.ok) return true;
  const remoteTip = await runGitFn(["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`], { cwd: worktreePath, timeoutMs: GIT_LOCAL_TIMEOUT_MS });
  return remoteTip.ok && remoteTip.stdout.trim() === headSha;
}

function normalizePrEvidence(prEvidence) {
  if (!prEvidence || typeof prEvidence !== "object") return null;
  const { url, state, head_sha: headSha, checked_at: checkedAt, branch } = prEvidence;
  if (typeof url !== "string" || typeof state !== "string" || typeof headSha !== "string" || typeof checkedAt !== "string") {
    return null;
  }
  if (!SHA.test(headSha)) return null;
  return {
    url,
    state: state.toUpperCase(),
    head_sha: headSha,
    checked_at: checkedAt,
    ...(typeof branch === "string" && branch !== "" ? { branch } : {}),
  };
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

// Dependency množina = sidecar dependency members ∪ aktuálně required
// repository-db sloty (deklarované i po create). Každá existující nested
// cesta uvnitř edit worktree musí být linked worktree kanonického ownera
// daného slotu — pak jde odstranit i dirty/posunutá. Checkout cizího ownera
// je chráněný cíl. Při resume se dokončený krok prokazuje absencí cesty i
// registrace; po odstraněném edit worktree už module contract nejde číst.
async function inspectDependencyMembers({
  organizationRoot,
  worktreePath,
  metadata,
  dependencyMembers,
  blockers,
  drift,
  journal = null,
  editRemoved = false,
  runGitFn = defaultRunGit,
}) {
  const journalSteps = new Map(
    (journal?.steps ?? [])
      .filter((step) => step.kind === "remove_dependency")
      .map((step) => [step.slot_path, step]),
  );
  const candidates = new Map();
  for (const member of dependencyMembers) {
    if (typeof member?.slot_path !== "string" || typeof member?.repo_path !== "string") {
      blockers.push(blocker("sidecar_invalid", "Dependency member nemá slot_path/repo_path."));
      continue;
    }
    candidates.set(member.slot_path, { slotPath: member.slot_path, repoPath: member.repo_path, member });
  }
  if (!editRemoved) {
    const requirements = await readRequiredRepositoryDbWorktreeSlots({
      organizationRoot,
      moduleCheckoutRoot: worktreePath,
      moduleSlotPath: metadata.module_path,
      moduleId: metadata.module,
    });
    if (!requirements.ok) {
      drift.push(driftEntry("requirements_unavailable", `Aktuální required sloty nejde přečíst (${requirements.message}); hodnotí se jen sidecar members.`, requirements.details));
    } else {
      for (const dependency of requirements.dependencies) {
        if (!candidates.has(dependency.slot_path)) {
          candidates.set(dependency.slot_path, { slotPath: dependency.slot_path, repoPath: dependency.relative_path, member: null });
        }
      }
    }
  }

  const dependencies = [];
  for (const candidate of candidates.values()) {
    const step = journal ? journalSteps.get(candidate.slotPath) : null;
    if (journal && !step) {
      blockers.push(blocker(
        "cleanup_journal_environment_mismatch",
        `Dependency ${candidate.slotPath} nemá v journalu teardown krok; cleanup se neobnoví.`,
      ));
      continue;
    }
    if (step?.status === "completed") {
      const registration = await ownerRegistrationForPath({ ownerRoot: step.source_path, targetPath: step.target_real_path, runGitFn });
      if (existsSync(step.target_real_path) || registration.found) {
        blockers.push(blocker(
          "cleanup_journal_environment_mismatch",
          `Dependency ${candidate.slotPath} po dokončeném kroku znovu existuje nebo je registrovaná u ownera; cleanup se neobnoví.`,
        ));
        continue;
      }
      dependencies.push({ slotPath: candidate.slotPath, repoPath: step.repo_path, sourcePath: step.source_path, targetRealPath: step.target_real_path, head: step.head ?? null });
      continue;
    }
    if (editRemoved) {
      blockers.push(blocker(
        "cleanup_journal_environment_mismatch",
        `Dependency ${candidate.slotPath} má nedokončený krok po odstraněném edit worktree; journal neodpovídá pořadí teardownu.`,
      ));
      continue;
    }
    const inspection = await inspectNestedCheckout({ organizationRoot, worktreePath, candidate, runGitFn });
    if (inspection.state === "absent") continue;
    if (inspection.state === "protected") {
      blockers.push(blocker("protected_target", inspection.message, inspection.details));
      continue;
    }
    if (inspection.state === "invalid") {
      blockers.push(blocker("containment_invalid", inspection.message, inspection.details));
      continue;
    }
    if (step && !samePath(step.target_real_path, inspection.targetRealPath)) {
      blockers.push(blocker("cleanup_journal_environment_mismatch", `Dependency ${candidate.slotPath} má jinou cestu než journal krok.`));
      continue;
    }
    drift.push(...inspection.drift);
    dependencies.push({
      slotPath: candidate.slotPath,
      repoPath: candidate.repoPath,
      sourcePath: inspection.sourcePath,
      targetRealPath: inspection.targetRealPath,
      head: inspection.head,
    });
  }
  return dependencies;
}

async function inspectNestedCheckout({ organizationRoot, worktreePath, candidate, runGitFn }) {
  const targetPath = resolve(worktreePath, candidate.repoPath);
  const lexicalRelative = relative(worktreePath, targetPath);
  if (lexicalRelative === "" || lexicalRelative.startsWith("..") || win32.isAbsolute(lexicalRelative) || lexicalRelative.startsWith(sep)) {
    return { state: "invalid", message: `Dependency cesta ${candidate.repoPath} opouští edit worktree.`, details: [] };
  }
  let entry;
  try {
    entry = await lstat(targetPath);
  } catch {
    return { state: "absent" };
  }
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    return { state: "invalid", message: `Dependency cesta ${candidate.repoPath} není běžný adresář.`, details: [] };
  }
  const boundary = await inspectCanonicalPathBoundary({ rootPath: worktreePath, targetPath });
  if (!boundary.ok || !boundary.targetRealPath) {
    return { state: "invalid", message: `Dependency cesta ${candidate.repoPath} opouští edit worktree.`, details: [] };
  }
  const targetRealPath = await realpath(boundary.targetRealPath);
  const sourcePath = resolve(organizationRoot, candidate.slotPath);
  const sourceRealPath = await realpathOrNull(sourcePath);
  const sourceBoundary = sourceRealPath
    ? await inspectCanonicalPathBoundary({ rootPath: organizationRoot, targetPath: sourcePath })
    : { ok: false };
  if (!sourceBoundary.ok || !sourceRealPath) {
    return { state: "protected", message: `Kanonický owner slotu ${candidate.slotPath} chybí nebo opouští Organization root; nested checkout nelze přiřadit.`, details: [] };
  }
  if (samePath(targetRealPath, sourceRealPath)) {
    return { state: "protected", message: `Dependency cesta ${candidate.repoPath} je kanonický repository-db checkout; cleanup ho nikdy nemaže.`, details: [] };
  }
  const owner = await resolveGitOwnerRoot({ path: targetRealPath, runGitFn });
  if (!owner.ok) {
    // Bez Git registru je to jen adresář uvnitř zahoditelného worktree;
    // odchází s remove_edit --force, samostatný krok nepotřebuje.
    return { state: "absent" };
  }
  if (!samePath(owner.root, sourceRealPath)) {
    return {
      state: "protected",
      message: `Nested checkout ${candidate.repoPath} patří jinému owner repu (${owner.root}); cizí worktree se nemaže.`,
      details: [],
    };
  }
  const registration = await ownerRegistrationForPath({ ownerRoot: sourceRealPath, targetPath: targetRealPath, runGitFn });
  if (!registration.found) {
    return {
      state: "protected",
      message: `Nested checkout ${candidate.repoPath} není registrovaný linked worktree ownera ${candidate.slotPath}.`,
      details: [],
    };
  }
  const [head, porcelain, branch] = await Promise.all([
    runGitFn(["rev-parse", "HEAD"], { cwd: targetRealPath, timeoutMs: GIT_LOCAL_TIMEOUT_MS }),
    runGitFn(["status", "--porcelain=v1", "--untracked-files=normal"], { cwd: targetRealPath, timeoutMs: GIT_LOCAL_TIMEOUT_MS }),
    runGitFn(["branch", "--show-current"], { cwd: targetRealPath, timeoutMs: GIT_LOCAL_TIMEOUT_MS }),
  ]);
  const drift = [];
  const baseSha = candidate.member?.base_sha ?? null;
  if (!porcelain.ok || porcelain.stdout !== "") {
    drift.push(driftEntry("dependency_dirty", `Dependency ${candidate.repoPath} má necommitnuté změny; apply je zahodí (canonical repository-db zůstává nedotčená).`));
  }
  if (baseSha && head.ok && head.stdout !== baseSha) {
    drift.push(driftEntry("dependency_head_moved", `Dependency ${candidate.repoPath} má jiný HEAD než sidecar base_sha; apply linked worktree zahodí.`));
  }
  if (branch.ok && branch.stdout !== "") {
    drift.push(driftEntry("dependency_on_branch", `Dependency ${candidate.repoPath} není detached (${branch.stdout}); branch ref zůstane ownerovi.`));
  }
  return {
    state: "checkout",
    sourcePath: sourceRealPath,
    targetRealPath,
    head: head.ok && SHA.test(head.stdout) ? head.stdout : null,
    drift,
  };
}

function planCleanupSteps({ dependencies, editMember }) {
  return [
    { id: "stop_runtime" },
    ...dependencies.map((dependency) => ({ id: `remove_dependency:${dependency.slotPath}` })),
    { id: "remove_edit", branch: editMember.branch },
    { id: "remove_sidecar" },
  ];
}

function computePreviewFingerprint({
  sidecarSha256,
  worktreeRealPath,
  editHead,
  eligibility,
  owner,
  dependencies,
  prEvidence,
}) {
  return sha256(JSON.stringify({
    v: 2,
    sidecar: sidecarSha256,
    worktree: pathKey(worktreeRealPath),
    edit_head: editHead,
    eligibility: eligibility?.basis ?? null,
    owner: { verified: owner?.verified ?? false, alive: owner?.alive ?? false },
    dependencies: dependencies.map((dependency) => ({
      slot: dependency.slotPath,
      target: pathKey(dependency.targetRealPath),
    })),
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
  const prEvidence = value?.eligibility?.pr_evidence;
  if (
    value?.schema_version !== CLEANUP_JOURNAL_SCHEMA
    || !value.environment
    || !Array.isArray(value.steps)
    || value.steps.some((step) => !step?.id || !step?.kind || !["pending", "completed"].includes(step?.status))
    || (prEvidence != null && normalizePrEvidence(prEvidence) === null)
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

function githubCoordinateFromRemote(url) {
  const match = /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(url ?? "");
  if (!match) return null;
  return `${match[1]}/${match[2]}`;
}

// Seznam procesů této Mašiny s jejich env (jen procesy, které OS dovolí
// číst — cizí uživatelé se nezobrazí, což je pro důkaz vlastníka správně).
async function defaultListProcessEnvironments({ platform = process.platform } = {}) {
  if (platform === "linux") {
    const entries = await readdir("/proc");
    const processes = [];
    for (const entry of entries) {
      if (!/^\d+$/.test(entry)) continue;
      try {
        const raw = await readFile(`/proc/${entry}/environ`, "latin1");
        processes.push({ pid: Number(entry), env: parseEnvironmentPairs(raw.split("\0")) });
      } catch {
        // Cizí nebo právě ukončený proces: bez env, nic k porovnání.
      }
    }
    return processes;
  }
  if (platform === "darwin") {
    const child = Bun.spawn(["ps", "-axww", "-E", "-o", "pid=,command="], { stdout: "pipe", stderr: "pipe" });
    const stdout = await new Response(child.stdout).text();
    const exitCode = await child.exited;
    if (exitCode !== 0) throw new Error(`ps skončil kódem ${exitCode}`);
    const processes = [];
    for (const line of stdout.split("\n")) {
      const match = /^\s*(\d+)\s+(.*)$/.exec(line);
      if (!match) continue;
      const tokens = match[2].split(" ");
      processes.push({ pid: Number(match[1]), env: parseEnvironmentPairs(tokens) });
    }
    return processes;
  }
  return null;
}

function parseEnvironmentPairs(tokens) {
  const env = {};
  for (const token of tokens) {
    const index = token.indexOf("=");
    if (index <= 0) continue;
    const name = token.slice(0, index);
    if (!OWNER_SESSION_ENV_NAMES.includes(name)) continue;
    env[name] = token.slice(index + 1);
  }
  return env;
}

function blocker(code, message, details = []) {
  return { code, message, details };
}

function driftEntry(code, message, details = []) {
  return { code, message, details };
}

function journalStepCompleted(journal, stepId) {
  return Boolean(journal?.steps?.some((step) => step?.id === stepId && step?.status === "completed"));
}

// Kód chyby resume podle povahy blockerů: drift identity journalu má přednost,
// živý vlastník a runtime si nechají specifický kód, ostatní je obecné
// „environment už není eligible".
function resumeBlockerCode(blockers) {
  const codes = new Set(blockers.map((item) => item.code));
  if (codes.has("cleanup_journal_environment_mismatch")) return "cleanup_journal_environment_mismatch";
  if (codes.has("active_owner")) return "cleanup_active_owner";
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
