# Lazurio Module Standard

Standard pro to, jak vypadá, startuje a žije Modul (a org-level aplikace)
v Lazuriu. Přijal ho Principál 2026-09-30 (decision 0171 v
[decision-register.md](decision-register.md)) s pořadím: **Launchpad
neimplementuje workaroundy pro odchylky modulů; moduly se srovnají na
jeden udržitelný standard a ten se dál rozvíjí.** Standard nezavádí nové
schéma ani druhou autoritu: zpřísňuje stávající rodinu manifestů
([lazurio-manifest-family.md](lazurio-manifest-family.md)) a přesně říká, co
je v Modulu povinné, co je zakázané a co drží Launchpad.

Autorita: tento manuál + schémata v `lazurio/schemas/` (Core). LazurioPlatform
je consumer: spouští jen to, co standard dovoluje, a nekonformní Modul hlásí
nebo odmítá (kapitola 10). Kontrolu drží mechanismus `lazurio module setup`
(kapitola 11), ne próza.

## 1. Pojmy

- **Modul** — jeden Git repozitář v `organizations/<Org>/workspace/<slug>/`
  s `lazurio.module.json` v kořeni. Org-level aplikace (`mission-control/`,
  `design-system/`) jsou Moduly se stejnými pravidly; liší se jen slotem
  v `modules.manifest.json`.
- **App** — spustitelný package Modulu deklarovaný v `apps[]`; právě jedna je
  `default_app`. Cesta `app/v<N>/package.json` je **generace** App.
- **Listener** — TCP port z `port_leases` Modulu, na který App poslouchá;
  má ID (`APP`, `WEB`, `EDITOR`, `API`…), které je klíčem env proměnných.
- **Příprava** — vše, co musí proběhnout před startem (instalace závislostí,
  build klienta, data, symlinky, migrace). Není to start.

## 2. Povinné soubory Modulu

| Soubor | Požadavek |
| --- | --- |
| `lazurio.module.json` | `schema_version: lazurio.module.v1`; `id` = slug slotu v `modules.manifest.json`; `company` = slug Organizace; `port_leases[]` s `id`, `host: 127.0.0.1`, `port` **uvnitř `module_port_pool` Organizace** (přesun existujícího leasu do poolu je součást převodu, viz níže); `apps[]` + `default_app`. Modul bez App má `tcp_port_policy: none` a `apps: []`. |
| `app/v<N>/package.json` každé App | App žije vždy v podadresáři `app/v<N>/` (nikdy v kořeni Modulu). `name`, `private: true`, `packageManager: "bun@<přesná verze z lazurio/package.json>"`, `lazurio.runtime` (kap. 4), `lazurio.preparation` (kap. 3), skripty `dev`, `check`, `test`. Python App: `app/v<N>/pyproject.toml` (kap. 7). |
| `app/v<N>/bun.lock` | commitnutý, aktuální; `bun install --frozen-lockfile` projde. Python App: `uv.lock`. |
| `app/v<N>/tsconfig.json` | `strict: true` (nebo `extends` strict preset frameworku); žádné `allowJs` na zdrojích App. |
| `biome.json` (v App nebo Modulu) | lint + format; `bun run check` = typecheck + biome. |
| `README.md`, `AGENTS.md` Modulu | co App dělá, jak ji vyvíjet; pravidla scope. |

**Přesun leasu do poolu.** Dosavadní pravidlo `lazurio module setup`
(„existující platný lease se automaticky nemění", `--adopt-port` jako vědomé
tvrzení operátora; [module-setup.md](module-setup.md)) platí dál pro běžný
provoz: mimo převod se port nepřečíslovává. Při **převodu Modulu na standard**
(vlny W1–W2) je lease mimo pool Organizace vada `MS-01` a přesouvá se na
nejnižší volný port poolu jako koordinovaná migrace: `--apply` zapíše nový
lease a report i PR uvedou mapování starý → nový port; hostované gateway
čtou lease z manifestu a po dalším apply Machines obsluhují nový port; přesun
se odmítne, dokud se číslo portu vyskytuje ve zdrojích nebo konfiguraci App
(nejdřív se odstraní natvrdo zapsaný port, kap. 4.2). Cross-Organization
takeover kontrakt Launchpadu zůstává pro dobu před cutoverem; po cutoveru
kolize mezi Organizacemi nevznikají, protože pooly jsou disjunktní.

