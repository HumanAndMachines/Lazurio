# Hostovaný Lazurio Buddy — co o něm musí vědět agent v rootu

> **Pro koho to je.** Task Agent (Codex, Claude Code, Cursor…), kterého
> Principál pustil z Lazurio rootu na svém počítači. Tenhle dokument
> odpovídá na dvě otázky: *má můj Principál hostovaného Buddyho?* a *co platí,
> když se práce dotkne jeho VPS?*
>
> **Co to není.** Instalační ani provozní manuál Buddyho. Veřejný lifecycle
> drží `manual/lazurio-resident-profiles.md` a `distribution/README.md`; konkrétní
> host se řídí svou ověřenou instalací a privátním profilem — viz
> [Na VPS platí jiná pravidla](#na-vps-platí-jiná-pravidla-než-v-tomhle-rootu).

## Cílový produktový model — 2026-09-12

**Lazurio Buddy** je jeden produkt pro osobní agenturu právě jednoho člověka.
Veřejné možnosti jsou „Staráme se my“ a „Spravujete si sami“. Způsob správy
se vede odděleně od umístění: vlastní VM zákazníka na hostiteli provozovatele,
zákazníkův VPS nebo jeho fyzický hardware. Buddy Lite ani samostatná produktová
řada Sovereign nejsou cílovou nabídkou. Více izolovaných zákaznických VM může
sdílet fyzický host; hypervizor a jeho provozovatel zůstávají vyšší hranicí.

Cíl je oficiální Hermes instalátor, gbrain a Lazurio root propojené standardními
mechanismy. Povinný Zulip ani buddy-bridge nejsou požadavkem nové instalace.
Verzované piny, runtime a konfigurační kontrakty existujících instalací však
zůstávají aktuálním stavem do ověřené migrace. Tento manuál nedovoluje měnit
běžící profil, vypnout kanál ani obejít jeho kontroly jen podle cílové prózy.

Buddy používá GitHub a další podporované účty svého Principála. Stejná identita
může být na jeho notebooku i u Buddyho; mašina sama není persona ani IAM.
Každý zákazník má vlastní osobní tailnet, bez společného zákaznického tailnetu
flotily. Obousměrné SSH se povoluje výslovně a vyžaduje odpovídající přihlášení,
nástroje a mandát. Organizace schvaluje pracovní přístup do své sítě samostatně;
směr Buddy → dílna neuděluje dílně právo zahajovat spojení do Personalspace.
Síťová dosažitelnost, aplikační přihlášení a oprávnění jsou oddělené kontroly.

Izolace VM i Tailscale závisí na bezpečné konfiguraci a údržbě; bezchybnost
softwaru ani absolutní nepřístupnost pro správce hypervizoru nejsou slibem.
Běžný přístup uživatele a vyžádaný servis přes infrastrukturu jsou oddělené.
Detailní rescue, obnova, předání instalace a dat, ceny a SLA zůstávají otevřené.
Předání cílově přenáší aplikaci a data, nikoli celý obraz virtualizační VM.

Publikovaný produktový kontrakt drží Knowledgebase Organizace vyvíjející
Lazurio; provedení a aktuální stav drží owning source a ověřená instalace.
Pravidla níže se týkají přístupu ke skutečné Mašině a zůstávají účinná i během
migrace. Lokální profilový mount se změnou cíle nestává execution prostředím.

## Proč o tom root vůbec mluví

Personalspace může existovat bez Buddyho a většina jich tak začíná. Když si ale
Principál Buddyho onboarduje, vznikne mu druhé místo, kde jeho osobní vrstva
žije: **samostatná per-owner Mašina**. Starší decision 0080 popisovala VPS-only instalaci; cílový model níže rozšiřuje umístění na zákaznickou VM, vlastní VPS nebo hardware. Lokální
mount `personalspace/<owner>_GEN3/buddy/` drží jen Git konfiguraci profilu —
**runtime tam není a nikdy nebude** (`local_execution: forbidden`).

Z toho plyne past, kvůli které tenhle dokument vznikl: agent na lokále vidí
složku `buddy/`, přečte si konfiguraci a začne se k ní chovat jako k něčemu, co
může lokálně spustit, opravit nebo přenastavit. Nemůže. Ta konfigurace popisuje
běh, který se odehrává jinde, pod jinými pravidly a s jiným credential setem.

## Jak zjistíš, jestli tvůj Principál Buddyho má

**Deklarace není důkaz.** `personal.gen3.json` může Buddyho binding deklarovat
a přesto k němu Principál dnes přístup mít nemusí — a naopak, instalace mimo
self-service lane v manifestu nemusí být vidět vůbec.
Stejná logika jako u přístupů obecně: **scope se prokazuje operací, ne
přečtením konfigurace.**

Jsou to **dvě různé otázky** a pletou se snadno:

- *Existuje Buddy?* — na to odpoví kroky 1–3 níž.
- *Mám k němu teď přístup?* — na to odpoví **jedině krok 4**.

Kroky 1–3 jsou **indicie, ne odpovědi**. Žádný z nich postup neukončuje: ani
Principálovo „ano, Buddy existuje", ani binding v manifestu, ani viditelný node
v tailnetu neprokazují, že se k Buddymu dnes někdo dostane. Když se na
kterémkoli z nich zastavíš, začneš plánovat proti Buddymu, který nemusí být
dosažitelný — a přijdeš na to až ve chvíli, kdy už jsi něco slíbil.

1. **Zeptej se Principála.** Nejlevnější zdroj a jediný, který odpoví na
   *existuje*. Vlastní jméno Buddyho (Principálové jim jména dávají) je dobrý
   signál, že instalace proběhla. O přístupu neříká nic.
2. **Manifest jako indicie.** `personalspace/<owner>_GEN3/personal.gen3.json` —
   pokud nese Buddy binding, ber to jako *pravděpodobné ano, ověř operací*.
   Pokud ho nenese, **neuzavírej z toho „ne"**: instalace mimo self-service
   lane v manifestu být nemusí.
3. **Dosažitelnost hostu.** Hostované Buddy hosty se zpřístupňují přes privátní
   síť Principála, ne veřejným portem. Pokud používá Tailscale, `tailscale
   status` vypíše i nody sdílené do jeho tailnetu. **Odpovídající node
   neprokazuje přístup** — prokazuje jen, že po síti někam dojdeš.
4. **Skutečný přístup — jediný krok, který otázku uzavírá.** Prokazuje ho
   výhradně operace, která uspěje: přihlášení do chatového rozhraní Buddyho,
   nebo SSH na host. Tady zároveň končí to, co smí agent dělat sám — viz
   hranice níž. Když operace neproběhla, správná odpověď je **„nevím, a proto
   nemá"**, ne „nejspíš ano".

**Fail-closed:** dokud nemáš důkaz z kroku 4, pracuj s odpovědí „nemá". Nikdy
nezakládej plán, report ani slib na domněnce, že Buddy je dosažitelný.

## Co s tím smíš dělat ty

| | |
|---|---|
| **Smíš** | zjistit, jestli Buddy existuje; přečíst lokální mount `buddy/` jako konfiguraci; odkázat Principála na jeho Buddyho; připravit mu podklad, který si na VPS odnese sám |
| **Nesmíš** | přihlašovat se za Principála do jeho chatu s Buddym; číst obsah Buddyho paměti a vynášet ho do sdílených výstupů; spouštět Buddy runtime lokálně; měnit stav VPS podle pravidel tohohle rootu |

Přístup na VPS je **Principálův**, ne tvůj — i když ti jeho počítač technicky
dovolí ho použít. Když je pro úkol potřeba, řekni si o něj nahlas a nech
Principála rozhodnout; mlčky použitý cizí přístup je porušení hranice, i když
skončí správným výsledkem.

**Paměť Buddyho je personalspace.** Platí pro ni celá security hranice
personalspace: nesmí se objevit ve sdílených výstupech, org discovery,
reportech ani šablonách — bez ohledu na to, jak užitečný ten obsah pro aktuální
úkol vypadá.

## Na VPS platí jiná pravidla než v tomhle rootu

**Tohle je to hlavní, co si z dokumentu odnes.** Jakmile se práce přesune na
host Buddyho, pravidla Lazurio source checkoutu **končí**. Nainstalovaný host se
řídí vygenerovaným `AGENTS.md` svého aktivního, non-Git Buddy resident rootu a
privátní ústavou, mandáty a konfigurací v Personalspace Principála. Ani jedna
vrstva nenahrazuje druhou.

Nejdřív ověř `active/lazurio.resident.json`, integritu payloadu a profil
`buddy`. Chybějící manifest neznamená, že se smějí použít source instrukce:
znamená legacy host, který ještě neprošel assisted migrací. Takový
host se nemění ad hoc. Jeho přechod drží veřejný assisted rollout kontrakt,
rollout plán příslušné Organizace a zachovaný původní service fallback až do
prokázané parity.

Praktický důsledek pro tvoje rozhodování:

- úkol o **lokálním** mountu, manifestu nebo Git konfiguraci → root, tenhle
  dokument a `personalspace/README.md`;
- úkol o **běhu Buddyho** — instalace, runtime, paměť, bridge, model,
  zálohy, incidenty → aktivní resident `AGENTS.md`, privátní profil a veřejný
  lifecycle kontrakt; čti je **dřív**, než se hostu dotkneš;
- úkol, kde si nejsi jistý, na které straně hranice leží → zeptej se
  Principála. Odhad je tu dražší než dotaz: špatná změna na hostu se
  projeví na tom, jak Buddy jedná jménem svého Principála.

## Vztah k self-service onboardingu

Založení personalspace pokrývá [`create-personalspace.md`](create-personalspace.md).
**Buddy část self-service flow zatím není dostupná** — root parser
`--with-buddy` ji dnes nevytváří. Legacy hosty se místo toho převádějí
asistovaným resident rolloutem s integrity, health, rollback a service-cutover
gatem. Když aktivní resident manifest chybí, narazil jsi na dosud
nemigrovanou instalaci, ne na podporovanou druhou architekturu.

---

*Tento manuál drží obecnou hranici mezi lokálním Lazurio rootem a hostovaným
Buddy runtime; konkrétní rollout plány a provozní poznatky patří do interních
zdrojů příslušné Organizace.*
