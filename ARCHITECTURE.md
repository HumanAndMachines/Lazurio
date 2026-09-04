# Architektura Lazuria

Tento dokument je krátká mapa cílového systému. Popisuje jeho hlavní části,
hranice a pravidla. Neobsahuje podrobný provozní postup ani úplný popis
současné implementace.

Při hledání odpovědi rozlišuj:

- **Formální rozhodnutí** drží [decision register](manual/decision-register.md).
  Pokud je s touto mapou v rozporu, musí se před změnou systému novelizovat.
- **Cílový model** popisuje tento dokument.
- **Aktuálně podporovaný stav** dokazují schémata, manifesty, kód a testy.
- **Pracovní postup Agentů** určuje `AGENTS.md` v příslušné oblasti.
- **Provozní detaily** patří do `manual/` a dokumentace konkrétního nástroje.

Výslovně vedená migrace může dočasně znamenat, že nasazený stav ještě cílovému
modelu neodpovídá. Dokumentace ale nesmí starý a cílový stav vydávat za dvě
rovnocenné architektury.

## Model v jedné větě

> **Owner vlastní Mašinu jako jednu runtime, bezpečnostní a recovery hranici.
> Resident na ní může dlouhodobě žít, Agenti na ní dočasně vykonávají práci a
> Lazurio systém distribuuje a koordinuje, aniž musí stát mezi Ownerem a jeho
> prostředím.**

```text
Owner
└── Machine                         jedna bezpečnostní hranice
    ├── Resident (volitelně)        dlouhodobá identita a mandát
    └── Agent sessions              dočasní vykonavatelé práce

Lazurio                             distribuce, životní cyklus a koordinace
```

## Základní pojmy

| Pojem | Význam |
| --- | --- |
| **Owner** | Člověk nebo Organizace, která vlastní Mašinu, její data, přístupy a poslední cestu obnovy. |
| **Machine (Mašina)** | Fyzické zařízení, virtuální server nebo providerem izolovaný hostovaný pracovní prostor, který Lazurio chápe jako jednu sdílenou runtime, bezpečnostní a recovery hranici se známým Ownerem. Není to třída hardwaru ani registrovaná identita. |
| **Resident** | Dlouhodobá digitální identita s kontinuitou, pamětí a mandátem. Buddy a AI Kolega jsou dva profily Residenta. |
| **Task Agent** | Dočasná pracovní relace pro konkrétní úkol, například Codex, Claude Code nebo Cursor. V běžné řeči se může zkrátit na „Agent“. |
| **Organizace** | Jedna firma, jedna GitHub Organization a jedna access hranice. |
| **Personalspace** | Privátní prostor právě jednoho Principála a jeho případného Buddyho. |
| **Modul** | Verzovaná pracovní schopnost uvnitř Organizace nebo Personalspace. Může, ale nemusí obsahovat spustitelnou aplikaci. |

Principál je ten, pro koho Agent právě pracuje. V osobním prostředí bývá
Principál současně Ownerem Mašiny. Ve sdíleném Hosted Team Workspace je
Ownerem Organizace a jednotliví Principálové jsou jeho oprávnění uživatelé;
používáním Mašiny její vlastnictví ani org-wide pravomoci nezískávají. V
Organizaci rozhodují jejich skutečná oprávnění u poskytovatelů, ne textový
název role.

## Pevná pravidla systému

### 1. Jedna Mašina je jedna bezpečnostní hranice

Mašinu určuje společný podporovaný rozsah dopadu, lokální runtime stav a cesta
obnovy, ne počet fyzických serverů. Lokální workstation, dedikovaný Buddy VPS
a celý Hosted Team Workspace proto mohou být třemi konkrétními druhy Mašiny.
Samotný proces, Modul, aplikace, worktree, browser, Unixový účet nebo libovolný
kontejner Mašinou nejsou.

Procesy s root nebo srovnatelnou autoritou mohou kompromitovat celou Mašinu.
Unixový účet, kontejner nebo aplikační profil uvnitř ní proto nejsou samy o
sobě tvrdou bezpečnostní hranicí. Hostovaný pracovní prostor se počítá jako
Mašina pouze tehdy, když jeho celý podporovaný infrastrukturní obal vymezuje
vlastní soubory, procesy, síť, credentials, lifecycle a obnovu a provider
vynucuje oddělení od sourozeneckých prostorů.

