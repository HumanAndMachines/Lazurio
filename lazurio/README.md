# Lazurio CLI v0

Interní CLI je tenká fasáda nad kanonickým Lazurio Core a platformními
adaptéry. Nevytváří další identity, IAM, vlastní search engine ani druhý
lifecycle engine. `context` bezpečně promítá
Principála/Mašinu/Personalspace a na explicitní selektor jednu lokálně objevenou
Organizaci, `doctor` znovu používá existující Doctor core a `search` přidává
první explicitně omezený Organization pilot.

## Stav localhost instalace

Opakovatelný top-level příkaz má jednu dlouhodobou roli: znovu odvodit stav
mašiny, doplnit jen odsouhlasené chybějící části a vždy skončit reportem. První
slice je záměrně pouze read-only:

```sh
lazurio install --root <cesta>
lazurio install --root <cesta> --language en
lazurio install --root <cesta> --json
```

Source CLI bez explicitního `--root` kontroluje svůj source Root. Immutable npm
CLI bez uložené volby místo pádu vrátí `root_selection_required`. Společné Core
postupně ověří platformu, exact Bun runtime z
`package.json#packageManager`, Git, GitHub CLI, přihlášení ke github.com
a tvar Rootu; chyba jednoho probe nezastaví nezávislé kontroly a výstup nikdy
neobsahuje stdout ani stderr externího nástroje. JSON zůstává locale-neutral,
český a anglický terminálový report jsou jen dva rendery stejného výsledku.

Install report `lazurio.install.report.v1` i `lazurio doctor` uvádějí
aktuální a požadovanou Bun verzi. Odlišný patch, včetně novějšího dosud
nepromovaného vydání, je `action_required`/Doctor failure: Kolega tak
nedostane neotestovaný runtime jen proto, že vyšel. První read-only installer
Bun sám nemění. Agent nejdřív zjistí způsob instalace, vyžádá souhlas
s externí změnou a použije standardní upstream postup; `lazurio update`
runtime nikdy potichu nepřepisuje.

Při troubleshootingu může Agent výslovně přidat síťovou kontrolu aktuálnosti
vývojových nástrojů:

```sh
lazurio doctor --tool-updates
lazurio doctor --tool-updates --json
```

Git, GitHub CLI a nainstalované Codex CLI / Claude Code se porovnají
s oficiálním stabilním release zdrojem. Kontrola je pouze advisory: novější
verze je `warn` s `next_action: ask_principal_before_update`; Lazurio nikdy
nespustí updater, package manager ani instalační příkaz. Nedostupná síť vrátí
výslovné `currency_unknown` místo zeleného odhadu. Volitelný přepínač drží
běžný `lazurio doctor` rychlý a deterministický. Bun se dál posuzuje výhradně
proti `package.json#packageManager`, protože novější nepromovaná verze není
automaticky podporovaným Lazurio runtime.

Exit code `0` znamená připravený stav, `1` konkrétní akci uživatele a `2`
selhání kontroly. Tento slice nic neinstaluje, nevolá `lazurio cli install` ani
`lazurio launchpad install` a legacy Git Root nepřesouvá. Interaktivní consent a
writer kroky přijdou jako samostatné řezy nad stejným kontraktem; žádná workflow
databáze ani obecný provisioning engine nevzniká.

## Read-only aktivace Organization

První activation řez pouze pozoruje živý GitHub stav:

```sh
lazurio organization activate --check --github-id <immutable-id>
lazurio organization activate --check --github-id <immutable-id> --json
```

Příkaz nepotřebuje existující Lazurio Root. Přes trusted instalaci `gh` sváže
aktuální účet, Organization a oprávnění s immutable provider ID, ověří
`Lazurio for GitHub`, canonical `<login>_GEN3` root a jeho podporovaný manifest.
Core nad těmito fakty vrátí pouze `needs_activation`, `active` nebo
`action_required`. Absent/empty repo a legacy/current formát jsou pozorování a
reason kódy, ne další lifecycle stavy. Transportní nebo offline chyba používá
oddělený `execution.status: error` a žádný Organization outcome nehádá.

