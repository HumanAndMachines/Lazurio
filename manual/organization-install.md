# Organization install pro Agenty

Tento postup přidá do existujícího Lazurio Rootu už aktivní GitHub Organization,
ke které má přihlášený uživatel read access. Je stejný pro veřejnou referenční,
privátní klientskou i vlastní Organization; CLI nezná žádnou jmennou výjimku.

## Krátký prompt pro novou Builder Mašinu

Následující blok je user-facing vstup pro Codex nebo jiného Task Agenta. Před
vložením nahraď `<github-organization>` přesným GitHub loginem Organizace.
Úplný bezpečnostní a diagnostický kontrakt zůstává v navazujících kapitolách
tohoto runbooku; krátký prompt jej nenahrazuje ani nerozšiřuje.

<!-- lazurio-guide:organization-install-short:start -->
> Připrav tuto Mašinu jako Lazurio Builder pro GitHub Organization
> `<github-organization>`. Nejdřív pouze čtením ověř platformu, aktuální účet,
> Git stav a živá oprávnění. Organization owner musí ještě před instalací této
> Mašiny nainstalovat GitHub App **Lazurio for GitHub** pro **All repositories**
> a dokončit jednorázovou aktivaci; jako Builder jeho `admin:org` kontrolu
> neopakuj ani z její nedostupnosti neodvozuj stav App.
>
> Máš mé výslovné svolení nainstalovat chybějící Git, GitHub CLI, Node.js LTS,
> Codex CLI a přesně verzovaný Bun z jejich oficiálních zdrojů a změnit pouze můj
> uživatelský `PATH` tak, aby jejich skutečné instalační adresáře byly dostupné
> v novém čistém terminálu. Zachovej existující `PATH`. Neměň system-wide
> `PATH`, package manager, bezpečnostní nastavení ani jiné verze nástrojů bez
> mého dalšího souhlasu. Codex CLI instaluj oficiálním OpenAI standalone
> instalátorem pro tuto platformu podle kapitoly „Codex CLI: instalace a aktualizace“;
> Homebrew, npm ani WinGet nejsou podmínkou ani překážkou: vyhovující instalaci zachovej.
>
> Pokud pro právě ověřený GitHub účet chybí použitelný SSH klíč, máš svolení
> vytvořit na této Mašině nový ed25519 klíč, nahrát přes GitHub CLI pouze jeho
> veřejnou část a uložit privátní klíč jen do standardní SSH custody této
> Mašiny. GitHub přihlášení spusť právě jednou přes
> `gh auth login --hostname github.com --git-protocol ssh --web`; drž živý
> proces, nech mě dokončit jediný osobní krok v čerstvě otevřené GitHub stránce
> a device kód, token ani privátní klíč nevypisuj do chatu, logu ani issue.
>
> Na Windows po každé autorizované WinGet instalaci obnov `PATH` pouze pro
> aktuální instalační proces z čerstvých Machine + User hodnot podle tohoto
> runbooku, aby šla bezpečně dokončit právě rozpracovaná operace. Pak mi napiš
> přesný resume bod, nech mě úplně ukončit všechna okna Codexu a po jeho novém
> spuštění pokračuj v tomto threadu. Hotový stav dokazuj až z relaunchnutého
> Codexu a jeho nového čistého procesu; nový terminál otevřený ze starého
> Codexu nestačí. Restart Windows použij jen jako fallback. Potom ověř
> správný GitHub účet, `git_protocol=ssh` a exact `git ls-remote` root repa
> `<github-organization>/<github-organization>_GEN3`.
>
> Spusť konvergentně `lazurio install --json`,
> `lazurio doctor --tool-updates --json`,
> `lazurio organization install <github-organization> --role builder --json`
> a finální
> `lazurio doctor`; všechny bezpečně opravitelné required nálezy v tomto
> mandátu vyřeš a kontroly opakuj. Přístupy, secrets ani cizí Organizace
> neměň. Aktivní scope určuje aktuální versioned Organization manifest. Když
> se s ním moje zadání nebo předaná evidence rozchází, nic tiše nepřepisuj ani
> nepřeskakuj: ukaž mi přesný rozpor a vyžádej moje rozhodnutí o navrhované
> změně. Nakonec spusť Launchpad stejnou podporovanou cestou, ověř health
> aktivních aplikací a předej matici `runtime ready` / `editing ready` /
> `publishing ready`. `READ` nikdy nevydávej za Builder-ready `WRITE`; access
> blocker pojmenuj přesným účtem, Teamem a repozitářem pro Organization ownera.
<!-- lazurio-guide:organization-install-short:end -->

