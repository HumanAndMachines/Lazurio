---
name: architecture-shaping
description: Vytvaruje návrh nebo změnu source do nejmenší koherentní architektury. Použij pro každou source změnu; plný průchod proveď při návrhu nové dlouhodobé abstrakce, stavu, autority, hranice, rozhraní, závislosti nebo migrace. Nepoužívej pro čistou business-data či copy změnu bez dopadu na technický kontrakt.
---

# Architecture shaping

## Kdy použít

Použij před každou tvorbou nebo změnou source: executable kódu, buildu,
schématu, validátoru, automatizace, infrastruktury nebo code-owned kontraktu.
Každá taková práce dostane rychlé architektonické posouzení; plný shaping je
potřeba teprve tehdy, když se architektura skutečně navrhuje nebo mění.

Zadání Principála určuje chtěný výsledek, priority a omezení. Není automaticky
hotovou architektonickou specifikací. Task Agent odpovídá za kvalitu návrhu a
Draftu, nikoli za business priority, přístupy nebo Publikaci. Poslední slovo
Principála proto neznamená slepé provedení prvního mechanismu; odborný úsudek
Agenta zase není oprávnění změnit cíl bez jeho vědomí.

Čistá business-data změna, běžná copy editace nebo mechanické použití již
rozhodnutého kontraktu hluboký shaping nepotřebuje. Pokud ale mění code-owned
chování, source of truth, hranici nebo dlouhodobý koncept, skill platí.

## Co je architektura

Architektura není seznam komponent ani velikost dokumentu. Je to dlouhodobé
rozdělení odpovědností, autorit, stavu, rozhraní a životního cyklu včetně
selhání a návratu. Elegantní a čisté řešení vyjadřuje toto rozdělení nejmenším
počtem konceptů, má jeden kanonický domov pro každou pravdu, používá přirozeného
ownera a standardní capability provideru, odstraňuje nebo slučuje nahrazovanou
cestu a přidává jen koncepty ospravedlněné skutečným invariantem a consumerem.

## Zvol hloubku

Rychlá cesta stačí, pouze pokud změna současně:

- zachovává existující architekturu, ownership a source of truth;
- nepřidává trvalou abstrakci, závislost, stav, konfiguraci ani fallback;
- nemění access, security, data, lifecycle nebo cross-scope kontrakt;
- má malý blast radius a zřejmý rollback.

Rychlá cesta je krátká kontrola, ne nový dokument. Ověř, že používáš existující
seam, nevytváříš druhou pravdu ani paralelní běžnou cestu a relevantní důkaz
chrání chtěné chování.

Plný shaping proveď, pokud některá podmínka rychlé cesty neplatí, zadání je
podurčené nebo se mění dlouhodobá abstrakce, persistentní stav, provider či
externí závislost, source of truth, access nebo trust hranice, veřejné
rozhraní, template/distribuce, více scope či obtížně vratná migrace.

## Postup

1. **Ukotvi realitu.** Přečti nejbližší `AGENTS.md`, relevantní decisions a
   cílovou `ARCHITECTURE.md`, potom schémata, config, kód, testy a živý stav.
   Rozliš cílový model, nasazenou realitu a výslovně vedenou migraci.
2. **Odděl cíl od prostředku.** Jednou větou pojmenuj chtěný výsledek,
   chráněné invarianty, non-goals a otevřené nejistoty. Službu, flag, tabulku
   nebo workflow ze zadání ber jako hypotézu, pokud nejsou samy požadavkem.
3. **Zmapuj autority a tok.** Urči přirozeného ownera dat, identity, accessu,
   validace, lifecycle a Publikace. Ukaž vztah komponent jen tehdy, když tím
   vyjasníš odpovědnost nebo tok; diagram není náhradou rozhodnutí.
4. **Porovnej skutečné varianty.** Vždy zahrň baseline bez nového mechanismu:
   použití provideru, opravu přirozeného ownera, rozšíření existujícího seam
   nebo odstranění staré cesty. Alternativy porovnej podle jednoduchosti,
   konvergence, selhání, rollbacku, rollout nákladů a skutečných consumerů.
   Rutinní technický úsudek rozhodni sám; trade-off měnící cíl, prioritu nebo
   přijaté riziko vrať Principálovi s doporučením.
5. **Zvol nejmenší úplný řez.** Každý nový dlouhodobý koncept musí mít
   konkrétní problém, kanonický domov, ownera, consumera, lifecycle, failure
   mode, ověření a vztah k tomu, co nahrazuje. Pokud to nelze vysvětlit
   jednoduše, návrh ještě není připravený.
6. **Zkus návrh vyvrátit.** Projdi chybějící access, souběh, částečný rollout,
   starého consumera, nedostupného providera a rollback podle relevance.
   U významné změny použij nezávislou protiváhu se zadáním hledat duplicitní
   pravdu a jednodušší standardní variantu. Když není dostupná, proveď solo
   inversion pass: zkus návrh s polovinou konceptů a bez nového mechanismu.
7. **Zapiš rozhodnutí do správného domova.** Trvalou změnu architektonického
   principu nebo sdíleného kontraktu navrhni v jeho kanonickém decision recordu;
   implementační volbu vysvětli v PR. Nevytvářej nový design dokument, ledger
   ani approval proces, pokud pro něj neexistuje trvalý consumer.
8. **Implementuj a dokaž celek.** Drž diff chirurgický, odstraň supersedovanou
   aktivní mašinérii, otestuj pozitivní i relevantní negativní cestu a u plného
   shapingu ověř skutečného nebo věrného consumera. Review i handoff musí
   odpovídat exact HEADu a uvést dopad, non-goals, rollout a zbylé riziko.

Když požadovaný prostředek odporuje vyšší autoritě, ukaž konkrétní kolizi a
doporuč nejbližší konformní cestu. Pokud řešení vyžaduje změnu cíle nebo
schváleného principu, zachovej vratný Draft a vrať tuto volbu oprávněnému
Principálovi; neimplementuj ji potichu jako technický detail.

## Ověření

Před označením source změny za hotovou musí být odpověď přiměřeně jasná:

- cíl, invarianty, non-goals a otevřené nejistoty jsou rozlišitelné;
- zvolená varianta je jednodušší než odmítnuté alternativy a nevytváří druhou
  autoritu ani paralelní běžnou cestu bez doložené nutnosti;
- každý nový trvalý koncept má ownera, consumera, failure mode a lifecycle;
- návrh konverguje: něco nahrazuje, slučuje nebo vědomě ohraničuje;
- relevantní pozitivní i negativní scénář prošel na exact HEADu;
- plný shaping má skutečný consumer nebo věrný smoke a nezávislou protiváhu či
  pravdivě označený solo inversion pass;
- další Agent pochopí rozhodnutí, non-goals a zbylé riziko bez původního chatu.

Skill je neúspěšně použitý, pokud jen přidá ceremonii k předem zvolenému
řešení, použije „principy“ jako záminku k převzetí cíle Principála nebo vytvoří
další vlastní proces místo zjednodušení systému.
