# Prohlížeč Environmentu: architektura pro aplikace a forky

Jedna architektura prohlížeče Environmentu pro všechny aplikace, které ho ukazují:
Launchpad, T3 Code, Lazurio MausBot a napojení Codex Desktopu. Podle tohoto dokumentu se
mění Platforma (LazurioPlatform), aktualizují se forky (`Lazurio/t3code`,
`Lazurio/OpenMausBot`, `Lazurio/agent-browser`) a reaguje se na nové verze upstreamu nebo
Codex Desktopu. Je to shrnutí platných rozhodnutí, ne nové rozhodnutí. Při rozporu platí
rozhodnutí: root **0191** (prohlížeč a plocha Environmentu), **0195** (paměť, pravý panel podle
aplikace, Nová karta, kdy karta zanikne) a návrhy LazurioPlatform **F38**, **F39** a **F47**
v jejím `docs/decisions.md`. Matěj tento dokument zadal 2026-10-11 jako vodítko pro
aktualizace forků (dodatek 0191 z 2026-10-11).

## Principy

1. **Prohlížeč patří Environmentu.** Na každém Remote Environmentu (Ubuntu) běží jeden prohlížeč:
   Chromium s jedním trvalým profilem. Přihlášení v něm jsou schopnost Environmentu a sdílí je
   všichni jeho agenti a uživatelé (0191 bod 1). Uvnitř Environmentu se nic neodděluje. Kdo
   potřebuje jiná přihlášení, dostane jiný Environment. Vestavěný prohlížeč desktopové aplikace
   na notebooku je prohlížeč toho notebooku, ne Environmentu.
2. **Karty otevírá Environment, agenti v nich pracují přes náš agent-browser.** Agent pracuje
   v okně prohlížeče Environmentu přes CLI `agent-browser` z forku `Lazurio/agent-browser`, se
   svým sezením a připojený k prohlížeči přes DevTools na portu 9222 (0191 bod 4). V T3 Code
   totéž dělají jeho náhledové nástroje `preview_*` nad stejným prohlížečem. Žádná aplikace si
   nestaví vlastní prohlížeč pro stránky Environmentu a žádný agent nespouští vlastní Chromium
   s jinými přihlášeními.
3. **Člověk vidí kartu jen přes pohled Platformy.** Jedna karta člověka je jedna vzdálená karta:
   `https://browser.<…>/t/<id>` je pohled právě na ni, holá adresa `browser.<…>/` založí novou
   (0191 bod 11, F39). Každá aplikace ukazuje kartu jako rámeček tohoto pohledu. Agent a člověk
   v ní pracují současně. Plocha (`desktop.<…>`, druhá vlna) je pohled na celou obrazovku.
4. **Spravuje se z Launchpadu.** Launchpad ukazuje všechny karty Environmentu, jeho paměť a
   spuštěné Moduly a umí kartu zavřít všem (0195 bod 5 a 9, F47). Stejnou Novou kartu otevře
   „+“ v každé aplikaci (0195 bod 10).
5. **Karta žije, dokud ji něco drží.** Drží ji místo, které ji ukazuje (lišta vlákna v T3 Code,
   Launchpad, ve kterém ji člověk otevřel, výhledově bot MausBotu), a agent, který v ní pracuje.
   Když ji nic nedrží, nikdo se na ni nedívá a nepracuje v ní agent, po krátké lhůtě
   s nabídkou Vrátit zanikne (0195 bod 11, F47 bod 5). O konci karty rozhoduje jediné místo:
   hub pohledu.
6. **Hranice Environmentů.** Pohled jiného Environmentu se nikdy nenačítá v prohlížeči tohoto
   Environmentu (pohled v pohledu). Aplikace ho smí vložit do svého panelu s barevným rámečkem a
   označením toho Environmentu (0191 body 20–22).

## Součásti a kdo co vlastní

