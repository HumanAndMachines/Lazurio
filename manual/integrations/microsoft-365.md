# Microsoft 365: firemní aplikace Organizace

Stav k 2026-10-14 podle rozhodnutí 0162, dodatek z 2026-10-14
([registr](../decision-register.md)). Postup zatím neprošel skutečným tenantem:
kroky označené **neověřeno** potvrdí nebo opraví ověření V1–V6 níže. Kdo na
skutečném tenantu narazí na jiné chování, opraví tenhle runbook PR podle
[živého standardu](../external-app-integrations.md#živý-standard-zpětná-vazba-z-instalací-je-povinná).

## Model

- **Jedna aplikace na Organizaci.** Organizace má ve svém vlastním tenantu
  Microsoftu právě jednu aplikaci Entra „Lazurio (<Organizace>)“: jen pro účty
  tohoto tenantu (`AzureADMyOrg`), jen delegovaná oprávnění Microsoft Graph.
  Žádná aplikační (app-only) ani správcovská oprávnění.
- **Založí ji agent** v pracovním Environmentu Admina oficiálním Azure CLI
  (`az`). Microsoft Graph CLI (`mgc`) Microsoft 2026-08-28 vyřadil a
  nepoužívá se. Admin se jen přihlásí správcovským účtem firmy a potvrdí
  souhlas.
- **Jeden souhlas za celou firmu.** Správce tenantu jednou potvrdí „Přijmout“
  jménem organizace; nikdo další souhlas nedává. Výchozí politika Microsoftu
  („Let Microsoft manage your consent settings“) lidem souhlas s poštou,
  kalendářem, soubory ani weby stejně nedovolí.
- **Veřejný klient bez tajného klíče.** Aplikace přihlašuje přes PKCE a žádný
  klientský tajný klíč ani certifikát nemá. Návratové adresy (typ *Mobile and
  desktop applications*, tedy `publicClient.redirectUris`) jsou:
  - adresa Launchpadu každého pracovního Environmentu Organizace,
    `<vstup Launchpadu>/api/integrations/oauth/callback`, pro přihlášení ve
    vlastním prohlížeči člověka;
  - `http://localhost/api/oauth/callback`, návrat Executoru pro přihlášení
    v prohlížeči Environmentu. U `localhost` Microsoft port nebere v úvahu,
    cesta se ale shodovat musí, proto se registruje celá cesta, nikdy holé
    `http://localhost`.
- **Nastavení Organizace nese jen identifikátory** (rozhodnutí 0194): id
  tenantu, id aplikace, zapnuté aplikace a zaregistrované adresy Launchpadů
  v `settings.integrations.microsoft365` manifestu Organizace
  ([tvar a pravidla](../lazurio-manifest-family.md#microsoft-365-company-app-settingsintegrationsmicrosoft365)).
  Environment podle nich zaregistruje aplikaci a specifikace Graphu do svého
  Executoru ([executor.md](executor.md)).
- **Lidé se připojují sami** v Apps → Integrace: Outlook (pošta i kalendář
  jednou kartou), OneDrive a SharePoint, ve svém prohlížeči a svým pracovním
  účtem. Agenti dosáhnou jen tam, kam smí ten člověk sám.
- **Odesílání pošty je vypnuté.** `Mail.Send` aplikace ve výchozím stavu
  nemá; agenti připravují koncepty. Organizace ho zapíná vědomě, jako
  samostatné rozšíření oprávnění se souhlasem správce.
- **Teams přijde ve druhé fázi**, pro čtení a koncepty.

**Dnes versus cíl.** Použití nastavení v Environmentech, karta Připojit pro
firemní aplikace a odpojení při předání Environmentu v LazurioPlatform
i nastavení Microsoftu 365 v Dashboardu teprve vznikají (plán DEV-6626).
Do té doby aplikaci zřídí agent v pracovním Environmentu Admina jen na jeho
výslovný pokyn podle tohoto runbooku a připojení dělá agent na výslovný pokyn
člověka přechodnou cestou ze sekce [Executor](#executor-v-environmentu).
Nastavení `microsoft365` Organizace do manifestu nezapisuje, dokud nevyjdou
čtenáři, kteří ho znají (sekce [Readers first](../lazurio-manifest-family.md#readers-first)):
starší čtenář by celou sekci `settings` odmítl, včetně přepínače Composia.

## Delegovaná oprávnění

Všechna oprávnění jsou delegovaná: skutečný přístup je průnik oprávnění
aplikace a práv přihlášeného člověka.

| Aplikace | Oprávnění | Volitelně později | Poznámka |
| --- | --- | --- | --- |
| přihlášení | `openid`, `profile`, `email`, `offline_access`, `User.Read` | — | `offline_access` dává obnovovací token |
| Outlook pošta | `Mail.ReadWrite` (čtení, koncepty) | `Mail.Send` | odeslání je Publikace; bez `Mail.Send` ho agent technicky neudělá |
| Outlook kalendář | `Calendars.ReadWrite` | — | patří k téže kartě Outlook |
| OneDrive a knihovny SharePointu | `Files.ReadWrite.All` | — | soubory ve vlastním OneDrivu i v knihovnách webů |
| SharePoint weby | `Sites.Read.All` | `Sites.ReadWrite.All`; delegované `Sites.Selected` | najít web, jeho knihovny a seznamy |
| Teams chaty (fáze 2) | `Chat.ReadWrite` | `ChatMessage.Send` | |
| Teams kanály (fáze 2) | `Channel.ReadBasic.All`, `ChannelMessage.Read.All` | `ChannelMessage.Send` | |

Nikdy nežádej aplikační oprávnění, adresářová ani správcovská oprávnění,
`MailboxSettings.ReadWrite` (které kurátorovaná specifikace pošty uvádí) ani
oprávnění ke sdíleným schránkám (`.Shared`), dokud sdílená schránka není
pojmenovaná potřeba. Specifikace Graphu pro uživatele, skupiny, adresář,
aplikace, identitu, bezpečnost a Intune se nenabízejí nikdy.

## Postup Admina (agent v pracovním Environmentu Admina)

Agent nejdřív Adminovi lidsky vysvětlí, co se stane: vznikne jedna aplikace
„Lazurio (<Organizace>)“, bez hesla a tajného klíče, která smí za přihlášeného
člověka číst a připravovat poštu, kalendář a soubory, vždy jen to, k čemu má
ten člověk sám přístup, a odesílání pošty zůstane vypnuté. Pak postupuje po
krocích a při každém selhání se zastaví a řekne, co chybí.

### 1. Přihlášení `az`

`az` chybí-li, nainstaluje ho agent z oficiálního zdroje podle pravidel
instalace nástrojů v `AGENTS.md` (se souhlasem Admina s přesnou změnou).

```sh
az login --tenant <doména-firmy> --allow-no-subscriptions --use-device-code
```

- Na Remote Environmentu je spolehlivější `--use-device-code`: krátký kód
  a adresu `https://microsoft.com/devicelogin` agent předá jen do soukromého
  chatu a Admin se přihlásí ve svém prohlížeči správcovským účtem. Kde
  podmíněný přístup kód zařízení blokuje, zkus přihlášení v prohlížeči
  Environmentu (`az login` bez `--use-device-code`); co fungovalo, zapiš
  k ověření V6.
- Přístupové tokeny `az` nikdy nevypisuj (`az account get-access-token` se
  nepoužívá) a nic z `~/.azure` nekopíruj.

### 2. Kontroly jen ke čtení

```sh
TENANT=$(az account show --query tenantId -o tsv)
az rest --method get --url 'https://graph.microsoft.com/v1.0/me/memberOf/microsoft.graph.directoryRole?$select=displayName' --query 'value[].displayName' -o tsv
az rest --method get --url https://graph.microsoft.com/v1.0/policies/authorizationPolicy --query 'defaultUserRolePermissions.permissionGrantPoliciesAssigned'
az rest --method get --url https://graph.microsoft.com/v1.0/policies/adminConsentRequestPolicy --query isEnabled
az rest --method get --url https://graph.microsoft.com/v1.0/policies/defaultAppManagementPolicy --query '{enabled:isEnabled,restrictions:applicationRestrictions}'
az rest --method get --url 'https://graph.microsoft.com/v1.0/identity/conditionalAccess/policies?$select=displayName,state' --query 'value[].{name:displayName,state:state}'
az ad app list --display-name 'Lazurio (<Organizace>)' --query '[].appId' -o tsv
```

- **Role.** Souhlas za celou firmu udělí Global Administrator nebo Privileged
  Role Administrator; Cloud Application Administrator a Application
  Administrator udělí delegovaná oprávnění k Graphu jen tam, kde to politika
  tenantu dovolí (**neověřeno**). Chybí-li role, agent řekne, kterou a kdo ve
  firmě ji má; dál nepokračuje.
- **Politika souhlasů** jen vysvětluje, proč lidé souhlas dát nemohou. Je-li
  zapnutý pracovní postup žádostí o souhlas správce, odeslaná žádost jen čeká
  ve frontě; agent to řekne a počká.
- **Politika správy aplikací** smí zakazovat tajné klíče. Veřejného klienta
  se to netýká, jen záložní varianty s klíčem.
- **Podmíněný přístup.** Čtení může skončit 403, když účet nebo `az` nemá
  `Policy.Read.All`; agent to uvede jako „nelze přečíst“. Zásady vyžadující
  spravované zařízení nebo pojmenované lokality mohou zablokovat přihlášení
  nebo volání Graphu z adresy Environmentu; náprava je rozhodnutí firmy
  (výjimka pro aplikaci Lazurio nebo odchozí adresy sítě jako pojmenovaná
  lokalita).
- **Existující aplikace** se znovu nezakládá; agent ji jen porovná s tímto
  runbookem a navrhne opravu.

### 3. Založení aplikace

`<vstup Launchpadu>` je adresa Launchpadu daného Environmentu, kterou
Environment sám uvádí (v návodech Lazurio Folderu řádek „Vstup: Launchpad
tohohle Environmentu je dosažitelný na …“); seznam adres pracovních
Environmentů Organizace cílově dodá Dashboard. Adresy nikdy nedopočítávej.

```sh
APP=$(az ad app create \
  --display-name 'Lazurio (<Organizace>)' \
  --sign-in-audience AzureADMyOrg \
  --public-client-redirect-uris 'http://localhost/api/oauth/callback' '<vstup Launchpadu 1>/api/integrations/oauth/callback' \
  --query appId -o tsv)

GRAPH=00000003-0000-0000-c000-000000000000
for SCOPE in openid profile email offline_access User.Read Mail.ReadWrite Calendars.ReadWrite Files.ReadWrite.All Sites.Read.All; do
  ID=$(az ad sp show --id "$GRAPH" --query "oauth2PermissionScopes[?value=='$SCOPE'].id | [0]" -o tsv)
  az ad app permission add --id "$APP" --api "$GRAPH" --api-permissions "$ID=Scope"
done
az ad sp create --id "$APP"
```

- Id oprávnění se čtou z principálu Microsoft Graph v tenantu, nikdy se
  neopisují odjinud.
- Klientský tajný klíč, certifikát ani federovaná identita se nepřidávají.
  „Allow public client flows“ (`isFallbackPublicClient`) zapínat netřeba: týká
  se jen toků bez návratové adresy.
- Přístup jen přiřazené skupině lidí („Assignment required“ na podnikové
  aplikaci a skupina, například „Lazurio“) je volba Organizace; přidá krok
  Admina u každého nového člověka a odchod pak řeší odebrání ze skupiny
  (ověření V5).

### 4. Souhlas jménem organizace

Admin souhlas dá sám ve svém prohlížeči. Agent mu připraví adresu, předem
řekne, že se po potvrzení prohlížeč pokusí otevřít `localhost` a ukáže chybu
spojení, a že to nevadí:

```text
https://login.microsoftonline.com/<TENANT>/v2.0/adminconsent?client_id=<APP>&scope=https%3A%2F%2Fgraph.microsoft.com%2F.default&redirect_uri=http%3A%2F%2Flocalhost%2Fapi%2Foauth%2Fcallback&state=<náhodný řetězec>
```

Microsoft ukáže obrazovku „Požadovaná oprávnění“ se seznamem z tabulky výše;
Admin ho zkontroluje a potvrdí **Přijmout**. Kde obrazovka nejde použít,
udělí stejný souhlas příkaz `az ad app permission admin-consent --id "$APP"`
spuštěný až na výslovné „ano“ Admina v chatu.

Výsledek agent ověří čtením:

```sh
SP=$(az ad sp show --id "$APP" --query id -o tsv)
az rest --method get --url "https://graph.microsoft.com/v1.0/oauth2PermissionGrants?\$filter=clientId%20eq%20'$SP'" --query 'value[].{type:consentType,scope:scope}'
```

Očekává se jeden záznam `AllPrincipals` s přesně oprávněními z tabulky.

### 5. Nastavení Organizace

Agent navrhne PR do kořenového repozitáře Organizace s
`settings.integrations.microsoft365` (`tenant_id`, `client_id`, `apps`,
`callbacks`) a Admin ho schválí v Dashboardu; schválení je Publikace
(rozhodnutí 0194 bod 2). `callbacks` obsahuje přesně adresy Launchpadů
zaregistrované v kroku 3, bez `localhost`. Před zápisem platí podmínka ze
sekce [Model](#model): čtenáři musí být venku.

### 6. Nový Environment

Dashboard porovná své Environmenty s `callbacks` a předá agentovi Admina
zadání doplnit chybějící adresy. Agent přečte aktuální seznam a zapíše celý
nový (příkaz seznam nahrazuje):

```sh
az ad app show --id "$APP" --query publicClient.redirectUris
az ad app update --id "$APP" --public-client-redirect-uris 'http://localhost/api/oauth/callback' '<všechny adresy Launchpadů>'
```

a stejnou změnu `callbacks` navrhne PR. Do té doby se lidé z nového
Environmentu přihlašují v prohlížeči Environmentu. Aplikace unese nejvýš 256
návratových adres, jednu bere `localhost`, takže `callbacks` má nejvýš 255
položek; zástupné znaky (wildcard) se nepoužívají. Do `callbacks` patří jen
adresy hostovaných Launchpadů `launchpad.<machine>.<github-org-login>.lazurio.io`;
jinou adresu nastavení odmítne, protože by na ni Microsoft poslal
autorizační odpověď.

## Executor v Environmentu

Cílově tohle dělá Launchpad podle nastavení Organizace, opakovaně bezpečně a
bez přihlašování kohokoli. Přechodně to agent dělá na výslovný pokyn člověka
přes rozhraní Executoru na `http://127.0.0.1:4789/api` s tokenem
z `~/.executor/server-control/auth.json` (popis rozhraní drží
`docs/integrations.md` v LazurioPlatform). Token se nikdy nevypisuje ani
nekopíruje; volání jdou bez proxy (`curl --noproxy '*'`).

**Připnuté specifikace.** Kurátorované specifikace Graphu z integrations.sh se
přidávají jako připnutý obsah (`blob`), ne živou adresou, aby změna katalogu
nerozšířila nástroje potichu. U každé se zapíše SHA-256 staženého souboru.

| Slug v Executoru | Zdroj | Oprávnění v šabloně |
| --- | --- | --- |
| `m365-outlook-mail` | `https://integrations.sh/specs/microsoft-graph/mail.json` | přihlášení + `Mail.ReadWrite` |
| `m365-outlook-calendar` | `https://integrations.sh/specs/microsoft-graph/calendar.json` | přihlášení + `Calendars.ReadWrite` |
| `m365-onedrive` | `https://integrations.sh/specs/microsoft-graph/files.json` | přihlášení + `Files.ReadWrite.All` |
| `m365-sharepoint` | `https://integrations.sh/specs/microsoft-graph/sites.json` | přihlášení + `Sites.Read.All` |

„Přihlášení“ znamená `openid profile email offline_access User.Read`.
Kurátorované specifikace míří na `common` a obsahují `Mail.Send` a
`MailboxSettings.ReadWrite`; obojí šablona nahradí:

1. **Specifikace** (`POST /api/openapi/specs`): obsah jako `blob`, slug podle
   tabulky a přepis šablony přihlášení `{kind: "oauth2", authorizationUrl:
   "https://login.microsoftonline.com/<TENANT>/oauth2/v2.0/authorize",
   tokenUrl: "https://login.microsoftonline.com/<TENANT>/oauth2/v2.0/token",
   scopes: [...], resource: null}`. Přesný tvar těla agent přečte ze zdroje
   Executoru 1.6.10 (`packages/plugins/openapi/src/api/group.ts`) a
   nedomýšlí ho (**neověřeno** na živém Executoru).
2. **Klient** (`POST /api/oauth/clients`): `{owner: "org", slug:
   "microsoft365", authorizationUrl, tokenUrl, grant: "authorization_code",
   clientId: "<APP>", clientSecret: "", resource: null}`. Prázdný
   `clientSecret` dělá z klienta veřejného klienta s PKCE.
3. **Připojení** (`POST /api/oauth/start`): `{client: "microsoft365",
   clientOwner: "org", owner: "org", name: "default", integration: "<slug>",
   template: "<id šablony OAuth z GET /api/integrations/<slug>>",
   newConnection: true}`. Bez `redirectUri` se vrací na
   `http://localhost:4789/api/oauth/callback`, proto člověk přihlášení
   dokončí v prohlížeči Environmentu, který mu agent otevře; výsledek ukáže
   `GET /api/oauth/await/<state>`. Executor přidání i připojení pozastaví ke
   schválení; výslovný pokyn člověka je tím schválením
   ([executor.md](executor.md#mcp-servery-a-připojení)).
4. **Kontrola:** `GET /api/connections` ukáže připojení s
   `lastHealth.status` `healthy` nebo `unknown`, `identityLabel` s pracovním
   účtem a prázdné `missingOAuthScopes`.

**Práce agentů.** Agenti operace hledají `executor tools search` a volají
přes Executor. Specifikace nemají adresování cestou (`root:/cesta:`), proto
se složky procházejí podle id položky (`/drives/{id}/items/{id}/children`)
a před tvrzením, že je složka prázdná, se přečte i `@odata.nextLink`.
Koncept zprávy vzniká `POST /me/messages` s `body.contentType: "Text"`,
odpověď `createReply` a následným `PATCH` těla; agent koncept přečte zpět a
dá člověku jeho `webLink`. `send` ani `sendMail` agent nevolá. Zápisy a
mazání, které Executor vrátí jako `waiting_for_interaction`, potvrdí jen pro
schválený Draft nebo Publikaci.

## Ověření na skutečném tenantu

Pořadí je důležité: V1 rozhoduje mezi veřejným a důvěrným klientem.

- **V1 Veřejný klient bez klíče.** Kód z přihlášení se vymění za tokeny bez
  tajného klíče (žádné AADSTS7000218 ani AADSTS700025) a po vypršení
  přístupového tokenu (asi po hodině) se obnoví. Úplné V1 vyžaduje návrat na
  HTTPS adresu Launchpadu, tedy kartu Připojit v LazurioPlatform; přechodná
  cesta přes `localhost` ověří výměnu a obnovu bez klíče.
- **V2 Executor 1.6.10 celou cestou:** připnutá specifikace s šablonou
  tenantu, klient s prázdným klíčem, start s adresou Launchpadu a předání
  návratu Executoru, vyplněné `identityLabel`, obnova po vypršení, prázdné
  `missingOAuthScopes`.
- **V3 Skutečná práce, nejdřív jen čtení:** najít web SharePointu podle
  adresy (`/sites/<host>:/sites/<cesta>`; když Executor zakóduje `/`, pak
  `GET /sites?search=<název>`), projít jednu složku podle id i se stránkováním,
  vytvořit textový koncept sobě, přečíst ho zpět s `webLink`. Mazat jen
  výslovně určený testovací artefakt.
- **V4 Politiky tenantu (jen čtení):** politika souhlasů, politika správy
  aplikací, podmíněný přístup, role Admina a jedno přihlášení i volání Graphu
  z adresy Environmentu.
- **V5 Odvolání:** „Assignment required“ a odebrání testovacího člověka ze
  skupiny zastaví obnovu tokenu (**neověřeno**, z dokumentace to neplyne);
  `revokeSignInSessions` udělá z připojení v Executoru `expired`.
- **V6 Záložní cesty:** přihlášení v prohlížeči Environmentu pro Environment,
  jehož adresa není zaregistrovaná; `az login` z Remote Environmentu (kód
  zařízení proti prohlížeči).

Výsledky se zapisují bez tajemství: id tenantu a aplikace, kód chyby, stav
připojení. Žádné tokeny, kódy z přihlášení ani obsah pošty.

## Odvolání a odchod člověka

- **Člověk odpojí** Integraci v Apps → Integrace („⋯“ → Odpojit), což smaže
  připojení v Executoru. U Microsoftu souhlas ruší v My Apps
  (`https://myapplications.microsoft.com`).
- **Odchod člověka:** firma zablokuje účet nebo zavolá
  `az rest --method post --url https://graph.microsoft.com/v1.0/users/<upn>/revokeSignInSessions`.
  Obnova pak do několika minut selže a Executor připojení označí `expired`;
  už vydaný přístupový token dobíhá nejvýš asi hodinu.
- **Předání nebo zrušení Environmentu** jeho připojení Microsoftu odpojí, jinak
  by další člověk v Environmentu jednal pod účtem předchozího (cílově
  Launchpad; přechodně agent na pokyn Admina).
- **Celá Organizace:** odebrání souhlasu (smazání `oauth2PermissionGrant`),
  zakázání podnikové aplikace nebo smazání aplikace (`az ad app delete --id
  <APP>`) zastaví všechna připojení. Nastavení `microsoft365` se pak odebere
  PR schváleným Adminem.
- Obnovovací token platí 90 dní od posledního použití; po 90 dnech bez
  použití se člověk připojí znovu.

## Záložní varianta: důvěrný klient

Jen když V1 na skutečném tenantu neprojde: na téže aplikaci jeden klientský
klíč pro každý Environment, pojmenovaný podle Environmentu, platný nejvýš 24
měsíců. Doručení klíče do Environmentu závisí na bodu 8 rozhodnutí 0198, který
musí být nejdřív rozhodnutý a postavený; do té doby se varianta nezavádí.
Tenant smí klíče politikou správy aplikací zakázat, pak zbývají certifikáty.

## Work IQ MCP jako pozdější volba

Work IQ MCP (`https://workiq.svc.cloud.microsoft/mcp`) je oficiální MCP server
Microsoftu, obecně dostupný od 2026-06-16 a použitelný z klientů třetích stran.
Výchozí cestou Lazuria není:

- účtuje se z Copilot Credits (Pay-as-you-go plán s předplatným Azure a
  přiřazenými lidmi);
- jediné delegované oprávnění `WorkIQAgent.Ask` dává čtení i zápis všude, kam
  Work IQ dosáhne;
- nastavení vyžaduje Global Administratora a server nemá dynamickou registraci
  klienta.

Organizace, která Copilot platí, ho může později zapnout na téže aplikaci
přidáním `WorkIQAgent.Ask` a souhlasem správce; server se pak přidá do
Executoru jako MCP server. Starší servery Agent 365 (`mcp_MailTools` a další)
jsou podle Microsoftu jen pro zpětnou kompatibilitu a nepoužívají se.

## Co se nepoužívá

- **Konektory ChatGPT a claude.ai** se pro nová napojení nezřizují.
  Existující konektor na vlastním počítači člověka smí dál běžet; agenti
  v pracovním Environmentu ho nepoužívají.
- **Komunitní MCP server** `softeria/ms-365-mcp-server` a launcher
  Organizace pro něj už nejsou doporučenou cestou: duplikovaly by to, co dávají
  kurátorované specifikace Graphu v Executoru, s vlastní cache tokenů vedle
  Executoru. Kde ho Organizace dnes používá, převede ho při zavedení firemní
  aplikace.
- **Composio** pro Microsoft 365 na pracovních Environmentech není potřeba,
  jakmile Organizace firemní aplikaci nastaví. Osobní účty Microsoftu
  (Outlook.com) firemní aplikace nepřihlásí; na osobním Environmentu zůstávají
  na Composiu.
- **Sdílená cizí aplikace Entra** (například klient komunitního nástroje)
  se nepoužívá: souhlas správce patří vlastní aplikaci Organizace.
