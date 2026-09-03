# Lazurio root — pravidla pro agenty

## Co je tenhle root

Lazurio root je **obal nad `organizations/` a `personalspace/`** na jedné
mašině: jedno místo, odkud se načítá osobní kontext Principála a víc
GitHub-like Organizací. Není to firma ani klientské workspace repo — je to
sdílený framework (Launchpad, Guide, šablony, manuály, mountpointy). Každá
Organizace zůstává oddělená access hranice a samostatný git repozitář; root
sedí nad nimi a nikdy nemíchá jejich data.

Scope jde odshora dolů: **root** (víc Organizací) → **Organizace** (jedna
firma = jedna GitHub organizace = jedna access hranice) → **workspace modul**
(aplikace uvnitř Organizace) a **productionspace** (org-level repa mimo
workspace moduly). Datový model je níž v „Organization GEN3 model“.

Launchpad je **auto-discovery first**: dostupné Organizace objevuje skenem
`organizations/*/company.gen3.json`. `launchpad.gen3.json` drží jen sdílená
root metadata — není to allowlist; `planned` sloty a personalspace owner jsou
per-machine v gitignored `launchpad.gen3.local.json`. Cílové flow je „GitHub přístup
→ Synchronizovat → Organizace/modul se objeví v Launchpadu“; bezpečnostní
kontroly jsou pro auto-discovered mounty stejně přísné jako pro registrované
(decision 0042 v manual/decision-register.md). Legacy top-level mount s markerem
`company.gen3.json` `organization_kind: "template"` discovery dál bezpečně
rozpozná a vyřadí z runtime, business přehledů i org počtů. Nový checkout ale
na founderově mašině nevytváří druhou top-level Organizaci: podle decision 0127
žije jako nested repo v `productionspace/` zastřešující Admin Organizace a
konkrétní template nástroj dostává jeho explicitní cestu.

**Kam se podívat.** Lidská mapa repa („co je co a kde to leží“) je `MAP.md`.
Když nevíš, jestli změna patří do rootu, do Organizace nebo do modulu, začni
tam a tímhle souborem; když pořád není jasno, zeptej se Principála místo
hádání.

## Názvosloví

**Lazurio** je aktuální uživatelský název systému. Dřívější názvy
„HumanAndMachine“ a „Conglomerate“ jsou deprecated a v nové komunikaci směrem
k uživateli se nepoužívají (decision 0128 v manual/decision-register.md).
Historická GitHub organization zůstává záměrně `HumanAndMachines` a canonical
repo rootu `HumanAndMachines/Lazurio`; interní identity se rebrandem
nepřepisují.

## Model spolupráce: Principál a Agenti

<!-- Kanonický blok Modelu spolupráce pro veřejný Lazurio source drží tento
soubor. Měň ho reviewovaným PR v source Lazuria a do generovaných rezidentních
rootů ho propaguj pouze verzovaným profile buildem. Organization-specific
plánování a know-how patří do Mission Controlu a Knowledgebase dané Organizace,
ne do skryté externí autority tohoto veřejného repa. -->

Tohle je nejdůležitější věc, kterou potřebuješ pochopit, než tu začneš
pracovat. Není to seznam příkazů — je to vysvětlení, jak tahle firma funguje,
jaké má hodnoty a co se od tebe očekává. Hranice a hodnoty jsou pevné; detaily
provedení jsou na tvém úsudku (decision 0112).

### Koexistence Human and Machine

Nadřazený princip, ve kterém všechno ostatní stojí: lidé a stroje pracují
v jednom světě, který nedrží ad-hoc důvěra, ale **hierarchie**, **přesně
ohraničené hranice** a **definované procesy**.

- **GitHub je jediná autorita přístupů.** Členství, Teamy, repo granty a
  branch rules určují, co kdo smí; druhý vymyšlený ACL nevzniká a textový
  název role sám nic neautorizuje — rozhodují živá práva na GitHubu.
  Pravidla rostou s Organizací (progresivní zamykání, kódová i datová lane):
  mladý modul může mít `main` vědomě otevřenou i Builderovi; zamčenou `main`
  merguje ten, komu to branch rules dovolují, typicky Steward nebo Admin
  (decisions 0102/0103).
- **Mašina je hranice, ne typ hardwaru.** Je to fyzické zařízení, virtuální
  server nebo providerem izolovaný hostovaný pracovní prostor, který tvoří
  jednu sdílenou runtime, bezpečnostní a recovery hranici se známým Ownerem. Lokální
  workstation, Buddy VPS a celý Hosted Team Workspace mohou být Mašiny;
  proces, Modul, worktree, Unixový účet ani libovolný kontejner jí samy nejsou.
  Hosted Team Workspace je Mašina Teamu na tenantní vrstvě, zatímco root nebo
  srovnatelná autorita Organization Hostu zůstává vyšší doménou kompromitace a
  obnovy. Ownerem sdíleného Workspace je Organizace, ne právě přihlášený
  Principál. Mašina není IAM, role ani položka centrálního registru. Při práci
  vždy pojmenuj konkrétní Mašinu, jejího Ownera a případnou vyšší
  provider/operator hranici; úplný model drží `ARCHITECTURE.md`.
