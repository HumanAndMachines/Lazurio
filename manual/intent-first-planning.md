# Plánování podle záměru a testovatelného kontraktu

Mission Control Organizace drží směr práce: proč změna vzniká, komu pomůže,
jak poznáme úspěch a v jakých hranicích může implementátor rozhodovat.
Plán je obrys, který se zpřesňuje poznáním. Není předem napsaným programem.

## Co má plán říct

- Kontext, problém a chtěný výsledek s ověřitelnými příklady.
- Důležité milníky a schopnosti; materializuj nejbližší proveditelné kroky,
  vzdálenější práci nech jako milníky.
- Pevné hranice: vlastník dat, access a publikační autorita, kompatibilita,
  nezbytné mechanismy a selhání, která výsledek musí zvládnout.
- Volnost implementátora: co může vyřešit jinak a jaké detaily lze ořezat
  nebo odložit bez porušení cíle.
- Podstatné závislosti, nejistoty a rozhodnutí Principála. Technické problémy
  odkazuj do GitHub Issues přesného owning repa podle [issue flow](github-issues.md).

Použij existující schéma plánu. Tyto informace patří do context, target_state,
scope, acceptance_criteria, validation, decisions a milníků; nezaváděj kvůli
nim paralelní plán ani povinné nové pole. Do plánu nekopíruj implementační
seznam funkcí, kompletní testy nebo data jiné Organizace.

## Kontrakt před implementací

Před změnou chování, veřejného rozhraní nebo architektury připrav v owning
code repu malou kostru testů odvozenou ze záměru. Má vyprávět podstatný příběh:
co skutečný consumer udělá, jaký výsledek dostane a co nastane při důležitém
selhání. Zahrň nezbytné hranice a mechanismy z plánu. Testuj pozorovatelné
účinky, zachování dat a autoritu, ne názvy interních funkcí nebo počet volání.

Ověř, že nový test před implementací selže z očekávaného důvodu; chyba importu
nebo prostředí není důkaz chybějícího chování. Pak doplň implementaci a ukaž
zelený výsledek. U refaktoru existující kontrakt zůstává zelený. Propojení
s plánem a důkaz testování uveď v PR; Mission Control může nést odkaz.

Je to výchozí review pravidlo, nikoli plošná technická brána. Čistá dokumentace,
kosmetická změna nebo ohraničený průzkumný spike může mít v PR stručně
zdůvodněnou výjimku. Počet testů, coverage kvóta ani samostatný červený PR
nejsou požadavek. Červená kostra může být Draft pro koordinaci; produkční
větev musí projít svými kontrolami.

## Změna směru a kvalita testů

Když se mění chtěné chování, nejdřív vysvětli změnu záměru a uprav plán a jeho
kontrakt, potom implementaci. Změnu pevného business, access nebo publikačního
principu rozhoduje Principál. Běžná interní změna nepotřebuje přepisovat plán.

Test, který potvrzuje chybu, duplikuje jiný důkaz nebo zamyká nepodstatný detail,
odstraň či nahraď scénářem správného chování. Zachovej skutečné regresní
pokrytí. Testy neoslabuj jen proto, aby odpovídaly současnému kódu.

## Migrace starých issues

Aktivní tracker je GitHub. Staré ledgery jsou neměnný migrační vstup a historie.
Při převodu zachovej původní identitu, souvislosti a odkazy; vyřešené položky
znovu neotevírej. Každý export musí mít konkrétní owning repo a bezpečnou
visibility. Nejasný cíl nebo chybějící přístup je explicitní blocker, nikoli
povolení kopírovat obsah do jiného repa.

Před vytvořením hledej existující issue včetně už migrované identity.
Po částečném selhání nejdřív proveď readback: opakování nesmí vytvářet
nové kopie. Organizace drží vlastní mapu stará identita → GitHub URL a důkaz
ověření; společný rollout drží jen dovolené odkazy a stav. Nedostupné ani
nematerializované Organizace se z inventury neztrácejí.
