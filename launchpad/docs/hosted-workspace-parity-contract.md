# Hosted Workspace machine parity contract

Tento kontrakt je acceptance vstup pro Hosted Team Workspace lane. Ověřuje, že
localhost i hosted používají stejný builder-visible Lazurio filesystem,
discovery, module lease a Launchpad runtime. Nemění provider, DNS, ingress ani
access policy.

Jde o vývojovou dílnu, ne produkční deployment. `lazurio.runtime.v1` popisuje
runnable listenery pro Launchpad a Doctor, nikoli produkční kontrakt. Produkce
začíná chráněným source commitem nebo tagem, vytváří reprodukovatelný neměnný
(immutable) artefakt a nasazuje jej do izolovaného produkčního runtime s explicitním
`public | authenticated | internal` ingressem. Neobsahuje T3, Codex, Launchpad,
dev checkouty ani worktrees.

## Jedna logická Builder mašina

Hosted Team Workspace je jedna izolovaná logická Builder mašina pro jeden Team.
Sdílí jeden pracovní filesystem a procesovou i síťovou hranici mezi T3 Code,
Codex CLI, Launchpadem a jeho modulovými child procesy. Nemá napodobovat celý
fyzický localhost Kolegy a není to produkční jednotka; poskytuje jen stejné
vlastnosti vývojové dílny, na které Launchpad a Builder nástroje spoléhají.

Aktuální infra může tuto logickou mašinu realizovat jedním non-root pracovním
kontejnerem se společným `$HOME`, PID a network namespace. Kontejner je ale
implementační detail, ne druhá produktová autorita. Tenký init/supervisor
udržuje pouze T3 Code a Launchpad; App ids, source selection, URL mapping
ani module reconcile do něj nepatří. Dashboard Development projektuje pouze
stabilní vstupy do dílny a modulový lifecycle nevlastní. Produkční aplikace
projektuje jen z ověřeného deployment katalogu, nikdy z vývojového lifecycle
stavu Workspace.

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
  --organization <exact-company-slug> \
  --team <exact-team-slug> \
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

Parity důkaz nevyžaduje kontejner jako produktovou identitu. Vyžaduje, aby T3,
Codex, Launchpad a zdravý module child skutečně sdílely jednu logickou Builder
mašinu: stejný pracovní filesystem, identitu vlastníka a procesovou i síťovou
hranici. V současné kontejnerové implementaci to runner dokládá společným
UID/HOME/PID/network namespace. Jiná budoucí implementace, například VM, musí
prokázat stejné vlastnosti bez změny Launchpad kontraktu.

Runner současně odmítá Docker/Tailscale LocalAPI/Caddy admin socket, GitHub App
private key, host mount, efektivní Linux capabilities a passwordless sudo.

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