Zakázané v Modulu: `.env`, `.env.local`, `.env.development` a jakýkoli
`.env*` na start cestě (kap. 4.3); `node_modules` v Gitu; symlinky vytvářené
při startu; absolutní cesty na konkrétní stroj; `modules/` layout (Moduly
žijí ve `workspace/`).

## 3. Příprava (`lazurio.preparation`)

Každá App **deklaruje** přípravu; výchozí příprava Platformy (F25) zůstává
pro adopci cizích Modulů, ne pro konformní Modul.

```json
"lazurio": {
  "runtime": { "...": "kap. 4" },
  "preparation": {
    "schema_version": "lazurio.preparation.v1",
    "owner_package": "app/v3/package.json",
    "prepare_script": "prepare:app",
    "check_script": "check:prepared"
  }
}
```

Jména skriptů přípravy **nesmí** být npm lifecycle jména (`prepare`,
`preprepare`, `postprepare`, `install`, `postinstall`, `prepublish`,
`prepack`…): `bun install` je spouští
samo, takže by build běžel uvnitř instalace závislostí, kterou drží Platforma.
Konvence: `prepare:app` a `check:prepared`.

- Gramatika `owner_package` a jmen skriptů je totožná se čtečkou Platformy
  (`parsePreparationDeclaration`, F25): segmenty `[A-Za-z0-9._-]` bez `..`,
  jména skriptů `^[A-Za-z][A-Za-z0-9:_-]*$`; schéma navíc vyžaduje alespoň
  jeden adresář (App nikdy v kořeni) a zakazuje lifecycle jména. Co schéma
  přijme, Platforma spustí — s výjimkou rezervované Python formy.
- `runtime`: `bun` (výchozí, **klíč se u Bun App nezapisuje**) nebo `uv`
  (Python, kap. 7). Klíč přidává schéma `lazurio-preparation.schema.json`;
  chybí-li, platí `bun`. **Mezikrok:** čtečka LazurioPlatform
  (`lazurio.preparation.v1`, F25) dnes neznámá pole odmítá; dokud vydání
  Platformy klíč `runtime` nečte (DEV-6634 W0-5), Bun App ho vynechá a
  Python App (která ho potřebuje) Platforma spustit neumí — to je jeden z
  důvodů, proč adaptér `uv` vzniká až s prvním reálným Python Modulem.
  Konformance (`MS-04`) bere chybějící klíč jako `bun`.
- `prepare_script` dělá **všechno**, co start nesmí: build klienta, generování
  dat, `ensure` symlinků, migrace repository-db, stažení WASI bindings…
  Musí být idempotentní a bez síťového volání mimo instalaci závislostí.
- `check_script` je read-only: vrátí 0, když je App připravená, jinak nenulu.
  Launchpad ho volá před startem; selhání znamená „připrav", ne „spusť".
- Instalace závislostí (`bun install --frozen-lockfile` z lockfilu vedle
  package.json) je součástí přípravy, kterou drží Platforma; skript ji
  neopakuje.

## 4. Start kontrakt

### 4.1 `dev` skript spouští jeden proces a nic jiného

`dev` (nebo jméno v `lazurio.runtime.dev_script`) spustí právě **jeden
dlouho běžící proces serveru App**. Nesmí: buildovat, spouštět `concurrently`
nebo jiný supervizor, vytvářet soubory či symlinky, spouštět migrace, číst
`.env`, měnit `NODE_ENV`, přebírat porty. Sub-procesy jsou dovolené jen jako
děti tohoto procesu (například Vite dev middleware uvnitř Bun serveru).

Povolené tvary:

```json
"dev": "bun run src/server.ts",
"dev": "bun ./node_modules/vite/bin/vite.js --host \"$LAZURIO_RUNTIME_LISTENER_APP_HOST\" --port \"$LAZURIO_RUNTIME_LISTENER_APP_PORT\" --strictPort",
"dev": "astro dev"
```

