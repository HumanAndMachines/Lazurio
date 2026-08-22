# Mapa Lazurio rootu

Lazurio je současný název systému a sdíleného frameworku. Tento repo root
(`HumanAndMachines/Lazurio`) je sdílený
framework pro Launchpad, Guide, templates, manuály a dynamické načítání
Organizací; není to klientské Organization repo.

Launchpad root drží více oddělených Organizací pod jedním Lazurio rootem na
jedné mašině. `launchpad.gen3.json` drží pouze root metadata; dostupné
Organizace Launchpad automaticky skenuje z lokálních mountů
`organizations/*/company.gen3.json`.

```text
Lazurio/
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
├── personalspace/              # private/gitignored personal repo mount
│   └── secrets/                 # local ignored secret custody; see manual/security/local-secret-custody.md
├── organizations/
│   ├── README.md               # jediný soubor trackovaný v root repu
│   ├── ExampleOrg_GEN3/        # lokální gitignored Organization repo checkout
│   ├── OtherOrg_GEN3/          # lokální gitignored Organization repo checkout
│   └── <another-github-org>_GEN3/
│       ├── workspace/          # plochá složka všech workspace modulů
│       │   └── <modul>/        # Team příslušnost deklaruje manifest
│       └── productionspace/    # org-level repa mimo workspace moduly
├── templates/
└── drafts/
```

## Kam jít

- `ARCHITECTURE.md` — krátká mapa cílového systému: Owner, Machine,
  Resident, Agent, pracovní prostory, runtime Modulů a bezpečnostní hranice.
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
  productionspace. Admin konfigurace a produkční aplikace patří do Lazurio
  Dashboardu.
- `guide/` — sdílený netechnický onboarding kurz (26 lekcí) do práce s digitální kanceláří a AI kolegy; technická cesta „mapa systému“ (Launchpad root, Organizace, workspace, productionspace, personalspace) je plánovaná budoucí část, do té doby tato témata drží MAP.md a `manual/`
- Lazurio Dashboard — v1 spike lokální mount (`dashboard/`) byl z rootu odstraněn i s launchery a Dock ikonou; aktuální Dashboard spike žije v privátním repu (v2 reference). Zůstává hostovaným surfacem pro Admin Organizace (billing, plány, přístupy, konfigurace, Buddy policies) a vstupem Uživatele Organizace (Organization User) do produkčních aplikací (decision 0047/0048 v manual/decision-register.md)
- `manual/` — technický maintenance manuál Launchpad rootu
- `distribution/` — source kontrakt, profilové fragmenty, manifest schema,
  evaly a deterministický build non-Git Lazurio Rootu; sdílený produkt se sem
  nekopíruje do druhého `common/` stromu.
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
