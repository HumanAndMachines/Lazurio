import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { validateAgainstSchema } from "../../runtime/json-schema-mini.mjs";
import reportSchema from "./organization-manifest-migration-report.v0.schema.json";
import { readOrganizationRoot } from "../../core/organization-root-reader-lib.mjs";
import { ORGANIZATION_ACTIVATABLE_MANIFEST_FORMATS } from "../../core/organization-activation-lib.mjs";
import { resolveGitExecutableOnPath } from "../../core/toolchain-lib.mjs";
import {
  organizationManifestMigrationExitCode,
  planOrganizationManifestMigration,
  renderHumanOrganizationManifestMigration,
  runOrganizationManifestMigration,
} from "./organization-manifest-migration.mjs";

const fixtureRoot = join(import.meta.dirname, "fixtures", "gen3-organization");
const gitExecutable = resolveGitExecutableOnPath();
const temporaryRoots = [];
afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("dry-run plans legacy → transition without touching the filesystem", async () => {
  const { primary } = organizationRepository();
  const before = snapshot(primary);
  const report = await runOrganizationManifestMigration({ organizationRoot: primary });

  expect(validateAgainstSchema(report, reportSchema, "report")).toEqual([]);
  expect(report).toMatchObject({
    mode: "plan",
    operation: "migrate",
    outcome: "planned",
    ok: true,
    before: { state: "legacy" },
    after: { state: "transition", issues: [] },
    parity: { semantic: true, projection: true },
    schema_validation: { canonical: [], legacy_projection: [] },
    modules_reconciliation: { legacy_entries: 4, reconciled: 4 },
    changes: [
      { path: "lazurio.organization.json", action: "create", before_sha256: null },
      { path: "company.gen3.json", action: "replace" },
    ],
    git: { status: "blocked", reason: "primary_checkout", linked_worktree: false, branch: "main" },
    blockers: [],
  });
  expect(report.after.semantic_hash).toBe(report.before.semantic_hash);
  expect(snapshot(primary)).toEqual(before);
  expect(organizationManifestMigrationExitCode(report)).toBe(0);
  expect(renderHumanOrganizationManifestMigration(report)).toContain("Po: transition");
});

test("write refuses a primary checkout, a canonical branch and foreign dirty files", async () => {
  const { primary, worktree } = organizationRepository();
  const before = snapshot(primary);

  const onPrimary = await runOrganizationManifestMigration({ organizationRoot: primary, write: true });
  expect(onPrimary).toMatchObject({ outcome: "blocked", ok: false, blockers: [{ code: "git_primary_checkout" }] });
  expect(snapshot(primary)).toEqual(before);

  git(worktree, ["checkout", "--quiet", "-b", "main-shadow"]);
  git(worktree, ["checkout", "--quiet", "master"]);
  const onCanonical = await runOrganizationManifestMigration({ organizationRoot: worktree, write: true });
  expect(onCanonical).toMatchObject({ outcome: "blocked", blockers: [{ code: "git_canonical_branch" }] });
  git(worktree, ["checkout", "--quiet", "agent/migrate"]);

  writeFileSync(join(worktree, "notes.txt"), "scratch\n");
  const dirty = await runOrganizationManifestMigration({ organizationRoot: worktree, write: true });
  expect(dirty).toMatchObject({ outcome: "blocked", blockers: [{ code: "git_dirty_worktree" }], git: { dirty_paths: ["notes.txt"] } });
  expect(snapshot(worktree)).toEqual(before);
  expect(organizationManifestMigrationExitCode(dirty)).toBe(1);
});