Skript funguje, když je v `PATH` jen `bun` (Launchpad dává
`~/.local/bin:/usr/local/bin:/usr/bin:/bin`). `node`, `npx`, `nvm`, `bunx`
a globální nástroje se na start cestě nepoužívají; lokální binárky se volají
přes `bun <cesta>` nebo jako package skript (Bun je spouští sám).

### 4.2 Host a port

App čte host a port **výhradně** z `LAZURIO_RUNTIME_LISTENER_<ID>_HOST` a
`LAZURIO_RUNTIME_LISTENER_<ID>_PORT` (F26) pro každý listener deklarovaný
v `lazurio.runtime.listeners[]`; externí adresu z
`LAZURIO_RUNTIME_LISTENER_<ID>_EXTERNAL_ORIGIN`. Chybí-li proměnná, App
**neběží** (exit 2 s jasnou hláškou) — nehádá port z lease souboru ani
z `PORT`. Starý pár `LAZURIO_RUNTIME_HOST/PORT` a `PORT` se nečtou.

Vite/Astro dev servery přijmou vlastní host jen z `_EXTERNAL_ORIGIN`
(`server.allowedHosts`); loopback vždy. Nikdy `--host 0.0.0.0`.

### 4.3 Konfigurace a tajemství

Konfigurace App = runtime env (F26 allowlist) + soubory commitnuté v repu
(`config/*.json`, výchozí hodnoty). Tajemství nikdy nejsou v repu ani
v `.env`; App si je bere z vaultu Environmentu (DEV-6631) nebo od uživatele
v UI. Demo/offline režimy jsou samostatné skripty (`dev:demo`), ne start.

### 4.4 Připravenost, signály, ukončení

- `lazurio.runtime.listeners[].health` je cesta, která vrátí **200** až když
  App skutečně obsluhuje; do té doby 503 nebo nic.
- `SIGTERM` = do 10 s čistě skončit (exit 0). Fatální stav = nenulový exit;
  App se sama nerestartuje.
- Logy jen na stdout/stderr (journal Launchpadu), ne do souborů v repu.
- App nezapisuje mimo svůj Modul a `XDG_STATE_HOME`/`XDG_CACHE_HOME`
  Environmentu.

## 5. Hranice a závislosti

- App importuje jen ze svého repozitáře a z deklarovaných závislostí
  v `package.json`. **Zakázané**: `../../../launchpad/…`, `<org>/infra/…`,
  `<org>/design-system/…`, jiný Modul (`../deals/app/…`), `file:` mimo repo.
- Sdílené kontrakty Organizace (`launchpad/contracts/v1`,
  `launchpad/apps/shared`) se stanou **verzovaným balíčkem** vlastněným
  Organizací (repo `<Org>/workspace-contracts`, závislost `github:<Org>/workspace-contracts#v1.x.y`) nebo se vloží do Modulu, který je jediný používá.
- Brand assety design systému se do App dostanou jako závislost na balíčku
  design systému, ne relativní cestou.
- Git submoduly jsou dovolené jen pro cizí kód s vlastním lockfilem; nesmí
  být na start cestě.
- Data: repository-db vždy jako závislost na **jedné vydané verzi**
  (`github:Lazurio/repository-db#v3.x.y`), ne na SHA větve.

## 6. Jazyk a stacky

- Jazyk App je **TypeScript strict**. `.js/.mjs/.cjs` se v App nepíší; nové
  JS zdroje jsou nekonformní. Konfigurace frameworků v TS (`vite.config.ts`,
  `astro.config.ts`).
- Povolené stacky (jiný = rozhodnutí Principála, ne tichá výjimka):

| Druh App | Stack | Poznámka |
| --- | --- | --- |
| UI / datová aplikace | Vite + React + TypeScript, data přes repository-db v3 | výchozí pro Deals, Pricebook, Warehouse, Clients… |
| Web, dokumentace, knowledgebase | Astro (Starlight pro KB), TS config | statický build je příprava |
| Služba / API / automatizace | Bun (`Bun.serve`) + TypeScript | bez frameworku; `@lazurio/module-kit` pro listener/health |
| Python (kap. 7) | `uv` + `pyproject.toml` | první reálný modul zapne adaptér Platformy |