`--check` volá jen read-only GitHub API. Remote writer v tomto řezu veřejný
není a bez `--check` CLI skončí před provider voláním. Instalaci se scope
`all` lze ověřit přímo. U `selected` se CLI pokusí o standardní read endpoint;
pokud jej aktuální `gh` token nemůže číst, vrátí přesný
`verify_root_repository_access` místo broad App grantu, dalšího credential
store nebo falešného úspěchu. Současný remote resolver podporuje dnešní GEN3
identity pair. Canonical `lazurio.organization.json` zůstává fail-closed do
publikace společného DEV-6488 resolveru; activation si jeho parser nevymýšlí.

Exit code `0` znamená `active`, `1` znamená bezpečný další krok a `2`
technickou chybu. Veřejný tvar drží
`organization-activation-report.v0.schema.json`; `next_action.kind` je uzavřený
enum a nikdy nepřenáší shell příkaz.

## Module setup

Agenti nových i privátních Organizací používají jediný konvergentní vstup:

```sh
lazurio module setup <module-root> --root <lazurio-root>
lazurio module setup <module-root> --root <lazurio-root> --apply
```

Read-only běh vrací přesný plán; `--apply` tentýž plán znovu odvodí pod
Organization lockem, zapíše jej a ověří. Příkaz umí podporovaný legacy runtime,
explicitní `--no-app`, novou single App a vědomý `--adopt-port`. Nevytváří repo,
Organization slot ani druhou port registry. Stabilní JSON report
`lazurio.module_setup.report.v1` rozlišuje `current`, `actionable`, `completed`
a `action_required`; exit kódy jsou 0/1/2 a syntax/environment používá 3.
U `current` a post-apply `completed` obsahuje report také `runtime`: minimální
module-relative projekci Apps a materializovaných listenerů. Tenké legacy
adaptery smějí konzumovat pouze tento výstup package-managed CLI; manifest,
port lease ani názvy runtime proměnných samy neparsují. U neaplikovaného nebo
blokovaného stavu je `runtime: null`, takže jej nelze omylem spustit jako
platný stav.

Úplný postup pro private Module migraci, nový Modul, rerun a PR handoff drží
[veřejný Agent manuál](../manual/module-setup.md).

## Module lifecycle

CLI obsluhuje explicitně deklarované Apps přes jediný aktivní Lazurio Server:

```sh
lazurio module status --json
lazurio module open ExampleOrganization/website --json
lazurio module stop ExampleOrganization/website --app-package app/v2/package.json --json
```

Snapshot všech Apps vzniká jedním Server readbackem. Jednotlivá akce vybírá
výhradně Core-projektovanou default App nebo explicitní `--app-package` a
nikdy nečte legacy port registry. Cross-Organization takeover bez přesného
uživatelského potvrzení failne; potvrzený retry používá
`--confirm-replace <app-id>`. Chybějící Server je odlišný
`server_unavailable`, ne stojící App. Úplný verzovaný kontrakt a pravidla pro
tenké GEN2 klienty drží [Module lifecycle manuál](../manual/module-lifecycle.md).
CLI explicitně blokuje hosted mutace před POST; local a kompatibilní starší
Server zůstávají obslužné přes vlastní Server request-trust gate. Hosted
lifecycle zůstává za přihlášeným Dashboard/Launchpad surface.

## Oprava umístění Modulu po rename/transferu

`Synchronizovat` nejprve stáhne Organization manifest a zdravé checkouty dál
aktualizuje. Když stabilní module slug ukazuje na nový repository basename, ale
checkout podle `lazurio.module.json` zůstal ve staré složce, Lazurio pozastaví
jen tento slot. Nevytvoří druhý clone a starou složku samo v obecném update
flow nepřejmenuje.

