# Lazurio Root pro Agenty

Tento stručný manuál je kanonický vstup pro Task Agenta, který instaluje,
diagnostikuje nebo vyvíjí localhost Lazurio. Nezavádí další instalační engine;
vede Agenta přes veřejné `lazurio` CLI a jeho jediné Install Core.

## Jeden Root v home, dva Root profily

Fresh a budoucí Managed Root se vždy odvozuje z home uživatele Mašiny:

| Platforma | Kanonický Root |
| --- | --- |
| macOS / Linux | `~/Lazurio` |
| Windows | `%USERPROFILE%\Lazurio` |

Lazurio veřejně rozlišuje právě dva filesystem profily:

- **Source Root** — dnešní podporovaný stav všech nasazených Mašin. Ověřený
  Lazurio Git checkout přímo v home je současně Root a drží instrukce,
  konfiguraci, data i oddělené Organization/Personalspace mounty. Existující
  instalace smí do migrace zachovat historický název složky, například
  `~/Conglomerate`.
- **Managed Root** — budoucí explicitní cíl. Canonical Root je generovaný
  non-Git adresář; runtime vlastní immutable package a volitelný Lazurio source
  checkout patří do `development/Lazurio`.

Toto přechodové rozpoznání existujícího source entrypointu není root picker ani
uložená alternativní cesta. Managed target zůstává přesně `<home>/Lazurio`.

Missing, dirty, foreign, partial ani podobné nálezy nejsou další profily. Jsou
to diagnostické reason kódy, které Agent řeší nad rozpoznaným profilem nebo
bezpečně předá jako nerozpoznaný vstup.

Na úplně fresh Source Mašině instaluj nejdřív jen chybějící oficiální Git,
naklonuj canonical Lazurio source do `<home>/Lazurio` a teprve z jeho
`lazurio/package.json#packageManager` přečti exact Bun pin. Neinstaluj obecný
latest Bun jako dočasný mezikrok; clone Bun nepotřebuje a následný downgrade by
jen přidal další chybnou mezifázi. Pokud source již existuje, nejdřív ověř jeho
identitu, branch a stav a cizí nebo dirty adresář nepřepisuj.

## Root profil není CLI provenance

Na localhost workstation má příkaz `lazurio` vždy právě jednu aktivní code
provenance:

- `source` — příkaz běží z ověřeného Git source;
- `package` — příkaz běží z immutable package.

Hostovaný Resident artefakt hlásí vlastní `resident` provenance. Je to
oddělený hosted lifecycle, nikoli třetí workstation Root profil nebo další
localhost instalace.

To není druhý seznam Root profilů. Dnešní Source Root přirozeně používá source
provenance. Budoucí Managed Root běžně používá package provenance, ale vývojář
jej smí vědomě přelinkovat na source checkout v `development/Lazurio`.
Zakázaná „druhá runtime kopie“ znamená skrytý vendor/generated klon vedle
aktivní package nebo source link provenance.

## Dnešní práce v Source Rootu

Source Root je podporovaný stav, ne rozbitá nebo zastaralá instalace. Agent
začne readbackem:

```sh
lazurio --version --json
lazurio doctor
```

Dnešní JSON uvádí `root_kind: "source"`, přesnou cestu, exact source commit a
clean/dirty stav. Před source prací Agent postupuje podle Root `AGENTS.md`: synchronizuje
primární checkout přes `lazurio update`, ověří `bun run doctor:task` a všechny
trackované změny připraví v task worktree. Primární Source Root zůstává na
`main`; není místem pro Draft.

Opakovaný `lazurio install` smí Source Root inspectovat a reconciliovat, ale
bez explicitní volby Principála jej nesmí migrovat ani označit za závadu jen
proto, že je Git checkout.

## Toolchain musí přežít instalační relaci

Přítomnost binárky ani `process.execPath` právě běžícího Bunu nedokazují, že je
Mašina připravená. Install Core proto vedle exact Bun verze ověřuje také příkaz
`bun` v `PATH`; u Gitu, GitHub CLI a Node.js rozlišuje nainstalovaný nástroj
od `git_not_on_path`, `github_cli_not_on_path` a
`node_runtime_not_on_path`. Git, `gh` ani `node` se nespustí, dokud příkaz z
`PATH` neodpovídá omezené sadě důvěryhodných instalačních cest. Na Windows tato
sada zahrnuje i explicitní user-scope cesty odvozené z home právě běžícího OS
účtu, včetně WinGet user command linku pro Node; ambientní `USERPROFILE`,
`LOCALAPPDATA` ani libovolná dřívější položka `PATH` tuto autoritu nemění. Běžný Doctor
navíc spouští z aktuálního PATH ověřený Bun, `bun x`, Git, `gh`, GitHub auth i
nastavený SSH protokol, Node v rozsahu z `lazurio/package.json#engines.node` a
`codex`.
Troubleshooting lane `lazurio doctor --tool-updates` ověří i čitelnou verzi a
aktuálnost povinných nástrojů; chybějící nebo nečitelný povinný nástroj je
required failure, zatímco pouhá dostupnost novější verze zůstává warningem a
vyžaduje rozhodnutí Principála.

