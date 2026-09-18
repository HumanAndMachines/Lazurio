# Organization manifest migration (DEV-6512, decision 0145)

**Purpose.** Move one Organization root from the deprecated
`company.gen3.json` (`legacy`) to the canonical `lazurio.organization.json`
with a generated legacy projection (`transition`), and regenerate that
projection when it drifts. This folder exists only to carry the old direction
into the new one; it is not part of the forward-direction runtime.

**Scope.** `legacy → transition` and projection regeneration only.
Finalization (`transition → current`, removing `company.gen3.json`) is **not
implemented**. Opening `current` requires a separately accepted
reader-readiness mechanism that proves trusted identity continuity live
(decision 0145): an offline tool can only restate what a manifest asserts about
itself. Until then every Organization stays in `transition` with the generated
projection.

**Rule (root `AGENTS.md`).** Migration code lives in a dedicated migrations
folder and is deleted when the migration completes. It is never mixed into
current-direction modules: Lazurio Core keeps only the resolver and the
deterministic legacy projection it already owns, the CLI is a thin dispatch
into this folder, and Doctor/compiler only reference the command or read the
canonical file.

**Removal condition.** Delete this folder, its CLI dispatch in
`lazurio/cli.mjs`, the `lazurio:test` entries and the manual section once every
Organization root is `current` (no `company.gen3.json` anywhere). Reaching
`current` is the job of the separate finalization-readiness work, not of this
folder.

**Distribution.** The folder ships with the source checkout and the
package-managed `lazurio` (`lazurio/package.json#files`). Resident artifacts
built by `distribution/build.mjs` do not carry it: the CLI loads the folder
lazily and `lazurio migrate organization-manifest` reports the absence with
exit code 2 there. Migration is an operator task on a source checkout in a
plan-owned worktree, never a hosted runtime feature.

## Entry points

| File | Role |
| --- | --- |
| `derive-canonical-manifest.mjs` | Pure inverse of Core `projectLegacyOrganizationManifest`: legacy document set → canonical manifest, lossless-mapping proof through the resolver's semantic hash, and the `company.gen3.json#modules[]` reconciliation against `modules.manifest.json`. |
| `organization-manifest-migration.mjs` | Pure planner (`planOrganizationManifestMigration`) plus the CLI adapter (`runOrganizationManifestMigration`) that owns the Git/worktree gate, the per-file atomic replacement and the resolver readback. |
| `organization-manifest-migration-report.v0.schema.json` | Public JSON shape of `--json` output. |
| `fixtures/` | Anonymized fixture shaped like a real GEN3 Organization root (verified Forge binding, Team bindings, root slots, productionspace, legacy `modules[]`). |

Command surface (see `manual/lazurio-manifest-family.md`):

```sh
lazurio migrate organization-manifest <organization-root>                   # plan only
lazurio migrate organization-manifest <organization-root> --write           # legacy → transition, or regenerate the projection
lazurio migrate organization-manifest <organization-root> --finalize        # not implemented: refused with finalize_not_implemented
```

## Invariants the code enforces

- Core is the only authority on state and parity: the plan is accepted only
  when the staged pair resolves to `transition` with `issues: []` and the same
  semantic hash as the legacy input (`lossy_mapping` otherwise).
- The deprecated `company.gen3.json#modules[]` is never copied. Every entry
  must be a declared `modules.manifest.json` slot projecting identically;
  otherwise the plan is `blocked` with `legacy_modules_unreconciled` and the
  operator aligns `modules.manifest.json` first.
- `--write` only in a linked task worktree on a non-canonical branch whose
  only dirty paths are the two managed manifests. Primary checkouts, `main`,
  detached HEAD and foreign dirty files are refused. Nothing is committed,
  pushed or sent to a Forge.
- Each file is replaced atomically on its own path (canonical first). An
  interruption leaves a visible fail-closed Git state; rerunning the same
  command regenerates deterministically. No hidden transaction state.
- `--finalize` is refused before anything is planned: `blocked` with
  `finalize_not_implemented`, exit 1, with or without `--write`. This tool
  never removes `company.gen3.json`.
- Template roots (`kind: template`) are refused; they migrate in their own
  explicit plan.
