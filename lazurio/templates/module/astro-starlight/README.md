# {{display_name}}

Modul `{{slug}}` Organizace `{{organization}}`: dokumentace nebo
knowledgebase v Astru se Starlight a TypeScript strict. Vznikl příkazem
`lazurio module create --stack astro-starlight` a splňuje Lazurio Module
Standard.

## Struktura

- `lazurio.module.json` — identita Modulu, lease `main` z poolu Organizace,
  `apps[]` a `default_app`.
- `app/v1/` — App; `package.json` nese `lazurio.runtime` (listener
  `{{listener_id}}`, health `/`) a `lazurio.preparation`; stránky žijí
  v `src/content/docs/`, navigace v `sidebar` v `astro.config.ts`.
- `.github/workflows/check.yml` — CI: `bun install --frozen-lockfile`,
  `bun run check`, `bun test`.

## Vývoj

```sh
cd app/v1
bun install --frozen-lockfile
bun run prepare:app   # astro sync (typy obsahu)
bun run check         # astro check + biome
bun test              # obsah a start kontrakt
```

Start patří Launchpadu: `lazurio module start {{organization}}/{{slug}} --json`
a otevři `result.runtime.url`. Ruční start jen s listener proměnnými (port je
lease `main` v `lazurio.module.json`):

```sh
{{listener_env_prefix}}_HOST=127.0.0.1 {{listener_env_prefix}}_PORT=<port> bun run dev
```

## Příprava

- `prepare:app` spouští `astro sync`; `check:prepared` ověří, že vygenerované
  typy existují.
- Kořenová stránka `/` odpovídá 200 sama; další jazyk přidej tak, aby health
  cesta nezačala přesměrovávat.
