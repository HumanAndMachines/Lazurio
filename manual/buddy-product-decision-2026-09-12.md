# BUDDY-2026-09-12 — cílový model Lazurio Buddy

Datum rozhodnutí: 2026-09-12. Stav: přijatý produktový směr Principála, implementace vyžaduje ověření. Tento samostatný identifikátor nemění obsah historického rozhodnutí 0080.

## Rozhodnutí a rozsah

Lazurio Buddy je jeden osobní produkt tvořený Hermesem, gbrainem a Lazurio rootem. Zákazník volí správu poskytovatelem nebo vlastní správu. Každý Buddy má samostatnou Mašinu jednoho lidského vlastníka a používá jeho účty; fyzický provozovatelský host může obsahovat více oddělených zákaznických VM. Vyšší oprávnění provozovatele hostu tím nezanikají.

Tento záznam nahrazuje **pouze cílové omezení umístění** z rozhodnutí 0080: vedle vlastní VPS je možná izolovaná zákaznická VM na hostu provozovatele nebo zákazníkův hardware. Starší 0080 zůstává přesným popisem původního VPS-only rozhodnutí a reference na něj nesmějí dokazovat nové umístění. Nasazené manifesty, piny a ověřené instalace dál dokazují aktuální stav.

Lokální profilový mount není runtime ani instalační fallback. Buddyho Personalspace zůstává osobní, není sdílený organizační workspace. Přechod cílového modelu neautorizuje změnu cizích účtů, živého hostu ani kopírování privátních dat.

## Přístup a instalace

Osobní tailnet patří zákazníkovi. Organizační přístup je schvalovaný zvlášť a neznamená tranzit do osobních nebo jiných organizačních sítí. Síťová dosažitelnost, GitHub oprávnění a mandát pro operaci jsou odlišné věci.

Výchozí instalační směr používá oficiální Hermes, gbrain a Lazurio root. Povinný Zulip ani Buddy Lite nejsou cílovou produktovou variantou. Dosavadní fork a komunikační konfigurace zůstávají implementační proveniencí do ověřené migrace.

## Důsledky a ověření

Odkazy popisující původní VPS baseline mohou dál citovat 0080; nové obecné umístění musí citovat tento záznam. Consumerem je hosted-access manuál a mapa rootu. Cílový návrh nezaručuje bezchybnost hypervizoru ani sítě. Detailní obnova, přenos instalace a aplikačních dat, ceny a SLA zůstávají otevřené. Samotné přijetí dokumentace neprokazuje hotovou instalaci ani migraci.
