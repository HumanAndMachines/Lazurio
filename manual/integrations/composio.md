# Composio: schválený broker pro napojení aplikací

Stav k 2026-09-27: rozhodnutí 0162 je přijaté, implementace v LazurioPlatform
teprve vzniká (plán DEV-6626). Tento runbook popisuje model a pilot; není to
návod k samostatnému zřízení mimo pilot.

## Model

- Přihlášení do aplikace platí pro celý Environment. Jiné přihlášení znamená
  jinou mašinu.
- Jeden projekt Composia na Environment. Klíč projektu leží jen na té mašině.
- Pracovní mašina používá Composio organizaci své Organizace, osobní mašina
  účet Principála.
- „Uživatel“ uvnitř projektu je identifikátor mašiny; operátor žádný Composio
  účet nepotřebuje a přihlašuje se jen do samotné aplikace.

## Custody

- Klíč projektu je secret podle
  [../security/local-secret-custody.md](../security/local-secret-custody.md);
  do Gitu, logu ani chatu se nikdy nezapisuje.
- Klíč celé Composio organizace drží jen Admin mimo pracovní mašiny.
- Odchod operátora nebo zrušení mašiny řeší Admin zrušením klíče nebo projektu.

## Co agent smí

- Napojenou aplikaci číst i do ní zapisovat, pokud operátor nenastavil režim
  jen pro čtení.
- Navenek viditelný zápis provést jen na pokyn Principála.
- Připojení účtu zprostředkovat operátorovi odkazem; přihlašovací údaje nikdy
  nedrží.
- Mimo pilot Composio nezřizovat.

## Pilot DEV-6626

Organizace Spectoda, první aplikace ClickUp, nejdřív jedna pracovní VM a potom
všechny. Konkrétní jména, custody a důkazy zůstávají v owner infra Spectody.

## Otevřené otázky

Issues v `Lazurio/LazurioPlatform`: #38 izolace a klíče, #39 zápisy a omezení
akcí, #40 custody dat a region, #41 cesta pro agenty, #42 vlastní instalace,
#43 spravovaná versus vlastní OAuth aplikace.