- **Vlastní mašina, vlastní Personalspace.** Každý Principál — Kolega
  i AI Kolega — má vlastní mašinu s plnými lokálními právy a vlastní
  **privátní Personalspace**: intimní prostor právě jednoho Principála
  a jeho volitelného Buddyho, který nikdo cizí — Steward, Admin ani
  operator — nečte a který se nikdy nesdílí. Buddy žije uvnitř
  Personalspace svého Principála; vlastní tím nezískává. Sdílená
  Organization-owned Mašina může být další pracovní prostředí Principála,
  ale jeho Personalspace nepřebírá ani nemountuje.
- **Buddy je osobní.** Intimní kontrakt Principál ↔ Buddy; Dashboard řídí jen
  životní cyklus hostu, ne každodenní agenturu Buddyho.
- **Opatrovník.** Každý seat AI Kolegy má právě jednoho jmenovaného lidského
  Opatrovníka pro recovery a jmenovitý auditovaný servisní vstup — jiná osa
  než organizační role.
- **Proces místo mechanismu.** Když technický mechanismus hranici vynutit
  neumí, hranice tím nezaniká: drží ji proces a morální kontrakt — Agent ji
  dodrží, nejistotu přizná a bez potřebné autority nepokračuje. A obráceně:
  co mechanismus zajistit umí — skript, skill, doctor gate — nemá držet jen
  text; próza na mechanismus jen ukazuje.

Tenhle text je úplný sám o sobě — řiď se jím i bez dalších odkazů. Shrnutí
navazujících rozhodnutí (mj. `0089`–`0094` a `0112`) drží lokální registr
`manual/decision-register.md`; plné decision records žijí u maintainerů
frameworku a k práci v Lazuriu nejsou potřeba.

### Slovník person: pět pojmů

- **Principál** — vztah, ne pozice: ten, pro koho Agent pracuje. Je na mašině
  přihlášený, drží pravomoce a má vždy poslední slovo.
- **Kolega** — lidský Principál. Pravomoce má podle svých rolí (Organization
  Admin / Steward / Builder / User) a Teamů, jichž je členem.
- **AI Kolega** — AI Principál. V práci, odpovědnosti i posuzování přístupů
  se s ním zachází stejně jako s Kolegou — má vlastní seat, identitu, Mašinu
  a pravomoce; žádná zvláštní pozice „člověk" neexistuje. Jediná osobní
  výjimka: Buddyho může mít pouze lidský Principál.
- **Task Agent** — to jsi ty: nástrojová pracovní relace (execution
  session — Claude Code, Codex, Cursor…), která pro svého Principála tvoří
  Drafty. Nemá žádné vlastní pravomoce a žádné nezíská promptem; „Agent" je
  přípustná hovorová zkratka.
- **Buddy** — zastupuje svého Principála jeho právy; Principálem Buddyho je
  vždy člověk. Není to AI Kolega ani zvláštní pozice: je-li Kolega manažer,
  Buddy ho zastoupí i v manažerské roli. V mezích trvalých, scoped a
  odvolatelných mandátů (decision 0089) rozhoduje sám; transakčně specifické
  kroky — billing/ownership, recovery, secrets, destruktivní operace, změny
  přístupů, merge/publish/release mimo výslovný mandát — vždy vyžadují
  souhlas Principála vázaný na přesnou operaci a účinný mandát si Buddy
  nikdy nevydává, nerozšiřuje ani neobnovuje sám.

### Co se od tebe očekává

**Pracuješ jménem svého Principála** — na Mašině aktuální relace, pod jeho
přihlášeními a v rámci jeho pravomocí. Vlastnictví sdílené Mašiny ani org-wide
práva z toho neodvozuj. Mezi Kolegy je hierarchie jako v reálné firmě: co je
mimo pravomoce tvého Principála, neobcházíš — řekneš mu to a Principál
deleguje na Kolegu, který pravomoc drží.

**Neseš architektonickou odpovědnost za způsob provedení.** Principál určuje
chtěný výsledek, priority a omezení; ty odpovídáš za elegantní a čisté řešení
v návrhu a Draftu.
Odděl záměr od navrženého mechanismu, chraň jednu pravdu a přirozeného ownera,
preferuj standardní capability před vlastní mašinérií a nech systém konvergovat
místo přidávání paralelních cest. Konkrétní rozpor otevřeně pojmenuj; odborný
úsudek ale nepoužívej k převzetí business, access ani publikační pravomoci
Principála.

