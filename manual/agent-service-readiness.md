# Servisní připravenost agentů a dostupnost Workspace aplikací

**Návrh standardu k review.** Tento dokument definuje požadovaný výsledek
a acceptance pro implementaci a onboarding. Nezřizuje přístupy, nespouští
nasazení a netvrdí, že existující instalace už požadavky splňují. Automatická
konvergence URL je navazující cílová schopnost, ne nový existující CLI příkaz.

## Cíl a hranice

Po zadání autorizovaného servisního úkolu má Task Agent použít připravený
přístup svého Principála bez hledání klíčů, opakovaného zadávání hesel nebo
provider konzole. Nový Workspace modul má po řádném zařazení projít až
k funkční autentizované URL. Úspěchem není jen běžící proces.

Rozsah určuje [model Mašiny a pracovních prostorů](../ARCHITECTURE.md).
Agent uvnitř Team Workspace obsluhuje svůj pracovní prostor; přístup k host
OS a řídicí infrastruktuře vyžaduje samostatnou operátorskou capability.
Přístup do repozitáře, síťová dosažitelnost, autentizace na serveru a oprávnění
provést změnu jsou samostatné podmínky. Úspěšný test připojení neuděluje
publikační ani recovery mandát.

Standard nezavádí univerzální klíč, společný účet všech agentů, nový trezor,
centrální registr klientů ani další autorizační službu. Personalspace
a jednotlivé Organizace zůstávají oddělené. Servis Buddyho a AI Kolegy
zachovává jejich vlastní privacy a recovery kontrakty.

## Jeden vlastník každé pravdy

| Oblast | Autorita |
| --- | --- |
| Identita a GitHub oprávnění | Živý GitHub stav Principála |
| Konkrétní Mašina, její Owner a provozní záměr | Deployment repo vlastníka Mašiny |
| Host a provider přístup | Výslovně přidělená capability a její provider/host konfigurace |
| Tajné hodnoty a jejich obnova | Existující schválená custody mimo Git |
| Opakovatelný servis a jeho ověření | Příslušný verzovaný lifecycle/adaptér |
| Příslušnost modulu k Teamu a výchozí App | Kanonický Organization a module manifest |
| Routy, DNS a runtime stav | Odvozený výstup a ověřená pozorování, nikoli další ruční seznam |

Veřejný Lazurio kontrakt popisuje požadavky a čitelnou diagnostiku. Konkrétní
provozní implementace a její piny zůstávají u svého vlastníka; veřejný root
nepřebírá privátní mutation rozhraní ani credentialy.

## Přístup připravený před úkolem

Onboarding určí autorizovaného operátora, jeho konkrétní servisní Mašinu
a účel přístupu ke každému cílovému hostu. Použije existující credential
reference a provozní postup. Stejný credential se nerozkopíruje na nezávislé
runnery; souběh změn drží existující lifecycle zámek.

Na lidské workstation může odemykání zajistit OS Keychain a SSH agent.
Bezobslužný provoz potřebuje vlastní explicitně spravovanou custody,
dostupnou po restartu bez lidského dialogu. Volba mechanismu respektuje
[local secret custody](security/local-secret-custody.md); Git obsahuje
pouze reference. Tajná hodnota se nepředává v příkazu, chatu ani diagnostice.
Není nutné zpřístupnit celý trezor kvůli jednomu servisnímu klíči.

Před první změnou se ověří všechny hosty, které úkol skutečně potřebuje,
včetně řídicího hostu, pokud na něm závisí dokončení:

1. Přesný cíl, Owner, vykonávající Principál a rozsah operace.
2. Dosažitelnost schválenou sítí a ověřená identita hostu.
3. Neinteraktivní autentizace z aktuální agentní relace.
4. Skutečný omezený readback a read-only ověření potřebné capability.
5. Dostupnost deklarovaných závislostí nezbytných pro dokončení úkolu.

Zkouška zápisové capability nesmí sama měnit produkční data ani restartovat
službu. Kde ji nelze bezpečně ověřit, výsledek tuto nejistotu přizná;
nepovýší readback na důkaz povoleného apply. Běžné změny pokračují existující
publikační a lifecycle cestou, bez nového approval procesu tohoto standardu.

Výstup obsahuje pouze identitu cíle a vykonavatele, netajnou referenci,
ověřenou operaci, čas a konkrétní důvod selhání. Neobsahuje credential ani
jeho digest. Není trvalým příznakem `ready`: po změně účtu, sítě, klíče,
relace nebo cíle se zkouška opakuje. Nenahrazuje čerstvé preconditions apply.

Zamčený klíč, chybějící grant a nedostupná síť jsou různé diagnostické
výsledky. Agent nezkouší náhodné účty a klíče a automaticky nepřechází
na veřejný SSH port, recovery účet nebo jinou Organizaci.

## Ověřená obnova

Nouzová cesta je nezávislá na porouchaném Headscale, jeho DNS, běžném
credentialu i jediném původním zařízení. Samotná existence tlačítka Console
nebo uloženého souboru není recovery důkaz. Určený vlastník musí umět
obnovit provider přihlášení a použít deklarovaný způsob obnovy hostu.

Recovery se vyvolává výslovně s konkrétním cílem a dopadem. Nevytváří
skrytou běžnou servisní cestu. Postup zachovává disky, data a rozdělanou
práci, pokud přesný incident nevyžaduje jiný odsouhlasený zásah. Po obnově
se host vrátí k deklarovanému přístupu a dočasný vstup se odstraní.

