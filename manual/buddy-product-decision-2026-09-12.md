# BUDDY-2026-09-12 — cílový model Lazurio Buddy

## Schválené upřesnění Ownera a Mašiny

Schválený společný tvar je `<aplikace>.<mašina>.<owner-slug>.lazurio.io`. Owner je GitHub User nebo GitHub Organization, nikoli správce infrastruktury; model ukládá typ `user` / `organization`, stabilní GitHub ID a aktuální login. `owner-slug` přesně zrcadlí GitHub login. Počet hostovaných osobních Mašin na uživatele a případná rezervovanost názvu `personal` jsou znovu otevřeným rozhodnutím Principála. Varianta jedné hostované osobní VM/Personalspace na uživatele (s více přístupovými laptopy) a více Mašin až pod Organizací je návrh, nikoli schválený singleton. Dashboard cardinalitu zatím nesmí vydávat za uzavřený kontrakt. Pilot jedné osobní VM se nemění. Přejmenování loginu a migrace adres zůstávají otevřené. DNS neposkytuje oprávnění ani veřejný přístup; platí osobní WireGuard, autentizace a GitHub autorita. Osobní VM nehostí org repozitáře; práce v nich probíhá přes SSH na org Mašinách. T3 Code není tímto prohlášen za nasazený a neblokuje první milník WireGuard + SSH/Codex.

Datum rozhodnutí: 2026-09-12. Stav: přijatý produktový směr Principála, implementace vyžaduje ověření. Tento samostatný identifikátor nemění obsah historického rozhodnutí 0080.

## Rozhodnutí a rozsah

Lazurio Buddy je jeden osobní produkt tvořený Hermesem, gbrainem a Lazurio rootem. Zákazník volí správu poskytovatelem nebo vlastní správu. Každý Buddy má samostatnou Mašinu jednoho lidského vlastníka a používá jeho účty; fyzický provozovatelský host může obsahovat více oddělených zákaznických VM. Vyšší oprávnění provozovatele hostu tím nezanikají.

Tento záznam nahrazuje **pouze cílové omezení umístění** z rozhodnutí 0080: vedle vlastní VPS je možná izolovaná zákaznická VM na hostu provozovatele nebo zákazníkův hardware. Starší 0080 zůstává přesným popisem původního VPS-only rozhodnutí a reference na něj nesmějí dokazovat nové umístění. Nasazené manifesty, piny a ověřené instalace dál dokazují aktuální stav.

Lokální profilový mount není runtime ani instalační fallback. Buddyho Personalspace zůstává osobní, není sdílený organizační workspace. Přechod cílového modelu neautorizuje změnu cizích účtů, živého hostu ani kopírování privátních dat.

## Přístup a instalace

Osobní tailnet byl návrhem z 12. září; aktuální rozhodnutí z 20. září níže jej pro nový cílový model nahrazuje osobním WireGuardem a odděleným org SSH přes Conglomerate Headscale. Existující instalace se nemigrují pouhým zápisem dokumentu. Síťová dosažitelnost, GitHub oprávnění a mandát pro operaci jsou odlišné věci.

Výchozí instalační směr používá oficiální Hermes, gbrain a Lazurio root. Povinný Zulip ani Buddy Lite nejsou cílovou produktovou variantou. Dosavadní fork a komunikační konfigurace zůstávají implementační proveniencí do ověřené migrace.

## Důsledky a ověření

Odkazy popisující původní VPS baseline mohou dál citovat 0080; nové obecné umístění musí citovat tento záznam. Consumery jsou [hosted-access manuál](hosted-buddy-vps.md), [mapa rootu](../MAP.md),
[root instrukce](../AGENTS.md) v hranici Personalspace a orientaci před prací
a [Personalspace kontrakt](../personalspace/README.md) včetně budoucího bindingu. Cílový návrh nezaručuje bezchybnost hypervizoru ani sítě. Detailní obnova, přenos instalace a aplikačních dat, ceny a SLA zůstávají otevřené. Samotné přijetí dokumentace neprokazuje hotovou instalaci ani migraci.

## Upřesnění 2026-09-20 — Hosted Buddy je produkt 1

Hosted Buddy je osobní VM lidského Operátora s Hermes agentem v roli Buddyho. Operátor v tomto produktu znamená Principála a osobního Ownera, nikoli provozovatele fyzického hostitele nebo novou IAM roli. Osobní VM drží pouze Personalspace, Buddyho, osobní Gbrain, identity a koordinaci. Organizační klony a pracovní běhy patří na Organization-owned Mašiny přidělené člověku.

Mac → osobní VM používá od začátku finální WireGuard a SSH/Codex. Osobní → org SSH používá Tailscale klienty a Headscale na Conglomerate Hostu. Společný tailnet nesmí udělit přístup k nepřidělené Mašině: nová org→osobní a cross-org spojení jsou zakázána, odpovědi existujícím spojením fungují. Žádné Personalspace mounty, osobní klíče v org VM, agent forwarding, reverse-tunnel bypass ani nekontrolované přenášení org kontextů do osobní paměti. GitHub zůstává autoritou organizačních oprávnění.

Cílový osobní app namespace je `<aplikace>.<mašina>.<owner-slug>.lazurio.io`, například `launchpad.<mašina>.<owner-slug>.lazurio.io`; browser přístup vyžaduje osobní WireGuard. DNS není veřejný přístup ani grant. Reuse stávajícího Dashboard **Workspaces → osobní záložky** pro osobní VM link a Machines pro lifecycle; nevytvářet druhý inventář, UI nebo provisioning. Osobní owner/discovery, DNS/TLS a rename/multiple-Machine podporu musí doložit implementace.

Nejdřív funkční a kvalifikovaný produkt 1. Produkt 2 je navazující zpřístupnění org prostředí přes Dashboard ve stejné cílové platformě. Dosavadní org prostředí mohou sloužit integračnímu ověření, nemusí čekat na přejmenování ani se stát osobními VM. Conglomerate je graf oprávněně dostupných Mašin; Conglomerate Host je konkrétní control-plane role.

Spravovaný dedicated pool u Hetzneru odděluje osobního Ownera, Lazurio host-admina a vyšší provider hranici. Host-admin má technickou moc nad VM; nejde o zero-knowledge záruku. Servisní vstup je samostatný, jmenovitý, scoped, auditovaný a odvolatelný; může fungovat nezávisle na owner laptopu, ale neopravňuje číst privátní obsah. Self-managed alternativa bez automatického Lazurio přístupu, měsíční spravovaný provoz a přenositelnost zůstávají.

Samostatný realizační pilot může nejdřív kvalifikovat základní VM a skutečné Codex SSH přes osobní WG; Hermes/Buddy, paměť, org integrace a plná provozní obnova následují. Základní přístup není dokončený produkt 1. Hardware, OS, kapacita, cena, servisní síťová cesta, backup/recovery a přesný release gate zůstávají otevřené. Machines shaping/Plan/Permit gates se neobcházejí. Tato public-safe projekce neobsahuje pilotní identity a neautorizuje nákup, deployment ani přístupy.
