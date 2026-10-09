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

## Účet Environmentu

Připojené aplikace patří u Composia účtu a jeho organizaci, ne mašině. Dvě
mašiny přihlášené stejným účtem a organizací vidí stejná připojení. Berte
proto přihlášení jako účet Environmentu: kde má mít mašina jiný rozsah,
přihlaste jiný účet nebo jinou Composio organizaci.

## Organizace

Organizace, která chce přehled, si založí vlastní Composio organizaci a žádá
operátory, aby se přihlašovali do ní. Je to samostatně spravovaná služba mimo
Lazurio Dashboard. Lazurio Environment to nevynucuje.

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
  zrušený). Fork `Lazurio/composio` zůstává pro drobné úpravy CLI.
- Composio účet může mít víc organizací a CLI vidí jen tu, do které je
  přihlášené. Launchpad proto u composia ukazuje organizaci Composia
  a připojuje aplikace do ní; připojení z webu Composia v jiné organizaci
  agent nevidí.
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

## Alternativy pro operátora

- Přímé Integrace a vlastní MCP servery v Executoru
  ([executor.md](executor.md)).
- Nástroje pro jednu aplikaci z výběru Launchpadu.

## Otevřené otázky

Issues v `Lazurio/LazurioPlatform`: #39 zápisy a omezení rozsahu, #40 custody
dat a region, #41 cesta pro agenty, #42 vlastní instalace, #43 spravovaná
versus vlastní OAuth aplikace, #44 model napojení.
