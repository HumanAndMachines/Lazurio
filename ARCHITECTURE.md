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

> **Owner vlastní Mašinu, na Mašině žije Resident, Agenti na ní vykonávají
> práci a Lazurio systém distribuuje a koordinuje, aniž musí stát mezi Ownerem
> a jeho Residentem.**

```text
Owner
└── Machine                         jedna bezpečnostní hranice
    ├── Resident                    dlouhodobá identita a mandát
    └── Agent sessions              dočasní vykonavatelé práce

Lazurio                             distribuce, životní cyklus a koordinace
```

## Základní pojmy

| Pojem | Význam |
| --- | --- |
| **Owner** | Člověk nebo Organizace, která vlastní Mašinu, její data, přístupy a poslední cestu obnovy. |
| **Machine (Mašina)** | Počítač, VPS nebo hostovaný pracovní prostor, který tvoří jednu bezpečnostní hranici. |
| **Resident** | Dlouhodobá digitální identita s kontinuitou, pamětí a mandátem. Buddy a AI Kolega jsou dva profily Residenta. |
| **Task Agent** | Dočasná pracovní relace pro konkrétní úkol, například Codex, Claude Code nebo Cursor. V běžné řeči se může zkrátit na „Agent“. |
| **Organizace** | Jedna firma, jedna GitHub Organization a jedna access hranice. |
| **Personalspace** | Privátní prostor právě jednoho Principála a jeho případného Buddyho. |
| **Modul** | Verzovaná pracovní schopnost uvnitř Organizace nebo Personalspace. Může, ale nemusí obsahovat spustitelnou aplikaci. |

Principál je ten, pro koho Agent právě pracuje. V osobním prostředí bývá
Principál současně Ownerem. V Organizaci rozhodují jeho skutečná oprávnění u
poskytovatelů, ne textový název role.

## Pevná pravidla systému

### 1. Jedna Mašina je jedna bezpečnostní hranice

Procesy s root nebo srovnatelnou autoritou mohou kompromitovat celou Mašinu.
Unixový účet, kontejner nebo aplikační profil uvnitř ní proto nejsou samy o
sobě tvrdou bezpečnostní hranicí. Pomáhají s pořádkem, obnovou a dohledatelností.

Více Residentů může sdílet Mašinu jen tehdy, když Owner vědomě přijímá společný
rozsah rizika. Pokud mají být skutečně oddělení, potřebují oddělené Mašiny nebo
rovnocenně silnou infrastrukturní izolaci.

### 2. Přístup drží existující poskytovatelé

- **GitHub** určuje členství, přístup k repozitářům, review a možnost
  publikovat.
- **Tailscale nebo jiná schválená přístupová vrstva** určuje síťový přístup.
- **Poskytovatel Mašiny** drží vlastnictví infrastruktury a cestu obnovy.

Lazurio tato oprávnění nekopíruje do druhého interního IAM. Lokální přítomnost
checkoutu také sama nedokazuje přístup u poskytovatele.

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

Každý Hosted Team Workspace se v tomto modelu počítá jako samostatná Machine.
Je to jedna sdílená vývojová dílna pro konkrétní Team:

- členové Teamu sdílejí soubory, procesy a síťový prostor;
- různé Team Workspaces jsou od sebe oddělené;
- individuální izolaci poskytne jednočlenný Team Workspace;
- uvnitř běží T3 Code, nástroje Agentů, Launchpad, checkouty a worktrees;
- řídicí infrastruktura, klíče poskytovatele, Tailscale/VPN sidecar a HTTPS ingress
  zůstávají mimo pracovní prostředí.

Supervisor udržuje pouze T3 Code a Launchpad. Vývojové procesy Modulů spouští a
zastavuje Launchpad. Dashboard pouze zpřístupňuje vstupy pracovního prostoru;
procesy Modulů neřídí. Per-module kontejnery, Docker-in-Docker a další
orchestrátor nejsou součástí tohoto modelu.

Hosted Team Workspace je privátní vývojové prostředí, ne produkční nasazení.
Hostovaný odkaz na aplikaci vede přes autentizovaný HTTPS/WSS ingress; interní
port Modulu se veřejně nevystavuje. Produkční aplikace se v Dashboardu mohou
objevit jen z ověřeného katalogu produkčních nasazení, nikdy ze seznamu
vývojových služeb Workspace.

## Runtime Modulu a porty

Port je součást verzovaného kontraktu Modulu. „Lease“ v tomto kontextu znamená
pojmenovanou rezervaci konkrétního listeneru.

`lazurio.runtime.v1` popisuje vývojový proces pro Launchpad a Doctor: příkaz,
listenery a health check. Není to kontrakt produkčního nasazení.

| Vrstva | Co vlastní |
| --- | --- |
| Organization manifest | Rozsah `module_port_pool` pro přidělení **nových** portů. Dnes jej nese `company.gen3.json`, cílově `lazurio.organization.json`. |
| `lazurio.module.json` | Přesný port, jeho název a seznam aplikací Modulu. Je jedinou autoritou konkrétního čísla. |
| `package.json#lazurio.runtime` | Příkaz, protokol, health check a odkaz na pojmenovaný lease. Číslo portu znovu neurčuje. |
| Launchpad | Při startu načte lease, předá host a port procesu a řídí jeho životní cyklus. Port nevymýšlí ani trvale neukládá. |
| Hosted infrastruktura | Ze stejné přesné revize zdroje odvodí proxy, subdoménu a interní cíl. Port nepřepisuje. |

Při přímém vývojářském startu načte aplikace lease sama z
`lazurio.module.json`. Při startu přes Launchpad dostane stejné hodnoty jako
procesní vstup a odmítne je, pokud s manifestem nesouhlasí.

Na jedné Mašině běží pro daného uživatele jeden sdílený Lazurio Server. Jeho
aktuální lokální adresu a obsluhovaný `root_id` drží jediný locator ve
standardním per-user state prostoru operačního systému (`Application Support`,
`XDG_STATE_HOME` nebo `LocalAppData`). Jde o ukazatel na Server, ne o registr
modulových portů; checkouty ani worktrees si proto nevytvářejí vlastní Server.

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

Kanonický source checkout slouží vývoji. Z reviewovaného commitu se sestaví
verzovaný non-Git Resident artefakt. Běžící runtime a měnitelná pracovní data
musí zůstat fyzicky oddělené:

- neměnný artefakt obsahuje Launchpad, CLI, kontrakty a profil;
- Organization checkouty, Personalspace a runtime data jsou samostatné
  měnitelné mounty;
- update nejdřív ověří nový artefakt, potom jej atomicky aktivuje;
- poslední zdravá verze zůstává dostupná pro rollback;
- běžící runtime se neaktualizuje přepisem vlastního source checkoutu.

Přesné rozhraní drží
[manuál immutable runtime](manual/lazurio-runtime-install-interface.md) a
[manuál aktualizace Residenta](manual/update-installed-resident.md).

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