Instalační mandát má explicitní rozsah, ne implicitní admin práva:

- výchozí nejmenší mandát dovoluje nainstalovat jmenované chybějící
  nástroje a doplnit jejich skutečné adresáře jen do User `PATH`;
- rozšířený mandát smí pro jednu instalaci navíc výslovně povolit standardní
  OS package manager, Machine/system-wide `PATH`, elevation a upgrade
  jmenovaných nástrojů;
- samostatný repo-specific publikační mandát smí Agentovi dovolit
  proaktivně vytvořit nebo doplnit sanitizované instalační GitHub Issues.

Agent provede jen kategorie skutečně povolené promptem. Existující platný PATH
zachová, task worktree do něj nikdy nezapíše a User souhlas nerozšíří na
Machine vrstvu. Git, GitHub CLI a Codex mohou s rozšířeným mandátem směřovat
na aktuální oficiální stable a Node na podporované aktuální LTS. Bun je
výjimka: vždy konverguje na exact verzi z
`lazurio/package.json#packageManager`, ne na obecný upstream latest. Výsledek
se na Windows ověří až po úplném ukončení a novém spuštění Codexu, v čistém
procesu této nové relace, nikoli v child shellu starého Codexu s dočasným
`export` nebo `$env:Path`. Před ukončením Agent zapíše do chatu přesný resume
bod. Odhlášení uživatele nebo restart Windows je pouze fallback, pokud nový
Codex správné persistentní User/Machine hodnoty stále nevidí.

