# Organization compiler

The active Lazurio source owns generation of the four existing Organization
`generated/` projections. Run with the Bun version in `lazurio/package.json`:

```sh
bun <Lazurio-source>/lazurio/organization-compiler/compile-company.mjs --organization <Organization-checkout> --dry-run
bun <Lazurio-source>/lazurio/organization-compiler/compile-company.mjs --organization <Organization-review-worktree> --write
```

From the Lazurio source root, `bun run organization:compile -- --organization
<path> --dry-run` is equivalent. `--report <path>` writes an explicit local JSON
report; reports contain Organization data and must stay within that owner's
access boundary. The compiler never fetches, pushes, merges, installs, starts an
App, or publishes repository-db data. A primary checkout supports dry-run only.
Write requires a linked review worktree on a non-canonical branch. Run dry-run
again after writing; unchanged inputs must produce zero changes.

## Authority and migration

The pure generator and semantic/schema contracts were forward-ported from the
historical compiler at `Rozjedeme-ai/HumanAndMachines`, commit
`58c0aaa3ae81a7e202b56ee71bec473a9bc877b5`. That repository remains read-only;
its compatibility bundle is not a runtime dependency. Consumer instructions
must use this command instead of `packages/organization-compiler` in that
historical checkout. No change to an Organization's declarations or generated
files occurs until its owner explicitly runs the command in its review worktree.

The input remains the Organization's `company.gen3.json` and
`modules.manifest.json`. When `lazurio.organization.json` exists, the active
Organization root reader must accept the canonical/projection relationship.
The compiler cannot silently generate from a conflicting legacy projection.
Generated projections do not become a second registration authority.

Child `workspace/<module>/db` declarations use the active
`core/organization-slot-scope-lib.mjs` path and repository identity contracts,
require an active declared parent, and retain `repository-db:<version>` and the
declared data branch. Organization data and examples are never copied into the
public source: tests construct synthetic fixtures locally.

## Design choice and limits

Keeping the old compiler unchanged cannot compile current child DB declarations
on the supported Bun. Copying its compatibility runtime would introduce a second
toolchain/distribution authority. The selected cut retains pure generation and
existing validation, uses Lazurio's existing schema validator and path boundaries,
and adds a local Git checkout observation adapter using the active PATH resolver.
This is smaller than migrating the template publisher and its runtime bootstrap.

The adapter checks local and effective Git routing, the exact target checkout,
and its primary repository identity. It does not connect to GitHub, attest grants,
verify SSH endpoint custody, or resolve immutable template repository IDs. A
template publisher cannot use name-only local observation to authorize template
writes; that supply-chain operation remains outside this compiler's write lane.
Caller-supplied observations and schemas are diagnostic-only, never write authority.

Invalid paths, escaping symlinks/junctions, ownership ambiguity, changed repository
identity or unsafe Git routing fail before generation writes. This is a local
operation inside the Principal's Machine boundary, not isolation against another
hostile process owned by that same Principal. Interrupted multi-file writes can
leave partial derived output; rerun the deterministic compiler in the same review
worktree and inspect the complete diff before commit. Rollback is an ordinary PR
revert; no persistent state or data migration is introduced.

`bun run organization:compiler:test` covers schema/semantic regressions, real
primary and linked review checkout behavior, deterministic second writes, child
DB identity/parent validation, caller bypass attempts, routing and filesystem
escapes. The suite is part of `bun run check`.
