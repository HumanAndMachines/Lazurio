# Buddy a AI Kolega v Lazuriu

Lazurio je pracovní prostředí, ve kterém lidé a stroje používají stejné
Organizace, nástroje a dohledatelné procesy. Buddy a AI Kolega nejsou dvě kopie
Lazuria ani dlouhodobé Git branche. Jsou to dva profily jednoho produktu,
postavené z jednoho přesného source commitu.

Tento manuál je veřejná a offline dostupná část kontraktu. Neobsahuje
konkrétní osobnosti, mandáty, paměť, jména instalací, incidentní logy ani
credentials.

## Jedna mapa pojmů

| Pojem | Co znamená |
| --- | --- |
| Principál | Ten, pro koho Agent pracuje a kdo má poslední slovo. |
| Kolega | Lidský Principál. Jeho pracovní Root leží přímo v home; dnešní Source Root může do migrace nést historický název složky, fresh/Managed target je `<home>/Lazurio`. Managed profil potřebuje source checkout jen pro vývoj Lazuria. |
| Buddy | Osobní zástupce jednoho lidského Principála uvnitř jeho Personalspace. Jedná jen v mezích jeho práv a mandátů. |
| AI Kolega | AI Principál s vlastní identitou, Mašinou, Personalspace a pracovními právy. Není Buddy. |
| Task Agent | Nástrojová pracovní relace, například Codex nebo Claude Code. Sama žádná práva nevlastní. |
| Steward | Organizační role AI Kolegy nebo Kolegy. Její název nic neautorizuje; rozhodují živá GitHub práva. |
| Mašina | Fyzické zařízení, virtuální server nebo providerem izolovaný hostovaný pracovní prostor, který tvoří jednu sdílenou runtime, bezpečnostní a recovery hranici se známým Ownerem. |
| Personalspace | Privátní prostor právě jednoho Principála a případného Buddyho. |
| Organizace | Jedna firma, jeden GitHub Organization scope a jedna access hranice. |
| Authority Compartment | Nejmenší runtime scope jedné sady credentials, repozitářů, nástrojů, instrukcí a paměti; je osobní, nebo patří právě jedné Organizaci. |
| Communication Binding | Vazba jednoho přesného Zulip realmu a jeho immutable routing policy na právě jeden Authority Compartment. Přenáší zprávu, ale sama neuděluje práva. |

Instrukce nemají vedlejší manifestovou autoritu. Hermes načítá kanonický
`AGENTS.md` přímo z rootu repozitáře vybraného compartmentu; osobní binding
Buddyho k němu přidává privátní `CONSTITUTION.md` a `MANDATES.md`. Binding
přidává jen neměnnou identitu aktivního compartmentu a zákaz sáhnout do jiného.

Seznam repozitářů v compartmentu je hranice materializace, ne druhé ACL.
Read/write a Publikační právo určuje výhradně živý scoped GitHub credential.
Dokud Managed runtime nemá revokovatelný Git credential broker pro pracovní
kontejner, smí checkouty připravit, ale nesmí tvrdit, že Agent umí
autentizovaný fetch nebo push.

Kanonickou cross-profile definici drží root `ARCHITECTURE.md`. Tento manuál dál
slovem Mašina myslí konkrétně Mašinu hostující Residenta. Hosted Team Workspace
se v širším modelu také počítá jako Mašina Teamu, ale tento fakt sám z něj
nedělá Resident profile ani Personalspace.

## Source, pracovní Root a runtime nejsou totéž

Kanonický Lazurio source je Git repozitář, ve kterém se vyvíjí společný
Launchpad, CLI/Core, Doctor, Guide, manuály, generátor a profilové buildy.
Pracovní Root každé Mašiny žije přímo v home a má dva veřejné profily: dnešní
podporovaný Source Root je ověřený Git checkout, který může do migrace nést
historický název složky; fresh/Managed target je přesně `<home>/Lazurio` a je
generovaným non-Git adresářem pro instrukce, konfiguraci, data a mounty.
Package-only Managed profil source checkout nepotřebuje.

Každý pracovní Root:

