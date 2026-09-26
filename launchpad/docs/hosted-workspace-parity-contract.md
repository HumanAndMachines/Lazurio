# Hosted Workspace machine parity contract

> **Stav (2026-09-18):** hosted identita Launchpadu je přepnutá na model
> decision 0146 (`manual/decision-register.md`): každá aplikace běží na kořeni
> vlastního hostname `https://<app>.<machine>.<domain>/` (dílna = hostovaná VM,
> jen z tailnetu), produkční workspace aplikace na `<app>.<org>.lazurio.io`,
> bare hostname VM je rozcestník. Pre-0146 tvar `<module>.<team>.<domain>` a
> jeho path routing jsou **superseded**; tento dokument dál platí jen pro
> parity rozsah synchronizace, jednu logickou Builder mašinu, runner a
> infra důkazy. Vstup, TLS, admission a diagnostiku hostname vlastní Machines:
> `productionspace/Machines/docs/workspace-application-entry.md` (sekce „What
> the application must do“) a `workloads/workspace-vm/routes.mjs`.

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
- společná lowercase DNS zóna v `LAZURIO_HOSTED_DOMAIN`;
- label Mašiny: `LAZURIO_HOSTED_MACHINE`, nebo odvozený z
  `LAZURIO_LAUNCHPAD_EXTERNAL_ORIGIN=https://launchpad.<machine>.<domain>`
  (při obou musí souhlasit; bez platného labelu start selže).

Externí App URL je vždy odvozená jako `https://<module>.<machine>.<domain>/`
(decision 0146); spuštěný modul dostane stejný origin v klíčovaném
`LAZURIO_RUNTIME_LISTENER_<ID>_EXTERNAL_ORIGIN` svého vstupního listeneru a
v generickém aliasu `LAZURIO_RUNTIME_EXTERNAL_ORIGIN`. Service catalog, revision, per-App desired
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
  --hosted-domain <shared-lowercase-dns-domain> \
  --machine <vm-label> \
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
internal GET `/api/internal/hosted/modules/<module-slug>/ensure` (nebo
`/api/internal/hosted/apps/<exact-app-id>/ensure` pro Organization Team), až
potom původní proxy request. Module-slug forma je kanonická pro gateway katalog,
který zná jen `id` z `lazurio.module.json`; Launchpad z něj vybere výchozí App
Modulu stejnou selekcí jako maintenance, v Organization Teamu i na osobní
Mašině. Interní namespace musí proxy blokovat (404) na všech veřejných
hostnames. Subrequest předává pouze přesnou Team/owner cookie, loopback Host a
gatewayí nastavené `Origin: <Launchpad external origin>` a
`Sec-Fetch-Site: same-origin`; Launchpad na něj vždy uplatní striktní hosted
pravidlo (Origin + same-origin + znovu ověřená podepsaná relace), nikdy
uvolněné pravidlo pro čtení. Identity hlavička není autorizace. Předaný
`Sec-Fetch-Mode` je jen lifecycle hint: `navigate` nebo chybějící hodnota je
Open a spustí i explicitně zastavenou App, ostatní režimy a WebSocket
reconnect App nespustí. Endpoint vrací 204 jen při zdravé App, 404 pro
neznámý nebo nevybraný Modul, jinak 503 s omezeným tělem bez interních adres.

Hosted Personalspace lane (inventář, lifecycle úspěchy i chyby) prochází
jednou fail-closed projekcí typu allowlist: URL pole (`url`, `*_url`) smí nést
jen přesné veřejné HTTPS originy této Mašiny (vybrané Apps, Launchpad, T3)
plus čistou cestu — query a fragment se vždy zahodí a cesta, jejíž dekódovaná
podoba nese URL, schéma, adresní literál, `host:port` nebo řídicí znak, dává
`null`; `host` je vždy `null`; v ostatním textu se nahradí každá URL
libovolného schématu i každý IPv4/IPv6 nebo `host:port` literál, i když je
percent-encoded; `message`
je jeden ohraničený řádek bez log tailu a řídicích znaků; `details`, logy a
stack se nevracejí. Chyby mají tvar `{ error, message, app_id?, status? }`.
Obsah poznámek gbrain je vědomá výjimka a zůstává beze změny. Původní path,
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
