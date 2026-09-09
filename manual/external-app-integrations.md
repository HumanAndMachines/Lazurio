# Napojení na externí aplikace

Kanonický standard Lazuria vysvětluje záměr, odpovědnosti a ověření, ne
uzavřený seznam technologií. Využij funkční napojení, pro novou službu
preferuj Composio, pokud pokrývá potřebnou schopnost a Principál přijímá
datovou hranici. Jinak zvol přímé MCP, CLI nebo jinou vhodnou cestu podle
Mašiny a mandátu. Nevytvářej vlastní integrační vrstvu jen pro sjednocení.

## Mašina a mandát

Přístupy dostupné na Mašině považujte za potenciálně dostupné všem Agentům,
kteří na ní pracují. Přihlášené nástroje, čitelné credentials i síťová cesta
jsou součástí této technické možnosti. Mandáty, Organization hranice a
zásady dál určují, co Agent smí udělat; technickou izolaci nenahrazují.

Potřebujete-li Agenta bez určitého citlivého přístupu, použijte jinou
izolovanou Mašinu, na které tento přístup ani cesta k jeho získání není.
Jiný chat, worktree, jméno MCP nebo Unixový účet tuto izolaci samy nedokazují.
Hosted Workspace má navíc vyšší hranici host operatora popsanou v
[ARCHITECTURE.md](../ARCHITECTURE.md).

Stejný široký cloudový účet na dvou Mašinách může zpřístupnit stejné služby.
Pojmenování účtů či Organizací pomáhá orientaci, není ACL. GitHub určuje práva
na GitHubu; přístup ke Google, Composiu a ostatním službám se uděluje zvlášť.
Technická dostupnost nedává Agentovi právo číst cizí Personalspace ani míchat
Organization data.

## Záměr výběru

- Nejprve zjisti, co je už připojené a funkční. Nahrazení není důvod ztratit
  potřebnou schopnost nebo znovu přihlašovat všechny účty.
- Composio je preferovaný hotový poskytovatel pro běžné externí služby.
  Použij jeho původní UI a podporované klienty; nezačínej vlastním SDK
  produktem, forkem konektoru ani kopírováním OAuth formulářů.
- Přímé MCP v harnessu a CLI na Mašině jsou normální alternativy. Posuzuj
  schopnost a provozní náklady: správa Neon projektu neprokazuje SQL,
  seznam chatů neprokazuje úplnou historii. GitHub dál obsluhuje `gh`.
- Oficiální cesta bývá jednodušší na údržbu. U komunitní implementace ověř
  původ, licenci, verzi a způsob autentizace. Neoficiální protokol může
  přestat fungovat nebo způsobit omezení účtu; Principál musí riziko vědomě
  přijmout. To neautorizuje obcházení práv ani získávání cizích relací.
- Výslovné provider či Organization požadavky zůstávají platné; obecná
  preference není důvod přepsat je nebo rozšířit mandát.

MCP a CLI popisují způsob použití nástroje. Composio je poskytovatel,
který nabízí obojí. Výčet není nový technický zákaz jiných řešení.
Bez potřebného oprávnění zastav příslušnou operaci a vyžádej rozhodnutí.

## Kde jsou konfigurace a přístupy

| Co | Přirozený owner |
| --- | --- |
| Sdílený záměr, onboarding a runbooky | Lazurio root |
| Org-specific potřeby a admin kroky | Organization `INTEGRATIONS.md` |
| Skutečně připojené MCP | konfigurace konkrétního harnessu na Mašině |
| Instalované CLI a jeho přihlášení | nástroj na Mašině |
| Upstream accounts v Composiu | Composio účet Principála a provider |
| Lokální tajemství | [custody standard](security/local-secret-custody.md) |

Katalog není druhé IAM. Do sdíleného Gitu patří jen netajná definice a
know-how, nikdy osobní účty, tokeny, OAuth odkazy nebo cache. Osobní integrace
patří do user konfigurace a Personalspace custody. Organization specifika
nekopíruj do veřejného rootu ani jiné Organizace.

Lazurio CLI a Launchpad nemusí přenášet akce agentů. Konfiguraci prováděj
standardní cestou harnessu nebo nástroje. Budoucí přehled v Launchpad Settings
má vycházet ze skutečného nastavení, ne z druhého ručně vedeného seznamu.
Tento dokument nedodává takové UI ani nový `lazurio composio` příkaz.

## Onboarding

Součástí onboardingu pro práci s externími službami je vlastní Composio účet
Principála a připojení do používaných harnessů podle
[Composio runbooku](integrations/composio.md). Task Agent nemá vlastní
trvalou identitu. Pokud Owner cloudovou cestu nepřijímá nebo je pro konkrétní
úkol nevhodná, zdokumentuj přímou alternativu; nezačínej automaticky nákupem
enterprise plánu nebo vlastním hostováním.

Souhlas s OAuth grantem zpřístupní
schopnost mašině; není souhlasem s každou budoucí operací. Před autorizací
ověř účet, účel a skutečný požadovaný rozsah. Přihlašovací UI, MFA a obnovu
účtu ponech podporovanému flow dodavatele. Grant může obsahovat potřebné
čtení i zápis; nepřidávej preventivně nové plošné zákazy ani oprávnění
nepotřebná pro zadání.

Přihlášení v prohlížeči, Composio CLI a MCP autorizace jednotlivých harnessů
jsou různé věci. Pro Codex použij [MCP runbook](codex-manual-mcp-integrations.md);
pro Claude Code postup v [Composio runbooku](integrations/composio.md).
Přihlášený MCP server také neprokazuje přihlášení modelového klienta.

## Cloudová a lokální custody