- má právě jeden aktivní root `AGENTS.md`; v Source profilu je trackovaný,
  v Managed profilu generovaný profile buildem;
- obsahuje `personalspace/` a `organizations/` jen jako oddělené mutable Git
  mounty s vlastními access hranicemi;
- nenese druhou vendored kopii CLI ani Launchpadu;
- po Managed migraci může v development profilu obsahovat jediný source
  checkout `<home>/Lazurio/development/Lazurio`.

Běžná budoucí Managed workstation instalace spouští package-managed `lazurio`
mimo pracovní Root. Dnešní Source Root používá source-linked CLI; Managed
development profil může tuto právě jednu aktivní CLI/Core provenance
explicitně přelinkovat na kanonický nested source checkout. Hosted Resident může
stejný reviewovaný source zabalit do immutable artefaktu s manifestem
`lazurio.resident.json`, exact source SHA, profilem, platformou a payload
hashi. Artefakt je runtime vrstva, nikoli druhý pracovní Root ani datová
autorita.

V source není umělý adresář `common/`. Sdílený produkt zůstává běžným Lazurio
stromem a build k němu přidá pouze úzký profilový fragment. Zdrojové fragmenty
se nejmenují `AGENTS.md`, takže v development checkoutu omylem nepřebírají
řízení Agentů.

## Profil Workspace

Workspace profil je immutable runtime pro Launchpad a Lazurio CLI v hostovaném pracovním
prostoru Kolegy nebo AI Kolegy. Není druhým datovým modelem hosted prostředí:
lokální i vzdálený pracovní prostor používají stejný Lazurio Root kontrakt,
Organization Rooty, org-level repa a Workspace Moduly. Liší se jen transportem, custody,
aktivní Team projekcí a způsobem provozního nasazení runtime.

Runtime artefakt běží mimo mutable working root. V hosted kontejneru je
kanonické rozhraní `LAZURIO_RUNTIME_ROOT=/opt/lazurio-runtime` a
`WORKSPACE_ROOT=/home/builder/Lazurio`; Launchpad se spouští z první cesty a
druhou dostává přes `--root`. Runtime nemá self-update. Exact build, startup
gate a rollout pořadí drží `manual/lazurio-runtime-install-interface.md`.

## Profil Buddy

Buddy patří jednomu člověku a zastupuje ho jeho právy. Veřejný profil určuje
hranice práce, soukromí a incidentního chování; neurčuje osobnost konkrétního
Buddyho. Ta spolu s ústavou, mandáty a pamětí zůstává v privátním
Personalspace.

Buddy není AI Kolega ani Steward. Běžný Task Agent spuštěný na Buddyho
Mašině také není Buddy. Transakčně citlivé kroky — přístupy, secrets,
destruktivní operace, billing, ownership a publish/release mimo trvalý mandát
— vyžadují přesný souhlas lidského Principála.

### Trust model Buddyho

Pro provoz se vždy rozlišují tři otázky:

1. Buddyho turn smí zadat právě jeden lidský Principál; to drží privátní
   komunikační surface a provider access.
2. Mašinu a Lazurio vlastní Principál. Smí je lokálně upravit; Doctor změnu
   popíše jako drift a lifecycle nabídne vratnou cestu, ale změnu nezakazuje.
3. Přístup běžícího Agenta k souborům a nástrojům drží Hermes sandbox. Lazurio
   vedle něj nevytváří druhý ACL ani paralelní sandbox.

Skutečnou vstupní hranicí Buddyho je jeho privátní komunikační surface.
Zulip realm, membership, credentials a síťový access plane musí být určené
právě jednomu lidskému Principálovi a technické identitě jeho Buddy botu. Turn
smí zadat pouze Principál; bot odpovídá a poskytovatel infrastruktury není další
Principál. Jiný autor konverzace znamená porušené nasazení, ne novou roli.

Principál vlastní svou Mašinu a systém předpokládá, že to se sebou myslí dobře.
Lazurio proti němu nestaví vlastní ACL, ownership gate ani permission zámek.
Agentní přístup k souborům a nástrojům omezuje existující sandbox runtime —
dnes Hermes Agent. Manifest, Doctor, service oddělení a rollback pouze
zviditelňují odchylky, omezují náhodnou self-mutaci procesu a umožňují obnovu;
nejsou druhou autorizační hranicí.

