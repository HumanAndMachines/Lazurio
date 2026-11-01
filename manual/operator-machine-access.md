# Přístupy mezi Mašinami jednoho uživatele

> **Cílové zpřesnění 0192 (2026-10-06):** [Model přístupů](environment-access-model.md)
> odděluje Lazurio účet, schválené zařízení, vstup do Environmentu a pracovní
> GitHub identitu. Jednočlenný GitHub Team ani připojený GitHub nejsou cílovou
> podmínkou vstupu; dosavadní postup níže je migrační implementace. GitHub
> se připojuje pro potřebné pracovní operace, ne jako univerzální brána
> k užívání aplikací či Environmentu. Tato změna není nasazená tímto textem.


Plné znění rozhodnutí 0155 z [decision registru](decision-register.md). Popisuje,
jak spolu smějí mluvit Mašiny a klienti, se kterými pracuje jeden uživatel, a
kde se to zapisuje. Cílem je, aby pravidla přečetl i uživatel bez IT specialisty
a aby Agenti stavějící Lazurio Platformu měli jednu pravdu.

## Dvě zóny

| Zóna | Co do ní patří | Owner |
| --- | --- | --- |
| **Osobní** | osobní klienti uživatele (laptop, telefon) a jeho jediná osobní VM (0153) | Uživatel |
| **Pracovní** | pracovní VM přiřazené právě tomuto uživateli (klidně víc, v různých Organizacích téhož Conglomerate) a pracovní laptop, který mu vydala Organizace | Organizace |

Každá položka v infra nese dvě oddělená pole: `owner` (uživatel u osobní
Mašiny a osobních klientů, Organizace u pracovních) a `operator` (uživatel,
kterému je pracovní VM nebo pracovní laptop přiřazený). Oba vztahy se váží na
neměnné GitHub ID; login je jen čitelný popis. Zmrazený lowercase login slouží
výhradně jako síťový a DNS slug (Headscale user, `<login>.lazurio.io`). Zóna se
odvozuje z `owner` a `operator`, ne z Headscale usera ani ze jména.

## Pravidla

1. **Uvnitř zóny oběma směry.** Agenti uživatele pracují v jednom souvislém
   prostoru a uživatel nemusí řešit, kde co leží.
   - osobní klient → osobní VM: SSH + HTTPS; osobní VM → osobní laptop: SSH;
   - pracovní laptop → pracovní VM téže Organizace přiřazená témuž uživateli: SSH.
     Grant se odvozuje z aktuálního stavu (schválené zařízení × právě přidělené
     Environmenty) bez samostatné žádosti a sleduje změny přidělení, zařízení
     i členství (dodatek 0192 z 2026-10-07).
     Opačný směr (Prostředí → zařízení) je Přístup na zařízení: vznikne jen
     tehdy, když ho zapne Owner zařízení, pro každé zařízení zvlášť (0224
     bod 2e, nahrazuje 0182 bod 3).
   - Pracovní VM mezi sebou grant nemají — ani v rámci jedné Organizace, ani
     napříč Organizacemi téhož Conglomerate. Hranice Organizací zůstává
     zachovaná; propojení drží pracovní laptop uživatele nebo jeho osobní strana.
     Výjimkou je SSH z Pracovního Prostředí člověka do Týmových Prostředí jeho
     Teamů v téže Organizaci (0224 bod 2b; druhé `ssh` spuštěné v Pracovním
     Prostředí jeho klíčem) a Správcovský přístup
     z Pracovního Prostředí Admina do všech ostatních Prostředí jeho
     Organizace (0202, 0224 bod 2c). Ke službám servisní Mašiny svého serveru (AI pool a další)
     jdou Prostředí po vnitřní síti serveru podle povolení v Deployment
     Repu, ne grantem Headscale (0209); SSH ani jiný port z toho neplyne.
     Druhou výjimkou jsou stanoviště Organizace LazurioDevelopment (0217).
     Stanoviště je Pracovní Prostředí jednoho člověka a propojení do
     Organizací, ve kterých pracuje, drží jako jeho klient, stejně jako jeho
     počítač.
