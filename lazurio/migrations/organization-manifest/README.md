# Organization manifest migration (DEV-6512, decision 0145)

**Purpose.** Move one Organization root from the deprecated
`company.gen3.json` (`legacy`) to the canonical `lazurio.organization.json`
(`transition`, later `current`). This folder exists only to carry the old
direction into the new one; it is not part of the forward-direction runtime.

**Rule (root `AGENTS.md`).** Migration code lives in a dedicated migrations
folder and is deleted when the migration completes. It is never mixed into
current-direction modules: Lazurio Core keeps only the resolver and the
deterministic legacy projection it already owns, the CLI is a thin dispatch
into this folder, and Doctor/compiler only reference the command or read the
canonical file.

**Removal condition.** Delete this folder, its CLI dispatch in
`lazurio/cli.mjs`, the `lazurio:test` entries and the manual section once every
Organization root is `current` (no `company.gen3.json` anywhere) and the
finalization gate has been passed for the whole supported Machine cohort.

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
lazurio migrate organization-manifest <organization-root> --finalize        # plan transition → current
lazurio migrate organization-manifest <organization-root> --finalize --write
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
- `--finalize` never produces a root its own reader cohort would refuse. It
  consumes the shared Core contract and owns no state list of its own:
  `isOrganizationForgeIdentityVerified` — the canonical manifest must carry a
  complete verified forge binding (`binding_state: "verified"` with
  `organization_id` and `repository_id`), otherwise `finalize_binding_unverified`
  in every cohort — and `isOrganizationRootSupported`, otherwise
  `finalize_reader_gate_closed`. Activation, install, update and the local
  mutation-safety checks apply the same predicates (activation/install against
  live GitHub IDs, update against the installed verified IDs). The shipped
  format list is `legacy`, `transition`; admitting `current` is a separate
  readiness decision (decision 0145), not part of this migrator. Tests exercise
  the `current` cohort by injecting `activationFormats`; the CLI cannot set it.
- Template roots (`kind: template`) are refused; they migrate in their own
  explicit plan.