| Součást | Vlastník | Co dělá |
| --- | --- | --- |
| Obrazovka a Chromium (`lazurio-display`, `lazurio-browser`) | Machines (balíčky), LazurioPlatform (jednotky) | Jeden prohlížeč s rozpočtem paměti a bez obnovy starých karet po restartu (F38 a jeho dodatky) |
| Pohled a jeho hub (`lazurio-browser-view`) | LazurioPlatform | Pohled jedné karty za bránou; hub sleduje každou kartu, rozhoduje o jejím konci a drží vlastní prázdné okno, aby prohlížeč neskončil (F39, F47 bod 5) |
| Soubory držitelů `$XDG_RUNTIME_DIR/lazurio-browser/holders/<lišta>.json` | Server aplikace, které lišta patří | Které karty lišta drží; zapisuje je jen ta aplikace, atomicky, s právy 0600 v adresáři 0700 (F47 bod 4) |
| Seznam živých karet `$XDG_RUNTIME_DIR/lazurio-browser/tabs.json` | Hub | Čerstvý snímek karet prohlížeče s časem na boot clock; podle něj si aplikace srovnávají svá držení (F47 bod 4) |
| Loopback API hubu (`/.lazurio/tabs…`) | Hub; volá ho jen Launchpad | Seznam karet, nová karta, zavřít všem, Vrátit; nikdy přes bránu ani z prohlížeče (F47 bod 6) |
| Přehled a akce Launchpadu (`/api/new-tab/…`) | LazurioPlatform | Paměť, karty, Moduly, otevřít, držet, zavřít, Vrátit (F47 body 7–8) |
| Nová karta: stránka `/new-tab` a prvek `<lazurio-new-tab>` | LazurioPlatform (shell) | Jedna komponenta pro všechny aplikace; aplikace ji vloží jako prvek shellu (F47 body 1–3) |
| `agent-browser` | Fork `Lazurio/agent-browser` | Nástroj agentů: sezení, vazba sezení na kartu, připnutá karta (0191 bod 4) |
| Návody agentům | LazurioPlatform (Folder) | Jak otevřít okno (`lazurio browser window`), poslat odkaz a co dělat po `tab_gone` |

**Jak karta vzniká.** Agent si otevře okno příkazem `lazurio browser window`: vznikne okno
prohlížeče a jeho sezení se na něj naváže (`<sezení>.target`). Člověk otevře kartu z Nové
karty, Launchpad požádá hub o nové okno. Stránka otevře novou kartu nebo pop-up: pop-up se
ukáže nad stránkou ve stejném pohledu, novou kartu nabídne aplikace jako novou kartu lišty
(0191 bod 12).

**Jak karta končí** (F47 body 5 a 6):
- **Kdy je karta držená.** Drží ji soubor držitele, který ji uvádí, nebo agent, který v ní
  pracuje. Agent v ní pracuje, když je na ni navázané jeho sezení `agent-browser`
  (`<sezení>.target`) a démon toho sezení běží (`<sezení>.pid`).
- **Konec po posledním držení.** Když poslední držení zmizí a nikdo se na kartu nedívá, karta
  skončí po 8 s. To je okno Vrátit.
- **Karta, kterou nic nedrží,** skončí 30 s po odchodu posledního diváka. Kartu, kterou ještě
  nikdo neviděl ani nedržel, ukončí hub po 10 minutách.
- **Držená karta** jen proto, že se na ni nikdo nedívá, nekončí.
- **Zavřít** v Přehledu nebo v liště Launchpadu zavře kartu všem po 8 s, i drženou. Pracuje-li
  v ní agent, nejdřív varuje.
- **Selhané čtení.** Když hubu selže čtení držení, kartu nezavře.

## Smlouva hostitelské aplikace

Každá aplikace, která prohlížeč ukazuje (Launchpad, T3 Code, výhledově MausBot), dodrží
tohle a nic dalšího nepotřebuje:

1. **Nová karta jako prvek shellu.** „+“ v pravém panelu vloží `<lazurio-new-tab>` ze skriptu
   `/.lazurio/shell.js` s atributy `strip` (lišta), `tools` (vlastní nástroje aplikace) a
   případně `focus-address`, a reaguje na událost `lazurio-new-tab`: stránka, vybraná karta,
   nebo nástroj. Sama nikam nenaviguje a protokol uvnitř prvku nepotřebuje znát.
