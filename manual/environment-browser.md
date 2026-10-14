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

**Stav k 2026-10-12: cílová smlouva, ne popis nasazeného stavu.** Přítomný čas níže popisuje cíl.
- **Vydané a ověřené na canary Environmentu:**
  - hub, který podle souborů držitelů rozhoduje o konci karty, Přehled a akce Launchpadu,
    Nová karta a panel Launchpadu (F47 kroky 1–3, LazurioPlatform v0.1.8-rc.51);
  - hodina nečinnosti démonů agent-browseru (rc.51) a restart pohledu po aktualizaci (rc.53);
  - Matějovo doladění panelu Launchpadu a jedno jméno Environmentu v pohledu i přepínači
    (rc.55), titulek pohledu se stránkou na začátku (rc.56);
  - karty vláken v T3 Code s jejich soubory držitelů a Nová karta v pravém panelu
    (preview 0.0.45-preview.20261012.2).
- **Teprve přijde:** stable T3 Code 0.0.45-lazurio.8 a nasazení na ostatní Environmenty;
  refaktor podle dodatku 0191 z 2026-10-12 (body 28–35).
- **Jen cíl:** MausBot na prohlížeči Environmentu.

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
4. **Spravuje se z Přehledu, lišta ukazuje karty svého místa.**
   - Přehled v Nové kartě ukazuje všechny karty Environmentu, jeho paměť a spuštěné Moduly a umí
     kartu zavřít všem (0195 body 5 a 10, F47).
   - Stejnou Novou kartu otevře „+“ v každé aplikaci, Launchpad je jejím domovem.
   - Lišta ukazuje karty svého místa: v T3 Code karty vlákna, v Launchpadu karty otevřené
     v Launchpadu (0195 bod 13).
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
| Přehled a akce Launchpadu (`/api/new-tab/…`) | LazurioPlatform | Paměť, karty, Moduly, otevřít, držet, pustit, zavřít všem, Vrátit (F47 body 7–9) |
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
  (`<sezení>.target`) a démon toho sezení běží (`<sezení>.pid`). Démon skončí po limitu
  nečinnosti z uživatelského nastavení agent-browseru: Platforma tam zapíše hodinu, pokud tam
  člověk nemá vlastní limit, a jeho volbu nepřepisuje.
  Výchozí limit agent-browseru se na prohlížeč připojený přes DevTools nevztahuje.
- **Konec po posledním držení.** Když poslední držení zmizí a nikdo se na kartu nedívá, karta
  skončí po 8 s. To je okno Vrátit.
- **Karta, kterou nic nedrží,** skončí 30 s po odchodu posledního diváka. Kartu, kterou ještě
  nikdo neviděl ani nedržel, ukončí hub po 10 minutách.
- **Držená karta** jen proto, že se na ni nikdo nedívá, nekončí.
- **× na liště** kterékoli aplikace zavře pohled člověka a kartu za to místo pustí, s nabídkou
  Vrátit. Karta v Environmentu i v Přehledu zůstává, dokud ji drží něco jiného nebo se na ni někdo
  dívá. Jinak skončí po 8 s (0195 bod 14).
- **Zavřít** v Přehledu zavře kartu všem po 8 s, i drženou. Pracuje-li v ní agent, nejdřív
  varuje.
