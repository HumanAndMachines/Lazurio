# Organization Host read-only contract v1

This directory is the public, provider-neutral compatibility and readback
contract for Organization Hosts. Lazurio owns the published interface;
`HumanAndMachine-ai/Machines` privately owns reusable plan/apply/rollback
tooling and operating know-how. A concrete Organization's restricted
Deployment Repo remains the only authority for its desired state, provider
references, plans, permits and deployment evidence.

This contract is not `InfraTemplate_GEN3`. It contains no provider values,
production playbook, customer inventory or mutation SDK and does not declare
an existing infra repository to be a template.

## Three distinct concepts

- **Organization Host** is the Organization-owned provider host and the
  higher-trust administrative, recovery and compromise domain that carries
  mutually isolated Hosted Team Workspace runtimes. At the provider/operator
  layer it is a Machine.
- **Hosted Team Workspace** is the entire provider-isolated private development
  envelope of one Team. At the tenant layer it counts as the Team's Machine;
  this follows from its complete filesystem, process, network, credential and
  recovery boundary, not merely from being a container. It is not a separate
  provider Machine Profile and does not host production applications, member
  Personalspace or provider credentials.
- **Conglomerate Host** is a separate provider- or enterprise-operated Machine
  Profile for shared infrastructure services used by multiple isolated
  Organizations. It holds none of their checkouts, Hosted Team Workspaces or
  Personalspace, has no mutation or access authority over them, creates no
  shared access boundary and is outside this Organization Host contract.

These layers are intentionally explicit rather than peers. Sibling Team
Workspaces are isolated from each other under the supported contract, while
Organization Host root or equivalent operator authority can recover or
compromise all of them. Calling a Workspace a Machine therefore does not claim
isolation from its authorized host operator and does not create a Machine
registry, IAM role or new authorization source.

## Files

- `adapter.v1.schema.json` — the read-only adapter declaration expected from an
  Organization Deployment Repo;
- `readback.v1.schema.json` — the minimum metadata-only observation;
- `contract-lib.mjs` — fail-closed semantic validation and a physically
  contained read-only invocation builder;
- `fixtures/` — anonymous profile-state archetypes, never real Organization
  inventory or deploy configuration.

Schema `lazurio.organization_host.adapter.v1` and interface version `1` are the
first compatibility boundary. A breaking change requires a new schema marker
and interface version; v1 meaning is not rewritten silently.

## Read-only adapter interface

The restricted Deployment Repo declares one relative executable entrypoint.
Lazurio may invoke exactly two fixed operations:

```text
<entrypoint> validate --json
<entrypoint> readback --json
```

Before invocation, the selected checkout and entrypoint are resolved through
the physical filesystem. The entrypoint must be a regular file inside the
physical checkout; lexical traversal and symlink escape are rejected.

The public SDK exposes no `plan`, `apply`, `rollback`, provider credentials or
delegated mutation launcher. A readback `next_action` may point only to another
public read-only operation; mutation begins in the private Machines and owning
Deployment Repo lane under its own reviewed permit workflow.

Output contains no free text, hostname, IP, Team name, provider ID, credential
or absolute path. State uses bounded enums and `reason_code`. Runtime pins
report kind, declared value, observation state and observed value; the adapter
does not self-assert `match`, `drift` or compliance. Lazurio Root observes the
exact Deployment Repo and Git HEAD from the selected local checkout.

## Conformance and recovery readback

Every declaration carries the same public invariants:

- non-root per-Team isolation and no production hosting in the Workspace;
- exact runtime pins;
- health categories `host`, `workspace`, `access`, `runtime`, `ingress` and
  `storage`;
- metadata-only logs without secrets;
- declared checkpoint, restore-readback, clean-rebuild and rollback
  capabilities;
- Organization-owned concrete state and deployment evidence.

`profile_state` distinguishes `legacy`, `target` and `declared`. An adapter
never reports `compliant`; Root Doctor may derive it only from valid readback,
exact pins, complete health coverage, recovery evidence and the observed exact
Deployment Repo HEAD.

## What v1 does not do

- no plan, mutation, recovery execution or provider management;
- no auto-discovery or aggregated inventory;
- no implicit fleet operation or central credential store;
- no customer-specific metadata, credentials or provider state;
- no automatic packaging into a Resident artifact.

Read-only Root inventory and Doctor are the next public slice of Mission
Control plan DEV-6501. Real adoption remains a separate reviewed change in the
selected Organization's Deployment Repo and a serial Machine canary.
