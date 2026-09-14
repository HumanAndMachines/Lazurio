# Hosted Workspace machine parity contract

## Rozsah synchronizace

CLI i Launchpad Sync používají existující ověřenou konfiguraci Hosted Workspace:
přesnou Organizaci a deklarovaný Team, nikoli OS username nebo nový access grant.
Aktualizují spravovaná root repa této Organizace a jen Workspace Moduly přiřazené
Teamu, včetně sdílených N:M modulů. Repozitářů ostatních Teamů se nedotknou,
ať už jsou přítomné nebo absentní. Lokální workstation si zachovává svůj rozsah.

Inventář zachovává deklarované Teamy a po aktualizaci Organization rootu je
ověřuje znovu. Chybějící Organizace, nedeklarovaný Team nebo neúplná hosted
konfigurace znamená blocked, nikoli návrat k neomezenému rozsahu. Chyby slotů
mimo rozsah lze vynechat jen při prokázaném přiřazení Organizace/Teamu; chyby
vybraných slotů a neklasifikovatelné chyby hranic dál blokují. Přístup stále
určuje GitHub a credential broker. Git chyba vybraného repozitáře se neskrývá
ani nevyvolává automatické rozšíření oprávnění.

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

## Cílový desktopový vstup

Model v `ARCHITECTURE.md` přidává nativní SSH vstup desktopového Codexu do
jednočlenné Dílny. Práce i přihlášení zůstávají vzdáleně; místní Lazurio není
potřeba. T3 může zůstat webovým vstupem.

Runner níže ověřuje současnou T3/Codex a modulovou paritu. Neprokazuje nové
SSH připojení, AI autentizaci, tunely ani pokračování po odpojení. Tyto vlastnosti
a migrace broker credentials potřebují vlastní důkaz. SSH do Dílny nesmí
zpřístupnit host OS nebo jinou Dílnu.

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
  --hosted-domain <shared-lowercase-dns-domain> \
  --t3-pid <pid> \
  --codex-pid <pid> \
  --launchpad-pid <pid>
```

`--organization` je exact `company.slug`, nikoli název mount adresáře. Runner
jeho cestu získá ze stejné scan-first discovery jako Launchpad, takže například
slug `Macano-Tech` korektně najde mount `organizations/Macano-Tech_GEN3` bez
druhého mapování.

`live` ověří discovery, Doctor, static module lease, worktree provenienci,
`main → worktree → main → worktree` takeover na jediném module portu,
odvozenou URL a skutečný Stop/reopen. Hosted výchozí Apps mají dostupný katalog,
ale běží pouze zvolená App; ostatní jsou stopped. Maintenance souhrn musí
souhlasit s přesnou odvozenou množinou a izolovanými neplatnými Moduly.

Po restartu (`--phase post-restart`) hosted profil nejprve prokáže studený
modul na `main`, pak jej otevře a prokáže zdravý proces. Ostatní Apps zůstanou
stopped. Starý worktree se neobnovuje. Local profil dál ověřuje prázdný port
bez obnovení session child.

Přímý odkaz musí mít samostatný actual ingress důkaz: ověření Team relace,
internal GET `/api/internal/hosted/apps/<exact-app-id>/ensure`, až potom
původní proxy request. Interní namespace musí proxy blokovat na všech veřejných
hostnames. Subrequest předává pouze přesnou Team cookie, loopback Host a
ověřovaný Launchpad Origin/Sec-Fetch-Site; identity hlavička není autorizace.
Endpoint vrací 204 jen při zdravé App, jinak chybu nebo 503. Původní path,
query, POST body a WebSocket upgrade se nesmí přepsat nebo opakovat. Starý
proxy config bez tohoto napojení není kvalifikovaný pro on-demand runtime;
source testy nenahrazují společný deploy a actual Caddy smoke.

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
