# Composio: připojení služeb bez vlastního konektoru

Ověřeno: 2026-09-09. Používáme hotové **Composio Connect / For You**, ne vlastní
aplikaci nad SDK. Pilot Lazuria zvolil MCP; Composio nabízí také CLI a plugin.
Standard drží [externí integrace](../external-app-integrations.md).

## Onboarding Principála

1. V [Composiu](https://dashboard.composio.dev/) založ nebo přihlas účet
   Principála, ne nový účet pro každou relaci Task Agenta. Stejnou GitHub
   identitu lze použít pro orientaci, pokud ji login nabízí; sama neudělí
   přístup k ostatním službám.
2. Ve **For You / Connect Apps** vyber službu a autorizuj správný účet.
   Developer projektové connections se do consumer prostředí automaticky
   nepřenášejí. Přihlašovací UI ponech poskytovateli.
3. Managed OAuth nevyžaduje vlastní OAuth aplikaci. Pokud služba potřebuje
   API klíč nebo vlastní klientské údaje, následuj aktuální formulář a admin
   postup; neslibuj univerzální připojení jedním kliknutím.
4. Přidej Composio do každého používaného harnessu a dokonči jeho samostatnou
   autorizaci. Přihlášení do webu nebo CLI ji nenahrazuje.
5. V novém tasku ověř cílový účet a požadovanou čtecí operaci. Více účtů
   ověř jednotlivě; označení ACTIVE nedokazuje identitu ani schopnost.

Composio drží upstream přístupy a provádí operace v cloudu. Lokální MCP token
není důkaz lokálního uložení všech credentials. Stejný Composio účet na více
Mašinách může zpřístupnit stejné služby: pro rozdílné přístupy nestačí jiné
jméno MCP serveru. Cloudovou důvěru a případné enterprise podmínky řeší
Principál s dodavatelem, ne automatický installer.

## Codex

Nejdřív zkontroluj existující konfiguraci; nevytvářej duplicitu. Pro nový
server podle [Codex MCP dokumentace](https://learn.chatgpt.com/docs/extend/mcp):

```sh
codex mcp add composio --url https://connect.composio.dev/mcp
codex mcp login composio
```

Pokud add již dokončil autorizaci, login bez důvodu neopakuj. Ověř nástroje
v novém tasku. Transporty a custody popisuje
[Codex runbook](../codex-manual-mcp-integrations.md).

## Claude Code

Podle [Claude MCP dokumentace](https://code.claude.com/docs/en/mcp):

```sh
claude mcp add --transport http --scope user composio https://connect.composio.dev/mcp
claude mcp list
```

V Claude Code otevři `/mcp`, vyber Composio a dokonči Authenticate.
Přihlášení modelového klienta je samostatné: Connected MCP nenahrazuje
`/login` ani oprávnění k modelu. Project scope použij pouze pro záměrnou
sdílenou definici bez credentials, ne kopii osobního účtu.

## CLI je volitelné

MCP nevyžaduje Composio CLI. Pokud ho potřebuješ, použij
[oficiální CLI postup](https://docs.composio.dev/docs/cli) a aktuální help.
Instalaci, update ani plugin neprováděj jako skrytou součást přidání MCP.
CLI není lokální kopie cloudových integrací.

## Ověření a běžné pasti

- Katalogové „Neon“ není důkaz možnosti číst SQL. Chybějící schopnost může
  dál obsluhovat přímý MCP; nezahazuj funkční cestu podle názvu aplikace.
- Allowlist obecného execute meta-tool není jemné read-only oprávnění ke
  všem upstream akcím. Mandáty dál platí.
- Google autorizuj po službách, které flow nabízí. Vlastní GCP projekt není
  automaticky potřeba pro managed Google připojení.
- Když OAuth nabídne stejný účet, ověř relaci poskytovatele a podporu typu
  účtu. Nemaž první funkční connection při opravě druhé. Expirovaný odkaz
  nahraď novým.
- Read smoke nesmí označovat zprávy jako přečtené. Write smoke potřebuje
  schválený cíl; pokud neproběhl, nehlásit ověřený zápis.
- I read odpověď může obsahovat token v paging URL. Neloguj celé odpovědi,
  callbacky ani autorizační URL; handoff je metadata-only.

## Migrace a odebrání

Zachovej funkční cesty do ověření náhrady. Pak odpoj jen schválené duplicity.
Odstranění lokálního MCP, odhlášení harnessu, odstranění connection v Composiu
a revokace upstream grantu jsou různé operace. Před revokací zjisti, co grant
sdílí; odpojení jednoho zařízení nesmí nečekaně zrušit přístup ostatních.
Publikace tohoto manuálu sama nemění žádné existující přihlášení.

## Zdroje a odpovědnosti

- [Composio Connect](https://docs.composio.dev/docs/composio-connect).
- [Consumer a developer hranice](https://docs.composio.dev/kb/guide/consumer-project-boundaries-and-auth-selection).
- [Connected accounts](https://docs.composio.dev/kb/guide/platform-connected-accounts).

Lazurio distribuuje postup, ne vlastní broker, OAuth proxy ani providerové
formuláře. Přehled v Launchpad Settings je navazující produktová práce, ne
hotová funkce tohoto runbooku. Nyní jsou autoritou nastavení harnessů, CLI
a Composio UI.