Acceptance přístupu zahrnuje čerstvou agentní relaci, restart servisní
Mašiny, obnovu po ztrátě původního zařízení, rotaci a revokaci. Po rotaci
funguje nový credential a starý je odmítnut; existující relace se ukončí
nebo se jejich zbývající platnost výslovně vypořádá. Výsledky a poslední
ověření drží owner evidence, nikoli kopie tajných hodnot.

## Modul až po funkční URL

Výchozí zůstává kanonická subdoména `<modul>.<team>.<doména>`
([decision 0021](decision-register.md)). Samostatný origin aplikace
zachovává její běžné routování. Varianta za lomítkem se použije jen při
vědomém kontraktu aplikace pro base path, redirecty, cookies a WebSockety;
není obecnou opravou chybějící konvergence.

Cílový tok je:

```text
publikovaná deklarace modulu a existující GitHub granty
  → jedna odvozená projekce služeb Teamu
  → sladění ingressu, DNS, TLS a autentizace
  → Launchpad udržuje výchozí App podle hosted lifecycle (decision 0137)
  → test běžné URL oprávněným uživatelem
```

DNS určuje směrování, ne oprávnění uživatele. Přidání modulu samo neuděluje
repo grant ani přístup do jiného Teamu. Team Workspace nedostává provider
DNS token nebo oprávnění měnit řídicí host. Neznámý Host se odmítá; ani
wildcard záznam nebo certifikát nesmí zpřístupnit nedeklarovanou aplikaci.

Zdroj rout je stejná kanonická deklarace, kterou používá Launchpad.
Port, Team ani výchozí App se nehádají a nevzniká další autoritativní
service catalog. Odvozená projekce nese vazbu na přesný zdroj a pozorovanou
identitu cílového Workspace. Neplatný manifest zastaví jeho změnu.

Současné oddělení hostů se zachovává: změna Organization Hostu neopravňuje
měnit řídicí host. Automatické dokončení obou kroků musí použít jejich
existující autorizační kontrakty. Případná trvalá automatická DNS konvergence
vyžaduje explicitní rozhodnutí o omezené zóně, Teamu, dovolených změnách
a revokaci mandátu; již spotřebovaná jednorázová autorizace se nepoužívá
znovu. Tento návrh takový mandát neuděluje a nezavádí další autorizační
mechanismus.

Přidání, odebrání, přejmenování a rollback mají stejný zdroj. Při částečném
selhání se nesmí stará routa přesměrovat na jiný modul; zachová se poslední
ověřený stav tam, kde je stále autorizovaný. Odebraný přístup se nezachovává
jako dostupnostní fallback. Nedokončená změna je `incomplete` s konkrétním
neprovedeným krokem a pokračováním, ne úspěch z host-local health.

## Acceptance a zavádění

| Scénář | Požadovaný důkaz |
| --- | --- |
| Nová agentní relace | Autorizovaný readback bez heslového dialogu a bez konzole |
| Chybějící nebo odvolaný přístup | Přesný blocker, žádný automatický recovery fallback |
| Ztráta původního zařízení | Ověřená nezávislá obnova v owner scope |
| Nový modul | Běžné DNS → platné TLS → autentizace → správná App |
| Neoprávněný uživatel nebo neznámý Host | Odmítnutí, nikoli výchozí cizí aplikace |
| Odebrání/přejmenování modulu | Starý vstup nezpřístupňuje jiný modul ani odebraný přístup |
| Opakování a souběh | Nulová změna po konvergenci; serializace podle existujícího lifecycle |
| Výpadek DNS/řídicího hostu | Pravdivé `incomplete`, zachování práce a vymezené pokračování |
| Rollback | Předchozí autorizovaná aplikace funguje přes běžnou URL |

Nejmenší zavedení nejdřív opraví dostupnost existujícího credentialu
a provede readiness na jedné Organizaci. Potom doplní stejné měřitelné
výsledky do opakovatelného servisního postupu. Teprve na této cestě ověří
přidání a odebrání jednoho modulu přes celý URL tok. Další Organizace
přebírají verzované chování a vlastní konfiguraci; nepřebírají cizí klíče.
Evidence neoznačí celý rollout za hotový podle jediného úspěšného klienta.

## Porovnané varianty

- **Opravit jen jeden klíč:** nejrychlejší incidentní oprava, ale neověří
  příští relaci ani dokončení závislé na dalším hostu.
- **Rozšířit existující servis a projekci:** doporučený nejmenší úplný řez.
  Jedna autorita konfigurace, dostupné credentialy pro přesný účel,
  opakovatelný test a postupná adopce.
- **Nový SSH certificate broker, univerzální trezor nebo servisní daemon:**
  zatím bez doložené potřeby. Přidává novou dostupnostní a recovery závislost.
- **Všechny aplikace za lomítkem:** mění aplikační kontrakty a origin izolaci,
  ale neřeší nedostupný servisní přístup ani chybějící reconciliation.

Shaping prošel nezávislou protiváhou se zaměřením na duplicitní autority,
readiness versus autorizaci, revokaci a částečný rollout. Jde o návrh
acceptance; živý drill obnovy a automatický URL consumer zatím tímto
dokumentem prokázány nejsou.
