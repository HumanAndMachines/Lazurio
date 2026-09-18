// Migration-only code (DEV-6512, decision 0145): `lazurio migrate
// organization-manifest`. Core owns state, parity and the deterministic
// projection; this adapter owns the plan, the Git/worktree gate and the
// per-file atomic replacement. Delete the folder once every Organization root
// is `current`.

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { rename, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  ORGANIZATION_ACTIVATABLE_MANIFEST_FORMATS,
  ORGANIZATION_ROOT_RESOLUTION_VERSION,
  isOrganizationForgeIdentityVerified,
  isOrganizationRootSupported,
  organizationLegacyProjectionHash,
  projectLegacyOrganizationManifest,
  resolveOrganizationRootDocuments,
} from "../../core/organization-activation-lib.mjs";
import {
  ORGANIZATION_DOCUMENT_PATHS,
  readOrganizationRoot,
  readOrganizationRootDocuments,
} from "../../core/organization-root-reader-lib.mjs";
import { resolveGitExecutableOnPath } from "../../core/toolchain-lib.mjs";
import { validateAgainstSchema } from "../../runtime/json-schema-mini.mjs";
import canonicalSchema from "../../lazurio.organization.v1.schema.json";
import legacySchema from "../../schemas/company.gen3.schema.json";
import packageManifest from "../../package.json";
import { deriveCanonicalOrganizationManifest } from "./derive-canonical-manifest.mjs";

export const ORGANIZATION_MANIFEST_MIGRATION_REPORT_SCHEMA = "lazurio.organization.manifest-migration.v0";
export const ORGANIZATION_MANIFEST_MIGRATION_COMMAND = "lazurio migrate organization-manifest";
export const ORGANIZATION_MANIFEST_MIGRATION_OPERATIONS = Object.freeze(["migrate", "regenerate", "finalize", "none"]);
export const ORGANIZATION_MANIFEST_MIGRATION_OUTCOMES = Object.freeze(["planned", "written", "noop", "blocked"]);
export const ORGANIZATION_MANIFEST_MIGRATION_CANONICAL_BRANCHES = Object.freeze(["main", "master"]);

const managedPaths = Object.freeze([
  ORGANIZATION_DOCUMENT_PATHS.canonical,
  ORGANIZATION_DOCUMENT_PATHS.legacy_projection,
]);

/**
 * Pure planner. Input is the raw document set of one Organization root as the
 * single Core filesystem adapter returns it; output is the deterministic plan:
 * resolver state before and after, the exact documents to write or remove,
 * parity evidence and fail-closed blockers. No filesystem, no Git.
 *
 * `activationFormats` is the reader contract `--finalize` is gated on. It
 * defaults to the shipped Core gate; the CLI never sets it — only tests inject
 * a future cohort to prove the gate opens exactly with the readers.
 */