2. **Z osobní do pracovní ano.** Osobní klienti a osobní VM → každá pracovní VM
   téhož uživatele: SSH + HTTPS. Z Osobního Prostředí je automatický a vždy
   zapnutý jen Pracovní přístup: SSH do Pracovních Prostředí přidělených jeho
   Ownerovi ve všech Organizacích jeho Conglomerate, bez schválení zařízení
   (0224 bod 2a). Do Týmových Prostředí a ostatních Prostředí Organizace se
   z něj jde přes vlastní Pracovní Prostředí. HTTPS a jiný dosah dál drží
   0192: schválené zařízení a grant.
3. **Z pracovní do osobní nikdy.** Pracovní VM ani pracovní laptop nemají grant
   na osobní VM, a to bez výjimky. Na osobní laptop nebo jiné zařízení dosáhne
   Prostředí jen Přístupem na zařízení podle pravidla 8 (0224 bod 2e).
4. **Sdílená týmová VM** (Hosted Team Workspace, víc uživatelů v jednom OS
   účtu) přijímá jen příchozí spojení od členů GitHub Teamu, na který je vázaná
   neměnným `github_team_id` (0147/0149); členství se čte živě z GitHubu a
   nevzniká druhý roster. Příchozí SSH přijímá i z Pracovních Prostředí členů
   Teamu (0224 bod 2b). Výjimkou je servisní SSH z jmenovaného Pracovního
   Prostředí Ownera nebo Admina téže Organizace podle 0202 (přesný zdrojový
   uzel a adresa), i když Admin není členem toho Teamu. Odchozí grant na jiné VM
   nikdy nemá; ke službám servisní Mašiny svého serveru, které jí Deployment
   Repo povolí, jde po vnitřní síti serveru, ne přes Headscale (0209). Na
   zařízení dosáhne jen Přístupem na zařízení podle pravidla 8, tedy jen když
   ho pro toto Týmové Prostředí zapne Owner zařízení; jinak by agenti jednoho
   člena došli na laptop jiného.
5. **Mezi uživateli nic implicitně.**
6. **Telefon** není SSH server; systémové ovládání telefonu se nesjednává.
7. **Správa Conglomerate Hostu** patří Ownerovi GitHub Organizace, která
   Conglomerate Host vlastní, a jde jen z jeho osobního laptopu a osobní VM
   (`owner_admin_ssh_grants`) a podle rozhodnutí 0202 i z jeho jmenovaného
   Pracovního Prostředí („Owner nebo Admin“ v 0202 je tatáž role Owner,
   v GitHub API `admin`). Ownerství jiné Organizace obsluhované tímtéž
   hostem správu nedává; telefon, jiné pracovní VM ani pracovní laptop ji
   nedostávají. Stanoviště LazurioDevelopment ji smí mít přes headless
   klienta svého člověka, jen u Organizace, jejímž je živým Ownerem, a jen
   jak to deklaruje overlay hostu (dodatek 0217 z 2026-10-28).

8. **Přístup na zařízení (0224 bod 2e).** Prostředí smí SSH na konkrétní
   zařízení, například na laptop svého člověka nebo na pracovní stanici
   Organizace s aplikacemi, na kterých mají agenti pracovat, jen při splnění
   všech podmínek:
   - **Zapíná ho Owner zařízení.** Osobní zařízení zapíná jeho člověk a vybere
     ze svých Prostředí (Osobního i Pracovních), která na ně smějí. Zařízení
     Organizace zapíná její Admin a vybere Prostředí té Organizace, která na ně
     smějí. Nikdo jiný přístup na cizí zařízení nezapne.
   - **Výslovně, pro každé zařízení zvlášť, nikdy odvozením.** Souhlas se váže
     na konkrétní zařízení a vybraná Prostředí. Neodvozuje se ze jména uzlu,
     popisu, Headscale usera, role Owner ani z toho, že zařízení smí do
     Prostředí. Owner ho může kdykoli odvolat; nová spojení pak do 5 minut
     selžou.
   - **Jen vybraná Prostředí.** Ostatní Prostředí, Organizace téhož
     Conglomerate ani cizí uživatelé z toho nic nezískávají.
   - **Vědomý důsledek.** Zpřístupní-li člověk svůj osobní počítač Pracovnímu
     Prostředí, dostane technickou cestu do zařízení, na kterém pracuje
     i soukromě, i autorita nad tímto Prostředím: Owneři a Admini Organizace,
     Správcovský přístup a každý, kdo smí na Prostředí spouštět práci, včetně
     agentních účtů. Proto rozhoduje jen Owner zařízení a souhlas jde odvolat.
   - **Osobní VM nikdy.** Přístup na zařízení platí pro klientská zařízení, ne
     pro osobní VM. Ta zůstává výhradně v osobní zóně (0153) a pracovní VM na
     ni nikdy nedosáhne.
   - **Mechanismus.** Souhlasy převádí na hrany služba na Conglomerate Hostu
     (0224 bod 3, plán DEV-6687). Dokud nepoběží, vzniká Přístup na zařízení
     jen výslovnou výjimkou v Deployment Repu a bez ní žádné Prostředí na
     zařízení nedosáhne.

