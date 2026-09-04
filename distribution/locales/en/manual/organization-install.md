# Organization install for Agents

This procedure adds an already active GitHub Organization, to which the signed-in
user has read access, into an existing Lazurio Root. It is the same for a public
reference, a private client, and your own Organization; the CLI has no
name-based exception.

## Short prompt for a new Builder Machine

The following block is user-facing input for Codex or another Task Agent. Before
pasting it, replace `<github-organization>` with the exact GitHub login of the
Organization. The full security and diagnostic contract remains in the
subsequent chapters of this runbook; the short prompt neither replaces nor
extends it.

<!-- lazurio-guide:organization-install-short:start -->
> Prepare this Machine as a Lazurio Builder for the GitHub Organization
> `<github-organization>`. First, using read-only checks, verify the platform,
> the current account, the Git state, and live permissions. Before this Machine
> is installed, the Organization owner must install the GitHub App
> **Lazurio for GitHub** for **All repositories** and complete the one-time
> activation; as a Builder, do not repeat their `admin:org` check and do not
> infer the App state from its unavailability.
>
> You have my explicit permission to install any missing Git, GitHub CLI,
> Node.js LTS, Codex CLI, and the exactly versioned Bun from their official
> sources, and to change only my user `PATH` so that their actual installation
> directories are available in a new clean terminal. Preserve the existing
> `PATH`. Do not change the system-wide `PATH`, the package manager, security
> settings, or other tool versions without my further consent. Install Codex CLI
> using the official OpenAI standalone installer for this platform as described
> in “Codex CLI: installation and updates”; do not use Homebrew, npm, or WinGet for it.
>
> If no usable SSH key exists for the GitHub account just verified, you have
> permission to create a new ed25519 key on this Machine, upload only its
> public part via the GitHub CLI, and store the private key only in this
> Machine's standard SSH custody. Start the GitHub login exactly once via
> `gh auth login --hostname github.com --git-protocol ssh --web`; keep the
> process alive, let me complete the single personal step in the freshly opened
> GitHub page, and never print the device code, token, or private key into the
> chat, a log, or an issue.
>
> On Windows, after each authorized WinGet installation, refresh `PATH` only
> for the current installation process from fresh Machine + User values
> according to this runbook so that the current operation can finish safely.
> Then tell me the exact resume point, let me fully close every Codex window,
> and continue in this thread after Codex has been started again. Prove the
> finished state only from the relaunched Codex and its new clean process; a
> new terminal opened from the old Codex is not enough. Use a Windows restart
> only as a fallback. Then verify the correct GitHub account,
> `git_protocol=ssh`, and an exact `git ls-remote` of the root repo
> `<github-organization>/<github-organization>_GEN3`.
>
> Run convergently `lazurio install --json`,
> `lazurio doctor --tool-updates --json`,
> `lazurio organization install <github-organization> --role builder --json`
> and the final
> `lazurio doctor`; resolve all safely fixable required findings within this
> mandate and repeat the checks. Do not change access, secrets, or foreign
> Organizations. The active scope is determined by the
> versioned Organization manifest. When my instructions or the evidence handed to you
> diverge from it, do not silently overwrite or skip anything: show me the
> exact discrepancy and request my decision on the proposed change. Finally,
> start the Launchpad through the same supported path, verify the health of the
> active applications, and hand over the `runtime ready` / `editing ready` /
> `publishing ready` matrix. Never present `READ` as Builder-ready `WRITE`;
> name any access blocker by the exact account, Team, and repository for the
> Organization owner.
<!-- lazurio-guide:organization-install-short:end -->

### Optional expanded installation mandate

The default prompt above remains the smallest safe mandate: it installs
missing tools and changes only the User `PATH`. A Principal who owns or
administers the whole Machine may consciously permit a complete system
installation in the same prompt. The expanded mandate is neither a new
installation profile nor a permanent Lazurio setting; it authorizes exact
external changes for the current installation session.

