# Přístupy mezi Mašinami jednoho Operátora

Plné znění rozhodnutí 0155 z [decision registru](decision-register.md). Popisuje,
jak spolu smějí mluvit Mašiny a klienti, se kterými pracuje jeden Principál, a
kde se to zapisuje. Cílem je, aby pravidla přečetl i člověk bez IT specialisty
a aby Agenti stavějící Lazurio Platformu měli jednu pravdu.

## Dvě zóny

| Zóna | Co do ní patří | Owner |
| --- | --- | --- |
| **Osobní** | osobní klienti Principála (laptop, telefon) a jeho jediná osobní VM (0153) | Principál |
| **Pracovní** | pracovní VM přiřazené právě tomuto Operátorovi (klidně víc, v různých Organizacích téhož Conglomerate) a pracovní laptop, který mu vydala Organizace | Organizace |

Každá položka v infra nese dvě oddělená pole: `owner` (Principál u osobní
Mašiny a osobních klientů, Organizace u pracovních) a `operator` (člověk,
kterému je pracovní VM nebo pracovní laptop přiřazený). Oba vztahy se váží na
neměnné GitHub ID; login je jen čitelný popis. Zmrazený lowercase login slouží
výhradně jako síťový a DNS slug (Headscale user, `<login>.lazurio.io`). Zóna se
odvozuje z `owner` a `operator`, ne z Headscale usera ani ze jména.

## Pravidla

1. **Uvnitř zóny oběma směry.** Agenti Operátora pracují v jednom souvislém
   prostoru a Operátor nemusí řešit, kde co leží.
   - osobní klient → osobní VM: SSH + HTTPS; osobní VM → osobní laptop: SSH;
   - pracovní laptop ↔ pracovní VM téže Organizace přiřazená témuž Operátorovi: SSH.
   - Pracovní VM mezi sebou grant nemají — ani v rámci jedné Organizace, ani
     napříč Organizacemi téhož Conglomerate. Hranice Organizací zůstává
     zachovaná; propojení drží Operátorův pracovní laptop nebo jeho osobní strana.
2. **Z osobní do pracovní ano.** Osobní klienti a osobní VM → každá pracovní VM
   téhož Operátora: SSH + HTTPS.
3. **Z pracovní do osobní nikdy.** Pracovní VM ani pracovní laptop nemají grant
   na osobní VM ani na osobní laptop. Jedinou výjimkou je zařízení vědomě
   deklarované v obou zónách podle pravidla 8.
4. **Sdílená týmová VM** (Hosted Team Workspace, víc Principálů v jednom OS
   účtu) přijímá jen příchozí spojení od členů GitHub Teamu, na který je vázaná
   neměnným `github_team_id` (0147/0149); členství se čte živě z GitHubu a
   nevzniká druhý roster. Nikdy nemá odchozí grant na klienty ani na jiné VM. Obousměrná hrana pracovní
   zóny existuje jen mezi pracovním laptopem a pracovní VM přiřazenou témuž
   Operátorovi; jinak by agenti jednoho člena došli na laptop jiného.
5. **Mezi Principály nic implicitně.**
6. **Telefon** není SSH server; systémové ovládání telefonu se nesjednává.
7. **Správa Conglomerate Hostu** patří Ownerovi GitHub Organizace, která
   Conglomerate Host vlastní, a jde jen z jeho osobního laptopu a osobní VM
   (`owner_admin_ssh_grants`). Ownerství jiné Organizace obsluhované tímtéž
   hostem správu nedává; telefon, pracovní VM ani pracovní laptop ji nedostávají.

