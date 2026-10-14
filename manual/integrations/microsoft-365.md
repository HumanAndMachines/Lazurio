# Microsoft 365: firemní aplikace Organizace

Stav k 2026-10-14 podle rozhodnutí 0162, dodatek z 2026-10-14
([registr](../decision-register.md)). Postup zatím neprošel skutečným tenantem:
kroky označené **neověřeno** potvrdí nebo opraví ověření V1–V6 níže. Kdo na
skutečném tenantu narazí na jiné chování, opraví tenhle runbook PR podle
[živého standardu](../external-app-integrations.md#živý-standard-zpětná-vazba-z-instalací-je-povinná).
Stránku pro IT oddělení firmy drží [microsoft-365-for-it.md](microsoft-365-for-it.md).

## Model

- **Jedna aplikace na Organizaci.** Organizace má ve svém vlastním tenantu
  Microsoftu právě jednu aplikaci Entra „Lazurio (<Organizace>)“: jen pro účty
  tohoto tenantu (`AzureADMyOrg`), jen delegovaná oprávnění Microsoft Graph.
  Žádná aplikační (app-only) ani správcovská oprávnění.
- **Založí ji IT firmy samo** ve svém prohlížeči (Microsoft Entra admin center,
  nebo Azure Cloud Shell s připravenými příkazy) a předá zpět jen id tenantu a
  id aplikace. Agent v Environmentu jen ověřuje a správcovské přihlášení
  nikdy nedrží. Postup, kdy `az` spustí agent v Environmentu, je až poslední
  možnost s povinným odhlášením (krok 5).
- **Jeden souhlas za celou firmu.** Správce tenantu jednou udělí souhlas
  jménem organizace; nikdo další souhlas nedává. Výchozí politika Microsoftu
  („Let Microsoft manage your consent settings“) lidem souhlas s poštou,
  kalendářem, soubory ani weby stejně nedovolí.
- **Veřejný klient bez tajného klíče.** Aplikace přihlašuje přes PKCE a žádný
  klientský tajný klíč ani certifikát nemá. Návratové adresy (typ *Mobile and
  desktop applications*, tedy `publicClient.redirectUris`) jsou:
  - adresa Launchpadu každého pracovního Environmentu Organizace,
    `https://launchpad.<machine>.<github-org-login>.lazurio.io/api/integrations/oauth/callback`,
    pro přihlášení ve vlastním prohlížeči člověka;
  - `http://localhost/api/oauth/callback`, návrat Executoru pro přihlášení
    v prohlížeči Environmentu. U `localhost` Microsoft port nebere v úvahu,
    cesta se ale shodovat musí, proto se registruje celá cesta.
- **Přijaté kompromisy veřejného klienta** (dodatek 0162 bod 3): bez klíče
  může útočník spustit vlastní přihlášení s id aplikace a návratem na
  `localhost` a vylákat z člověka adresu s kódem; protože souhlas za firmu už
  platí, Microsoft se na nic neptá. Frekvence přihlášení z podmíněného
  přístupu se u veřejného klienta neodkládá. Změna hesla může zneplatnit
  obnovovací tokeny získané přihlášením heslem, ty z přihlášení bez hesla
  ale platí dál; spolehlivé ukončení je zablokování účtu nebo odvolání
  relací. Firmám proto doporučujeme „Assignment required“ a skupinu lidí,
  kteří se smějí připojit (krok 3).
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
  nemá. Organizace ho zapíná vědomě, jako samostatné rozšíření oprávnění se
  souhlasem správce.
- **Teams přijde ve druhé fázi**, pro čtení a koncepty.

**Dnes versus cíl.** Použití nastavení v Environmentech, karta Připojit pro
firemní aplikace a odpojení při předání Environmentu v LazurioPlatform
i nastavení Microsoftu 365 v Dashboardu teprve vznikají (plán DEV-6626).
Do té doby připojení dělá agent na výslovný pokyn člověka přechodnou cestou
ze sekce [Přechodně: Executor ručně](#přechodně-executor-ručně). Nastavení
`microsoft365` Organizace do manifestu nezapisuje, dokud nevyjdou čtenáři,
kteří ho znají (sekce [Readers first](../lazurio-manifest-family.md#readers-first)):
starší čtenář by celou sekci `settings` odmítl, včetně přepínače Composia.

## Co oprávnění dovolují

Všechna oprávnění jsou delegovaná: skutečný přístup je průnik oprávnění
aplikace a práv přihlášeného člověka. Správcovské role člověka k nim nic
nepřidávají.

| Aplikace | Oprávnění | Co tím agent smí | Volitelně později |
| --- | --- | --- | --- |
| přihlášení | `openid`, `profile`, `email`, `offline_access`, `User.Read` | přečíst vlastní profil, obnovovat přihlášení | — |
| Outlook pošta | `Mail.ReadWrite` | číst, třídit, přesouvat a **mazat** poštu, vytvářet koncepty; odeslat ne | `Mail.Send` |
| Outlook kalendář | `Calendars.ReadWrite` | číst, zakládat, měnit a **rušit schůzky**; to odešle pozvánky a zrušení účastníkům | — |
| OneDrive a knihovny SharePointu | `Files.ReadWrite.All` | číst, nahrávat, měnit a **mazat** soubory, vytvářet **odkazy ke sdílení** a zvát lidi | — |
| SharePoint weby | `Sites.Read.All` | najít weby, jejich knihovny a seznamy | `Sites.ReadWrite.All`; delegované `Sites.Selected` |
| Teams chaty (fáze 2) | `Chat.ReadWrite` | | `ChatMessage.Send` |
| Teams kanály (fáze 2) | `Channel.ReadBasic.All`, `ChannelMessage.Read.All` | | `ChannelMessage.Send` |

Co agent přečte, odchází jako součást práce k poskytovateli AI modelu, se
kterým Environment pracuje. Zápisy a mazání drží procesní pravidlo Draft a
Publikace ([standard](../external-app-integrations.md#draft-a-publikace-ve-write-operacích))
a schválení v Executoru, ne rozsah oprávnění. Specifikace se nezužují.

Nikdy nežádej aplikační oprávnění, adresářová ani správcovská oprávnění,
`MailboxSettings.ReadWrite` (které kurátorovaná specifikace pošty uvádí) ani
oprávnění ke sdíleným schránkám (`.Shared`), dokud sdílená schránka není
pojmenovaná potřeba.

## Postup IT firmy (výchozí)

Agent IT předá tuto stránku a [stránku pro IT](microsoft-365-for-it.md),
připraví seznam adres Launchpadů a čeká na výsledek. Do Environmentu se
správcovským účtem nikdo nepřihlašuje.

**Role.** Aplikaci smí zaregistrovat každý uživatel, pokud to tenant
nezakázal; jinak role Application Developer nebo vyšší. Souhlas jménem
organizace s delegovanými oprávněními Graphu udělí **Cloud Application
Administrator** nebo **Application Administrator** (tlačítko v admin centru
i adresa souhlasu níže); Global Administrator je potřeba jen pro příkaz
`az ad app permission admin-consent`.

### 1. Registrace v Microsoft Entra admin center

V `https://entra.microsoft.com` ve vlastním prohlížeči:

1. **Applications → App registrations → New registration.** Jméno
   „Lazurio (<Organizace>)“, *Supported account types*: „Accounts in this
   organizational directory only“. *Redirect URI*: platforma **Public
   client/native (mobile & desktop)** a první adresa Launchpadu.
2. **Authentication:** u *Mobile and desktop applications* doplnit další
   adresy Launchpadů a `http://localhost/api/oauth/callback`. *Allow public
   client flows* nechat vypnuté (týká se jen toků bez návratové adresy).
   Platformu *Web* ani *Single-page application* nepřidávat.
3. **API permissions → Add a permission → Microsoft Graph → Delegated
   permissions:** `openid`, `profile`, `email`, `offline_access`,
   `User.Read`, `Mail.ReadWrite`, `Calendars.ReadWrite`,
   `Files.ReadWrite.All`, `Sites.Read.All`. Pak **Grant admin consent for
   <tenant>**.
4. **Certificates & secrets:** nic nepřidávat.
5. **Overview:** zkopírovat *Application (client) ID* a *Directory (tenant)
   ID* a předat je agentovi. Nejsou tajné.

### 2. Totéž přes Azure Cloud Shell

Kde má firma předplatné Azure, správce může v `https://shell.azure.com`
(Bash) ve svém prohlížeči vložit příkazy, které agent připraví s doplněnými
adresami:

```sh
APP=$(az ad app create \
  --display-name 'Lazurio (<Organizace>)' \
  --sign-in-audience AzureADMyOrg \
  --public-client-redirect-uris 'http://localhost/api/oauth/callback' '<adresa Launchpadu 1>/api/integrations/oauth/callback' \
  --query appId -o tsv)
GRAPH=00000003-0000-0000-c000-000000000000
for SCOPE in openid profile email offline_access User.Read Mail.ReadWrite Calendars.ReadWrite Files.ReadWrite.All Sites.Read.All; do
  ID=$(az ad sp show --id "$GRAPH" --query "oauth2PermissionScopes[?value=='$SCOPE'].id | [0]" -o tsv)
  az ad app permission add --id "$APP" --api "$GRAPH" --api-permissions "$ID=Scope"
done
az ad sp create --id "$APP" > /dev/null
az ad app show --id "$APP" --query '{client:appId,audience:signInAudience,publicClient:publicClient.redirectUris,web:web.redirectUris,secrets:length(passwordCredentials),certs:length(keyCredentials)}'
az account show --query tenantId -o tsv
```

Souhlas pak udělí tlačítkem *Grant admin consent* v admin centru, nebo
adresou (otevřít ve vlastním prohlížeči; po potvrzení prohlížeč ukáže chybu
spojení na `localhost`, to nevadí):

```text
https://login.microsoftonline.com/<TENANT>/v2.0/adminconsent?client_id=<APP>&scope=https%3A%2F%2Fgraph.microsoft.com%2F.default&redirect_uri=http%3A%2F%2Flocalhost%2Fapi%2Foauth%2Fcallback&state=<náhodný řetězec>
```

### 3. Kdo se smí připojit (doporučeno pro firmy)

V **Enterprise applications → Lazurio (<Organizace>) → Properties** zapnout
*Assignment required* a v *Users and groups* přiřadit skupinu lidí, kteří se
smějí připojit. Kdo ve skupině není, přihlášení nedokončí. Global
Administratory to podle Microsoftu neomezuje.

### 4. Ověření agentem (jen čtení)

Agent zkontroluje, že id jsou GUID, a od správce si vyžádá výstup kontroly
(admin center *Authentication*, *API permissions* se stavem *Granted*, nebo
výstup posledních příkazů Cloud Shellu): `AzureADMyOrg`, přesně zadané adresy,
žádná platforma *Web*, nula tajných klíčů a certifikátů, souhlas pro všech
devět oprávnění. Skutečný důkaz je až první připojení (V1 až V3).

### 5. Poslední možnost: `az` v Environmentu

Jen když IT nemůže použít admin center ani Cloud Shell. Agent spustí stejné
příkazy jako v kroku 2 v Environmentu po
`az login --tenant <doména-firmy> --allow-no-subscriptions --use-device-code`:

- Přihlášení kódem zařízení výchozí bezpečnostní nastavení nových tenantů
  (security defaults) blokuje a vypadá jako phishing; agent předem vysvětlí,
  odkud kód je, a kód předá jen do soukromého chatu.
- Správce se nikdy nepřihlašuje do prohlížeče Environmentu. Kdyby to nešlo
  jinak, hned potom se odhlásí a agent smaže cookies toho prohlížeče.
- **Povinný poslední krok:** `az logout; az account clear`, potom
  `az account list` vrátí `[]` a v `~/.azure` nezůstane cache tokenů
  (`msal_token_cache.*` chybí nebo je prázdná). Bez toho krok není hotový:
  agenti v Environmentu mají plný přístup a dosáhli by na správcovské
  přihlášení.
- Přístupové tokeny `az` nikdy nevypisuj (`az account get-access-token` se
  nepoužívá).

### 6. Nastavení Organizace

Po vydání čtenářů agent navrhne PR do kořenového repozitáře Organizace
s `settings.integrations.microsoft365` (`tenant_id`, `client_id`, `apps`,
`callbacks`) a PR mergne člověk, který na to má práva na GitHubu.
Schválení v Dashboardu přijde s jeho editorem. `callbacks` obsahuje přesně
zaregistrované adresy Launchpadů, bez `localhost`.

### 7. Nový Environment

IT doplní adresu jeho Launchpadu v *Authentication* (nebo
`az ad app update --id <APP> --public-client-redirect-uris <všechny adresy>`,
příkaz seznam nahrazuje) a stejná změna `callbacks` jde PR. Do té doby se
lidé z nového Environmentu přihlašují v prohlížeči Environmentu. Aplikace
unese nejvýš 256 návratových adres, jednu bere `localhost`, takže `callbacks`
má nejvýš 255 položek; zástupné znaky (wildcard) se nepoužívají. Do
`callbacks` patří jen adresy hostovaných Launchpadů
`launchpad.<machine>.<github-org-login>.lazurio.io`; jinou adresu nastavení
odmítne, protože by na ni Microsoft poslal autorizační odpověď.

## Podmíněný přístup

- Přihlášení se vyhodnocuje na adrese člověka (jeho prohlížeč), obnova tokenu
  a volání Graphu na odchozí adrese Environmentu. IT proto potřebuje odchozí
  adresy Environmentů Organizace, pokud má zásady podle lokality.
- Zásady vyžadující spravované nebo vyhovující zařízení zablokují přihlášení
  v prohlížeči Environmentu (`AADSTS53000`); přihlášení ve vlastním prohlížeči
  na spravovaném zařízení projde, obnova z Environmentu ale může narazit.
- Frekvence přihlášení (sign-in frequency) připojení po uplynutí ukončí
  (`AADSTS70043`); veřejný klient nedostává odklad. Člověk se pak připojí
  znovu. Změna hesla připojení ukončí jen u tokenu z přihlášení heslem.
- Executor neumí Continuous Access Evaluation, takže zablokování účtu se
  projeví až po vypršení přístupového tokenu.

## Přechodně: Executor ručně

Cílově tohle dělá Launchpad podle nastavení Organizace. Přechodně to agent
dělá na výslovný pokyn člověka přes rozhraní Executoru 1.6.10 na
`http://127.0.0.1:4789/api` s tokenem z `~/.executor/server-control/auth.json`
(popis rozhraní drží `docs/integrations.md` v LazurioPlatform). Token se nikdy
nevypisuje ani nekopíruje; volání jdou bez proxy (`curl --noproxy '*'`).

**Přechodné slugy `pilot-m365-*`.** První vydání LazurioPlatform s firemní
aplikací převezme jmenný prostor `m365-*` a připojení, která v něm nezná,
odebere. Ručně založené integrace proto nesou předponu `pilot-`; po vydání se
člověk připojí kartou v Integracích a pilotní integrace se odeberou.

**Připnuté specifikace.** Stejné soubory, jaké připíná LazurioPlatform:
kurátorovaný katalog Executoru v repozitáři `UsefulSoftwareCo/integrations`
na commitu `9b7117ce36e9b0a8ec86a51bd40fb380d861fe06`, cesta
`public/specs/microsoft-graph/<soubor>` na `raw.githubusercontent.com`.
Agent soubor stáhne a porovná SHA-256, než ho Executoru předá adresou.

| Slug | Soubor | SHA-256 | Oprávnění nad přihlášení |
| --- | --- | --- | --- |
| `pilot-m365-outlook-mail` | `mail.json` | `fe66b9a7ea6572077a996bc959a8617b7599369ae54f2b02f926490c4edee62a` | `Mail.ReadWrite` |
| `pilot-m365-outlook-calendar` | `calendar.json` | `7d665dbb02ce07b8a2fd1e13880f2538e807e078a613fecb80e975357b8cea31` | `Calendars.ReadWrite` |
| `pilot-m365-onedrive` | `files.json` | `0e9364c576e5ae336fd14b82b23401dc1ecde2daf53ac6ded2574069707e504a` | `Files.ReadWrite.All` |
| `pilot-m365-sharepoint` | `sites.json` | `3f0400cd5bdee8f826d28d3d310309382f611d3af6a5dd4961be39563e116394` | `Sites.Read.All` |

Přihlášení znamená `openid profile email offline_access User.Read`.
SharePoint potřebuje i `pilot-m365-onedrive`: procházení knihoven jde přes
operace nad položkami disku, které specifikace webů nemá.

1. **Specifikace:** `POST /api/openapi/specs` s `{spec: {kind: "url", url:
   "<připnutá adresa>"}, slug, name, authenticationTemplate: [{slug:
   "microsoft365", kind: "oauth2", label: "Microsoft 365", authorizationUrl:
   "https://login.microsoftonline.com/<TENANT>/oauth2/v2.0/authorize",
   tokenUrl: "https://login.microsoftonline.com/<TENANT>/oauth2/v2.0/token",
   resource: null, scopes: [...]}]}`.
2. **Klient:** `POST /api/oauth/clients` s `{owner: "org", slug:
   "microsoft365", authorizationUrl, tokenUrl, grant: "authorization_code",
   clientId: "<APP>", clientSecret: "", resource: null}`. Prázdný
   `clientSecret` dělá z klienta veřejného klienta s PKCE.
3. **Připojení ve vlastním prohlížeči:** `POST /api/oauth/start` s
   `{client: "microsoft365", clientOwner: "org", owner: "org", name:
   "default", integration: "<slug>", template: "microsoft365", newConnection:
   true, redirectUri: "<adresa Launchpadu>/api/integrations/oauth/callback"}`.
   Člověk otevře `authorizationUrl` ve svém prohlížeči a přihlásí se.
   Launchpad bez karty Připojit tento návrat nezná, odpoví stránkou s chybou
   400 a kód nespotřebuje. Člověk agentovi předá adresu té stránky; agent ji
   hned předá Executoru jako `GET http://localhost:4789/api/oauth/callback?<tentýž dotaz>`.
   Executor najde tok podle `state` a kód vymění s uloženou návratovou adresou
   a PKCE ověřovačem, bez klíče. Kód je jednorázový, platí minuty a bez
   ověřovače, který zůstává v Executoru, je k ničemu; agent ho nikam jinam
   nepíše.
4. **Jen pro účty bez správcovské role** jde i kratší cesta: `oauth/start`
   bez `redirectUri` vrátí přihlášení na `localhost` Executoru a člověk ho
   dokončí v prohlížeči Environmentu.
5. **Kontrola:** `GET /api/oauth/await/<state>`, pak `GET /api/connections`:
   `lastHealth.status` `healthy` nebo `unknown`, `identityLabel` s pracovním
   účtem, `expiresAt` vyplněné.

Executor zápisy pozastaví ke schválení (`waiting_for_interaction`); výslovný
pokyn člověka k připojení je schválením připojení, zápisy navenek schvaluje
jen pro schválený Draft nebo Publikaci.

**Práce agentů.** Agenti operace hledají `executor tools search` a volají
přes Executor. Specifikace nemají adresování cestou (`root:/cesta:`), proto
se složky procházejí podle id položky (`/drives/{id}/items/{id}/children`)
a před tvrzením, že je složka prázdná, se přečte i `@odata.nextLink`.
Koncept zprávy vzniká `POST /me/messages` s `body.contentType: "Text"`,
odpověď `createReply` a následným `PATCH` těla; agent koncept přečte zpět a
dá člověku jeho `webLink`. `send` ani `sendMail` agent nevolá.

## Ověření na skutečném tenantu

Pořadí je důležité: V1 rozhoduje mezi veřejným a důvěrným klientem.

- **V1 Veřejný klient s návratem na HTTPS bez klíče.** Tok spuštěný
  s `redirectUri` adresy Launchpadu (Přechodně, bod 3) se vymění za tokeny bez
  tajného klíče (žádné `AADSTS7000218` ani `AADSTS700025`). Obnova: přístupové
  tokeny žijí 60 až 90 minut, proto se obnova ověří až po vypršení
  `expiresAt` připojení (nebo nejdřív za 100 minut) dalším voláním a novým,
  pozdějším `expiresAt` bez nového přihlášení.
- **V2 Executor 1.6.10 celou cestou:** specifikace s šablonou tenantu,
  klient s prázdným klíčem, vyplněné `identityLabel`, obnova po vypršení,
  žádná chybějící oprávnění.
- **V3 Skutečná práce, nejdřív jen čtení:** najít web SharePointu podle
  adresy (`/sites/<host>:/sites/<cesta>`; když Executor zakóduje `/`, pak
  `GET /sites?search=<název>`), projít jednu složku podle id i se stránkováním,
  vytvořit textový koncept sobě, přečíst ho zpět s `webLink`.
- **V4 Politiky tenantu:** role správce, politika souhlasů, podmíněný přístup
  (od IT), jedno přihlášení i volání Graphu z adresy Environmentu.
- **V5 Odvolání:** „Assignment required“ a odebrání testovacího člověka ze
  skupiny zastaví obnovu tokenu (**neověřeno**); `revokeSignInSessions`
  udělá z připojení v Executoru `expired`.
- **V6 Záložní cesty:** přihlášení v prohlížeči Environmentu pro Environment,
  jehož adresa není zaregistrovaná; kdy je potřeba krok 5.

Výsledky se zapisují bez tajemství: id tenantu a aplikace, kód chyby, stav
připojení. Žádné tokeny, kódy z přihlášení ani obsah pošty.

## Odvolání a odchod člověka

- **Skutečný vypínač je v Entra.** Odebrání aplikace nebo nastavení
  `microsoft365` v Lazuriu existující připojení neodpojí; přestane jen
  nabízet nová. Celou firmu zastaví zakázání podnikové aplikace (*Enabled
  for users to sign in: No*), odebrání souhlasu nebo smazání aplikace.
- **Člověk odpojí** Integraci v Apps → Integrace („⋯“ → Odpojit), což smaže
  připojení v Executoru. U Microsoftu souhlas ruší v My Apps
  (`https://myapplications.microsoft.com`).
- **Odchod člověka:** IT zablokuje účet nebo odvolá jeho přihlášení
  (`revokeSignInSessions`). Obnova pak selže a Executor připojení označí
  `expired`; už vydaný přístupový token platí dál, takže přístup skončí až
  asi do 90 minut.
- **Předání nebo zrušení Environmentu** jeho připojení Microsoftu odpojí, jinak
  by další člověk v Environmentu jednal pod účtem předchozího (cílově
  Launchpad; přechodně agent na pokyn Admina).
- Obnovovací token platí 90 dní od posledního použití; po 90 dnech bez
  použití se člověk připojí znovu.

## Tokeny v klidu

Executor drží tokeny připojení v `~/.executor` jako nešifrovaný soubor
čitelný jen uživatelem Environmentu (`0600`), stejně jako přihlášení `gh`
nebo Codexu. Číst ho mohou všichni agenti v Environmentu (rozhodnutí 0172),
root hostitele Organizace a každý, kdo má zálohu Environmentu. Šifrované
úložiště přinese Executor 2.

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
