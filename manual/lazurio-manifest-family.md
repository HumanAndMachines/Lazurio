# Proposal: Lazurio manifest family

Status: **Organization contract accepted by decision amendments 0026, 0031 and
0042; Personalspace naming remains a separate proposal and rollout**
Decision owner: Lazurio maintainers
Tracking: `DEV-6488`

## Proposed target

Review and, after explicit decision-record amendments, adopt one visible
Lazurio-owned manifest family:

```text
lazurio.organization.json
lazurio.module.json
lazurio.personalspace.json
```

The filename identifies the resource. Schema versions live inside the file:

```text
lazurio.organization.v1
lazurio.module.v1
lazurio.personalspace.v1
```

`company.gen3.json` is the temporary Organization legacy compatibility
projection. The `personal.gen3.json` proposal remains unaccepted by this
Organization-only implementation slice. This contract does not rename or
remove either deployed file by itself.

## Why

- `company.gen3.json` carries the deprecated CompaniesAsCode name instead of
  identifying a Lazurio Organization root.
- `personal.gen3.json` carries historical HumanAndMachines/GEN3 and
  GitHub-specific terminology.
- `lazurio.module.json` already establishes the clearer pattern.
- A schema version should not require another repository-wide filename rename.

This is not a cosmetic rename. These files currently participate in discovery,
Doctor composition, Git inventory, update and worktree resolution. Readers must
become compatible before any repository migrates.

## Three resource contracts

| Manifest | Declares | Does not declare |
| --- | --- | --- |
| `lazurio.organization.json` | One Organization root, Organization identity, Organization-wide policy, optional root Forge binding and subordinate manifest pointers | Module runtime, provider grants or Dashboard account state |
| `lazurio.module.json` | One workspace Module, its explicit applications and module-owned local leases | Organization authority, production deployment or Forge ACL |
| `lazurio.personalspace.json` | One Principal-owned Personalspace, its privacy boundary, subordinate manifests and optional Resident bindings | Organization membership or another Principal's context |

`launchpad.gen3.json` remains Machine-root configuration. `modules.manifest.json`
remains the sole Organization repository-slot inventory and Git materialization
authority in v1. The new Organization manifest points to it; it does not add
another repository or Module list.

### Repository inventory and catalog presentation

An entry in `modules.manifest.json` declares an Organization-owned repository
slot or nested materialization target. It does not, by itself, assert that every
listed repository is a workspace Module. The target Module identity comes from
`lazurio.module.json`; root repositories, Productionspace repositories and
nested repository-db checkouts remain distinct resource kinds.

The repository-slot entry may carry Organization-owned catalog metadata that
Core normalizes for all consumers:

- `name` and `description` provide the human-facing catalog identity; an
  application-owned description remains more specific and takes precedence;
- `ui_exposure: module | diagnostics-only` controls only the everyday Launchpad
  catalog projection;
- `diagnostics-only` keeps the slot in inventory, Git materialization and Doctor
  diagnostics while excluding it from normal Module cards;
- an absent or unknown presentation value preserves the slot's existing
  Core-classified default (`module` for ordinary repository slots and
  `diagnostics-only` for slots already classified that way); only a recognized,
  reviewed value overrides that presentation default.

These fields grant no access, do not change runtime ownership and cannot turn a
non-Module repository into a Module. Lazurio Core owns their validation and
normalization; Launchpad consumes the normalized presentation instead of
parsing or defaulting these fields independently.

## `lazurio.organization.v1`

The first schema must contain or preserve:

- `schema_version: lazurio.organization.v1`;
- `kind: organization | template` — the mapping from legacy
  `organization_kind` is mandatory because `template` excludes the mount from
  runtime, worktree and publication surfaces;
- `organization.slug` and `organization.display_name`;
- an optional local-first/remote-active root repository binding containing
  `forge`, readable `locator`, `default_branch` and `binding_state`;
- `binding_state: unverified` preserves locator and branch without inventing a
  provider ID; `repository_id` appears only after live Forge readback changes
  the state to `verified`;
- `manifests.modules: modules.manifest.json`;
- `module_port_pool` as the Organization-wide interval for deterministic new
  Module lease allocation; exact ports remain owned only by each
  `lazurio.module.json`;