Add only the paragraphs whose impact the Principal actually approves:

> For this Machine, you additionally have my explicit permission to use a
> supported system package manager, request the standard OS elevation, and
> change both the User and Machine/system-wide `PATH`. Add only the canonical
> installation directories of the named tools, preserve all other valid
> entries, and remove only a demonstrably invalid or shadowing entry for the
> same tool. Do not bypass UAC, device-management policy, or the Machine's
> security protections.
>
> Install missing and update existing Git, GitHub CLI, and Codex CLI to the
> current official stable versions, and Node.js to the current supported LTS.
> Always set Bun to the exact stable version declared by the current clean
> Lazurio `lazurio/package.json#packageManager`, even when upstream offers a
> newer release. Install and update Codex CLI using the official OpenAI standalone
> installer. For Codex, you also have permission to migrate an existing
> Homebrew/npm/WinGet installation to standalone: first verify the new
> installation, then remove only the previous Codex CLI package and preserve
> settings, authentication, and history.
> Do not use preview, beta, nightly, or canary versions. Resolve
> every safely fixable required Install Core and Doctor finding within this
> mandate and repeat the checks; do not stop after merely reporting it.
>
> If you reproduce a general Lazurio problem during installation, you have my
> permission—after checking open and closed duplicates and sanitizing the
> evidence—to create or extend a GitHub Issue in
> `<installation-issue-repository>` and include its URL in the handoff. Do not
> publish secrets, Personalspace, the local username, or Organization-specific
> data. Do not close, assign, or prioritize the issue.

`<installation-issue-repository>` must be the exact owning repo, not a generic
name. For the installer, CLI, Doctor, Launchpad, and shared manual, that is
currently `HumanAndMachines/Lazurio`; an Organization-specific finding does
not belong there. Follow the publication and sanitization process in
[`manual/github-issues.md`](github-issues.md).

This expanded mandate does not authorize a merge, release, source push,
GitHub membership or Team changes, or GitHub App installation outside the
explicitly named Organization.

## What turns a GitHub Organization into a Lazurio Organization

The first constitutive step is installing the official GitHub App
**Lazurio for GitHub** into the target GitHub Organization. For regular
onboarding, the Organization owner selects **All repositories** in the GitHub
installer. This creates the provider-side binding of the Organization to
Lazurio, and future repositories do not end up in a hidden partial-access
state. As long as the App is missing, the owner's read-only check returns
`github_app_installation_required` and remote activation must not proceed.

`All repositories` is the canonical onboarding standard, not a second Lazurio
ACL. GitHub remains the sole authority for access. A deliberately restricted
**Only select repositories** installation is a supported scoped exception; it
must include the canonical Organization root and all repositories that Lazurio
is actually meant to serve, and its partial access must never be presented as
the full Organization scope.

The GitHub App itself does not replace the Organization source. A usable
Lazurio Organization has all of the following at once:

1. the `Lazurio for GitHub` App installed with a verified repository scope;
2. the canonical root repo `<login>/<login>_GEN3` on `main` with a valid
   Organization manifest and an immutable Forge binding;
3. a local mount created only by the convergent command
   `lazurio organization install`.

After installing the App, the **GitHub Organization owner** verifies it once
via the immutable GitHub Organization ID:

```sh
lazurio organization activate --check --github-id <immutable-id> --json
```

Only the owner-observed result `outcome: "active"`, a matching App
installation scope, and a valid root prove remote activation. The GitHub
settings page or the textual name of the Organization are not proof on their
own.

This activation is a provider-side owner gate, not a step on every working
machine. The Builder does not repeat it and does not need `admin:org`: the
installations endpoint is deliberately unobservable for them, and GitHub may
return the boundary as HTTP 403 or even a hidden 404. Such a response proves
neither a missing App nor a broken transport. The Builder materializes the
already active Organization via
`lazurio organization install <github-login> --role builder`. Besides read
access, this proves, before cloning, their own active Organization and Team
membership and WRITE or higher permission on the Builder repositories.

