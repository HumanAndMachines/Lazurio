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
Installation is serialized with a local lock; a leftover lock is reported with
its exact path and must be reconciled against its recorded process, not blindly
deleted. Reinstall refreshes the copied worker and LaunchAgent interpreter path
without rotating existing credentials. Liveness probes are unauthenticated;
administrative API requests use literal IPv4 loopback rather than `localhost`.

Admin credentials belong only to console administration. A separate random
bootstrap runtime credential closes the runtime API even before a persistent
agent token exists. Never distribute either credential to agents. Agent
tokens must be individually revocable and explicitly scoped. All generic
HTTP proxies and GitHub actions are deployment-blocked; GitHub remains `gh`.
Since the MCP has a generic `execute_action`, harness approval should be
`prompt` for that tool, not an assumed per-provider write classification.

## Google onboarding

### Proč potřebujeme OAuth aplikaci, když máme OpenConnector

OpenConnector je v tomto pilotu společná integrační křižovatka Mašiny:
Claude Code, Codex i další harnessy se připojují na jeho MCP endpoint.
Google účty se přihlašují v OpenConnectoru, ne znovu v každém harnessu.
GitHub zůstává výslovnou výjimkou přes `gh`. Tento směr není tvrzení,
že už jsou všechny dosavadní integrace migrované nebo podporované.

Je potřeba rozlišovat čtyři věci:

| Pojem | Co představuje | Kdo jej v pilotu spravuje |
| --- | --- | --- |
| Google Cloud projekt a OAuth klient | Registrace aplikace, zapnutá API, kvóty a identita na consent obrazovce | Owner pilotu v Google Cloud |
| Google účet a jeho OAuth grant | Konkrétní člověk/účet, který povolil konkrétní scopes | Účet uděluje a odvolává souhlas; OpenConnector drží tokeny lokálně |
| Pojmenované připojení | Volba konkrétního účtu u konkrétního provideru | OpenConnector Web Console |
| Runtime token harnessu | Přístup Codexu či Claude k povoleným akcím a připojením | OpenConnector; oddělený token pro každý harness |

OAuth klient tedy není přihlášený uživatel. Jedna správně nastavená External
aplikace může obsloužit více účtů z různých Workspace organizací i osobní
Gmail, pokud jejich administrátorské politiky přístup dovolují. Projekt
nezakládáme pro každý účet ani pro každý harness. Upstream pilot přitom
přihlašuje Gmail, Drive a Sheets jako samostatné providery s vlastními
pojmenovanými připojeními; neznamená to jeden společný grant pro všechny služby.

Pozor při změně výchozího OAuth klienta provideru: v upstream v1.5.0 běžné
console připojení používá aktuální výchozí konfiguraci i při obnově tokenu.
Pouze explicitní custom-client flow ukládá vlastní snapshot konfigurace.
Změna defaultu proto není izolovaná jen na příští nové připojení. Naplánuj
opětovné přihlášení existujících účtů daného provideru a zachovej původní
klientské údaje pro rollback, dokud migrace není ověřená. Neměň všechny
providery najednou před dokončením prvního přihlášení.

### Jak to řeší Composio

Composio nabízí **managed OAuth**: pro podporované služby, včetně Gmailu,
registruje a udržuje vlastní OAuth aplikaci, klientské credentials a callback.
Uživatel proto svůj Google Cloud projekt zakládat nemusí; pouze udělí souhlas.
Composio potom ukládá a obnovuje jeho tokeny. Registrace aplikace tedy nezmizela,
jen ji za uživatele spravuje poskytovatel. Alternativou je **custom OAuth**,
kdy zákazník poskytne vlastní aplikaci kvůli brandingu, scopes nebo kvótám.
[Managed vs custom auth](https://docs.composio.dev/docs/authentication/custom-app-vs-managed-app),
[Managed OAuth apps](https://docs.composio.dev/toolkits/managed-auth).

Self-hostovaný OpenConnector v tomto pilotu tuto registraci jako managed
službu nedodává: připravíme vlastní OAuth aplikaci a OpenConnector bude
spravovat výsledná připojení. Cloud projekt zde neznamená hostování našich
agentů nebo OpenConnectoru v Google Cloud. Tento návod neautorizuje billing,
centrální broker ani přesun uživatelských tokenů mimo Mašinu.

### Internal, External a chyba `403: org_internal`

Internal aplikace připouští jen účty své Google Workspace organizace.
Chyba `org_internal` proto neznamená chybný callback ani poruchu MCP serveru.
Pro účty mimo tuto organizaci potřebujeme vhodnou External aplikaci.
Neměň existující Internal aplikaci bez explicitního pokynu: může ji používat
jiná integrace. Bezpečný oddělený pilot dostane vlastní projekt a klienta.

External není synonymum pro hotovou produkční integraci. U zvolených Google
scopes mají External/Testing refresh tokeny standardně sedmidenní životnost.
Publikační stav, případné ověření aplikace, výjimky pro osobní použití a
Workspace administrátorské politiky je nutné ověřit podle konkrétního použití;
přepnutí stavu samo nezaručuje schválení Googlu ani neomezenou platnost tokenů.
[Google OAuth](https://developers.google.com/identity/protocols/oauth2),
[ověření restricted scopes](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification).

### Mac pilot versus distribuce Lazuria

Pilot řeší aplikaci pro známé účty jednoho Ownera a lokální custody.
Budoucí onboarding dalších Mašin musí zvlášť rozhodnout ownership OAuth
aplikace, typ klientů pro jednotlivé platformy, callbacky, případné Google
ověření, kvóty, revokaci a recovery. Společná registrace aplikace sama o sobě
neznamená společné uživatelské tokeny; granty mají zůstat per Mašina.
Privátní client secret se nesmí přibalit do veřejného forku ani rozesílat
na všechny Mašiny jako univerzální tajemství. Public fork sám není managed
OAuth služba a tyto otázky neřeší.

Google poskytuje také vlastní remote MCP pro Workspace, podle dokumentace
ověřené 2026-09-05 stále v Developer Preview. I tato cesta vyžaduje Cloud
projekt a OAuth konfiguraci. Pro tento pilot ji nezavádíme jako další přímé
napojení harnessů: OpenConnector zůstává společným vstupem a používá své
stávající Google providery. Případné použití Google MCP za OpenConnectorem
vyžaduje nejprve ověřit podporovaný upstream způsob; nepředpokládej automatické
přeposílání libovolného MCP serveru.
[Google Workspace MCP](https://developers.google.com/workspace/guides/configure-mcp-servers).

### Aktivační kontrola

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

### Direct client authentication

The pilot uses the officially supported local HTTP-header helper contract:
Codex `http_headers_helper` and Claude Code `headersHelper`. Each invokes the
installed worker with `--headers codex` or `--headers claude`, which reads only
that client's separately revocable runtime credential from local custody.
Its stdout is a secret protocol channel consumed by the harness: do not run
the helper interactively or log its output. User configuration contains only
the helper command and localhost URL, never a bearer token. There is no MCP
relay and no dependency on a GUI process inheriting environment variables.

Use Codex `default_tools_approval_mode = "prompt"` and Claude Code an `ask`
rule for `mcp__lazurio_open_connector__execute_action`. Do not blanket-allow
the execution tool. OAuth grants remain broader than the explicit runtime
action and connection allowlists edited in the upstream console.

References: [Codex MCP](https://learn.chatgpt.com/docs/extend/mcp),
[Claude Code dynamic headers](https://code.claude.com/docs/en/mcp#use-dynamic-headers-for-custom-authentication).
