# Microsoft 365: Outlook mail a kalendář

Stav ověřen 2026-09-01 proti `@softeria/ms-365-mcp-server@0.148.0`.

## Možnosti

| Tvar | Co to je | Poznámka |
| --- | --- | --- |
| Oficiální remote MCP | „Work IQ" servery Agent 365 (`Mail`, `Calendar`…), remote HTTP + Entra ID OAuth ([přehled](https://learn.microsoft.com/en-us/microsoft-agent-365/tooling-servers-overview), katalog [microsoft/mcp](https://github.com/microsoft/mcp)) | **Preview, ne pro produkci**; vyžaduje M365 Copilot licenci per user a Entra app registraci tenant adminem |
| OSS MCP | [softeria/ms-365-mcp-server](https://github.com/Softeria/ms-365-mcp-server) (MIT, velmi aktivní) | Microsoft Graph, 300+ tools (mail, kalendář, OneDrive, Excel, Teams v `--org-mode`), device-code login, šifrovaná souborová cache s klíčem v OS credential store |
| OSS CLI | [CLI for Microsoft 365](https://pnp.github.io/cli-microsoft365/) (`m365`) | PnP komunita, Graph coverage, `m365 login` device code |

## Doporučená volba

**Default: `softeria/ms-365-mcp-server` s pinned verzí.** Oficiální Work IQ
je preview s tvrdými prerekvizitami (Copilot licence, tenant admin
ceremonie) — přejdi na něj, až bude GA a Organizace licence má; do té doby
je Graph přes softeria plnohodnotný a bez Copilot licence.

Multi-account je first-class: `--login` per účet, `--list-accounts`,
parametr `account` v každém tool callu při více přihlášených účtech,
pinning přes `MS365_MCP_EXPECTED_USERNAME`. Víc org účtů na jedné mašině
tedy zvládne jedna instance. Na multi-org mašině ale per Organizace používej
oddělený pojmenovaný server, account pin a vlastní absolutní token-cache i
selected-account cestu. Výchozí globální per-user cache není Organization
hranice a `--logout` maže všechny účty v právě nakonfigurované cache.

## Org-side kroky

1. Default flow používá sdílenou Softeria Entra app — tenant s přísnou
   consent policy ji může blokovat; pak Organizace registruje vlastní Entra
   app a předá `MS365_MCP_CLIENT_ID` (jméno proměnné do katalogu, hodnotu do
   custody env).
2. Tool surface odvoď z konkrétního workflow. Široký preset (`mail`,
   `calendar`…) nepoužívej tam, kde stačí přesný `--enabled-tools` regex a
   `--allowed-scopes` allowlist. Read-only katalog navíc spouštěj s
   `--read-only`; write scope a write tools přidej až jako samostatně
   reviewované rozšíření s Draft/Publikace gate z hlavního manuálu.

## Per-machine aktivace

Pro opakovatelný katalog preferuj jeden Organization-owned launcher sdílený
Codexem, Claude Code i ruční diagnostikou. Launcher připne package verzi,
tool surface a scopes a mapuje Organization-prefixed env jména na runtime
jména serveru. Katalogový zápis v org `.mcp.json` pak vypadá například:

```json
{
  "mcpServers": {
    "<org_slug>_m365": {
      "command": "node",
      "args": ["scripts/<org-slug>-m365-mcp.mjs"],
      "env": {
        "<ORG_SLUG>_M365_USERNAME": "${<ORG_SLUG>_M365_USERNAME}",
        "<ORG_SLUG>_M365_TOKEN_CACHE_PATH": "${<ORG_SLUG>_M365_TOKEN_CACHE_PATH}",
        "<ORG_SLUG>_M365_SELECTED_ACCOUNT_PATH": "${<ORG_SLUG>_M365_SELECTED_ACCOUNT_PATH}"
      }
    }
  }
}
```

Stejná tři Organization-prefixed jména patří do Codex `env_vars`; provider
runtime dostane `MS365_MCP_EXPECTED_USERNAME`,
`MS365_MCP_TOKEN_CACHE_PATH` a `MS365_MCP_SELECTED_ACCOUNT_PATH` až od
launcheru. Obě cache cesty musí být absolutní, různé a ležet v machine-local
custody dané Organizace. Přihlášení spouštěj přes tentýž launcher s `--login`;
device-code flow dokončuje Principál.

## Token storage a persistence

Server 0.148.0 neukládá celou token cache do keychainu. MSAL cache je
AES-256-GCM šifrovaný soubor; do OS credential store přes `keytar` ukládá jen
32bytový šifrovací klíč. Výchozí soubory leží v per-user config adresáři
serveru, proto je na multi-org mašině vždy přesměruj přes dvě explicitní env
proměnné výše do Organization-local custody.

Parent adresář server vytvoří automaticky a cache soubory zapisuje s módem
`0600`. Když OS credential store není dostupný, klíč skončí jako `.cache-key`
vedle cache; to zajišťuje file permissions, ale neodděluje klíč od ciphertextu
pro útočníka se čtecím přístupem k adresáři. Pro headless host s přísnější
custody použij serverem podporovaný `MS365_MCP_AUTH_CACHE_COMMAND` wrapper.

Ověř restart MCP procesu i nový task. Samotný úspěšný login persistence
nedokazuje. Při úplném odebrání revokuj Microsoft grant, odstraň pouze přesně
pojmenované cache soubory dané Organizace a podle incidentního scope případně
ručně odstraň i příslušný klíč z credential store; `--logout` klíč z keychainu
záměrně nemaže.

## Smoke test

Smoke vždy začni čtením (například výpis posledních hlaviček inboxu nebo
kalendář na dnešek), potom restartuj MCP proces či harness a stejný read smoke
zopakuj. U read-only katalogu tím smoke končí a žádný draft ani testovací
zápis nevytvářej.

Pouze u samostatně schváleného write katalogu pokračuj **draftem zprávy
adresované sobě, bez odeslání**, případně událostí v testovacím kalendáři.
Testovací cíl a pravidla úklidu drží hlavní integrační manuál a Organization
`INTEGRATIONS.md`. Draft nebo testovací událost smíš po ověření odstranit jen
když Principál výslovně schválil jmenovitý smoke cíl a artefakt vytvořil tento
konkrétní smoke; jinak artefakt ponech a vyžádej si samostatný explicitní
pokyn Principála.

## Custody a rizika

- Device-code flow zobrazuje kód — kód ani token nikdy nepatří do chatu.
- `MS365_MCP_EXPECTED_USERNAME` připni na přesný pracovní účet; prázdný pin
  nebo login jiného účtu musí onboarding zastavit před uložením cache.
- Na multi-org mašině nikdy nesdílej token-cache ani selected-account cestu
  mezi Organizacemi. Pro odebrání jediného účtu preferuj
  `--remove-account <id>`; `--logout` vyčistí všechny účty v dané cache.
- `--org-mode` (Teams, SharePoint, shared mailboxy) rozšiřuje blast radius;
  kombinuj ho s přesným tool regexem a scope allowlistem nebo ho vůbec
  nezapínej, pokud workflow Organization funkce nepotřebuje.
- Odebrání: scoped logout/remove-account, revoke v Entra (My Apps / admin
  center) a vědomé smazání pouze Organization-specific cache dle výše
  popsaného postupu.