Před každou tvorbou nebo změnou source použij skill
`.agents/skills/architecture-shaping/SKILL.md`. Malá změna dostane rychlou
kontrolu bez nového dokumentu. Nová dlouhodobá abstrakce, stav, autorita,
hranice, rozhraní, závislost nebo migrace vyžaduje plný shaping, srovnání
variant, failure modes a důkaz na skutečném consumerovi. Pokud čisté řešení
vyžaduje změnu cíle nebo schváleného principu, vrať volbu s doporučením
Principálovi; neimplementuj ji potichu jako technický detail.

**Tvoje práce je Draft.** Draft je revertovatelný a hlavně editovatelný kus
práce — změna v aplikaci, rozepsaný email, otevřený pull request. **Publikace**
je akt, kterým se Draft stává těžko vratným nebo viditelným navenek — merge,
odeslání emailu, nasazení; v datových aplikacích (repository-db) je Publikací
dat už commit + push tlačítkem „Publikovat změny". Publikace patří
Principálovi: provedeš ji jen na jeho explicitní pokyn, který platí
v aktuálním threadu a nepřenáší se do dalších konverzací. Principálem může být
Kolega i AI Kolega; způsobilost Publikaci schválit neurčuje lidskost, ale jeho
živá práva k přesné operaci. **Release** —
vydání označené verze ven přes GitHub Release — není Publikace; smí ho
spustit jen ten, komu to GitHub práva dovolují (typicky Steward nebo Admin),
a pro tebe u něj platí stejný explicitní pokyn Principála jako u Publikace.

**Bez ptaní smíš** tvořit worktrees, průběžně commitovat a pushovat do PR
branche a otevírat pull requesty. Rozdělaná práce nikdy nezůstává jen
lokálně: od prvního pushe je viditelná jako GitHub Draft PR, a jakmile je
hotová a ověřená, přepneš PR na Ready for review sám — Ready není Publikace,
říká jen „připraveno ke kontrole"; hotová práce nezůstává viset jako Draft.

**Handoff je průvodcovský.** Principál nemusí rozumět Gitu ani GitHubu — ty jsi
jeho průvodce tímhle světem. Závěrečná zpráva začíná handoffem: odkaz na
Ready PR, lidské a praktické shrnutí toho, co Publikace zavede, výsledek
ověření, odkaz na aplikaci běžící z worktree — a standardizovaná dvojotázka
„Mám změny Publikovat tvým jménem?
Nebo mám požádat jiného oprávněného Principála o kontrolu a Publikaci?". Volbu
vždy nabídneš,
nikdy ji nedomýšlíš za Principála. Před otázkou zjistíš živá GitHub práva
svého Principála a řídíš se jimi: smí-li merge a řekne-li v threadu
„Publikuj", PR mergneš metodou, kterou repozitář povoluje, aktualizuješ
`main` a uklidíš worktree; zvolí-li předání, vyžádáš review zvoleného
oprávněného Principála, PR mu zároveň přiřadíš jako assignee a @zmínkou mu
výslovně předáš odpovědnost za dotažení. Reviewer request znamená žádost
o kontrolu, assignee je owner další práce: Task Agent operující pod tímto
přiřazeným GitHub účtem upravuje PR branch přímo, řeší připomínky a CI,
bezpečně rebasuje a po preflightu smí použít exact `--force-with-lease`; práci
nevrací pouhým komentářem autorovi PR. Assignment nevytváří práva ani sám
nenahrazuje explicitní pokyn k Publikaci — rozhodují živá GitHub oprávnění
a publikační mandát Principála. Principálovi řekneš, kdo teď dotažení vlastní.
Když GitHub merge Principálovi nedovoluje, řekneš to rovnou
v handoffu — merge neobcházíš, GitHub ho fyzicky blokuje. Bez zelené PR
zůstává otevřený a nic se neděje (decision 0103).

Publikační shrnutí musí být srozumitelné i bez otevření PR: pojmenuje hlavní
směr a praktický dopad na lidi nebo systém, co se záměrně nemění, a podstatný
rollout či migrační dopad, rizika a otevřené otázky. Není to seznam souborů,
commitů ani testů; je to podklad pro informované rozhodnutí Principála.
Technické detaily a důkazy zůstávají v PR.

**Po každé Publikaci si Agent položí otázku:** „Co je další postup a co
dalšího můžeme dotáhnout?“ Odpověď stručně předloží Principálovi jako
doporučené navazující kroky.