test("write migrates a clean task worktree to transition, reads it back and is idempotent", async () => {
  const { worktree } = organizationRepository();
  const written = await runOrganizationManifestMigration({ organizationRoot: worktree, write: true });

  expect(validateAgainstSchema(written, reportSchema, "report")).toEqual([]);
  expect(written).toMatchObject({
    mode: "write",
    operation: "migrate",
    outcome: "written",
    ok: true,
    git: { status: "ready", linked_worktree: true, branch: "agent/migrate" },
    readback: { state: "transition", issues: [] },
    blockers: [],
  });
  const resolution = readOrganizationRoot({ organizationRoot: worktree });
  expect(resolution).toMatchObject({ state: "transition", resource_count: 1, issues: [] });
  expect(resolution.semantic_hash).toBe(written.before.semantic_hash);
  expect(readFileSync(join(worktree, "lazurio.organization.json"), "utf8").endsWith("\n")).toBe(true);
  const status = git(worktree, ["status", "--porcelain=v1", "--untracked-files=all"]).split("\n").filter(Boolean).sort();
  expect(status).toEqual([" M company.gen3.json", "?? lazurio.organization.json"]);

  const again = await runOrganizationManifestMigration({ organizationRoot: worktree, write: true });
  expect(again).toMatchObject({ operation: "none", outcome: "noop", ok: true, before: { state: "transition" } });
  expect(again.next_step).toContain("--finalize");
});

test("an interrupted write is a visible drift state and the same command regenerates it", async () => {
  const { worktree } = organizationRepository();
  const plan = await runOrganizationManifestMigration({ organizationRoot: worktree });
  expect(plan.outcome).toBe("planned");
  // Simulate the interruption between the two replacements: only the
  // canonical manifest landed, the stale legacy document is still on disk.
  const canonicalText = readFileSync(join(fixtureRoot, "company.gen3.json"), "utf8");
  const derived = planOrganizationManifestMigration({
    documents: {
      companyManifest: JSON.parse(canonicalText),
      modulesManifest: JSON.parse(readFileSync(join(fixtureRoot, "modules.manifest.json"), "utf8")),
      canonicalManifest: null,
      documentIssues: [],
    },
  });
  writeFileSync(join(worktree, "lazurio.organization.json"), derived.documents[0].content);
  expect(readOrganizationRoot({ organizationRoot: worktree }).state).toBe("projection_drift");

  const drift = await runOrganizationManifestMigration({ organizationRoot: worktree });
  expect(drift).toMatchObject({ operation: "regenerate", outcome: "planned", before: { state: "projection_drift" }, after: { state: "transition" } });
  expect(drift.changes).toEqual([
    expect.objectContaining({ path: "lazurio.organization.json", action: "unchanged" }),
    expect.objectContaining({ path: "company.gen3.json", action: "replace" }),
  ]);
  const repaired = await runOrganizationManifestMigration({ organizationRoot: worktree, write: true });
  expect(repaired).toMatchObject({ operation: "regenerate", outcome: "written", readback: { state: "transition" } });
});

test("editing the canonical manifest makes the legacy projection stale until regenerated from canonical", async () => {
  const { worktree } = organizationRepository();
  await runOrganizationManifestMigration({ organizationRoot: worktree, write: true });
  const canonicalPath = join(worktree, "lazurio.organization.json");
  const canonical = JSON.parse(readFileSync(canonicalPath, "utf8"));
  canonical.teams.push({ slug: "sales", display_name: "Sales", default: false });
  writeFileSync(canonicalPath, `${JSON.stringify(canonical, null, 2)}\n`);
  expect(readOrganizationRoot({ organizationRoot: worktree }).state).toBe("conflict");

  const regenerated = await runOrganizationManifestMigration({ organizationRoot: worktree, write: true });
  expect(regenerated).toMatchObject({ operation: "regenerate", outcome: "written", readback: { state: "transition" } });
  const projection = JSON.parse(readFileSync(join(worktree, "company.gen3.json"), "utf8"));
  expect(projection.teams.map((team) => team.slug)).toEqual(["delivery", "platform", "sales"]);
  expect(JSON.parse(readFileSync(canonicalPath, "utf8")).compatibility.legacy_projection.sha256)
    .toBe(readOrganizationRoot({ organizationRoot: worktree }).projection.declared_hash);
});