export function planOrganizationManifestMigration({
  documents,
  finalize = false,
  activationFormats = ORGANIZATION_ACTIVATABLE_MANIFEST_FORMATS,
}) {
  const before = resolveOrganizationRootDocuments(documents);
  const plan = {
    operation: "none",
    outcome: "blocked",
    before: resolutionSummary(before),
    after: null,
    parity: { semantic: null, projection: null },
    schema_validation: { canonical: [], legacy_projection: [] },
    modules_reconciliation: null,
    documents: [],
    blockers: [],
    next_step: null,
  };
  const block = (code, message) => {
    plan.blockers.push({ code, message });
    return plan;
  };
  if (before.state === "missing") {
    return block("organization_root_missing", "Kořen není Lazurio Organization: chybí lazurio.organization.json i company.gen3.json.");
  }
  if (before.state === "conflict" && !documents.canonicalManifest) {
    return block("organization_manifest_conflict", `Organization dokumenty nejde bezpečně vyřešit (${before.issues.join(", ") || "conflict"}).`);
  }
  const kind = before.resource?.kind ?? before.recovery_identity?.kind ?? null;
  if (kind === "template") {
    return block("template_kind_not_migratable", "Template root (kind: template) se tímto příkazem nemigruje; template dostává vlastní explicitní plán.");
  }

  if (finalize) return planFinalize({ plan, before, documents, block, activationFormats });

  if (before.state === "legacy") {
    plan.operation = "migrate";
    const derived = deriveCanonicalOrganizationManifest(documents);
    plan.modules_reconciliation = derived.modulesReconciliation;
    if (derived.canonicalManifest === null) {
      return block(
        derived.issues.includes("lossy_mapping") ? "lossy_mapping" : "canonical_derivation_blocked",
        `Canonical manifest nejde odvodit beze ztráty (${derived.issues.join(", ")}).`,
      );
    }
    stagePair({ plan, before, documents, canonicalManifest: derived.canonicalManifest, block });
    if (derived.modulesReconciliation.issues.length > 0) {
      plan.outcome = "blocked";
      plan.next_step = null;
      plan.blockers.push({
        code: "legacy_modules_unreconciled",
        message: "Legacy company.gen3.json#modules[] není sladěné s modules.manifest.json "
          + `(${derived.modulesReconciliation.issues.join(", ")}); nejdřív slaď modules.manifest.json v PR Organizace.`,
      });
    }
    return plan;
  }
  if (before.state === "transition") {
    plan.operation = "none";
    plan.outcome = "noop";
    plan.after = plan.before;
    plan.parity = { semantic: true, projection: true };
    plan.next_step = `${ORGANIZATION_MANIFEST_MIGRATION_COMMAND} <root> --finalize`;
    return plan;
  }
  if (before.state === "current") {
    plan.operation = "none";
    plan.outcome = "noop";
    plan.after = plan.before;
    plan.parity = { semantic: true, projection: true };
    return plan;
  }
  // projection_drift, or conflict with a canonical document present: the
  // canonical manifest is the only authority, so regeneration recomputes its
  // declared hash and rewrites the legacy projection from it.
  plan.operation = "regenerate";
  const canonicalManifest = structuredClone(documents.canonicalManifest);
  if (!isRecord(canonicalManifest) || !isRecord(canonicalManifest.compatibility?.legacy_projection)) {
    return block("canonical_manifest_invalid", `Canonical manifest nejde použít jako autoritu (${before.issues.join(", ") || before.state}).`);
  }
  try {
    canonicalManifest.compatibility.legacy_projection.sha256 = organizationLegacyProjectionHash(canonicalManifest, documents.modulesManifest);
  } catch {
    return block("canonical_manifest_invalid", `Canonical manifest nejde promítnout (${before.issues.join(", ") || before.state}).`);
  }
  return stagePair({ plan, before, documents, canonicalManifest, block });
}

function planFinalize({ plan, before, documents, block, activationFormats }) {
  plan.operation = "finalize";
  if (before.state === "current") {
    plan.outcome = "noop";
    plan.after = plan.before;
    plan.parity = { semantic: true, projection: true };
    return plan;
  }
  if (before.state !== "transition") {
    return block("finalize_requires_transition", `Finalizace vyžaduje stav transition s paritou; aktuální stav je ${before.state}.`);
  }
  const after = resolveOrganizationRootDocuments({
    canonicalManifest: documents.canonicalManifest,
    companyManifest: null,
    modulesManifest: documents.modulesManifest,
  });
  plan.after = resolutionSummary(after);
  plan.parity = { semantic: after.semantic_hash === before.semantic_hash, projection: true };
  plan.documents = [{ path: ORGANIZATION_DOCUMENT_PATHS.legacy_projection, action: "remove", content: null }];
  if (after.state !== "current" || !plan.parity.semantic) {
    return block("finalize_readback_invalid", `Canonical manifest sám o sobě neresolvuje jako current (${after.issues.join(", ") || after.state}).`);
  }
  // Finalization may only produce a root the same cohort's readers accept.
  // Offline it has no live GitHub facts, so it requires the structural half of
  // the shared Core identity proof: a complete verified forge binding in the
  // canonical manifest. Activation/install then match it against live IDs.
  if (!isOrganizationForgeIdentityVerified(after.resource)) {
    return block(
      "finalize_binding_unverified",
      "Canonical manifest nenese verified forge binding (binding_state: verified s organization_id a repository_id); "
        + "canonical-only root by žádný reader neaktivoval. Legacy projekce zůstává povinná.",
    );
  }
  if (!isOrganizationRootSupported(after, { activationFormats })) {
    plan.outcome = "blocked";
    plan.blockers.push({
      code: "finalize_reader_gate_closed",
      message: "Reader/update gate ještě nepřijímá stav current: podporované Machines aktivují pouze "
        + `${activationFormats.join(", ")}. Legacy projekce zůstává povinná (decision 0145).`,
    });
    return plan;
  }
  plan.outcome = "planned";
  return plan;
}

