# {{display_name}}

Modul `{{slug}}` Organizace `{{organization}}`: služba v Pythonu přes `uv`
(`pyproject.toml`, `uv.lock`), bez frameworku. Vznikl příkazem
`lazurio module create --stack python-uv` a drží Lazurio Module Standard
(kap. 7).

## Struktura

- `lazurio.module.json` — identita Modulu, lease `main` z poolu Organizace,
  `apps[]` a `default_app`.
- `app/v1/pyproject.toml` — balíček `{{python_package}}`, entry point
  `{{slug}} = "{{python_package}}.server:main"`, `lazurio-module-kit` na tagu
  `v{{module_kit_version}}`, ruff + pyright strict + pytest.
- `app/v1/package.json` — `lazurio.runtime` (listener `{{listener_id}}`,
  health `/healthz`), `lazurio.preparation` (`runtime: uv`, `uv_version`) a
  skripty `dev`, `check`, `test`; `[tool.lazurio]` v `pyproject.toml` nese
  totéž a musí zůstat shodné.
- `.github/workflows/check.yml` — CI: `uv sync --frozen`, `bun run check`,
  `bun run test`.

## Vývoj

```sh
cd app/v1
uv sync --frozen
bun run check   # ruff format + ruff check + pyright
bun run test    # pytest: start kontrakt
```

Ruční start (port je lease `main` v `lazurio.module.json`):

```sh
{{listener_env_prefix}}_HOST=127.0.0.1 {{listener_env_prefix}}_PORT=<port> uv run --no-sync {{slug}}
```

## Stav v Lazuriu

Start přes Launchpad přijde s adaptérem `uv` v Platformě (DEV-6634 W0-5). Do
té doby `lazurio module setup` hlásí u Python App `MS-04` (a `MS-08`) jako
`warn`, ne `fail`; Modul je jinak konformní.
