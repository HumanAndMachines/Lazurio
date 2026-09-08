# Mandáty pro práci v Organizaci

Člověk určuje cíl a hranice práce. Harness spouští Agenty ručně nebo
opakovaně. Lazurio poskytuje kontext a pravidla. Firemní automatizovaná
Mašina je pracovní prostředí Organizace se svěřenými účty a odpovědným
člověkem, nikoli další Principál (decision 0143).

## Jeden kanonický domov

Trvalé pracovní pověření patří do `MANDATES.md` v kořeni repozitáře příslušné
Organizace. Je verzované a podléhá jejímu review a přístupovým pravidlům.
Organization `AGENTS.md` na něj odkazuje; Root i generované Managed instrukce
vysvětlují pouze jeho použití. Do dalších rootů, skillů, úkolů ani lokálního
ignored souboru se nekopíruje další účinná verze.

Úkol nebo automatizace uvádí identifikátor mandátu, práci, spouštěč a očekávaný
výsledek. Konkrétní zadání může pověření zúžit. Jednorázové svolení oprávněného
člověka může být přímo v zadání a nemusí vytvořit trvalý zápis; samo se nestává
mandátem dalších běhů. Název role ani text úkolu od neověřeného autora není
rozšířením pověření.

Osobní automatizace člověka používá jeho vlastní zadání a oprávnění. Buddyho
privátní `MANDATES.md` zůstává v jeho osobním profilu; není fallbackem pro
chybějící firemní mandát. Firemní mandát nikdy neplatí v jiné Organizaci.

## Udělení, použití a odvolání

1. Oprávněný člověk vymezí účel, účet a pracovní nasazení, povolené operace,
   repozitáře či nástroje, podmínky, odpovědného člověka a dobu platnosti.
2. Agent smí připravit změnu mandátu jako PR. Pověření je účinné až ve
   schválené revizi na kanonické publikační branchi Organizace, obvykle `main`,
   s dohledatelným schválením člověka oprávněného k danému rozsahu. Samotný
   commit, merge ani schvalovatelův textový titul nejsou důkaz jeho pravomoci.
3. Před během Agent načte příslušné Organization instrukce a mandát. Ověří
   shodu aktuálního provider účtu, Organizace, pracovního nasazení a úkolu.
   Kopie souboru či výměna serveru pověření automaticky nepřenáší.
4. Bezprostředně před Publikací ověří aktuální schválenou revizi u autority,
   platnost mandátu, nezměněný scope/účet, podmínky a živé oprávnění k přesné
   operaci. Draft mandátu ve worktree není účinná revize. Záznam operace může
   uvést repo, commit a ID mandátu pro dohledatelnost; není novou autoritou.
5. Chybějící, odvolané, expirované, rozporné nebo neověřitelné pověření
   zastaví samostatnou Publikaci. Agent zachová bezpečný draft a předá
   výjimku odpovědnému člověku. Nedostupný provider není důvod použít starou
   kopii, jiný účet ani domyslet oprávnění.
6. Člověk mandát odvolá nebo změní stejnou schvalovanou cestou. Při naléhavém
   zastavení využije také vypnutí automatizace a odebrání provider přístupu.
   Soubor nezaručuje okamžité přerušení již běžící operace. Rollback kódu
   nebo runtime neobnovuje odvolaný mandát.

Agent si nikdy mandát sám neuděluje, nerozšiřuje ani neobnovuje. Ani stávající
mandát k merge jiných PR neopravňuje schválit vlastní rozšíření mandátu.
Publikace mandátu potřebuje samostatně prokázané lidské schválení, nikoli
oprávnění odvozené z navrhovaného textu.

GitHub a další poskytovatelé dál drží skutečné přístupy. Mandát je doložené
pověření k jejich použití, ne nový IAM, technický sandbox ani bypass branch
rules. Organization-owned root soubor nesmí obsahovat secrets ani informace
mimo access hranici svého repozitáře. Pokud je potřebný rozsah citlivější než
viditelnost root repa, nezačínej jej zveřejňovat; nech oprávněného člověka
vyřešit odpovídající repo hranici. Nevytvářej skrytou lokální autoritu.

## Neúčinná šablona

Následující text je pouze návrh pro Organization repo. Placeholdery ani
publikace této veřejné šablony nikomu nic nepovolují.

```markdown
# Mandáty Organizace

## <stabilní-id>

- Stav: návrh / aktivní / odvolaný
- Organizace a kanonické repo: <GitHub Organization, owner/repo>
- Udělil: <oprávněný člověk; dohledatelný schvalovací záznam>
- Odpovědný člověk: <konkrétní kontakt pro dohled a obnovu>
- Účet a pracovní nasazení: <provider account; konkrétní určení Mašiny>
- Účel: <svěřená agenda>
- Rozsah: <přesné repozitáře, nástroje a datová hranice>
- Samostatně povolené operace: <výčet; Publikaci pojmenovat výslovně>
- Podmínky: <review, kontroly a další podmínky před akcí>
- Předává člověku: <výjimky a operace mimo mandát>
- Platnost: <od/do nebo do odvolání>
```

Nastavení automatizace pak může říkat: „Podle mandátu `<stabilní-id>` v
Organizaci `<scope>` každý večer zpracuj svěřenou frontu a předávej výjimky
odpovědnému člověku.“ Čas, retry a poslední běh vlastní zvolený harness;
`MANDATES.md` není scheduler ani task ledger.

## Přechod ze starého modelu

Záměr budoucího Resident profilu `ai-colleague` je nahrazen tímto modelem.
Existující schéma Personalspace dál čte historický typ `ai-colleague`, aby
nezneplatnilo chráněná data. Nový Personalspace vzniká pouze člověku. Žádná
existující soukromá paměť se tím nepřesouvá, nesdílí ani nepřeklasifikuje.
Konkrétní migration potřebuje vlastní scope, oprávnění a ověřenou obnovu.

Tento kontrakt nenasazuje účty, živé mandáty ani automatizace. Pro nasazení
se musí ověřit skutečný harness consumer: běžný průchod, zákaz po odvolání,
neshoda účtu/scope, nedostupnost autority, zákaz vlastní změny mandátu a
opakovaný běh bez duplicitní Publikace. Testy distribuce dokazují doručení
instrukcí; samy nedokazují poslušnost modelu ani provozní dostupnost.
