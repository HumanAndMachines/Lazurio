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

## GitHub transport při workstation onboardingu

Úspěšné `gh auth status --hostname github.com` dokazuje GitHub API session,
nikoli Git transport pro privátní repozitáře. Agent se proto nepřihlašuje
opakovaně naslepo. Pro jednu cílovou Organizaci nejdřív přečte její install
postup a ověří exact canonical root remote přes `git ls-remote`; teprve tento
probe dokazuje, že zvolený HTTPS nebo SSH transport umí repo skutečně číst.

Je-li deklarovaný privátní remote SSH a probe selže při platném `gh` loginu,
Agent ověří existující SSH klíč a vazbu na tentýž GitHub účet. Vytvoření nebo
nahrání nového klíče je změna přístupu: vyžaduje explicitní souhlas Principála,
privátní klíč se nevypisuje a po nápravě se opakuje `git ls-remote`, ne celý
GitHub login. Podrobný owner/Builder postup drží
[`manual/organization-install.md`](organization-install.md).

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
