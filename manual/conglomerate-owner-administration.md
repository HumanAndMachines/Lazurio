# Správa Conglomerate Hostu vlastníky Organizace

Tento standard platí stejně pro každou Organizaci. Konkrétní účty, zařízení,
klíče, síťové vazby a důkazy celého hostu patří výhradně do Deployment Repa
vlastníka této Mašiny. U sdíleného hostu tenantní Organizace drží jen své
ohraničené vstupy nebo reference; nevytvářejí další autoritu nad společným
hostem a nekopírují přístupová data jiných tenantů. Text
standardu sám nezakládá oprávnění a nedokazuje, že je daná Organizace nasazená.

## Běžná práce Ownera

Aktivní GitHub Organization Owner musí mít po schváleném onboardingu možnost
spravovat vlastní Conglomerate Host z konkrétně povoleného osobního počítače a
osobní hostované Mašiny. Spojení vede přes Headscale a nativní SSH, pod vlastní
jmenovitou identitou se samostatně odvolatelnými klíči. Nezávisí na domácí IP,
počítači, přihlášení ani privátním klíči jiného Ownera nebo dodavatele.

Členství v tailnetu, společný Headscale user, tag pracovního prostředí ani jméno
mašiny nejsou důkaz role Owner. Ověř živou GitHub roli a přesnou vazbu zařízení
na schváleného Ownera. Přístup se nedává automaticky všem uzlům Organizace.
Telefon a pracovní VM správní práva implicitně nezískávají. Jejich běžný SSH a
webový přístup do pracovních prostředí je samostatná věc.

Privátní klíč zůstává na zdrojové mašině. Server má jmenovité SSH účty, přesné
síťové granty a potřebné správní oprávnění. Povol jen schválené protokoly a
směry; odpověď na navázané spojení není oprávnění zahájit opačné spojení.
Vazbu nové IP či reenrollmentu nikdy neopravuj automatickým širokým grantem.

## Samostatnost a odpovědnost

Úspěšné SSH není dokončený onboarding. Owner musí pod svým účtem:

1. ověřit stav Headscale a načíst potřebnou konfiguraci;
2. přistupovat k vlastnímu infrastrukturnímu repozitáři;
3. navrhnout, validovat a provést autorizovanou změnu standardním nasazovacím
   postupem s vlastními potřebnými přístupy;
4. rozumět publikaci, review a obnově a mít dostupnou recovery cestu.

Správní sudo neruší pravidla pro Task Agenty: požadovaný stav stále vlastní
Deployment Repo vlastníka Mašiny a změny procházejí podporovaným lifecycle,
kontrolou a publikací.
Nezávislá kontrola může vyžadovat oprávněného Kolegu, nesmí však stát na tajných
údajích, které vlastní jen dodavatel. Popiš rozdíl mezi technickou závislostí a
vědomě nastaveným schvalovacím procesem.

Při odchodu Ownera, změně role nebo ztrátě zařízení odvolej síťové granty,
klíče a podle možností aktivní relace. Uveď, zda je revokace automatická, nebo
jde o ruční offboarding. Kontrola role při nasazení není průběžná kontrola
každého SSH přihlášení; automatickou ochranu bez implementace netvrď.

## Hranice a recovery

Správa Conglomerate Hostu má dopad na všechny jeho tenanty. Owner jedné
Organizace nemá automaticky právo spravovat host dalších Organizací; schválení
musí odpovídat vlastnictví a celé sdílené hranici hostu. Vlastník osobní VM tím
nepředává oprávnění číst svůj Personalspace jinému Ownerovi ani Operátorovi.

Plné ovládání osobního počítače z pracovní VM může umožnit nepřímé použití
jeho správních přístupů. Síťový zákaz přímé cesty toto neřeší. Rozsah computer
use musí být vědomý a dokumentovaný; přísnou izolaci současně neslibuj.

Primární správní cesta je privátní Headscale. Při jejím přerušení slouží
provider konzole/rescue jako nouzová obnova. Před zrušením veřejné SSH fallback
cesty ověř soukromý vstup a provider recovery oprávnění, identitu hostu a postup
návratu do normálního bootu. Rescue může přerušit sdílené služby. Nouzovou změnu
následně promítni do autoritativního stavu a auditního záznamu.

## Evidence skutečného nasazení

Deployment Repo vlastníka hostu eviduje schválené zdrojové mašiny, vazby na
aktuální Ownery,
verzi implementace, nasazovací důkaz a úspěšné i negativní testy. Test proveď
z každého povoleného zdroje včetně skutečného SSH/sudo ověření. Nepovolené
zdroje nesmějí navázat správní spojení. Diagram označí cílové a ověřené cesty.
Obecný standard, plán, otevřený PR a živé nasazení jsou různé stavy.