8. **Zařízení v obou zónách (founder).** Zakladatel bývá týž člověk jako Owner
   Organizace a jeden notebook mu slouží osobně i pracovně. Takové zařízení smí
   být deklarované v obou zónách, ale jen při splnění všech podmínek:
   - **Owner a Principál jsou tatáž osoba.** Neměnné GitHub ID vlastníka
     zařízení je zároveň Owner té Organizace, jejíž pracovní Mašiny na ně mají
     dosáhnout. Pravidlo „z pracovní do osobní nikdy“ chrání Principála před
     autoritou Organizace a jejích pracovních VM. Výjimka tu ochranu neruší;
     Principál, který je sám Ownerem, ji vědomě a výslovně vzdává pro jedno své
     zařízení a přijímá důsledek popsaný níže. Rozhodnutí je jeho, protože se
     týká jeho vlastního zařízení.
   - **Výslovná deklarace, nikdy odvození.** Dvojí zařazení se zapisuje v infra
     u konkrétního zařízení spolu s Organizacemi, kterých se týká. Neodvozuje se
     z jména uzlu, popisu, Headscale usera ani z toho, že je někdo Owner.
   - **Jen jmenovaná Organizace.** Grant dostanou pouze pracovní Mašiny
     deklarovaných Organizací. Ostatní Organizace téhož Conglomerate ani cizí
     Principálové z toho nic nezískávají.
   - **Vědomý důsledek.** Autorita Organization Hostu a Conglomerate Hostu tím
     dostane technickou cestu do zařízení, na kterém Principál pracuje i
     soukromě. Ta autorita nepatří jen jemu: mají ji všichni Owneři té
     Organizace a každý, kdo smí spouštět práci na jejích pracovních VM, včetně
     agentních účtů. To je přijatý důsledek; proto tuhle výjimku nesmí dostat
     zařízení nikoho jiného než Ownera a vždy jen jeho vlastním rozhodnutím.
   - **Osobní VM výjimku nedostává.** Dvojí zařazení platí pro klientské
     zařízení, ne pro osobní VM. Ta zůstává výhradně v osobní zóně (0153) a
     pracovní VM na ni nikdy nedosáhne. Mezi zakladatelovým notebookem, jeho
     osobní VM a jeho pracovní VM je to jediná zakázaná cesta.
   - **Mechanismus až po deklaraci.** Dokud Machines neumí dvojí zařazení
     výslovně deklarovat, platí přísné pravidlo 3 i pro zakladatelovo zařízení
     a žádná pracovní VM na deklarovaného osobního klienta nedosáhne.

**Vědomý důsledek pracovního laptopu:** pracovní VM vlastní Organizace a nad ní
stojí autorita Organization Hostu a Conglomerate Hostu. Grant pracovní VM →
pracovní laptop proto dává této vyšší autoritě technickou cestu do laptopu. U
zařízení vlastněného Organizací je to přijaté; právě proto se třída `work`
nikdy neodvozuje a osobní laptop ji dostat nesmí.

## Hranice jednoho Conglomerate

Zóny a pravidla platí uvnitř jednoho Conglomerate (jednoho Headscale tailnetu).
Osobní VM je uzlem právě jednoho tailnetu: **domovského Conglomerate**
Principála, který se určí při jejím založení (Conglomerate Organizace, kterou
Principál vlastní nebo pro kterou primárně pracuje) a zapíše se do jejího
záznamu. Do cizího Conglomerate vstupuje Principál jen svým klientem
přihlášeným do toho tailnetu; jeho osobní VM tam grant nemá a mezi tailnety se
nestaví žádný most.

## Identita a jména

- Osobní klienti a osobní VM patří pod **osobního Headscale usera**
  pojmenovaného lowercase GitHub loginem zmrazeným při založení (stejný slug
  jako `<app>.<login>.lazurio.io`).
- Pracovní VM jsou tagované workloady Organizace; pracovní laptop je
  netagovaný uzel v namespace Organizace.
- Linuxové admin účty na hostu jsou samostatná osa a nesmějí vytvářet vlastní
  Headscale usery.
- **Přechodný stav existujících uzlů:** nové uzly se zakládají rovnou pod
  osobním Headscale userem. Existující uzel pod jiným userem (např. Matoušův
  Windows, iPhone a Friday v `org-macano-tech`) se přesune jen při příležitosti,
  kdy se zařízení stejně znovu přihlašuje, nebo až Headscale přesun uzlu bez
  nového přihlášení umožní (v0.29.3 `nodes move` nemá). Znovu párovat zařízení
  jen kvůli tomuto pravidlu se nesmí. Zóny se do té doby odvozují z
  deklarovaného záznamu Mašiny v infra, ne z Headscale usera.
