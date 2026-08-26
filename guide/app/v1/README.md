# Lazurio Guide App v1

Astro renderer pro sdílený Lazurio Guide.

## Spuštění

```sh
cd guide/app/v1
bun install
bun run dev
```

Lokální URL: `http://127.0.0.1:5281`.

## Původ mechanismu

Aplikace přebírá funkční pattern z GEN2 guide předlohy: mapa cesty, lekce, kvízy, úkoly, achievementy a jednoduchý progres v browseru.

Obsah se ale čte z `guide/content/` a je obecný pro Lazurio.

## Mattyčus asset

Guide používá plný Mattyčus spritesheet jako vendored build asset. Jeho
vizuální autoritu drží `Rozjedeme-ai/design-system-lazurio` v
`content/brand/buddy/assets.json`; runtime jiný repozitář nečte.

`bun run build` nejdřív ověří lokální SHA-256, velikost, frame grid a
prezentační identitní kontrakt. Změna assetu bez předchozí změny v Design
Systemu proto failne build.