- **`@lazurio/module-kit`** (repo `Lazurio/module-kit`, závislost
  `github:Lazurio/module-kit#v0.x.y`): `listener("APP")` → `{host, port,
  externalOrigin}` z F26 env s fail-closed chybou, `health()` handler,
  `onShutdown()` pro SIGTERM, `viteServerOptions()`/`astroServerOptions()`
  pro dev servery a `viteShutdownPlugin()` (Vite sám hlásí po SIGTERM
  128 + signál a otevřené keep-alive spojení drží `close()`; plugin spojení
  zavře, `close()` ohraničí a skončí 0 — od v0.2.0). Nahrazuje kopie
  `runtime-listener.mjs` i lokální shutdown pluginy. Je to jediná sdílená
  runtime knihovna Modulu; neroste v framework.
- Kvalita: `bun run check` (tsc `--noEmit` + `biome check`) a `bun test`
  v každé App; CI repozitáře je spouští na každém PR.

## 7. Python Modul

Pro App v Pythonu platí stejný kontrakt s těmito ekvivalenty:

| TS/Bun | Python |
| --- | --- |
| `packageManager: bun@…` | `requires-python` + `[tool.uv]` v `pyproject.toml`; přesná verze `uv` v `lazurio.preparation.uv_version` (povinná při `runtime: uv`) |
| `app/v<N>/package.json` jako nositel `lazurio.*` | `app/v<N>/pyproject.toml` s tabulkou `[tool.lazurio]` se stejnými klíči `runtime` a `preparation`; `owner_package` ukazuje na `pyproject.toml` |
| `bun.lock` | `uv.lock` (commitnutý; `uv sync --frozen`) |
| `dev: bun run src/server.ts` | `[project.scripts]` definuje Python entry point `<slug> = "<balíček>.server:main"`; `lazurio.runtime.dev_script` = jméno toho entry pointu a Platforma jej spouští jako `uv run <slug>` (jeden proces) |
| `tsconfig strict` + biome | `ruff` + `pyright`/`mypy strict` |
| `@lazurio/module-kit` | `lazurio-module-kit` (Python balíček z téhož repa) |

`lazurio.preparation.runtime: "uv"` říká Platformě, že příprava je
`uv sync --frozen` a start `uv run <entry point>`; `uv` je nástroj katalogu
Environmentu v přesné verzi `uv_version`. Schéma se rezervuje teď (`owner_package` smí být
`package.json` nebo `pyproject.toml`; při `runtime: uv` je `uv_version`
povinná); čtení `[tool.lazurio]` z `pyproject.toml` a adaptér Platformy
vznikají s prvním reálným Python Modulem (proof na skutečném consumerovi).
Do té doby `MS-04` Python App hlásí `warn`, ne `pass`.

## 8. Generace App a úklid

- Modul drží nejvýše **dvě generace App**: výchozí a jednu další — buď
  předchozí (ponechanou pro návrat), nebo kandidátní novější, která ještě
  není výchozí (migrační okno, např. `v2` výchozí a `v3` nad repository-db).
  Přepnutí `default_app` na kandidáta je rozhodnutí Stewarda nebo Principála,
  ne oprava konformance. Starší generace (Firebase éra `app/v1`, nepoužívané
  `v2`) se mažou; Git historie zůstává. Rozhodnutí Principála 2026-09-30.
- `apps[]` odpovídá adresářům: package bez deklarace v `apps[]` v repu není.

## 9. Organizace

- Každá Organizace má kanonický `lazurio.organization.json`
  (`lazurio migrate organization-manifest`); `company.gen3.json` je do
  finalizace generovaná projekce (stav `transition`), potom se odstraní.
- `modules.manifest.json` odpovídá adresářům `workspace/`: každý přítomný
  Modul je deklarovaný, každý deklarovaný aktivní slot je materializovaný nebo
  označený `planned_slot`; repository-db děti jsou deklarované jako
  `module_slots` s `repository_db_mount`.
- `module_port_pool` Organizace: 100 portů; pooly různých Organizací jsou
  **disjunktní** (root doctor to kontroluje napříč namountovanými
  Organizacemi; žádný centrální registr nevzniká). Každý lease Modulu leží
  v poolu.