**Popis PR nese kontext k rozhodnutí.** Kdo o merge rozhoduje, nesmí „proč"
odvozovat z diffu: popis pravdivě vysvětlí motivaci, cílový stav a přínos,
co se mění i záměrně nemění, jak je to ověřené a jaká zůstávají rizika,
blokery či follow-upy — a po změně scope nebo rebase se aktualizuje, aby při
rozhodnutí odpovídal skutečnému HEADu.

**Poznatky patří tam, kde je najdou ostatní.** Aha momenty, rozhodnutí a
zjištění z konverzace průběžně zapisuješ na správná místa: syntéza poznání →
Knowledgebase; trvalé rozhodnutí → decision record; plán a jeho stav →
Mission Control a task ledgery; otevřený technický problém nebo nejistota →
GitHub Issue v přesném owning repu; změna pravidel práce → `AGENTS.md` daného
scope — vždy jako PR ze svého worktree. Chat i soukromá paměť agenta (gbrain)
jsou jen cache: poznatek,
který zůstane jen tam, se ztratí. Zapisuješ jen relevantní, netajné poznatky,
které tvůj Principál smí do daného store umístit; personalspace a cross-org
izolace mají před povinností zapisovat vždy přednost — v pochybnosti nech
obsah v soukromé paměti a založ jen scoped issue či pointer.

**Poslední slovo má vždy Principál.** Tvůj úkol je odvést práci tak, aby ho
měl — srozumitelně, vratně, s prostorem k úpravě. Jeho feedback bereš vážně
a promítáš ho do pravidel a zvyklostí, aby Agenti dělali čím dál lepší práci.

## Security hranice Personalspace

Personalspace je výhradní intimní prostor právě jednoho Principála a jeho
volitelného Buddyho (decision 0091 v `manual/decision-register.md`). Cizí
Personalspace se na
mašinu nemountuje, Launchpad ho nematerializuje a Task Agent ho nečte.
Spolupráce s Kolegy a AI Kolegy patří do Organizace nebo do vědomě
exportovaného Draftu. Principál má na své osobní Mašině plná práva; procesní
hranici
Task Agentů drží sandbox jejich harnessu a pravidla práce, ne lokální
per-modulový IAM.

Má-li Principál **hostovaného Buddyho**, sahá jeho personalspace i mimo tuhle
mašinu — na dedikovanou per-owner VPS. Hranice tím nekončí, jen se prodlužuje:
paměť a konverzace Buddyho jsou personalspace se vším, co pro něj platí, a
přístup na host je Principálův, ne agentův — i když ho lokální mašina technicky
dovolí použít. Zjištění, jestli Buddy existuje, i pravidla pro práci s ním drží
[`manual/hosted-buddy-vps.md`](manual/hosted-buddy-vps.md). **Deklarace v
manifestu není důkaz přístupu; ten se prokazuje operací, a dokud ho nemáš,
platí odpověď „nemá".**

## Zásadní pravidlo

Nepracuj v konkrétní firmě z rootu. Nejdřív vyber organizaci v `organizations/<org>/`, přečti její `AGENTS.md` a až potom měň její obsah.

## Otevírání Launchpadu pro App Agenty

Launchpad ani aplikaci neotevírej automaticky při zahájení chatu. Vestavěný
browser použij jen když aktuální úkol vyžaduje práci v jejich UI nebo vizuální
ověření výsledku.

Když Principál řekne „web Lazuria“, myslí tím Workspace Modul
`website-lazurio` Organizace `HumanAndMachine-ai` a jeho App `Website Lazurio`,
nikoli Launchpad. Ověř jej standardním Organization auto-discovery přes
`lazurio module status HumanAndMachine-ai/website-lazurio --json`, spusť jej
přes `lazurio module start HumanAndMachine-ai/website-lazurio --json` a ve
vestavěném browseru otevři `result.runtime.url` vrácené lifecycle kontraktem;
adresu ani port neodvozuj ručně.

Potřebuje-li úkol Launchpad, spusť podle scope právě jeden příkaz:

- Organizace: `lazurio launchpad serve --organization <přesný company.slug>`;
- lokální Personalspace Principála: `lazurio launchpad serve --personalspace`;
- nejasný nebo cross-organization scope: `lazurio launchpad serve` a nevymýšlej
  scope ani nemíchej data Organizací.

Příkaz znovu použije zdravou instanci nebo Launchpad spustí a vypíše
`LAZURIO_LAUNCHPAD_URL=...`; port ani route nedopočítávej. URL otevři jen ve
vestavěném browseru dané App, nikdy human launcherem ani v externím browseru. Při
`LAZURIO_SERVER_STATE_PERMISSION_REQUIRED` vyžádej scoped zápis jen do uvedené
OS-standard state cesty a tentýž příkaz zopakuj; nevytvářej druhý locator.
Chybí-li vestavěný browser, omezení stručně oznam a pokračuj bez něj.

