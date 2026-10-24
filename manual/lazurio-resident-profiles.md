# Lazurio Resident a jeho profil Workspace

> **Buddy nemá Resident profil (decision 0210).** Buddy je Hermes Agent
> v Osobním Prostředí svého uživatele; co o něm platí, drží
> [manuál Buddyho](https://github.com/HumanAndMachines/Lazurio/blob/main/manual/buddy.md).
> Profil Buddyho v Resident distribuci, jeho Zulip bridge a operator plane
> jeho hostů skončily. Dosavadní hostované instalace Buddyho se do své migrace
> řídí pravidly svého hostu.

Lazurio je pracovní prostředí, ve kterém uživatelé a stroje používají stejné
Organizace, nástroje a dohledatelné procesy. Lazurio Resident je immutable
runtime artefakt Lazuria postavený z jednoho přesného source commitu, ne druhá
kopie Lazuria ani dlouhodobá Git branch. Build kontrakt dnes vydává jediný
profil, Workspace.

Tento manuál je veřejná a offline dostupná část kontraktu. Neobsahuje
konkrétní osobnosti, mandáty, paměť, jména instalací, incidentní logy ani
credentials.

## Jedna mapa pojmů

| Pojem | Co znamená |
| --- | --- |
| Uživatel | Ten, kdo Environment ovládá, a tím i Agenty, které v něm spouští; Agenti pracují pro něj a poslední slovo má on. Uživatelem je vždy člověk (decision 0175 s dodatkem z 2026-10-21; starší záznamy mu říkají Operátor). Není to role User v Organizaci. |
| Kolega | Uživatel v Organizaci. Jeho pracovní Root leží přímo v home; dnešní Source Root může do migrace nést historický název složky, fresh target je `<home>/Lazurio`. |
| Buddy | Osobní zástupce jednoho uživatele. Běží v jeho Osobním Prostředí (decision 0210) a jedná jen v mezích jeho práv a mandátů. Resident profil nemá. |
| Prostředí Henry | Pracovní Prostředí Organizace s nastavenými automatizacemi: práci v něm dělají boti Lazurio MausBotu pod vlastním GitHub účtem persony a odpovídá za něj Owner nebo Admin Organizace (decisions 0169 a 0170 s dodatkem z 2026-10-19). Vlastní Resident profil nemá a není Buddy. |
| Task Agent | Nástrojová pracovní relace, například Codex nebo Claude Code. Sama žádná práva nevlastní. |
| Steward | Organizační role Kolegy; stejně se jmenuje preset Lazurio MausBotu v Prostředí Henry. Název role ani presetu nic neautorizuje; rozhodují živá GitHub práva. |
| Mašina | Fyzické zařízení, virtuální server nebo providerem izolovaný hostovaný pracovní prostor, který tvoří jednu sdílenou runtime, bezpečnostní a recovery hranici se známým Ownerem. |
| Personalspace | Privátní prostor právě jednoho uživatele a případného Buddyho. |
| Organizace | Jedna firma, jeden GitHub Organization scope a jedna access hranice. |

Kanonickou cross-profile definici drží root `ARCHITECTURE.md`. Tento manuál dál
slovem Mašina myslí konkrétně Mašinu hostující Residenta. Hosted Team Workspace
se v širším modelu také počítá jako Mašina Teamu, ale tento fakt sám z něj
nedělá Resident profile ani Personalspace.

## Source, pracovní Root a runtime nejsou totéž

Kanonický Lazurio source je Git repozitář, ve kterém se vyvíjí společný
Launchpad, CLI/Core, Doctor, Guide, manuály, generátor a profilové buildy.
Pracovní Root workstation žije přímo v home: podporovaný Source Root je
ověřený Git checkout, který může do migrace nést historický název složky;
fresh target je přesně `<home>/Lazurio`. Dříve plánovaný Managed profil
(generovaný non-Git Root) se podle decision 0164 nestaví; instalace Root Repa
přejdou jednosměrně do Lazurio Folderu spravovaného LazurioPlatform.

Každý pracovní Root:

- má právě jeden aktivní root `AGENTS.md`; v Source profilu je trackovaný,
  v hosted Resident profilu generovaný profile buildem;
- obsahuje `personalspace/` a `organizations/` jen jako oddělené mutable Git
  mounty s vlastními access hranicemi;
- nenese druhou vendored kopii CLI ani Launchpadu.

Dnešní Source Root používá source-linked CLI. Hosted Resident může
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
prostoru Kolegy. Není druhým datovým modelem hosted prostředí:
lokální i vzdálený pracovní prostor používají stejný Lazurio Root kontrakt,
Organization Rooty, org-level repa a Workspace Moduly. Liší se jen transportem, custody,
aktivní Team projekcí a způsobem provozního nasazení runtime.

Runtime artefakt běží mimo mutable working root. V hosted kontejneru je
kanonické rozhraní `LAZURIO_RUNTIME_ROOT=/opt/lazurio-runtime` a
`WORKSPACE_ROOT=/home/builder/Lazurio`; Launchpad se spouští z první cesty a
druhou dostává přes `--root`. Runtime nemá self-update. Exact build, startup
gate a rollout pořadí drží `manual/lazurio-runtime-install-interface.md`.

## Automatizovaná práce Organizace

Pro automatizovanou práci Organizace se žádný další Resident profil nestaví.
Nese ji Prostředí Henry: obyčejné Pracovní Prostředí Organizace s nastavenými
automatizacemi, ve kterém práci dělají boti Lazurio MausBotu (decisions 0169
a 0170 s dodatkem z 2026-10-19). Hermes zůstává jen Buddymu.

## Instalace, aktualizace a rollback

První nasazení celé Mašiny a aktualizace už nainstalovaného Lazurio Rootu jsou
dvě různé operace. Mašinu připravuje zvenku reviewovaný operator plane; pro
Prostředí je to Machines. Aktivaci verze, kontrolu a rollback drží verzovaný
updater Lazuria, který operator plane volá z ověřeného operator kitu. Operator
plane nesmí znovu implementovat kopírování, přepnutí active verze ani rollback.

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
je atomicky měněný odkaz na jednu zdravou verzi. Update, status a rollback
spouští operator kit mimo aktivní root; živý root se kvůli tomu nestává source
checkoutem.

Lifecycle adapter immutable hosted artefaktu v1 je záměrně pouze POSIX (Linux
a macOS). Windows hosted Resident se nezapne, dokud nebude mít vlastní atomický
pointer adapter a stejné failure testy. To neomezuje localhost Windows profil:
pracovní Root zůstává `%USERPROFILE%\\Lazurio`. V dnešním Source profilu je
source samotný Root a oprava patří do task worktree.

## Když je potřeba vlastní oprava Launchpadu

Owner může na své Mašině připravit urgentní platformní opravu. Resident mu
v tom nestaví vlastnický ani permission zámek, ale package ani immutable
artefakt se ručně nepatchují. Oprava patří do kanonického development checkoutu
a task worktree; Doctor současně hlídá, aby runtime nepocházel ze skryté nebo
neověřitelné kopie.

Má-li oprava zůstat, projde přes PR a nový package nebo hosted artefakt. Do té
doby může development source link vědomě držet přesný hotfix commit; provenance
musí zůstat viditelná a permanentním link targetem nikdy není task worktree.
Systém zde Ownerovi pomáhá odchylku vidět, nepředpokládá proti němu
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