- current Organization-owned governance, Team, task-source and Doctor sections
  without semantic loss.

The current `humanandmachines.doctor.declaration.v1` remains unchanged during
this migration. Renaming the Doctor declaration schema is a separate decision.

During the legacy compatibility window, a declared root binding uses the
existing managed-root invariant: its GitHub owner matches the Organization
locator and its default branch is `main`. Verified Organization and repository
IDs appear as one complete pair and must satisfy the existing Forge-binding
contract; a partial verified pair cannot be represented losslessly to an old
reader and therefore fails closed. Canonical `organization.metadata` cannot
reuse legacy `company` authority-field names; such values belong in their
canonical fields or in a reviewed non-reserved extension.

An opaque cross-Forge Organization ID is deliberately deferred. It has no
current minting authority or consumer. V1 uses the existing Organization slug
and, when connected, the provider-stable repository ID. Cross-Forge identity
that survives a provider migration needs its own consumer-driven decision.

Legacy `company.gen3.json#modules` is not copied into the new manifest. The
migrator must reconcile every entry into `modules.manifest.json` or stop on a
conflict. The new contract must not preserve two module inventories.

Legacy `company.gen3.json#module_port_pool` is instead mapped without semantic
change to `lazurio.organization.v1#module_port_pool`. It is Organization
policy, not repository inventory. The migrator must prove semantic parity; it
must not create a root-wide port registry or rewrite exact Module leases.

Provider-specific data stays inside the root repository binding. Installing a
Forge integration grants connectivity; it does not by itself create a Lazurio
Organization. Exact Forge activation and remote lookup are outside this
filename decision.

Local Core, CLI and Launchpad discovery never consult Dashboard state. A future
Dashboard registry may cache a verified root lookup for remote Dashboard
operations, but it cannot become local identity, access or runtime authority.

## Ownership

Lazurio Core owns:

- candidate filename resolution and one-resource-per-mount deduplication;
- schema validation;
- legacy/current normalization into one canonical read model;
- repository-slot kind and catalog-presentation normalization, including
  `description` and `ui_exposure`;
- semantic parity and conflict detection;
- deterministic migration planning and legacy projection;
- machine-readable states, errors and migration evidence.

The authored document uses `lazurio.organization.v1`. The resolver envelope
uses `lazurio.organization.root-resolution.v1`, and its normalized resource
uses the distinct `lazurio.organization.resource.v1`; consumers must not
validate the normalized read model as if it were the authored manifest.
The envelope's optional `recovery_identity` is presentation-only metadata for
one root recovery surface. It never authorizes Organization or child actions
and is `null` whenever present documents disagree on kind, slug, or display
name.

Consumers use that Core result:

- Lazurio CLI exposes Doctor and explicit migration commands and owns their
  Git/worktree preflight plus atomic filesystem execution;
- Launchpad displays normalized catalog presentation, state and recovery
  actions but has no second parser and never migrates during Synchronize;
- a future Dashboard consumer may consume a versioned normalized JSON contract
  for authorized remote operations without becoming local authority;
- OrganizationTemplate and PersonalspaceTemplate distribute scaffolds,
  pointers and compatibility tests — never copies of the Core resolver,
  schemas, migrator or a real Organization/Personalspace manifest.

Core owns migration planning, validation and deterministic projection. The CLI
adapter executes the explicit write after its Git/worktree gates. It is not a
Launchpad Server action. Launchpad Server continues to own only its long-running
runtime/process state, consistent with DEV-6439.

## Compatibility states

| Files present | State | Behavior |
| --- | --- | --- |
| only legacy | `legacy` | supported; Doctor offers migration |
| both, normalized semantics and canonical projection hash match | `transition` | supported; Lazurio file is canonical and legacy is a generated projection |
| semantics match but canonical projection hash drifts | `projection_drift` | canonical Lazurio read remains available; mutations block until projection regeneration |
| normalized semantics differ | `conflict` | fail closed for mutation; never choose silently |
| only Lazurio | `current` | readable for diagnosis; mutations remain blocked until the finalization gate |
| neither | `missing` | not a Lazurio resource; fail only when the mount is expected |
| any present document is invalid or unreadable | `conflict` | fail closed; `issues[]` identifies the malformed or unreadable document even when no second file exists |