function stagePair({ plan, before, documents, canonicalManifest, block }) {
  let projection;
  try {
    projection = projectLegacyOrganizationManifest(canonicalManifest, documents.modulesManifest);
  } catch (error) {
    return block("canonical_manifest_invalid", `Canonical manifest nejde promítnout: ${error.message}`);
  }
  const after = resolveOrganizationRootDocuments({
    canonicalManifest,
    companyManifest: projection,
    modulesManifest: documents.modulesManifest,
  });
  plan.after = resolutionSummary(after);
  plan.parity = {
    semantic: before.semantic_hash === null ? null : after.semantic_hash === before.semantic_hash,
    projection: after.state === "transition",
  };
  plan.schema_validation = {
    canonical: validateAgainstSchema(canonicalManifest, canonicalSchema, "lazurio.organization.json"),
    legacy_projection: validateAgainstSchema(projection, legacySchema, "company.gen3.json"),
  };
  plan.documents = [
    { path: ORGANIZATION_DOCUMENT_PATHS.canonical, action: "write", content: json(canonicalManifest) },
    { path: ORGANIZATION_DOCUMENT_PATHS.legacy_projection, action: "write", content: json(projection) },
  ];
  if (after.state !== "transition" || after.issues.length > 0) {
    return block("staged_pair_invalid", `Připravená dvojice neresolvuje jako transition (${after.state}: ${after.issues.join(", ") || "none"}).`);
  }
  if (plan.parity.semantic === false) {
    return block("lossy_mapping", "Normalizovaná sémantika po migraci neodpovídá legacy vstupu.");
  }
  if (plan.schema_validation.canonical.length > 0 || plan.schema_validation.legacy_projection.length > 0) {
    return block("schema_validation_failed", "Připravené dokumenty neprošly schema validací.");
  }
  plan.outcome = "planned";
  plan.next_step = `${ORGANIZATION_MANIFEST_MIGRATION_COMMAND} <root> --write`;
  return plan;
}

/**
 * CLI adapter: reads one Organization root through the single Core filesystem
 * adapter, plans, evaluates the Git/worktree gate and — only with `write` —
 * replaces each managed file atomically on its own path, then reads the result
 * back through the same resolver. It never commits, pushes or touches a Forge.
 */
export async function runOrganizationManifestMigration({
  organizationRoot,
  write = false,
  finalize = false,
  activationFormats = ORGANIZATION_ACTIVATABLE_MANIFEST_FORMATS,
  runGit = defaultRunGit,
}) {
  const root = resolve(organizationRoot);
  const documents = readOrganizationRootDocuments({ organizationRoot: root });
  const plan = planOrganizationManifestMigration({ documents, finalize, activationFormats });
  const git = observeGitGate({ root, runGit });
  const changes = plan.documents.map((document) => describeChange(root, document));
  const report = {
    schema_version: ORGANIZATION_MANIFEST_MIGRATION_REPORT_SCHEMA,
    tool: {
      command: ORGANIZATION_MANIFEST_MIGRATION_COMMAND,
      package_version: packageManifest.version,
      resolver_contract: ORGANIZATION_ROOT_RESOLUTION_VERSION,
    },
    mode: write ? "write" : "plan",
    root,
    operation: plan.operation,
    outcome: plan.outcome,
    ok: false,
    before: plan.before,
    after: plan.after,
    parity: plan.parity,
    schema_validation: plan.schema_validation,
    modules_reconciliation: plan.modules_reconciliation,
    changes: changes.map(({ content, ...change }) => change),
    git,
    blockers: [...plan.blockers],
    readback: null,
    next_step: plan.next_step,
  };
  if (plan.outcome === "blocked") return finish(report);
  if (plan.outcome === "noop") {
    report.ok = true;
    return finish(report);
  }
  if (!write) {
    report.ok = true;
    return finish(report);
  }
  if (git.status !== "ready") {
    report.outcome = "blocked";
    report.blockers.push({ code: `git_${git.reason}`, message: git.message });
    return finish(report);
  }
  // Targets are the two fixed filenames directly under the root; the Core
  // reader already refused a symlinked root or document (conflict → blocked),
  // so no further path containment check is needed here.
  try {
    for (const change of changes) {
      const target = join(root, change.path);
      if (change.action === "unchanged") continue;
      if (change.action === "remove") {
        await unlink(target);
        continue;
      }
      await replaceFileAtomically(target, change.content);
    }
  } catch (error) {
    report.outcome = "blocked";
    report.blockers.push({
      code: "write_interrupted",
      message: `Zápis se přerušil (${error.message}); stav je viditelný v git status a tentýž příkaz jej deterministicky dokončí.`,
    });
    report.readback = resolutionSummary(readOrganizationRoot({ organizationRoot: root }));
    return finish(report);
  }
  const readback = readOrganizationRoot({ organizationRoot: root });
  report.readback = resolutionSummary(readback);
  if (readback.state !== plan.after.state || readback.semantic_hash !== plan.after.semantic_hash) {
    report.outcome = "blocked";
    report.blockers.push({ code: "readback_mismatch", message: `Soubory po zápisu resolvují jako ${readback.state}, očekáváno ${plan.after.state}.` });
    return finish(report);
  }
  report.outcome = "written";
  report.ok = true;
  report.next_step = plan.operation === "finalize"
    ? null
    : "git diff · commit v task worktree · PR pro reviewer Organizace";
  return finish(report);
}