Stejný no-clone guard přežije i další Sync nebo restart. Přímý Git checkout
bez čitelného autoritativního markeru zůstává konzervativním suspectem pro
každý skutečně volný nový target, i když se jeho basename liší od stabilního
slugu. Lazurio jej nikdy nepřiřadí ani nepřesune odhadem; současně tím
nekaranténuje zdravý sourozenec, který už má svůj přesný markerovaný checkout
nebo zavedený legacy adresář v deklarovaném targetu.

Agent používá dvoufázový repair:

```sh
lazurio repair module-location --org <organization> --module <stable-slug>
lazurio repair module-location --org <organization> --module <stable-slug> \
  --apply --expect <fingerprint-z-prvního-kroku>
lazurio update
```

První příkaz nic v pracovním stromu nemění. Najde checkout jen přes stabilní
marker identity, zkontroluje oba Organization manifesty, přesnou cílovou
cestu/remote, clean `main`, Git operace a skrytý index, shallow stav, linked
worktrees, target kolizi a shodu historie původního a nového remote. Vrátí
`ready` s přesným plánem a fingerprintem, `current`, nebo konkrétní `blocked`.
Manifesty smějí autorizovat mutaci pouze z Organization root checkoutu, který
je sám clean `main` a jeho `HEAD`, lokální `main` i cached `origin/main` jsou
shodné, jeho jediný `origin` odpovídá deklarovanému root repository a oba
manifesty jsou běžné trackované bloby právě tohoto `HEAD`. Stabilní Module
marker musí být stejně publikovaný blob Module `HEAD`; ignored/untracked nebo
symlinkovaný JSON nikdy není mutační autorita. Lokální Draft nebo stale root
nejdřív vyžaduje review/publikaci a `Synchronizovat`. Konfliktní či malformed
legacy/canonical remote a branch aliasy, non-main governance, foreign GitHub
owner i rozpor s `forge_binding` jsou Organization-scoped blocker, nikdy
implicitní volba podle pořadí polí. Přítomný `governance` musí být objekt a
je-li v něm `access_authority`, jediná platná hodnota je přesně `github`;
legacy absence pole zůstává kompatibilní.

`--apply` celý stav znovu odvodí pod stejným lockem jako update a přijme pouze
exact fingerprint. Jeho jediná mutace je změna `origin` a parent directory
rename s readbackem a rollbackem; nedělá clone, stash, reset, merge, rebase,
push ani delete. CLI tedy vlastní mechaniku a guardy. Agent vlastní úsudek:
ověří, že plán odpovídá záměru Organizace, a při dirty, ahead/diverged,
nejednoznačné identitě, cizím remote, worktrees nebo kolizi nic neobchází —
zachová data, vysvětlí blocker a vyřeší jej jako běžnou reviewovanou Git práci.
Po úspěchu spustí `lazurio update` a ověří postižený i zdravé sousední moduly
v Launchpadu. Opakovaný check/update je idempotentní.

Tento repair pokrývá přejmenování repozitáře nebo změnu GitHub owner/repo
souřadnic uvnitř téže Lazurio Organizace, pokud oba její manifesty už
reviewovaně deklarují nový `github_org`, remote a přesnou cestu. Přesun Modulu
mezi dvěma Lazurio Organizacemi automaticky nedetekuje ani neprovádí: stabilní
slug je jedinečný jen uvnitř Organization access hranice a není důkazem
cross-Organization identity. Remote s ownerem jiné Organization proto dostane
`slot_remote_owner_mismatch`, zůstane v karanténě a UI nabídne Agent review,
nikoli fingerprintovaný location repair. Agent musí nejprve reviewovaně
ustanovit cílovou Organization deklaraci a přístup a konkrétní lokální práci
vyřešit bez hádání; budoucí automatizace by potřebovala explicitní neměnnou
migrační identitu/token, ne shodu názvu nebo slugu.

## Instalace Launchpadu

Nejdřív zpřístupni CLI v uživatelském `PATH`:

```sh
bun run lazurio -- cli install
lazurio cli status
```

