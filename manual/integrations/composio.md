# Composio: doporučená cesta k napojení aplikací

Stav k 2026-10-02: rozhodnutí 0162 je přijaté a sekce Nastavení Launchpadu
Platformy je vydaná (LazurioPlatform 0.1.8). Composio je aktivní součást
Lazuria na každém Environmentu, kde ho operátor zapne a přihlásí v Nastavení
→ Nástroje; pilot DEV-6626 skončil (Matěj 2026-10-02). Tento runbook popisuje
model.

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

## Cíl: dva režimy (rozhodnuto 2026-10-08)

Dodatek k rozhodnutí 0162, plán DEV-6626. Dnes platí model výše; následující
teprve vzniká.

- **Každý operátor svůj účet** je výchozí režim a pro osobní Environmenty
  jediný: model výše. Aplikace se budou připojovat přímo v Launchpadu, v Apps
  → Připojené aplikace, pod přihlášeným Composio účtem.
- **Firemní Composio organizace** je volba Organizace. Každý Environment
  Organizace má vlastní projekt ve firemní Composio organizaci. Projekt
  zakládá, rotuje a maže broker Organizace, který jako jediný drží firemní
  token. Environment drží jen klíč svého projektu. Při předání nebo zrušení
  Environmentu se projekt smaže i s přístupy.
- Agenti i boti používají v obou režimech příkaz `composio`; ve firemním
  režimu je přihlášený klíčem projektu (úprava CLI nabídnutá upstreamu).
- Mapa Conglomerate v Dashboardu ukazuje jen ke čtení, kam který Environment
  sahá; osobní Environmenty vidí jen jejich majitel.
- Všechno, kam je Environment přihlášený, mají vždy všichni jeho agenti i
  boti. Uvnitř Environmentu se přístupy nedělí; jiné přístupy znamenají další
  Environment.
- MCP servery Environmentu se spravují na stejné stránce (záložka MCP servery)
  a platí pro Chat, Apps i Automate.

## Co agent smí

- S napojenou aplikací dělat vše, co nabízí, tedy číst, zapisovat i mazat,
  pokud operátor rozsah neomezil.
- Navenek viditelný zápis provést jen na pokyn Operátora.
- Připojení účtu zprostředkovat operátorovi odkazem; přihlašovací údaje nikdy
  nedrží a nikam je nezapisuje.
- Na mašině s více Organizacemi volit nástroj Organizace, pro kterou pracuje,
  a data mezi Organizacemi nepřenášet.
- Kde ho operátor nezapnul, Composio nezřizovat; nabídnout mu zapnutí
  v Launchpadu.

## Alternativy pro operátora

- Další podporované CLI nástroje z výběru Launchpadu.
- MCP server, který na požádání nastaví agent. MCP servery se do Folderu
  nezapisují.

## Otevřené otázky

Issues v `Lazurio/LazurioPlatform`: #39 zápisy a omezení rozsahu, #40 custody
dat a region, #41 cesta pro agenty, #42 vlastní instalace, #43 spravovaná
versus vlastní OAuth aplikace, #44 model napojení.
