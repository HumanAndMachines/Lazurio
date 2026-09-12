# Ruční MCP integrace pro Codex

Tento runbook je Codex-specifická část standardu
[external-app-integrations.md](external-app-integrations.md): napojení na
externí aplikace používají existující napojení, preferované Composio nebo
vhodné přímé MCP či CLI bez Lazurio prostředníka.
Popisuje, jak Kolega na své mašině přidá MCP server přímo do Codexu.
Lokální autorizace Codexu neznamená lokální custody upstream tokenů:
u Composia je spravuje také poskytovatel ve svém cloudu. Přímý lokální STDIO server ani vzdálený
HTTP MCP server Docker nepotřebují.

Codex CLI, desktop aplikace a IDE extension používají stejnou lokální
konfiguraci na stejné Mašině. Webové prostředí tuto lokální konfiguraci
nepřebírá; má vlastní správu připojení. Připojení v jiném klientovi
neprokazuje funkčnost zde. Aktuální syntaxe a podporované volby jsou v
[oficiálním Codex MCP manuálu](https://learn.chatgpt.com/docs/extend/mcp).

## Volba integračního tvaru

| Potřeba | Doporučený tvar | Kde jsou credentials | Docker |
| --- | --- | --- | --- |
| Jedna mašina, lokální proces a lokální OAuth cache | STDIO MCP | Na dané mašině | Ne |
| Poskytovatel provozuje svůj MCP endpoint | Streamable HTTP + OAuth | Lokální OAuth úložiště Codexu; token se používá vůči poskytovateli | Ne |
| Composio Connect | Streamable HTTP + OAuth | Lokální autorizace Codexu; upstream účty a credentials spravuje Composio v cloudu | Ne |

Lokální konfigurace neznamená lokální zpracování dat ani všech credentials.
Přímé MCP i agregátor vyžadují důvěru v MCP
server, poskytovatele služby ani model. MCP nástroj může číst data, která mu
udělené OAuth scopes a lokální filesystem dovolí, a obsah e-mailu nebo dokumentu
může nést prompt injection. Připojuj jen zdroj, jehož kód a datovou hranici
Principál přijímá.

## Bezpečnostní gate před instalací

1. Urči Mašinu, Ownera a scope: osobní nebo Organization. Názvy pomáhají
   orientaci, ne technické izolaci. Při více účtech ověř konkrétní identitu.
   Nepřenášej credentials mezi Organizacemi ani Mašinami.
2. Ověř publishera, zdrojový repozitář, licenci, release/tag nebo přesný commit
   a seznam závislostí. Komunitní MCP není „oficiální integrace“ jen proto, že
   obsluhuje známou službu. Pro trvalý runtime nepoužívej neukotvené `latest`.
3. Scopes zvol podle potřeb a mandátu. Harness může nabídnout doplňkové
   approvals, ale nejsou izolací vůči jiným procesům. U obecného execute
   meta-tool nejsou důkazem read-only oprávnění každé upstream akce.
4. Secret hodnoty, OAuth kódy, tokeny ani obsah client JSONu neposílej chatem a
   necommituj. Řiď se [lokálním secret custody standardem](security/local-secret-custody.md):
   root/operator secrets patří do
   `personalspace/<owner>_GEN3/secrets/<provider>/<scope>/<purpose>`, secrets
   Kolegy v Organizaci do
   `organizations/<org>/company/colleagues/<os-user>/private/secrets/<provider>/<scope>/<purpose>`.
   Adresáře mají mód `0700`, soubory `0600`.
5. Do trackované projektové `.codex/config.toml` nikdy nevkládej secret hodnotu.
   Projektovou konfiguraci Codex načte jen v trusted projektu, přesto ji reviewuj
   jako spustitelnou konfiguraci. Osobní integrace patří raději do
   `~/.codex/config.toml`.
6. Lokální STDIO proces běží s právy přihlášeného uživatele. Nepovoluj mu širší
   filesystem cesty, než potřebuje. Vzdálený HTTP server naopak přijímá data
   přes síť; ověř doménu a TLS endpoint přímo v dokumentaci poskytovatele.

## Základní práce s Codex MCP

Nejdřív zkontroluj aktuální CLI kontrakt:

```sh
codex mcp --help
codex mcp add --help
```

Codex umí server přidat přes CLI nebo přímo v `config.toml`:

```sh
# Lokální STDIO proces. Všechno za -- je příkaz serveru.
codex mcp add <server_name> -- /absolutni/cesta/k/serveru --argument

# Vzdálený Streamable HTTP endpoint.
codex mcp add <server_name> --url https://provider.example/mcp

codex mcp list
codex mcp get <server_name>
```

Po změně restartuj desktop/IDE Codex nebo otevři nový task. V tasku zkontroluj
MCP stav přes `/mcp` a proveď nejdřív neškodný read-only dotaz. Výpis ani
closeout nesmí obsahovat secret nebo OAuth callback data.

### Doporučené globální nastavení OAuth

Na platformě s dostupným systémovým keyringem preferuj jeho použití:

```toml
# ~/.codex/config.toml
mcp_oauth_credentials_store = "keyring"
```

`file` úložiště používej jen tehdy, když keyring není dostupný a lokální
filesystem je odpovídajícím způsobem chráněný. OAuth client secret nebo bearer
token nevkládej do TOMLu. Pro statický bearer token použij
`bearer_token_env_var`, tedy jméno lokální environment proměnné, ne její
hodnotu.

Toto nastavení řeší OAuth, který u Streamable HTTP serveru obsluhuje Codex.
U lokálního STDIO serveru, jenž se sám přihlašuje k providerovi (například
`workspace-mcp` ke Googlu), drží refresh token tento server ve vlastní
persistentní credentials directory. Codex keyring jeho interní cache
nenahrazuje. V obou případech musí běžný restart serveru, Codexu i mašiny
přihlášení zachovat; krátkodobý access token se obnovuje refresh tokenem.

## Per-machine onboarding Organizace

Každý Kolega nastavuje integrace ve svém uživatelském profilu Codexu. Agent smí
instalaci připravit a diagnostikovat, ale výběr účtu a OAuth souhlas dokončuje
Principál v prohlížeči. Sdílej pouze dokumentovaný postup a metadata; nepřenášej
mezi lidmi hotové token cache, client secrety ani celý uživatelský
`~/.codex/config.toml`.

### Composio a více Mašin

Pro běžný onboarding použij [Composio runbook](integrations/composio.md).
Přihlášení Codexu do Composia je samostatné od Composio CLI i prohlížeče.
Každý klient autorizuj podporovaným postupem; credentials nekopíruj.
Stejný Composio účet na dvou Mašinách může zpřístupnit stejné upstream účty.
Samostatná lokální konfigurace proto neslibuje oddělení těchto oprávnění
ani nezávislou revokaci upstream grantu.

### Ověření a řízená náhrada

Nejprve ověř správný účet a potřebnou schopnost v novém Codex tasku. CLI
smoke není MCP smoke. Zápis ověř jen na schváleném vratném cíli. Teprve
potom odpoj konkrétní nahrazovanou cestu; přímý MCP s unikátní potřebnou
schopností není zbytečná duplicita. Zrušení upstream grantu může ovlivnit
jiné klienty, a proto vyžaduje kontrolu jeho skutečného rozsahu a mandát.

## Příklad A: oficiální vzdálený ClickUp MCP

ClickUp publikuje endpoint `https://mcp.clickup.com/mcp` ve své
[oficiální MCP dokumentaci](https://developer.clickup.com/docs/connect-an-ai-assistant-to-clickups-mcp-server).
Je-li přímý ClickUp MCP vhodnější pro potřebnou schopnost, přidej jej například:

```sh
codex mcp add example_org_clickup --url https://mcp.clickup.com/mcp
codex mcp login example_org_clickup
codex mcp get example_org_clickup
```

OAuth souhlas dokončuje člověk v prohlížeči. Zkontroluj správný ClickUp
Workspace a oprávnění účtu; agent může dělat pouze operace, které tento účet
smí. Smoke začni čtením známého tasku a pokračuj zápisem na testovacím
záznamu v mandátu Principála.

Pro explicitní approval policy lze server upravit v `~/.codex/config.toml`:

```toml
[mcp_servers.example_org_clickup]
url = "https://mcp.clickup.com/mcp"
default_tools_approval_mode = "writes"
startup_timeout_sec = 20
tool_timeout_sec = 60
required = false
```

`writes` nechává čtení automatické a zápisy potvrzované. Pro citlivější data
použij `prompt`, případně přes `enabled_tools` povol jen reviewovanou podmnožinu.

## Příklad B: lokální Google Workspace MCP přes STDIO

Google Workspace příklad níže používá komunitní MIT projekt
[`taylorwilsdon/google_workspace_mcp`](https://github.com/taylorwilsdon/google_workspace_mcp),
nikoli produkt vydaný Googlem nebo OpenAI. Před instalací zkontroluj aktuální
security dokumentaci a ukotvi instalaci na reviewovaný release nebo commit.
Server vyžaduje Python a lokální runtime (například izolovaný `venv`); Docker
není potřeba.

1. V Google Cloud vytvoř OAuth client pro desktop aplikaci a povol jen potřebná
   API. Pro interní Organization použití preferuj Organization-owned projekt
   a audience `Internal`; `External / Testing` s Workspace scopes ukončuje
   autorizaci test usera po sedmi dnech. Přesnou diagnostiku a variantu
   `In production` drží [Google Workspace runbook](integrations/google-workspace.md#google-oauth-persistence).
   Stažený client JSON ulož do custody cesty, nikoli do repozitáře serveru.
2. Server spouštěj z lokálního izolovaného prostředí a ukotvi ho na reviewovanou
   verzi. Aktuální upstream používá příkaz `workspace-mcp` a podporuje `uvx`;
   před nasazením nahraď `<reviewed-version>` konkrétní ověřenou verzí.
3. Zapni služby, které Organizace používá (například Gmail, Calendar, Drive
   a Sheets), s read i write přístupem. Cesty lze dodat přes lokální
   environment; jejich hodnoty necommituj do sdíleného repozitáře.

Příklad osobního `~/.codex/config.toml`:

```toml
[mcp_servers.example_org_google_workspace]
command = "/ABSOLUTNI/LOKALNI/CESTA/bin/uvx"
args = ["--from", "workspace-mcp==<reviewed-version>", "workspace-mcp", "--single-user", "--tool-tier", "core"]
env_vars = ["GOOGLE_CLIENT_SECRET_PATH", "WORKSPACE_MCP_CREDENTIALS_DIR", "GOOGLE_MCP_CREDENTIALS_DIR"]
default_tools_approval_mode = "writes"
startup_timeout_sec = 30
tool_timeout_sec = 90
required = false
```

Před spuštěním Codexu nastav v lokálním shellu nebo machine-local launcheru:

```sh
export GOOGLE_CLIENT_SECRET_PATH="/custody/cesta/google/client.json"
export WORKSPACE_MCP_CREDENTIALS_DIR="/custody/cesta/google/tokens"
export GOOGLE_MCP_CREDENTIALS_DIR="/custody/cesta/google/tokens"
```

Tyto ukázkové cesty nahraď skutečnými absolutními cestami. Launcher se secret
hodnotami musí zůstat mimo Git a mít lokální custody oprávnění. Nepřebírej
vývojové nastavení `OAUTHLIB_INSECURE_TRANSPORT=1` do běžného provozu.
Credentials directory nesmí být v `/tmp`, ephemeral containeru ani
memory-only/stateless backendu. Adresář drž v módu `0700`, credential soubory
v módu `0600`. Současný upstream dokumentuje obě credentials env jména, ale
připnutá reviewovaná verze může podporovat jen jedno. Proto je exportuj na
tutéž custody cestu a ve sdíleném příkladu žádné nemaž; uvedení obou jmen v
`env_vars` i v prostředí drží bezpečný přechod bez tichého pádu do defaultní
runtime cesty.

První browser consent dokonči ručně a pak v `/mcp` ověř nástroje nejdřív
čtecím dotazem; write tools jsou od začátku povolené a per-action je
potvrzuje approval mode.

Potom ukonči STDIO proces, restartuj Codex nebo otevři nový task a zopakuj
metadata-only identitu + read smoke. Restart smoke prokazuje lokální
persistenci; odstranění sedmidenní Google provider expirace potvrdí až
kontrola po více než sedmi dnech.

## Odebrání, rotace a incident

```sh
codex mcp logout <server_name>
codex mcp remove <server_name>
```

Odebrání z Codexu samo nemusí zrušit grant u poskytovatele ani smazat cache
samotného MCP serveru. Při ukončení napojení:

1. odhlaš server v Codexu a odeber konfiguraci;
2. zruš OAuth grant/token u poskytovatele;
3. podle dokumentace serveru bezpečně odstraň nebo rotuj jeho lokální token
   cache a client secret;
4. ověř `codex mcp list` a nový task;
5. zapiš jen metadata: název integrace, scope, datum, owner a výsledek. Nikdy
   nezapisuj token, callback URL ani credential JSON.

Při podezření na kompromitaci nejdřív revoke u poskytovatele, potom rotuj
client credentials a lokální cache. Pouhé smazání lokálního souboru už vydaný
token na straně poskytovatele nemusí zneplatnit.

## Časté problémy

- **Server se po přidání nezobrazuje:** restartuj Codex/IDE, ověř
  `codex mcp get <name>` a zda projektová konfigurace leží v trusted projektu.
- **OAuth se opakuje po restartu:** nejdřív urči transport. U HTTP OAuth ověř
  systémový keyring Codexu; u STDIO ověř persistentní credentials directory
  serveru, její načtení launcherem a oprávnění `0700`/`0600`. Neloguj callback
  URL ani obsah cache.
- **Google OAuth se opakuje přibližně po sedmi dnech:** ověř audience a
  publishing status GCP OAuth projektu. `External / Testing` s Gmail/Drive
  scopes má sedmidenní refresh token; postup pro `Internal` nebo
  `In production` drží provider runbook. Admin stav `Trusted` řeší app-access
  policy, ale tuto expiraci neruší. Pouhé další přihlášení příčinu neřeší.
- **Server nenastartuje:** spusť executable mimo Codex jen s `--help`, ověř
  absolutní cestu, pin verze a názvy environment proměnných. Secret hodnoty
  nevypisuj.
- **Nástroj má příliš mnoho možností:** použij `enabled_tools`, read-only mód
  serveru a `default_tools_approval_mode = "prompt"`.
- **Integrace je potřeba na telefonu:** lokální Codex konfigurace se automaticky
  nepřenáší. Ověř samostatné možnosti cílového klienta; tento runbook je
  neinstaluje ani netvrdí jejich funkčnost.