test("finalize plans transition → current but stays blocked by the reader gate", async () => {
  const { worktree } = organizationRepository();
  await runOrganizationManifestMigration({ organizationRoot: worktree, write: true });
  const before = snapshot(worktree);
  const finalize = await runOrganizationManifestMigration({ organizationRoot: worktree, finalize: true, write: true });

  expect(ORGANIZATION_ACTIVATABLE_MANIFEST_FORMATS).not.toContain("current");
  expect(finalize).toMatchObject({
    operation: "finalize",
    outcome: "blocked",
    ok: false,
    after: { state: "current" },
    parity: { semantic: true },
    changes: [{ path: "company.gen3.json", action: "remove" }],
    blockers: [{ code: "finalize_reader_gate_closed" }],
  });
  expect(snapshot(worktree)).toEqual(before);

  const legacyOnly = organizationRepository();
  expect(await runOrganizationManifestMigration({ organizationRoot: legacyOnly.worktree, finalize: true })).toMatchObject({
    operation: "finalize",
    outcome: "blocked",
    blockers: [{ code: "finalize_requires_transition" }],
  });
});

test("template kind, missing roots and unreconciled legacy modules fail closed", async () => {
  const template = organizationRepository({ mutate: (company) => { company.organization_kind = "template"; } });
  expect(await runOrganizationManifestMigration({ organizationRoot: template.worktree, write: true })).toMatchObject({
    outcome: "blocked",
    blockers: [{ code: "template_kind_not_migratable" }],
  });

  const empty = mkdtempSync(join(tmpdir(), "lazurio-migrate-empty-"));
  temporaryRoots.push(empty);
  expect(await runOrganizationManifestMigration({ organizationRoot: empty })).toMatchObject({
    outcome: "blocked",
    before: { state: "missing" },
    blockers: [{ code: "organization_root_missing" }],
  });

  const unreconciled = organizationRepository({ mutate: (company) => { company.modules[0].notes = "only here"; } });
  const report = await runOrganizationManifestMigration({ organizationRoot: unreconciled.worktree, write: true });
  expect(report).toMatchObject({
    outcome: "blocked",
    after: { state: "transition" },
    parity: { semantic: true, projection: true },
    modules_reconciliation: { field_conflicts: [{ path: "workspace/knowledgebase", fields: ["notes"] }] },
    blockers: [{ code: "legacy_modules_unreconciled" }],
  });
  expect(readOrganizationRoot({ organizationRoot: unreconciled.worktree }).state).toBe("legacy");

  const malformed = organizationRepository();
  writeFileSync(join(malformed.worktree, "company.gen3.json"), "{ not json");
  expect(await runOrganizationManifestMigration({ organizationRoot: malformed.worktree, write: true })).toMatchObject({
    outcome: "blocked",
    before: { state: "conflict", issues: expect.arrayContaining(["legacy_projection_unreadable"]) },
    blockers: [{ code: "organization_manifest_conflict" }],
  });
});

function organizationRepository({ mutate = null } = {}) {
  const base = mkdtempSync(join(tmpdir(), "lazurio-migrate-"));
  temporaryRoots.push(base);
  const primary = join(base, "Example-ai_GEN3");
  cpSync(fixtureRoot, primary, { recursive: true });
  if (mutate) {
    const path = join(primary, "company.gen3.json");
    const company = JSON.parse(readFileSync(path, "utf8"));
    mutate(company);
    writeFileSync(path, `${JSON.stringify(company, null, 2)}\n`);
  }
  git(primary, ["init", "--quiet", "--initial-branch=main"]);
  git(primary, ["add", "."]);
  git(primary, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "fixture"]);
  git(primary, ["branch", "--quiet", "master"]);
  const worktree = join(primary, ".worktrees", "root", "DEV-0000-migrate");
  git(primary, ["worktree", "add", "--quiet", "-b", "agent/migrate", worktree, "main"]);
  return { primary, worktree };
}

function git(cwd, args) {
  const result = spawnSync(gitExecutable, ["-C", cwd, ...args], {
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", HOME: cwd },
  });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return String(result.stdout ?? "");
}

function snapshot(root) {
  const read = (name) => {
    try {
      return readFileSync(join(root, name), "utf8");
    } catch {
      return null;
    }
  };
  return {
    canonical: read("lazurio.organization.json"),
    legacy: read("company.gen3.json"),
    modules: read("modules.manifest.json"),
  };
}