export function organizationManifestMigrationExitCode(report) {
  return report?.ok === true ? 0 : 1;
}

export function renderHumanOrganizationManifestMigration(report) {
  const lines = [
    `Lazurio Organization manifest migration: ${report.outcome} (${report.mode}, ${report.operation})`,
    `Root: ${report.root}`,
    `Před: ${describeResolution(report.before)}`,
  ];
  if (report.after) lines.push(`Po: ${describeResolution(report.after)}`);
  lines.push(`Parita: sémantická ${flag(report.parity.semantic)} · projekce ${flag(report.parity.projection)}`);
  if (report.modules_reconciliation) {
    const reconciliation = report.modules_reconciliation;
    lines.push(`Legacy modules[]: ${reconciliation.legacy_entries} položek · ${reconciliation.reconciled} sladěno s modules.manifest.json`);
    for (const path of reconciliation.unreconciled) lines.push(`! ${path}: není deklarovaný slot v modules.manifest.json`);
    for (const conflict of reconciliation.field_conflicts) {
      lines.push(`! ${conflict.path}: pole ${conflict.fields.join(", ")} se liší od modules.manifest.json slotu — nejdřív slaď modules.manifest.json`);
    }
  }
  for (const change of report.changes) {
    const symbol = change.action === "unchanged" ? "·" : change.action === "remove" ? "−" : "✓";
    lines.push(`${symbol} ${change.path}: ${change.action}${change.after_sha256 ? ` → ${change.after_sha256.slice(0, 19)}` : ""}`);
  }
  lines.push(`Git: ${report.git.status}${report.git.branch ? ` · branch ${report.git.branch}` : ""}${report.git.linked_worktree === true ? " · linked worktree" : report.git.linked_worktree === false ? " · primary checkout" : ""}`);
  if (report.git.message && report.git.status !== "ready") lines.push(`  ${report.git.message}`);
  for (const path of report.git.dirty_paths ?? []) lines.push(`  dirty: ${path}`);
  for (const blocker of report.blockers) lines.push(`! ${blocker.code}: ${blocker.message}`);
  for (const failure of [...report.schema_validation.canonical, ...report.schema_validation.legacy_projection]) lines.push(`! schema: ${failure}`);
  if (report.readback) lines.push(`Readback: ${describeResolution(report.readback)}`);
  if (report.next_step) lines.push(`Další krok: ${report.next_step}`);
  return lines.join("\n");
}