Instalace používá standardní Bun global link. Nevytváří vlastní shim,
neupravuje shell profily ani Windows registry a nepotřebuje admin práva nebo
certifikát. Bun global bin musí být v `PATH` už předem; když není, instalace
skončí před mutací s přesným návodem. Existing foreign `lazurio` command se
nespouští ani nepřepisuje. `install` je idempotentní a slouží i jako reinstall.
Veřejný self-uninstall ve v0 není: na Windows Bun launcher čeká na běžící CLI,
takže vlastní `.exe` nelze synchronně přesně odstranit bez druhého cleanup
mechanismu. Exact Bun unlink proto patří pozdějšímu machine updateru, který
neběží přes tento launcher.

Development link a Resident bez `--root` použijí Root vlastního entrypointu,
takže fungují z libovolného pracovního adresáře. Platformně neutrální npm
balíček je naopak pouze CLI code origin: dokud pozdější writer `lazurio install`
neuloží zvolený pracovní Root, rootové příkazy vyžadují explicitní `--root`.
`lazurio --version` vždy popisuje samotné spuštěné CLI a `--root` proto
nepřijímá. Linked task/PR worktree se permanentním PATH targetem stát nesmí.

Aktivní development override i budoucí immutable instalace publikují stejný
read-only provenance kontrakt:

```sh
lazurio --version
lazurio --version --json
```

Development verze se odvozuje přímo z aktuálního Git HEADu a pravdivě ukazuje
`clean`/`dirty`; nevytváří generovaný version soubor, který by mohl zestárnout.
Resident verze se čte z immutable `lazurio.resident.json`. Npm verze a exact
source commit se čtou z generovaného standardního `package.json`; tarball
integrity vlastní npm a Lazurio nevytváří druhý payload digest. Root s Git i
Resident markerem je explicitní konflikt a directory-only root bez manifestu
zůstává nerozpoznaný. `lazurio cli status --json` skládá stejnou provenance
vedle stávající instalační identity; její schéma `lazurio.cli.identity.v1` se
nemění.
Immutable provenance záměrně neobsahuje uživatelův distribuční track. Budoucí
`nightly`/`latest` je package-manager preference nad již vydanou verzí, ne
vlastnost payload bytes; historický Resident channel je proto pouze explicitní
`artifact.build_channel`.

Package gate sestavuje z čistého exact Git HEADu jeden source balíček bez
OS/arch variant, balí ho připnutým standardním npm packerem a instaluje
skutečný tarball přes Bun do izolovaného globálního prefixu. CI porovnává npm
integrity a inventory na macOS, Linuxu a Windows. Krátkodobé Actions artifacts
přenášejí mezi joby pouze malé JSON evidence; nejsou distribučním kanálem.
Tento gate nic nepublikuje na npm a source `package.json` zůstává `private`.

Potom lze samostatně nainstalovat desktop Launchpad:

```sh
# z vývojového/source checkoutu
bun run lazurio -- launchpad install

# po instalaci CLI do PATH
lazurio launchpad install
```

Příkaz je veřejným vlastníkem uživatelského záměru „nainstaluj lokální
Launchpad“. Na macOS spustí existující Bash instalátor; na Windows existující
PowerShell instalátor. Jejich validace rootu, bezpečná výměna, rollback,
historická migrace a platformní filesystem pravidla se v CLI neduplikují.
CLI dědí jejich výstup a vrací jejich exit code beze změny. Linux tento
desktop instalační slice zatím nepodporuje a skončí před mutací čitelnou
chybou.

`lazurio launchpad install` neprovádí Git update. `lazurio update` naopak
nemění desktop launcher. `--json` se u instalace nepřijímá, protože žádný
druhý strojový instalační protokol v tomto slice nevzniká.

Resident artefakt nese stejná package/bin metadata, ale jeho immutable
`active` switch zatím CLI link nepřepíná. Bun při linku připíná fyzickou
version cestu; atomický Resident switch + relink + rollback proto zůstává
samostatný updater krok, nikoli skrytá součást source instalace.

## Context kontrakt

```sh
# stručný lidský výstup; bez selektoru nečte Organization data
bun run lazurio -- context

# explicitně vybraná Organization; selektor je case-insensitive
bun run lazurio -- context --organization HumanAndMachine-ai
bun run lazurio -- context --organization humanandmachine-ai --json
```

