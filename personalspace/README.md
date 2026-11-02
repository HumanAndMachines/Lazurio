# Personalspace

Mountpoint pro privátní prostory uživatelů podle
`launchpad.gen3.json` (`personalspace_mountpoint`) a CompaniesAsCode
decisions 0013 a 0021; strukturu definuje decision 0051
(revidovaná pro self-service decision 0079; Buddyho v Osobním Prostředí
zavádí decision 0210 místo VPS-only Buddyho z decision 0080; shrnutí drží
`../manual/decision-register.md`).

`personalspace/` je integrální privátní vrstva Lazuria a mountpoint
**jediného osobního prostoru uživatele této mašiny**. Není to Organizace ani
externí doplněk. Prostor je samostatné repo `<username>/<username>_GEN3` na
osobním nebo agentním GitHub účtu (generační marker per decision 0045), mimo
firemní GitHub organizace. Přístup má pouze uživatel a jeho volitelný Buddy;
Kolegové, jiní Buddyové ani Organization Builders sem přístup nemají. Firemní
pravda sem nepatří a nikdy se odsud nepřenáší mezi Organizacemi.

Personalspace může fungovat bez Buddyho. Jeho uživatelem je vlastník; Buddy
binding a přístup ke gbrainu se přidávají jen tehdy, když vlastník Buddyho
skutečně má. Buddy patří k Osobnímu Prostředí a běží v něm (decision 0210);
Personalspace o něm drží blok `buddy` v `personal.gen3.json`, secret-free
profil v `buddy/` a paměť v `gbrain/`. Dosavadní hostované instalace Buddyho
na dedikované VPS zůstávají do své migrace, jak jsou.

**Agentům:** jestli vlastník Buddyho má a jestli k němu máš přístup, se
z manifestu nepozná: deklarace není důkaz a přístup se prokazuje operací. Co
s Buddym smíš, kde leží jeho profil a paměť a že se dosavadní hostované
instalace řídí pravidly svého hostu, ne pravidly source checkoutu, drží
[`../manual/buddy.md`](../manual/buddy.md).

Owner identifikátor je GitHub username vlastníka, například `exampleowner` — jeho prostor je
`personalspace/exampleowner_GEN3/` a repo `exampleowner/exampleowner_GEN3`.
Lokální OS účet není GEN3 owner identita.

## Pravidlo pro agenty

**Personalspace je privátní prostor uživatele a jeho volitelného Buddyho.**
Pokud hledáš pracovní záležitosti — firmy, klienty, moduly, Mission Control
plány — patří do `../organizations/<Org>/`, ne sem. Agent nesmí cizí
Personalspace materializovat ani číst; jeho výskyt v tomto mountpointu je
privacy failure, ne nabídka ke spolupráci. Obsah personalspace se nikdy nesmí
objevit ve sdílených výstupech, org discovery, reportech ani šablonách.

## Struktura (decision 0051)

```text
personalspace/
└── exampleowner_GEN3/          # jediný osobní prostor uživatele mašiny
    ├── personal.gen3.json      # manifest (vlastník, volitelný Buddy, sloty)
    ├── modules.manifest.json   # identický kontrakt jako v Organizaci
    ├── workspace/              # plochá složka OSOBNÍCH modulů (nested private
    │   └── <modul>/            #   repa <owner>/<modul> na osobním GitHubu)
    ├── gbrain/                 # privátní paměťové data repo vlastníka
    │                           #   (přístup jen uživatel + volitelný Buddy)
    ├── buddy/                  # volitelný mount private Hermes Profile
    │                           #   Distribution Buddyho (bez secrets)
    ├── secrets/                # owner-scoped secret custody (viz níže)
    └── README.md
```

Osobní moduly drží stejný kontrakt jako workspace moduly Organizací —
promotion do firemního workspace je přesun repa + úprava manifestů, vždy
přes fail-closed isolation gate (žádné secrets, osobní overlaye ani gbrain
reference). Gbrain je root vrstva prostoru (analogie `mission-control/`
v rootu Organizace), ne modul; v1 lidské rozhraní je Obsidian (deep link),
agenti pracují přes gbrain MCP server. Software pochází z veřejného
`garrytan/gbrain`; privátní Markdown data vlastníka žijí v samostatném repu,
doporučeně `<username>/<username>-gbrain`, mountovaném do `gbrain/`. Software
repo a data repo se nesmějí zaměnit.