Více Residentů může sdílet Mašinu jen tehdy, když Owner vědomě přijímá společný
rozsah rizika. Pokud mají být skutečně oddělení, potřebují oddělené Mašiny nebo
rovnocenně silnou infrastrukturní izolaci.

Hranice mohou být vrstevnaté. Organization Host může být providerovou Mašinou
a současně hostit několik Mašin typu Hosted Team Workspace na tenantní vrstvě.
Pro Buildera a Agenta je nejbližší hranicí jeho Team Workspace; root nebo
srovnatelná autorita hostu ale zůstává vyšší doménou kompromitace a obnovy a
může ovlivnit všechny Workspaces na hostu. Izolace sourozeneckých Teamů proto
není tvrzením, že jsou izolované od oprávněného host operatora nebo provideru.

V komunikaci vždy používej konkrétní druh hranice: například „lokální Mašina
Kolegy“, „Buddy VPS“, „Hosted Team Workspace Mašina“ nebo „Organization Host
Mašina“. „Team Machine“ je nanejvýš hovorová zkratka pro Hosted Team Workspace,
ne další systémový objekt. Lazurio pro Mašiny nezavádí centrální registr,
vlastní IAM ani nový manifest; konkrétní hranici dokazují její podporovaný
profil a infrastruktura daného Ownera a provideru.

### 2. Přístup drží existující poskytovatelé

- **GitHub** určuje členství, přístup k repozitářům, review a možnost
  publikovat.
- **Tailscale nebo jiná schválená přístupová vrstva** určuje síťový přístup.
- **Poskytovatel Mašiny** drží vlastnictví infrastruktury a cestu obnovy.

Lazurio tato oprávnění nekopíruje do druhého interního IAM. Lokální přítomnost
checkoutu také sama nedokazuje přístup u poskytovatele.

Manifest interní Team pouze váže na neměnné ID odpovídajícího GitHub Teamu;
oprávnění z něj nevzniká. Builder readiness je explicitní čerstvý readback
GitHub účtu, Organization a Team membership a efektivního i Teamového grantu
na přesných aktivních Builder repozitářích. Běžný offline Doctor tento síťový
provider gate nepředstírá.

### 3. Resident a Agent jsou různé identity

Resident má dlouhodobý vztah, paměť a mandát. Agent dostane konkrétní úkol,
pracuje v ohraničené relaci a odevzdá atribuovaný výsledek. Resident může práci
Agentovi delegovat a Agent se může Residenta poradit; jejich identity se tím
neslučují.

### 4. Lazurio není povinný prostředník

Lazurio distribuuje software, drží kontrakty, Doctor, Launchpad, Guide a
životní cyklus. Nemá být povinnou cestou každé zprávy, inference nebo lokální
operace a nemá automaticky číst obsah Personalspace, GBrainu ani organizační
paměti.

Plný Resident musí po dočasném odpojení Lazuria dál komunikovat se svým
Ownerem, používat lokální paměť a nástroje a pracovat s již udělenými
přístupy u poskytovatelů.

## Buddy a AI Kolega

Buddy a AI Kolega používají stejný technický základ. Liší se vlastníkem,
mandátem a správou dat, ne odděleným vývojem runtime.

| Vlastnost | Buddy | AI Kolega |
| --- | --- | --- |
| Owner | jeden lidský Principál | Organizace |
| Mandát | osobní | pracovní a organizační |
| Paměť | osobní GBrain | organizačně svěřený GBrain |
| Síťová bezpečnostní hranice | Principálova | organizační |
| Přístupy | delegace Principála | granty Organizace |
| Technický základ | Resident runtime | stejný Resident runtime |

Buddyho smí oslovovat právě jeden lidský Principál přes privátní komunikační
rozhraní. Mašinu vlastní Principál a může ji měnit. Co smí běžící Agent dělat,
omezuje sandbox agentního runtime; Lazurio vedle něj nestaví druhý sandbox.
Proces omezený sandboxem jej zároveň nesmí vlastnit ani přepisovat.

Podrobný profil, instalaci a incidentní hranice popisuje
[manuál Residentů](manual/lazurio-resident-profiles.md). Pravidla pro práci s
hostovaným Buddym jsou v [manuálu hostovaného Buddyho](manual/hosted-buddy-vps.md).

## Pracovní prostory

Lokální a hostovaný Workspace mají pro Buildera stejný model: Lazurio root,
Organization checkouty, worktrees, nástroje Agentů, Launchpad a vývojové
procesy Modulů. Liší se infrastrukturním a síťovým obalem.

### Hosted Team Workspace