**Vědomý důsledek pracovního laptopu:** pracovní laptop dostává SSH do
pracovního Environmentu, který je přidělený témuž uživateli; opačný směr pracovní
VM → laptop vzniká jen Přístupem na zařízení podle pravidla 8. Pracovní VM
vlastní Organizace a nad ní stojí autorita Organization Hostu a Conglomerate
Hostu, takže hrana VM → zařízení dává této vyšší autoritě technickou cestu do
laptopu. Proto o ní rozhoduje jen Owner zařízení a nikdy se neodvozuje.

## Hranice jednoho Conglomerate

Zóny a pravidla platí uvnitř jednoho Conglomerate (jednoho Headscale tailnetu).
Osobní VM je uzlem právě jednoho tailnetu: **domovského Conglomerate**
uživatele, který se určí při jejím založení (Conglomerate Organizace, kterou
uživatel vlastní nebo pro kterou primárně pracuje) a zapíše se do jejího
záznamu. Do cizího Conglomerate vstupuje uživatel jen svým klientem
přihlášeným do toho tailnetu; jeho osobní VM tam grant nemá a mezi tailnety se
nestaví žádný most. Stanoviště LazurioDevelopment (0217) vstupuje do jiného
tailnetu jen headless klientem svého člověka, kterého schválí Admin té
Organizace, a mezi tailnety nic neroutuje. Každý takový klient běží ve vlastním
síťovém prostoru, všechny naráz, a vlákno tailnet volí u příkazu; globální
profil na stanovišti není (dodatek 0217 z 2026-10-31).

Na Linuxovém stanovišti je síťovým prostorem tailnetu kontejner s vlastním
`tailscaled` v plném režimu, stavem, socketem, DNS a proxy jen na loopbacku.
Zakládá, převezme, ověří a odstraní ho `bun run tailnet`; příkaz v tailnetu
spustí `run`, SSH jde přes `ssh-proxy` a prohlížeč přes `proxy`. Systémový
`tailscaled` Prostředí před příkazy agentů hlídá guard. Postup, záruky
a selhání drží [Cizí tailnety na stanovišti](station-tailnets.md).

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
  `personalspace/<login>_GEN3`. Pracovní VM má label podle 0146. **Zobrazované jméno** si volí uživatel (osobní VM
  „Friday“, pracovní „Henry“) a je jen popis.
- **Jména uzlů zařízení uživatelů.** Uzel zařízení uživatele v tailnetu se jmenuje
  `<login>-<zařízení>` (např. `<login>-macbook`) a další headless klient téhož
  zařízení `<login>-<zařízení>-cli`. Uzel osobní VM, tedy Osobního Prostředí
  na serveru, se jmenuje `<login>-personal-vm`; její technické jméno z
  předchozího bodu zůstává login. `<login>` je štítek osobního Headscale
  usera; u účtu propojeného s GitHubem je to zmrazený lowercase GitHub login,
  týž slug jako v bodech výše. Účet bez GitHubu (0192) použije štítek svého
  Headscale usera a GitHub se kvůli jménu uzlu nepropojuje. `<zařízení>` je
  krátký stálý štítek (`macbook`, `iphone`, `pixel`, `windows`), zvolený
  jednou a stejný ve všech tailnetech. `-cli` je samostatný `tailscaled` s
  vlastním stavem a socketem, nejvýš jeden na zařízení a tailnet: na počítači
  člověka userspace, na stanovišti LazurioDevelopment v plném režimu ve vlastním
  síťovém prostoru (dodatek 0217 z 2026-10-31). Jméno nenese
  Organizaci, roli ani personu: nezačíná `company_slug` ani `lazurio-`, které
  patří tagovaným uzlům a runnerům, a končí `-vm` jen u osobní VM. Je to
  konvence, kterou Machines nekontroluje: jméno nic neuděluje a existující
  uzly se kvůli ní nepřejmenovávají. Jméno se nastavuje na zařízení samém jako
  hostname klienta, nikdy ručně na Conglomerate Hostu. Pravidla, chování
  Headscale a dopad přejmenování na vazby drží Machines
  `docs/conglomerate-tailnet.md` §1.1.
