# Lazurio

[![Testy](https://github.com/HumanAndMachines/Lazurio/actions/workflows/checks.yml/badge.svg?branch=main&event=push)](https://github.com/HumanAndMachines/Lazurio/actions/workflows/checks.yml)

**Lazurio je lokální pracovní systém, ve kterém lidé a AI spolupracují na
firmách, projektech i osobní agendě — s jasným kontextem, oddělenými přístupy
a vědomou kontrolou nad tím, co se zveřejní.**

Z jednoho počítače pomáhá dlouhodobě spravovat více firem, projektů, aplikací
a osobních podkladů, aniž by se jejich repozitáře, data nebo oprávnění slily
dohromady. Grafický rozcestník ukazuje dostupné aplikace a rozpracovanou práci;
příkazové nástroje, diagnostika a Git udržují stav a dohledatelnou historii.

Každý úkol začíná jednoznačným kontextem: pro koho se pracuje, které firmy nebo
projektu se týká, jaká data smí AI nástroj použít a kdo může výsledek schválit
nebo zveřejnit. Výsledek zůstává editovatelný a kontrolovatelný, dokud jej
oprávněný člověk nebo AI spolupracovník vědomě neposune dál.

Lazurio není nový AI model ani společné cloudové úložiště všech dat. Je to
koordinační vrstva, která propojuje lidi, AI nástroje, repozitáře a aplikace
pod jednou sadou srozumitelných pravidel.

Projekt je určený technickým zakladatelům, vývojářům a týmům, které chtějí
dlouhodobě spolupracovat s AI pomocí srozumitelných postupů, skutečných
oprávnění v používaných službách a výsledků, které lze před zveřejněním
zkontrolovat a upravit — ne pomocí neviditelné agentní magie.

> [!IMPORTANT]
> Lazurio je ve fázi aktivního vývoje. Tento repozitář dnes slouží vývojářům,
> kteří Lazurio spouštějí přímo ze zdrojového kódu. Jednoduchá instalace a
> automaticky vytvořené pracovní prostředí ve zvoleném jazyce jsou cílový
> směr, nikoli už vydaná distribuce. Zdrojový kód je nyní dostupný pod FSL,
> která ještě není finální open-source licencí projektu; volba OSS licence je
> bezprostřední navazující krok.

## Společný slovník Lazuria

Lazurio používá malý počet záměrně přesných pojmů pro role, pracovní prostory
a rozhodování. Nejsou to jen interní názvy. **Společný slovník je součástí
fungování Lazuria:** zajišťuje, aby lidé i AI nástroje stejně rozuměli tomu,
pro koho se pracuje, kdo má jaká oprávnění, kde končí hranice dat a kdy je
výsledek jen připravený ke kontrole, nebo už skutečně publikovaný.

Bez společných definic mohou běžná slova jako „agent“, „uživatel“, „vlastník“
nebo „schválení“ znamenat pro každého něco jiného. Od tohoto místa proto README
používá následující pojmy s jejich přesným významem.

### Lidé a agentní role

| Pojem | Co znamená běžnou řečí |
| --- | --- |
| **Principál** | Ten, pro koho Agent právě pracuje, z čích oprávnění vychází a kdo má poslední slovo. Principálem může být člověk i AI Kolega. |
| **Kolega** | Lidský Principál zapojený do práce podle svých firemních rolí a oprávnění. |
| **AI Kolega** | Dlouhodobá AI identita s vlastním účtem, pracovním prostředím, odpovědností a přístupy. Není to jedna dočasná relace nástroje. |
| **Task Agent (hovorově Agent)** | Jedna nástrojová pracovní relace pro konkrétní úkol, například Codex, Claude Code nebo Cursor. Pracuje jménem svého Principála, má dohledatelné ID své relace a sama nevlastní žádná oprávnění. |
| **Buddy** | Osobní AI zástupce právě jednoho člověka. Jedná v mezích jeho oprávnění a trvalých, ohraničených a odvolatelných mandátů. |

**Task Agent ID** je lokální recovery identita pracovní relace: tvoří ji název
harnessu a jeho opaque thread/session/chat ID. Lazurio ji zapisuje do sidecaru
každého agentem založeného worktree, aby šlo i po přerušení dohledat správný
task, obnovit jeho kontext a bezpečně pokračovat. ID samo nedává žádná
oprávnění a do sdíleného Gitu se s ním nekopíruje transcript ani reasoning.

### Prostory a práce

| Pojem | Co znamená běžnou řečí |
| --- | --- |
| **Mašina** | Počítač nebo dedikovaný server ovládaný jedním Principálem. V Lazuriu tvoří základní lokální bezpečnostní hranici. |
| **Organizace** | Jedna firma, její GitHub organizace a samostatná hranice repozitářů, dat a přístupů. |
| **Personalspace** | Soukromý prostor jednoho Principála a jeho případného Buddyho. S firemní Organizací se automaticky nesdílí. |
| **Root** | Kořenová složka pracovního prostředí, která zastřešuje Lazurio, dostupné Organizace a případný Personalspace. |
| **Draft a Publikace** | Draft je vratný a editovatelný výsledek. Publikace jej zviditelní navenek nebo z něj udělá obtížně vratnou změnu a vyžaduje vědomé rozhodnutí oprávněného Principála. |

Tento zkrácený slovník stačí pro čtení README. Úplný model spolupráce drží
[pravidla pro Agenty](AGENTS.md#model-spolupráce-principál-a-agenti) a cílové
vztahy mezi rolemi, prostory a runtime popisuje [architektura](ARCHITECTURE.md).

## Proč Lazurio vzniká

Běžné agentní nástroje umějí dobře vykonat jednotlivý úkol. Hůř se v nich ale
udržuje dlouhodobý kontext: komu Agent slouží, ve které firmě právě pracuje,
kam patří výsledek, co smí být sdílené a kdo může změnu publikovat.

Lazurio nad tím staví malý počet pevných pravidel:

- **jedna Mašina je jedna trust doména** se známým vlastníkem;
- **GitHub je autorita pracovních přístupů** — Lazurio nevytváří paralelní
  systém oprávnění;
- **každá Organizace je samostatná hranice** a samostatný Git repozitář;
- **Personalspace je privátní** a nikdy se automaticky nesdílí s Organizací;
- **Agent pracuje pro svého Principála** a odevzdává editovatelný Draft;
- **publikace zůstává vědomým rozhodnutím oprávněného Principála**.

Výsledkem má být pracovní prostředí, ve kterém lidé i AI Kolegové používají
stejnou organizační strukturu, stejné zdroje pravdy a stejné kontrolovatelné
procesy.

## Jak Lazurio zapadá dohromady

### Dnešní vývojový tok

```text
Git repozitář Lazurio
        │
        ├── Lazurio CLI v0 a sdílené Core
        ├── Launchpad, Guide, Doctor a manuály
        ├── lokálně připojené Organizace
        └── lokálně připojený Personalspace
```

Source checkout je dnes současně vývojovým pracovním rootem. Příkazy se
spouštějí přes Bun; primární checkout lze také zpřístupnit jako uživatelský
příkaz `lazurio` v `PATH`. Některé instalační a distribuční části jsou stále
experimentální.

### Cílová distribuce

```text
                         Lazurio source repo
                         /                  \
             lokální vývojový build      package-managed CLI
                         \                  /
                    jazykově generovaný non-Git Root
                                   │
              ┌────────────────────┼────────────────────┐
          Launchpad            Personalspace       Organizace
        a sdílené UI         jednoho vlastníka    oddělené Git scope
```

Repozitář zůstane zdrojem produktu. Vývojář sestaví Root z přesného lokálního
source commitu; produkční instalaci bude materializovat jedno verzované
`lazurio` CLI. Lokalizuje se lidský obsah výsledného Rootu, nikoli názvy cest,
manifestové klíče, identifikátory nebo strojová schémata.

Cílově CLI/Core vlastní stavová pravidla, instalaci, validaci, lifecycle a
výsledný report. Dnešní Launchpad vedle grafického UI ještě přímo řídí start,
stop a obnovu lokálních modulových procesů; tato odpovědnost se postupně skládá
do společného Core. Produktová hranice se nemění: **Launchpad je klient
společného kontraktu**, ne druhý nezávislý runtime engine. Lazurio Dashboard je
samostatný povrch pro administraci Organizací a vstup do produkčních aplikací;
Launchpad ho nenahrazuje.

## Hlavní části systému

| Část | Úloha |
| --- | --- |
| **Lazurio CLI/Core** | Headless kontrakt pro kontext, diagnostiku, synchronizaci, instalaci a reportování. Současné CLI v0 je interní a nestabilní. |
| **Launchpad** | Builder-first grafický povrch nad stejnými pravidly: objevuje Organizace a moduly, spouští vývojové aplikace a ukazuje jejich stav. |
| **Guide** | Netechnický průvodce spoluprací lidí, AI Kolegů a digitálních kanceláří. |
| **Personalspace** | Privátní prostor právě jednoho vlastníka a jeho případného Buddyho; neleží uvnitř firemní Organizace. |
| **Organizace** | Jedna firma, jedna GitHub Organization, jeden samostatný super-repozitář a jedna access hranice. |
| **Workspace moduly** | Samostatné repozitáře pro každodenní práci uvnitř Organizace; Teamy jsou nad nimi logické N:M seskupení. |
| **Productionspace** | Org-level repozitáře s vlastním release a provozním modelem, které Launchpad standardně ukazuje read-only. |
| **Resident** | Dlouhodobá instalace Lazuria na Mašině, například profil Buddyho nebo AI Kolegy. |
| **Task Agent** | Jedna dohledatelná nástrojová pracovní relace pro konkrétní úkol, například Codex, Claude Code nebo Cursor; sama nevlastní žádná oprávnění. |

Podrobný cílový model vysvětluje [ARCHITECTURE.md](ARCHITECTURE.md) a fyzické
rozložení repozitářů [MAP.md](MAP.md).

## Co funguje dnes a co je cílový stav

| Oblast | Stav |
| --- | --- |
| Source checkout a Bun workflow | **Funguje dnes.** Obsahuje Launchpad, Guide, CLI v0, Doctory, manuály, šablony a build kontrakty. |
| Launchpad | **Funguje dnes.** Je builder-first a dynamicky objevuje lokálně připojené Organizace. |
| Lazurio CLI v0 | **Experimentální.** Umí omezený kontext, Doctor, synchronizaci, instalaci desktopového launcheru a scoped search. Primární checkout lze přes Bun zpřístupnit jako uživatelský příkaz `lazurio`; nejde ještě o stabilní distribuční balíček ani veřejné API. |
| Resident artefakty | **První funkční řez.** Deterministický build a lifecycle dnes pokrývají vybrané profily a platformy; nejde ještě o obecný onboarding každého uživatele. |
| Package-managed `lazurio` CLI | **Cíl.** Má být jediným produkčním vstupem pro instalaci a údržbu Lazuria. Přesná nevydaná syntaxe zatím není veřejný kontrakt. |
| Jazykově generovaný non-Git Root | **Cíl.** Lidský obsah se zvolí podle jazyka, zatímco strojové identity zůstanou stabilní. |
| Lazurio Dashboard | **Samostatně vyvíjený povrch.** Není součástí tohoto root repozitáře ani runtime autoritou Launchpadu. |

## Rychlý start pro vývojáře

Aktuální podporovaná cesta vede přes source checkout. Potřebuješ [Git](https://git-scm.com/)
a [Bun](https://bun.sh/).

```sh
git clone https://github.com/HumanAndMachines/Lazurio.git
cd Lazurio

# Bezpečná projekce lokálního kontextu
bun run lazurio -- context --json

# Diagnostika checkoutu a připojených částí
bun run lazurio -- doctor

# Spuštění Launchpadu v prohlížeči
bun run launchpad
```

Stejný primární checkout můžeš bezpečně a opakovaně zpřístupnit v `PATH`:

```sh
bun run lazurio -- cli install
lazurio cli status
```

Čerstvý checkout nemusí mít připojenou žádnou Organizaci ani Personalspace.
To je platný stav: Launchpad je objevuje až z lokálních, Gitignored mountů a
jejich manifestů. Varování Doctoru proto vždy čti podle uvedeného vlastníka a
dalšího kroku; neopravuj je plošným kopírováním dat do root repozitáře.

Na macOS a Windows lze z **primárního checkoutu** nainstalovat uživatelský
desktopový launcher:

```sh
bun run lazurio -- launchpad install
```

Tento příkaz sám CLI do `PATH` neregistruje, nemění Git checkout a na Linuxu
zatím desktopový instalační slice nepodporuje. Detaily drží
[dokumentace CLI](lazurio/README.md#instalace-launchpadu).

Po registraci CLI je stejná operace dostupná jako `lazurio launchpad install`.

### Kontrola změn

```sh
bun run check
bun run doctor
```

`check` ověřuje sdílené kontrakty a testy; `doctor` posuzuje konkrétní lokální
instalaci a může správně hlásit stav připojených Organizací nebo aplikací.

## Budoucí instalace

Cílem je jedno package-managed `lazurio` CLI pro macOS, Linux a Windows.
Instalace má být bezpečně opakovatelná i po částečném selhání nebo aktualizaci
instalátoru a má končit pravdivým reportem současného stavu:

```text
inspect → reconcile → final inspect → report
```

Jednotlivé komponenty mají být idempotentní a crash-safe. Lazurio nemá
udržovat druhý globální rollback systém ani skrytý paralelní stav; riskantní
změny zůstávají explicitní a migrace dnešního Gitového Rootu bude samostatná,
silně hlídaná operace s inventurou a obnovitelným rollbackem.

Dnešní `lazurio cli install` pouze zpřístupní CLI z tohoto checkoutu. Budoucí
opakovatelný `lazurio install` má připravit celé lokální prostředí včetně
generovaného Rootu a při každém běhu skončit aktuálním reportem. Aktuální build
rezidentních artefaktů popisuje [distribution/README.md](distribution/README.md)
a profily [manual/lazurio-resident-profiles.md](manual/lazurio-resident-profiles.md).

## Bezpečnost a soukromí

- **GitHub oprávnění rozhodují.** Textový název role ani lokální adresář
  nevytvářejí přístup. Chybějící checkout také neznamená, že přístup neexistuje;
  bez živého provider readbacku je stav pouze neověřený.
- **Organizace se nemíchají.** Secrets, zákaznická data, firemní strategie ani
  osobní overlaye se mezi nimi nekopírují. Sdílet lze jen obecné patterny,
  anonymizované šablony a public-safe software.
- **Personalspace je intimní hranice.** Patří jednomu vlastníkovi a jeho
  případnému Buddymu. Cizí Personalspace se nemountuje ani neprohledává.
- **Secrets nepatří do Gitu ani chatu.** Do repozitáře smějí pouze standardní
  cesty, názvy proměnných a metadata-only ověření — nikdy tokeny, hesla,
  OAuth soubory nebo obsah soukromé paměti.
- **Mašina je bezpečnostní jednotka.** Pokud mají dva runtime procesy
  root-equivalent přístup na stejné Mašině, běžný adresář nebo Unix user z nich
  nedělá dvě nezávislé trust domény.

Podrobnosti najdeš v [architektuře](ARCHITECTURE.md#vnější-bezpečnostní-hranice),
[pravidlech pro Agenty](AGENTS.md#model-spolupráce-principál-a-agenti) a
[standardu lokálního držení secrets](manual/security/local-secret-custody.md).
Bezpečnostní problém nepublikuj do veřejného issue spolu s citlivými daty;
nejdřív odstraň secrets a zákaznický či osobní obsah z reprodukce.

## Orientace v repozitáři

| Cesta | Co v ní hledat |
| --- | --- |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Cílový systémový model, pojmy a trust hranice. |
| [MAP.md](MAP.md) | Lidská mapa fyzického rootu a jednotlivých scope. |
| [lazurio/](lazurio/README.md) | Aktuální interní CLI v0 a jeho bezpečnostní kontrakty. |
| [launchpad/](launchpad/README.md) | Builder-first Launchpad, discovery, runtime a UI kontrakty. |
| [distribution/](distribution/README.md) | Deterministický build non-Git Resident rootů, updater a rollback. |
| [guide/](guide/README.md) | Netechnický onboarding do digitální kanceláře a spolupráce s AI. |
| [manual/](manual/README.md) | Provozní a maintenance dokumentace Lazurio rootu. |
| [templates/](templates/README.md) | Sdílené public-safe šablony. |
| [organizations/](organizations/README.md) | Pravidla mountpointu oddělených Organization repozitářů. |
| [personalspace/](personalspace/README.md) | Privacy, custody a lokální mount osobního prostoru. |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Scope změn, kvalita PR, testy a review workflow. |

## Jak přispět

Lazurio má zůstat sdíleným a fork-friendly frameworkem. Do tohoto repozitáře
patří obecná oprava nebo funkce použitelná napříč instalacemi; pravidlo,
workflow, vzhled nebo data jedné firmy patří do její Organizace.

1. U chyby přilož malou, anonymizovanou reprodukci. Větší funkci nejdřív
   prober v [GitHub issue](https://github.com/HumanAndMachines/Lazurio/issues).
2. Před změnou si přečti [CONTRIBUTING.md](CONTRIBUTING.md) a pravidla scope
   v [AGENTS.md](AGENTS.md).
3. Pracuj v samostatné větvi nebo worktree, drž změnu úzce zaměřenou a přidej
   odpovídající test nebo ověření.
4. Před pull requestem spusť `bun run check`; u změn konfigurace nebo runtime
   také `bun run doctor`.
5. Do issue, commitu ani PR nikdy nevkládej secrets, osobní data nebo interní
   obsah některé Organizace.

## Licence

Exact stav tohoto repozitáře se řídí souborem [LICENSE.md](LICENSE.md), který
dnes používá **FSL-1.1-Apache-2.0**. Jde o source-available licenci s budoucím
přechodem jednotlivých verzí na Apache 2.0; není to zatím finální OSS licenční
režim, který má Lazurio nabídnout komunitě.

Volba a publikace navazující OSS licence je samostatné explicitní rozhodnutí
Principála. Dokud není nová licence skutečně publikovaná, nelze ji z plánů ani
záměru projektu domýšlet a platí přesné znění aktuálního `LICENSE.md`.
