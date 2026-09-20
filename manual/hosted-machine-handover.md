# Předání hostované Mašiny a onboarding operátora

Tento kontrakt rozpracovává rozhodnutí 0144, 0146 a 0147–0149. Jeho autoritou je
`ARCHITECTURE.md` a registr rozhodnutí; nejde o nový IAM, registr Mašin ani další
instalační systém. Popisuje cílovou hranici a výslovně odlišuje její dosud
nedokončenou implementaci. Konkrétní nasazení, evidence a pořadí oprav patří do
Deployment Repa vlastníka a jeho Mission Controlu.

## Hranice odpovědností

| Oblast | Vlastník odpovědnosti | Podmínka předání |
|---|---|---|
| Dedicated server, hypervisor, CPU/RAM/disk, vytvoření a odstranění guestu | Machines podle owner Deployment Repa | Guest a jeho prostředky odpovídají schválenému stavu |
| OS, management transport, přidělený OS účet a sudo | Machines | Fungující správa a oddělení guestů, bez osobních tokenů v image |
| Tailnet, DNS, TLS, gateway a vstup do konkrétní VM | Machines a příslušné síťové/Auth služby | Vstup funguje pro oprávněný subjekt, neoprávněný vstup je odmítnut |
| Identita Mašiny, Owner a vyšší provider/operator hranice | Machines, projekce owner Deployment Repa | Platný popis identity; nejde o oprávnění číst repozitáře |
| Instalace podporované distribuce Lazuria | Machines vyvolají podporovaný Platform instalátor | Čisté Lazurio se spustí bez Organization checkoutu |
| Lazurio Folder, Environment preset, instrukční profil, Launchpad, nástroje a jejich aktualizace | LazurioPlatform přes `lazurio` | Jedna instalační a aktualizační cesta vlastněná Platformou |
| Osobní `gh` přihlášení a volba Organizací | Operátor individuální VM | Přihlášení vlastním účtem; žádná identita vypůjčená od provisionera |
| Materializace a synchronizace Organizací a Modulů | LazurioPlatform na explicitní volbu operátora | Čerstvá živá práva na GitHubu, existující materializační mechanismus |
| Projektové závislosti, pracovní nastavení, aplikace a data | Operátor a příslušná Organizace | Jejich vlastní workflow; nejsou podmínkou vytvoření VM |
| Záloha a obnova Mašiny | Machines v rozsahu provozního kontraktu | Ověřený restore; není to oprávnění číst nebo zveřejnit obsah |
| Konzistence a migrace aplikačních dat | Vlastník aplikace/dat s operátorem | Aplikační kontrola, samostatně od health VM |

Machines mohou znovu spravovat svou infrastrukturu i po předání. Předání není
ukončení provozní odpovědnosti. Reconcile infrastruktury ale nevybírá checkouty,
nepřepisuje přihlášení, nevytváří další Platform updater a nevrací operátorovy
nástroje na starší verzi. Obnova infrastruktury a obnova prostředí mají mít
odděleně doložený výsledek.

## Čtyři odlišné vztahy

1. **Owner Mašiny** určuje vlastnictví a provozní/recovery hranici. Organizace
   provozující dedicated server není automatickým seznamem obsahu guestu.
2. **Oprávnění vstoupit do VM** stanovuje její gateway a živá přístupová politika.
   Přihlášení do gateway samo nevytváří `gh` session ani repo grant.
3. **GitHub identita uvnitř individuální VM** je účet jejího operátora. GitHub
   určuje dostupné Organizace, Teamy a repozitáře při konkrétní operaci.
4. **Obsah Lazurio Environment** vybírá operátor z toho, k čemu má oprávnění.
   Vlastnický label Mašiny není allowlist Organizací pro Launchpad.