Codex CLI na macOS, Linuxu i Windows instaluj a aktualizuj oficiálním OpenAI
standalone instalátorem; Homebrew, npm ani WinGet nejsou výchozí cesta Lazuria.
Přesné příkazy, scoped mandát, zachování nastavení/přihlášení a bezpečný převod
existující instalace drží
[Codex CLI: instalace a aktualizace](organization-install.md#codex-cli-instalace-a-aktualizace).
Doctor pouze naviguje na tento postup, neinstaluje nástroje a úspěšnou verzní
zkoušku nevydává za důkaz způsobu instalace.

Organization instalace tuto machine autoritu nepřebírá. Začíná až poté, co
top-level gate vidí Bun, Git, `gh` a kompatibilní Node.js v PATH a Doctor vidí
Codex; potom se registruje `lazurio` a z nového Codex procesu projde
`lazurio cli status --json`.
Přesný Builder postup a doporučený prompt blok drží
[`manual/organization-install.md`](organization-install.md).

## GitHub transport při workstation onboardingu

Úspěšné `gh auth status --hostname github.com` dokazuje GitHub API session,
nikoli Git transport pro privátní repozitáře. Agent se proto nepřihlašuje
opakovaně naslepo. Pro jednu cílovou Organizaci nejdřív přečte její install
postup a ověří exact canonical root remote přes `git ls-remote`; teprve tento
probe dokazuje, že zvolený HTTPS nebo SSH transport umí repo skutečně číst.

Nový účet páruj jednou přes
`gh auth login --hostname github.com --git-protocol ssh --web`. Tentýž flow
umí vybrat, vytvořit a nahrát veřejnou část SSH klíče; přístupovou změnu ale
musí instalační prompt výslovně autorizovat. Po pairing flow se vždy zvlášť
ověří `gh auth status`, nastavený Git protokol a exact `git ls-remote` cílového
Organization rootu.

Je-li deklarovaný privátní remote SSH a probe selže při platném `gh` loginu,
Agent ověří existující SSH klíč a vazbu na tentýž GitHub účet. Vytvoření nebo
nahrání nového klíče je změna přístupu: vyžaduje explicitní souhlas Principála,
privátní klíč se nevypisuje a po nápravě se opakuje `git ls-remote`, ne celý
GitHub login. Podrobný owner/Builder postup drží
[`manual/organization-install.md`](organization-install.md).

Na Windows se kvůli skills nezapíná Developer Mode. `.agents/skills` je source
a `.claude/skills` jeho Git-tracked exact mirror; žádný symlink, junction ani
per-worktree lokální materializátor nevzniká. Paritu dokazuje
`bun run doctor:agent-skills`.

Když onboarding odhalí reprodukovatelný problém, nenechá jej Agent jen v
chatu. Vybere přesný owning repo a postupuje podle
[`manual/github-issues.md`](github-issues.md). Vytvoření issue nebo komentáře
je Publikace a vyžaduje explicitní mandát v instalačním promptu; bez něj Agent
vrátí sanitizovaný draft, cílový repo a důvod, proč jej nezveřejnil. Pokud
prompt exact repo předem povolil, Agent se u každého stejného nálezu znovu
neptá: ověří reprodukci, najde duplicity, sanitizuje evidence a issue vytvoří
nebo doplní. Tento mandát nepovoluje issue zavřít, přiřadit ani prioritizovat.

Kompletní rozhodovací postup pro fresh install, repair i opakovaný onboarding
drží skill
[`lazurio-workstation-install`](../.agents/skills/lazurio-workstation-install/SKILL.md).

## Budoucí Managed Root

Managed Root se nestane podporovanou volbou jen změnou dokumentace. CLI jej
smí nabídnout až po kompletním package-owned Launchpadu/runtime, verzovaném
generatoru a schema compatibility, exact rollbacku a fyzických
macOS/Linux/Windows branách.

Potom bude `lazurio install` stále jediný konvergenční entrypoint pro fresh
Managed instalaci, repair, resume i explicitní Source → Managed migraci. TUI a
Agent JSON použijí tentýž Core; budoucí GUI nebude kopírovat instalační
pravidla. Přesná syntaxe volby profilu není veřejný kontrakt, dokud ji
neprokáže implementační slice.

Package-only Managed instalace source checkout nepotřebuje a installer jej
implicitně neklonuje. Chce-li Principál Lazurio vyvíjet, jediná canonical
source cesta po migraci je:

```text
macOS / Linux: ~/Lazurio/development/Lazurio
Windows:       %USERPROFILE%\Lazurio\development\Lazurio
```

Task/PR worktree se nikdy nestává permanentním `PATH` targetem. Source link se
vytváří pouze z canonical source checkoutu a výsledek se ověří přes
`lazurio --version --json`. Produkční package chování se navíc dokazuje ze
skutečně zabaleného artefaktu; source link sám není package acceptance.

## Source → Managed migrace

Migraci nedělej ručním přesunem adresářů ani vlastním skriptem. Až bude
implementovaná a povolená, smí ji spustit jen explicitní volba Managed profilu
uvnitř `lazurio install`. Stejné Core musí před mutací:

1. inventarizovat Source Root, Git stav, ignored mounty, worktrees a recovery
   stashe;
2. zastavit nebo vyřadit všechny Lazurio readery a runtime procesy, které by
   mohly pozorovat mixed stav;
3. připravit kompatibilní package a generovaný Root na stejném filesystemu;
4. zachovat Organization/Personalspace mounty a přesunout samotný Lazurio
   source do `development/Lazurio`;
5. opravit Git worktree vazby standardním `git worktree repair`;
6. ověřit historii, mounty, CLI provenance, Launchpad a Doctor;
7. při pádu bezpečně pokračovat z lokálního migračního receipt nebo vrátit celý
   atomický krok.

Dokud tyto brány nejsou dostupné, Source Root zůstává beze změny. Agent jen
předá přesný report Principálovi.

## Co Agent nesmí obcházet

- nevytváří root picker, lokální `root-path` config ani alternativní aktivní
  Root;
- nepředává top-level `lazurio install --root ...`;
- nevydává Source Root za chybu jen proto, že je Git;
- nevolí Managed profil bez explicitního souhlasu Principála a readiness gate;
- neklonuje source automaticky v package-only Managed profilu;
- nelinkuje permanentní `lazurio` na task worktree;
- nekopíruje CLI nebo Launchpad do Managed Rootu jako druhou runtime autoritu;
- nemění strojové cesty podle jazyka;
- nepoužívá `git stash --all`, nemaže worktrees a nepushuje lokální Drafty jako
  součást migrace;
- neposílá diagnostiku bez samostatného opt-in consentu.

Pro hlubší diagnostiku použij [`lazurio/README.md`](../lazurio/README.md), pro
celkový filesystem model [`MAP.md`](../MAP.md) a pro hranice instalace
[`ARCHITECTURE.md`](../ARCHITECTURE.md#source-instalace-a-aktualizace).
