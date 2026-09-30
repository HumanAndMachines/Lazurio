# Nový Modul: `lazurio module create`

Nový Modul vzniká podle Lazurio Module Standardu od prvního commitu
([module-standard.md](module-standard.md) kap. 13, decision 0171). Ručně se
nezakládá a lokální repozitář se na slot dodatečně nepřivazuje. Tento manuál
popisuje Core scaffold: co příkaz zapíše, co odmítne a jaký kontrakt z něj
převezme Dashboard „Nový Modul“.

## Kdy použít

- Principál chce nový Modul Organizace (aplikaci, web, dokumentaci, službu
  nebo repozitář bez App).
- Nepoužívej pro převod existujícího Modulu; ten jde přes
  `lazurio module setup` ([module-setup.md](module-setup.md)).
- Nepoužívej pro productionspace repa (decision 0041) ani pro Organization
  root boundaries (`infra`, `design-system`, `mission-control`).

## Postup

1. `lazurio update` a `bun run doctor:task` v primárním checkoutu.
2. Založ task worktree root repa Organizace; primární checkout Organizace
   zůstává na `main`:

   ```sh
   bun run worktrees:create -- --plan <KOD> --repository organizations/<Org-mount>
   ```

3. Z tohoto worktree ověř plán a potom Modul vytvoř:

   ```sh
   lazurio module create <Organization>/<slug> --stack <stack> --dry-run
   lazurio module create <Organization>/<slug> --stack <stack> [--name "<název>"] [--teams a,b] [--port N]
   ```

4. Commitni `modules.manifest.json` ve worktree Organizace a otevři PR do
   root repa Organizace. Organization Admin založí privátní GitHub repo
   `<github-org>/<slug>` s chráněnou `main`; Modul se do něj pushne
   (`git remote add origin …` a `git push -u origin main`, přesné příkazy
   vypíše report). Merge slotu je Publikace a patří oprávněnému Principálovi.
5. Po merge slotu `lazurio update` Modul materializuje na každém
   Environmentu; `lazurio module start <Organization>/<slug> --json` ho
   spustí.

`<Organization>` je přesný `company.slug` namountované Organizace. Příkaz
pozná task worktree podle aktuální složky: když leží v Git worktree téhož
repozitáře jako primární mount Organizace, zapisuje do něj. Jinak míří na
primární mount a na `main` odmítne zapisovat.

## Stacky

| `--stack` | App | Health | Příprava |
| --- | --- | --- | --- |
| `vite-react` | Vite + React + TypeScript strict | `/` | `check:prepared` (závislosti) |
| `astro` | Astro | `/` | `prepare:app` = `astro sync`, `check:prepared` |
| `astro-starlight` | Astro + Starlight | `/` | `prepare:app` = `astro sync`, `check:prepared` |
| `bun-service` | `Bun.serve` + TypeScript strict, kontrola `Host` | `/healthz` | `check:prepared` (závislosti) |
| `python-uv` | Python přes `uv`, `http.server`, ruff + pyright strict + pytest | `/healthz` | `runtime: uv`, `check:prepared` = `uv sync --frozen --check` |
| `none` | bez App (`tcp_port_policy: none`, `apps: []`) | — | — |

Každá App má listener `app` na leasu `main`, čte host a port jen přes
`@lazurio/module-kit` (bez proměnných skončí kódem 2), cizí `Host` odmítne
403 a na `SIGTERM` skončí 0. Vite App nese dočasný `process.exitCode = 0`
na `SIGTERM` do vyřešení Lazurio/module-kit#2. Python App je připravená na
adaptér `uv` v Platformě (DEV-6634 W0-5); do té doby `lazurio module setup`
hlásí `MS-04` a `MS-08` jako `warn` a App se ověřuje ručně
`uv run --no-sync <slug>`. Deklarace je v `app/v1/package.json` (tu čte Core)
i shodně v `[tool.lazurio]` v `pyproject.toml`.

## Co příkaz zapíše

- `<organization-root>/workspace/<slug>/`: `lazurio.module.json` (lease
  z nejnižšího volného portu `module_port_pool`, který nedrží žádný Modul na
  Mašině), `app/v1/` podle stacku, `README.md`, `AGENTS.md`, `.gitignore` a
  `.github/workflows/check.yml` (`bun install --frozen-lockfile`,
  `bun run check`, `bun test`; u Pythonu `uv sync --frozen`).
- Do `modules.manifest.json` téhož checkoutu přesně jeden slot
  `workspace/<slug>` (`teams` jen při `--teams`, `git.url`
  `git@github.com:<github-org>/<slug>.git`). Ostatní bajty souboru zůstanou
  beze změny; vložení se ověří parsováním.
- `bun install` v App (u `python-uv` `uv lock`, je-li `uv` v `PATH`), takže
  vznikne commitnutý `bun.lock` / `uv.lock`. Proměnná
  `LAZURIO_SCAFFOLD_SKIP_INSTALL=1` instalaci přeskočí (jen testy a offline
  náhled; `MS-02` pak hlásí chybějící lockfile).
