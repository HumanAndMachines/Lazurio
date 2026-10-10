---
name: lazurio-module-standard
description: Use whenever a Task Agent creates a new Lazurio Module, converts an existing Module to the Lazurio Module Standard, or verifies conformance before a PR. Covers the required manifests and files, the single-process start contract, the runtime environment, repository boundaries, the allowed stacks (TypeScript strict; Python through uv), the `lazurio module setup` conformance gate and the per-Module PR flow. Never patch the Launchpad around a Module's deviation; fix the Module.
version: 1.0.0
author: Lazurio
license: MIT
metadata:
  hermes:
    tags: [module, standard, typescript, bun, launchpad, conformance, scaffold]
    related_skills: [worktree-development-discipline]
---

# Lazurio Module Standard

## Overview

Autorita je [`manual/module-standard.md`](../../../manual/module-standard.md)
(decision 0171) a schémata v `lazurio/schemas/`. Tento skill je pracovní
postup nad nimi: jak Modul založit, převést a ověřit tak, aby ho Launchpad
spustil bez výjimek. Odchylka Modulu se opravuje v Modulu; Launchpad pro ni
nedostává workaround.

Zkrácený kontrakt, který drží každá App Modulu:

- `lazurio.module.json` (`id` = slot, lease v poolu Organizace, `apps` +
  `default_app`), v každé App `packageManager: bun@<přesná verze>`,
  `lazurio.runtime` (listenery + health), `lazurio.preparation`
  (`owner_package`, `prepare_script`, `check_script`; klíč `runtime` jen
  pro `uv` — Bun App ho vynechá, Platforma dnes neznámá pole odmítá), commitnutý
  `bun.lock` / `uv.lock`, `tsconfig` strict, biome, skripty `dev`, `check`,
  `test`.
- `dev` spouští **jeden proces serveru** a nic jiného; funguje jen s `bun` v
  `PATH`; host/port jen z `LAZURIO_RUNTIME_LISTENER_<ID>_HOST/_PORT`, externí
  adresa z `_EXTERNAL_ORIGIN`, adresa API deklarovaného souseda jen
  z `LAZURIO_RUNTIME_SIBLING_<SLUG>_ORIGIN`; žádné `.env*`, `PORT`,
  `LAZURIO_RUNTIME_HOST`, `COMPANYASCODE_*`, lease soubor.
- Žádné importy mimo repo Modulu (`../../../launchpad/…`, jiný Modul,
  `infra/`, `design-system/`); sdílené věci jen jako verzované závislosti
  (`github:<owner>/<repo>#v…`), repository-db a `@lazurio/module-kit` na
  vydaném tagu.
- TypeScript strict; stack Vite + React (UI/data), Astro (web/KB), Bun
  (služby), `uv` (Python). Nejvýše dvě generace App: výchozí a jedna
  předchozí nebo kandidátní.

## Co platí dnes a co je cílový stav

Standard je přijatý (decision 0171), mechanismy přicházejí po vlnách. Agent
si před prací ověří, co má k dispozici, a nevydává starší stav za důkaz:

| Mechanismus | Stav | Co to znamená pro postup |
| --- | --- | --- |
| `lazurio module setup` s `standard.checks[]` (`MS-01`–`MS-13`) | vzniká (HumanAndMachines/Lazurio#454); dostupný, když report obsahuje klíč `standard` | Bez `standard.checks[]` je `current` jen důkaz platného kontraktu Modulu, **ne** konformance. Agent pak projde kapitoly 2–9 manuálu ručně a v PR to napíše. |
| `lazurio module create` (scaffold) | vzniká (HumanAndMachines/Lazurio#458, stacky vite-react, astro, astro-starlight, bun-service, python-uv, none; dostupný, když `lazurio module create --help` odpoví) | Do vydání nový Modul zakládá jen Organization Admin na základě rozhodnutí Operátora: repo na GitHubu + slot PR; obsah Modulu Agent připraví podle kapitol 2–6 manuálu a po vydání scaffoldu ho sladí se šablonou. Není to „ruční zakládání" ve smyslu zákazu — zákaz míří na Moduly bez slotu, bez repa a mimo standard. |
| Dashboard „Nový Modul" | cílový stav (DEV-6634 W0-7, DEV-6514) | Do vydání zakládá repo a slot Admin ručně přes GitHub a PR. |
| `@lazurio/module-kit` | vydaný v0.2.0 (`github:Lazurio/module-kit#v0.2.0`; `listener`, `health`, `onShutdown`, `viteServerOptions`/`astroServerOptions`, `viteShutdownPlugin`) | Používej hned; Vite App vždy s `viteShutdownPlugin()`. |
| Platform Launchpad: supervize, `module-nonconformant`, `uv` | cílový stav (W0-5, W3) | Nekonformní Modul dnes Launchpad spustí; standard přesto platí pro každý PR. |

## Kdy použít

- Operátor chce nový Modul nebo novou App v Modulu.
- Modul má být převeden na standard (program DEV-6634, wave W1–W2).
- Před každým PR do Modulu (konformance je součást preflightu).
- Launchpad hlásí `module-nonconformant` nebo Diagnostika `warn` u Modulu.

Nepoužívej pro Organization manifest (na to je
`lazurio migrate organization-manifest`, viz `manual/lazurio-manifest-family.md`)
ani pro productionspace repa (decision 0041).

## Postup

### A. Nový Modul

1. Scope: Organizace `organizations/<Org>/`, přečti její `AGENTS.md`;
   `lazurio update` + `bun run doctor:task` v primárním checkoutu.
2. Slot a port: ověř v `modules.manifest.json`, že slug je volný, a vyber
   volný port z `module_port_pool` Organizace (`lazurio module setup` ho
   navrhne). Slot přidává PR do root repa Organizace (nebo Dashboard, až
   bude tlačítko „Nový Modul" vydané); Modul bez slotu se nematerializuje.
3. Scaffold v task worktree Organizace:
   `lazurio module create <Org>/<slug> --stack vite-react | astro |
   astro-starlight | bun-service | python-uv | none [--name …] [--teams …]
   [--port N] [--dry-run]` (vloží i slot do `modules.manifest.json` téhož
   worktree a udělá první commit). Dokud scaffold v Core není
   vydaný (viz tabulka výše), připrav stejné soubory podle kapitol 2–6
   manuálu — App vždy v `app/v1/`, `lazurio.module.json` se slotem a leasem
   z poolu, `lazurio.runtime` + `lazurio.preparation`, `packageManager`,
   lockfile, strict `tsconfig`, biome, `check`/`test`, README, `AGENTS.md`,
   CI — a v PR uveď, že vznikl bez scaffoldu.
4. `lazurio module setup <module-root> --root <lazurio-root> --json` musí
   vrátit `current` **a** report musí obsahovat `standard.checks[]` se všemi
   `pass`; bez klíče `standard` doplň ruční kontrolu kapitol 2–9 a napiš to
   do PR.
5. `bun run check && bun test` v App; `lazurio module start <Org>/<slug>
   --json` přes běžící Launchpad a otevři `result.runtime.url`.
6. Repo Modulu: GitHub repo `<Org>/<slug>` (zakládá Admin nebo Dashboard),
   CI workflow spouštějící `bun run check && bun test`, PR podle pravidel
   Organizace. Jeden Modul = jeden worktree = jedna branch = jeden PR.

### B. Převod existujícího Modulu

1. Spusť `lazurio module setup <module-root> --root <lazurio-root> --json`
   read-only a přečti `standard.checks[]` (bez toho klíče postupuj podle
   kapitol 2–9 manuálu a v PR to uveď). Mechanické položky nech opravit
   `--apply` (`packageManager`, skeleton `lazurio.preparation`). Lease
   `--apply` nepřesouvá: u leasu mimo pool hlásí `MS-01` volný port poolu,
   ten přepiš v `lazurio.module.json` ručně, mapování starý → nový port
   uveď v PR a start na novém portu dolož (`lazurio module start`). Ostatní
   opravuj ručně v tomto pořadí:
   1. **Start**: `dev` = jeden proces; vše ostatní (build, symlinky, data,
      migrace) přesuň do `prepare_script` (konvence `prepare:app`; nikdy
      npm lifecycle jméno jako `prepare`, které `bun install` spouští samo),
      read-only kontrolu do `check_script` (`check:prepared`). Odstraň `concurrently`, `&&`, `npx`, `node`, `bunx`,
      inline `VAR=…`.
   2. **Env**: host/port jen z listener-keyed proměnných; nahraď kopie
      `runtime-listener.mjs` závislostí `@lazurio/module-kit`; smaž čtení
      `PORT`, `LAZURIO_RUNTIME_HOST/PORT`, `COMPANYASCODE_*`, lease souboru;
      žádné `.env*` na start cestě a každé volání `bun` na start cestě
      s `--no-env-file` před vstupem (`bun --no-env-file run src/server.ts`)
      a bez `--env-file` (Bun jinak `.env*` načte sám; `MS-07`).
      **Tajemství** (klíč externí služby, token) App neukládá do `.env*`
      ani do vlastního souboru: deklaruje jejich jména
      v `lazurio.runtime.secrets` (`["EXTERNAL_API_KEY"]`), čte je
      fail-closed z `LAZURIO_RUNTIME_SECRET_<NAME>` (bez proměnné exit 2)
      a hodnotu Operátor uloží do kolekce Environmentu v trezoru
      Organizace; Launchpad ji předá při startu, chybějící tajemství
      start zastaví (kap. 4.3, decision 0177). Dokud Platform Launchpad
      deklaraci nečte, hlásí ji `MS-03` jako `warn` a App s ní nestartuje;
      deklaraci proto zapiš až s tím vydáním. Tajemství jen pro ručně
      spouštěný skript nedeklaruj; skript si ho čte z trezoru sám a README
      to popisuje.
   3. **Hranice**: odstraň importy mimo repo; sdílený kontrakt Organizace
      nahraď verzovanou závislostí nebo ho vlož do Modulu; repository-db na
      vydaný tag. **Sousední Modul** (decision 0176): čte-li App data jiného
      Modulu, deklaruj ho v `lazurio.runtime.required_module_slots`
      (`workspace/<slug>` nebo `workspace/<slug>/db`) a čti jen
      `../<slug>/…` od kořene Modulu (`db/`, read modely v `generated/`), nikdy
      přes `COMPANYASCODE_ORGANIZATION_ROOT`, jeho kód ani jeho
      `lazurio.module.json`/`package.json`. Odkaz pro prohlížeč na App
      souseda odvoď z vlastního `LAZURIO_RUNTIME_LISTENER_<ID>_EXTERNAL_ORIGIN`
      výměnou prvního labelu hostname za slug souseda; bez té proměnné odkaz
      nevykresli. **Volá-li App API souseda** (serverem, i zápisem), deklaruj
      ho jako slot Modulu `workspace/<slug>` a jeho adresu čti jen
      z `LAZURIO_RUNTIME_SIBLING_<SLUG>_ORIGIN` (loopback, předá ji Launchpad
      Platformy; decision 0176 dodatek z 2026-10-10, kap. 4.2): neplatná
      hodnota = exit 2; chybějící proměnná (Launchpad bez podpory) =
      funkce souseda odpoví typovanou chybou a App běží dál; App, jejíž
      deklarovaný soused na Environmentu není, Launchpad nespustí (0176
      bod 4); odmítnuté spojení = typovaná chyba (503) bez opakování; adresu nikdy
      nedávej prohlížeči a na zápis pošli `Origin` rovný této adrese. Převod
      z portu z leasu souseda na proměnnou mergni až tam, kde běží vydání
      Platformy, které ji předává. Start bránu podle Teamu z App odstraň. Zápis jednajícího
      Teamu do auditní stopy je otevřený (#467): nevymýšlej pro něj nový
      zdroj, ponech ho jako jediný zbývající nález `MS-06` s odkazem na #467
      a uveď to v PR.
   4. **Jazyk**: `.js/.mjs/.cjs` zdroje App převeď na TS (`git mv` + typy ve
      dvou commitech), `tsconfig` strict, biome, `check` + `test` skripty.
   5. **Generace**: smaž staré App generace (Firebase éra `v1`, nepoužívané
      `v2`); `apps[]` = adresáře. Novější kandidát vedle výchozí App zůstat
      smí; přepnutí `default_app` není součást převodu. Přesouvá-li se
      adresář App nebo maže generace, přidej staré cesty build výstupů
      (`/app/node_modules/`, `/app/.astro/`, `/app/dist/`…) do kořenového
      `.gitignore`, jinak `lazurio update` na existujících checkoutech
      skončí `blocked`. Pravidla neodebírej, dokud není úklid všech
      checkoutů ověřený.
   6. **Health**: deklarovaná `health.path` musí vrátit 200 přímo — sonda
      Launchpadu redirecty nenásleduje (`/cs/`, ne `/` s 301); ověř, že
      `curl -s -o /dev/null -w '%{http_code}' --max-redirs 0 <url>` vypíše
      přesně `200` (samotný návratový kód curl je 0 i při 301).
2. Opakuj `lazurio module setup … --json`, dokud není `current`; potom
   `bun run check && bun test` a skutečný start přes Launchpad
   (`lazurio module start`, otevři URL, `lazurio module stop`).
3. PR Modulu: popis říká, které kontroly byly `fail` před převodem a co se
   záměrně nemění (chování aplikace). Když převod vyžaduje změnu Organizace
   (slot, pool, sdílený balíček), jde to samostatným PR do root repa
   Organizace; oba PR se navzájem odkazují.
4. Nikdy neuprav Launchpad, Platform ani Core, aby Modul „prošel". Skutečná
   mezera standardu je issue v `HumanAndMachines/Lazurio` (manuál/schéma)
   nebo `Lazurio/LazurioPlatform` (consumer), ne výjimka v Modulu.

### C. Organizace (doprovodné PR)

- `lazurio migrate organization-manifest <org-root> --json` → `--write`
  (legacy → transition); `modules.manifest.json` srovnej s adresáři
  `workspace/`; `module_port_pool` disjunktní s ostatními Organizacemi na
  Mašině (`lazurio doctor` to hlásí); org-level aplikace jako samostatná
  repa se `lazurio.module.json`; layout `modules/` zruš.

## Ověření

- `lazurio module setup <module-root> --root <lazurio-root> --json` →
  `status: current` a `standard.checks[]` se všemi `pass` (je-li klíč
  `standard` přítomný; jinak ruční kontrola kapitol 2–9 zapsaná v PR).
- `bun run check` a `bun test` v každé App: 0 selhání.
- Skutečný start přes Launchpad: `lazurio module start <Org>/<slug> --json`
  → `running`, `result.runtime.url` odpoví 200 pod vlastním hostname a 403
  pod cizím; `lazurio module stop` skončí proces do 10 s.
- `lazurio doctor` bez `fail` a bez `module-nonconformant` pro Modul.
- PR popis nese seznam kontrol před/po a odkaz na DEV-6634 task.