Agentem spuštěný terminal kontejner nesmí vlastnit ani přepsat sandbox, který
jej omezuje: nedostává Docker socket, host credentials ani zapisovatelný
software root. Hermes checkout a Bun může vlastnit a měnit Principál nebo jím
řízená maintenance identita. Preflight kontroluje skutečná host oprávnění a
tracked Hermes bytes proti pinned commitu bez důvěry v Git index, replacement
refs či symlinkované předky.

Managed v1 přitom používá rootful Docker. Binding-scoped Hermes gateway proto
musí umět vytvářet terminal kontejnery a členství v `docker` group z ní dělá
důvěryhodnou součást Machine TCB s prakticky root-equivalentní mocí. Bridge tuto
moc nemá. Procesní a datové oddělení bindingů brání běžnému scope bleed, ale
kompromitace gatewaye je kompromitací celé Mašiny. Silnější hranice vyžaduje
pozdější ověřený rootless sandbox nebo úzký privilegovaný broker; současný
kontrakt ji nepředstírá.

Veřejný Buddy runtime obsahuje komunikační bridge mezi privátním Zulipem a
agentním runtime. Bridge sám nevlastní identitu ani mandáty: před prvním
síťovým krokem ověří mount privátního profilu, vloží jeho ústavu a mandáty do
každého turnu a odmítne běh bez úplného kontraktu. Běží pod odděleným účtem,
nevystavuje příchozí port a trvanlivou frontu drží mimo immutable root.
Managed Machines nasazení vytváří jeden gateway a jeden bridge proces pro
každý binding. Každý má vlastní OS identity, `HERMES_HOME`, frontu, API klíč,
port, session namespace a `GBRAIN_HOME`; Organization binding nikdy nedostane
Buddyho soukromý profil. Osobní binding vrství veřejný profilový `AGENTS.md`
s privátní ústavou a mandáty, zatímco Organization binding vrství veřejný
profil s instrukcemi právě vybrané Organizace. Žádná vrstva nenahrazuje druhou.
Oddělené procesy omezují záměnu scope, ale nejsou novým IAM ani novou Mašinou:
root VPS, její kompromitace a obnova zůstávají společnou hranicí.

Předchozí assisted `buddy-rollout` zůstává pouze přechodovou migrační lane pro
existující instalace. Používá již existující host custody soubor; secrets
nekopíruje ani nevypisuje. Cutover je vratný přes uchovanou původní systemd
unit a úspěch dokazuje registrace polleru, nikoli jen stav procesu.
Existující Personalspace se při migraci nekopíruje: updater ho adoptuje jako
explicitní updater-managed mutable mount kontrakt a service preflight ověří, že
deklarovaný Buddy profil skutečně leží uvnitř `active/personalspace`.
Produkční příkaz `buddy-rollout` skládá aktivaci rootu a service cutover do
jedné kompenzované operace. Selže-li service gate, novou aktivaci odstraní nebo
vrátí last-known-good a znovu zprovozní předchozí service vstupy.
Bun binárku pro unit volí Principál explicitně přes `--bun PATH`; preflight ji
resolveuje a ověří její spustitelnost runtime účtem, ale nevyžaduje root-owned
instalaci. Současně ověří, že ji ani Hermes checkout účty `buddy` a
`buddy-bridge` nevlastní a nemohou přepsat nebo nahradit přes zapisovatelný
parent.
Sanitizované privileged subprocessy chrání instalační krok před ambientním
`PATH` a Git hooky, ne Lazurio před Principálem.
Privátní Buddy profil zůstává mutable a služba jej čte přes běžná host
oprávnění. Další sandbox pro Personalspace tu nevzniká; přístup agentních
nástrojů omezuje existující Hermes sandbox.

## Profil AI Kolega a Steward overlay

