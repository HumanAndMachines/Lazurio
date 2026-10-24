# Guide GEN3 changelog

## 2026-10-24

- DEV-6617 (issue #628): lekce učí model z dodatků rozhodnutí 0156,
  0169/0170 a 0103 z 2026-10-24. AI už v nich nevystupuje jako kolega
  s vlastním místem a pravomocemi a výsledek práce agenta se jmenuje pull
  request; Publikace zůstává.
  - Lekce 11 (titulek „AI agenti a nástroje“) vysvětluje AI agenta, který
    pracuje pro svého uživatele, Prostředí Henry pro automatizovanou práci
    Organizace a Buddyho v Osobním Prostředí; kvíz má druhou otázku na
    Prostředí Henry.
  - Lekce 19 učí pull request a Publikaci jako chvíli, kdy změna začne
    platit; kvíz má druhou otázku na Publikaci. Lekce 15 doplňuje, že
    v napojené službě agent práci jen připraví (třeba koncept e-mailu)
    a odeslat ji smí až na výslovný pokyn.
  - Ostatní lekce, praktické úkoly, kvízy, cesta, odznak „Umím zadat práci“
    a `README.md` mluví o agentech. Id, složky, URL a pořadí lekcí se
    nemění; starší záznamy tohoto changelogu zůstávají historií.

## 2026-08-26

- DEV-6507 sjednotil existujícího Guide průvodce s výchozí vizuální identitou
  Buddyho. Spritesheet zůstává vendored a runtime nezískává cross-repository
  závislost; nový build gate hlídá Design System digest, rozměry, frame grid a
  čistě prezentační sémantiku.

## 2026-07-02

- Revize meta-dokumentů podle interního auditu (2026-07-02) a draftu 0040 (Guide = odvozený povrch bez vlastní autority); lekce 04 opravena podle founder kánonu Digitální kancelář = Workspace (draft 0041; veřejné shrnutí dnes drží `../manual/decision-register.md`):
  - `README.md` — sekce Účel opravena na realitu kurzu: 26 lekcí je netechnický onboarding do práce s digitální kanceláří a AI kolegy; technická cesta „mapa systému“ označena jako plánovaná budoucí část.
  - `AGENTS.md` — tabulka mapující root témata na lekce 01–07 neodpovídala skutečnému obsahu lekcí (např. 05 = „AI vata“, 07 = „Rozcestníky“); nahrazena poznámkou, že mapování vznikne s cestou „mapa systému“. Ve schématu lekce opraven odkaz na neexistující sekci `1-mapa-systemu` na reálnou `1-mindset`.
  - Lekce 04 (`co-je-digitalni-kancelar`) — opraven obrácený výklad: pracovní prostor (workspace) je digitální kancelář jednoho týmu/značky uvnitř firmy, ne „část digitální kanceláře“; firma může mít kanceláří víc.

## 2026-06-30

- Přenesen funkční mechanismus GEN2 guide do sdíleného Conglomerate Guide: Astro app shell, `content/` cesta, lekce, kvízy, úkoly a achievementy.
- Obsah přepsán na obecný HumanAndMachine GEN3 model bez firemních dat z předlohy.
- Zakotveno pravidlo GEN2 → GEN3: obecný `guide/` se z Organization repozitáře maže a nahrazuje ho shared `HumanAndMachines/Lazurio/guide`.
