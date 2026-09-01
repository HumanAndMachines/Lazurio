# GitHub Issues pro Agenty

GitHub Issues jsou kanonický domov otevřených technických problémů, vad a
nejistot v Lazurio source. Issue žije v repozitáři, který problém přirozeně
vlastní; GitHub tak současně drží viditelnost, přístup, historii i stav
`open`/`closed`. Nevzniká paralelní JSON ledger ani synchronizace.

Mission Control zůstává autoritou plánu, stavu práce a odpovědnosti. Issue
popisuje problém, ale sama není pracovní plán. Trvalé rozhodnutí dál patří do
decision recordu a znalost do Knowledgebase.

## Vyber přesný owning repo

| Nález | GitHub Issue patří do |
| --- | --- |
| Lazurio installer, CLI, Launchpad, Guide nebo sdílený manuál | `HumanAndMachines/Lazurio` |
| Organization root kontrakt nebo org-wide proces | privátní root repo dané Organizace |
| Jedna aplikace nebo Modul | přesný repo Modulu |
| Plán, priorita, assignee nebo stav realizace | Mission Control, ne Issue tracker |
| Personalspace, secrets nebo neveřejný obsah bez bezpečného owning repa | nepublikovat; předat sanitizovaný draft Principálovi |

Nikdy neposílej Organization-specific obsah do veřejného Lazurio repa jen
proto, že se problém projevil během instalace. Do upstream issue patří pouze
obecná, anonymizovaná reprodukce frameworkového problému.

## Instalační report

Před vytvořením issue Agent:

1. read-only ověří přesný scope, source commit/verzi a reprodukci;
2. vyhledá existující otevřený i zavřený issue podle stabilního reason kódu a
   stručného symptomu;
3. odstraní secrets, tokeny, device kódy, credential URL, zákaznická data,
   Personalspace, lokální uživatelská jména a zbytečné absolutní cesty;
4. vytvoří nový issue, nebo k přesně shodnému issue přidá novou evidence;
5. vrátí URL v instalačním handoffu a dál bez pověření issue nezavírá,
   nepřiřazuje ani nemění jeho priority.

Pro Lazurio použij issue template
`.github/ISSUE_TEMPLATE/installation-report.md`. Strojově bezpečný postup je:

```sh
gh issue list --repo HumanAndMachines/Lazurio --state all \
  --search "<stable reason code nebo stručný symptom>" --limit 50
gh issue create --repo HumanAndMachines/Lazurio \
  --title "<stručný reprodukovatelný problém>" \
  --body-file "<absolutní cesta k sanitizovanému dočasnému draftu>"
```

Issue body má obsahovat problém, prostředí bez osobních údajů, přesnou
reprodukci, skutečný a očekávaný výsledek, bezpečný workaround a rozhodnutelná
acceptance criteria. Screenshot přilož jen tehdy, když byl vizuálně
zkontrolovaný a neobsahuje citlivý obsah.

Vytvoření issue nebo komentáře je Publikace. Instalační prompt musí obsahovat
explicitní mandát pro přesný owning repo. Doporučená věta:

> Pokud během instalace reprodukuješ obecný Lazurio problém, máš svolení po
> kontrole duplicit a sanitizaci vytvořit nebo doplnit GitHub Issue v
> `HumanAndMachines/Lazurio` a uvést jeho URL v handoffu. Nezveřejňuj secrets,
> Personalspace ani Organization-specific data a issue nezavírej ani
> nepřiřazuj.

Když Issues nejsou povolené, GitHub účet nemá potřebné právo, síť je
nedostupná nebo public-safety není jistá, Agent nic neobchází a nezapisuje
fallback do jiné Organizace. Vrátí Principálovi hotový sanitizovaný body draft,
exact cílový repo a důvod, proč jej nezveřejnil.

## Migrace starých JSON ledgerů

`ISSUES.open.json` a `ISSUES.resolved.json` jsou pouze legacy migrační vstup;
nové záznamy do nich nevznikají. Každý dosud otevřený záznam se jednorázově
ztotožní s novým nebo existujícím GitHub Issue v přirozeném owning repu a
uloží se jeho URL. Po úplném readbacku se legacy soubory odstraní reviewovaným
PR; jejich auditní historie zůstane v Gitu.

Resolved JSON historii není potřeba kopírovat do nových, uměle zavřených
issues. Git historie ji zachová. Nezaváděj webhook, obousměrný sync, shadow
databázi ani lokální číselnou řadu issues.