Každý Hosted Team Workspace se na tenantní vrstvě počítá jako samostatná
Machine. Ne proto, že obsahuje kontejner, ale proto, že celý podporovaný obal
Workspace vymezuje jednu sdílenou vývojovou dílnu pro konkrétní Team:

- členové Teamu sdílejí soubory, procesy a síťový prostor;
- různé Team Workspaces jsou od sebe oddělené na tenantní vrstvě;
- individuální izolaci poskytne jednočlenný Team Workspace;
- uvnitř běží T3 Code, nástroje Agentů, Launchpad, checkouty a worktrees;
- řídicí infrastruktura, klíče poskytovatele, Tailscale/VPN sidecar a HTTPS ingress
  zůstávají mimo pracovní prostředí.

Ownerem je Organizace; členové Teamu jsou oprávnění uživatelé sdílené Mašiny.
Workspace nepřebírá ani nemountuje jejich Personalspace. Organization Host
operator zůstává vyšší doménou obnovy a kompromitace, ale běžný Team ani jeho
Agent tím nezískává přístup k host OS, jinému Workspace nebo org-wide
credentials.

Supervisor udržuje pouze T3 Code a Launchpad. Vývojové procesy Modulů spouští a
zastavuje Launchpad. Dashboard pouze zpřístupňuje vstupy pracovního prostoru;
procesy Modulů neřídí. Per-module kontejnery, Docker-in-Docker a další
orchestrátor nejsou součástí tohoto modelu.

Hosted Team Workspace je privátní vývojové prostředí, ne produkční nasazení.
Hostovaný odkaz na aplikaci vede přes autentizovaný HTTPS/WSS ingress; interní
port Modulu se veřejně nevystavuje. Produkční aplikace se v Dashboardu mohou
objevit jen z ověřeného katalogu produkčních nasazení, nikdy ze seznamu
vývojových služeb Workspace.

Launchpad proto používá tři oddělené lifecycle profily:

- **localhost** je úsporná dílna. `Start` a `Open` spouštějí přesný `main` nebo
  worktree jen pro život aktuální Server instance. Kliknutí nevytváří trvalý
  intent; graceful shutdown ukončí celý spravovaný process tree a další start
  Launchpadu nic neobnovuje;
- **Hosted Team Workspace** je always-on dílna. Manifesty Organizace určují
  Team moduly a jejich výchozí Apps; Launchpad tuto množinu odvodí a po vlastní
  readiness ji udržuje asynchronně a izolovaně. Cold start vždy začíná z
  `main`; Builder smí v aktuální session přepnout Modul na Mission
  Control-owned worktree, ale kliknutí ani přepnutí nevytváří persistentní stav;
- **production** přijímá jen reprodukovatelný Build a běží na samostatném
  produkčním runtime. Team katalog, Launchpad proces ani worktree nejsou
  deployment input.

Machine-wide evidence odvozená ze Start/Open kliknutí není konfigurace žádného
z těchto profilů. Launchpad ji nevytváří ani nečte.

## Runtime Modulu a porty

Port je součást verzovaného kontraktu Modulu. „Lease“ v tomto kontextu znamená
pojmenovanou rezervaci konkrétního listeneru.

`lazurio.runtime.v1` popisuje vývojový proces pro Launchpad a Doctor: příkaz,
listenery a health check. Není to kontrakt produkčního nasazení.

| Vrstva | Co vlastní |
| --- | --- |
| Organization manifest | Rozsah `module_port_pool` pro přidělení **nových** portů. Kanonická authoring autorita je `lazurio.organization.json`; dosud nemigrovaný mount zůstává ve stavu `legacy` a `company.gen3.json` je po migraci jen parity-ověřená legacy compatibility projection. |
| `lazurio.module.json` | Přesný port, jeho název a seznam aplikací Modulu. Je jedinou autoritou konkrétního čísla. |
| `package.json#lazurio.runtime` | Příkaz, protokol, health check a odkaz na pojmenovaný lease. Číslo portu znovu neurčuje. |
| Launchpad | Při startu načte lease, předá host a port procesu a řídí jeho životní cyklus. Port nevymýšlí ani trvale neukládá. |
| Hosted infrastruktura | Ze stejné přesné revize zdroje odvodí proxy, subdoménu a interní cíl. Port nepřepisuje. |

Při přímém vývojářském startu načte aplikace lease sama z
`lazurio.module.json`. Při startu přes Launchpad dostane stejné hodnoty jako
procesní vstup a odmítne je, pokud s manifestem nesouhlasí.

