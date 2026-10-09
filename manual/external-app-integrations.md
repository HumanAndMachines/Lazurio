# Napojení na externí aplikace: lokální MCP a CLI standard

Tento manuál je kanonický standard Lazurio pro připojování
Task Agentů a Kolegů na externí aplikace (Gmail, Slack, Jira, Canva…).
Definuje závazné defaultní chování, žebříček výběru integrace, kde žijí
definice a kde přihlašovací artefakty. Harness-specifické detaily drží
[codex-manual-mcp-integrations.md](codex-manual-mcp-integrations.md) pro
Codex; per-provider postupy drží runbooky v [integrations/](integrations/).

## Závazné pravidlo

Napojení Organizace na externí aplikaci se dělá **primárně lokálně
definovaným MCP serverem nebo CLI nástrojem na konkrétní mašině**.

- **Nové napojení nikdy nezřizuj** přes ChatGPT pluginy/konektory ani
  claude.ai konektory. Jsou vázané na cloudový účet a sdílejí se přes
  všechny mašiny přihlášené tím účtem — přesný opak per-machine custody.
- **Už nainstalovaný konektor se používat smí.** Když na účtu/mašině
  funkční konektor existuje, agent s ním normálně pracuje — je to ale
  dočasný, ne cílový stav: preferovaná cesta je MCP/CLI z katalogu a při
  příležitosti navrhni Operátorovi řízený přechod (postup v sekci
  „Přechod ze sdíleného integračního brokeru" Codex runbooku platí
  obdobně).
