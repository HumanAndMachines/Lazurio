# {{display_name}}

Modul `{{slug}}` Organizace `{{organization}}`: UI a datová aplikace
ve Vite + React + TypeScript strict. Vznikl příkazem
`lazurio module create --stack vite-react` a splňuje Lazurio Module Standard.

## Struktura

- `lazurio.module.json` — identita Modulu, lease `main` z poolu Organizace,
  `apps[]` a `default_app`.
- `app/v1/` — App; `package.json` nese `lazurio.runtime` (listener
  `{{listener_id}}`, health `/`) a `lazurio.preparation`.
- `.github/workflows/check.yml` — CI: `bun install --frozen-lockfile`,
  `bun run check`, `bun test`.

## Vývoj

```sh
cd app/v1
bun install --frozen-lockfile
bun run check   # tsc --noEmit + biome
bun test        # jednotkové testy a start kontrakt
```

Start patří Launchpadu: `lazurio module start {{organization}}/{{slug}} --json`
a otevři `result.runtime.url`. Ruční start jen s listener proměnnými (port je
lease `main` v `lazurio.module.json`):

```sh
{{listener_env_prefix}}_HOST=127.0.0.1 {{listener_env_prefix}}_PORT=<port> bun run dev
```

## Příprava

- `check:prepared` ověří, že jsou nainstalované závislosti; Vite dev server
  build nepotřebuje, proto App nedeklaruje `prepare_script`.
- `dev` spouští jeden proces Vite dev serveru. Build, data ani migrace do něj
  nepatří.