- Org-level aplikace (Mission Control, design system) jsou samostatná repa
  se `lazurio.module.json`; nejsou soubory Organization root repa.
- Mission Control v3 běží ve všech Organizacích ze stejné vydané verze app
  kódu; Organizace liší jen `db/`.
- Layout `modules/` je zrušený.

## 10. Co drží Launchpad (a co nedělá)

Launchpad (LazurioPlatform) drží **jednu politiku** pro všechny Moduly:

- příprava před startem (`check_script` → `prepare_script`), start `dev`
  skriptu s uzavřeným env (F26), `umask 077`, loopback;
- **supervize**: proces, který skončí nenulově, restartuje s omezeným
  backoffem (1 s, 5 s, 30 s; po třetím selhání stav `failed` viditelný v
  Launchpadu a Diagnostice; další start je explicitní). Rozhodnutí Principála
  2026-09-30 uzavírá LazurioPlatform #104 řádek 3 jako standard, ne výjimku;
- obsazený port = chyba Modulu (`port-occupied`), Launchpad nepřebírá cizí
  procesy;
- nekonformní Modul: do cutoveru `warn` v Diagnostice a katalogu, po
  cutoveru (decision 0171, datum doplní rollout) start odmítne s kódem
  `module-nonconformant` a odkazem na výstup `lazurio module setup`.

Launchpad **nedělá**: nedědí PATH ani env operátora, nečte `.env`,
nespouští build ani supervizory za App, nepřebírá porty, nenabízí legacy
`LAZURIO_RUNTIME_HOST/PORT` (odstraní jedno vydání po dokončení W2 migrace).

## 11. Konformance: `lazurio module setup`

`lazurio module setup <module-root> --root <lazurio-root>` (viz
[module-setup.md](module-setup.md)) rozšiřuje read-only kontrolu o standard.
Každá kontrola má stabilní ID a stav `pass | fail | warn`; `actionable` plán
umí opravit mechanické položky (`packageManager`, chybějící `check`/`test`
skript, `lazurio.preparation` skeleton, lease mimo pool na volný port poolu).

| ID | Kontrola |
| --- | --- |
| `MS-01` | `lazurio.module.json` platné, `id` = slot, každý lease v poolu Organizace, pooly disjunktní |
| `MS-02` | každá App: `packageManager` přesný Bun, lockfile commitnutý a čerstvý |
| `MS-03` | `lazurio.runtime` s listenery a health; `dev_script` existuje |
| `MS-04` | `lazurio.preparation` deklarované; `check_script` existuje; `runtime` chybí (= `bun`) nebo `uv`; `runtime: "bun"` zapsané explicitně je do W0-5 vada (Platforma ho odmítne); `prepare_script`/`check_script` nejsou npm lifecycle jména |
| `MS-05` | `dev` skript je jednoprocesový: bez `&&`, `concurrently`, `build`, `npx`, `node`, `bunx`, `nvm`, inline `VAR=…` |
| `MS-06` | žádné čtení `LAZURIO_RUNTIME_HOST`, `LAZURIO_RUNTIME_PORT`, `PORT`, `COMPANYASCODE_*`, lease souboru ze zdrojů App |
| `MS-07` | žádné `.env*` na start cestě; žádné `dotenv` |
| `MS-08` | TypeScript strict; žádné `.js/.mjs/.cjs` zdroje App (config frameworku v TS) |
| `MS-09` | žádné importy mimo repo (`../` nad kořen Modulu, `file:` mimo repo, jiný Modul, `launchpad/`, `infra/`, `design-system/`) |
| `MS-10` | závislost repository-db a module-kit připnutá na vydaný tag |
| `MS-11` | žádné absolutní cesty na stroj, žádné symlinky vytvářené při startu, žádné `modules/` |
| `MS-12` | `apps[]` odpovídá adresářům; nejvýše dvě generace App (výchozí a jedna předchozí nebo kandidátní) |
| `MS-13` | `bun run check` a `bun test` skripty existují (spuštění je věc CI Modulu) |