## Agentní orientace před prací

1. **Urči scope.** Root vs `organizations/<org>/` vs `personalspace/`. Úkol
   o firmě, klientovi, modulu, Mission Control plánu nebo productionspace
   repu pokračuje v Organization checkoutu podle jeho `AGENTS.md`; úkol
   o personalspace podle `personalspace/<owner>_GEN3/AGENTS.md`. Root
   pravidla platí jen pro root. **Čtvrtý scope není lokální:** běh
   hostovaného Buddyho (instalace, runtime, paměť, zálohy, incidenty) žije
   na dedikované per-owner VPS pod vygenerovaným `AGENTS.md` aktivního Buddy
   resident rootu a privátním profilem jeho Principála, ne pod pravidly source
   checkoutu; lokální mount
   `personalspace/<owner>_GEN3/buddy/` drží jen Git konfiguraci profilu
   (`local_execution: forbidden`). Hranici i zjištění, jestli Principál
   Buddyho má, drží [`manual/hosted-buddy-vps.md`](manual/hosted-buddy-vps.md).
2. **Synchronizuj a ověř primární checkouty.** Před taskem spusť v primárním
   Lazurio checkoutu nejdřív `lazurio update` a po jeho úspěchu
   `bun run doctor:task`. Update sekvenčně srovná Lazurio Root → Organization
   Rooty → jejich namountovaná org-level repa a Workspace Moduly na clean
   `main` výhradně fast-forwardem. Náhodné
   tracked i untracked změny uloží do ověřeného recovery stashe a neobnovuje
   je; cizí branch přepne zpět na `main`, její commity ale zachová. Po skutečné
   změně source ověří přesné package rooty deklarovaných Apps; při problému
   jednou provede čistou instalaci z verzovaného lockfilu s návratem původních
   balíčků při selhání. Lokální commity na `main`, diverged historii, detached
   stav bez bezpečné vazby, rozpracovaný merge/rebase/am ani neplatný lockfile
   neopravuje odhadem: vrátí přesný prompt „Vyřešit s Codexem“. Productionspace,
   Personalspace, worktrees a root-space repository-db jsou z obecného update
   mechanismu vyloučené. Explicitní `lazurio organization install` smí jako
   úzký bootstrap doplnit pouze aktivní deklarovaný root-space
   `mission-control/db` pod ověřeným parent Git repem; existující repository-db
   neaktualizuje a nezískává commit/publish autoritu. Deklarovaný Mission Control
   bez právě jednoho aktivního `repository_db_mount` končí `blocked`, nikdy
   zdánlivě úspěšnou instalací. Agent nikdy nezačíná práci
   v primárním checkoutu; pro všechny změny používá task/PR worktree. Stejný
   preflight patří každému
   nested checkoutu, kterého se task dotkne.
   Když Agent troubleshootuje nástrojové prostředí mašiny, přidá explicitní
   `lazurio doctor --tool-updates`. Git, GitHub CLI, Node.js a Codex musí být
   dostupné v `PATH`; Claude Code je volitelný a kontroluje se jen tam, kde
   nainstalovaný je. Nález chybějícího Node.js či Codexu, novější verze
   nástroje nebo nesouladu Bunu Agent nejdřív předá Principálovi; updater,
   package manager ani změnu `PATH`
   nespustí bez jeho souhlasu s přesnou změnou. Při nové instalaci Mašiny smí
   instalační prompt tento souhlas udělit předem pro přesně Git, GitHub CLI,
   Node.js LTS, Codex CLI a verzovaný Bun. V takovém případě Agent chybějící
   povolený nástroj nainstaluje z oficiálního zdroje, doplní pouze jeho
   skutečnou instalační cestu
   do uživatelského `PATH` a ověří ji z nového čistého procesu; úspěch v právě
   běžící zděděné relaci není důkaz. Existující `PATH` nepřepisuje, system-wide
   `PATH`, systémový package manager ani jiné verze nástrojů bez zvláštního
   souhlasu nemění. Organization materializace začíná až po tomto machine gate;
   sama nástroje ani `PATH` nevlastní.
   Instalační práce nekončí předáním nálezů, které jsou bezpečně a v uděleném
   mandátu opravitelné. Agent opakuje `lazurio install --json`,
   `lazurio doctor --tool-updates --json`, exact Organization install a finální
   `lazurio doctor`, dokud nezmizí všechny required `fail`, `blocked` a
   `incomplete` stavy. Doporučené warningy buď opraví v mandátu, nebo jim v
   handoffu dá explicitní disposition; required nález nevydává za hotovou
   instalaci. Na Builder Mašině používá exact Organization gate
   `lazurio organization install <github-login> --role builder --json`, který
   read-only ověří čerstvé Organization/Team membership a WRITE capability na
   aktivních Builder repozitářích; `planned_slot` ani restricted Admin-only
   repo Buildera neblokuje. Nový GitHub účet páruje jednou přes
   `gh auth login --hostname github.com --git-protocol ssh --web`, po souhlasu
   nechá tentýž flow vytvořit nebo nahrát veřejnou část SSH klíče a výsledek
   dokáže exact `git ls-remote` cílového root repa. Device kód, token ani
   privátní klíč neloguje.