Composio spravuje upstream credentials a provádí akce ve svém cloudu.
Lokální konfigurace MCP ani lokální Composio CLI z toho nedělá self-hosted
službu. Poskytovatel dostává data potřebná pro prováděnou operaci; tuto
důvěru, podmínky a případné náklady přijímá Principál.

U přímého HTTP MCP drží klient svoji autentizaci; samotná externí služba
nadále běží u poskytovatele. U STDIO nebo CLI může autentizaci spravovat
lokální proces. Ověř skutečnou custody, nepředpokládej ji podle transportu.
Lokální secrets mají privátní oprávnění a persistentní úložiště dle custody
standardu. Nekopíruj celé konfigurace, credentials ani session cache mezi
Mašinami nebo Principály. Samostatnou revokaci ověř podle reality provideru,
neslibuj ji pouze z existence dvou lokálních tokenů.

## Mandáty a konkrétní operace

**write agenta je Draft, ne Publikace.** V mezích zadání preferuj vratný
návrh, nový soubor nebo draft zprávy; odeslání, zveřejnění a jiné významné
externí změny vyžadují příslušný mandát Principála.

Nevratné operace (odeslání, zveřejnění, mazání, přepis ostrého obsahu,
změna oprávnění) potvrzuje Principál per akci.

Harness může nabídnout approval pravidla a výběr tools. Nejde o bezpečnostní
oddělení od jiných procesů na Mašině. MCP pravidla také nezachytí CLI volání.
U agregátoru může jediný execute meta-tool vyvolat mnoho různých upstream
akcí: allowlist tohoto nástroje neznamená argument-level nebo read-only
policy celé služby. Nezaváděj vlastní gate ani paralelní IAM; dodržuj
mandát, provider oprávnění a skutečné ochrany daného prostředí.

### Smoke testy: vratný cíl a úklid

Write smoke nedělej na ostrém obsahu. Použij k tomu určený jednorázový cíl
— testovací kanál, scratch složku nebo drafts cestu, sandbox projekt/space,
vlastní draft. Organization smoke cíl eviduj v jejím `INTEGRATIONS.md`,
pokud jej má Organizace sdílet mezi Mašinami. Osobní smoke cíl a důkaz
patří pouze do příslušného Personalspace nebo soukromého handoffu;
osobní účty, adresáty ani obsah nepřenášej do sdíleného katalogu.
Do evidence stačí metadata bezpečná pro daný scope a výsledek úklidu.

**Výjimka pro úklid určeného smoke artefaktu:** když Principál výslovně
schválil tento jmenovitý smoke cíl, patří do téže schválené operace i úklid
artefaktu, který agent v tomto konkrétním smoke sám vytvořil (draft, testovací
zpráva nebo testovací záznam). Agent jej smí po ověření odstranit; nejde o
samostatnou Publikaci ani o obecné oprávnění mazat. Výjimka se nikdy netýká
existujícího, ostrého nebo cizího obsahu. Není-li cíl jmenovitě určený v
`INTEGRATIONS.md`, původ artefaktu není prokazatelný nebo úklid zasahuje mimo
tento smoke, artefakt ponech a vyžádej si samostatný explicitní pokyn
Principála.


## Důkaz funkčnosti

Odlišuj nainstalováno, nakonfigurováno, autorizováno a funkčně ověřeno.
Pro každý skutečně používaný harness ověř nový task nebo proces, správnou
identitu a konkrétní read akci. CLI výsledek nenahrazuje MCP test.
Více účtů ověř zvlášť; account label není důkaz upstream identity.

Write prohlašuj za ověřený jen po skutečném schváleném smoke. Pokud nebyl
proveden, napiš to. Restart dokazuje lokální persistenci, ne budoucí
platnost provider tokenu. Limity historie, scopes a expirace zaznamenej
jako omezení, ne jako úspěch.

## Přímé provider runbooky

Následující runbooky popisují alternativní přímá napojení, nikoli povinnost
instalovat je vedle funkčního Composia:

- [Google Workspace](integrations/google-workspace.md)
- [Microsoft 365](integrations/microsoft-365.md)
- [Slack](integrations/slack.md)
- [Atlassian](integrations/atlassian.md)
- [LinkedIn](integrations/linkedin.md)
- [Canva](integrations/canva.md)
- [ESO9](integrations/eso9.md)
- [Osobní WhatsApp přes wacli](integrations/whatsapp-wacli.md)

Jejich konkrétní bezpečnostní a provider limity zůstávají relevantní pro
zvolenou cestu. Před použitím ověř aktuální oficiální dokumentaci.
Managed OAuth může odstranit potřebu vlastního OAuth klienta; například
GCP projekt není automatický požadavek pro každé Google napojení.

## Migrace, odebrání a poznatky

Nejdřív ověř potřebnou schopnost náhrady, potom odpoj schválenou starou cestu.
Lokální konfigurace, token cache, Composio connection a upstream grant mají
různý lifecycle. Nemaž sdílený OAuth klient ani grant, na kterém závisí jiná
funkční integrace. Smazání lokální cache samo nerevokuje token u provideru.

Při incidentu má přednost zastavení kompromitovaného přístupu u poskytovatele;
konkrétní revokaci a obnovu prováděj v mandátu Ownera. Closeout je metadata-only:
účel, scope, datum a výsledek. Žádné credentials, autorizační URL nebo obsah
osobních zpráv. I read odpověď může nést tajemství v paging URL.

Obecné poučení patří do tohoto standardu a runbooků; Organization specifika
do jejího katalogu. Technické nejistoty patří do GitHub Issues owning repa
podle [publikačního postupu](github-issues.md), ne do legacy issues JSON.
Bez publikačního mandátu připrav sanitizovaný draft.
