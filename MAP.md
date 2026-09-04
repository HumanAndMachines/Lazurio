# Mapa Lazurio rootu

Lazurio je současný název systému a sdíleného frameworku. Tento dokument žije
v source repozitáři `HumanAndMachines/Lazurio`; source repo není totéž jako
výsledný pracovní Root a není klientské Organization repo.

Pracovní Root drží více oddělených Organizací pod jedním `Lazurio` adresářem
v home uživatele Mašiny. `launchpad.gen3.json` drží pouze root metadata;
dostupné Organizace Launchpad automaticky skenuje z lokálních mountů
`organizations/*/company.gen3.json`.

## Kanonický pracovní Root: dva profily

Dnešní podporovaný Source Root:

```text
<home>/<existující-source-složka>/     # Git checkout Lazuria i pracovní Root
├── .git/
├── AGENTS.md
├── launchpad.gen3.json
├── organizations/                     # oddělené Organization Git checkouty
└── personalspace/                     # privátní mount jednoho Principála
```

Dnešní instalace může mít source složku stále pojmenovanou například
`Conglomerate`; musí ale ležet přímo v home a být ověřeným Lazurio source.
Nejde o volitelný picker ani cílovou alternativní cestu.

Budoucí Managed Root po explicitní fresh instalaci nebo migraci:

```text
<home>/Lazurio/                        # generovaný non-Git pracovní Root
├── AGENTS.md                          # generované instrukce profilu a jazyka
├── launchpad.gen3.json                # stabilní root metadata
├── organizations/                     # oddělené Organization Git checkouty
├── personalspace/                     # privátní mount jednoho Principála
└── development/
    └── Lazurio/                       # volitelný canonical source checkout
```

Fresh/Managed target je vždy canonical `<home>/Lazurio`; existující Source
Root si do migrace ponechá svou ověřenou home cestu. Nevzniká root picker ani
druhý aktivní Root. `development/Lazurio` existuje pouze po Managed migraci
nebo ve fresh Managed development profilu. Package-only Managed instalace je
platná bez něj. Package/source popisuje CLI provenance, ne třetí Root profil;
runtime nikdy neběží ze skryté kopie uvnitř Rootu.

## Source repozitář

V Source profilu je tímto repozitářem samotný ověřený Root přímo v home,
včetně jeho existujícího historického názvu do migrace. V Managed profilu je
jeho volitelná canonical cesta:

```text
<home>/Lazurio/development/Lazurio/
├── launchpad.gen3.json
├── package.json
├── README.md
├── ARCHITECTURE.md             # cílové základy Lazuria, Residentů a Agentů
├── MAP.md
├── AGENTS.md
├── manual/
├── .agents/skills/             # základní postupy pro Buddy a AI kolegy
├── lazurio/                    # Lazurio CLI v0: context, Doctor, update, install a scoped search
├── launchpad/
├── Launchpad.command
├── Launchpad.cmd
├── Launchpad.ps1
├── launchpad.sh
├── guide/
├── personalspace/
│   └── README.md               # trackovaný kontrakt mountpointu, ne aktivní osobní data
├── organizations/
│   └── README.md               # trackovaný kontrakt mountpointu, ne Organization checkouty
├── templates/
└── drafts/
```

V Source profilu jsou gitignored Organization a Personalspace checkouty v
těchto source adresářích zároveň aktivními mounty, protože source checkout je
pracovní Root. V Managed profilu obsahuje volitelný
`development/Lazurio/{organizations,personalspace}` pouze trackované README
kontrakty source repozitáře. Aktivní checkouty a privátní data zůstávají
výhradně v `<home>/Lazurio/organizations` a `<home>/Lazurio/personalspace`;
nikdy se neduplikují pod `development/Lazurio`.

## Kam jít

- `ARCHITECTURE.md` — krátká mapa cílového systému: Owner, Machine,
  Resident, Agent, pracovní prostory, runtime Modulů a bezpečnostní hranice.
- `manual/lazurio-root-for-agents.md` — kanonická stručná procedura pro
  Agenty: jak pracovat v dnešním Source Rootu, rozeznat package/source CLI,
  kde smí být Managed development checkout a jak předat budoucí migraci bez
  ručního přesouvání.
- `lazurio/` — interní CLI pro bezpečný kontext, Doctor a ohraničené
  vyhledávání. Explicitní mutace jsou oddělené: Bun-managed PATH registrace,
  Git-only update a desktop Launchpad install. CLI není MCP ani veřejné Core
  API. Aktuální příkazy a hranice popisuje `lazurio/README.md`.
- `launchpad.gen3.json` — metadata Lazurio rootu a lokální `planned` sloty.
  Není to allowlist; Organizace se objevují z lokálních mountů.
- Organization manifest — dnes `company.gen3.json`, cílově
  `lazurio.organization.json`. Drží Organization-wide pravidla včetně poolu
  pro přidělování nových portů. Přesný port vlastní každý Modul ve svém
  `lazurio.module.json`; globální registr neexistuje.