## Vytvoření vlastního Personalspace

`HumanAndMachines/Lazurio` je direct-pull repo a není GitHub
template. Pro self-service založení prostoru vlastníka slouží veřejná GitHub
template
[`Lazurio/PersonalspaceTemplate_GEN3`](https://github.com/Lazurio/PersonalspaceTemplate_GEN3).
Vygenerovaná instance musí být vždy private a pojmenovaná přesně:

```text
<github-login>/<github-login>_GEN3
```

Mount je `personalspace/<github-login>_GEN3/`. Bootstrap ověřuje shodu
GitHub loginu, remote repa a mount path, private visibility owner i gbrain
repa, vlastní `.gitignore` pro secrets a nepřítomnost `.gitmodules`/gitlinků.
Doctor pak přes přihlášené `gh` živě ověřuje skutečnou GitHub visibility;
manifestová deklarace `private` sama nestačí a neověřitelný remote je hard
failure. Všechny checkouty jsou Doctor-managed gitignored nested repa.
Cross-platform automatizaci drží root příkaz:

```text
bun run personalspace:create -- --display-name "<jméno>" --apply --install-gbrain
```

Příkaz před zápisem vyžaduje public + `isTemplate=true` upstream. Při jakémkoli
driftu fail-closed skončí v preflightu a nevytvoří žádný osobní repozitář ani
checkout.

Detail a recovery jsou v `manual/create-personalspace.md`; pilot jednoho uživatele
a cross-platform evidence drží `CAC-0071`.

Root příkaz Buddyho nezakládá: parser `--with-buddy` odmítá jako neznámý
argument a Buddy repo nevytváří. Blok `buddy` podle decision 0210 drží
`runtime.deployment_target: owner-personal-environment` a
`hermes.software_repo: Lazurio/hermes-agent`, bez `runtime.github_repo`
a `runtime.local_execution`; stejný kontrakt kontroluje šablona Personalspace
i root.
Dosavadní hostovaný blok (`owner-dedicated-personalspace-vps`,
`local_execution: forbidden`, `runtime.github_repo`) root do migrace instalace
přijme a Doctor ho hlásí jako deprecation warning.

Existující neversionované manifesty zůstávají přechodně čitelné s Doctor
warningem a migrují se podle
[`manual/migrate-personalspace-custody-v1.md`](../manual/migrate-personalspace-custody-v1.md);
částečný nebo neplatný upgrade se nedoplňuje tichým defaultem.

## Spolupráce s Kolegy

Personalspace se s Kolegy nesdílí, a to ani po jednotlivých modulech. Co má
být součástí práce Organizace, přesune uživatel záměrně pull requestem do repa
Organizace a podřídí to jeho GitHub oprávněním a review procesu. Export nebo
předání výsledku nikdy nedává příjemci přístup k Personalspace, jeho manifestu,
gbrainu ani secrets custody.

Obsah tohoto mountpointu je lokální (gitignored kromě tohoto README);
konkrétní checkouty si sem mountuje vlastník stroje.

## Lokální secrets

Root a lokální owner secrets, které nepatří do žádné GitHub Organizace, mají
owner-scoped custody cestu v primárním prostoru vlastníka mašiny:

```text
personalspace/<owner>_GEN3/secrets/<provider>/<scope>/<purpose>
```

Příklad Google OAuth Desktop client souboru:

```text
personalspace/<owner>_GEN3/secrets/google-oauth/<domain>/client-desktop.json
```

Adresáře se drží lokálně s módem `0700`, secret soubory s módem `0600`.
Do Gitu patří jen tento standard a no-secret runbooky, nikdy skutečné secret
hodnoty ani obsah JSON souborů. Personalspace ani jeho secrets custody se
nesdílejí.
Buddy/Hermes provider auth, sessions a runtime secrets patří jen do custody
Osobního Prostředí, ve kterém Buddy běží (u dosavadních hostovaných instalací
do custody jejich hostu); do profilu `buddy/` ani do Gitu nikdy.
Detailní pravidla jsou v `manual/security/local-secret-custody.md`
(aktualizace cesty na owner-scoped tvar je součást CAC-0048).

Podle decision 0210 je Osobní Prostředí jediná osobní hostovaná Mašina uživatele
(0153) a Buddy běží v něm; organizační klony a běhy zůstávají na přidělených
Organization-owned Mašinách.