function observeGitGate({ root, runGit }) {
  const gate = {
    status: "blocked",
    reason: null,
    message: null,
    checkout_root: null,
    branch: null,
    linked_worktree: null,
    dirty_paths: [],
  };
  const blocked = (reason, message) => ({ ...gate, reason, message });
  const executable = resolveGitExecutableOnPath();
  if (!executable) return blocked("unavailable", "Git není dostupný v PATH.");
  const git = (...args) => runGit(executable, ["-C", root, ...args]);
  const prefix = git("rev-parse", "--show-prefix");
  if (prefix.status !== 0) return blocked("not_a_repository", "Organization root není Git checkout.");
  if (prefix.stdout.trim() !== "") return blocked("not_checkout_root", "Organization root musí být kořen Git checkoutu.");
  let gitDir;
  let commonDir;
  let actualRoot;
  try {
    actualRoot = realpathSync(root);
    gitDir = realpathSync(git("rev-parse", "--absolute-git-dir").stdout.trim());
    commonDir = realpathSync(git("rev-parse", "--path-format=absolute", "--git-common-dir").stdout.trim());
  } catch {
    return blocked("unobservable", "Git metadata checkoutu nejde přečíst.");
  }
  gate.checkout_root = actualRoot;
  gate.linked_worktree = gitDir !== commonDir;
  const branch = git("symbolic-ref", "--short", "HEAD");
  gate.branch = branch.status === 0 ? branch.stdout.trim() : null;
  const status = git("status", "--porcelain=v1", "--untracked-files=all", "-z");
  if (status.status !== 0) return { ...gate, reason: "unobservable", message: "git status selhal." };
  gate.dirty_paths = status.stdout
    .split("\0")
    .filter(Boolean)
    .map((entry) => entry.slice(3))
    .sort();
  if (!gate.linked_worktree) {
    return { ...gate, reason: "primary_checkout", message: "Zápis je dovolený jen v linked task worktree; primární checkout se nemění." };
  }
  if (gate.branch === null) {
    return { ...gate, reason: "detached_head", message: "Worktree je v detached HEAD; přepni na task branch." };
  }
  if (ORGANIZATION_MANIFEST_MIGRATION_CANONICAL_BRANCHES.includes(gate.branch)) {
    return { ...gate, reason: "canonical_branch", message: `Branch ${gate.branch} je kanonická; migrace patří na task branch a do PR.` };
  }
  const foreignDirty = gate.dirty_paths.filter((path) => !managedPaths.includes(path));
  if (foreignDirty.length > 0) {
    return { ...gate, reason: "dirty_worktree", message: `Worktree má necommitnuté změny mimo Organization manifesty: ${foreignDirty.join(", ")}.` };
  }
  return { ...gate, status: "ready" };
}

function defaultRunGit(executable, args) {
  const result = spawnSync(executable, args, { encoding: "utf8", timeout: 10_000, maxBuffer: 4 * 1024 * 1024, shell: false });
  return { status: result.status ?? 1, stdout: String(result.stdout ?? ""), stderr: String(result.stderr ?? "") };
}

function describeChange(root, document) {
  const existing = readExistingBytes(join(root, document.path));
  const before = existing === null ? null : sha256(existing);
  if (document.action === "remove") {
    return { path: document.path, action: existing === null ? "unchanged" : "remove", before_sha256: before, after_sha256: null, content: null };
  }
  const after = sha256(document.content);
  return {
    path: document.path,
    action: existing === null ? "create" : before === after ? "unchanged" : "replace",
    before_sha256: before,
    after_sha256: after,
    content: document.content,
  };
}

function readExistingBytes(path) {
  try {
    return readFileSync(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function replaceFileAtomically(target, content) {
  const temporary = `${target}.${process.pid}-${Date.now().toString(36)}.tmp`;
  try {
    await writeFile(temporary, content, { encoding: "utf8", flag: "wx" });
    await rename(temporary, target);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

function resolutionSummary(resolution) {
  return {
    state: resolution.state,
    declaration_source: resolution.declaration_source,
    semantic_hash: resolution.semantic_hash,
    projection: resolution.projection,
    issues: [...resolution.issues],
    warnings: [...(resolution.warnings ?? [])],
  };
}

function describeResolution(summary) {
  const hash = summary.semantic_hash ? ` · semantic ${summary.semantic_hash.slice(0, 19)}` : "";
  const issues = summary.issues.length > 0 ? ` · issues ${summary.issues.join(", ")}` : "";
  return `${summary.state}${hash}${issues}`;
}

function finish(report) {
  return report;
}

function flag(value) {
  return value === null ? "n/a" : value ? "ok" : "NE";
}

function sha256(content) {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

function json(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