- **Selhané čtení.** Dnes nasazený hub (F47 bod 5): když mu selže čtení držení, nezavře žádnou
  kartu, ani když nejde přečíst jediný soubor. Rozhodnutý cíl (dodatek 0191 z 2026-10-12, bod
  32), který přinese Lazurio/LazurioPlatform#347:
  - nečitelný soubor držitele zastaví jen karty, které držel při svém posledním přečtení;
  - ostatní karty končí dál a `lazurio doctor` nečitelný soubor hlásí;
  - soubor, který od startu hubu přečíst nešel, nedrží nic, co by hub znal, protože hub poslední
    přečtení neukládá;
  - adresář, který nejde přečíst, dál zastaví ukončování všech karet.

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
3. **Drží, co ukazuje.** Tvary definuje smluvní modul LazurioPlatform `src/browser/contract/`
   (F50; dřív `holds.ts`, F47 bod 4, kroky 1–2) a jeho vektory. Kdo je vlastní a od kterého
   vydání, říká [tabulka smluv](#tabulka-smluv-prohlížeče).
   - **Čas na boot clock** je `{"boot": "<boot_id>", "at": <sekundy od bootu>}`. Čte se z
     `/proc/sys/kernel/random/boot_id` a z prvního čísla `/proc/uptime`, nikdy ze systémových
     hodin.
   - **Soubor držitele, který čte hub.** Server aplikace zapisuje pro každou lištu jeden soubor
     `<lišta>.json`. Hub z něj čte jen tuhle část:

     ```json
     {"strip": "<lišta>", "label": "<název lišty>", "tabs": ["<id karty>"]}
     ```

     - `strip` se musí shodovat s názvem souboru a počítají se jen id cílů DevTools.
     - Soubor se zapisuje atomicky (dočasný soubor a přejmenování), s právy 0600 v adresáři 0700.
     - Lišty jsou `launchpad` a `t3-<vlákno>`; `t3-<vlákno>` je zároveň sezení agenta vlákna.
     - Soubor nese i `"schema": "lazurio.browser-holder.v1"` a `"contract"`, vydání Platformy
       svého zapisovatele (Launchpad od v0.1.8-rc.61). Soubor bez `schema` je v1 a hub ho čte
       dál; soubor jiného majoru hub nepřečte a `lazurio doctor` ho hlásí.
   - **Čas záznamu, který čte jen aplikace sama.** Ke každé kartě si aplikace drží čas, kdy ji
     do lišty přidala. Čas přečte z boot clock v té chvíli a uloží ho spolu s kartou.
     - Launchpad i T3 Code ho ukládají do svého souboru držitele jako další pole
       `"recordedAt": {"<id karty>": {"boot": "…", "at": …}}`, které hub ignoruje.
     - Soubor držitele je jediné úložiště karet lišty, takže databáze T3 Code zůstává
       upstreamová (návrh úkolu 501, Matěj 2026-10-12).
     - Karta bez času se počítá jako zaznamenaná dávno.
   - **Seznam živých karet, který zapisuje hub.** `tabs.json` je
     `{"tabs": ["<id karty>"], "takenAt": {"boot": "…", "at": …}}`, kde `takenAt` je chvíle,
     kdy hub snímek začal, a od v0.1.8-rc.61 i `"schema": "lazurio.browser-tabs.v1"`. Seznam
     jiného majoru se počítá jako žádný seznam, takže se nic nepustí.
   - **Srovnání.** Aplikace se se seznamem srovná:
     - při startu;
     - při každé jeho změně (sleduje ho a čte znovu každých 30 s);
     - před zápisem souboru držitele.
   - **Kdy kartu pustí** (pravidlo `keptTabs`):
     - seznam z jiného bootu ignoruje;
     - kartu, kterou seznam obsahuje, drží dál;
     - kartu, kterou seznam postrádá, pustí jen tehdy, když `takenAt` je pozdější než její čas
       záznamu, protože snímek začatý po záznamu by živou kartu obsahoval;
     - kartu zaznamenanou ve stejnou chvíli nebo později drží.
4. **Pouští, co skončilo.**
   - × v liště kartu z této lišty odebere a pustí ji, s nabídkou Vrátit. Karta zůstane, dokud ji
     potřebuje agent, jiné místo nebo divák, a dokud existuje, je v Přehledu.
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

## Tabulka smluv prohlížeče

Programy, které se v prohlížeči Environmentu potkávají, se domlouvají sedmnácti smlouvami
C1–C17 z rozhodnutí F50 v LazurioPlatform `docs/decisions.md`. Cílem F50 je, aby jedinou
definicí každé z nich byl smluvní modul Platformy `src/browser/contract/` a pravdou jeho vektory
(`vectors/v1/`). Dnes modul a vektory pokrývají C1–C7; C8–C17 definuje F50 a do modulu je
přenáší zbytek fáze 1 (úkol 2026-10-12-701). Forky z artefaktu vydání (níže) převezmou jen to,
co modul už nese; u ostatních smluv platí text F50 a sloupec vydání níže. Tabulka říká, kdo
smlouvu vlastní, kdo podle ní zapisuje a čte a od kterého vydání. **Platforma** je
LazurioPlatform, **T3 Code** fork `Lazurio/t3code`, **MausBot** fork `Lazurio/OpenMausBot`
(uveden jen tam, kde se smlouvy dnes dotýká). Stav k 2026-10-14.

| # | Smlouva | Vlastník | Kdo zapisuje a kdo čte | Verze a vydání |
| --- | --- | --- | --- | --- |
| C1 | **Id vzdálené karty:** id cíle DevTools, 32 hexadecimálních číslic, velkými písmeny | Chrome; pravidlo Platforma | Platforma: hub, pohled, Launchpad, Nová karta, CLI; T3 Code: server i web, zatím vlastní kopií | v1, bez `schema`; v modulu od Platformy v0.1.8-rc.61 |
| C2 | **Jména lišt a sezení:** `[A-Za-z0-9_-]{1,64}`, lišty `launchpad` a `t3-<vlákno>`, prefixy `codex-`, `claude-` a `bot-` (vyhrazený MausBotu) | Platforma (gramatika a registr prefixů); T3 Code svá jména `t3-…`; agent-browser sezení démona | Platforma: hub, Launchpad, CLI (`threadSession`); T3 Code: sezení vláken, které gramatice odpovídají; MausBot pojmenovává sezení `bot-<id>` a `guest-<uuid>`, která gramatice běžně odpovídají; hub přeskočí jen jméno, které ji poruší (například s tečkou nebo delší než 64 znaků) | v1; v modulu od v0.1.8-rc.61 |
| C3 | **Adresa pohledu a jeho Environment:** `https://browser.<base>.lazurio.io/t/<id>`, holý origin otevře novou kartu, `<base>` je id Environmentu (`environmentIdOf`) | Platforma | Zapisuje pohled a hub; čte Launchpad (panel, Nová karta), shell a pohled; T3 Code: server i web, každý vlastní kopií | v1; přísný tvar bez portu, přihlašovacích údajů, query, fragmentu a koncového lomítka mají všichni čtenáři Platformy od v0.1.8-rc.61; T3 Code čte týž tvar vlastní kopií, navíc bere i `/T/<ID>` |
| C4 | **Hodiny bootu:** `{"boot": "<boot_id>", "at": <sekundy>}` z `/proc` | Platforma | Platforma: hub a Launchpad; T3 Code: server, kopií | v1; od v0.1.8-rc.51, T3 Code od 0.0.45-lazurio.8 |
| C5 | **Soubor držitele:** `$XDG_RUNTIME_DIR/lazurio-browser/holders/<lišta>.json` | Formát Platforma; každý soubor aplikace, které lišta patří | Zapisují Launchpad (`launchpad.json`) a T3 Code (`t3-<vlákno>.json`); čtou hub, `lazurio doctor` a T3 Code (cizí soubory kvůli „drží i…“) | `lazurio.browser-holder.v1`; hub čte od v0.1.8-rc.51, nečitelný soubor drží jen své karty od rc.57, `schema` a `contract` (vydání Platformy zapisovatele) zapisuje Launchpad od rc.61; T3 Code zapisuje od 0.0.45-lazurio.8 zatím bez `schema`, což se čte jako v1 |
| C6 | **Seznam živých karet a srovnání:** `$XDG_RUNTIME_DIR/lazurio-browser/tabs.json` a pravidlo `keptTabs` | Hub Platformy | Zapisuje hub; čtou Launchpad a T3 Code (server) | `lazurio.browser-tabs.v1`; od v0.1.8-rc.51, `schema` od rc.61; T3 Code čte od 0.0.45-lazurio.8 |
| C7 | **Soubory sezení agent-browseru a limit nečinnosti:** `<sezení>.target`, `.pid`, `.sock`, `idleTimeout` v `~/.agent-browser/config.json` | Fork `Lazurio/agent-browser` | Píše agent-browser; čtou hub, `lazurio browser done` a T3 Code (vazby vlákna, ukončení démona při archivaci); limit hodiny zapisuje Platforma; MausBot spouští démony s vlastním `AGENT_BROWSER_CONFIG`, takže limit Platformy na ně nedosáhne | Tvar vydání agent-browseru, které připínají Machines; limit od Platformy v0.1.8-rc.51, ukončení přes socket démona (`lazurio browser done`) od rc.58 |
| C8 | **Zprávy pohledu aplikaci:** `lazurio-browser:info`, `lazurio-browser:new-tab`, `lazurio-browser:closed` | Pohled Platformy | Posílá pohled; čtou panel Launchpadu a T3 Code (web) | v1 bez `v`, chybějící `v` znamená v1; `info` a `new-tab` od v0.1.8-rc.38, `closed` od rc.51; T3 Code čte `info` a `new-tab` od 0.0.45-lazurio.5, `closed` od lazurio.8; `"v": 1` a jedno pravidlo čtení přinese zbytek fáze 1 |
| C9 | **Identita a prvek `<lazurio-environment>`:** dotaz `lazurio-browser:identity-request` a odpověď `lazurio-browser:identity`; atributy `environment`, `lang`, `space` | Shell Platformy (rozhraní v1) | Ptá se pohled; odpovídá shell v aplikaci (Launchpad, T3 Code); prvek ukazuje T3 Code; forky shell načítají za běhu z `/.lazurio/shell.js` Environmentu, MausBot také | Rozhraní shellu v1; od v0.1.8-rc.55; T3 Code ukazuje prvek od 0.0.45-lazurio.8; `lang` a `majors` v odpovědi přinese zbytek fáze 1 |
| C10 | **Rozhraní Nové karty:** `<lazurio-new-tab strip tools focus-address lang>` a událost `lazurio-new-tab` | Shell Platformy (rozhraní v1) | Prvek a stránku `/new-tab` dodává Platforma; vkládají ho Launchpad a T3 Code (web) | Rozhraní shellu v1; od v0.1.8-rc.51; T3 Code od 0.0.45-lazurio.8; registr id nástrojů s ikonami přinese zbytek fáze 1 |
| C11 | **Loopback API hubu:** `/.lazurio/tabs…` | Hub Platformy | Volá jen Launchpad a `lazurio browser link --url`; žádný fork ho nevolá a forkům se nedodává | Vnitřní smlouva Platformy, obě strany v jednom vydání |
| C12 | **Trasy pohledu v Launchpadu:** `/.lazurio/browser.json`, `/.lazurio/browser` | Launchpad Platformy | Čtou panel Launchpadu a `lazurio browser`; T3 Code 0.0.45-lazurio.7 se ptal `?session=`, lazurio.8 už ne | Vnitřní; větev `?session=` zůstane, dokud lazurio.8 není všude |
| C13 | **`lazurio browser … --json`:** odpovědi `window`, `link` a `done` | CLI Platformy | Volají agenti a T3 Code (server: deklarace prohlížeče `link --json`, okno vlákna `window --json`) | Zatím bez `schema`; `window` a `link` od v0.1.8-rc.31, `done` a `link --url` od rc.58; T3 Code volá `link` a `window` od 0.0.45-lazurio.5; `"schema": "lazurio.browser-cli.v1"` a vlastní `kind` i bez prohlížeče přinese zbytek fáze 1 |
| C14 | **Časy a meze:** lhůty hubu (8 s po posledním držení, 30 s po posledním divákovi, 10 min), Vrátit, port DevTools 9222, okno 1280×900 | Hub Platformy | Opisují je ručně Launchpad (Vrátit 8 s) a T3 Code (Vrátit 7 s, 9222, 1280×900) | Konstanty modulu a Vrátit 7 s všude přinese zbytek fáze 1; v1 nikdy nezkrátí lhůtu, na kterou jiný program spoléhá |
| C15 | **Rámování:** atributy rámu a `frame-ancestors` pohledu a Nové karty | Pohled Platformy; Launchpad pro Novou kartu | Rámují Launchpad (`referrerpolicy="no-referrer"`) a T3 Code (`origin`) | v1; jednu sadu atributů s `referrerpolicy="origin"` přinese zbytek fáze 1 |
| C16 | **Vstup adresního řádku:** co otevře text napsaný do lišty pohledu a do Nové karty | Platforma | Lišta pohledu, Nová karta, hub (jen http(s) a `about:blank`) a `lazurio browser link --url` | v1; adresu pohledu čte Nová karta jako Chrome od v0.1.8-rc.61; jedno pravidlo pro obě lišty přinese zbytek fáze 1 |
| C17 | **Jazyk:** jazyk shellu všude, jazyk prohlížeče jen u pohledu otevřeného samostatně | Shell Platformy | Pohled a Nová karta; T3 Code (jeho overlay mluví jazykem prohlížeče) | `lang` v odpovědi identity přinese zbytek fáze 1, prvek karty prohlížeče úkol 2026-10-12-704 |

**Verze.** Dokument nese `schema`, zpráva `v`; co je nemá, je v1 navždy. Uvnitř v1 smlouva jen
roste: vydání smí přidat členy, hodnoty, zprávy a případy a přijmout, co dřív odmítlo, nikdy
nic neodebere, nepřejmenuje ani nezúží a nezkrátí lhůtu, na kterou jiný program spoléhá. Major
změnu rozhoduje dodatek F50 a ohlásí se nejdřív v runboocích forků. Vydání aplikace, které
potřebuje novou část Platformy, vyjde až poté, co vydání Platformy, které ji přináší, běží na
všech Environmentech s prohlížečem (F50 bod 7).

**Smluvní modul pro forky.** Artefakt vydání Platformy `lazurio-shell.tar.gz` nese modul pod
`browser-contract/`: obě části jako ES moduly s deklaracemi, vektory a vlastní licenci MIT.
`artifact.json` ho uvádí v `browserContract` (major 1) a každý soubor s jeho SHA-256 v `files`;
vše kryje jedna atestace vydání. Přináší ho Lazurio/LazurioPlatform#404, takže ho nese první
vydání Platformy po jeho sloučení. Fork ověří jeden přesný tag podle dodatku F50 bodu 5
z 2026-10-14: atestace `release.yml` s neměnnými id repozitáře a vlastníka, jen uvedené obyčejné
soubory, každý digest, `LICENSE` a `NOTICE` vedle souborů a `provenance.json`. T3 Code modul
převezme v úkolu 2026-10-12-703, MausBot až v úkolu 2026-10-05-510.

## Aplikace po jedné

### Launchpad

- **Lišta** ukazuje karty, které drží Launchpad (`holders/launchpad.json`, 0195 bod 13):
  - karty, které v něm člověk otevřel z Nové karty, adresou nebo výběrem z Přehledu;
  - nové karty stránek zobrazených v něm.
- **„+“** otevře Novou kartu bez nástrojů a s adresním řádkem připraveným k psaní. Když je
  lišta prázdná, panel ukáže Novou kartu.
- **× na liště** kartu pustí. Zavřít všem jde v Přehledu.
- **Přehled** čte paměť Environmentu, karty a Moduly jen tehdy, když je Nová karta vidět. Paměť jedné karty
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
- **Okno agenta** se do lišty dostane samo, ať agent pracuje přes nástroje T3, nebo přes
  `agent-browser`. Panel se sám otevře, když agent otevře kartu nebo nové okno, ne při každém
  kliknutí (0195 bod 15).
- **Pořadí:** nové karty vlákna mají na všech zařízeních stejné pořadí. Místo existující karty si
  drží každé zařízení a karty jde přetahovat. Do v0.0.45 se přetahování přenáší z upstreamu
  (#17730), v 0.0.46 je upstreamové.
- **Zavření poslední karty** panel zavře, jako to dělá upstream.
- **Desktopová aplikace** T3 Code na lokálním Environmentu dál používá vlastní prohlížeč
  počítače, na kterém běží. Připojená k Remote Environmentu, který prohlížeč deklaruje, má
  v pravém panelu ukazovat karty vlákna z prohlížeče Environmentu (dodatek 0191 z 2026-10-12,
  bod 30). Dnes tam ještě ukazuje vlastní prohlížeč počítače; změnu přinese refaktor.
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
- Nová karta je pro něj samostatná stránka `launchpad.<…>/new-tab`. Výběr existující karty ji
  jen otevře ve stejném okně. Stránky otevřené odtud a stránky, které agent mimo T3 Code otevře
  pro člověka, nikdo nedrží: žijí, dokud se na ně někdo dívá, a skončí 30 s po posledním
  divákovi (dodatek 0191 z 2026-10-12, bod 29). Codex Desktop nemá lištu ani ×, kterými by je
  člověk pustil;
- okno agenta Codexu drží jen práce agenta a to, že se na ně někdo dívá. Vlákna Codexu Lazurio
  nevidí, takže je nedrží. Na konci ho agent pustí (bod 28) a hub ho ukončí, až se na ně nikdo
  nedívá.
  - Agent přestal pracovat, když okno pustí nebo když jeho démon skončí po hodině bez příkazu
    podle limitu, který nastaví Platforma, pokud si člověk v nastavení agent-browseru nezvolil
    jiný.
  - Bez limitu démon připojený k prohlížeči sám nekončí.

### agent-browser (fork `Lazurio/agent-browser`)

Na `agent-browser` stojí tato smlouva:
- připojení ke sdílenému prohlížeči přes `--cdp 9222`;
- sezení pro vlákno;
- vazba sezení na kartu (`<sezení>.target`), která přežije restart démona;
- `<sezení>.pid`, který démon při skončení smaže;
- připnutá karta;
- limit nečinnosti démona z jeho uživatelského nastavení (`idleTimeout` v
  `~/.agent-browser/config.json`).
  - Platforma tam zapíše hodinu (`"1h"`), jen když tam člověk nemá vlastní limit, a jeho volbu
    nepřepisuje.
  - Nastavení, které nejde přečíst, není objekt JSON nebo není obyčejný soubor (třeba odkaz),
    nechá Platforma být. Démon pak limit mít nemusí a sám neskončí (#533).
  - Výchozí limit agent-browseru prohlížeč připojený přes DevTools vynechává
    (`blocks_default_idle_shutdown`). Bez limitu v nastavení by démon sám nikdy neskončil.
  - Po vypršení se démon jen odpojí, kartu nezavře; o jejím konci dál rozhoduje hub.

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
   - Body napojení v upstreamových souborech musí být malé, pokryté testy smlouvy a uvedené
     v allowlistu `allowed_upstream_changes` fork CI (`lazurio-fork-ci.yml`).
   - Každá schopnost prohlížeče má řádek v tabulce kapitoly „Overlay“ runbooku forku
     (`docs/operations/lazurio-fork-release.md`): commit, proč ho Lazurio potřebuje, a kdy
     zůstane nebo odpadne. Patří sem:
     - soubory držitelů a jejich srovnání;
     - Nová karta;
     - zprávy pohledu;
     - náhledové nástroje;
     - odkazy jiných Environmentů;
     - uvolnění po archivaci.
   - Při každé přestavbě na nový upstream stable tag (kapitola „Přestavba na nový upstream
     tag“ runbooku) se každý commit overlaye přenese podle záměru. Overlay se zmenší o všechno, co
     už umí upstream.
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

- Refaktor podle dodatku 0191 z 2026-10-12 (body 28–35), který plánují DEV-6656 a DEV-6646:
  - jeden smluvní modul Platformy s testovacími vektory, který forky převezmou ověřený místo
    ručních kopií: modul s vektory pro C1–C7 je ve vydání v0.1.8-rc.61 a artefakt vydání ho
    nese od Lazurio/LazurioPlatform#404; zbývá převést do něj C8–C17 a zápis souboru držitele
    a nechat ho převzít T3 Code (úkol 2026-10-12-703);
  - prvek shellu pro kartu prohlížeče, společný Launchpadu, T3 Code a MausBotu;
  - `lazurio browser done` a stránky pro člověka bez držení;
  - nečitelný soubor držitele zastaví jen svou aplikaci (soubor, který od startu hubu přečíst
    nešel, nedrží nic, co by hub znal);
  - jeden jazyk povrchů;
  - MausBot jako poslední.
- Viditelné označení cizího Environmentu a karty z jiného Environmentu, například červeným
  rámečkem (bod 35): zatím jen směr pro návrhy rozhraní.
- Uspávání karet a jeho mechanismus (DEV-6656 spike 916).
- Nastavení doby nečinnosti okna agenta a strategie zavřít, nebo uspat v Nastavení Launchpadu
  (Matěj 2026-10-11; DEV-6656 úkol 943, čeká na spike 916). Do té doby karty vlákna, které stojí,
  ale není archivované, drží jeho lišta.
- Jména lidí u karet: přijdou s účty Lazuria (0192). Přihlášení přes bránu identitu neříká.
- Plocha a Computer Use (druhá vlna 0191).
- Jak při refreshi na stable 0.0.46 napojit serverový prohlížeč upstreamu na prohlížeč
  Environmentu: buď ho fork vypne, nebo ho nasměruje na DevTools na 9222.
