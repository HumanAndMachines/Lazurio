# Otázky, issues a poznatky

Závazná součást pravidel pro agenty v Lazurio rootu. Platí stejně jako
`AGENTS.md`, který na tento manuál odkazuje a drží jeho závazné jádro. Načti
ho, než se uživatele na něco zeptáš nebo ho požádáš o úkon, než zapíšeš issue
a než zapíšeš poznatek.

Text níže byl přesunut z `AGENTS.md` beze změny znění. Oddíly nesou názvy
oddílů `AGENTS.md`, ze kterých pocházejí; body, které v `AGENTS.md` zůstaly
doslova, tu nejsou.

## Otázky, issues a poznatky

- **Uživatele se ptáš nástrojem na otázky** (0211; Claude Code
  `AskUserQuestion`, Codex `request_user_input`, Hermes `clarify`), ne jen
  textem: otázka v textu zapadne a vlákno stojí, i když vypadá, že pracuje.
  Stejně položíš i žádost, aby uživatel něco udělal: zadal ověřovací kód,
  přihlásil se, něco potvrdil nebo zkontroloval. Do otázky napíšeš, co přesně
  má udělat, s odkazem, kódem a do kdy platí, a volbami se necháš říct, jak to
  dopadlo („Hotovo“, „Nejde to“); otázka v T3 Code i v Codex Desktopu vyskočí
  jako upozornění, text ve zprávě ne (dodatek 0211 z 2026-10-24).
  Nabídneš 2–4 volby, doporučenou první s „(Doporučeno)“, a kontext napíšeš
  nad otázku. Nejdřív uděláš všechno, co na odpovědi nezávisí, a ptáš se,
  jen když bez odpovědi nejde bezpečně pokračovat nebo když rozhodnutí patří
  uživateli. Bez nástroje se zeptáš textem s očíslovanými volbami a napíšeš,
  že čekáš a co do té doby stojí. Subagent, bot MausBotu ani automatický
  reviewer uživatele nemá a otázku předá tomu, kdo mu práci zadal. Zapnutí
  nástroje v Codexu popisuje `manual/organization-install.md`.
- **Zapsat issue je trvalý mandát** (0163). Otevřený technický problém,
  nejistotu nebo nález, který nejde hned vyřešit, po kontrole duplicit
  a sanitizaci zapíšeš do Issues přesného owning repa a URL uvedeš
  v handoffu. Pokračuješ na všem, co na něm nestojí. Issue nezavíráš ani
  neprioritizuješ bez pokynu uživatele a přiřazuješ ho jen při eskalaci
  chybějícího práva: když ti právo chybí, zapíšeš issue do kořenového
  repozitáře Organizace a přiřadíš ho tomu, kdo ho smí udělit (jako Folder,
  0219, #702). Když Issues nejdou
  nebo public-safety není jistá, vrátíš sanitizovaný návrh s přesným cílovým
  repem. Postup drží `manual/github-issues.md`; `ISSUES.open.json`
  a `ISSUES.resolved.json` jsou zmrazený migrační vstup.
- **Poznatky patří tam, kde je najdou ostatní**, vždy jako PR ze svého
  worktree a do správného scope: syntéza do Knowledgebase, trvalé rozhodnutí
  do decision recordu, plán a stav do Mission Controlu, otevřený problém do
  Issues, změna pravidel práce do `AGENTS.md` daného scope. Chat i soukromá
  paměť agenta jsou jen cache. Zapisuješ jen netajné poznatky, které tam
  uživatel smí umístit; Personalspace a izolace Organizací mají přednost
  a v pochybnosti necháš obsah v soukromé paměti a založíš jen scoped issue
  nebo pointer.
