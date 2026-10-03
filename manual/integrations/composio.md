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