## Prerequisites

- the production or development-linked `lazurio` command is in `PATH`;
- Git, the exactly pinned Bun, a supported Node.js, and the GitHub CLI are
  available in the `PATH` of a new clean process;
- `gh auth status --hostname github.com` confirms the correct account;
- the Organization owner has already completed the one-time activation of
  `Lazurio for GitHub`;
- the canonical Lazurio Root `<home>/Lazurio` has already gone through
  `lazurio install` and has a real `organizations/` folder;
- the Organization root repo `<login>/<login>_GEN3` exists on `main`, contains
  a valid Forge binding, and the user can read it.

The command is local-only. It never creates or changes a GitHub repo, a GitHub
App grant, Team membership, branch rules, visibility, a port, or a commit. A
separate explicit activation procedure serves to establish a remote
Organization.

An internal Team slug is not an authorization identity. For the Builder gate,
the Organization manifest maps it via `teams[].forge_binding` to
`lazurio.team-forge-binding.github.v0`, the immutable GitHub Team `id`, and its
`asserted_slug`. A missing or renamed binding is an owner blocker, not a reason
to guess the Team by display name. The Organization root and the active slots
assigned to the Builder are checked; `planned_slot` and restricted/Admin-only
slots are deliberately not included.

## Toolchain gate before the Organization scope

An installed binary is not yet a ready tool. Onboarding must not proceed merely
because the installation script can run Bun via an absolute path or because the
currently running terminal inherited a temporarily extended `PATH`. Before the
Organization is materialized, a new clean process must find the commands `bun`,
`git`, `gh`, `node`, `codex`, and subsequently `lazurio`; for an SSH remote,
Git's SSH transport must also work.

