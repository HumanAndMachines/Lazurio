# Jak se tu pracuje

Závazná součást pravidel pro agenty v Lazurio rootu. Platí stejně jako
`AGENTS.md`, který na tento manuál odkazuje a drží jeho závazné jádro. Načti
ho na Týmovém Prostředí, při refactoru staré struktury, při sdílení Pracovního
Prostředí, při návrhu s novou abstrakcí, stavem, autoritou, hranicí,
rozhraním, závislostí nebo migrací, při práci na Modulu a když práce potřebuje
pořadí nebo návaznost s jiným vláknem.

Text níže byl přesunut z `AGENTS.md` beze změny znění. Oddíly nesou názvy
oddílů `AGENTS.md`, ze kterých pocházejí; body, které v `AGENTS.md` zůstaly
doslova, tu nejsou.

## Jak se tu pracuje

- **Týmové Prostředí** je výjimka: na GitHubu tam jednáš pod brokerovanou
  identitou Organizace (Lazurio for GitHub), nikdy pod přihlášením
  připojeného uživatele, a nic jiného nepředstíráš (0148). Práva tam určují
  granty Teamu a branch rules. Sám tam nikdy nemerguješ ani na pokyn
  z chatu; publikuje vždy jmenovaný uživatel a kdo změny schválí
  a publikuje, za ně odpovídá.
- **Sdílení Pracovního Prostředí** (0192): přidělený uživatel smí po
  srozumitelném vysvětlení pustit důvěryhodného aktivního člena téže
  Organizace ke všem schopnostem Prostředí včetně svých pracovních
  přihlášení; riziko nese on. Odhlašování ani výmaz nevynucuj a izolaci
  uložených identit neslibuj. Členství a v Organizaci s tailnetem i Adminem
  schválené zařízení zůstávají povinné (0213), konkrétní Publikace dál čeká
  na pokyn odpovědného uživatele a Personalspace se nesdílí
  (`manual/environment-access-model.md`).
- **Neseš architektonickou odpovědnost** (0132). Uživatel určuje výsledek,
  priority a omezení, ty odpovídáš za elegantní a čisté řešení. Odděl záměr
  od mechanismu, chraň jednu pravdu a jejího ownera, dej přednost standardní
  capability a existujícím dobře zdokumentovaným nástrojům před vlastní
  mašinérií a nech systém konvergovat. Malá změna dostane rychlou kontrolu;
  nová abstrakce, stav, autorita, hranice, rozhraní, závislost nebo migrace
  plný shaping s variantami, failure modes a důkazem na skutečném
  consumerovi. Nové názvy a mechanismy nejdřív ověř v rozhodnutích
  a `ARCHITECTURE.md`. Konkrétní rozpor otevřeně pojmenuj, ale odborný
  úsudek nepoužívej k převzetí business, access ani publikační pravomoci
  uživatele. Vyžaduje-li čisté řešení změnu cíle nebo principu, vrať volbu
  s doporučením uživateli; nepřepisuj ji potichu jako technický detail.
- **Refactor dělá agent** (0173). Starou strukturu převádíš se subagenty jako
  reviewovaný refactor podle návodu s motivací, cílovým stavem a ověřením;
  automatický migrátor, automatickou opravu ani codemod pro přestavbu
  nestavíš a nástroje jen měří a hlásí. Migrační kód žije jen
  v `lazurio/migrations/<migrace>/` s README a podmínkou smazání a po
  dokončení migrace se maže.
- **Moduly** vznikají a mění se podle Lazurio Module Standardu (0171; plné
  znění v LazurioPlatform `docs/module-standard.md`, 0225; záznam GEN3
  `manual/module-standard.md`, skill `lazurio-module-standard`). Nový Modul
  zakládáš `lazurio module create` nebo z Dashboardu a konformanci ověřuje
  `lazurio module setup`. Launchpad odchylky Modulu neobchází, opravíš je
  v Modulu.
- **Vlákna se mezi sebou nekoordinují** (dodatky 0218 z 2026-10-31). Zprávy
  jiným vláknům neposíláš, pokud si to tvůj uživatel výslovně nepřeje; každé
  vlákno má vlastní worktree, PR, ověření a assignee. Co potřebuje pořadí
  nebo návaznost, zapíšeš do hlavní roadmapy v Mission Controlu, kterou
  jako frontu drží v repozitářích vývoje Lazuria Pablo (Mission Control
  LazurioDevelopment) a v ostatních repozitářích Organizace její Henry; na
  GitHubu k tomu patří závislost a komentář s @zmínkou, štítek pozdržení
  se nepoužívá (dodatek 0218 z 2026-11-01, večer). Každý tvůj text na
  GitHubu končí podpisem `Agent: environment <UUID> · T3 thread <UUID>`
  (bot: UUID bota), bez jména Prostředí. Vlákna se ani neblokují (0223):
  nic sdíleného
  v Prostředí nepřepínáš ani nepřihlašuješ pod jinou identitou a místo, kde
  bys musel na jiné vlákno čekat, zapíšeš jako vadu Prostředí do issue.
