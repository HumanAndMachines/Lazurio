---
name: Instalační problém Lazuria
about: Bezpečný reprodukovatelný report z instalace nebo workstation onboardingu
title: ""
labels: ""
assignees: ""
---

<!--
Než issue odešleš:
- vyhledej duplicitu podle reason kódu a symptomu;
- odstraň tokeny, device kódy, credentials, zákaznická data, Personalspace,
  lokální uživatelská jména a zbytečné absolutní cesty;
- Organization-specific problém patří do privátního owning repa, ne sem.
-->

## Problém

<!-- Co přesně nefunguje a ve kterém podporovaném flow? -->

## Prostředí

- OS a architektura:
- Lazurio verze nebo exact source commit:
- Git / GitHub CLI / Bun verze, pokud jsou relevantní:

## Reprodukce

1.
2.
3.

## Skutečný výsledek

<!-- Stabilní reason/error kód a sanitizovaný výstup. Nevkládej secrets. -->

## Očekávaný výsledek

<!-- Jaký rozhodnutelný výsledek má podporovaný flow vrátit? -->

## Bezpečný workaround

<!-- Uveď jen ověřený workaround; jinak napiš „nenalezen“. -->

## Acceptance criteria

- [ ] Problém je pokrytý regresním testem na dotčené platformě nebo hranici.
- [ ] Diagnostika pojmenuje skutečnou příčinu bez credentials a osobních dat.
- [ ] Oprava zachová GitHub access, Organization a Personalspace hranice.
