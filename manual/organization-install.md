# Organization install pro Agenty

Tento postup přidá do existujícího Lazurio Rootu už aktivní GitHub Organization,
ke které má přihlášený uživatel read access. Je stejný pro veřejnou referenční,
privátní klientskou i vlastní Organization; CLI nezná žádnou jmennou výjimku.

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
materializuje už aktivní Organizaci přes `lazurio organization install`, které
ověřuje jeho vlastní read access k rootu a Modulům.

## Předpoklady

- produkční nebo development-linked příkaz `lazurio` je v `PATH`;
- Git, přesně pinovaný Bun a GitHub CLI jsou dostupné v `PATH` nového čistého
  procesu;
- `gh auth status --hostname github.com` potvrzuje správný účet;
- Organization owner už dokončil jednorázovou aktivaci `Lazurio for GitHub`;
- kanonický Lazurio Root `<home>/Lazurio` už prošel `lazurio install` a má
  skutečnou složku `organizations/`;
- Organization root repo `<login>/<login>_GEN3` existuje na `main`, obsahuje
  validní Forge binding a uživatel jej může číst.

Příkaz je local-only. Nikdy nevytváří nebo nemění GitHub repo, GitHub App grant,
Team membership, branch rules, visibility, port ani commit. K založení remote
Organization slouží oddělený explicitní activation postup.

## Toolchain gate před Organization scope

Instalovaná binárka ještě není připravený nástroj. Onboarding nesmí pokračovat
jen proto, že instalační skript umí spustit Bun absolutní cestou nebo že právě
běžící terminál zdědil dočasně rozšířený `PATH`. Před materializací Organizace
musí nový čistý proces najít příkazy `bun`, `git`, `gh`, `codex` a následně
`lazurio`; u SSH remote musí fungovat i Gitův SSH transport.

Machine toolchain vlastní top-level instalační tok, nikoli Organizace. Agent
nejdřív spustí `lazurio install --json` a při troubleshootingu také
`lazurio doctor --tool-updates --json`. Install Core odlišuje chybějící nástroj
od stavu `*_not_on_path`; přesnou podporovanou Bun verzi dál vlastní
`package.json#packageManager`.

Obsahuje-li instalační prompt explicitní mandát pro přesné nástroje a změnu
uživatelského `PATH`, Agent nezůstane u handoff warningu:

1. chybějící Git, GitHub CLI, Codex CLI nebo přesně pinovaný Bun nainstaluje
   výhradně oficiálním postupem pro zjištěnou platformu;
2. do uživatelského `PATH` doplní pouze skutečný instalační adresář chybějícího
   nástroje, zachová všechny existující položky a nevytvoří vazbu na task
   worktree;
3. bez dalšího souhlasu nemění system-wide `PATH`, neinstaluje systémový
   package manager, neupgraduje funkční cizí nástroje ani nepřepisuje shell
   profil nesouvisejícím obsahem;
4. zahodí dočasné PATH dědictví a z nového čistého procesu ověří příkazy
   `bun --version`, `git --version`, `gh --version`, `codex --version` a po
   registraci také `lazurio cli status --json`;
5. znovu spustí Install Core. Bun, Git ani GitHub CLI nesmí mít reason
   `*_not_on_path`; teprve potom pokračuje `lazurio organization install`.

Doporučený autorizační blok instalačního promptu je:

> Máš mé výslovné svolení nainstalovat chybějící Git, GitHub CLI, Codex CLI a
> přesně verzovaný Bun z jejich oficiálních zdrojů a změnit pouze můj
> uživatelský PATH tak, aby jejich skutečné instalační adresáře byly dostupné
> v novém čistém terminálu. Zachovej existující PATH. Neměň system-wide PATH,
> neinstaluj systémový package manager, neměň bezpečnostní nastavení ani
> neupgraduj jiné nástroje bez mého dalšího souhlasu.

Když prompt změnu `PATH` neautorizuje, Agent vrátí přesný instalační report a
vyžádá si souhlas; dočasná absolutní cesta není přípustný bypass gate.

## GitHub přihlášení není Git transport

`gh auth status` dokazuje API přihlášení, nikoli schopnost Gitu číst privátní
SSH remote. Onboarding proto provede přihlášení jen jednou a před
materializací ověří přesný root remote:

```sh
gh auth status --hostname github.com
git ls-remote --exit-code --heads -- \
  git@github.com:<login>/<login>_GEN3.git refs/heads/main
```

Pokud první příkaz selže, přihlas správný účet jednou přes oficiální
interaktivní `gh auth login --hostname github.com --git-protocol ssh --web`.
Pokud první příkaz uspěje a druhý ne, další `gh auth login` neopakuj: oprav
jednorázově SSH transport tohoto účtu standardním GitHub postupem. Nejdřív
ověř existující klíč a jeho vazbu na správný GitHub účet. Vytvoření nového SSH
klíče a jeho nahrání přes `gh ssh-key add` je změna přístupu a Agent ji smí
udělat jen s výslovným souhlasem Principála pro tuto mašinu a účet; privátní
klíč nikdy nevypisuje ani nevkládá do repozitáře. Potom zopakuje přesný
`git ls-remote`, ne celý login.

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
  a teprve potom spusť `lazurio organization install`.

Chce-li Principál bez dalšího přerušení autorizovat SSH bootstrap, prompt má
říct: „Pokud pro tento účet chybí použitelný SSH klíč, máš svolení vytvořit na
této Mašině nový ed25519 klíč, nahrát přes `gh ssh-key add` pouze jeho veřejnou
část na právě ověřený GitHub účet a ověřit exact Organization root. Privátní
klíč nikdy nevypisuj ani nekopíruj mimo standardní SSH custody této Mašiny.“

## Konvergentní postup

```sh
lazurio organization install <github-login> --json
lazurio organization install <github-login> --json
lazurio doctor
```

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
`blocked` — nesmí hlásit úspěšnou konvergenci s chybějícími daty.

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