Report `lazurio.module_setup.report.v1` nese seznam kontrol; `current`
znamená všechny `pass`. Platforma čte totéž (Diagnostika, katalog), nepíše
si vlastní tabulku.

## 12. Migrace (W0–W3)

Program drží Mission Control plán DEV-6634 (privátní; jmenuje konkrétní
Organizace). Pořadí určil Principál: pilot = Organizace maintainerů
(HumanAndMachine-ai) + největší klientská Organizace → Organizace
s hostovanými Environmenty → ostatní.

- **W0 kontrakt**: tento manuál, decision 0171, `lazurio-preparation.schema.json`, konformance v `lazurio module setup`, `Lazurio/module-kit` v0.1, root doctor pool disjunktnosti.
- **W1 pilot**: Organizace maintainerů (14 Modulů, už kanonická) a největší klientská Organizace (20 Modulů): per-Modul PR (jeden Modul = jeden PR = jeden worktree), Organization PR (manifest reconciliation, pooly, org-level repa), ověření startem přes Platform Launchpad na Environmentu.
- **W2 zbytek**: šablonové změny (KB 14×, MC 14×) jako jedna změna replikovaná; per-Organization PR pro Stewardy; migrace manifestů `lazurio migrate organization-manifest`.
- **W3 cutover**: Platforma odstraní legacy env pár, zapne `module-nonconformant`; decision 0171 dostane datum cutoveru.

- **W4 nový Modul podle standardu** (kap. 13): scaffold v Core, založení
  repa a slotu z Dashboardu, skill a instrukce pro agenty, Knowledgebase.
  W4 běží **souběžně s W1–W3** a na cutover nečeká — nový Modul má vznikat
  konformně co nejdřív; cutover (W3) naopak na W4 nečeká.

Ne-cíle: přepis fungujících aplikací do jiného stacku „pro pořádek",
sjednocení vzhledu, nový framework pro služby, centrální registr portů,
generický bridge pro legacy chování v Launchpadu.

## 13. Nový Modul vzniká už podle standardu

Cíl (Principál 2026-09-30): nový Modul se **nezakládá ručně** ani se lokální
repo neváže na GitHub dodatečně. Tři vrstvy, každá s vlastním ownerem:

1. **Scaffold v Core** — `lazurio module create <Org>/<slug> --stack
   vite-react | astro | astro-starlight | bun-service | python-uv --port-lease
   <id>` vytvoří v task worktree Organizace kompletní konformní Modul
   (`lazurio.module.json` s leasem z volného portu poolu, `app/v1/` se
   šablonou stacku, `lazurio.runtime`, `lazurio.preparation`, `bun.lock`,
   `tsconfig` strict, biome, `check`/`test`, README, AGENTS.md, CI workflow
   spouštějící `bun run check && bun test`) a hned ho ověří `lazurio module
   setup` → `current`. Šablony stacků žijí v Core (`lazurio/templates/module/<stack>/`),
   ne v Organizaci; Organization Template je jen konzument.
2. **Založení repa a slotu z Dashboardu** — tlačítko „Nový Modul" v
   Dashboardu (Organization Admin): vybere Organizaci, slug, stack, Team(y);
   Dashboard přes GitHub App založí privátní repo `<Org>/<slug>` s výchozí
   ochranou `main`, naplní ho scaffoldem (stejný Core kód, stejná šablona), a
   otevře PR do root repa Organizace, který přidá slot do
   `modules.manifest.json` (Team, `ui_exposure`, `repository_db_mount` je-li
   datový). Po merge `lazurio update` Modul materializuje na každém
   Environmentu; Launchpad ho ukáže bez ručního linkování. Navazuje na plán
   DEV-6514 (Admin zakládá Moduly jen přes Dashboard a GitHub); GitHub zůstává
   jedinou autoritou přístupů, Dashboard nevede druhý roster.
3. **Agenti** — root `AGENTS.md` odkazuje na tento standard; skill
   `.agents/skills/lazurio-module-standard/SKILL.md` říká, jak Modul založit,
   převést a ověřit; Knowledgebase (`lazurio-ai` namespace) drží syntézu „proč
   takhle". Nový Modul mimo standard je nekonformní od prvního commitu.
