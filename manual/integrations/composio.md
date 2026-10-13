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

- Každý člověk má jeden svůj účet Composia, přihlášený přes GitHub.
- V něm má pro každou Organizaci Lazuria jednu vlastní organizaci se stejným
  jménem, ve které nikdo jiný není, a výchozí organizaci, kterou Composio
  založilo při registraci.
- Environment Organizace pracuje v organizaci se jménem své Organizace. Jméno
  se porovnává bez ohledu na velikost písmen, mezery a diakritiku („Human and
  Machine“ odpovídá `humanandmachine`). Launchpad ji nastaví sám
  (`composio orgs switch`), aby v ní pracovali i agenti.
- Chybí-li taková organizace, Launchpad to řekne v Apps → Integrace a odkáže
  do dashboardu Composia, kde ji založíte; Composio organizaci jinak založit
  neumí. Dokud chybí, Composio dál pracuje v organizaci, kterou máte
  vybranou, takže nic, co už máte připojené, nepřestane fungovat. Jakmile ji
  založíte, Launchpad do ní přepne sám a aplikace v ní připojíte znovu;
  přejmenováním stávající organizace na jméno Organizace zůstanou připojení
  zachovaná.
- Nejde-li přečíst jméno Organizace Environmentu (rozbitý Folder), přes
  Composio se v něm nic nepřipojí ani neodpojí, dokud se to neopraví.
- Osobní Environment používá výchozí organizaci účtu; vybíráte ji při
  přihlášení v Nastavení → Nástroje.
- Sdílené organizace Composia se zvanými lidmi, API klíči a sdílením se
  nedělají.

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
  instalátorem Composia z forku, připnutým na commit, a v připnuté verzi;
  na tu ho převede i Aktualizovat v Nastavení → Nástroje. Proti upstreamu umí odpojit účet bez dotazu
  (`composio connections remove <účet> --yes`) a ve výpisu připojení ukazuje
  id, alias a e-mail nebo login účtu. Apps → Integrace proto nabízí Odpojit
  i u vypršelého nebo nedokončeného pokusu a účty pojmenuje. Až to upstream
  vydá po svém, Lazurio se vrátí k oficiálnímu sestavení.
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

## Co agent smí

- S napojenou aplikací dělat vše, co nabízí, tedy číst, zapisovat i mazat,
  pokud operátor rozsah neomezil.
- Navenek viditelný zápis provést jen na pokyn Operátora.
- Připojení účtu zprostředkovat operátorovi odkazem; přihlašovací údaje nikdy
  nedrží a nikam je nezapisuje.
- Na mašině s více Organizacemi volit nástroj Organizace, pro kterou pracuje,
  a data mezi Organizacemi nepřenášet.
- Integraci nepřipojovat sám a Composio nezřizovat, kde zapnuté není:
  poslat člověku odkaz na kartu v Apps → Integrace. Dokud stránka Integrace
  na Environmentu není, zprostředkovat připojení jen na výslovný pokyn
  člověka odkazem z `composio link`; přihlášení dokončí člověk sám.
- Účet Composia odpojit jen na výslovný pokyn člověka, a jen ten, který
  člověk jmenoval: v Apps → Integrace (⋯ → Odpojit), nebo příkazem
  `composio connections remove <id> --yes` s id z
  `composio connections list`.

## Alternativy pro operátora

- Přímé Integrace a vlastní MCP servery v Executoru
  ([executor.md](executor.md)).
- Nástroje pro jednu aplikaci z výběru Launchpadu.

## Otevřené otázky

Issues v `Lazurio/LazurioPlatform`: #39 zápisy a omezení rozsahu, #40 custody
dat a region, #41 cesta pro agenty, #42 vlastní instalace, #43 spravovaná
versus vlastní OAuth aplikace, #44 model napojení.