- Technické jméno osobní VM = lowercase GitHub login (stejný slug jako Headscale
  user a `<login>.lazurio.io`); personalspace si zachovává svůj tvar
  `personalspace/<login>_GEN3`. Pracovní VM má label podle 0146. **Zobrazované jméno** si volí Principál (osobní VM
  „Friday“, pracovní „Henry“) a je jen popis.

## Infra je blueprint

Deployment Repo Organizace, která vlastní Conglomerate Host (`<Org>/infra`), je
jediný čitelný popis toho, jaké Mašiny a klienti figurují, v jaké zóně, s jakým
`owner` a `operator` a podle jakých pravidel. Autoruje se jen tento seznam a
pravidla výše. Výsledné Headscale granty jsou exaktní per-Mašina (node ID,
machine key, jméno, /32 adresa, žádné wildcardy namespace ani tagu), ale jsou
**generovaný, reviewovatelný výstup**, aby blueprint nerostl s počtem lidí ×
Mašin.

**Síťová lane (cíl):** merge změny, která se týká jen seznamu Mašin, zón a
Headscale userů, do `main` se na Conglomerate Hostu projeví sám. Proběhne
render, `headscale policy check`, apply a kontrola z pohledu admin zdroje, že
se správce nezamkl; jinak se host vrátí na poslední funkční stav. Autoritou
zůstává GitHub: merge Organization Adminem, nezávislé schválení a povinné
checky. Mechanismus vybere plný shaping, preferuje se udržovaný standard (např.
GitHub Actions self-hosted runner na Conglomerate Hostu, jen pro toto privátní
repo, spouštěný `push` do `main` s chráněným environmentem). Validace
neprověřeného kódu z PR na Conglomerate Hostu nikdy neběží. Enrollment klíčů,
balíčky, služby, DNS, certifikáty a credentials zůstávají v push apply s
jednorázovým Permitem. Do zavedení lane platí push apply i pro síť.

## IPv4 rozsahy

Každý Conglomerate Host dostane vlastní nepřekrývající se prefix uvnitř
`100.64.0.0/10`, aby se adresy různých tailnetů na počítači operátora
nepletly. Seznam přidělených prefixů vede `HumanAndMachine-ai/infra` jako
pomůcku operátora pro Conglomeraty, které zakládá, stejně jako jména v
`lazurio.io`. Není to centrální autorita ani registr cizích tailnetů či Mašin.
Pro nové Conglomerate Hosty je prefix povinný; existující se přečíslují jen
řízenou migrací, HumanAndMachine-ai jako první.

## Příklad

| Principál | Domovský Conglomerate | Osobní zóna | Pracovní zóna |
| --- | --- | --- | --- |
| Matouš (`mcn-kacanos-m`) | Macano-Tech | Windows laptop, iPhone, osobní VM „Friday“ | pracovní VM Macano-Tech „Henry“ |
| Matěj (`immakermatty`) | HumanAndMachine-ai | MacBook, telefon, osobní VM | pracovní VM ve Spectodě, HumanAndMachine-ai a Lumbio |
| Anička (`annavesela`) | HumanAndMachine-ai | MacBook, telefon, osobní VM | pracovní VM ve Spectodě |

Matěj a Anička mají osobní laptop, takže jejich pracovní VM na laptop nesmí.
Matouš je Owner Macano-Techu a rozhodl, že jeho Windows notebook má být podle
pravidla 8 v obou zónách pro Macano-Tech. **Dnes to ještě neplatí:** Machines
dvojí zařazení zatím neumí výslovně deklarovat, takže podle přísného pravidla 3
pracovní VM Macano-Techu na notebook nedosáhne a notebook je v příkladu jen v
osobní zóně. Pracovní VM na něj dosáhne teprve po třech krocích: schopnost
Machines deklarovat dvojí zařazení, výslovná deklarace v `Macano-Tech/infra` a
běžné nasazení s Plánem a Permitem. Pak se notebook objeví v obou sloupcích.
Do osobní zóny jiných Principálů ani jiných Organizací se tím nic neotevírá.
Operátor s pracovním laptopem Organizace (např. v ConceptLine) má pracovní
laptop ↔ pracovní VM obousměrně.

Realizace a stav: Mission Control DEV-6614. Konkrétní instance pro Matouše
drží `Macano-Tech/infra` v `machines/macano-tech-conglomerate-host/operator-device-access.md`.