One mount always produces at most one resource and at most one child Doctor.
Two filenames never create two Organizations or two Personalspaces.

The legacy projection is required during the compatibility window because old
supported Machines have hardcoded legacy structural gates and there is no
complete reader-version evidence today. It is not a second authority:

- edits target only the Lazurio manifest;
- one command regenerates the legacy projection;
- Core compares normalized semantics to prove lossless mapping and the
  canonical-JSON projection hash to prove exact equivalence to the
  deterministic generator output;
- canonical JSON uses deterministic serialization independent of indentation,
  LF/CRLF and host platform, so formatting-only drift is not a semantic error;
- a manual legacy edit that changes the canonical projection becomes
  `projection_drift` or `conflict`, never a second authority;
- extensions are preserved losslessly; only an unknown field that cannot be
  preserved or mapped blocks migration.

## Doctor and migrator

Doctor remains read-only and returns the next safe command:

```text
lazurio migrate organization-manifest
lazurio migrate organization-manifest --write
lazurio migrate organization-manifest --finalize --write

lazurio migrate personalspace-manifest
lazurio migrate personalspace-manifest --write
lazurio migrate personalspace-manifest --finalize --write
```

Contract:

- without `--write`, print a plan and machine-readable diff summary;
- Organization `--write` operates only in a clean plan-owned worktree on its
  expected branch; it never edits a primary checkout;
- Personalspace `--write` uses an owner-private task/worktree contract and
  never depends on an Organization Mission Control;
- build and validate the complete Lazurio manifest and legacy projection before
  replacing either file; never claim filesystem-level multi-file atomicity;
- validate schemas, normalized parity, root Git provenance, template kind and
  subordinate manifest references;
- never commit, push, merge or mutate Forge/Dashboard state;
- emit tool version, before/after semantic hashes, deterministic projection
  hash and changed files;
- preserve supported extension fields; refuse ambiguous roots, dirty
  worktrees, unpreservable fields, binding mismatch and path traversal;
- keep `--finalize` blocked until a separate accepted mechanism proves the
  minimum reader version for every supported Machine cohort.

### Authoring worktree protocol

Git is the recovery authority for authoring. The migrator uses a clean,
plan-owned worktree, computes both complete documents before touching either
path, validates the staged pair through Core and replaces each file atomically
on its own path. It then validates the files as read from disk and leaves the
result as an ordinary reviewable Git diff.

An interruption between the two replacements may leave `projection_drift` or
`conflict`. That state fails closed and remains visible in `git status`; the
migrator can deterministically regenerate the projection from the canonical
manifest, or the Task Agent can inspect and restore the worktree with normal Git
tools. Lazurio does not maintain a hidden transaction registry, receipt or
second rollback authority. Windows replacement behavior, case-preserving
repository names and separators remain hard gates alongside macOS and Linux.

### Machine update compatibility gate

The updater transports an already reviewed Git revision. It does not implement
a manifest-specific activation lifecycle:

1. Under the existing global update lock, fetch and pin the exact target OID
   without moving the checkout; verify the expected remote again after fetch.
2. Read the exact target documents through Git object inspection and resolve
   them with the same Core resolver as the live filesystem. Bind the normalized
   Organization and root-repository identity to the already verified checkout
   and remote. During the compatibility window only `legacy` and parity-valid
   `transition` targets may advance; `projection_drift`, `conflict`, `current`,
   `missing`, malformed, unreadable or mismatched targets block before stash,
   branch switch or pull.
3. Apply the existing local-work gates, verified recovery stash and exact
   pinned fast-forward update. Verify final HEAD and source identity against the
   pinned OID, then rediscover the Organization inventory and invalidate stale
   child caches before continuing.

Git HEAD is the only durable activation authority. A process or OS failure
during checkout may require ordinary Git recovery on the next run; Lazurio
detects and blocks unsafe states but does not promise unattended rollback.
Concurrent readers observing a multi-file Git checkout are a general runtime
snapshot or quiescence problem. If zero mixed-generation observation becomes a
hard requirement, it must be solved once for the whole runtime with an
immutable generation pointer or process quiescence, not with manifest-specific
shadow state.

