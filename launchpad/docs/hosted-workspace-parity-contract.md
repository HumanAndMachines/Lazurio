# Hosted Workspace machine parity contract

Tento kontrakt je acceptance vstup pro Iotor a další Hosted Team Workspace
lane. Ověřuje, že localhost i hosted používají stejný builder-visible Lazurio
filesystem, discovery, module lease a Launchpad runtime. Nemění provider, DNS,
ingress ani access policy.

Jde o vývojovou dílnu, ne produkční deployment. `lazurio.runtime.v1` popisuje
runnable listenery pro Launchpad a Doctor, nikoli produkční kontrakt. Produkce
začíná chráněným source commitem nebo tagem, vytváří reprodukovatelný neměnný
(immutable) artefakt a nasazuje jej do izolovaného produkčního runtime s explicitním
`public | authenticated | internal` ingressem. Neobsahuje T3, Codex, Launchpad,
dev checkouty ani worktrees.

## Jedna runtime topologie

Team Workspace obsahuje jeden non-root pracovní kontejner se společným `$HOME`,
filesystemem, PID a network namespace pro T3 Code, Codex CLI, Launchpad a jeho
modulové child procesy. Tenký init/supervisor udržuje pouze T3 Code a Launchpad.
App ids, source selection, URL mapping ani module reconcile do něj nepatří.
Dashboard Development projektuje pouze stabilní vstupy T3 a Launchpadu a
modulový lifecycle nevlastní. Produkční aplikace projektuje jen z ověřeného
deployment katalogu, nikdy z vývojového lifecycle stavu Workspace.

Launchpad je jediný owner modulových procesů. Po vlastní readiness z Organization
manifestů odvodí všechny workspace moduly exact Teamu a výchozí App každého z
nich udržuje asynchronně. Chyba jednoho Modulu neblokuje ostatní. Na restartu
začne každý Modul z `main`; Builder může pro aktuální Launchpad session přepnout
Modul na exact Mission Control-owned worktree. Kliknutí se nepersistuje a hosted
`Stop` je odmítnutý.

Hosted identitu tvoří pouze:

- `LAZURIO_WORKSPACE_PROFILE=hosted`;
- exact `LAZURIO_ORGANIZATION_SLUG`;
- exact lowercase `LAZURIO_TEAM_ID`;
- společná lowercase DNS zóna v `LAZURIO_HOSTED_DOMAIN`.

Externí App URL je vždy odvozená jako
`https://<module>.<team>.<domain>/`. Service catalog, revision, per-App desired
state ani druhý lifecycle controller neexistují.

## Runner

Verzovaný runner `launchpad/src/workspace-parity-runner.mjs` se spouští stejně
lokálně i hosted:

```bash
bun run parity:workspace -- \
  --profile hosted \
  --phase live \
  --organization IotorLazurio_GEN3 \
  --app-id <default-team-app-id> \
  --worktree-slug <t3-created-canonical-slug> \
  --expected-worktree-created-by <t3-creation-identity> \
  --launchpad-url http://127.0.0.1:4174 \
  --expected-origin https://<module>.<team>.<domain>/ \
  --t3-pid <pid> \
  --codex-pid <pid> \
  --launchpad-pid <pid>
```

`live` ověří discovery, Doctor, static module lease, worktree provenienci,
`main → worktree → main → worktree` takeover na jediném module portu, odvozenou
URL a to, že hosted `Stop` vrátí `hosted_module_always_on`. Lokální profil může
na konci použít `--stop-after`; hosted ne.

Po restartu pracovního kontejneru i po host rebootu se spustí
`--phase post-restart`. Local profil musí prokázat, že session child nebyl
obnoven a module port je prázdný. Hosted profil musí bez `/open` prokázat zdravou
managed instanci z `main`, healthy maintenance a shodu maintenance s runtime
source. Starý worktree se po restartu obnovit nesmí.

## Security a infra důkaz

Runner uvnitř kontejneru vyžaduje společný UID/HOME/PID/network namespace pro
T3, Codex, Launchpad a zdravý module child. Současně odmítá Docker/Tailscale
LocalAPI/Caddy admin socket, GitHub App private key, host mount, efektivní Linux
capabilities a passwordless sudo.

Infra lane samostatně dokládá:

- autentizovaný Team HTTPS/WSS ingress na 443;
- privátní development dostupnost jen přes schválený Tailscale/VPN access plane;
- nedostupnost interních module portů klientům Tailnet/VPN;
- izolaci filesystemu, procesů a ingressu mezi Team Workspaces;
- server-side broker allowlist;
- skutečný host reboot před post-restart důkazem.

Infra lane připne exact centrální commit a přiloží oba JSON reporty i vnější
síťové důkazy ke gate `workspace_machine_parity_live_apply`. Tento centrální PR
sám žádný live apply neautorizuje.