- `launchpad/` — vývojový povrch pro Buildery. Objevuje Organizace, Teamy a
  Moduly, spouští aplikace z `main` i worktrees a ukazuje read-only
  productionspace. Obsahuje také současný in-shell Guide; jeho UI copy používá
  Launchpad katalogy a dlouhý Organization install runbook párové Root locale
  zdroje. Admin konfigurace a produkční aplikace patří do Lazurio Dashboardu.
- `guide/` — sdílený netechnický onboarding kurz (26 lekcí) do práce s digitální kanceláří a AI kolegy; technická cesta „mapa systému“ (Launchpad root, Organizace, workspace, productionspace, personalspace) je plánovaná budoucí část, do té doby tato témata drží MAP.md a `manual/`
- Lazurio Dashboard — v1 spike lokální mount (`dashboard/`) byl z rootu odstraněn i s launchery a Dock ikonou; aktuální Dashboard spike žije v privátním repu (v2 reference). Zůstává hostovaným surfacem pro Admin Organizace (billing, plány, přístupy, konfigurace, Buddy policies) a vstupem Uživatele Organizace (Organization User) do produkčních aplikací (decision 0047/0048 v manual/decision-register.md)
- `manual/` — technický maintenance manuál Launchpad rootu
- `manual/mission-control-trusted-builder-smoke.md` — živý cross-Lazurio audit GitHub-only writeru, root pointerů a progresivního `trusted-process` / `provider-enforced` režimu
- `manual/windows-e2e-lab.md` — native Windows 11 E2E acceptance: kdy použít
  owner-controlled testovací Mašinu, co přesně smí znamenat Lazurio-only reset
  a jak prokázat instalaci, nový proces, restart, rollback a PR reprodukci.
- `distribution/` — source kontrakt, profilové fragmenty, manifest schema,
  locale projekce Root-owned dlouhých dokumentů, evaly a deterministický build
  non-Git Lazurio Rootu; sdílený produkt se sem nekopíruje do druhého `common/`
  stromu.
- `provisioning/` — source-only operator plane pro přípravu Resident Mašiny;
  do výsledného Lazurio Rootu se nebalí a atomický install/update/rollback
  deleguje na verzovaný resident lifecycle.
- `.agents/skills/` — základní opakovatelné postupy pro Buddy a AI kolegy
- `organizations/README.md` — vysvětlení mountpointu; jediný trackovaný soubor uvnitř `organizations/` v root repu
- `organizations/<org>/` — lokální gitignored Organization GEN3 checkout, ideálně podle GitHub organizace
- Legacy top-level Organization template mount s markerem `company.gen3.json` `organization_kind: "template"` zůstává discovery-kompatibilní, ale nový se nezakládá. Current pracovní checkout podle decision 0127 žije v `organizations/<AdminOrganization>/productionspace/OrganizationTemplate_GEN3`; template nástroje dostávají explicitní cestu a ověřují Git provenienci.
- `organizations/<org>/workspace/` — plochá složka všech workspace Modulů.
  Team příslušnost je N:M deklarace v `modules[].teams` nebo
  `module_slots[].teams`, ne další adresář. Chybějící deklarace znamená Team
  `workspace`; starší singulární `workspace` je pouze migrační alias. Launchpad
  podle stejné deklarace grupuje karty a odvozuje hostovaný tvar
  `<modul>.<team>.<doména>` (decision 0041).
- `organizations/<org>/productionspace/` — org-level repozitáře dané Organizace, které nejsou workspace moduly (např. firmware, connect, platformní runtime nebo pracovní template checkout); každé repo si definuje vlastní pravidla a Doctor u nich vynucuje jen bezpečné minimum (decisions 0041 a 0127 v manual/decision-register.md)
- `personalspace/` — privátní osobní repo mimo GitHub organizace; cílově obsahuje privátní moduly a per-user/per-colleague aplikace včetně GBrain rozhraní
- **Hostovaný Buddy** — když si Principál Buddyho onboarduje, běží na dedikované per-owner VPS (decision 0080), ne lokálně; lokální mount `personalspace/<owner>_GEN3/buddy/` drží jen Git konfiguraci profilu. Na hostu platí vygenerované instrukce aktivního Buddy resident rootu spolu s privátním profilem Principála, ne pravidla source checkoutu — hranici a postup zjištění drží `manual/hosted-buddy-vps.md`
- `personalspace/<owner>_GEN3/secrets/<provider>/<scope>/<purpose>` — lokální gitignored
  custody cesta pro root/Buddy/operator secrets; organization/AI-colleague
  secrets patří do organization-local `private/secrets/...`
- `templates/` — šablony
- `drafts/` — lokální netrackované návrhy bez dlouhodobé autority; sdílený draft patří do příslušné Organizace, plan-owned worktree nebo PR
- **V jakém světě jsi (koexistence Human↔Machine):** začni sekcí
  `AGENTS.md → Model spolupráce → Koexistence Human and Machine`. Vysvětluje
  hierarchii, hranice a procesy, ve kterých tenhle root a všechny Organizace
  fungují — pro lidi i agenty.