Výstup vybrané Organizace vzniká z existujícího scan-first Launchpad read
modelu, lokálního Git inventáře a worktree indexu. Obsahuje Teamy, moduly,
objevené aplikace a vstupní body `AGENTS.md`, Mission Control a Knowledgebase.
Nevytváří nový registry ani druhý access model. Přítomnost checkoutu je pouze
lokální pozorování; Organization, Team, modul i aplikace proto vždy nesou
`access.status: not_evaluated`, dokud neproběhne živý provider readback.

Skutečný Modul navíc nese normalizované `apps`: stav deklarace, položky,
výchozí App a `open_target_app_id`. Hodnotu určuje výhradně Lazurio Core podle
kanonické cesty kořene Modulu. `declared` nikdy nepovýší jinou App, když je
deklarovaný default chybějící nebo nevalidní; `legacy-missing` zachovává
deterministický přechodový fallback, `explicit-none` znamená vědomé `apps: []`.
Launchpad i CLI čtou stejnou projekci a nevymýšlejí vlastní pořadí defaultu.

Selektor vrací právě jednu Organization v jejím objeveném casingu. Neznámý,
neplatný nebo nejednoznačný slug skončí chybou; Personalspace root Organization
selektor nepřijímá. Všechny publikované cesty mají jedinou bázi — Launchpad
root. JSON ani lidský výstup neobsahují absolutní lokální cesty.

## Search kontrakt

```sh
# živé fixed-string hledání; výchozí režim
bun run lazurio -- search "český dotaz"
bun run lazurio -- search "český dotaz" --json --limit 20

# diagnostika exact lane, QMD runtime a čerstvosti indexu
bun run lazurio -- search --status
bun run lazurio -- search --status --json

# lokální QMD index; --embed doplní vektory pro semantic/hybrid
bun run lazurio -- search --update
bun run lazurio -- search --update --embed
bun run lazurio -- search "záměr produktu" --mode lexical
bun run lazurio -- search "záměr produktu" --mode semantic
bun run lazurio -- search "záměr produktu" --mode hybrid
```

Strojové výsledky mají schema marker `lazurio.search.results.v1`, diagnostika
`lazurio.search.status.v1` a QMD adapter `lazurio.qmd.adapter.v1`. Každý hit
obsahuje relativní cestu a provenance: Organization, Principála, Team, scope,
source, repository a stav provider access. Absolutní lokální cesty se ve
výstupu nepublikují.

Akce jsou záměrně flagy `--status` a `--update`, ne rezervovaná slova v pozici
dotazu. `lazurio search status` i `lazurio search update` proto vždy provedou
živé exact hledání těchto slov; diagnostiku nebo lokální index mutation nelze
spustit nechtěnou kolizí s běžným dotazem.

Exact lane spouští `rg` samostatně v každém povoleném source. Používá
`--no-ignore-parent`, aby parent `.gitignore` Launchpad rootu neschoval
deklarovaný nested repo, ale nepoužívá `--no-ignore` ani plošný scan rootu.
Proto vidí čerstvou, dosud neindexovanou změnu a současně respektuje ignore
pravidla samotného source repa. `rg` je proto explicitní runtime závislost
exact lane; když chybí, status vrátí `not_evaluated` a QMD update nezapíše
falešný freshness fingerprint.

## Pilotní scope a hranice

Verzovaný registr [search-scopes.v1.json](search-scopes.v1.json) deklaruje
pilot `lazurio` pro Organization `HumanAndMachine-ai`, Team `lazurio` a
Principála `immakermatty`. Jediné zdroje jsou:

- repo `workspace/website-lazurio`;
- repo `workspace/design-system-lazurio`;
- explicitní subtree `workspace/knowledgebase/data/v2/lazurio-ai` uvnitř repo
  `workspace/knowledgebase`.