The machine toolchain is owned by the top-level installation flow, not by the
Organization. The Agent first runs `lazurio install --json` and, when
troubleshooting, also `lazurio doctor --tool-updates --json`. Install Core
distinguishes a missing tool from the `*_not_on_path` state; the exact
supported Bun version continues to be owned by `package.json#packageManager`.
The supported Node range is owned solely by
`lazurio/package.json#engines.node`; currently it is `>=22.12.0`. For a new
Machine, after explicit consent, use the current
[official Node.js LTS](https://nodejs.org/en/download), not a custom latest
resolver or an unknown registry package. Both Install Core and Doctor run
`node --version` and evaluate the same versioned range before Organization
materialization.

### Windows: continuing after WinGet in the same installation session

WinGet writes a new User `PATH`, but an already running PowerShell, Task Agent,
or Explorer keeps holding the old process snapshot. After an authorized
installation, the installing Agent therefore loads the current persistent
Machine and User values in the same PowerShell process and changes **only the
process `PATH`**:

```powershell
$machinePath = [Environment]::GetEnvironmentVariable(
  'Path', [System.EnvironmentVariableTarget]::Machine
)
$userPath = [Environment]::GetEnvironmentVariable(
  'Path', [System.EnvironmentVariableTarget]::User
)
$env:Path = (@($machinePath, $userPath) | Where-Object { $_ }) `
  -join [IO.Path]::PathSeparator
```

This step writes nothing to the registry or the shell profile and does not use
a manually located versioned package directory. It allows the installation
session to continue, but it is not the final proof. After the currently active
atomic operation finishes, the Agent records the exact resume point in the
chat and the Principal fully closes every Codex window and starts Codex again.
Only a new clean process from the relaunched Codex may prove that the same
commands are available without this snippet. A new terminal started by the old
Codex still inherits its environment snapshot and is not sufficient. Their
actual identity and usability are subsequently verified by
`lazurio install --json` and Doctor; a mere `Get-Command` is not enough. User
sign-out or a Windows restart is only a fallback when the persistent User and
Machine values are correct but the new Codex still cannot see them.

On Windows, Git, GitHub CLI, and Node.js may be installed even without admin
rights into the official user directories under
`%USERPROFILE%\AppData\Local\Programs`. Install Core and Doctor accept the Git
Installer in `Git\cmd`/`Git\bin`, PortableGit in
`PortableGit\cmd`/`PortableGit\bin`, and the GitHub CLI in `GitHub CLI\bin`
(including the variant with `gh.exe` directly in `GitHub CLI`). They accept
Node.js in `Programs\nodejs` and via the exact user-scope WinGet command link
`AppData\Local\Microsoft\WinGet\Links\node.exe`. The authority for these
prefixes is the home of the current OS account, not an inherited
`LOCALAPPDATA`, `USERPROFILE`, or an arbitrary `PATH` entry; the binary found
must still canonically match one of these fixed candidates and pass a
functional probe.

### Codex CLI: installation and updates

For localhost workstations on macOS, Linux, and Windows, the default path is
[the official OpenAI standalone installer](https://developers.openai.com/codex/cli).
OpenAI owns installation and subsequent updates; Lazurio only directs Agents
to that procedure. Codex release availability therefore does not depend on
updates to the Homebrew cask. Do not use Homebrew, npm, or WinGet for new Codex
CLI installations. This rule does not change how other tools are installed or
the immutable hosted Resident/Buddy pins and their release lifecycle.

On macOS and Linux, use this for installation and updates:

```sh
curl -fsSL https://chatgpt.com/codex/install.sh | sh
```

On Windows, use this for installation and updates:

```powershell
powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/codex/install.ps1 | iex"
```

Use the current official stable release, not a preview or a version copied
verbatim from a manual. Before execution, a scoped installation or update
mandate for Codex and the relevant `PATH` layer must apply. Do not request an
already granted mandate again; if it is missing, first prepare the exact
remediation and request the Principal's consent. Neither Doctor nor
`lazurio update` ever executes this command. `lazurio install` remains a
machine-gate report, not an installer for the external toolchain.

**Existing Homebrew/npm/WinGet installations.** Identify all `codex` commands
on `PATH`, their actual symlink targets, and the previous package's manager.
A version string or the path `~/.local/bin/codex` does not prove standalone
ownership: this path can also link to Homebrew. A working older installation
still meets runtime availability; Doctor neither migrates it automatically
nor confirms its origin.

Migration requires a mandate to remove the exact previous Codex package as
well. Record its manager, version, and exact recovery procedure beforehand.
First install standalone. Read the actual installation directory from the
official installer's output and invoke the new binary by explicit absolute
path with `--version`. Resolve the complete symlink chain and verify that the
target belongs to that standalone installation, outside the previous
Homebrew/npm/WinGet package. Then verify that ordinary `codex` in a new
process resolves to that same standalone binary; matching version strings
from two different files are not sufficient. If it is shadowed, fix only the
already authorized `PATH` layer. Uncertain ownership or a missing PATH
mandate means keeping the old package and reporting the exact finding.
Only after both probes succeed, uninstall the previous Codex through its
actual manager (for example, `brew uninstall --cask codex` or
`npm uninstall -g @openai/codex`). If the installer offers to remove the old
installation before the new one is verified, defer removal until this step.
Do not remove the package manager itself, Node, or other tools. Do not use
purge/zap and do not delete `CODEX_HOME`, settings, authentication, or history.
If the new installation fails, retain the working previous installation and
report the finding; do not create a custom fallback installer or wrapper.

After installation and again after removing the old package, verify command
resolution and version in a new process: on macOS/Linux, use `command -v codex`
and the actual symlink target; on Windows, use `Get-Command codex -All`.
Verify `codex --version` and `codex login status` without reading or printing
credential files. On Windows, refresh the process `PATH` and complete the
full Codex relaunch described in the preceding chapter; a child shell of the
old session is not sufficient. If the command fails or points elsewhere after
removal of the old package, restore working resolution to the verified
standalone binary within the granted mandate; if that is not possible,
restore the exact previous package and its original PATH binding using the
prepared recovery step. Without a recovery mandate, do not guess: preserve
the standalone files and user data and report the precise blocker. Do not
present the migration as complete until the new-process probe passes.
Finally, repeat `lazurio doctor --tool-updates --json`.

The Windows installer creates a visible native `codex.exe` and checks its
version. A bare `codex-x86_64-pc-windows-msvc.exe` or
`codex-aarch64-pc-windows-msvc.exe` on `PATH` is not a green state. Do not
create an ad-hoc `codex.cmd`, copy the target-specific binary, or accept it as
proof of readiness. Doctor names this specific WinGet state but deliberately
does not fix it.

If the installation prompt contains an explicit mandate for the exact tools and
a change to the User or Machine `PATH`, the Agent does not stop at a handoff
warning:

1. it installs any missing Git, GitHub CLI, Node.js LTS, Codex CLI, or exactly
   pinned Bun exclusively via the official procedure for the detected
   platform;
2. it adds only the actual installation directory of the tool to the explicitly
   authorized User or Machine `PATH`, preserves unrelated valid entries, and
   creates no binding to the task worktree;
3. it uses the system-wide `PATH`, a system package manager, or an upgrade of
   an existing tool only when the prompt explicitly permits each category; even
   the expanded mandate does not authorize overwriting an unrelated shell
   profile or changing security settings;
4. after an exact resume handoff, it fully closes and restarts Codex, thereby
   discarding the temporary PATH inheritance, and from the new clean process
   verifies `bun --version`, `git --version`, `gh --version`, `node --version`,
   `codex --version`, and, after registration, also
   `lazurio cli status --json`;
5. it runs Install Core again. Bun, Git, and GitHub CLI must not have the
   reason `*_not_on_path`, and Node must satisfy the versioned range; only then
   does `lazurio organization install` proceed.

The recommended authorization block of the installation prompt is:

> You have my explicit permission to install any missing Git, GitHub CLI,
> Node.js LTS, Codex CLI, and the exactly versioned Bun from their official
> sources, and to change only my user PATH so that their actual installation
> directories are available in a new clean terminal. Preserve the existing
> PATH. Do not change the system-wide PATH, do not install a system package
> manager, do not change security settings, and do not upgrade other tools
> without my further consent. For Codex CLI, use the official OpenAI standalone
> installer from the chapter above, not Homebrew, npm, or WinGet.

When the prompt does not authorize the concrete `PATH` layer, the Agent returns
an exact installation report and requests consent. User consent is not treated
as Machine consent, and a temporary absolute path is not an acceptable bypass
of the gate.

## GitHub login is not Git transport

`gh auth status` proves the API login, not Git's ability to read a private SSH
remote. Onboarding therefore performs the login only once and, before
materialization, verifies the exact root remote:

```sh
gh auth status --hostname github.com
git ls-remote --exit-code --heads -- \
  git@github.com:<login>/<login>_GEN3.git refs/heads/main
```

If the first command fails, sign in the correct account **once** via the
official interactive:

```sh
gh auth login --hostname github.com --git-protocol ssh --web
```

The `--git-protocol ssh` option is part of the same GitHub device/web pairing.
During login, the GitHub CLI looks for existing SSH keys and offers to upload
their public part; if it finds none, it offers to create and upload a new one.
The Agent may confirm this prompt only with the explicit mandate stated below.
It does not start a second login in parallel, does not print the device code
into an issue or log, and, after the authorization page opens, clearly tells
the Principal the single pending human step. After completion, it verifies in
the same session:

```sh
gh auth status --hostname github.com
gh config get git_protocol --host github.com
git ls-remote --exit-code --heads -- \
  git@github.com:<login>/<login>_GEN3.git refs/heads/main
```

In this way, a single pairing establishes both the API session and the SSH Git
path; `gh auth status` alone is still not proof of transport. If the API login
succeeds but the exact `git ls-remote` does not, do not repeat `gh auth login`:
repair this account's SSH transport once using the standard GitHub procedure.
First verify the existing key and its binding to the correct GitHub account.
Use a standalone `gh ssh-key add` only as a repair of an already signed-in
account, not as a second default onboarding flow. Creating a new SSH key and
uploading it is an access change, and the Agent may do it only with the
Principal's explicit consent for this machine and account; it never prints the
private key or places it in the repository. It then repeats the exact
`git ls-remote`, not the whole login.

The reference behavior is held by the official documentation for
[`gh auth login`](https://cli.github.com/manual/gh_auth_login). A standalone
`ssh -T git@github.com` is only a supplementary diagnostic probe and, on
successful GitHub authentication, deliberately ends with exit code 1; the
installation gate therefore decides based on the exact `git ls-remote`, not on
the exit code of `ssh -T` alone.

`lazurio organization install` performs the same read-only preflight before
cloning. The reason `materialization_source_unavailable` therefore means
"verify repo access and the declared Git transport", not "the App is
apparently not installed".

The installation prompt for a new Builder Machine must state this boundary
explicitly:

- do not use `organization activate --check` as the Builder gate, and do not
  infer the App state from a response requiring `admin:org`;
- when the SSH key is missing, the Agent may create a key and upload its
  **public** part to the GitHub account just verified only if the prompt
  contains explicit permission for this exact access change;
- after login or key repair, always verify the exact root using
  `git ls-remote`, and only then run
  `lazurio organization install <github-login> --role builder`.

If the Principal wants to authorize the SSH bootstrap without further
interruption, the prompt should say: "If no usable SSH key exists for this
account, you have permission to create a new ed25519 key on this Machine,
upload only its public part via `gh ssh-key add` to the GitHub account just
verified, and verify the exact Organization root. Never print the private key
or copy it outside this Machine's standard SSH custody."

## Convergent procedure

```sh
lazurio organization install <github-login> --role builder --json
lazurio organization install <github-login> --role builder --json
lazurio doctor
```

The installing Agent does not stop at the first output. It always repeats the
remediation and the read-only verification until all of the following hold at
the same time:

1. `lazurio install --json` has `status: "completed"`;
2. `lazurio doctor --tool-updates --json` has no required `fail`, `blocked`,
   or `incomplete`; a missing or unreadable version of the mandatory Git,
   GitHub CLI, Node.js, or Codex is not a warning but an incomplete
   installation;
3. `lazurio organization install <github-login> --role builder --json` is
   `current` or safely `updated`, `access.status` is `ready`, and the exact
   SSH root probe passed;
4. the final `lazurio doctor` is green, including all declared subordinate
   doctors.

Every recommended warning has an explicit disposition in the handoff: fixed,
knowingly accepted by the Principal, or blocked by missing authority. A
required finding is never merely "acknowledged". After a change to the
persistent PATH, the Agent starts a new clean process; on Windows, an open
Explorer, Start menu, or terminal with the old environment snapshot is not
enough.

## Windows without Developer Mode

Neither Lazurio nor OrganizationTemplate may create a symlink or junction for
`.claude/skills`. The canonical source is `.agents/skills`; `.claude/skills` is
a Git-tracked, byte-for-byte derived mirror verified by
`bun run doctor:agent-skills`. A fresh checkout and every worktree therefore
already contain it, and Windows **does not need to be switched to Developer
Mode**. The command `bun run repair:agent-skills` is deliberately a no-write
diagnostic: it does not overwrite drift or a missing mirror, but returns them
to the Agent for an explicit Git-reviewed fix in the task worktree.

Do not solve this with a gitignored local copy: it would require an additional
materialization step after every checkout and worktree and would allow local
drift. The diagnostic lane does not overwrite any content or symlink/junction
by guesswork; it returns every conflict to the Agent for a safe fix in the
owning repo.

The CLI neither selects the Root nor stores it as additional configuration. A
production installation always uses `~/Lazurio` on macOS/Linux and
`%USERPROFILE%\\Lazurio` on Windows. This gives both people and Agents one
predictable path, and the absolute path simultaneously carries the Machine's
user. This operation therefore does not accept `--root`.

The first run materializes the exact Organization root into
`organizations/<CanonicalLogin>_GEN3` and, via the regular update reconciler,
adds the available declared Modules. The same explicit installer can then
atomically add the active root-space `mission-control/db` with the
materialization of `repository_db_mount`, but only under exactly one declared
and actually materialized parent Git repository. It verifies the
Organization-owned remote, the declared branch, the Git ignore in the parent
repository, and a safe physical path. A duplicate legacy `repository_db`
projection is not an additional authority; the slot's normalized Git fields
decide. If the declared Mission Control does not have exactly one active
`mission-control/db` mount with this contract, the install ends `blocked` — it
must not report a successful convergence with missing data. Every freshly
materialized checkout uses `--single-branch` for the initial clone, but before
publication it receives exactly one canonical fetch refspec
`+refs/heads/*:refs/remotes/origin/*`. Subsequent update, review, and Doctor
therefore do not inherit a narrow refspec limited to the bootstrap branch alone.

The installer neither fetches nor fast-forwards an existing repository-db
checkout: it verifies only a clean exact Git root, the remote, and the declared
branch. Ongoing sync, commit, and publish remain in the repository-db workflow,
and the general `lazurio update` continues to skip it. The second run must be
`current` unless the local state changed in the meantime. The Agent decides
based on the stable fields `state`, `target.reason`, and the nested update
report, not on a localized sentence.

The public states are only:

- `current` — the root and the available declared hierarchy already match
  `main`;
- `updated` — at least one safe checkout was added or fast-forwarded;
- `blocked` — at least one part needs access or a safe remediation.

`blocked` does not mean a rollback of already verified checkouts. A typical
case is a private Module that the signed-in user cannot see: the available
Modules remain installed, and the report marks only the unavailable slot. After
the GitHub access is fixed, the Agent runs the same command again.

## When the Agent must not repair the state by guesswork

The CLI fails before overwriting data when the target path:

- is a symlink/junction alias, a file, or a case-insensitive collision;
- contains dirty tracked or untracked changes;
- uses a different GitHub origin or a foreign Forge binding;
- does not have a clean checkout of the declared default branch;
- after the fetch contains ahead/diverged history or an invalid manifest.

In such a case, preserve all commits and files, work in a task worktree, and
fix the exact cause. Do not use `reset --hard`, force push, or a manual move of
a foreign checkout. The login is only a locator: the immutable Organization
and repository IDs are verified before cloning, in staging, and again before
the atomic move, so a rename race or a reused namespace cannot silently install
a foreign root.

The repository-db target remains equally fail-closed when its parent is not an
exact Git root, `db/` is not ignored directly in this parent repository, or the
existing database contains local changes or a different remote/branch. The
ignore of the Organization root does not by itself authorize the child
database.

## Handoff

In the PR or the installation report, state the exact CLI version, the GitHub
login, the immutable ID from the JSON report, the resulting target, the overall
state, and all blocked repo reasons. Also state the status of the
installer-managed `mission-control/db` mount; `current` here proves identity
and cleanliness, not the online currency of its data branch. Do not copy
secrets, provider stderr, or the content of another Organization into the
report.

Report a reproduced general problem of the Lazurio installer according to
[`manual/github-issues.md`](github-issues.md) to `HumanAndMachines/Lazurio`; an
Organization-specific problem belongs in the private owning repo. The
installing Agent may create or extend an issue only when the prompt contains an
explicit publication mandate for that repo. Otherwise, it returns a sanitized
issue draft and the exact target repo in the handoff.
