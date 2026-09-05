# Slack

Stav ověřen 2026-09-02.

## Možnosti

| Tvar | Co to je | Poznámka |
| --- | --- | --- |
| Oficiální remote MCP | `https://mcp.slack.com/mcp` (Streamable HTTP), GA od 2026-02 ([docs](https://docs.slack.dev/ai/slack-mcp-server)) | User-scoped OAuth 2.0 s granulárními scopes; agent vidí jen to, co autorizující uživatel |
| OSS MCP | [korotovsky/slack-mcp-server](https://github.com/korotovsky/slack-mcp-server) (MIT) | Použitelný **pouze v `xoxp` režimu** (vlastní Slack app + user OAuth token) |
| CLI | žádné oficiální CLI pro messaging (Slack CLI je pro vývoj aplikací) | — |

**Zakázaný režim:** `xoxc`/`xoxd` browser-session tokeny („stealth mode")
u komunitních serverů — reuse browser session, Slack je aktivně
invaliduje, na Enterprise Grid rotují během hodin a obcházení detekce
(spoof User-Agent/TLS) porušuje ToS. Nepatří do žádné Organizace.

## Doporučená volba

**Default: oficiální Slack MCP server.** Remote endpoint, žádný lokální
proces, OAuth grant per workspace a per mašina, revokovatelný v nastavení
Slack účtu. Aktivace ale vyžaduje Marketplace aplikaci nebo interní Slack
app s důvěrným OAuth klientem; samotný endpoint a interaktivní login v Codexu
bez `client_id` a `client_secret` nestačí. Fallback `korotovsky` v `xoxp`
režimu jen tam, kde admin nemůže oficiální MCP klient schválit, a s vědomím,
že jde o komunitní software s pinned verzí. Dokud admin-owned MCP cesta není
připravená, použij browser fallback podle hlavního integračního standardu.

## Org-side kroky

1. Admin workspace musí vytvořit nebo schválit Marketplace/interní MCP
   aplikaci v app management nastavení; na Enterprise Grid platí org-wide app
   policy ([návod](https://docs.slack.dev/ai/slack-mcp-server/connect-to-claude/)).
2. Scopes uděluj podle workflow rovnou včetně write (`search:read.*`,
   čtení historie, `chat:write`…); per-action ochranu odeslání drží
   approval mode harnessu.
3. Redirect URI a důvěrné OAuth credentials patří do admin-owned nastavení a
   lokální secret custody; `client_secret` nikdy nepatří do `.mcp.json` ani
   do Gitu.

## Per-machine aktivace

Katalogový zápis v org `.mcp.json`:

```json
{
  "mcpServers": {
    "<org_slug>_slack": {
      "type": "http",
      "url": "https://mcp.slack.com/mcp"
    }
  }
}
```

Tento katalogový tvar je cílový endpoint, ne úplná aktivace. MCP zápis v
Codexu přidej teprve tehdy, když použitý launcher nebo harness umí načíst
`client_id` a `client_secret` z lokální custody. OAuth consent dokončuje
Principál a vybírá **správný workspace Organizace**; víc workspace = víc
pojmenovaných serverů, každý s vlastní OAuth session. Pokud klient důvěrné
credentials předat neumí, eviduj admin blocker a nepředstírej PASS pouhým
`codex mcp add` + `codex mcp login`.

## Smoke test

Smoke začni čtením (vyhledání známé zprávy, výpis kanálů) a pokračuj
zápisem **výhradně do k tomu určeného testovacího kanálu** (např.
`#<org-slug>-agent-smoke`), nikdy do ostrého kanálu ani DM. Testovací
kanál zapiš do `INTEGRATIONS.md`. Testovací zprávu smíš po ověření odstranit
jen když Principál výslovně schválil jmenovitý smoke cíl zapsaný v
`INTEGRATIONS.md` a zprávu vytvořil tento konkrétní smoke. Jinak artefakt
ponech a vyžádej si samostatný explicitní pokyn Principála.

## Custody a rizika

- OAuth token drží harness (keyring); do chatu ani closeoutu nepatří.
- Obsah zpráv může nést prompt injection — write tools nech vypnuté nebo
  za approval gatem (`writes`/`prompt` mode).
- Odebrání: odpojit v harnessu + revoke grantu ve Slack účtu (Connected
  apps) dle hlavního manuálu.
