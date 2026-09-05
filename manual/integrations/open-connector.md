# OpenConnector — Apple Silicon DEV pilot

This is a bounded workstation pilot, not a released cross-platform installer.
Use `lazurio open-connector install|start|stop|status|configure|doctor` from
the DEV-6558 worktree. `--root` selects the installed Lazurio root whose
local manifest declares the Personalspace owner. Normal main is unchanged.

## Ownership and shape

One instance belongs to the workstation's owner. OpenConnector owns provider
configuration, encrypted credential records, named connections and runtime
token policies. Launchpad must link to the upstream console; it is not an
MCP proxy or a second provider configuration store. Agents connect directly
to `/mcp`. Named connections are orientation labels, not organization ACLs.

The pilot uses the upstream signed macOS ARM64 v1.5.0 binary at commit
`0eeed9dc8fecaa3d914c8375125680ff2372eced`, SHA-256
`804ae35511a6f995c26b87382f48cba339ce8462ea6da1e7c9e12f8ec3924332`.
The public Lazurio fork and release promotion are subsequent delivery work;
this binary is explicitly upstream, not a Lazurio release.

Native upstream binary plus a user LaunchAgent avoids adding Docker to the
first consumer. Docker remains a hosted deployment option, not another
workstation runtime running alongside it. Existing individual MCP servers
remain installed until functional parity and restart acceptance pass.

## Local lifecycle and custody

Non-secret install metadata and the copied worker live under
`~/Library/Application Support/Lazurio/open-connector`; launchd owns process
restart. The service binds only `127.0.0.1:24321`; console and callback origin
is `http://localhost:24321`. No public callback relay or central broker exists.
The credentials and data directory live in the owner's ignored
`secrets/open-connector/mac-pilot` custody. Never print their contents.

The upstream SQLite secret columns are encrypted; the database file and log
metadata are not wholly encrypted. Preserve both the data directory and
encryption key for recovery. Stopping the LaunchAgent does not delete data.
An incomplete install preserves its files and requires reconciliation;
never resolve it by deleting the custody directory.

Admin credentials belong only to console administration. A separate random
bootstrap runtime credential closes the runtime API even before a persistent
agent token exists. Never distribute either credential to agents. Agent
tokens must be individually revocable and explicitly scoped. All generic
HTTP proxies and GitHub actions are deployment-blocked; GitHub remains `gh`.
Since the MCP has a generic `execute_action`, harness approval should be
`prompt` for that tool, not an assumed per-provider write classification.

## Google onboarding

An OAuth client identifies the application, not the Google account. Reuse an
existing local client only after verifying its permitted audience; an Internal
app cannot onboard other Workspace tenants or consumer Gmail. External Testing
may yield refresh tokens that expire after seven days. Production/Workspace
policy and API enablement must be verified before calling the pilot durable.

Upstream supports separate named connections for each provider. The pilot
requests these exact provider-declared subsets:

- Gmail: `https://www.googleapis.com/auth/gmail.modify`.
- Drive: `https://www.googleapis.com/auth/drive`.
- Sheets: `https://www.googleapis.com/auth/spreadsheets` and
  `https://www.googleapis.com/auth/drive.readonly`.

Display the scopes before the Principal selects the account and consents in
the upstream console. No passwords, authorization URLs or codes enter chat.
The provider page's action scopes are not necessarily the requested subset.
Gmail settings actions requiring additional scopes are intentionally excluded.

## Acceptance and open work

Do not call an installed runtime a completed integration. Required acceptance:
unauthenticated MCP/API rejection; valid-token MCP discovery; forbidden-action
and wrong-connection rejection; each account identity verified; read smoke and
reversible draft/scratch write smoke; server restart and fresh harness smoke.
Never send mail, share files, modify existing business documents or delete the
smoke artifacts without a specific publication/cleanup instruction.

Still required before release: complete Google acceptance, client attachment,
Launchpad entry, platform lifecycle expansion, partial-install/concurrency
hardening, public fork and reviewed promotion. Neon management is supported
upstream but SQL execution is not; keep the existing SQL-capable integration.