Pro individuální VM může operátor zvolit více Organizací; každá zůstává
samostatným checkoutem a access hranicí. Změna výběru není Machines rollout
ani změna identity Mašiny. Repository credentials nejsou součástí image,
Deployment Repa, záloh s širší dostupností ani předávací evidence. Povolení
na GitHubu neodstraňuje pravidla dané Organizace o umístění dat ani vyšší
provider/operator hranici hostované VM. Personalspace se na Organization-owned Mašině nemountuje, ani když ji používá
jen jeden přiřazený člověk; jeho vlastní osobní Mašina má odlišného Ownera
a privátní hranici.

## Individuální VM a sdílený Team Workspace

**Individuální hostovaná VM** má jednoho přiřazeného lidského operátora. Ten
používá vlastní `gh` účet a volí obsah stejně jako na své pracovní stanici.
Ownerem může zůstat Organizace. Jednočlenný GitHub Team použitý pro vstup do
VM sám z Mašiny nedělá sdílený Team Workspace ani nemění identitu Git operací.

**Hosted Team Workspace** je sdílená Mašina vlastněná Organizací bez osobního
operátora. Společné soubory, procesy a Git identita se řídí týmovým kontraktem.
Podle rozhodnutí 0147–0149 používá Lazurio for GitHub přes scoped broker,
ne osobní token posledního přihlášeného člověka. Jeho organizační a týmový
rozsah zůstává omezený; do tohoto prostředí se nepřenáší pravidlo osobní VM
„přihlásím svůj účet a připojím libovolnou svou Organizaci“. Samotná instalace
Lazuria ani zde nesmí potřebovat checkout firemních dat; následná týmová
materializace je samostatná Platform operace s týmovou identitou.

