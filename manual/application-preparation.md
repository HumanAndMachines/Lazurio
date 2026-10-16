# Application preparation after source updates

This is the consumer contract for Lazurio#470 under Module Standard (decision
0171), not a second build configuration. `lazurio.preparation` in the selected
App package remains the sole authority for its owner and scripts.

## Intended behavior

- After an actual managed source change, update installs/verifies frozen
  dependencies, runs the declared preparation even when the read-only check
  would accept an old build, and verifies readiness afterward. Unchanged
  checkouts do not rebuild. Update does not start applications.
- Start/Open checks the selected main or worktree App. An unsuccessful check
  runs preparation once and checks again before starting/reusing its URL.
  A managed selected process is stopped before preparation writes artifacts.
- A missing declaration preserves the existing legacy lifecycle. An invalid
  declaration, escaped owner path, unsupported preparation runtime, failed
  build or still-failing check blocks the operation with the script output.
  No successful HTTP probe substitutes for preparation readiness.
- Preparation runs in the declared package inside the owning checkout with
  Bun's implicit `.env` loading disabled. It introduces no build stamp or
  duplicate dependency installer. Existing frozen-install recovery remains
  the dependency authority. Python preparation stays unsupported here until
  the existing uv runtime adapter is implemented.

## Design choice and failure modes

Running `build` by convention would miss data generation and other supported
preparation tasks. Checking only existence would preserve stale artifacts,
as Presentation demonstrated. Persisting another freshness cache would create
an authority that the Module does not own. Instead, source update forces the
existing idempotent task; ordinary start checks readiness and repairs only
when required. One shared preparation executor serves updater and lifecycle.

Failures propagate to the existing blocked update / lifecycle error surfaces.
A build failure does not trigger dependency reinstallation: it is not proof
of a dependency defect. An unsuccessful post-build check is a separate
failure. Successful repository sync is retained even when preparation fails;
there is no guessed Git rollback or automatic application restart.

## Evidence required

Tests exercise real Bun package scripts through updater and runtime manager:
a stale but accepted build changes after source update, unchanged source does
not run preparation, a missing build is prepared before serving, failed
preparation never starts the App, owner escape is rejected, and a failed
post-check stays blocked. Browser smoke uses an actual conformant module
through an isolated runtime manager from the task worktree.
