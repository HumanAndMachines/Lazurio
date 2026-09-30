# Šablony nového Modulu

Šablony stacků pro `lazurio module create` (manual/module-create.md). Jediný
generátor je čistá funkce `planModuleScaffold` v
`lazurio/module-scaffold-lib.mjs`; tahle složka jsou jen její vstupní data.

- **Vrstvy.** Soubory Modulu vzniknou překrytím vrstev v pořadí `_common` →
  `_bun` (jen stacky s Bun App) → `<stack>`; pozdější vrstva vyhrává nad
  stejnou cestou. Stacky: `vite-react`, `astro`, `astro-starlight`,
  `bun-service`, `python-uv`, `none`. `lazurio.module.json` šablona není:
  generuje ho plan funkce z leasu a stacku.
- **Jména.** Segment cesty začínající `dot-` se zapíše s tečkou
  (`dot-gitignore` → `.gitignore`, `dot-github/` → `.github/`) a přípona
  `.tmpl` se odstraní (`AGENTS.md.tmpl` → `AGENTS.md`,
  `start.test.ts.tmpl` → `start.test.ts`). Díky tomu šablony nepůsobí jako
  ignore pravidla, CI, instrukce agentů ani testy tohoto repozitáře a npm
  balíček CLI je nese bez testových souborů.
- **Placeholdery.** `{{name}}` v cestě i obsahu: `slug`, `display_name`,
  `organization`, `github_org`, `stack`, `listener_id`,
  `listener_env_prefix`, `runtime_id`, `python_package`, `port`,
  `bun_version`, `module_kit_version`, `uv_version`. Neznámé jméno je chyba
  šablony; engine ani escapování neexistuje, proto plan funkce hodnoty
  validuje (`display_name` bez `"`, `\`, `<`, `>`, `{`, `}` a řídicích znaků).
- **Standard.** Každá App šablona musí po vygenerování projít `MS-02`–`MS-13`;
  hlídá to `lazurio/module-scaffold.test.mjs`. Port se do šablon nepíše
  (`MS-01` a kap. 4.2), App ho čte jen z listener proměnných.