## Rollout

### 0. Accept the Organization contract

DEV-6512 amended decisions 0026, 0031 and 0042 for the Organization contract.
Decision 0051 remains the Personalspace authority and is explicitly unchanged.
The resolver slice introduces no Organization writer or migration by itself.

The proposal and later rollout use a new Mission Control plan and DEV code.
They are independent of DEV-6439 and PR #129: DEV-6439 keeps its current Iotor
Core/CLI/lifecycle scope and does not deprecate Organization or Personalspace
manifests. The new plan may consume its Core read-model patterns after they land
without becoming part of its implementation sequence.

### 1. Make readers compatible in small follow-up slices

1. Add a Core resolver with legacy-identical behavior.
2. Move Organization discovery to it.
3. Move Git inventory, update and worktrees to it.
4. Move Doctor composition to it and prove one child per mount.
5. Move CLI to the same normalized model.
6. Add the binding-aware exact target-tree gate to the Organization update
   entrypoint before any checkout mutation.

No resource may enter `transition` until all mutation-capable consumers use the
Core resolver and every supported Machine is covered by the target-tree update
gate. Each slice keeps existing files canonical and carries golden parity,
real-Organization smoke and Windows CI.

#### Consumer impact map at the resolver baseline

The map below is the exact direct-reader inventory at Lazurio `main`
`5859fe524a2042053c781641810527db04407d38`. It is an implementation gate, not
a second registry: each follow-up removes a direct document read by consuming
`resolveOrganizationRootDocuments` and its normalized resource instead.

| Follow-up owner | Direct consumers at this baseline | Required convergence |
| --- | --- | --- |
| Core compatibility adapters | `lazurio/organization-activation-lib.mjs`, `lazurio/organization-install-lib.mjs` | Already call the single resolver; they intentionally retain the legacy-only activation projection until the reader/update gate. |
| Launchpad discovery and diagnostics | `launchpad/src/discovery-lib.mjs`, `launchpad/src/diagnostics-lib.mjs`, `launchpad/src/git-inventory-lib.mjs`, `launchpad/src/doctor-children-lib.mjs`, `launchpad/src/module-location-repair-lib.mjs`, `launchpad/src/workspace-parity-runner.mjs` | Consume one normalized Organization resource, preserve fail-closed conflict, and compose exactly one Organization child Doctor per mount. |
| Lazurio CLI, update and Module policy | `lazurio/lib.mjs`, `lazurio/module-port-lib.mjs`, `lazurio/module-setup-lib.mjs` | Stop opening the legacy projection as authority; use the same normalized identity, policy and repository inventory. |
| Root scripts and worktree inventory | `scripts/worktree-create.mjs`, `scripts/lazurio-module-inventory.mjs`, `scripts/mission-control-trust-smoke.mjs`, `scripts/gen2-gen3-sync-inventory.mjs`, `.agents/skills/worktree-development-discipline/scripts/worktree-inventory.mjs`, `.claude/skills/worktree-development-discipline/scripts/worktree-inventory.mjs` | Resolve the mount once through Core; keep the two tracked skill mirrors byte-identical. |
| Bootstrap follow-up | `lazurio/core/organization-scaffold-lib.mjs` | Emit the canonical manifest plus its deterministic legacy compatibility projection only after reader and target-tree update gates. |

`launchpad/src/doctor-surface-lib.mjs`, `launchpad/src/module-folder-lib.mjs` and
`lazurio/core/module-location-repair-contract-lib.mjs` mention the legacy
filename only in user guidance or interface documentation; they are copy
follow-ups, not independent readers. `lazurio/lazurio.organization.v1.schema.json`
and `lazurio/core/organization-activation-lib.mjs` are the schema and resolver
authorities introduced by the first slice and therefore are not migration
consumers.

### 2. Distribute migration capability

The Lazurio distribution delivers the versioned Organization schema, resolver,
migrator and Doctor integration. OrganizationTemplate Sync delivers only the
scaffold/pointers and compatibility tests needed by an Organization. The
Organization manifest is Organization-owned and is never copied from the
template.

Personalspace receives its capability separately through Lazurio and
PersonalspaceTemplate. OrganizationTemplate never reads or migrates it.