AI Kolega je samostatný Principál. Má vlastní účet, seat, Mašinu,
Personalspace a přístupy do Organizací. Profil `ai-colleague` používá stejný
build, manifest, Doctor, updater a Managed controller jako Buddy, ale jiné root
instrukce a v1 právě jeden Organization Communication Binding. Jeho
Organization turn nikdy automaticky nemountuje ani nečte Personalspace.

Steward není třetí profil. Je to role overlay nad AI Kolegou, který může
zpřesnit workflow a health checks. Overlay však nevytvoří žádné oprávnění:
merge, release a administrativní operace dál povoluje jen přihlášená GitHub
identita, její Teamy a branch rules.

## Instalace, aktualizace a rollback

První nasazení celé Mašiny a aktualizace už nainstalovaného Lazurio Rootu jsou
dvě různé operace. Blank nebo obnovovanou Mašinu připravuje zvenku reviewovaný
operator plane; jeho public-safe vstup je `provisioning/README.md` ve source
checkoutu. Běžný update už aktivního Residenta provádí pouze jeho verzovaný
updater. Ansible může updater explicitně zavolat, ale nesmí znovu implementovat
kopírování, přepnutí active verze ani rollback.

Managed Linux lane v1 používá Machines Ansible pro host desired state a
Resident controller z exact Lazurio artefaktu pro runtime kompozici. Podporuje
Ubuntu 24.04 na x64/arm64, Bun 1.4.0, exact-pinned Hermes a GBrain, systemd,
Docker terminal sandbox, UFW, fail2ban, automatické security updates a
šifrovaný Restic checkpoint mimo host. GBrain je pro každý binding samostatný
PGLite/stdio store bez embeddings a s výslovně zvoleným search modem.

Buddyho osobní Zulip je součást stejné Mašiny: oficiální digest-pinned Compose
stack poslouchá aplikačně jen na loopbacku, veřejné TLS ukončuje Caddy a jeho
`/data` vstupuje do stejného quiesced checkpointu jako Resident. První apply
idempotentně založí realm, lidského ownera a Generic bot identitu; obnova nejdřív
ověří přesnou Machine/Profile/binding/artifact kompatibilitu. Organization Zulip
naopak patří jako explicitní Workload na Conglomerate Host a jeho výpadek se
obnovuje přes provider/SSH, nikdy přes samotný chat.

Host přijímá jen deklarované SSH recovery CIDRy a u Buddyho veřejné porty
80/443. Terminal sandbox má exact image digest, CPU/memory/PID limit,
`no-new-privileges`, žádný Docker socket a žádné automatické forwardování
host credentials. Síť je výslovná: `none`, nebo standardní `docker-bridge`.
Druhá volba znamená dostupný egress, nikoli předstíraný allowlist; skutečně
filtrovaný egress vyžaduje samostatný implementovaný mechanismus.

Release je svázaný s přesným artefaktem. Bezpečný lifecycle má tento tvar:

1. ověřit digest, manifest, profil a kompatibilitu s platformou;
2. rozbalit do nové verzované cesty, nikoli přes aktivní instalaci;
3. připojit existující mutable mounty bez kopírování jejich obsahu;
4. spustit integrity a profilový health gate;
5. teprve při PASS atomicky přepnout aktivní verzi;
6. ponechat poslední zdravou verzi jako explicitní rollback cíl.

Rollout v1 je úmyslně asistovaný a viditelný. Background daemon,
nepozorovaná fleet aktualizace a autonomní maintenance window nejsou součástí
základního kontraktu. Přesný stav aktuálního artefaktu ověří
`bun run resident:doctor`.

Managed Machines operace mají navíc uzavřený sled `readback → plan → review →
one-use Permit → apply → readback`. Každý úspěšný apply, backup, restore,
rollback i rebuild vytvoří nový šifrovaný off-host checkpoint a finální gate
vyžaduje exact aplikovaný Machines/Lazurio release, aktivní bindingy, sandbox,
čerstvou zálohu a checkpoint stejného artefaktu. Provider nákup nebo zrušení
VPS do tohoto lifecycle nepatří a vyžaduje samostatný Provisioning Intent.