Na jedné Mašině běží pro daného uživatele jeden sdílený Lazurio Server. Jeho
aktuální lokální adresu, obsluhovaný machine `root_id` a právě vybraný
`control_root_id` (main nebo konkrétní worktree) drží jediný locator ve
standardním per-user state prostoru operačního systému (`Application Support`,
`XDG_STATE_HOME` nebo `LocalAppData`). Jde o ukazatel na Server, ne o registr
modulových portů; změna control rootu nahradí tutéž sdílenou instanci, nevytvoří
druhý Server. Singleton nevynucuje hledání portů: Server po celou dobu života
drží per-user lifetime lease ve stejném state prostoru. Chybějící locator proto
nezruší důkaz, že Server stále běží, a další proces zůstane fail-closed.

Z toho plynou tato pravidla:

1. Přesný port je v Gitu právě jednou: v `lazurio.module.json` daného Modulu.
   Není v `.env`, náhradní hodnotě ve spouštěcím skriptu ani v centrálním
   registru Lazurio rootu.
2. `module_port_pool` je pouze přidělovač nových portů. Již používaný port se
   automaticky nepřečísluje, ani když leží mimo později zvolený pool.
3. Dvě různé Module ID v jedné Organizaci nesmějí vlastnit stejné číslo.
   Oddělené Organizace stejné číslo mít mohou; globální ani veřejný seznam
   portů napříč uživateli nevzniká.
4. Main, verze a worktrees stejného Modulu sdílejí jeho lease. Na jedné Mašině
   běží v jednu chvíli nejvýše jedna varianta.
5. Pokud na jedné lokální Mašině kolidují Moduly dvou namountovaných
   Organizací, Launchpad je nepřemapuje. Umožní potvrzené přepnutí z jedné
   konkrétní aplikace na druhou. Oddělené Hosted Team Workspaces mají vlastní
   síťové prostory, takže se jejich interní čísla neovlivní.
6. Změna již používaného portu je koordinovaná migrace. Musí současně
   aktualizovat module manifest a všechny navázané proxy, subdomény, VPN,
   hosting a monitoring kontrakty a ověřit jejich shodu.
7. Modul bez aplikace deklaruje prázdný seznam aplikací a žádný TCP lease.
   Root-local a Personalspace aplikace mohou mít vlastní `lazurio.module.json`,
   ale nepoužívají pool cizí ani syntetické Organizace.

`.env` zůstává určený pro lokální hodnoty Mašiny, které nejsou identitou
runtime. Podrobnou validaci manifestů, aktivních env souborů, kolizí a přebírání
procesu popisuje [dokumentace Launchpadu](launchpad/README.md). Migrační postup
je v [GEN2 → GEN3 runbooku](manual/gen2-to-gen3-migration.md).

## Konverzační a nástrojové povrchy

- **Zulip je chat s Residentem.** Nese jeho identitu, kontinuitu a mandát.
- **T3 Code nebo jiné agentní CLI je chat s Agenty na Mašině.** Slouží
  konkrétní práci, opravám a diagnostice.
- **Lazurio CLI je nástroj Agentů.** Promítá bezpečný kontext, Doctor a
  ohraničené vyhledávání. Není třetí identita, nový IAM ani nový datový store.

Když Resident nebo jeho chat nefunguje, opravuje jej Agent přímo na Mašině.
Podrobný aktuální kontrakt CLI je v [`lazurio/README.md`](lazurio/README.md).

## Source, instalace a aktualizace

Na localhost workstation existuje právě jeden pracovní Root přímo v home
uživatele Mašiny. Fresh a Managed target je `~/Lazurio` na macOS/Linuxu a
`%USERPROFILE%\Lazurio` na Windows. Lazurio podporuje dvě jeho podoby:

- **Source Root** je dnešní nasazený a podporovaný profil. Ověřený Lazurio Git
  checkout přímo v home je současně pracovní Root a může do řízené migrace
  zachovat svůj existující historický název složky.
- **Managed Root** je budoucí cílový profil. Canonical cesta je non-Git Root
  sestavený z immutable source jako přesný součin `resident profile × locale`:
  profil určuje například Buddyho nebo AI Kolegu a locale jazyk Root-owned
  generovaných instrukcí včetně `AGENTS.md`. Runtime vlastní immutable package
  mimo Root.