2. **Karta je rámeček pohledu.** Aplikace ukazuje kartu jako rámeček `browser.<…>/t/<id>` a
   naslouchá zprávám pohledu: `lazurio-browser:info` (adresa a titulek),
   `lazurio-browser:new-tab` (nová karta stránky) a `lazurio-browser:closed` (karta skončila).
3. **Drží, co ukazuje.**
   - **Soubor držitele.** Server aplikace zapisuje pro každou lištu jeden soubor držitele
     `<lišta>.json` = `{"strip", "label", "tabs": [<id karty>…]}`. Zapisuje ho atomicky
     (dočasný soubor a přejmenování), s právy 0600. Lišty jsou `launchpad` a `t3-<vlákno>`, což
     je zároveň sezení agenta vlákna.
   - **Čas záznamu.** Ke každé kartě si aplikace ve vlastním úložišti drží čas jejího záznamu.
     Měří ho na boot clock (`boot_id` a `/proc/uptime`), nikdy systémovými hodinami. T3 Code ho
     drží ve stavu vlákna, Launchpad jako `recordedAt` ve svém souboru držitele.
   - **Srovnání se seznamem živých karet.** Aplikace se srovná při startu, při každé změně
     seznamu (sleduje ho a čte znovu každých 30 s) a před zápisem souboru držitele.
   - **Kdy kartu pustí.** Jen když ji postrádá seznam ze současného bootu pořízený po jejím
     záznamu (pravidlo `keptTabs` v LazurioPlatform). Seznam z jiného bootu ignoruje.
4. **Pouští, co skončilo.**
   - Zavření karty v liště ji odebere z této lišty, s nabídkou Vrátit.
   - Archivace nebo smazání vlákna zavře všechny jeho karty, včetně vlastního okna jeho agenta
     (Matěj 2026-10-11, F47 to nechával otevřené).
     - Aplikace karty pustí a ukončí sezení agenta vlákna, aby okno nedržel jeho démon.
     - Kartu, kterou drží i jiné vlákno nebo Launchpad, jen pustí, protože bod 11 rozhodnutí
       0195 platí dál.
   - Zbytek dořeší hub.
5. **Jen rozhraní Platformy.**
   - Aplikace používá prvky shellu, dokumenty `/.lazurio/…` svého Environmentu a soubory
     držitelů.
   - Loopback API hubu patří Launchpadu, jiná aplikace ho nevolá.
   - Webová stránka aplikace nevolá DevTools prohlížeče.
   - Pohled jiného Environmentu aplikace nikdy neotevírá v prohlížeči tohoto Environmentu (0191
     bod 21). Ve svém panelu ho smí vložit s označením toho Environmentu (bod 20).

## Aplikace po jedné

### Launchpad

Lišta ukazuje všechny karty Environmentu. „+“ otevře Novou kartu bez nástrojů. Launchpad
drží karty, které v něm člověk otevřel: z Nové karty, nebo jako novou kartu stránky
zobrazené v něm (`holders/launchpad.json`). Ty žijí, dokud je někdo nezavře všem. Přehled
čte paměť Environmentu, karty a Moduly jen tehdy, když je Nová karta vidět. Paměť jedné karty
je odhad z JavaScript heapu označený „≈“; Matěj 2026-10-11 rozhodl, že odhad stačí, aby bylo
vidět, které karty jsou nejnáročnější.

### T3 Code (hlavní cíl kompatibility)

- **Lišta je vlákno.** Lišta pravého panelu ukazuje karty jednoho vlákna: jeho karty
  prohlížeče a nástroje T3 Code (0195 bod 9). Drží je server T3 Code, takže lišta je stejná na
  všech zařízeních, a zapisuje soubor držitele vlákna `t3-<vlákno>.json`. Sezení agenta
  vlákna je `t3-<vlákno>`.
- **„+“ je Nová karta** s nástroji T3 (Terminal, Files, Diff, pull requesty, Agents, Device)
  místo upstreamové nabídky. Adresní řádek se v T3 nezaměřuje, aby písmena otevírala nástroje.
- **Náhledové nástroje** (`preview_*`) řídí prohlížeč Environmentu: každá jejich karta je okno
  prohlížeče Environmentu a pravý panel ukazuje kartu vlákna.
