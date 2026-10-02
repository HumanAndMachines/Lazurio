# {{display_name}}

Modul `{{slug}}` Organizace `{{organization}}`: web v Astru s TypeScript
strict. Vznikl příkazem `lazurio module create --stack astro` a splňuje
Lazurio Module Standard.

## Struktura

- `lazurio.module.json` — identita Modulu, lease `main` z poolu Organizace,
  `apps[]` a `default_app`.
- `app/v1/` — App; `package.json` nese `lazurio.runtime` (listener
  `{{listener_id}}`, health `/`) a `lazurio.preparation`; `astro.config.ts`
  čte listener přes `@lazurio/module-kit` jen při `astro dev`/`preview`.
- `.github/workflows/check.yml` — CI: `bun install --frozen-lockfile`,
  `bun run check`, `bun test`.

## Vývoj

```sh
cd app/v1
bun install --frozen-lockfile
bun run prepare:app   # astro sync (typy obsahu)
bun run check         # astro check + biome
bun test              # jednotkové testy a start kontrakt
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
- `dev` spouští jeden proces `astro dev`. Statický build (`bun run build`) je
  příprava publikace, ne start.
