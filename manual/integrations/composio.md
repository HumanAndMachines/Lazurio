# Composio: volitelné napojení aplikací vlastním účtem

Stav k 2026-10-09: Composio je volitelný nástroj Lazuria. Zapíná se
a přihlašuje v Nastavení Launchpadu → Nástroje na každém Environmentu, kde
ho operátor chce (rozhodnutí 0162, sekce Nastavení vydaná v LazurioPlatform
0.1.8). MCP servery Environmentu spravuje Executor 1
([executor.md](executor.md), dodatek 0162 z 2026-10-09). Tento runbook
popisuje model Composia.

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

## Vedle Executoru (dodatek 0162 z 2026-10-09)

- Composio a Executor se doplňují. Executor spravuje MCP servery
  Environmentu, Composio připojuje aplikace pod účtem operátora.
- Agent hledá nástroj nejdřív v Executoru; co tam není, vezme z Composia.
  Návody Folderu toto pořadí převezmou, až bude Executor v katalogu
  Nástrojů (plán DEV-6626).
- Na stránce Apps → Připojené aplikace jsou záložky Vše a Připojené
  obrazovkou Composia nad účtem přihlášeným v Nastavení. Záložka MCP servery
  je Executor. Stránka teprve vzniká (plán DEV-6626).
- Organizace, které Composio používají, ho mají dál beze změny. Nic se
  nemigruje a nikdo se nepřipojuje znovu.
- Composio nemá žádné režimy. Firemní Composio organizace s projektem na
  Environment, broker ani fork Composio CLI se nestaví (dodatek 2026-10-08
  je v tomto zrušený).
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
- Kde ho operátor nezapnul, Composio nezřizovat. Pro MCP server nabídnout
  Executor, pro ostatní aplikace zapnutí Composia v Launchpadu.

## Alternativy pro operátora

- MCP servery Environmentu v Executoru ([executor.md](executor.md)).
- Další podporované CLI nástroje z výběru Launchpadu.

## Otevřené otázky

Issues v `Lazurio/LazurioPlatform`: #39 zápisy a omezení rozsahu, #40 custody
dat a region, #41 cesta pro agenty, #42 vlastní instalace, #43 spravovaná
versus vlastní OAuth aplikace, #44 model napojení.
