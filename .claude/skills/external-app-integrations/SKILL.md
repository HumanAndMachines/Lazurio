---
name: external-app-integrations
description: Připojí nebo ověří externí službu pro Agenty na Mašině. Preferuje existující napojení a Composio, podle potřeb přímé MCP, CLI nebo jinou vhodnou cestu bez vlastní integrační vrstvy.
---

# External app integrations

## Kdy použít

Principál chce připojit externí aplikaci nebo potřebuje schopnost, kterou
dosavadní napojení neposkytuje. Kanonický záměr a hranice drží
`manual/external-app-integrations.md`; pro Composio pokračuj runbookem
`manual/integrations/composio.md`. Neměň nesouvisející funkční přístupy.

## Postup

- Urči konkrétní Mašinu, jejího Ownera, Principála a osobní nebo Organization
  scope. Technicky dostupné přístupy považuj za dostupné Agentům na Mašině;
  mandát není technická izolace. Osobní obsah ani credentials nedávej do
  Organization katalogu. GitHub práva nenahrazují práva ostatních služeb.
- Nejdřív využij existující napojení. Pro nové služby preferuj Composio,
  pokud pokrývá potřebné akce a přijatelnou datovou hranici. Agent komunikuje
  přímo s poskytovatelem přes harness nebo CLI, ne přes Lazurio proxy.
  Nepokrytou schopnost řeš vhodným přímým MCP nebo CLI; nestav vlastní
  konektor jen proto, aby vše procházelo jednou bránou. GitHub dál přes `gh`.
- Zvaž skutečnou schopnost, ne jen jméno aplikace: metadata databáze nejsou
  SQL, připojená služba negarantuje celou historii ani všechny účty.
  U komunitního nástroje ověř publishera, licenci, připnutou verzi a způsob
  přihlášení. Riziko neoficiálního protokolu musí Principál přijmout;
  instalace není mandát získávat cizí relace nebo obcházet práva.
- Použij přihlašovací UI dodavatele. Ověř cílový účet a požadovaný rozsah;
  jednotlivé harnessy autorizuj zvlášť. Composio spravuje upstream credentials
  v cloudu; lokální MCP token není důkaz per-Mašina izolace cloudových účtů.
  Udělený OAuth grant je
  schopnost mašiny, ne souhlas s libovolnou operací.
- **Přihlášení musí přežít běžný restart.** Ověř nový proces nebo task a
  skutečnou čtecí operaci. Connected prokazuje spojení, ne všechny schopnosti.
  Lokální secrets drž podle `manual/security/local-secret-custody.md`;
  nevypisuj je do chatu nebo Gitu. Provider expiraci neprohlásíš za vyřešenou
  samotným restartem.
- Zápis testuj v mandátu na vratném cíli. Pokud Principál výslovně
  schválil jmenovitý smoke cíl (u Organization v `INTEGRATIONS.md`) a artefakt
  vytvořil tento konkrétní smoke, lze uklidit jen tento vlastní artefakt.
  Jinak artefakt ponech a vyžádej si samostatný explicitní pokyn Principála.
  Harness approvals nenahrazují mandát ani izolaci vůči jinému procesu.
- Při nahrazování cesty nejdřív ověř náhradu. Odpojení, zrušení upstream
  grantu a odstranění cache jsou různé operace. Neruš sdílený grant, na kterém
  závisí jiná funkční cesta. Technické nejistoty řeš podle
  `manual/github-issues.md`, ne novým záznamem v legacy issues ledgeru.

## Ověření

- Správná identita a potřebná schopnost fungují skutečným tool callem;
  odliš účet, workspace a připojení. Další účet neověřuj jen počtem connections.
- Ověření proběhlo v cílovém harnessu; CLI test nenahrazuje MCP test a
  přihlášení MCP neprokazuje přihlášení samotného modelového klienta.
- Přihlášení je persistentní, ale omezení ověření a provider expirace jsou
  pojmenované. Pokud write nebyl testován, výslovně to řekni.
- Closeout obsahuje účel, scope, cestu, datum a skutečný výsledek; žádné tokeny,
  autorizační URL, osobní zprávy ani credential soubory.
