# BUDDY-2026-09-12 — cílový model Lazurio Buddy

## Schválené upřesnění Ownera a Mašiny

Podle root rozhodnutí 0153/0154 má každý Principál právě jednu hostovanou osobní Mašinu. Volitelný lidský Buddy žije přímo na ní; další host ani dočasná či vnořená VM není výjimka. Další Mašiny patří Organizaci. Osobní Mašina je osobní user node v Headscale tailnetu Conglomerate Hostu, nikoli org user nebo tagged device. Laptop i telefon používají stejný Tailscale klient pro SSH/Codex a osobní aplikace; žádná druhá VPN, veřejný per-VM port ani DNAT. Buddy/Personalspace zůstává osobní, organizační klony a běhy patří přiděleným Organization-owned Mašinám přes autorizované SSH. Osobní URL je `<app>.<github-user-login>.lazurio.io`, organizační `<app>.<machine>.<github-org-login>.lazurio.io`. Owner model rozlišuje user/organization a stabilní GitHub ID. Runtime DNS slug vzniká lowercase při založení a zůstává frozen; rename loginu automaticky nepřepojuje DNS. Hostname je case-insensitive; mixed-case a lowercase musí vést ke stejné službě a autorizaci. DNS není grant. Připravenost konkrétního consumera, DNS/TLS a přístupu musí doložit runtime evidence; tento text ji nenahrazuje.

Datum rozhodnutí: 2026-09-12. Stav: přijatý produktový směr Principála, implementace vyžaduje ověření. Tento samostatný identifikátor nemění obsah historického rozhodnutí 0080.

## Rozhodnutí a rozsah

Lazurio Buddy je jeden osobní produkt tvořený Hermesem, gbrainem a Lazurio rootem. Zákazník volí správu poskytovatelem nebo vlastní správu. Každý Buddy má samostatnou Mašinu jednoho lidského vlastníka a používá jeho účty; fyzický provozovatelský host může obsahovat více oddělených zákaznických VM. Vyšší oprávnění provozovatele hostu tím nezanikají.

Tento záznam nahrazuje **pouze cílové omezení umístění** z rozhodnutí 0080: vedle vlastní VPS je možná izolovaná zákaznická VM na hostu provozovatele nebo zákazníkův hardware. Starší 0080 zůstává přesným popisem původního VPS-only rozhodnutí a reference na něj nesmějí dokazovat nové umístění. Nasazené manifesty, piny a ověřené instalace dál dokazují aktuální stav.

Lokální profilový mount není runtime ani instalační fallback. Buddyho Personalspace zůstává osobní, není sdílený organizační workspace. Přechod cílového modelu neautorizuje změnu cizích účtů, živého hostu ani kopírování privátních dat.

## Přístup a instalace

Aktuální síťový kontrakt drží [root decision 0154](decision-register.md): osobní user node v Headscale tailnetu Conglomerate Hostu a jediný Tailscale klient na laptopu i telefonu. Historie zrušeného síťového pilotu je pouze v tomto rozhodnutí. Existující instalace se nemigrují pouhým zápisem dokumentu. Síťová dosažitelnost, GitHub oprávnění a mandát pro operaci jsou odlišné věci.

Výchozí instalační směr používá oficiální Hermes, gbrain a Lazurio root. Povinný Zulip ani Buddy Lite nejsou cílovou produktovou variantou. Dosavadní fork a komunikační konfigurace zůstávají implementační proveniencí do ověřené migrace.

## Důsledky a ověření

Odkazy popisující původní VPS baseline mohou dál citovat 0080; nové obecné umístění musí citovat tento záznam. Consumery jsou [hosted-access manuál](hosted-buddy-vps.md), [mapa rootu](../MAP.md),
[root instrukce](../AGENTS.md) v hranici Personalspace a orientaci před prací
a [Personalspace kontrakt](../personalspace/README.md) včetně budoucího bindingu. Cílový návrh nezaručuje bezchybnost hypervizoru ani sítě. Detailní obnova, přenos instalace a aplikačních dat, ceny a SLA zůstávají otevřené. Samotné přijetí dokumentace neprokazuje hotovou instalaci ani migraci.

## Upřesnění 2026-09-20 — Hosted Buddy je produkt 1

Hosted Buddy je osobní VM lidského Operátora s Hermes agentem v roli Buddyho. Operátor v tomto produktu znamená Principála a osobního Ownera, nikoli provozovatele fyzického hostitele nebo novou IAM roli. Osobní VM drží pouze Personalspace, Buddyho, osobní Gbrain, identity a koordinaci. Organizační klony a pracovní běhy patří na Organization-owned Mašiny přidělené člověku.

Mac → osobní VM používá od začátku finální Headscale a SSH/Codex. Osobní → org SSH používá Tailscale klienty a Headscale na Conglomerate Hostu. Společný tailnet nesmí udělit přístup k nepřidělené Mašině: nová org→osobní a cross-org spojení jsou zakázána, odpovědi existujícím spojením fungují. Žádné Personalspace mounty, osobní klíče v org VM, agent forwarding, reverse-tunnel bypass ani nekontrolované přenášení org kontextů do osobní paměti. GitHub zůstává autoritou organizačních oprávnění.

Cílový osobní app namespace je `<app>.<github-user-login>.lazurio.io`, například `launchpad.<github-user-login>.lazurio.io`; browser přístup vyžaduje osobní přístup přes Headscale. DNS není veřejný přístup ani grant. Reuse stávajícího Dashboard **Workspaces → osobní záložky** pro osobní VM link a Machines pro lifecycle; nevytvářet druhý inventář, UI nebo provisioning. Osobní owner/discovery, DNS/TLS a rename a osobní singleton musí doložit implementace.

Nejdřív funkční a kvalifikovaný produkt 1. Produkt 2 je navazující zpřístupnění org prostředí přes Dashboard ve stejné cílové platformě. Dosavadní org prostředí mohou sloužit integračnímu ověření, nemusí čekat na přejmenování ani se stát osobními VM. Conglomerate je graf oprávněně dostupných Mašin; Conglomerate Host je konkrétní control-plane role.

Spravovaný dedicated pool u Hetzneru odděluje osobního Ownera, Lazurio host-admina a vyšší provider hranici. Host-admin má technickou moc nad VM; nejde o zero-knowledge záruku. Servisní vstup je samostatný, jmenovitý, scoped, auditovaný a odvolatelný; může fungovat nezávisle na owner laptopu, ale neopravňuje číst privátní obsah. Self-managed alternativa bez automatického Lazurio přístupu, měsíční spravovaný provoz a přenositelnost zůstávají.

Samostatný realizační pilot může nejdřív kvalifikovat základní VM a skutečné Codex SSH přes osobní Headscale; Hermes/Buddy, paměť, org integrace a plná provozní obnova následují. Základní přístup není dokončený produkt 1. Hardware, OS, kapacita, cena, servisní síťová cesta, backup/recovery a přesný release gate zůstávají otevřené. Machines shaping/Plan/Permit gates se neobcházejí. Tato public-safe projekce neobsahuje pilotní identity a neautorizuje nákup, deployment ani přístupy.