Výběr jazyka nemění strojové cesty ani identity. Top-level installer nemá root
picker a žádný profil nevytváří druhý aktivní Root. Přechodové rozpoznání
existujícího source entrypointu není uložená volba jiné cesty.

Root profil a provenance spuštěného CLI jsou dvě odlišné osy. Dnešní Source
Root používá source-linked `lazurio`. Budoucí Managed Root běžně používá
package-managed `lazurio`, ale developer smí stejnou CLI/Core implementaci
vědomě přelinkovat na jediný ověřený checkout
`<home>/Lazurio/development/Lazurio`. Package-only Managed profil source
checkout nepotřebuje a instalátor jej implicitně neklonuje. Generátor
nevytváří uvnitř Rootu další vendored kopii CLI nebo Launchpadu;
Organization checkouty se do zvoleného jazyka nikdy nepřekládají ani
nepřepisují: Organizace si jazyk svého repozitáře vlastní sama. Personalspace
a runtime data také zůstávají samostatné měnitelné mounty.

Launchpad locale je oproti tomu runtime preference prohlížeče, ne varianta
Rootu. Launchpad-owned copy je offline v párových katalozích; přednost má
explicitně uložená volba, potom podporovaný jazyk prohlížeče a nakonec český
fallback. Přepnutí reloadne stejnou URL a nemění scope ani běžící procesy.
Guide je součást stejného Launchpad surface: statická copy používá tytéž
katalogy a dlouhý Organization install runbook se načítá pro explicitní
`cs`/`en` locale z párových Root-owned zdrojů. Českou autoritou zůstává
`manual/organization-install.md`, anglickou projekcí
`distribution/locales/en/manual/organization-install.md`; chybějící nebo
neshodný locale zdroj skončí fail-closed a nikdy se potichu nenahradí češtinou.
Core a API zůstávají locale-neutral: poskytují stabilní reason kódy a parametry,
zatímco UI vlastní lidské error, warning a loading texty. Organization-owned
názvy, popisy, commit messages a technická evidence se zobrazují beze změny.

`lazurio install` je jediný konvergenční vstup pro oba profily. Nad Source
Rootem jej defaultně zachová a opraví jen podporovaný stav. Source → Managed
migrace bude explicitní volba Principála a zůstane nedostupná, dokud není
complete package-owned Launchpad/runtime, generátor a schema compatibility,
exact rollback i fyzický macOS/Linux/Windows acceptance. Ruční přesun Source
Rootu není podporovaný postup.

Hosted Resident profily mohou dál používat verzovaný immutable artefakt s
atomickou aktivací a rollbackem. Ani tam se běžící runtime neaktualizuje
přepisem source checkoutu a artefakt nesmí vytvořit druhou datovou autoritu.

Pracovní checkouty aktualizuje jediná explicitní akce `lazurio update`, kterou
volá CLI i tlačítko **Synchronizovat**. Postupuje shora dolů přes Lazurio,
Organization rooty a všechny spravované modulové checkouty na `main` — jak
org-level repa typu Mission Control, tak Workspace Moduly. Chybějící Workspace
Modul se materializuje z úplných Git souřadnic; chybějící root repo jen tehdy,
když manifest explicitně deklaruje `materialization:
doctor_managed_nested_repo`. Productionspace a root-space repository-db tím
autoritu nezískávají. Jedinou úzkou výjimkou je explicitní
`lazurio organization install`: po materializaci aktivního root-level parent
repozitáře smí jednorázově atomicky doplnit deklarovaný
`mission-control/db` `repository_db_mount`. Jakmile je deklarovaná Mission
Control app/data hranice neúplná, neaktivní nebo pod jiným materializačním
kontraktem, instalace fail-closed skončí jako blokovaná. Existující databázi pouze ověří;
nefetchuje ji, nefast-forwarduje a nezískává commit ani publish autoritu.
Dirty obsah primárního checkoutu nejdřív
uloží do ověřeného recovery stashe, který nikdy automaticky nevrací, a potom
použije jen fast-forward. Historii s lokálními commity nebo konfliktem
nepřepisuje — předá ji Agentovi.

Po skutečné změně source se obnovují pouze package rooty deklarovaných Apps v
dotčeném repozitáři. Autoritou je verzovaný lockfile, ne stáří souborů. První
pokus zachová existující `node_modules`; pokud selže, následuje jedna čistá
instalace po odstranění tohoto přesného odvozeného stromu. Selhání ani pád
procesu neobnovují starý cache: aplikace zůstane blokovaná, neúplný strom se
při dalším Repair znovu odstraní a frozen instalace se bezpečně zopakuje.
Běžící managed aplikaci Launchpad po dobu opravy zastaví a znovu spustí pouze
po ověřeném úspěchu. Neplatný lockfile je source chyba pro Agenta, ne důvod
vytvořit lokálně jinou verzi dependencies.