- **Nikdy** přes sdílený cloudový integrační broker — tedy jakoukoli službu
  nebo hostovaný agregátorový MCP, kde OAuth granty a tokeny drží třetí
  strana místo dané mašiny. **Jedinou výjimkou je Composio** za podmínek
  decision 0162 a sekce [Composio jako volitelný nástroj](#composio-jako-volitelný-nástroj):
  operátor ho na mašině povolí a přihlásí svůj účet přes prohlížeč; žádný
  projekt ani klíč Composia se na mašinu nezakládá a nekopíruje.
- **Executor brokerem není.** Běží v každém Environmentu jako jeho služba
  a tokeny MCP serverů drží v Environmentu (decision 0162, dodatek
  z 2026-10-09; runbook [integrations/executor.md](integrations/executor.md)).
- Vzdálený MCP endpoint provozovaný **přímo poskytovatelem služby**
  (například Slack, Atlassian, Canva, Google) je v pořádku — pokud je
  definovaný v lokálním configu harnessu na dané mašině a OAuth grant vzniká
  a je revokovatelný per mašina. Rozhoduje místo konfigurace a custody
  tokenu, ne to, kde běží proces serveru.

Motivace: přístupy a schopnosti jsou svázané s Environmentem, tedy
s mašinou a tím, co je na ní nainstalované a přihlášené. Environment zrcadlí
svého operátora (decision 0162): agenti jednají tam, kam sahají přihlášení na
té mašině. Každé přihlášení na mašině jde odhlásit samostatně. Kdo potřebuje
oddělit kontexty nebo přístupy, zakládá další Environment. Multi-org mašina
je jeden Environment; pojmenování `<org_slug>_<provider>` tam pomáhá agentovi
zvolit nástroj správné Organizace, technickou hranici mezi Organizacemi ale
netvoří. U cest, kde přihlášení patří účtu a ne mašině (Composio), platí
doporučení „účet Environmentu“ ze sekce níže.

## Žebříček výběru integrace

**Integrace a pořadí při práci (decision 0162, dodatek z 2026-10-09).**
Aplikace připojená k Environmentu je Integrace a má právě jednu cestu:
nástrojem z Nastavení → Nástroje (vždy `gh` pro GitHub, dále například
`wacli`, `gogcli`, `neon`), přímo přes Executor, nebo přes Composio. Agent
použije Integraci tam, kde je připojená, v pořadí nástroj aplikace,
Executor, Composio. Integraci nikdy nepřipojí sám, protože přihlášení je
souhlas člověka: chybí-li, pošle mu odkaz na její kartu v Apps → Integrace.
Vlastní MCP server přidá do Executoru jen na výslovný pokyn člověka. Kde
Executor ještě neběží, použije MCP servery, které má harness právě
k dispozici, a podrobnosti se dozví z MCP serveru samotného.

**Pořadí při novém napojení.** Při požadavku „napoj aplikaci X" postupuj
v tomto pořadí a první funkční úroveň vyhrává; poslední slovo má operátor
Environmentu:

1. **Oficiální MCP server poskytovatele** — remote endpoint nebo oficiální
   self-hosted server, přidaný do Executoru Environmentu (záložka MCP
   servery, nebo agent na pokyn operátora podle
   [integrations/executor.md](integrations/executor.md)). Kde Executor ještě
   neběží, přidá ho agent do harnessu podle sekcí o aktivaci níže.
2. **Oficiální CLI poskytovatele** (`gh`, `acli`, Google Workspace CLI…) —
   pro agenty se shell přístupem rovnocenná a často jednodušší cesta;
   credentials drží CLI lokálně stejně jako MCP server.
3. **Composio** — snadná cesta s vlastním účtem člověka podle decision
   0162, když oficiální MCP ani CLI poskytovatele neexistuje nebo nevyhovuje
   a Composio je povolené: na pracovním Environmentu nastavením Organizace
   (decision 0194), na osobním Environmentu člověkem. Kurátorovaný katalog Organizace je doporučení cesty pro
   danou aplikaci; poslední slovo má operátor Environmentu.
4. **Reviewnutý open-source MCP server nebo CLI** — jen s ukotvenou verzí
   (release/commit pin), ověřeným publisherem a licencí; komunitní server
   není „oficiální integrace" jen proto, že obsluhuje známou službu. MCP
   server patří do Executoru Environmentu.
5. **Browser fallback** — čtení/obsluha webu agentem v browseru pod přímým
   dohledem Operátora, když MCP/CLI cesta neexistuje.

**Zakázané v každém kroku:** servery postavené na scraping/cookie-session
přístupu (reuse browser session tokenů, obcházení bot detekce) — porušují
ToS poskytovatele a riskují ban účtu Organizace; sdílené brokery jiné než
Composio podle decision 0162; kopírování klíčů a tokenů do chatu, Gitu nebo
logu; zřizování nových konektorů v cloud UI účtu.

**Když žádná MCP/CLI cesta neexistuje:** použij browser fallback, případně
existující už nainstalovaný konektor, a chybějící MCP zapiš jako issue/PR
živého standardu — nový konektor sám neinstaluj; jeho zřízení je vědomé
rozhodnutí Operátora, ne automatický fallback agenta.

## Composio jako volitelný nástroj

Decision 0162 (Matěj 2026-09-27) mění dřívější plošný zákaz a určuje, kdo
o napojení rozhoduje: **Operátor Environmentu**. Environment zrcadlí svého
operátora; agenti v něm jednají tam, kam sahají přihlášení na té mašině.

| Pravidlo | Znění |
| --- | --- |
| Kdo rozhoduje | Operátor. Napojení je volitelné a nic se centrálně nevynucuje. |
| Cesty | Každá Integrace má právě jednu cestu: nástrojem z výběru Launchpadu (`gh` je povinný, ne volitelný), přímo přes Executor (povinná služba každého Environmentu), nebo přes Composio s vlastním účtem, pokud je povolené. |
| Přihlášení Composia | Přes prohlížeč, stejně jako `gh`. API klíč se nikdy nekopíruje. Agenti používají příkazovou řádku `composio`. |
| Účet Environmentu | Připojení patří účtu a jeho Composio organizaci, ne mašině. Stejný účet a organizace na dvou mašinách znamená stejná připojení; jiný rozsah znamená jiný účet nebo organizaci. |
| Oddělení kontextů | Nový Environment, tedy nová mašina s vlastními přihlášeními. |
| Mašina s více Organizacemi | Jeden Environment. Agent volí nástroj Organizace, pro kterou pracuje, a data mezi Organizacemi nepřenáší; je to pravidlo práce, ne technická hranice. |
| Organizace | Zda se smí Composio na jejích Environmentech používat, je nastavení Organizace podle decision 0194: nová Organizace ho má vypnuté, Organizace, které ho už používají, zapnuté. Na osobním Environmentu rozhoduje člověk. Kdo chce přehled účtů, založí vlastní Composio organizaci a žádá operátory, aby se přihlašovali do ní. |
| Výchozí rozsah | Vše, co aplikace nabízí: čtení, zápis i mazání. Rozsah omezí operátor. |
| Zápisy | Schopnost zápisu není souhlas s Publikací; platí sekce o write operacích níže. |
| Návody pro agenty | Aktivovaný CLI nástroj se propíše do instrukcí a manuálů Lazurio Folderu té mašiny. Návody říkají, co je v Environmentu povoleno, ať to operátor povolil v Launchpadu nebo příkazem `lazurio`; je to jedna věc. MCP servery Environmentu drží Executor a návody uvádějí Executor před Composiem. |
| CLI-first | Lazurio se stará o Environment, tedy o nástroje v něm, a říká agentům, jak se v něm pohybovat. Codex, Claude Code, `gh`, Executor, Composio i další nástroje jsou CLI nainstalovaná a přihlášená na mašině. |
| Katalog Launchpadu | Jen nástroje s uživatelsky přívětivým přihlášením (prohlížeč, ověřovací kód, párování). Atypický nástroj napojí na zadání operátora agent. |
| Závazek údržby | Každý nástroj katalogu má popsáno, co má jeho instalace udělat. Když instalátor selže, spustí se agent, který instalaci dotáhne podle tohoto popisu. |
| Pořadí pro agenty | Nástroj aplikace, Executor, Composio. Integraci agent nikdy nepřipojí sám; pošle odkaz na její kartu v Apps → Integrace. |
| Přihlášení bez tření | Přihlášení nástroje má operátora stát co nejméně: odkaz, ověřovací kód nebo čitelný QR kód v Launchpadu, nikdy rozsypaný QR kód v terminálu. |
| Dokumentace pro operátory | Hranice a přijaté kompromisy tohoto modelu se operátorům srozumitelně vysvětlují ve veřejné dokumentaci Lazuria. |
| Data | U Composia drží tokeny aplikací a obsah volání Composio; operátor i Organizace to vědí před prvním připojením. U Executoru zůstávají tokeny v Environmentu. |

**Stav.** Sekce Nastavení Launchpadu Platformy s povinnými, doporučenými
a volitelnými nástroji, jejich zapnutím a propsáním do Folderu je vydaná
(LazurioPlatform 0.1.8). Pilot DEV-6626 tím skončil: Composio je aktivní
součást Lazuria na každém Environmentu, kde ho operátor zapne a přihlásí
v Nastavení → Nástroje (Matěj 2026-10-02). Kde zapnuté není, agent ho sám
nezřizuje ani jinou Integraci nepřipojuje; pošle člověku odkaz na kartu
v Apps → Integrace, nebo použije další cesty žebříčku. Executor 1 zatím
běží v pilotu na jednom pracovním Environmentu; stránka Integrace, katalog,
nastavení Organizace a firemní aplikace Google a Microsoftu teprve vznikají
(plány DEV-6626 a DEV-6653). Modely a otevřené otázky drží
[integrations/composio.md](integrations/composio.md)
a [integrations/executor.md](integrations/executor.md).

## Kde co žije

| Vrstva | Místo | V Gitu |
| --- | --- | --- |
| Pravidlo chování agentů | root `AGENTS.md`, tento manuál | ano |
| Kurátorovaný katalog Organizace | `organizations/<org>/INTEGRATIONS.md` + `organizations/<org>/.mcp.json` + `organizations/<org>/.codex/config.toml` | ano (org repo, bez secretů) |
| Osobní integrace Operátora | user-level config harnessu (`~/.codex/config.toml`, user scope Claude Code) | ne |
| Přímé Integrace a vlastní MCP servery | Executor v Environmentu (`~/.executor`): definice, připojení i tokeny | ne |
| Nastavení Integrací pro celou Organizaci | sekce manifestu Organizace v jejím repozitáři (decision 0194), tajemství v trezoru Organizace | ano (bez tajemství) |
| Per-machine aktivace | env soubor v custody cestě, OAuth consent, token cache | ne (gitignored/lokální) |
| Secrets | custody dle [security/local-secret-custody.md](security/local-secret-custody.md) | nikdy |

### Kurátorovaný katalog Organizace

Katalog je trackovaný v repu Organizace a říká, **co Organizace doporučuje
a sdílí**: které integrace používá, jakou cestou a s jakou definicí. Není to
povolovací brána pro Environment operátora. Operátor smí svůj Environment
napojit i na to, co v katalogu není (decision 0162); takové napojení zůstává
jeho a do katalogu se dostane jen běžným PR, když ho má sdílet celá
Organizace. Katalog obsahuje:

- `INTEGRATIONS.md` — lidský katalog: schválené integrace, owner, scope,
  jména env proměnných, org-side admin kroky, datum schválení.
- `.mcp.json` — strojová definice pro Claude Code (project scope). Smí
  obsahovat jen příkazy, URL, argumenty a **jména** env proměnných přes
  `${VAR}` expanzi — nikdy hodnoty.
- `.codex/config.toml` — totéž pro Codex (načítá se jen v trusted projektu);
  `env_vars` nese jen jména proměnných.

Přidání nebo změna integrace v katalogu = PR ze worktree ke Stewardovi.
Tím je kurátorovaný obsah katalogu vynucený procesně; vlastní napojení
operátora na jeho Environmentu tímto procesem neprochází.

Pojmenování: server `<org_slug>_<provider>` (např. `example_organization_slack`),
env proměnné `<ORG_SLUG>_<PROVIDER>_<PURPOSE>` (např.
`EXAMPLE_ORGANIZATION_GOOGLE_CLIENT_SECRET_PATH`). Jeden provider = jeden server;
Google Workspace pokrývá Gmail/Drive/Docs/Sheets/Slides jedním serverem.

### Per-machine aktivace

Definice z katalogu se na mašině stává funkční až lokální aktivací:

1. Env proměnné pro danou Organizaci drž v machine-local env souboru v
   custody cestě, například
   `organizations/<org>/company/colleagues/<os-user>/private/secrets/env/integrations.env`
   (mód `0600`); launcher nebo shell profil ho načítá před startem harnessu.
2. OAuth consent dokončuje **Operátor v prohlížeči na té mašině** — agent
   připraví konfiguraci a diagnostiku, ale výběr účtu a souhlas je lidský
   krok (viz Human-action boundary v custody standardu). Před consentem agent
   ukáže přesný účet, účel a seznam scopes. Souhlas s OAuth grantem zpřístupní
   schopnost mašině; není to blanketní souhlas s každou budoucí akcí agenta.
3. Scopes uděluj defaultně **read i write** pro služby, které workflow
   Organizace potřebuje. Read-only start je volitelné zpřísnění pro
   mimořádně citlivé zdroje, ne default; LinkedIn zůstává post-only výjimka
   dle svého runbooku. Primární ochranu drží stejný kontrakt jako u kódu:
   **write agenta je Draft, ne Publikace**. Mechanické gaty se liší podle
   harnessu a formy integrace — konkrétní nastavení a jejich meze drží
   sekce „Draft a Publikace ve write operacích" níže; nastav je při
   aktivaci a ověř je ve smoke testu.
4. Token cache zůstává lokální a persistentní: u HTTP OAuth ji drží
   credential store harnessu (preferovaně systémový keyring), u STDIO
   integrace vlastní credentials directory serveru v custody. Tool-runtime
   cesty (`~/.google_workspace_mcp/…`, `~/.gmail-mcp/…`) nejsou custody
   source; runbook musí umět cache z custody obnovit a bezpečně rotovat.
   Dočasná cesta, memory-only/stateless backend ani agentní „zapamatování"
   přihlášení nenahrazují. Správná aktivace přežije restart MCP procesu,
   harnessu i mašiny a krátkodobý access token obnovuje refresh tokenem;
   provider však může refresh token legitimně zneplatnit podle své policy.
5. Mezi mašinami se nikdy nepřenáší token cache, client secrety ani celé
   uživatelské configy harnessu. Každá mašina = vlastní OAuth grant,
   revokovatelný u poskytovatele samostatně.

### Aktivace v Claude Code

- Katalogové servery Organizace načte Claude Code automaticky z `.mcp.json`
  v rootu org repa, když agent pracuje v checkoutu té Organizace; první
  použití na mašině potvrzuje Operátor v approval promptu.
- **První approval serveru není per-action write gate.** Claude Code
  rozhoduje per tool přes permission pravidla `mcp__<server>__<tool>`.
  Write nástroje nikdy neschvaluj plošně („allow celý server"); zapiš je
  jmenovitě do `ask`, případně `deny`, a čtecí nástroje smíš dát do
  `allow`. Pravidla patří do settings toho scope, kterému integrace slouží
  (projektová `.claude/settings.json` Organizace, nebo user settings pro
  osobní integrace) — kontrakt harnessu ověř v jeho aktuální dokumentaci,
  názvy nástrojů vyčti z `/mcp`.
- U integrace sdílené Organizací zapiš nastavení do `INTEGRATIONS.md`
  k dané integraci, ať je reprodukovatelné a ověřitelné i na další mašině.
  U napojení, které je jen na Environmentu operátora, zůstává nastavením té
  mašiny.
- Osobní integrace přidávej do user scope
  (`claude mcp add --scope user <name> …`), ne do project scope
  Organizace.
- Konektory v claude.ai Settings → Connectors se pro org napojení
  **nepoužívají** — jsou vázané na claude.ai účet, ne na mašinu.

### Aktivace v Codexu

Postupuj podle [codex-manual-mcp-integrations.md](codex-manual-mcp-integrations.md):
`codex mcp add`, keyring OAuth store, approval mode `writes`/`prompt`,
per-machine onboarding a cutover ze sdíleného brokeru.

### CLI lane

CLI nástroje jsou pro agenty běžná cesta vedle Executoru (decision 0162)
a platí pro ně stejná pravidla custody. Rozlišuj dvě situace: integraci, kterou má **sdílet
celá Organizace**, zapiš do jejího `INTEGRATIONS.md`; nástroj, který si
operátor povolil jen **na svém Environmentu**, se do katalogu Organizace
nezapisuje a jeho aktivace se propisuje do návodů Lazurio Folderu té mašiny.
Příklady:

- `gh` — GitHub (kanonický vzor),
- Google Workspace: oficiální [googleworkspace/cli](https://github.com/googleworkspace/cli)
  nebo komunitní [gog](https://github.com/steipete/gogcli) s nativním
  multi-account (`--account`),
- Atlassian: oficiální [acli](https://developer.atlassian.com/cloud/acli/),
- Microsoft 365: komunitní [CLI for Microsoft 365](https://pnp.github.io/cli-microsoft365/).

Agent CLI volá přes shell dané mašiny; přihlášení (`gh auth login`,
`gog auth add …`) dokončuje Operátor. Výhoda: žádný další běžící proces,
credentials drží CLI ve vlastním lokálním úložišti, funguje ve všech
harnessech se shellem. Nevýhoda: bez typovaných tool schémat — pro
harness bez shellu použij MCP variantu.

**Pozor: MCP approval mode se na CLI nevztahuje.** Zápis provedený příkazem
v shellu není MCP tool call, takže ho `writes`/`prompt` ani permission
pravidla `mcp__…` nezachytí. Gate má tři úrovně a všechny platí:

1. **Shell permission pravidla harnessu** — write podpříkazy nikdy
   neallowlistuj plošně (`gog *`, `acli *`, `gh *`). Allowlistuj jen
   konkrétní čtecí příkazy; ostatní ať procházejí potvrzením.
2. **Draft forma výstupu** — CLI volej tak, aby výsledek byl vratný
   (draft místo odeslání, nový soubor místo přepisu, testovací cíl).
3. **Explicitní pokyn Operátora** pro každou nevratnou operaci; u CLI je
   tohle procesní pravidlo hlavní gate, ne pojistka.

## Draft a Publikace ve write operacích

Write přístup není povolení publikovat. Platí stejný kontrakt jako u kódu
(root `AGENTS.md`, decisions 0090 a 0103): **co agent v externí aplikaci
vytvoří, je Draft — revertovatelný a editovatelný Operátorem. Publikaci
dělá Operátor, nebo agent, ale jen na jeho explicitní pokyn v daném
threadu.** Právě proto je write scope defaultní: proces, ne zúžený scope,
drží hranici.

Prakticky to znamená volit vratnou formu výstupu a nechat nevratný krok
Operátorovi:

| Služba | Draft (agent smí sám) | Publikace (jen na explicitní pokyn) |
| --- | --- | --- |
| Gmail / Outlook | vytvořit draft zprávy, štítky, uspořádání | odeslat, smazat, hromadné operace |
| Slack | připravit znění, zapsat do testovacího kanálu | poslat do ostrého kanálu, DM, oznámení |
| Jira / Confluence | draft issue nebo stránky, komentář k review | přechod stavu, publikace stránky, mazání |
| Drive / Docs / Sheets | nový soubor nebo kopie k revizi, návrh úprav | přepis ostrého dokumentu, sdílení ven, mazání |
| Canva | nový design, export do drafts cesty | sdílení/zveřejnění, přepis týmového assetu |
| LinkedIn | draft příspěvku | publikace příspěvku |

Nevratné operace (odeslání, zveřejnění, mazání, přepis ostrého obsahu,
změna oprávnění) potvrzuje Operátor per akci.

### Čím je write gate vynucený — a čím ne

Mechanická vrstva se liší podle harnessu a formy integrace. Nepředpokládej
jednotný „approval mode"; při aktivaci nastav to, co daná cesta skutečně
nabízí. U integrace sdílené Organizací to zapiš k integraci do
`INTEGRATIONS.md`; u napojení, které je jen na Environmentu operátora, to
zůstává nastavením té mašiny:

| Cesta | Mechanický gate | Co gate nepokrývá |
| --- | --- | --- |
| MCP v Codexu | `default_tools_approval_mode = "writes"` / `"prompt"`, výběr `enabled_tools` | nic mimo MCP tool cally |
| MCP v Claude Code | permission pravidla per nástroj (`mcp__<server>__<tool>` v `ask`/`deny`), výběr povolených serverů | plošné „allow serveru" gate ruší |
| CLI přes shell | permission pravidla shellu daného harnessu (allowlist jen čtecích příkazů) | MCP approval mode se **neuplatní** |
| Browser fallback | přímý dohled Operátora u obrazovky | nic automatického |

**Udělený OAuth grant je schopnost mašiny, ne agenta.** Token v lokálním
úložišti může použít kterýkoli proces, který na něj dosáhne — CLI, Buddy,
skript, jiný harness. Approval mode proto **není bezpečnostní hranice vůči
ostatním procesům na mašině**; je to gate uvnitř jednoho harnessu. Skutečné
hranice udělených scopes jsou: rozsah samotného grantu, custody souborů
(`0600`/`0700`), rychlá revokace u poskytovatele a procesní pravidlo
Draft → Publikace, kterým se řídí každý agent i Buddy (Buddy navíc v rámci
svých mandátů). U scopes, jejichž zneužití by bylo nevratné a drahé
(mazání, správa oprávnění, admin operace), scope neuděluj vůbec — to je
jediná spolehlivá ochrana.

### Smoke testy: vratný cíl a úklid

Write smoke nedělej na ostrém obsahu. Použij k tomu určený jednorázový cíl
— testovací kanál, scratch složku nebo drafts cestu, sandbox projekt/space,
vlastní draft. U integrace sdílené Organizací zapiš cíl použitý pro smoke
do `INTEGRATIONS.md`, ať ho další mašina používá taky a nevzniká nepořádek
ani zbytečné notifikace v produkčních prostorech Organizace. U napojení,
které je jen na Environmentu Operátora, se do katalogu Organizace nic
nezapisuje: smoke cíl jmenovitě určí a schválí Operátor v threadu a agent
ho uvede v evidenci svého úkolu.

**Výjimka pro úklid určeného smoke artefaktu:** když Operátor výslovně
schválil tento jmenovitý smoke cíl, patří do téže schválené operace i úklid
artefaktu, který agent v tomto konkrétním smoke sám vytvořil (draft, testovací
zpráva nebo testovací záznam). Agent jej smí po ověření odstranit; nejde o
samostatnou Publikaci ani o obecné oprávnění mazat. Výjimka se nikdy netýká
existujícího, ostrého nebo cizího obsahu. Není-li cíl jmenovitě určený v
`INTEGRATIONS.md` (u integrace sdílené Organizací) nebo jmenovitě schválený
Operátorem v threadu (u napojení jen na Environmentu Operátora), původ
artefaktu není prokazatelný nebo úklid zasahuje mimo tento smoke, artefakt
ponech a vyžádej si samostatný explicitní pokyn Operátora.

**Runbooky poskytovatelů** v [integrations/](integrations/) popisují integrace
sdílené Organizací; kde říkají „zapiš do `INTEGRATIONS.md`“, platí to pro ně.
Pro napojení jen na Environmentu Operátora platí stejný postup s tím
rozdílem, že místo zápisu do katalogu stačí jmenovité schválení Operátora
v threadu.

## Org-side admin kroky

Některé služby vyžadují jednorázové povolení na straně Organizace; patří do
onboarding checklistu Organizace, ne do per-machine kroků:

| Služba | Admin krok |
| --- | --- |
| Slack | Admin workspace schvaluje MCP klienta (aplikaci) v app managementu |
| Atlassian | Org admin spravuje MCP přístup (allowlist klientů, API-token toggle) v Atlassian Administration |
| Canva | Admin týmu povoluje „AI Connector" v Controls and Permissions |
| Microsoft 365 | Tenant consent policy může vyžadovat admin souhlas s app registrací |
| Google Workspace | Organizace vlastní GCP projekt s OAuth clientem; admin řídí povolená API a scopes |
| ESO9 | Organization owner jmenuje správce nebo implementačního partnera; ten potvrdí API variantu, provider-side oprávnění, audit a samostatnou revokaci před aktivací |

## Osobní integrace (personalspace scope)

Integrace, které nepatří žádné Organizaci (osobní Gmail, osobní kalendář…),
patří do personalspace scope: definice v user-level configu harnessu,
secrets v `personalspace/<owner>_GEN3/secrets/<provider>/<scope>/<purpose>`,
naming `personal_<provider>`. Do org katalogů se nezapisují a org agenti je
nepoužívají; personalspace izolace má přednost.

## Per-provider runbooky

| Runbook | Pokrývá |
| --- | --- |
| [integrations/google-workspace.md](integrations/google-workspace.md) | Gmail, Drive, Docs, Sheets, Slides, Meet |
| [integrations/microsoft-365.md](integrations/microsoft-365.md) | Outlook mail a kalendář, M365 |
| [integrations/slack.md](integrations/slack.md) | Slack |
| [integrations/atlassian.md](integrations/atlassian.md) | Jira, Confluence |
| [integrations/linkedin.md](integrations/linkedin.md) | LinkedIn (post-only + browser fallback) |
| [integrations/canva.md](integrations/canva.md) | Canva |
| [integrations/executor.md](integrations/executor.md) | Executor 1: přímé Integrace a vlastní MCP servery, instalace, napojení agentů a custody |
| [integrations/composio.md](integrations/composio.md) | Composio: snadná cesta Integrací přes server třetí strany, účet a zapnutí v Launchpadu |
| [integrations/eso9.md](integrations/eso9.md) | ESO9 Web API, omezený JSON API fallback a discovery-first read-only rollout |

Stav každého runbooku odpovídá datu uvedenému v jeho úvodní hlavičce; před
instalací zkontroluj aktuální dokumentaci poskytovatele.

## Živý standard: zpětná vazba z instalací je povinná

Externí aplikace a jejich MCP/CLI ekosystém se mění rychleji, než je kdokoli
schopen průběžně přetestovávat. Tenhle manuál i runbooky jsou **komunitní
standard Lazurio** a žijí z reálných instalací — nikdo je centrálně
denně neověřuje. Proto pro každého agenta platí:

1. Když se Kolega během napojování na čemkoli zasekne, nebo narazíš na
   chybu manuálu, zastaralý endpoint, změněnou verzi/scope či jiné chování
   poskytovatele, **nenech to jen v chatu**.
2. Znáš-li řešení nebo aktualizaci, oprav runbook/manuál a pošli PR na
   `HumanAndMachines/Lazurio` (platí worktree disciplína). Do PR
   popiš, co se stalo, na čem se Kolega zasekl, jak se to projevovalo a jak
   je oprava ověřená — metadata-only, žádné secrets, tokeny ani screenshoty
   s citlivým obsahem.
3. Neznáš-li řešení, připrav issue podle `manual/github-issues.md` do přesného
   owning repa a po kontrole duplicit a sanitizaci ho sám zapiš (decision
   0163); sanitizovaný draft vrať jen tehdy, když zápis není možný nebo
   public-safety není jistá. Veřejné
   `HumanAndMachines/Lazurio` smí dostat jen obecný, anonymizovaný problém
   frameworku.
4. Org-specifika (jiné admin kroky, plán, licence) patří do `INTEGRATIONS.md`
   katalogu dané Organizace; do root runbooků jde jen generalizované a
   anonymizované poučení — nikdy org data.

Oprava poslaná upstream se dostane ke všem uživatelům Lazurio;
poznatek zamčený v jedné mašině nebo jednom chatu je ztracený.

## Odebrání, rotace, incident a closeout

Platí postup z [codex-manual-mcp-integrations.md](codex-manual-mcp-integrations.md)
(sekce „Odebrání, rotace a incident") pro všechny harnessy: odhlásit a
odebrat lokální konfiguraci, revokovat grant u poskytovatele, rotovat
lokální cache, ověřit nový task. Closeout je vždy metadata-only: název
serveru, scope, owner, datum, výsledek — nikdy token, callback URL ani
obsah credential souboru.