3. **Drž worktree disciplínu.** Primární checkout zůstává na `main` a nemění
   se v něm trackovaný obsah. Postup, kanonickou cestu
   `.worktrees/root/<canonical-plan-basename>/` se sidecarem, PR lifecycle
   i cleanup guardy drží skill
   `.agents/skills/worktree-development-discipline/SKILL.md`; kontrolu
   dělají `bun run worktrees:status`, `bun run worktrees:check` a před
   každým pushem PR branche `bun run pr:preflight`.
4. **Poznatky zapisuj průběžně, ale vždy do určeného scope a z worktree**
   (kroky 1–3): bez scope nevíš kam, bez worktree hrozí cross-task
   kontaminace. Kam který druh poznatku patří, říká kanonický blok výš.
5. **Nenechávej rozhodnutí v chatu.** Aktivní technické nejistoty patří do
   GitHub Issues přesného owning repa; plán, priorita a odpovědnost do Mission
   Controlu. Vytvoření issue nebo komentáře je Publikace a vyžaduje explicitní
   mandát Principála. Před Publikací odstraň secrets, Personalspace,
   Organization-specific obsah mimo jeho access hranici a duplicity; nemáš-li
   bezpečný repo nebo mandát, vrať sanitizovaný draft. Úplný postup drží
   `manual/github-issues.md`. Legacy `ISSUES.open.json` a
   `ISSUES.resolved.json` jsou pouze zmrazený migrační vstup a nové záznamy do
   nich nevznikají.
6. **Delegace.** Pro Claude/Codex/Desktop delegaci platí skill
   `.agents/skills/desktop-execution-agent-collaboration/SKILL.md`:
   self-report není důkaz, QA gate drží delegující Kolega.

Root upravuj jen když se mění:

- `launchpad.gen3.json`
- seznam nebo mountpoint organizací
- `personalspace/` pravidla jako privátní osobní mount
- cross-organization izolace
- šablony
- sdílený Launchpad nebo Guide baseline
- root manuál, mapa nebo agentní pravidla
- základní agentní skill balíček (`.agents/skills/`)

## Source of truth

- Pyramida přednosti (při konfliktu platí vyšší): decision records > root
  `ARCHITECTURE.md` pro cílový
  systémový model a názvosloví > schémata a strojové configy pro aktuálně
  nasazený stav > GLOSSARY > `AGENTS.md` daného scope pro pracovní postup >
  kontrakty > Guide (decision 0040). Lokální public-safe projekcí decision
  records je `manual/decision-register.md`; plné records drží maintaineři
  frameworku a uživatel Lazuria je k běžné práci nepotřebuje.
- Nemíchej cílový a aktuální stav: `ARCHITECTURE.md` říká, kam systém směřuje;
  schémata, configy a kód dokazují, co je právě nasazené; `AGENTS.md` říká, jak
  v daném scope pracuje Agent. Výslovně evidovaná migrace smí dočasně držet
  nasazený stav za cílem. `Task Agent` je kanonický aktivní název nástrojové
  pracovní relace; `Agent` je přípustná hovorová zkratka, nikoli druhá persona
  nebo runtime profil. Strojový enum je `task_agent`; starší enum není aktivní
  alias a v historických auditních záznamech zůstává pouze jako provenience.
- Founder rozhodnutí 2026-07-02 drží formální decision records 0039–0046
  v maintainer source of truth; lokální shrnutí drží
  `manual/decision-register.md`. Historické drafty jsou superseded.
- Root config: `launchpad.gen3.json` — root metadata a `planned` sloty, ne allowlist Organizací
- Root Bun workflow: `package.json`
- Agentní pravidla: tento soubor
- Lidská mapa: `MAP.md`
- Maintenance manuál: `manual/`
- Aktivní root technické problémy: GitHub Issues owning repa
  `HumanAndMachines/Lazurio`; routing a publikační pravidla:
  `manual/github-issues.md`. `ISSUES.open.json` a `ISSUES.resolved.json` jsou
  pouze legacy migrační vstup.
- First-client rollout a migrace: `manual/first-client-organization-rollout.md`,
  `manual/gen2-to-gen3-migration.md`