Hranice mutace a hledání balíčků je vždy přesný owning checkout. Relativní
`file:` dependency smí jako read-only zdroj ukázat i do jiného checkoutu uvnitř
téže Organizace (například na sdílené kontrakty), ale jen na přesně deklarovaný
kanonický adresář. Jeho package identita se připne spolu s manifestem a
lockfilem; každý symlink v cíli i instalovaném link-farmu musí zůstat uvnitř
přesného package cíle. Změna repozitáře, který tento cíl vlastní, zahrne do
post-update obnovy i jinak nezměněné App consumery. Cíl mimo Organizaci nebo
změna autority během instalace jsou fail-closed. Personalspace, template a
obecné repo package rooty tuto Organization výjimku nezískávají.

Přesný technický důvod selhání aktualizace patří do API, CLI a Doctoru pro
Agenty. Běžný Launchpad jej nikdy nevypisuje přímo: stabilní reason kódy
promítá do vlastní lidské copy a stav bez smysluplné uživatelské akce na
denní ploše nezobrazuje.

Přesné rozhraní drží
[manuál immutable runtime](manual/lazurio-runtime-install-interface.md) a
[manuál aktualizace Residenta](manual/update-installed-resident.md). Praktický
workstation postup pro Task Agenty drží
[manuál Lazurio Rootu](manual/lazurio-root-for-agents.md).

## Produkce je oddělený systém

Vývojová aplikace v Launchpadu ani Hosted Team Workspace není produkční
nasazení. Produkční cesta začíná chráněným source commitem nebo tagem, vytvoří
reprodukovatelný neměnný (immutable) artefakt a spustí jej v izolovaném
produkčním runtime.

Produkce musí samostatně určit ingress (`public | authenticated | internal`),
autentizaci a autorizaci aplikace, secrets, data, zálohy,
rollback a dohled. Neobsahuje T3 Code, Codex, Launchpad, dev checkouty
ani worktrees. Konkrétní produkční topologie vyžaduje vlastní kontrakt.

## Kde žije která pravda

| Druh informace | Kanonický domov |
| --- | --- |
| Konverzace Residenta | Zulip |
| Dlouhodobá znalost Residenta | GBrain |
| Software, dokumentace a review | GitHub |
| Plán, stav a odpovědnost | Mission Control |
| Provozní a obnovitelný runtime stav | Machine |
| Důvod zásadního rozhodnutí | decision record |

Tyto vrstvy se nekopírují automaticky jedna do druhé. GBrain není kopie
Mission Controlu, Zulip není task ledger a Lazurio není vzdálený sklad veškeré
paměti Residenta.

## Generace nejsou produkty

GEN2 je ověřovací kohorta a GEN3 první veřejně opakovatelná distribuce.
Dlouhodobé názvy produktu jsou Lazurio, Buddy a AI Kolega. Generační označení
může zůstat v historii a migračních formátech, ale není samostatnou vrstvou
architektury.

## Kontrola nového návrhu

Nový návrh musí umět jednoduše odpovědět:

1. Kdo je Owner?
2. Která Machine tvoří společnou bezpečnostní hranici?
3. Kdo je Resident a jaký má mandát?
4. Který Agent vykonává práci a komu se výsledek připíše?
5. Který provider vynucuje přístup?
6. Kde bude trvalý výsledek a kde paměť?
7. Funguje Resident dál, když Lazurio není dostupné?
8. Řeší nový mechanismus konkrétní problém?

Pokud odpovědi vyžadují další skryté autority, registry nebo identity, návrh
ještě není dost jednoduchý.

## Další mapy a kontrakty

- [MAP.md](MAP.md) — co v Lazurio rootu leží a kam změna patří.
- [Launchpad README](launchpad/README.md) — discovery, procesy a runtime
  kontrakt Modulů.
- [Manifest family](manual/lazurio-manifest-family.md) — návrh přechodu z
  generačních názvů manifestů na rodinu `lazurio.*.json`.
- [Resident profiles](manual/lazurio-resident-profiles.md) — Buddy, AI Kolega,
  instalovaný root a provozní hranice.
- [AGENTS.md](AGENTS.md) — pravidla spolupráce, pravomoci a publikace.