### 3. Canary, then per-resource PRs

Migrate one canary Organization in a plan-owned worktree. The PR contains the
new canonical manifest and verified legacy projection. Old and new readers must
produce the same normalized inventory. Then repeat with one reviewed PR per
Organization. Pull/sync never authors or regenerates a manifest; it may only
validate and fast-forward to the exact reviewed target revision.

During `transition`, contributors edit the Lazurio file and regenerate the
legacy projection. Editing the legacy file directly always produces
`projection_drift` or `conflict`, and mutation remains blocked until repaired.

New bootstraps emit the Lazurio manifest plus a compatibility projection while
the supported window requires it. Template `kind: template` remains preserved
and cannot become an actionable Organization.

### 4. Finalize later

`--finalize` remains unavailable until a separate accepted design proves
reader readiness for online, offline and returning Machines. Finalization then
requires no conflicts, cross-platform regeneration tests and an owner-approved
PR for the exact Organization or Personalspace.

Legacy reader removal is a later major compatibility change, never part of the
first migration PR.

## Required evidence

1. Golden normalization for remote-active, local-first and template
   Organizations.
2. Golden normalization for Personalspace variants without exporting private
   content.
3. All six states across Core and each consumer adapter.
4. One resource and one child Doctor when both files exist.
5. Old-reader compatibility against generated projections.
6. Unknown-field and lossy-mapping refusal.
7. Authoring interruption remains a visible fail-closed Git worktree state and
   deterministic rerun restores parity without hidden transaction state.
8. Windows/macOS/Linux per-file atomic replacement, path, case and projection
   behavior.
9. Exact target OID pinning plus proof that incompatible content, identity or
   remote drift blocks before stash, switch or pull; interrupted Git updates
   remain recoverable by the ordinary next-run Git gates.
10. Read-only smoke over all available Organizations without cross-Organization
   output.
11. Catalog projection proving that `diagnostics-only` slots remain in Doctor
    and materialization inventory but never become normal Module cards, while
    Module and application descriptions preserve their declared precedence.
12. Template ownership: mechanisms managed; manifests resource-owned.

## Non-goals

- No file rename or runtime behavior change in this proposal PR.
- No Forge, Cursor Origin, GitLab or self-hosted Forge implementation.
- No new IAM, daemon, state store, Dashboard authority or Launchpad parser.
- No filename/schema migration of `modules.manifest.json`, no migration of
  `launchpad.gen3.json` and no migration of Module runtime declarations.
- No business/legal profile decomposition hidden inside filename migration.
- No Personalspace rollout coupled to an Organization rollout.
- No broad rename PR; implementation follows as small, reversible plans.

## Review questions

Reviewers should answer explicitly:

1. Accept the three filenames and internal schema-version rule?
2. Accept Core ownership and consumer-only Launchpad/Dashboard adapters?
3. Accept the generated legacy projection and distinct repairable
   `projection_drift` state until reader readiness is provable?
4. Preserve current Organization-owned sections in v1, except eliminating the
   deprecated duplicate `modules[]` surface?
5. Keep `modules.manifest.json` as the only v1 repository-slot inventory and
   materialization authority, including Core-normalized catalog presentation,
   without treating every listed repository as a Module?
6. Keep local runtime fully independent of any Dashboard lookup index?
7. Keep `--finalize` blocked pending a separate Machine-readiness mechanism?
8. Accept Personalspace naming now but implement its migration separately?

## Independent review

Claude Fable 5 reviewed the proposal and current contracts on 2026-08-18. Its
initial verdict was **ACCEPT WITH CHANGES** and this revision incorporates its
blocking findings: Dashboard scope, unchanged Doctor schema, template-kind
preservation, plan-owned worktree writes, Core deduplication/consumer ordering,
canonical projection drift and the explicitly blocked finalization gate. Final
review evidence belongs to the PR, not to this proposal's own authority.

The active DEV-6439 architecture task independently reviewed the live import
graph and agreed with the direction while requiring a separate Mission Control
plan, independence from PR #129, verified/unverified Forge binding, canonical
projection drift, extension-safe migration, a Personalspace-private worktree
contract and Lazurio-owned executable tooling. This revision incorporates those
requirements.