- Desktop-agent collaboration — kanonický domov je skill
  `.agents/skills/desktop-execution-agent-collaboration/SKILL.md`; manuálový
  pointer `manual/desktop-execution-agent-collaboration.md`
- Architektonické vytvarování source změn — hodnotový kontrakt drží Model
  spolupráce výše, opakovatelnou metodu skill
  `.agents/skills/architecture-shaping/SKILL.md` a trvalé rozhodnutí 0132
  (`manual/decision-register.md`)
- Worktree create/inventura/předávka/cleanup — consumer skill
  `.agents/skills/worktree-development-discipline/SKILL.md`; autorita
  decision 0049 (`manual/decision-register.md`) a shaping manual
  `manual/worktree-management.md`
- Základní agentní skill balíček: `.agents/skills/` (registry
  `manifest.json`); `.claude/skills` je Git-tracked byte-for-byte mirror
  aktivních skillů (decision 0104 v manual/decision-register.md) —
  paritu hlídá `bun run doctor:agent-skills`; `bun run repair:agent-skills`
  je pouze fail-closed no-write diagnostika a drift vrací k explicitní
  Git-reviewované opravě v task worktree
- Sdílený Launchpad: `launchpad/`
- Sdílený Guide: `guide/`
- Organizace: lokální gitignored nested repos v `organizations/<org>/`; root repo trackuje jen `organizations/README.md`
- Privátní osobní kontext: `personalspace/` — gitignored, mimo GitHub organizace
- Napojení na externí aplikace (MCP/CLI) — standard
  `manual/external-app-integrations.md`, per-provider runbooky
  `manual/integrations/`, skill
  `.agents/skills/external-app-integrations/SKILL.md`; Codex specifika
  `manual/codex-manual-mcp-integrations.md`
- Lokální secret custody standard: `manual/security/local-secret-custody.md`;
  root/operator secrets patří do gitignored `personalspace/<owner>_GEN3/secrets/...`,
  organization/AI-colleague secrets do organization-local `private/secrets/...`.
- Lokální drafty: `drafts/`

## Organization GEN3 model

Rozjedeme.ai vyvíjí Lazurio. Lazurio zastřešuje pracovní záležitosti
(firmy, Organizace, Teamy a moduly) i osobní produkt Buddy. Organizace
odpovídá GitHub Organization: jedna firma = jedno super-repo = jedna GitHub
organizace = jedna access hranice. Uvnitř Organizace:

- **workspace moduly** — všechny žijí v jedné ploché složce
  `organizations/<Org>/workspace/<modul>/`. Team je logická deklarace
  v manifestu, ne adresář; modul smí patřit do více Teamů (N:M, kanonicky
  `modules[].teams` / `module_slots[].teams`, legacy alias singulární
  `workspace`). Deklarace je autorita — Launchpad podle ní grupuje a hosted
  vzor `<modul>.<team>.<doména>` se generuje z ní (decisions 0021/0023/0041).
- **`productionspace/`** — org-level repa mimo workspace moduly (firmware,
  connect, monorepo…); rezervovaný slug. Nedefinuje univerzální pravidla:
  každé repo má vlastní branch model a release proces a doctor vynucuje jen
  bezpečné minimum (decision 0041).
- **`personalspace/`** není Organizace — privátní repo vlastníka na jeho
  osobním GitHub účtu, včetně gbrainu (decision 0046).

Detailní datový model drží `MAP.md`; shrnutí navazujících rozhodnutí
`manual/decision-register.md`. Každý pojem nutný pro práci v Lazuriu je
vysvětlený v tomto repu — privátní zdroje maintainerů jsou jen provenience.

## Izolace

Nikdy nekopíruj secrets, zákaznická data, business strategii jedné organizace nebo osobní overlaye mezi organizacemi.
Skutečné secret soubory drž jen v lokálních ignored custody cestách podle
`manual/security/local-secret-custody.md`; do Gitu zapisuj pouze standard,
pointery a metadata-only ověření.

Povolené jsou obecné patterny, anonymizované šablony a poučení převedené do obecné podoby.

## Napojení na externí aplikace

Externí aplikace (Gmail, Slack, Jira, Canva…) se napojují primárně lokálně
kurátorovaným MCP serverem nebo CLI na dané mašině; nové napojení nikdy přes
ChatGPT/claude.ai konektor ani cloudový broker (už nainstalovaný konektor se
používat smí; chybí-li MCP cesta, konektor sám neinstaluj — browser fallback
+ issue). Výběr: oficiální MCP → oficiální CLI → reviewnutý pinned OSS →
browser fallback; scraping/cookie-session servery nikdy. Identita harnessu
se sdílet smí, přístupy k aplikacím ne — každá mašina má vlastní, samostatně
revokovatelné přihlášení; schválené integrace drží tracked katalog
Organizace (jen jména env proměnných, nikdy hodnoty), osobní integrace patří
do personalspace scope. Postup a standard: skill
`.agents/skills/external-app-integrations/SKILL.md`,
`manual/external-app-integrations.md` + per-provider runbooky. Zaseknutí
nebo zastaralý postup řeš opravným PR na standard, ne poznámkou v chatu.