- **Karta vzatá z Přehledu** do vlákna zůstává jednou sdílenou kartou. Lišta ukáže, že ji drží i
  jiné vlákno nebo Launchpad.
- **Desktopová aplikace** T3 Code má vlastní prohlížeč počítače, na kterém běží, a 0191 ho
  nemění.
- **Upstream.** Až upstream T3 Code přinese vlastní integraci prohlížeče do webového T3, fork
  ji vyřadí a ponechá pohled Environmentu. Vzdálená karta je pro Remote Environment
  správné řešení (Matěj 2026-10-11). Stav upstreamu k 2026-10-11 popisuje kapitola
  „Upstream T3 Code k 2026-10-11“ níže.

### Lazurio MausBot

Pro MausBot se vymyslí totéž co pro T3 Code (Matěj 2026-10-11):
- lišta bota drží karty, které bot ukazuje;
- karty bota se zavřou, když bot skončí;
- práce bota v prohlížeči jde přes `agent-browser` v prohlížeči Environmentu.

Je to třetí vlna 0191 (bod 9) a F47 MausBot zatím nenavrhuje. Do té doby používá MausBot
vlastní profily podle své dosavadní podoby. Přechod na prohlížeč Environmentu se navrhne
v plánu MausBotu podle smlouvy výše.

### Codex Desktop (vědomý kompromis)

Codex Desktop upravit nemůžeme, proto:
- jeho agenti pracují v prohlížeči Environmentu přes `agent-browser` (přes SSH na Environment)
  a posílají do chatu odkaz `browser.<…>/t/<id>`, který člověk otevře v prohlížeči Codex
  Desktopu;
- Nová karta je pro něj samostatná stránka `launchpad.<…>/new-tab`. Karty otevřené odtud drží
  Launchpad, výběr existující karty ji jen otevře ve stejném okně;
- okno agenta Codexu drží jen práce agenta a to, že se na ně někdo dívá. Vlákna Codexu Lazurio
  nevidí, takže je nedrží. Okno skončí, když agent přestal pracovat (démon skončí po hodině bez
  příkazu) a nikdo se na ně nedívá ani ho nedrží Launchpad.

### agent-browser (fork `Lazurio/agent-browser`)

Na `agent-browser` stojí tato smlouva:
- připojení ke sdílenému prohlížeči přes `--cdp 9222`;
- sezení pro vlákno;
- vazba sezení na kartu (`<sezení>.target`), která přežije restart démona;
- `<sezení>.pid`, který démon při skončení smaže;
- připnutá karta;
- výchozí hodina nečinnosti démona.

Dashboard `agent-browser` lidé nepoužívají, lidé mají pohled Platformy. Fork nese jen opravy a
distribuci; jeho vydání popisuje `docs/operations/lazurio-fork-release.md` ve forku.

## Aktualizace forků a nové verze upstreamu

1. **Nejdřív upstream.** Před stable refreshem forku projdi, co upstream změnil v prohlížeči,
   pravém panelu, náhledových nástrojích a ve správě vláken nebo botů, a sepiš, kde se to
   potkává s touto smlouvou.
2. **Smlouva má přednost.** Co upstream přinese do webové aplikace jako vlastní prohlížeč nebo
   jinou integraci prohlížeče, fork vypne a jeho vstupy svede na pohled Environmentu a Novou
   kartu.
3. **Overlay je ohraničený.**
   - Kód Lazuria žije ve vlastních souborech overlaye (v T3 Code `apps/*/src/lazurio/`).
   - Body napojení v upstreamových souborech musí být malé a pokryté testy smlouvy.
   - Každá schopnost prohlížeče je řádek tabulky „Canonical overlay inventory“ v runbooku forku
     (`docs/operations/lazurio-fork-release.md`), s důkazem a pravidlem pro odstranění. Patří
     sem:
     - soubory držitelů a jejich srovnání;
     - Nová karta;
     - zprávy pohledu;
     - náhledové nástroje;
     - odkazy jiných Environmentů;
     - uvolnění po archivaci.
   - Při každém stable refreshi se schopnost znovu zařadí (odstranit, ponechat, převést). Co
     převzal upstream, se odstraní.
