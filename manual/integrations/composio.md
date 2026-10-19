# Composio: snadná cesta Integrací přes server třetí strany

Stav k 2026-10-09: Composio je jedna ze tří cest Integrací (rozhodnutí 0162,
dodatek z 2026-10-09). Připojí jedním klikem mnoho aplikací, ale jde přes
server Composia a s vlastním účtem člověka. Zapíná se a přihlašuje
v Nastavení Launchpadu → Nástroje (sekce vydaná v LazurioPlatform 0.1.8).
Přímou cestu z Environmentu drží Executor 1 ([executor.md](executor.md)).
Tento runbook popisuje model Composia.

## Model

- O napojení rozhoduje operátor Environmentu. Je volitelné a nic se centrálně
  nevynucuje.
- Operátor Composio povolí v Nastavení Launchpadu a přihlásí svůj účet přes
  prohlížeč, stejně jako `gh`. API klíč se nikdy nekopíruje.
- Agenti používají příkazovou řádku `composio`. Její aktivace se propíše do
  instrukcí Lazurio Folderu té mašiny.
- Aplikaci operátor připojí odkazem, který mu vrátí Launchpad nebo agent, a
  přihlásí se přímo do ní.

## Účet a organizace (dodatek 0162 z 2026-10-13)

Připojené aplikace patří u Composia účtu a jeho organizaci, ne mašině. Dvě
mašiny přihlášené stejným účtem a organizací vidí stejná připojení.

- Každý člověk má výchozí jeden svůj účet Composia, přihlášený přes GitHub.
  Další účet si založí, jen když jiné Prostředí potřebuje jiné přihlašovací
  údaje (viz níže).
- V něm má pro každou Organizaci Lazuria jednu vlastní organizaci se stejným
  jménem, ve které nikdo jiný není, a výchozí organizaci, kterou Composio
  založilo při registraci.
- Environment Organizace pracuje v organizaci se jménem své Organizace.
  Composio ve jménu dovolí jen písmena, číslice a podtržítka, takže jméno se
  porovnává bez ohledu na velikost písmen, diakritiku a všechny znaky kromě
  písmen a číslic („Human and Machine“ odpovídá `humanandmachine` i
  `Human_and_Machine`). Launchpad ji nastaví sám (`composio orgs switch`), aby
  v ní pracovali i agenti.
