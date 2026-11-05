# Před prací

Závazná součást pravidel pro agenty v Lazurio rootu. Platí stejně jako
`AGENTS.md`, který na tento manuál odkazuje a drží jeho závazné jádro. Načti
ho na začátku tasku: synchronizace a ověření checkoutu, nástroje Mašiny,
worktree disciplína a SSH na Mašiny v tailnetu.

Text níže byl přesunut z `AGENTS.md` beze změny znění. Oddíly nesou názvy
oddílů `AGENTS.md`, ze kterých pocházejí; body, které v `AGENTS.md` zůstaly
doslova, tu nejsou.

## Před prací

2. **Synchronizuj a ověř** primární checkout: `lazurio update` a po jeho
   úspěchu `bun run doctor:task`, stejně u každého nested checkoutu, kterého
   se task dotkne. Update srovná vrstvy na clean `main` jen fast-forwardem,
   náhodné změny uloží do recovery stashe a co bezpečně neumí, vrátí jako
   blocked s promptem pro Codex; nic z toho neopravuješ odhadem.
   Productionspace, Personalspace, worktrees a root-space repository-db
   obecný update nepřekračuje. Podrobnosti drží
   `manual/lazurio-root-for-agents.md` a `manual/worktree-management.md`.
3. **Nástroje mašiny** ověříš `lazurio doctor --tool-updates`. Chybějící nebo
   zastaralý nástroj nejdřív předáš uživateli; updater, package manager ani
   změnu `PATH` nespustíš bez jeho souhlasu s přesnou změnou, pokud ho
   instalační prompt nedal předem. Instalace a oprava mašiny se řídí skillem
   `lazurio-workstation-install` a `manual/organization-install.md` a končí
   až finálním `lazurio doctor` bez required nálezů. Od uživatele nikdy
   nechceš, aby otevřel terminál nebo do něj kopíroval příkazy.
4. **Drž worktree disciplínu:** primární checkout zůstává na `main` a nic
   v něm neměníš; každá změna jde přes task worktree podle skillu
   `worktree-development-discipline` (`bun run worktrees:status`,
   `bun run worktrees:check` a před každým pushem `bun run pr:preflight`).
   Review cizího PR bez změn děláš v odpojeném checkoutu jeho přesného headu
   (`bun run worktrees:review -- <PR URL>`) a po verdiktu ho smažeš.
5. **SSH na Mašiny v tailnetu.** Tailscale profil je na mašině jeden pro
   všechny relace a adresy `100.64.0.x` se v každém tailnetu opakují.
   Nepřipojuj se na holou adresu ani přes obecný `~/.ssh/known_hosts`:
   identitu ber z Machine Recordu owning Organizace (pinnutý host klíč přes
   `HostKeyAlias` a vlastní `UserKnownHostsFile`) a před spojením ověř, že
   `ControlURL` z `tailscale debug prefs` je login server Headscale, který ta
   Organizace deklaruje. `CurrentTailnet.Name` z `tailscale status --json` je
   jen popisek pro případ, že prefs nejsou dostupné, a musí se s hostem login
   serveru přesně shodovat. „Host key changed“ znamená nejdřív jiný aktivní
   tailnet, ne důvod klíč přepsat. Profil bez souhlasu uživatele
   nepřepínáš, přepnul bys ho všem relacím. Má-li uživatel pro tailnet
   headless klienta (uzel `<login>-<zařízení>-cli`), jdeš jen přes něj
   (`ProxyCommand tailscale --socket=<socket> nc %h %p`) a tailnet ověříš na
   stejném socketu; když neběží, řekneš to uživateli. Na stanovišti
   LazurioDevelopment má každý tailnet vlastní síťový prostor a volíš ho
   u každého příkazu; síť samotného Prostředí nepřepínáš (dodatek 0217
   z 2026-10-31).
