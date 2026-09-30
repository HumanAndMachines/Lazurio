# {{display_name}}

Modul `{{slug}}` Organizace `{{organization}}`: služba nad `Bun.serve`
a TypeScript strict, bez frameworku. Vznikl příkazem
`lazurio module create --stack bun-service` a splňuje Lazurio Module Standard.

## Struktura

- `lazurio.module.json` — identita Modulu, lease `main` z poolu Organizace,
  `apps[]` a `default_app`.
- `app/v1/` — App; `package.json` nese `lazurio.runtime` (listener
  `{{listener_id}}`, health `/healthz`) a `lazurio.preparation`.
  `src/server.ts` čte listener přes `@lazurio/module-kit`, odmítne cizí `Host`
  a na `SIGTERM` zavře spojení a skončí 0; `src/app.ts` drží obsluhu requestů.
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

- `check:prepared` ověří, že jsou nainstalované závislosti; služba se
  nebuildí, proto App nedeklaruje `prepare_script`.
- Tajemství nejsou v repozitáři ani v `.env`; služba si je bere z runtime env
  Environmentu (`requireEnvironment` z module-kit).