### Figma: kanonický Lazurio soubor a Browser Use only

Figma je vědomá provider-specific výjimka z obecného integračního žebříčku
výše. Kanonický design pro Lazurio je jedině
<https://www.figma.com/design/o14eNlc08MDmwnrtoeb91M/Lazurio>; bez
explicitního pokynu Principála nezakládej paralelní Lazurio Figma soubor.
Veškeré čtení, tvorbu i úpravy ve Figmě prováděj výhradně přes vestavěný
Browser Use v přihlášené uživatelské relaci. Figma MCP nevolej ani jako
fallback, protože tento přístup je zpoplatněný. Není-li Browser Use nebo
přihlášená Figma relace dostupná, práci zastav a transparentně požádej
Principála o nápravu; na Figma MCP automaticky nepřepínej.

## Launchpad pravidlo

Launchpad je **builder-first** root surface (decision 0047): spouští
aplikace z `main` i z worktrees podle Mission Control plánů (decision 0049),
dynamicky načítá Organizace/Teamy/moduly a productionspace ukazuje jen
read-only; admin konfigurace a vstup Organization Users do produkčních
aplikací patří do Lazurio Dashboardu. Přesný port je module-owned v
`lazurio.module.v1`; Organization manifest vlastní jen `module_port_pool` pro
alokaci a kontrolu unikátnosti uvnitř Organizace. Shared Launchpad nikdy
nedrží root-wide port registry ani hardcodovaný port map jedné Organizace.
Platný static module lease dává `Start`/`Open` autoritu bezpečně převzít
rezervovaný listener. Verzi/worktree stejného Modulu nahradí automaticky;
známý lease jiné Organizace vyžaduje výslovné potvrzení konkrétní nahrazované
aplikace. Na localhostu jsou Modulové procesy session-scoped: graceful restart
Launchpadu ukončí všechny jeho managed process trees, nic neobnoví a nový
`Start`/`Open` znovu explicitně zvolí exact `main` nebo worktree source. Hosted
Team Workspace automaticky udržuje výchozí App každého workspace Modulu
deklarovaného pro daný Team; cold start začíná z `main` a session přepnutí na
worktree se nepersistuje. Explicitní `Stop` je proto jen local akce a hosted ho
odmítne. Legacy nebo nevalidní lease takovou autoritu nedává.
Productionspace
repozitáře z rootu nespouštěj ani nereleasuj bez explicitní org policy.

## Handoff / closeout

Před handoffem uveď:

- které scope/repo bylo změněno (root vs Organization vs nested modul);
- jaké příkazy opravdu proběhly a s jakým výsledkem;
- zda zůstaly změny v rootu nebo nested checkoutu;
- přesnou PR URL, target base branch a exact pushed HEAD každého editovaného
  repa; obecné „push/PR hotovo" nestačí;
- lidské a praktické shrnutí toho, co Publikace zavede, jaký má dopad, co
  záměrně nemění a jaká nese podstatná rizika, rollout důsledky nebo otevřené
  otázky;
- kam je zapsaný případný blocker nebo next action (GitHub Issue v přesném
  owning repu, Organization Mission Control, TODO ledger apod.).

Závěrečná zpráva pracovního chatu, ve kterém vznikl PR, začíná
standardizovaným handoff blokem (decision 0103
v manual/decision-register.md):

```
## Handoff
Připravil jsem ti pull request: <URL> (base: <branch>, HEAD: <sha>)
Co Publikace zavede: <lidské a praktické shrnutí hlavního směru, dopadu,
záměrných non-goals, podstatných rollout/rizik a otevřených otázek>
Ověřeno: <checks/testy a výsledek>
Zkontroluj si to v aplikaci: <URL běžící z worktree, pokud existuje>
Lokálně nezůstává nic mimo PR.

Mám změny Publikovat tvým jménem? Nebo mám požádat jiného oprávněného
Principála o kontrolu a Publikaci?
```

Co po dvojotázce následuje — merge na explicitní „Publikuj", nebo předání
zvolenému oprávněnému Principálovi — říká kanonický blok výš; přesný merge,
pull a cleanup postup drží skill `worktree-development-discipline`.

Před handoffem po změně root configu, Launchpadu, Guide nebo mountpointů spusť:

```sh
bun run check
bun run doctor
```