**Machine Profile** v Machines vyjadřuje custody, access a recovery politiku.
**Workspace preset** v LazurioPlatform skládá Environment: způsob provider
identity, nástroje, nabízená rozhraní, správu procesů a výchozí update channel.
Jeho kanonický kontrakt je [Platform workspace presets](https://github.com/Lazurio/LazurioPlatform/blob/main/docs/workspace-presets.md):
`hosted-private` pro individuální použití a `hosted-team` pro sdílené použití
jsou přijatý směr, dosud ne hotová funkcionalita. Preset se volí explicitně,
neodvozuje se z Teamu, hostname ani OS účtu. **Instrukční profil** Folderu
(locale, odbornost, způsob spolupráce) je užší oblast; nevlastní infrastrukturu,
procesy ani aktualizace produktu. Požadavek „Hosted Virtual Machine“ se promítá
do těchto existujících kontraktů, nikoli do dalšího univerzálního profilu.
Tento text nezavádí nový enum, store nebo nastavovací CLI.

Instalace a aktualizace produktu jsou oddělené od výběru/synchronizace obsahu;
aktualizace neklonuje Organizace a synchronizace neaktivuje produktový release.
Závazné návrhy a jejich implementační stav drží Platform
[handover consumer](https://github.com/Lazurio/LazurioPlatform/blob/main/docs/machine-handover.md),
[hosted entry](https://github.com/Lazurio/LazurioPlatform/blob/main/docs/hosted-entry.md)
a [content sync](https://github.com/Lazurio/LazurioPlatform/blob/main/docs/content-sync.md).
Současné Organization příkazy legacy Lazuria nejsou důkazem implementace těchto
operací v nové Platform distribuci.

## Dva samostatné výsledky

### Mašina připravená k předání

- Jsou ověřené prostředky, OS, identita, management, síť a izolace.
- Webový vstup má platný certifikát, správné DNS a funkční přístupovou bránu.
- Čisté Lazurio a základní pracovní vstup běží bez Organization checkoutu,
  bez osobního GitHub tokenu a bez přihlášení operátora k AI nástrojům.
- Launchpad zobrazuje pravdivý prázdný stav; chybějící checkout nezpůsobí pád
  serveru, automatické klonování ani přístup k jiné Organizaci.
- Opakovaná instalace zachová identitu a již existující pracovní data.
- Záloha/restore má samostatný ověřený výsledek. Pokud je pro pilot výslovně
  odložený, report uvede toto omezení; neoznačí obnovu za ověřenou.

### Operátor připravený pracovat

- Dokončil vstup z vlastního zařízení a přihlášení vlastním `gh` účtem.
- Vybral a materializoval požadované dostupné Organizace stávajícím CLI.
- Launchpad objevil checkouty bez změny Machines konfigurace; moduly stále
  respektují Organization hranice a živá oprávnění.
- Nastavil vlastní nástroje, jejich přihlášení a projektové závislosti.
- Ověřil reálnou práci. Úspěšné přihlášení do webu není důkaz SSH, Git přístupu,
  funkce každého modulu ani aplikační obnovy.

Čekání na lidské přihlášení je `onboarding pending`, nikoli porucha provisioningu.
Tyto názvy jsou význam stavů, ne tvrzení o existujících strojových enum hodnotách.
Report fleetu nesmí sloučit infrastrukturu, základní Lazurio a operátorskou
acceptance do jediného nezdůvodněného zeleného políčka.

## Současné rozpory a dokončení migrace

| Pozorovaná implementace | Rozpor | Správný vlastník nápravy |
|---|---|---|
| Hosted Launchpad vyžaduje existující Organization/Team při startupu | Čistá instalace bez checkoutu spadne | Launchpad: prázdný funkční shell, přísná validace již připojeného scope |
| `LAZURIO_ORGANIZATION_SLUG` a `LAZURIO_TEAM_ID` současně filtrují celý hosted inventory | Vstupní scope VM se zaměňuje s výběrem obsahu individuálního operátora | Platform runtime: oddělit individuální a sdílené použití při zachování request trust |
| Workspace VM role instalují optional Organization archive a vlastní resident/tool artifacty | Infrastruktura vytváří a udržuje Environment mimo Platform instalátor | Migrace dle 0144: kvalifikovat Platform handover a pak odstranit supersedovanou cestu |
| Označení „hosted“ se používá současně pro síťový trust a týmový lifecycle | Přepnutí na local by mohlo oslabit gateway ochranu | Zachovat hosted request trust; obsahové a lifecycle chování řešit samostatně |
| Owner gateway roster někde obsahuje seznam firemních Modulů místo minimálního vstupu | Obsah operátora je zadrátovaný do infrastruktury | Zachovat jen základní vstupy; ostatní deklarovat existujícím Platform katalogem, ověřit consumer před odstraněním legacy routes |
| Hosted app hostname se odvozuje jen z modulu a Mašiny | Více Organizací se stejným modulem může kolidovat | Platform katalog: před širším rolloutem prokázat jednoznačný slot a fail-closed kolize, bez druhého katalogu v Machines |
| Machine identity má OS operátora, ale neurčuje spolehlivě osobní vs sdílenou Git identitu | Jméno Unix účtu ani velikost Teamu nejsou důkaz režimu | Verzovaná owner deklarace a Platform consumer; nepřidávat odhad nebo paralelní ACL |
| Staré runbooky říkají „pending“ nebo „aktuální“ i po změně release | Cíl a nasazený stav se směšují | Owner docs a generované release/readback odkazy; historické evidence neměnit |

Oprava prázdného startupu sama **neimplementuje** multiorganizační hosted
Environment ani celý Platform handover. Dokud zůstává single-Organization
filtr, jde o výslovné migrační omezení; nesmí se vydávat za finální individuální
VM profil. Nesmí se obcházet vypnutím Auth, změnou trust profilu na local nebo
předinstalací checkoutu pod administrátorovým přihlášením.

Před odstraněním současných workspace resident rolí musí jedna kvalifikační
VM prokázat Platform instalaci, prázdný start, operátorské přihlášení,
materializaci vybraných Organizací, modulovou izolaci, aktualizaci a recovery
při zachování identity a dat. Team Workspace dostane samostatný důkaz identity
brokeru a týmového scope. Role sdílené s Buddy a AI Kolegy se touto migrací
neodstraňují. Konkrétní rollout pořadí patří do Mission Controlu, ne sem.