- **Nové infrastrukturní Mašiny** Organizace mají výchozí jména: fyzický
  virtualizační host `<org>-proxmox-NN` (např. `lumbio-proxmox-01`, aby ho
  správce více Organizací rozlišil v konzoli providera, SSH i tailnetu; `<org>`
  je krátký štítek Organizace, který Owner zvolí jednou a který se nemění
  s přejmenováním GitHub loginu ani DNS slugu); číslování od `01`, smí
  přerůst dvě číslice. Jméno hostu je konvence Owner Recordu, kterou Machines
  nevynucuje; nic neuděluje a existující Mašiny se kvůli konvenci
  nepřejmenovávají.
- **Jedna servisní Mašina na server (0209).** Každý virtualizační host
  Organizace má právě jednu servisní Mašinu `services-NN` s číslem hostu
  (`<org>-proxmox-01` má `services-01`). Je to Pracovní Prostředí jen pro
  Ownery a Adminy Organizace a každá její služba (AI pool, brány a další)
  běží ve vlastním kontejneru. Když jí dochází výkon, zvětší se; druhá
  servisní Mašina na tomtéž hostu nevzniká. Kde běží diagnostický kolektor,
  zatím otevřeně určí navazující rozhodnutí (0209 bod 7). Host s Osobními
  Prostředími více uživatelů služby Organizace nemá.

## Infra je blueprint

Deployment Repo Organizace, která vlastní Conglomerate Host (`<Org>/infra`), je
jediný čitelný popis toho, jaké Mašiny a klienti figurují, v jaké zóně, s jakým
`owner` a `operator` a podle jakých pravidel. Autoruje se jen tento seznam a
pravidla výše. Výsledné Headscale granty jsou exaktní per-Mašina (node ID,
machine key, jméno, /32 adresa, žádné wildcardy namespace ani tagu), ale jsou
**generovaný, reviewovatelný výstup**, aby blueprint nerostl s počtem uživatelů ×
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

| Uživatel | Domovský Conglomerate | Osobní zóna | Pracovní zóna |
| --- | --- | --- | --- |
| Matouš (`mcn-kacanos-m`) | Macano-Tech | Windows laptop, iPhone, osobní VM „Friday“ | pracovní VM Macano-Tech „Henry“ |
| Matěj (`immakermatty`) | HumanAndMachine-ai | MacBook, telefon, osobní VM | pracovní VM ve Spectodě, HumanAndMachine-ai a Lumbio |
| Anička (`annavesela`) | HumanAndMachine-ai | MacBook, telefon, osobní VM | pracovní VM ve Spectodě |

Pracovní VM na osobní laptop nesmí, dokud Owner laptopu nezapne Přístup na
zařízení podle pravidla 8. Matouš je Owner Macano-Techu a chce, aby jeho Windows
notebook byl dosažitelný z pracovního Prostředí Macano-Techu; podle pravidla 8
to zapne sám jako Owner zařízení. **Dnes to ještě neplatí:** služba, která
souhlasy převádí na hrany, zatím neběží, takže bez výslovné výjimky
v `Macano-Tech/infra` pracovní VM Macano-Techu na notebook nedosáhne a notebook
je v příkladu jen v osobní zóně. Do osobní zóny jiných uživatelů ani jiných
Organizací se tím nic neotevírá. Uživatel s pracovním laptopem Organizace má SSH
z pracovního laptopu do přiděleného pracovního Environmentu; opačný směr jen
Přístupem na zařízení podle pravidla 8.

Realizace a stav: Mission Control DEV-6614. Konkrétní instance pro Matouše
drží `Macano-Tech/infra` v `machines/macano-tech-conglomerate-host/operator-device-access.md`.