### Volitelný rozšířený instalační mandát

Výchozí prompt nahoře zůstává nejmenší bezpečný mandát: instaluje chybějící
nástroje a mění jen User `PATH`. Principál, který vlastní nebo spravuje celou
Mašinu, může v tomtéž promptu vědomě povolit i úplnou system instalaci.
Rozšířený mandát není nový instalační profil ani trvalé nastavení Lazuria;
je to autorizace přesných externích změn pro aktuální instalační relaci.

Do promptu přidej pouze ty odstavce, jejichž dopad Principál skutečně schvaluje:

> Pro tuto Mašinu máš navíc mé výslovné svolení použít podporovaný
> systémový package manager, vyžádat standardní OS elevation a změnit User i
> Machine/system-wide `PATH`. Přidej jen canonical instalační adresáře
> jmenovaných nástrojů, zachovej ostatní platné položky a odstraň jen
> prokazatelně neplatný nebo stínící záznam téhož nástroje. Neobcházej UAC,
> device-management policy ani bezpečnostní ochranu Mašiny.
>
> Nainstaluj chybějící a aktualizuj existující Git, GitHub CLI a Codex CLI
> na aktuální oficiální stable a Node.js na aktuální podporované LTS. Bun
> nastav vždy na exact stabilní verzi deklarovanou aktuálním clean Lazurio
> `lazurio/package.json#packageManager`, i když upstream nabízí novější verzi.
> Codex CLI instaluj a aktualizuj oficiálním OpenAI standalone instalátorem.
> Pokud výslovně požádám o změnu způsobu instalace, smíš převést existující Homebrew/npm/WinGet instalaci
> na standalone: nejdřív ověř novou instalaci, pak odstraň pouze původní balíček
> Codex CLI a zachovej nastavení, přihlášení i historii.
> Preview, beta, nightly ani canary verze nepoužívej. Všechny bezpečně
> opravitelné required nálezy Install Core a Doctoru v tomto mandátu skutečně
> oprav a kontroly opakuj; nekonči pouhým reportem.
>
> Pokud během instalace reprodukuješ obecný Lazurio problém, máš svolení po
> kontrole otevřených i zavřených duplicit a sanitizaci vytvořit nebo doplnit
> GitHub Issue v `<installation-issue-repository>` a uvést jeho URL v handoffu.
> Nezveřejňuj secrets, Personalspace, lokální username ani
> Organization-specific data. Issue nezavírej, nepřiřazuj ani neprioritizuj.

`<installation-issue-repository>` musí být exact owning repo, ne obecný název.
Pro installer, CLI, Doctor, Launchpad a sdílený manuál je dnes
`HumanAndMachines/Lazurio`; Organization-specific nález do něj nepatří.
Publikační postup a sanitizaci drží
[`manual/github-issues.md`](github-issues.md).

Tento rozšířený mandát nepovoluje merge, release, source push, změnu GitHub
membership/Teamů ani instalaci GitHub App mimo výslovně určenou Organizaci.

## Co z GitHub Organization tvoří Lazurio Organization

Prvním konstitutivním krokem je instalace oficiální GitHub App
**Lazurio for GitHub** do cílové GitHub Organization. Pro běžný onboarding
Organization owner v GitHub installeru zvolí **All repositories**. Tím vznikne
provider-side vazba Organizace na Lazurio a budoucí repozitáře se nestanou
skrytým partial-access stavem. Dokud App chybí, ownerova read-only kontrola
vrací `github_app_installation_required` a vzdálená aktivace nesmí pokračovat.

`All repositories` je kanonický onboarding standard, ne druhý Lazurio ACL.
GitHub dál zůstává jedinou autoritou přístupů. Vědomě omezená instalace
**Only select repositories** je podporovaná scoped výjimka; musí zahrnovat
canonical Organization root a všechny repozitáře, které má Lazurio skutečně
obsluhovat, a její partial access se nikdy nesmí vydávat za plný Organization
scope.

GitHub App sama nenahrazuje source Organizace. Použitelná Lazurio Organization
má současně:

1. instalovanou `Lazurio for GitHub` App s ověřeným repository scope;
2. canonical root repo `<login>/<login>_GEN3` na `main` s validním Organization
   manifestem a immutable Forge bindingem;
3. lokální mount vytvořený až konvergentním příkazem
   `lazurio organization install`.

Po instalaci App ji **GitHub Organization owner** jednou ověří přes immutable
GitHub Organization ID:

```sh
lazurio organization activate --check --github-id <immutable-id> --json
```

Teprve ownerem pozorovaný výsledek `outcome: "active"`, odpovídající App
installation scope a validní root dokazují vzdálenou aktivaci. GitHub settings
stránka nebo textový název Organizace samy nejsou důkaz.

Tato aktivace je provider-side owner gate, ne krok na každé pracovní mašině.
Builder ji neopakuje a nepotřebuje `admin:org`: installations endpoint je pro
něj záměrně nepozorovatelný a GitHub může hranici vrátit jako HTTP 403 i skryté
404. Taková odpověď nedokazuje chybějící App ani rozbitý transport. Builder
materializuje už aktivní Organizaci přes
`lazurio organization install <github-login> --role builder`. Vedle read
přístupu tím před klonem prokáže i vlastní aktivní Organization a Team
membership a WRITE nebo vyšší oprávnění k Builder repozitářům.

## Předpoklady

- produkční nebo development-linked příkaz `lazurio` je v `PATH`;
- Git, přesně pinovaný Bun, podporovaný Node.js a GitHub CLI jsou dostupné
  v `PATH` nového čistého procesu;
- `gh auth status --hostname github.com` potvrzuje správný účet;
- Organization owner už dokončil jednorázovou aktivaci `Lazurio for GitHub`;
- kanonický Lazurio Root `<home>/Lazurio` už prošel `lazurio install` a má
  skutečnou složku `organizations/`;
- Organization root repo `<login>/<login>_GEN3` existuje na `main`, obsahuje
  validní Forge binding a uživatel jej může číst.

Příkaz je local-only. Nikdy nevytváří nebo nemění GitHub repo, GitHub App grant,
Team membership, branch rules, visibility, port ani commit. K založení remote
Organization slouží oddělený explicitní activation postup.

Interní Team slug není autorizační identita. Organization manifest jej pro
Builder gate mapuje přes `teams[].forge_binding` na
`lazurio.team-forge-binding.github.v0`, neměnné GitHub Team `id` a jeho
`asserted_slug`. Chybějící nebo přejmenovaná vazba je owner blocker, ne důvod
hádat Team podle display name. Kontrolují se Organization root a aktivní sloty
určené Builderovi; `planned_slot` a restricted/Admin-only sloty se záměrně
nezařazují.

## Toolchain gate před Organization scope

Instalovaná binárka ještě není připravený nástroj. Onboarding nesmí pokračovat
jen proto, že instalační skript umí spustit Bun absolutní cestou nebo že právě
běžící terminál zdědil dočasně rozšířený `PATH`. Před materializací Organizace
musí nový čistý proces najít příkazy `bun`, `git`, `gh`, `node`, `codex`
a následně `lazurio`; u SSH remote musí fungovat i Gitův SSH transport.

