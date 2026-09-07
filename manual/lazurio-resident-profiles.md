# Buddy, Workspace a automatizovaná práce v Lazuriu

Lazurio je pracovní prostředí, ve kterém lidé a stroje používají stejné
Organizace, nástroje a dohledatelné procesy. Buddy je osobní Resident runtime;
Workspace je pracovní runtime. Firemní automatizovaná Mašina používá svěřené
účty a mandát Organizace a nevyžaduje samostatnou AI personu ani Buddy runtime.

Tento manuál je veřejná a offline dostupná část kontraktu. Neobsahuje
konkrétní osobnosti, mandáty, paměť, jména instalací, incidentní logy ani
credentials.

## Jedna mapa pojmů

| Pojem | Co znamená |
| --- | --- |
| Principál | Ten, pro koho Agent pracuje a kdo má poslední slovo. |
| Kolega | Lidský Principál. Jeho pracovní Root leží přímo v home; dnešní Source Root může do migrace nést historický název složky, fresh/Managed target je `<home>/Lazurio`. Managed profil potřebuje source checkout jen pro vývoj Lazuria. |
| Buddy | Osobní zástupce jednoho lidského Principála uvnitř jeho Personalspace. Jedná jen v mezích jeho práv a mandátů. |
| Firemní automatizovaná Mašina | Mašina Organizace se svěřeným účtem, mandátem a odpovědným člověkem; Agenty spouští harness. |
| Task Agent | Nástrojová pracovní relace, například Codex nebo Claude Code. Sama žádná práva nevlastní. |
| Steward | Organizační role, jejíž práci může podle mandátu vykonávat automatizace. Její název nic neautorizuje; rozhodují živá GitHub práva. |
| Mašina | Fyzické zařízení, virtuální server nebo providerem izolovaný hostovaný pracovní prostor, který tvoří jednu sdílenou runtime, bezpečnostní a recovery hranici se známým Ownerem. |
| Personalspace | Privátní prostor právě jednoho Principála a případného Buddyho. |
| Organizace | Jedna firma, jeden GitHub Organization scope a jedna access hranice. |

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
prostoru člověka nebo firemní automatizace. Není druhým datovým modelem hosted prostředí:
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

Buddy není firemní automatizovaná Mašina. Běžný Task Agent spuštěný na Buddyho
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

Jedna úzká provozní podmínka z toho neustupuje: runtime nesmí vlastnit ani umět
přepsat sandbox, který jej omezuje. Hermes checkout a Bun může vlastnit a měnit
Principál nebo jím řízená maintenance identita, která nespouští agentní relaci.
Účty `buddy` a `buddy-bridge` k nim musí mít pouze potřebné čtení/spuštění a
nesmí je nahradit ani přes parent adresář. Preflight kontroluje skutečná host
oprávnění a tracked Hermes bytes proti pinned commitu bez důvěry v Git index,
replacement refs či symlinkované předky. Jde o self-protection existujícího
Hermes sandboxu, ne o nový Lazurio ACL.

Veřejný Buddy runtime obsahuje komunikační bridge mezi privátním Zulipem a
agentním runtime. Bridge sám nevlastní identitu ani mandáty: před prvním
síťovým krokem ověří mount privátního profilu, vloží jeho ústavu a mandáty do
každého turnu a odmítne běh bez úplného kontraktu. Běží pod odděleným účtem,
nevystavuje příchozí port a trvanlivou frontu drží mimo immutable root.
Přechodová služba používá již existující host custody soubor; jeho secrets
nekopíruje ani nevypisuje. Cutover je vratný přes uchovanou původní systemd
unit a úspěch nového residenta dokazuje registrace polleru, nikoli jen stav
procesu. Unmanaged pre-resident unit se před migrací i po explicitním restore
ověřuje svým legacy enabled/active systemd kontraktem; nový `poller.json` po ní
se nedá vyžadovat.
Hermes dostává aktivní Lazurio Root jako `TERMINAL_CWD`, aby jeho context-file
discovery vložilo veřejný profilový `AGENTS.md` i do Zulip session. Ten se
vrství s privátní ústavou a mandáty; žádná z těchto vrstev nenahrazuje druhou.
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

## Firemní automatizace a práce Stewarda

Rozhodnutí 0143 nahrazuje plán budoucího `ai-colleague` profilu automatizovanou
Mašinou Organizace. Harness se vybírá podle potřeb práce; Buddyho Hermes a
privátní komunikační bridge nejsou povinným firemním runtime.

Steward označuje práci podle organizačních pravidel. Svěřený účet musí mít
živá provider oprávnění a samostatná Publikace musí být výslovně pokrytá
účinným mandátem. Jméno Mašiny, role overlay ani prompt pověření nevytváří.
Kanonický domov, schválenou revizi a odvolání drží
[Organization mandáty](organization-mandates.md).

Staré `ai-colleague` Personalspace záznamy zůstávají pouze čitelným migračním
vstupem. Nová tvorba je zakázána; soukromá data se automaticky nepřevádějí do
Organizace. Tato změna není rolloutem živého scheduleru, účtů ani mandátů.

## Instalace, aktualizace a rollback

První nasazení celé Mašiny a aktualizace už nainstalovaného Lazurio Rootu jsou
dvě různé operace. Blank nebo obnovovanou Mašinu připravuje zvenku reviewovaný
operator plane; jeho public-safe vstup je `provisioning/README.md` ve source
checkoutu. Běžný update už aktivního Residenta provádí pouze jeho verzovaný
updater. Ansible může updater explicitně zavolat, ale nesmí znovu implementovat
kopírování, přepnutí active verze ani rollback.

Buddy/Linux operator lane v1 používá jen existující mechanismy: Ansible pro
host desired state, upstream install rozhraní Hermesu a GBrainu, Tailscale jako
access plane, UFW jako host firewall a provider snapshot jako recovery bod.
Nový osobní GBrain začíná na lokálním PGLite; nevzniká kvůli němu další
PostgreSQL service. Zulip je privátní externí transport prerequisite a Buddy
bridge jej polluje odchozím spojením, takže resident host nepotřebuje veřejný
Zulip ingress.

Síťový kontrakt Linux profilu v1 má nulový veřejný ingress. SSH, případný
privátní Zulip HTTPS a servisní UI se připouštějí pouze přes deklarované
tailnet rozhraní. Najde-li preflight staré veřejné nebo jinak cizí allow
pravidlo, nic nemaže ani nepřepisuje: zastaví se a nechá Principála rozhodnout,
co na jeho Mašině skutečně patří zachovat.

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
- Osobnost, osobní mandáty a paměť Buddyho: privátní Personalspace.
- Firemní mandáty: `MANDATES.md` příslušného Organization repozitáře.
- Jmenovitá evidence, credentials, zálohy a runtime logy: scoped privátní
  custody dané instalace.

Žádná z těchto vrstev se nestává druhou autoritou jen proto, že je lokálně
dostupná.
