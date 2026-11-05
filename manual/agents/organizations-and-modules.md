# Organizace a Moduly

Závazná součást pravidel pro agenty v Lazurio rootu. Platí stejně jako
`AGENTS.md`, který na tento manuál odkazuje a drží jeho závazné jádro. Načti
ho, když potřebuješ vědět, kdo Lazurio vyvíjí, nebo pracuješ s modelem
Organizace, workspace Moduly, Teamy, productionspace, jmény hostovaných
aplikací, hostujícími Moduly nebo s grantem na Design System.

Text níže byl přesunut z `AGENTS.md` beze změny znění. Oddíly nesou názvy
oddílů `AGENTS.md`, ze kterých pocházejí; body, které v `AGENTS.md` zůstaly
doslova, tu nejsou.

## Organizace a Moduly

- Lazurio vyvíjí Human and Machine s.r.o.; Rozjedeme.ai je její agentura,
  která Lazurio integruje do provozu jiných firem (0128, dodatek
  z 2026-10-24). Lazurio zastřešuje pracovní svět (Organizace, Teamy,
  Moduly) i osobní produkt Buddy.
- Organizace odpovídá GitHub Organization: jedno super-repo a jedna access
  hranice. Workspace Moduly žijí v ploché složce
  `organizations/<Org>/workspace/<modul>/`; Team je deklarace v manifestu,
  ne adresář, a Modul smí patřit do více Teamů. Na Modul dosáhne Team podle
  živého grantu na GitHubu (0186). `productionspace/` drží org-level repa
  s vlastním branch a release modelem (0041) a `personalspace/` není
  Organizace (0046). Hostovaná jména aplikací určuje 0146: dílna
  `<app>.<vm>.<org>.lazurio.io` jen z tailnetu, u Organizace s veřejným DNS
  (0213) i z internetu přes veřejný vstup serveru k bráně s přihlášením
  Lazurio účtem, a produkční aplikace `<app>.<org>.lazurio.io`. Podrobný model
  drží `MAP.md`.
- **Hostující Moduly** (0221): Organizace smí namountovat Modul jiné
  Organizace jako kontext ve `workspace/<DomovskáOrganizace>_GEN3/<repozitář>`,
  jediné výjimce z ploché složky; slot nese `home_organization`. Čteš ho podle
  `AGENTS.md` té složky, nic z něj nekopíruješ a změny v něm jdou pull
  requestem do domovského repozitáře podle pravidel domovské Organizace.
- **Design System** Organizace má číst každý aktivní člen včetně účtů jejích
  Prostředí Henry, ve všech Teamech a u organizačních i produktových Design
  Systemů. Při založení, onboardingu člena i instalaci Prostředí ověř
  skutečnou dostupnost; chybějící Read grant je nedokončený onboarding.
  Pravidlo nedává právo zápisu, veřejnou viditelnost ani přístup jiné
  Organizaci. Grant bez mandátu Admina nerozšiřuješ, předáš konkrétní
  nápravu.