Každý source musí existovat v `modules.manifest.json`, patřit do Teamu
`lazurio`, být materializovaný Git repo nebo jeho explicitní subtree a projít
Launchpad containment kontrolami. Samotný název adresáře nic neautorizuje.

Personalspace, jiné Organizace, Organization templates, worktrees, `.git`,
`node_modules`, build/output/cache adresáře, `private/`, `secrets`, `.env`,
binární typy a symlinkované stromy se do pilotu nedostanou. Exact `rg` symlinky
nenásleduje a `--no-config` spolu s odstraněním `RIPGREP_CONFIG_PATH` brání
zděděné konfiguraci toto pravidlo přepsat. QMD standardně skenuje s
`followSymbolicLinks: false`; adapter
navíc fail-closed odmítne rozbitý symlink nebo target mimo deklarovaný source.
Bezpečný interní symlink přeskočí, takže nevytvoří duplicitu kanonického obsahu.
Každý QMD hit se před publikací znovu ověří proti aktuální source boundary:
excluded, chybějící, binární a symlinkované cesty se zahodí i tehdy, když je
stale lokální index ještě obsahuje.
Textové soubory s více filesystem linky (`nlink !== 1`) se odmítnou před exact
scanem i QMD indexací a znovu při publikaci hitu, takže hard link z cizího
scope nemůže přenést jeho bytes pod povolenou cestu.

`provider_access_status: not_evaluated` je záměrně pravdivý: lokální manifest a
mount nejsou živý GitHub provider readback. Pilot tedy prokazuje lokální scope,
nikoli obecný effective workspace nebo provider oprávnění.

## QMD adapter

QMD drží pro každou dvojici Organization/Principál samostatný pojmenovaný
config, SQLite index a Lazurio freshness state pod gitignored
`.cache/lazurio/qmd/`. Adapter nastavuje vlastní `QMD_CONFIG_DIR` a
`XDG_CACHE_HOME`; globální uživatelský QMD index nečte ani nemění.

Podporovaný kontrakt je QMD `>=2.5.3` a `<3.0.0`. Ověřuje se `qmd --version` a
`qmd status`; chybějící CLI, nepodporovaná verze, runtime chyba i známý Node
native ABI mismatch mají strukturovaný stav. Exact lane zůstává dostupná.
`search --update` zapisuje obsahově citlivý SHA-256 fingerprint cest a bytes
povolených textových souborů, podle nějž `search --status` rozliší `fresh`,
`stale`, `absent` a `not_evaluated`. Čerstvost smí potvrdit pouze stav s přesným
algoritmem `sha256-path-content-v1`; legacy nebo neznámý algoritmus je `stale`.
Adapter
porovná snapshot před a po QMD indexaci; pokud se source během update změní,
success state nezapíše a vyžádá bezpečné opakování.

Kontrakt byl 2026-08-10 porovnán s oficiální dokumentací QMD pro pojmenované
indexy, `QMD_CONFIG_DIR`, `XDG_CACHE_HOME`, config collections/ignore a příkazy
`search`, `vsearch`, `query`, `status`, `update`, `embed` a `doctor`:
[README](https://github.com/tobi/qmd/blob/main/README.md),
[CHANGELOG](https://github.com/tobi/qmd/blob/main/CHANGELOG.md). npm dist-tag
`latest` byl 2.5.3. Standardní macOS oprava nepodporované nebo ABI-rozbité
globální instalace je:

```sh
brew install sqlite
npm install -g @tobilu/qmd@latest
qmd --version
qmd doctor
```

QMD vyžaduje Node.js 22 nebo novější. Lazurio adapter globální instalaci sám
nemění; pouze ji diagnostikuje a exact režim nechává dostupný. Každý QMD child
process explicitně nastavuje izolované `QMD_CONFIG_DIR` a `XDG_CACHE_HOME` a
odstraňuje zděděný `INDEX_PATH`, který by jinak přesměroval SQLite databázi
mimo deklarovanou Organization/Principál boundary.

Launchpad pole „Hledat aplikaci“ zůstává filtrem karet. Search UI ani obecný
cross-Organization search nejsou součástí tohoto slice.