4. **Kontrola po aktualizaci.** Na Environmentu ověř, že:
   - lišta drží své karty a archivace je pustí;
   - Nová karta se otevře a otevře stránku i kartu z Přehledu;
   - nová karta stránky se objeví v liště;
   - `preview_*` řídí prohlížeč Environmentu;
   - pohled jiného Environmentu se nenačte uvnitř tohoto prohlížeče.

   Ověření v prohlížeči podle 0178.
5. **Verze k sobě.** Vydání aplikace, které spoléhá na novou část Platformy, ji vyžaduje (například
   T3 Code s držiteli vláken potřebuje Platformu se seznamem živých karet). Mění-li se chování
   karet, vydá se Platforma i aplikace spolu.

### Upstream T3 Code k 2026-10-11

Upstream `main` (`pingdotgg/t3code`, 754 commitů za stable v0.0.45, z níž fork vychází) mění
prohlížeč takto:
- **Stable zatím není.** Z větve 0.0.46 vyšly jen verze preview a nightly. Refresh forku podle
  jeho runbooku vychází jen ze stable tagu. Úkol 501 proto staví na v0.0.45 a overlay připraví
  pro přenos podle bodů níže.
- **Prohlížeč na serveru.** „Run the browser on the environment server“ (#15328): každé
  prostředí T3 má vlastní prohlížeč na serveru a webový klient, telefon i agenti ho používají
  bez notebooku (`PreviewRuntime` `desktop | server`, `serverBrowser` zapnuté vždy). Bez zásahu
  by „+ Browser“ i `preview_*` ve webovém T3 na Environmentu spustily druhé, headless Chromium
  uvnitř serveru T3. To odporuje principu 1. Fork proto serverový prohlížeč upstreamu
  napojí na prohlížeč Environmentu (DevTools na 9222), nebo ho vypne a vstupy svede na pohled
  Environmentu.
- **Karty patří serveru, pořadí klientovi.** Server upstreamu drží, které karty existují
  (`PreviewManager`, vlastník karty, `reveal`). Klient drží pořadí, aktivní kartu a stav panelu
  (`rightPanelStore`, localStorage). Cílem forku je ukládat karty vlákna ve tvaru blízkém
  `PreviewSessionSnapshot`, aby je mohl později nést `PreviewManager` upstreamu. Pak je uvidí
  i desktopová a mobilní aplikace upstreamu.
- **„+“ nemá bod rozšíření.** Nabídka „+“ (`RightPanelTabs`, zkratka Mod+T) je napevno.
  Nejmenší zásah je vložit Novou kartu do jejího vyskakovacího okna a předat jí akce upstreamu
  jako nástroje T3.
- **Archivace a smazání.** Orchestrace je přepsaná (`orchestration-v2`). Obě verze ale
  publikují proud doménových událostí. Uvolnění karet při archivaci a smazání vlákna proto
  patří do reaktoru overlaye nad tímto proudem, s malým adaptérem pro obě verze. Upstream sám
  karty při archivaci nechává a při smazání zavírá.
- **Funkce mají vlastní HTTP trasy** s autorizací rozsahem (`preview:operate`). Trasa overlaye
  pro karty vláken se drží stejného vzoru místo změny RPC kontraktu.

## Co je otevřené

- Uspávání karet a jeho mechanismus (DEV-6656 spike 916).
- Nastavení doby nečinnosti okna agenta a strategie zavřít, nebo uspat v Nastavení Launchpadu
  (Matěj 2026-10-11; DEV-6656 úkol 943, čeká na spike 916). Do té doby karty vlákna, které stojí,
  ale není archivované, drží jeho lišta.
- Jména lidí u karet: přijdou s účty Lazuria (0192). Přihlášení přes bránu identitu neříká.
- Plocha a Computer Use (druhá vlna 0191).
- Jak při refreshi na stable 0.0.46 napojit serverový prohlížeč upstreamu na prohlížeč
  Environmentu: buď ho fork vypne, nebo ho nasměruje na DevTools na 9222.
- Zda pořadí karet v liště vlákna sdílet mezi zařízeními (upstream ho drží v každém klientovi
  zvlášť).
