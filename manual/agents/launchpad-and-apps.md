# Launchpad a aplikace

Závazná součást pravidel pro agenty v Lazurio rootu. Platí stejně jako
`AGENTS.md`, který na tento manuál odkazuje a drží jeho závazné jádro. Načti
ho, když úkol potřebuje Launchpad, Web Lazuria nebo spuštění aplikace, a když
otevíráš vlákno z Launchpadu.

Text níže byl přesunut z `AGENTS.md` beze změny znění. Oddíly nesou názvy
oddílů `AGENTS.md`, ze kterých pocházejí; body, které v `AGENTS.md` zůstaly
doslova, tu nejsou.

## Launchpad a aplikace

- Potřebuje-li úkol Launchpad, spusť podle scope právě jeden příkaz:
  `lazurio launchpad serve --organization <přesný company.slug>`,
  `lazurio launchpad serve --personalspace`, nebo při nejasném či
  cross-organization scope `lazurio launchpad serve`. Vypsané
  `LAZURIO_LAUNCHPAD_URL=…` otevři jen ve vestavěném browseru; port ani route
  nedopočítávej. Při `LAZURIO_SERVER_STATE_PERMISSION_REQUIRED` si vyžádej
  scoped zápis do uvedené cesty a tentýž příkaz zopakuj. Chybí-li vestavěný
  browser, řekni to a pokračuj bez něj.
- „Web Lazuria“ je Modul `website-lazurio` Organizace `HumanAndMachine-ai`,
  ne Launchpad: ověř ho `lazurio module status
  HumanAndMachine-ai/website-lazurio --json`, spusť `lazurio module start
  HumanAndMachine-ai/website-lazurio --json` a otevři vrácené
  `result.runtime.url`.
- Každé vlákno, které Launchpad, průvodce nebo prompt otevírá v Chatu, začíná
  v projektu Lazurio Folderu a prompt jmenuje Organizaci a práci. Platí
  výchozí model T3 Code z Nastavení (0189).
- Launchpad je builder-first (0047): spouští aplikace z `main` i z worktrees
  a productionspace ukazuje jen read-only; admin konfigurace a vstup
  uživatelů do produkčních aplikací patří do Dashboardu. Port patří Modulu,
  Organizace drží jen `module_port_pool`; chování leases a procesů drží
  `launchpad/README.md`. Productionspace repozitáře z rootu nespouštíš ani
  nereleasuješ bez výslovné politiky Organizace.