- Chybí-li taková organizace, Launchpad ukáže jeden krok: jméno ke
  zkopírování v tvaru, který Composio přijme (např.
  „LazurioExampleOrganization“), a animaci cesty v dashboardu Composia. V něm
  máte vlevo nahoře vybrané „FOR YOU“, vlevo dole otevřete kartu organizace,
  zvolíte „Create Org“ a ve formuláři „Create Organization“ jméno vložíte. Že organizace vznikla, Launchpad pozná sám a přepne do ní (dodatek
  0162 z 2026-10-17). Composio organizaci jinak založit neumí; Lazurio ho
  požádalo o rozhraní (ComposioHQ/composio#4949).
- Dokud organizace chybí, Composio dál pracuje v organizaci, kterou máte
  vybranou, takže nic, co už máte připojené, nepřestane fungovat. V nové
  organizaci aplikace připojíte znovu; přejmenováním stávající organizace na
  jméno Organizace zůstanou připojení zachovaná.
- Nejde-li přečíst jméno Organizace Environmentu (rozbitý Folder), přes
  Composio se v něm nic nepřipojí ani neodpojí, dokud se to neopraví.
- Osobní Environment používá výchozí organizaci účtu; vybíráte ji při
  přihlášení v Nastavení → Nástroje.
- Do své organizace Composia nikoho nezvete. Sdílené organizace se zvanými
  lidmi, API klíči a sdílením se nedělají: dělaly by nepořádek a ostatní by
  viděli vaše volání. Lazurio nedrží žádný klíč organizace Composia.
- Co v organizaci připojíte, používají agenti (Chat, Apps i Automate) ve
  vašem Prostředí té Organizace.
- Potřebuje-li jiné Prostředí téže Organizace jiné přihlašovací údaje (jiný
  Gmail, jiné účty), přihlaste se v něm do Composia samostatným účtem. Tři
  Prostředí s různými přihlašovacími údaji tedy znamenají tři účty Composia,
  každý se svou organizací jména Organizace (dodatek 0162 z 2026-10-17).

## V modelu Integrací (dodatek 0162 z 2026-10-09)

- Integrace má v Environmentu jednu cestu: nástrojem, přímo přes Executor,
  nebo přes Composio. Přímo se připojuje, kde je to stejně snadné; Composio
  zbývá pro aplikace, které přímo jednoduše nejdou (třeba Google
  a Microsoft bez firemní aplikace, Salesforce nebo Zoom).
- Zda se Composio smí používat, rozhoduje na pracovních Environmentech
  Organizace v nastavení Organizace (rozhodnutí 0194): nová Organizace ho
  má vypnuté, Organizace, které ho už používají, zapnuté. Na osobním
  Environmentu rozhoduje člověk sám a Composio je tam snadná výchozí cesta.
- Organizace, které Composio používají, nic nemigrují a nikdo se
  nepřipojuje znovu.
- Composio nemá žádné režimy. Firemní Composio organizace s projektem na
  Environment ani broker se nestaví (dodatek 2026-10-08 je v tomto
  zrušený).
- Lazurio instaluje CLI Composia ze svého forku `Lazurio/composio`:
  instalátorem Composia z forku, připnutým na commit, v připnuté verzi
  a s připnutým otiskem SHA-256 archivu; instalátor jiný archiv nebo
  chybějící kontrolní součet odmítne dřív, než cokoli nahradí. Proti
  upstreamu umí sestavení odpojit účet bez dotazu
  (`composio connections remove <účet> --yes`) a ve výpisu připojení ukazuje
  id, alias a e-mail nebo login účtu. Až to upstream vydá po svém, Lazurio se
  vrátí k oficiálnímu sestavení.
- Platí to od vydání LazurioPlatform, které nese LazurioPlatform #395 a #403,
  a jen na Environmentu, který to vydání má. Sestavení na Environment přijde
  instalací Composia, nebo tlačítkem Aktualizovat v Nastavení → Nástroje;
  dokud na Environmentu běží CLI Composia bez `--yes`, Integrace Odpojit
  nenabízí a účty bez aliasu se jmenují „účet“. S tímto sestavením nabízí
  Apps → Integrace Odpojit i u vypršelého nebo nedokončeného pokusu a účty
  pojmenuje.
- Katalog Integrací nemá všechny aplikace Composia. Od téhož vydání otevře
  Apps → Integrace → „Aplikace v Composiu“ sekci Apps v organizaci Composia
  tohoto Environmentu, kde člověk chybějící aplikaci připojí. Připojený účet
  pak Integrace ukážou i mimo katalog (třeba Wispr Flow) a agenti ho najdou
  v `lazurio integrations list`.
- Composio účet může mít víc organizací a CLI vidí jen tu, do které je
  přihlášené. Launchpad proto u composia ukazuje organizaci Composia
  a připojuje aplikace do ní; připojení z webu Composia v jiné organizaci
  agent nevidí. Na Environmentu Organizace je to organizace jejího jména;
  dokud ji člověk nemá, ta, kterou má vybranou, a `lazurio integrations list`
  to agentům řekne (viz Účet a organizace výše). Agent proto stav organizace
  čte tam, než přes Composio začne pracovat.
- Všechno, kam je Environment přihlášený, mají vždy všichni jeho agenti
  i boti. Uvnitř Environmentu se přístupy nedělí; jiné přístupy znamenají
  další Environment.
- V Týmovém Prostředí se do Composia přihlašuje týmový účet Composia, nikdy
  osobní účet některého člověka: co se v něm připojí, používá každý z Teamu.
  Je to samostatný účet a jeho organizace nese jméno Organizace stejně jako
  v osobním účtu (dodatek 0162 z 2026-10-19).

## Co agent smí

- S napojenou aplikací dělat vše, co nabízí, tedy číst, zapisovat i mazat,
  pokud operátor rozsah neomezil.
- Navenek viditelný zápis provést jen na pokyn Operátora.
- Připojení účtu zprostředkovat operátorovi odkazem; přihlašovací údaje nikdy
  nedrží a nikam je nezapisuje.
- Na mašině s více Organizacemi volit nástroj Organizace, pro kterou pracuje,
  a data mezi Organizacemi nepřenášet.
- Integraci nepřipojovat sám a Composio nezřizovat, kde zapnuté není:
  poslat člověku odkaz na kartu v Apps → Integrace, a chybí-li aplikace
  v katalogu, na „Aplikace v Composiu“ tamtéž (od vydání s #403). Dokud stránka Integrace
  na Environmentu není, zprostředkovat připojení jen na výslovný pokyn
  člověka odkazem z `composio link`; přihlášení dokončí člověk sám.
- Účet Composia odpojit jen na výslovný pokyn člověka, a jen ten, který
  člověk jmenoval: v Apps → Integrace (⋯ → Odpojit), nebo s připnutým
  sestavením příkazem `composio connections remove <id> --yes` s id
  z `composio connections list`.

## Alternativy pro operátora

- Přímé Integrace a vlastní MCP servery v Executoru
  ([executor.md](executor.md)).
- Nástroje pro jednu aplikaci z výběru Launchpadu.

## Otevřené otázky

Issues v `Lazurio/LazurioPlatform`: #39 zápisy a omezení rozsahu, #40 custody
dat a region, #41 cesta pro agenty, #42 vlastní instalace, #43 spravovaná
versus vlastní OAuth aplikace, #44 model napojení.