Updater v1 drží immutable verze pod `versions/`, content-free lifecycle stav a
mutable `organizations/` a `personalspace/` pod odděleným `state/`. `active`
je atomicky měněný odkaz na jednu zdravou verzi. Po assisted bootstrapu
se update, status a rollback spouští z `active/resident/updater.mjs`; živý root
se kvůli tomu nestává source checkoutem.

Lifecycle adapter immutable hosted artefaktu v1 je záměrně pouze POSIX (Linux
a macOS). Windows hosted Resident se nezapne, dokud nebude mít vlastní atomický
pointer adapter a stejné failure testy. To neomezuje localhost Windows profil:
pracovní Root zůstává `%USERPROFILE%\\Lazurio` a package-managed CLI má vlastní
Windows kompatibilní brány. V dnešním Source profilu je source samotný Root;
po Managed migraci patří source oprava do
`%USERPROFILE%\\Lazurio\\development\\Lazurio` a task worktree.

Konkrétní offline postup pro status, update, rollback a zachování lokálního
hotfixu je v `manual/update-installed-resident.md` a je součástí resident
artefaktu.

## Hermes fork je release mirror

`Lazurio/hermes-agent` není vývojové repo a neočekává další contributory. Jeho
jediným správcem je Matěj Suchánek. Fork se obnovuje pouze z přesného upstream
release tagu: tree-neutral bridge zachová identický upstream strom a až nad něj
se aplikuje malý pořadový overlay popsaný ve `FORK_POLICY.md` a
`fork-maintenance/patches.v1.json`.

Produktové změny Buddyho a AI Kolegy patří do Lazurio nebo Machines, ne do
forku. Dočasný compatibility patch smí ve forku zůstat jen s popsanou upstream
mezerou, testem a objektivní retirement condition. Při každém refreshi se
nejdřív ověří, zda upstream už chování nedodal; pokud ano, lokální patch se ve
stejné změně odstraní nebo zúží. Consumery pinují exact commit, nezávislý Hermes
self-update je vypnutý a publikovaná historie ani tagy se nepřepisují.

## Když je potřeba vlastní oprava Launchpadu

Principál může na své Mašině připravit urgentní platformní opravu. Resident mu
v tom nestaví vlastnický ani permission zámek, ale package ani immutable
artefakt se ručně nepatchují. Oprava patří do kanonického development checkoutu
a task worktree; Doctor současně hlídá, aby runtime nepocházel ze skryté nebo
neověřitelné kopie.

Má-li oprava zůstat, projde přes PR a nový package nebo hosted artefakt. Do té
doby může development source link vědomě držet přesný hotfix commit; provenance
musí zůstat viditelná a permanentním link targetem nikdy není task worktree.
Systém zde Principálovi pomáhá odchylku vidět, nepředpokládá proti němu
nepřátelský model.

## Když něco nefunguje

- Nejdřív zastav další mutace a spusť resident Doctor.
- Rozliš veřejný artefakt, privátní Personalspace, Organization checkout,
  externí službu a agentní runtime. Jedna porucha neopravňuje procházet jiný
  scope.
- Aktivní verzi nepřepisuj poškozenou kandidátní verzí. Selhání před health
  gatem nechává active beze změny; post-switch selhání se vrací na poslední
  zdravou verzi.
- Do sdílené evidence patří verze, check, čas a content-free výsledek. Obsah
  paměti, konverzací, secrets ani osobní data tam nepatří.
- Neprokázaný přístup znamená „nemám přístup“. Nevytvářej náhradní token,
  účet, veřejný port ani druhou neauditovanou cestu.

## Kde žijí další informace

- Produktový source, build kontrakt a tento public manuál: Lazurio source.
- Obecné interní know-how a anonymizované learnings: Knowledgebase příslušné
  Organizace.
- Aktivní plán, rollout a blokery: její Mission Control.
- Osobnost, mandáty a paměť: privátní Personalspace.
- Jmenovitá evidence, credentials, zálohy a runtime logy: scoped privátní
  custody dané instalace.

Žádná z těchto vrstev se nestává druhou autoritou jen proto, že je lokálně
dostupná.
