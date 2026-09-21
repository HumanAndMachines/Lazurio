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
Mašiny a osobních klientů, Organizace u pracovních) a `operator` (GitHub login
člověka, kterému je pracovní VM nebo pracovní laptop přiřazený). Zóna se
odvozuje z nich, ne z Headscale usera ani ze jména.

## Pravidla

1. **Uvnitř zóny oběma směry.** Agenti Operátora pracují v jednom souvislém
   prostoru a Operátor nemusí řešit, kde co leží.
   - osobní klient → osobní VM: SSH + HTTPS; osobní VM → osobní laptop: SSH;
   - pracovní laptop ↔ pracovní VM téže Organizace přiřazená témuž Operátorovi: SSH.
2. **Z osobní do pracovní ano.** Osobní klienti a osobní VM → každá pracovní VM
   téhož Operátora: SSH + HTTPS.
3. **Z pracovní do osobní nikdy.** Pracovní VM ani pracovní laptop nemají grant
   na osobní VM ani na osobní laptop.
4. **Sdílená týmová VM** (Hosted Team Workspace, víc Principálů v jednom OS
   účtu) přijímá jen příchozí spojení od svých členů a nikdy nemá odchozí grant
   na klienty ani na jiné VM. Obousměrnost z pravidla 1 platí jen pro pracovní
   VM jednoho Operátora; jinak by agenti jednoho člena došli na laptop jiného.
5. **Mezi Principály nic implicitně.**
6. **Telefon** není SSH server; systémové ovládání telefonu se nesjednává.
7. **Správa Conglomerate Hostu** patří Ownerovi GitHub Organizace, která
   Conglomerate Host vlastní, a jde jen z jeho osobního laptopu a osobní VM
   (`owner_admin_ssh_grants`). Ownerství jiné Organizace obsluhované tímtéž
   hostem správu nedává; telefon, pracovní VM ani pracovní laptop ji nedostávají.

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
  jako `<app>.<login>.lazurio.io` a personalspace).
- Pracovní VM jsou tagované workloady Organizace; pracovní laptop je
  netagovaný uzel v namespace Organizace.
- Linuxové admin účty na hostu jsou samostatná osa a nesmějí vytvářet vlastní
  Headscale usery.
- Technické jméno osobní VM i personalspace = lowercase GitHub login; pracovní
  VM má label podle 0146. **Zobrazované jméno** si volí Principál (osobní VM
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

Všichni tři mají osobní laptop, takže jejich pracovní VM na laptop nesmí.
Operátor s pracovním laptopem Organizace (např. v ConceptLine) má pracovní
laptop ↔ pracovní VM obousměrně.

Realizace a stav: Mission Control DEV-6614. Konkrétní instance pro Matouše
drží `Macano-Tech/infra` v `machines/macano-tech-conglomerate-host/operator-device-access.md`.