Machine toolchain vlastní top-level instalační tok, nikoli Organizace. Agent
nejdřív spustí `lazurio install --json` a při troubleshootingu také
`lazurio doctor --tool-updates --json`. Install Core odlišuje chybějící nástroj
od stavu `*_not_on_path`; přesnou podporovanou Bun verzi dál vlastní
`package.json#packageManager`. Podporovaný Node rozsah vlastní jedině
`lazurio/package.json#engines.node`; aktuálně je to `>=22.12.0`. Pro novou
Mašinu použij po výslovném souhlasu aktuální
[oficiální Node.js LTS](https://nodejs.org/en/download), nikoli vlastní
latest resolver nebo neznámý registry package. Install Core i Doctor spouštějí
`node --version` a stejný verzovaný rozsah vyhodnotí ještě před Organization
materializací.

### Windows: pokračování po WinGet ve stejné instalační relaci

WinGet zapisuje nový User `PATH`, ale už běžící PowerShell, Task Agent nebo
Explorer dál drží starý process snapshot. Po autorizované instalaci proto
instalační Agent v témže PowerShell procesu načte aktuální persistentní Machine
a User hodnoty a změní **jen process `PATH`**:

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

Tento krok nic nezapisuje do registru ani shell profilu a nepoužívá ručně
dohledaný verzovaný package adresář. Umožní instalační relaci pokračovat, ale
není finálním důkazem. Po dokončení právě rozpracované atomické operace Agent
do chatu zapíše přesný resume bod a Principál úplně ukončí Codex včetně všech
oken a znovu jej spustí. Teprve nový čistý proces z relaunchnutého Codexu musí
bez tohoto snippet najít tytéž příkazy. Nový terminál spuštěný starým Codexem
stále dědí jeho environment snapshot a nestačí. Jejich skutečnou identitu a
použitelnost následně ověří `lazurio install --json` a Doctor; pouhé
`Get-Command` nestačí. Odhlášení uživatele nebo restart Windows je až fallback,
pokud persistentní User/Machine hodnoty sedí, ale ani nový Codex je nevidí.

Git, GitHub CLI a Node.js smějí být i na Windows instalované bez admin práv.
Jejich umístění není omezené seznamem prefixů; platí společný kontrakt níže.

### Nástroje z PATH: kompatibilita před způsobem instalace

Homebrew není závislost instalace Lazuria. Nejprve ověř existující příkazy
v prostředí, ze kterého Lazurio skutečně běží. Doctor a Install Core používají
první nalezený executable v `PATH`, ověří jeho spuštění a podporovanou verzi.
Neprohledávají povolené instalační adresáře a při nefunkčním prvním příkazu
nevyberou potichu jinou instalaci. Absolutní cesta je diagnostika, nikoli
potvrzení původu nebo bezpečnosti balíčku.

Git potřebuje alespoň 2.31.0 (absolutní cesty z rev-parse), GitHub CLI 2.57.0
(ověření aktivního účtu). Jejich kanonický kontrakt drží
`lazurio/core/toolchain-lib.mjs`. Node minimum vlastní
`lazurio/package.json#engines.node`; Bun zůstává přesně pinovaný přes
`lazurio/package.json#packageManager`. Codex musí vrátit rozpoznatelnou
stabilní verzi svého CLI; Lazurio dnes nepoužívá funkci vyžadující novější
číselné minimum. Novější upstream release je samostatné doporučení v
`doctor --tool-updates`, ne automatický důvod k neúspěšnému běžnému Doctoru.

Instalační Agent zachová funkční Homebrew/npm, systémovou instalaci i správce
verzí. Instaluje nebo opravuje jen chybějící či nekompatibilní nástroj v uděleném
mandátu. Neinstaluje Homebrew jen proto, že jde o macOS. Shell alias dostupný
pouze v interaktivním terminálu nestačí: příkaz musí fungovat i z procesu
Lazuria. Symlinky a shimy jsou přípustné, pokud fungují také ve skutečném
consumerovi. Konfigurace správce verzí nesmí v jiném pracovním adresáři
vybrat nekompatibilní nástroj. Git konfigurace, přístupy, timeouty a izolace
Organizací zůstávají samostatnými kontrolami.

Na Windows se standardní npm `*.cmd` shim pro Node spouští přes jeho
ověřený JavaScript vstup a nativní `node.exe`, bez shellu. Zachovává se
přednost Node vedle shimu před Node z PATH. Musí odpovídat celý podporovaný
formát npm shimu i deklarace binárky v balíčku; vlastní příkazy, argumenty
interpretu a neznámé `*.bat` obálky se neinterpretují a skončí s diagnostikou.
Takovou obálku Agent neopravuje přepnutím na obecný shell ani výběrem jiné
instalace za zády uživatele.

### Codex CLI: instalace a aktualizace

Pro localhost workstation na macOS, Linuxu i Windows je výchozí cestou
[oficiální OpenAI standalone instalátor](https://developers.openai.com/codex/cli).
Instalaci i další aktualizace vlastní OpenAI; Lazurio na něj pouze naviguje.
Tím se dostupnost verze Codexu neodvíjí od aktualizace Homebrew casku.
Homebrew, npm ani WinGet nejsou povinné ani zakázané. Vyhovující existující
instalaci zachovej; standalone je doporučení pro chybějící Codex, nikoli
podmínka readiness. Immutable hosted Resident/Buddy piny mají vlastní lifecycle.

Na macOS a Linuxu použij pro instalaci i aktualizaci:

```sh
curl -fsSL https://chatgpt.com/codex/install.sh | sh
```

Na Windows použij pro instalaci i aktualizaci:

```powershell
powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/codex/install.ps1 | iex"
```

Použij aktuální oficiální stable, ne preview ani verzi napevno opsanou z manuálu.
Před spuštěním platí scoped instalační nebo aktualizační mandát pro Codex a
příslušnou vrstvu `PATH`. Už udělený mandát se nevyžaduje podruhé; chybí-li,
Agent nejdřív připraví přesnou nápravu a požádá Principála o souhlas.
Doctor ani `lazurio update` tento příkaz nikdy nespouštějí. `lazurio install`
zůstává reportem machine gate, ne instalátorem externího toolchainu.

**Existující Homebrew/npm/WinGet instalace.** Zjisti všechny příkazy `codex`
v `PATH`, jejich skutečné symlink cíle a správce původního balíčku. Samotná
verze nebo cesta `~/.local/bin/codex` neprokazuje standalone původ: i tato
cesta může být jen odkaz na Homebrew. Funkční starší instalace dál splňuje
runtime dostupnost; Doctor ji automaticky nepřevádí ani její původ nepotvrzuje.

Převod vyžaduje mandát i k odstranění přesného původního Codex balíčku.
Předem si zaznamenej původního správce, verzi a postup obnovy přesného balíčku.
Nejdřív nainstaluj standalone. Z výstupu oficiálního instalátoru zjisti jeho
skutečný instalační adresář a novou binárku spusť explicitní absolutní cestou
s `--version`. Rozbal celý řetězec symlinků a ověř, že cíl patří této
standalone instalaci a neleží v původním Homebrew/npm/WinGet balíčku.
Potom ověř, že běžný `codex` v novém procesu rozliší tutéž standalone binárku;
shodná verze dvou různých souborů nestačí. Při stínění oprav pouze již
autorizovanou vrstvu `PATH`. Nejasný původ nebo chybějící PATH mandát znamená
ponechat starý balíček a předat přesný nález.
Teprve po obou úspěšných probech odinstaluj původní Codex jeho skutečným správcem
(např. `brew uninstall --cask codex` nebo `npm uninstall -g @openai/codex`).
Pokud instalátor nabízí odstranění staré instalace před ověřením nové, odlož
je na tento krok. Neodstraňuj samotný package manager, Node ani jiné nástroje.
Nepoužívej purge/zap a nemaž `CODEX_HOME`, nastavení, přihlášení ani historii.
Při selhání nové instalace zachovej funkční původní instalaci a popiš nález;
nevytvářej vlastní fallback installer nebo wrapper.

Po instalaci i po odstranění starého balíčku ověř rozlišení příkazu a jeho
verzi v novém procesu: na macOS/Linuxu `command -v codex` a skutečný cíl
symlinku, na Windows `Get-Command codex -All`. Ověř `codex --version` a
`codex login status` bez čtení či vypisování credential souborů. Na Windows
obnov process `PATH` a dokonči úplný Codex relaunch podle předchozí kapitoly;
child shell staré relace nestačí. Pokud po odstranění starého balíčku příkaz
selže nebo míří jinam, vrať v uděleném mandátu funkční rozlišení na ověřenou
standalone binárku; pokud to nejde, obnov přesný původní balíček a jeho
původní PATH vazbu podle připraveného recovery kroku. Bez recovery mandátu
nic nehádej: zachovej standalone soubory i uživatelská data a vrať přesný
blokátor. Přechod nevydávej za hotový, dokud probe z nového procesu neprojde.
Nakonec zopakuj
`lazurio doctor --tool-updates --json`.

Windows instalátor vytváří viditelný nativní `codex.exe` a ověřuje jeho verzi.
Samotná `codex-x86_64-pc-windows-msvc.exe` nebo
`codex-aarch64-pc-windows-msvc.exe` na `PATH` není zelený stav.
Nevytvářej ad-hoc `codex.cmd`, nekopíruj target-specific binárku a nepřijímej
ji jako důkaz připravenosti. Doctor tento konkrétní WinGet stav pojmenuje,
ale záměrně jej neopravuje.

Obsahuje-li instalační prompt explicitní mandát pro přesné nástroje a změnu
User nebo Machine `PATH`, Agent nezůstane u handoff warningu:

1. chybějící Git, GitHub CLI, Node.js LTS, Codex CLI nebo přesně pinovaný Bun
   nainstaluje výhradně oficiálním postupem pro zjištěnou platformu;
2. do výslovně autorizovaného User nebo Machine `PATH` doplní pouze skutečný
   instalační adresář nástroje, zachová nesouvisející platné položky a
   nevytvoří vazbu na task worktree;
3. system-wide `PATH`, systémový package manager a upgrade existujícího
   nástroje použije jen tehdy, když prompt každou tuto kategorii výslovně
   povoluje; ani rozšířený mandát neopravňuje přepisovat nesouvisející shell
   profil nebo bezpečnostní nastavení;
4. po přesném resume handoffu úplně ukončí a znovu spustí Codex, zahodí tím
   dočasné PATH dědictví a z jeho nového čistého procesu ověří příkazy
   `bun --version`, `git --version`, `gh --version`, `node --version`,
   `codex --version` a po registraci také `lazurio cli status --json`;
5. znovu spustí Install Core. Bun, Git ani GitHub CLI nesmí mít reason
   `*_not_on_path` a Node musí splnit verzovaný rozsah; teprve potom pokračuje
   `lazurio organization install`.

Doporučený autorizační blok instalačního promptu je:

> Máš mé výslovné svolení nainstalovat chybějící Git, GitHub CLI, Node.js LTS,
> Codex CLI a přesně verzovaný Bun z jejich oficiálních zdrojů a změnit pouze můj
> uživatelský PATH tak, aby jejich skutečné instalační adresáře byly dostupné
> v novém čistém terminálu. Zachovej existující PATH. Neměň system-wide PATH,
> neinstaluj systémový package manager, neměň bezpečnostní nastavení ani
> neupgraduj jiné nástroje bez mého dalšího souhlasu. Pro Codex CLI použij
> oficiální OpenAI standalone instalátor podle kapitoly výše jako doporučenou cestu;
> existující vyhovující instalaci zachovej bez ohledu na jejího správce.

Když prompt změnu konkrétní vrstvy `PATH` neautorizuje, Agent vrátí přesný
instalační report a vyžádá si souhlas; User souhlas se neinterpretuje jako
Machine souhlas a dočasná absolutní cesta není přípustný bypass gate.

## GitHub přihlášení není Git transport

`gh auth status` dokazuje API přihlášení, nikoli schopnost Gitu číst privátní
SSH remote. Onboarding proto provede přihlášení jen jednou a před
materializací ověří přesný root remote:

```sh
gh auth status --hostname github.com
git ls-remote --exit-code --heads -- \
  git@github.com:<login>/<login>_GEN3.git refs/heads/main
```

Pokud první příkaz selže, přihlas správný účet **jednou** přes oficiální
interaktivní:

```sh
gh auth login --hostname github.com --git-protocol ssh --web
```

Volba `--git-protocol ssh` je součást téhož GitHub device/web párování. GitHub
CLI při loginu vyhledá existující SSH klíče a nabídne nahrání jejich veřejné
části; pokud žádný nenajde, nabídne vytvoření a nahrání nového. Agent tento
prompt smí potvrdit jen s níže uvedeným výslovným mandátem. Nespouští paralelně
druhý login, nevypisuje device kód do issue ani logu a po otevření autorizační
stránky jasně řekne Principálovi jediný čekající lidský krok. Po dokončení
stejné relace ověří:

```sh
gh auth status --hostname github.com
gh config get git_protocol --host github.com
git ls-remote --exit-code --heads -- \
  git@github.com:<login>/<login>_GEN3.git refs/heads/main
```

Tím jeden pairing založí API session i SSH Git cestu; `gh auth status` sám
stále není důkaz transportu. Pokud API login uspěje a exact `git ls-remote`
ne, další `gh auth login` neopakuj: oprav jednorázově SSH transport tohoto účtu
standardním GitHub postupem. Nejdřív ověř existující klíč a jeho vazbu na
správný GitHub účet. Samostatné `gh ssh-key add` použij jen jako repair již
přihlášeného účtu, ne jako druhý výchozí onboarding tok. Vytvoření nového SSH
klíče a jeho nahrání je změna přístupu a Agent ji smí udělat jen s výslovným
souhlasem Principála pro tuto mašinu a účet; privátní klíč nikdy nevypisuje ani
nevkládá do repozitáře. Potom zopakuje přesný `git ls-remote`, ne celý login.

Referenční chování drží oficiální dokumentace
[`gh auth login`](https://cli.github.com/manual/gh_auth_login). Samostatný
`ssh -T git@github.com` je jen doplňkový diagnostický probe a na úspěšné GitHub
autentizaci končí záměrně exit kódem 1; instalační gate proto rozhoduje podle
exact `git ls-remote`, ne podle samotného exit kódu `ssh -T`.

Stejný read-only preflight provádí `lazurio organization install` před klonem.
Reason `materialization_source_unavailable` proto znamená „ověř repo access a
deklarovaný Git transport“, ne „App zřejmě není nainstalovaná“.

Instalační prompt pro novou Builder Mašinu musí tuto hranici uvést výslovně:

- nepoužívej `organization activate --check` jako Builder gate a z odpovědi
  vyžadující `admin:org` neodvozuj stav App;
- při chybějícím SSH klíči smí Agent klíč vytvořit a nahrát **veřejnou** část
  na právě ověřený GitHub účet jen tehdy, když prompt obsahuje explicitní
  svolení k této přesné změně přístupu;
- po přihlášení nebo opravě klíče vždy ověř exact root pomocí `git ls-remote`
  a teprve potom spusť
  `lazurio organization install <github-login> --role builder`.

Chce-li Principál bez dalšího přerušení autorizovat SSH bootstrap, prompt má
říct: „Pokud pro tento účet chybí použitelný SSH klíč, máš svolení vytvořit na
této Mašině nový ed25519 klíč, nahrát přes `gh ssh-key add` pouze jeho veřejnou
část na právě ověřený GitHub účet a ověřit exact Organization root. Privátní
klíč nikdy nevypisuj ani nekopíruj mimo standardní SSH custody této Mašiny.“

## Konvergentní postup

```sh
lazurio organization install <github-login> --role builder --json
lazurio organization install <github-login> --role builder --json
lazurio doctor
```

Instalační Agent nekončí prvním výpisem. Vždy opakuje nápravu a read-only
ověření, dokud současně neplatí:

1. `lazurio install --json` má `status: "completed"`;
2. `lazurio doctor --tool-updates --json` nemá žádný required `fail`,
   `blocked` ani `incomplete`; chybějící nebo nečitelná verze povinného Gitu,
   GitHub CLI, Node.js či Codexu není warning, ale nedokončená instalace;
3. `lazurio organization install <github-login> --role builder --json` je
   `current` nebo bezpečně `updated`, `access.status` je `ready` a exact SSH
   root probe prošel;
4. finální `lazurio doctor` je zelený včetně všech deklarovaných podřízených
   doctorů.

Každý doporučený warning má v handoffu explicitní disposition: opraveno,
vědomě přijato Principálem, nebo blokováno chybějící pravomocí. Required nález
se pouze „vezme na vědomí“ nikdy. Po změně perzistentního PATH Agent spustí
novou Codex relaci a z ní čistý proces; na Windows nestačí nový terminál
otevřený ze starého Codexu ani Explorer se starým environment snapshotem.
Restart celých Windows je pouze fallback po neúspěšném Codex relaunchi.

## Windows bez Developer Mode

Lazurio ani OrganizationTemplate nesmějí pro `.claude/skills` vytvářet
symlink nebo junction. Kanonický source je `.agents/skills`; `.claude/skills`
je Git-tracked, byte-for-byte odvozený mirror ověřovaný
`bun run doctor:agent-skills`. Fresh checkout i každý worktree jej proto už
obsahuje a Windows **nemusí být přepnutý do Developer Mode**. Příkaz
`bun run repair:agent-skills` je záměrně no-write diagnostika: drift ani
chybějící mirror nepřepisuje, ale vrátí je Agentovi k explicitní
Git-reviewované opravě v task worktree.

Neřeš to gitignored lokální kopií: ta by po každém checkoutu a worktree
vyžadovala další materializační krok a dovolila by lokální drift. Diagnostická
lane nepřepisuje žádný obsah ani symlink/junction odhadem; každý konflikt vrátí
Agentovi k bezpečné opravě v owning repu.

CLI Root nevybírá ani neukládá jako další konfiguraci. Produkční instalace
vždy používá `~/Lazurio` na macOS/Linuxu a `%USERPROFILE%\\Lazurio` na
Windows. Tím mají lidé i Agenti jednu předvídatelnou cestu a absolutní cesta
současně nese uživatele Mašiny. `--root` proto tato operace nepřijímá.

První běh materializuje exact Organization root do
`organizations/<CanonicalLogin>_GEN3` a přes běžný update reconciler doplní
dostupné deklarované Moduly. Potom může tentýž explicitní installer atomicky
doplnit aktivní root-space `mission-control/db` s materializací
`repository_db_mount`, ale jen pod právě jedním deklarovaným a skutečně
materializovaným parent Git repozitářem. Ověří Organization-owned remote,
deklarovanou branch, Git ignore v parent repozitáři a bezpečnou fyzickou cestu.
Duplicitní legacy `repository_db` projekce není další autorita; rozhodují
normalizovaná Git pole slotu. Nemá-li deklarovaný Mission Control právě jeden
aktivní `mission-control/db` mount s tímto kontraktem, install skončí
`blocked` — nesmí hlásit úspěšnou konvergenci s chybějícími daty. Každý
čerstvě materializovaný checkout používá pro úvodní clone
`--single-branch`, ale před publikací dostane přesně jeden kanonický fetch
refspec `+refs/heads/*:refs/remotes/origin/*`. Následný update, review ani
Doctor proto nezdědí úzký refspec omezený jen na bootstrap branch.

Existující repository-db checkout installer nefetchuje ani nefast-forwarduje:
ověří pouze čistý exact Git root, remote a deklarovanou branch. Ongoing sync,
commit a publish zůstávají v repository-db workflow a obecný `lazurio update`
jej dál vynechává. Druhý běh musí být `current`, pokud se mezitím nezměnil
lokální stav. Agent rozhoduje podle stabilních polí `state`, `target.reason`
a vnořeného update reportu, ne podle lokalizované věty.

Veřejné stavy jsou pouze:

- `current` — root i dostupná deklarovaná hierarchie už odpovídají `main`;
- `updated` — alespoň jeden bezpečný checkout byl doplněn nebo fast-forwardnut;
- `blocked` — alespoň jedna část potřebuje přístup nebo bezpečnou nápravu.

`blocked` neznamená rollback už ověřených checkoutů. Typickým případem je
private Modul, který přihlášený uživatel nevidí: dostupné Moduly zůstanou
nainstalované a report označí jen nedostupný slot. Po opravení GitHub accessu
Agent spustí stejný příkaz znovu.

## Kdy Agent nesmí stav opravovat odhadem

CLI failne před přepsáním dat, když cílová cesta:

- je symlink/junction alias, soubor nebo case-insensitive kolize;
- obsahuje dirty tracked či untracked změny;
- používá jiný GitHub origin nebo cizí Forge binding;
- nemá čistý checkout deklarované default branche;
- po fetchi obsahuje ahead/diverged historii nebo neplatný manifest.

V takovém případě zachovej všechny commity a soubory, pracuj v task worktree a
oprav přesnou příčinu. Nepoužívej `reset --hard`, force push ani ruční přesun
cizího checkoutu. Login je jen locator: immutable Organization a repository ID
se ověřují před klonem, ve stagingu i znovu před atomickým přesunem, takže rename
race nebo znovupoužitý namespace nemůže tiše nainstalovat cizí root.

Stejně fail-closed zůstane repository-db target, když jeho parent není přesný
Git root, `db/` není ignorované přímo v tomto parent repozitáři nebo existující
databáze obsahuje lokální změny či jiný remote/branch. Ignore Organization rootu
sám o sobě child databázi neautorizuje.

## Handoff

Do PR nebo instalačního reportu uveď exact CLI verzi, GitHub login, immutable
ID z JSON reportu, výsledný target, celkový stav a všechny blocked repo reasons.
Uveď také stav installer-managed `mission-control/db` mountu; `current` zde
dokazuje identitu a čistotu, nikoli online aktuálnost jeho datové branche.
Secrets, provider stderr ani obsah jiné Organization do reportu nekopíruj.

Reprodukovaný obecný problém Lazurio instalátoru reportuj podle
[`manual/github-issues.md`](github-issues.md) do
`HumanAndMachines/Lazurio`; Organization-specific problém patří do privátního
owning repa. Instalační Agent smí issue vytvořit nebo doplnit jen tehdy, když
prompt obsahuje explicitní publikační mandát pro tento repo. Jinak vrátí
sanitizovaný issue draft a exact cílový repo v handoffu.