- `git init` s větví `main` a první commit Modulu (autor z Git konfigurace).
- Nakonec změří výsledek stejnými kontrolami jako `lazurio module setup`
  (`MS-01`–`MS-13`) plus kontrakt `lazurio.module.json` a `lazurio.runtime`.

Lease se volí pod stejným Organization lockem jako v `lazurio module setup`.
Selže-li zápis souborů nebo slotu, příkaz složku z tohoto běhu smaže a nic
jiného nemění.

## Co odmítne

| Kód | Význam |
| --- | --- |
| `organization_root_on_main` | Organization checkout je na `main` nebo detached; spusť z task worktree (s `--dry-run` projde) |
| `invalid_slug`, `reserved_slug` | slug není lowercase kebab-case začínající písmenem (max. 50 znaků), nebo je rezervovaný (`productionspace`, `personalspace`, `mission-control`, `launchpad`, `design-system`, `infra`…) |
| `slot_exists`, `directory_exists` | slot nebo složka se stejným jménem už existuje (i při jiné velikosti písmen) |
| `unknown_stack`, `invalid_display_name`, `invalid_team`, `unknown_team` | neplatný vstup; Team musí být deklarovaný v Organizaci |
| `pool_missing`, `pool_exhausted`, `port_outside_pool`, `port_taken`, `port_not_allowed` | port: Organizace nemá pool, pool je plný, `--port` mimo pool nebo obsazený, `--port` u stacku `none` |
| `organization_not_found`, `organization_manifest_not_mutation_safe`, `module_contracts_unreadable` | Organizace není namountovaná, její manifest není bezpečný pro zápis, nebo nejdou přečíst leasy ostatních Modulů |

## Report a exit kódy

`--json` vrací `lazurio.module_create.report.v1`: `status`, `reason`,
`organization` (`root`, `source: primary | worktree`, `branch`),
`module_root`, `slot`, `lease`, `tree_hash`, `files[]` (cesta a velikost),
`generated_by_install`, `warnings`, `issues`, `standard.checks[]` a
`next_steps[]`. Exit kódy drží konvenci `lazurio module setup`:

- `0` `completed` — Modul zapsaný, commitnutý a bez `fail` kontroly;
- `1` `actionable` — `--dry-run`, plán připravený, nic nezapsáno;
- `2` `blocked` (nic nezapsáno) nebo `action_required` (zapsáno, ale selhala
  instalace, commit nebo kontrola; kroky jsou v `issues[].action`);
- `3` chyba použití.

## Kontrakt pro Dashboard: `planModuleScaffold`

Jediný generátor nového Modulu je čistá funkce `planModuleScaffold` v
`lazurio/module-scaffold-lib.mjs`. CLI i Dashboard „Nový Modul“
(DEV-6634 úkol 407) volají stejnou funkci se stejnými šablonami; druhý
generátor nevzniká.

- **Vstup:** `organization` (`slug`, `github_org`, `module_port_pool`,
  `existing_slots[]` z `modules.manifest.json`, `existing_leases[]` všech
  Modulů, které volající vidí, volitelně `teams[]` roster), `slug`,
  `display_name`, `stack`, `teams[]`, volitelný `port`, `templates`
  (`loadModuleTemplates()` nebo stejná data z vydané verze Core) a
  `versions` (`bun` z `lazurio/package.json`, `module_kit`, `uv`;
  výchozí `DEFAULT_SCAFFOLD_VERSIONS`).
- **Výstup:** `files[]` (`path`, `content`, volitelně `mode`), přesný `slot`
  pro `modules.manifest.json`, `lease` (nebo `null` u `none`),
  `generated_by_install` (lockfile, který čistá funkce vyrobit neumí),
  `warnings[]` a `tree_hash` (sha256 přes seřazené cesty, módy a obsah).
- **Vlastnosti:** bez I/O a bez sítě; stejný vstup dává stejný výstup a
  stejný `tree_hash`; chyby jsou `ModuleScaffoldError` se stabilním `code`
  (tabulka výše bez kódů, které patří zapisujícímu volajícímu).
- **Slot:** `insertModuleSlotText(text, slot)` vloží slot do textu
  `modules.manifest.json` bez přeformátování; Dashboard ho použije pro PR do
  root repa Organizace.
- **Na volajícím zůstává:** založení GitHub repa a ochrany `main`, commit
  souborů, vytvoření lockfilu (`bun install` / `uv lock` v izolovaném běhu,
  bez něj `MS-02` neprojde), PR se slotem a ověření `lazurio module setup`.

## Co záměrně nedělá

- Nezakládá GitHub repo, nepushuje, neotevírá PR a nic nemerguje; to je
  Publikace, Organization Admin a později Dashboard (úkol 407) přes GitHub
  App.
- Nespouští Launchpad ani App; start přes Launchpad ověřuje
  `lazurio module start` po merge slotu. Python start přes Launchpad přijde
  s adaptérem `uv` (úkol 405).
- Nemění existující Moduly, porty ani Organization pool.

Šablony, jejich vrstvy a placeholdery popisuje
`lazurio/templates/module/README.md`.
