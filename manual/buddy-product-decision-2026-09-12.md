# Synchronizace dokumentace osobní Mašiny a Buddyho

Tato stránka je odvozený popis pro root consumery, nikoli decision record nebo roadmapa. Původní cesta souboru zůstává kvůli odkazům. Kanonická pravidla vlastní [rozhodnutí 0153/0154](decision-register.md); historické rozhodnutí 0080 se zde nepřepisuje ani nenahrazuje vlastním identifikátorem.

## Owner, Mašina a DNS

Podle root rozhodnutí 0153/0154 má každý Principál právě jednu hostovanou osobní Mašinu. Volitelný lidský Buddy žije přímo na ní; další host ani dočasná či vnořená VM není výjimka. Další Mašiny patří Organizaci. Osobní Mašina je osobní user node v Headscale tailnetu Conglomerate Hostu, nikoli org user nebo tagged device. Laptop i telefon používají stejný Tailscale klient pro SSH/Codex a osobní aplikace; žádná druhá VPN, veřejný per-VM port ani DNAT. Buddy/Personalspace zůstává osobní, organizační klony a běhy patří přiděleným Organization-owned Mašinám přes autorizované SSH. Osobní URL je `<app>.<personal-dns-slug>.lazurio.io`, organizační `<app>.<machine>.<github-org-login>.lazurio.io`. Owner model rozlišuje user/organization a stabilní GitHub ID. `personal-dns-slug` je lowercase GitHub login zachycený při založení a zůstává frozen; nejde o aktuální mutable login. Schválený creation-time tvar app.github-user-login.lazurio.io se tím nemění. Rename loginu automaticky nepřepojuje DNS. Case-insensitive lookup je pouze kompatibilita existujícího hostname se stejnou autorizací, nikoli zdroj identity nebo nového DNS bindingu. DNS není grant. Připravenost konkrétního consumera, DNS/TLS a přístupu musí doložit runtime evidence; tento text ji nenahrazuje.

## Osobní a organizační hranice

Osobní VM drží Personalspace, volitelného Buddyho, osobní paměť a identity. Organizační klony a pracovní běhy patří přiděleným Organization-owned Mašinám. Síťová dosažitelnost, živé GitHub oprávnění a mandát k operaci jsou odlišné věci. Osobní mounty, předání privátních klíčů, agent forwarding ani reverse tunnel nesmějí obejít tuto hranici. Host admin má technickou kontrolu nad VM; scoped servisní mandát není plošné právo číst osobní obsah.

## Autorita plánu a evidence instalací

Produktové pořadí, dodací etapy a acceptance se čtou z kanonických plánů [DEV-6585](https://github.com/HumanAndMachine-ai/mission-control-data/blob/v3/data/mission-control/plans/2026/09/DEV-6585-buddy-product-and-delivery.yaml), [DEV-6612](https://github.com/HumanAndMachine-ai/mission-control-data/blob/v3/data/mission-control/plans/2026/09/DEV-6612-produkt-jedna.yaml) a [DEV-6614](https://github.com/HumanAndMachine-ai/mission-control-data/blob/v3/data/mission-control/plans/2026/09/DEV-6614-personal-vm-pool-pilot.yaml). Publikují se jedinou Mission Control v3 cestou; tato stránka je neurčuje ani nenahrazuje. Konkrétní provozní stav má vlastní owning evidence.

Starší VPS-only manifesty a bindingy jsou evidence dosavadních instalací. Nejsou automatickým požadavkem nové instalace ani důkazem provedené migrace. Lokální profilový mount není runtime. Pro aktuální osobní host platí jediná Mašina podle 0153 a Headscale podle 0154; historie zrušeného síťového pilotu zůstává pouze v rozhodnutí 0154.

Synchronizovanými consumery jsou [hosted-access manuál](hosted-buddy-vps.md), [mapa rootu](../MAP.md), [root instrukce](../AGENTS.md), [Personalspace kontrakt](../personalspace/README.md), distribuční a provisioning manuály. Žádný z těchto odkazů sám nemigruje instalaci, neuděluje přístup a nepotvrzuje funkční DNS/TLS, zálohu nebo obnovu.
