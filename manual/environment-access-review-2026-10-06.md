# Review přístupového modelu — 2026-10-06

Podklad k uzavření [modelu 0192](environment-access-model.md), nikoli další
přístupová autorita nebo schválení nových pravidel. Schválené principy
Lazurio účtu, povinného Headscale a interního sdílení zůstávají. Operátor následně rozhodl pro vědomé plné sdílení na základě důvěry, bez
povinného odhlašování nebo přechodu na sdílený broker. Potvrdil zachování
členství v Organizaci a schválení zařízení Adminem. Toto rozhodnutí
aktualizuje původní doporučení review; implementace přichází až po publikaci
sjednoceného kontraktu.

## Rozsah ověření

Na výslovný pokyn Operátora proběhlo nezávislé review přes Claude CLI
2.1.291, model `claude-opus-5-5`, nastavení `--effort high`. Reviewer dostal
verzované dokumenty s čísly řádků a otisky obsahu, uživatelův záměr a
dosavadní hranice. Neměl nástroje, oprávnění k zápisu ani přístup k živé
infrastruktuře. První kolo dostalo deset vybraných dokumentů z rootu, Auth,
Dashboardu, Machines, Platformy, infra a Mission Controlu. Druhé kolo dostalo
navíc konkrétní námitky autora, nový dodatek 0191 a současný kontrakt správy
Organizace v Auth. Výsledek je posouzení návrhu, ne penetrační test nebo
důkaz bezpečnosti nasazeného systému.

Výchozí root revize byla `a0e1d64b1d7bd913b496226f64885dc2ce80ca65`.
Obsah `manual/environment-access-model.md` měl SHA-256
`e53d92cd99017134dae4bec043e9655ce253c57d6df347285765c1449bb083de`;
rebase na main `d8fd8135c76825a5f3e03e5166a78591c41e70c7` jej nezměnil.
Původní pin `d5194378` obsahoval tentýž soubor. Pro druhé kolo byl použit i
aktuální dodatek 0191 z tohoto main. Tento záznam zachycuje závěry a
jejich omezení, nikoli skryté uvažování modelu nebo přihlašovací údaje.

Obě volání skončila úspěšně a jejich výstupní metadata potvrdila
`claude-opus-5-5` jako model odborného posouzení. Po druhém kole se autor
a reviewer shodli na směru a doporučených opravách; z původního širšího
seznamu otázek zůstala jedna produktová volba o plném sdílení. Její následné
rozhodnutí Operátorem je uvedené níže; není to dodatečný souhlas Opusu
s novou volbou.
Reviewer stáhl zejména návrh obnovovat globální účet přes Admina
Organizace, novou Admin roli bez dosavadního Owner důkazu a obecný
požadavek placeného GitHub tarifu. Druhé kolo připouští publikaci po
opravách textu; Operátorem určené pořadí rozhodnutí → zapracování →
publikace → implementace platí beze změny.

## Hlavní nálezy a doporučené řešení

### 1. Plné sdílení deleguje i přihlášené účty

Plný operátor může používat soubory, procesy, browser, trezor i credentials
Environmentu. Pokud individuální pracovní Environment obsahuje osobní
GitHub přihlášení, publikační token nebo přihlášení Admina do Dashboardu,
přidání dalšího plného operátora mu může fakticky zpřístupnit také tato
oprávnění. Omezení tlačítek pro sdílení tomu nezabrání.

Původní doporučení review požadovalo odstranit privilegované osobní
identity nebo omezit plné sdílení na týmové Environmenty. **Operátor je
následně odmítl jako povinnou technickou podmínku.** Zvolil vědomé přijetí
rizika sdílejícím člověkem a srozumitelnou komunikaci plného rozsahu.

Aktuální rozhodnutí: důvěryhodný příjemce plného vstupu může používat vše,
co je uvnitř dostupné, včetně osobních přihlášení, browseru, passkeys,
publikačních identit a existujících vzdálených přístupů. Nevyžaduje se
odhlášení, výmaz ani převod na týmový broker. Příjemce musí být aktivním
členem téže Organizace a používat zařízení schválené Adminem. Odebrání
vstupu nezneplatní již zkopírované údaje; případná rotace patří recovery.

0191/DEV-6646 zůstává kompatibilní: jeden sdílený browser profil není
izolace jednotlivých lidí. Osobní schválení operace, za kterou odpovídá
jmenovaný člověk, je uvnitř důvěrně sdíleného runtime procesní pravidlo,
nikoli kryptograficky prokázaná exkluzivita jeho přihlášení. Ochrany
organizačního bota se neposuzují jako ochrany libovolného osobního účtu,
který někdo do browseru vloží. Komunikace nesmí slibovat opak.

### 2. Nepřímé přístupy: původní návrh a důsledek přijaté důvěry

Review původně doporučilo pro plnou ovladatelnost A → B:

```text
Plní operátoři(A) ⊆ Plní operátoři(B)
```

Tento požadavek **není podmínkou nyní schváleného důvěrného sdílení**.
Vědomé plné sdílení A předává i již dostupnou schopnost A → B. Nemá nutit
sdílejícího založit příjemci nový přímý grant do B nebo ho před sdílením
odpojit. Sdílení ale samo nevytváří novou síťovou hranu, členství ani
přímý grant do B. Vytvoření a změna linku nadále kontroluje oprávněného
aktéra a organizační rozsah.

Mapa a sdílecí text musejí ukázat efektivní cestu a její důsledky. Přímé
oprávnění a možnost použít již přihlášený účet zevnitř A nejsou stejná věc;
Auth ACL neumí omezit širší práva takového účtu. Odebrání přímého grantu
v B neodvolává schopnost dostupnou z A. Audit nesmí zaměňovat doložený
workload nebo sdílený účet za nezaměnitelnou identitu člověka.

Rozlišujeme osobní zařízení, soukromý osobní Environment a pracovní
Environment Organizace. Existující samostatně schválené osobní vstupy a
přesné servisní výjimky nejsou automaticky zrušené ani rozšířené na obecný
most mezi Organizacemi. Vyšší provider/host autorita zůstává samostatnou
doménou kompromitace a obnovy.

### 3. Jedno síťové připojení není souhlas všech Organizací

Schválení je vztah konkrétního zařízení, ověřeného účtu a cílové
Organizace. Jedna fyzická instalace Tailscale může obsloužit společný
tailnet, ale Admin jedné Organizace tím neschvaluje vstup do jiné.
Odebrání člověka z jedné Organizace nesmaže jeho globální účet ani
oprávnění v ostatních Organizacích.

Navrženým vlastníkem tohoto schválení je Auth spolu s ostatními
account/access granty; infra a Machines drží odvozené vynucení a důkaz
apply. Dokumenty nesmějí schválení současně přidělit třem nezávislým
writerům. Převod schválené akce na Machines Plan/Permit musí být explicitní
kontrakt vykonavatele, nikoli tvrzení, že dnešní kliknutí je už Permitem.

Brána musí doložit souvislost schváleného zdroje a přihlášeného člověka:
schválený notebook jednoho člověka plus relace jiného člověka nesmějí
náhodně splnit dvě nesouvisející kontroly. Vstup přes pracovní Environment
se vyhodnocuje jako delegovaná pracovní schopnost s odpovídajícím rozsahem,
ne jako soukromý notebook jeho přiděleného uživatele.

Dokumentace [Headscale OIDC](https://headscale.net/stable/ref/oidc/)
popisuje identitu `iss` + `sub` a filtry přijetí uživatelů. To samo
nedokazuje schvalování jednotlivých zařízení před dosažitelností.
DEV-6641 musí na připnuté verzi kvalifikovat skutečné přijetí, obnovu,
rotaci klíčů, odvolání a korelaci zdroje. Nová identita zařízení není
automaticky pokračováním staré; běžná rotace klíče zároveň nemá nutit k
novému schválení, pokud se nemění prokázaná identita.

### 4. Aplikace a publikace jsou skutečné hranice schopností

Pouhý App grant nesmí otevřít browser, desktop, shell, Chat, obecné
automatizace nebo libovolné soubory. Aplikace s takovou schopností se
nemůže vydávat za omezený vstup. Kvalifikují se její backendové operace,
API, WebSockety, downloads a použitelné credentials. Nevytváříme per-App
sandbox, který současná hranice Environmentu neumí vynutit.

Omezený návštěvník aplikace a škodlivý plný operátor téhož runtime jsou
odlišné hrozby. Plný operátor může ovlivnit aplikaci i její data. Silnější
oddělení vyžaduje další Environment; samotná brána ho nevytvoří.

Sdílená cookie brány z 0191 není oprávnění ke všem aplikacím. Brána
ověřuje konkrétní cíl a nesmí svou session cookie přeposílat backendům
aplikací. Je nutné ověřit Origin, CSRF, WebSockety a povolené vkládání do
rámců včetně požadavků mezi sourozeneckými subdoménami. `HttpOnly` brání
JavaScriptu číst cookie, ale nebrání browseru odeslat ji v požadavku;
`SameSite` samo není hranice mezi sourozeneckými aplikacemi. Viz
[kontrakt cookie v MDN](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Set-Cookie).

Zákaz samostatné publikace sdíleným Environmentem se týká také přímého
push, deploy tokenů, CI a preview. Nechráněný build skript změněný v PR
nesmí získat produkční secrets jen proto, že workflow soubor zůstal
stejný. Důkaz vzniká z přesné kombinace brokeru, provider práv a
repozitářových pravidel, nikoli z obecného názvu GitHub tarifu.
[GitHub uvádí ochranu větví i pro veřejná Free repa a popisuje výchozí
výjimky pro administrátory](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches).

Záznam pracovní identity nebo Git trailer sám neprokazuje, který člověk
spustil proces uvnitř sdíleného runtime. Audit musí rozlišit doloženého
iniciátora, delegaci a pouze doložený původ z Environmentu. Nesmí
předstírat lidskou identitu tam, kde má jen workload credential.

### 5. Odvolání a přepřidělení nejsou jen smazání grantu

Revokace musí pokrýt nové požadavky i existující relace, refresh,
WebSocket, SSH, běžící automatizace a delegované pracovní credentials.
Každý mechanismus potřebuje změřenou lhůtu a chování při výpadku autority.
Již přečtená data nelze odvolat; u exportovaných klíčů je nutná jejich
skutečná revokace nebo rotace u cílového systému.

Doporučený technický výchozí postup: při přepřidělení a při ztrátě důvěry ve dřívější
plný přístup použít čistý Environment, zneplatnit staré credentials a
přenést jen výslovně vybraná pracovní data. Kopie celého home, browser
profilu, trezoru nebo automatizací by přenesla i původní přístupy a možné
trvalé změny. Toto review samo nic nemaže ani nepřepřiděluje.

Odchod historického schvalovatele automaticky nemaže všechny organizační
granty, které kdysi schválil. Rozhoduje současné vlastnictví a platnost
grantu; historie schválení není druhý owner. Naopak změna přidělení musí
ukončit nebo znovu ověřit delegace závislé na původním přidělení.

## Navržená migrace

1. **Inventura a přiřazení identit.** Zachovat neměnná ID, DNS názvy a
   přesné autorizované servisní cesty. E-mail ani podobné jméno nejsou
   důkazem totožnosti. Nejasné zařízení se nepovažuje za ověřené jen
   proto, že už má starý přístup. Výjimka nebo odklad musí mít konkrétní
   rozsah a ownera; není to potvrzení nového modelu.
2. **Stínové vyhodnocování.** Nová politika nejprve pouze vypočítává
   výsledek. Rozdíly proti dosavadnímu vynucení se projdou po cílech:
   očekávané zachování, záměrné odebrání, nechtěné rozšíření či nejasnost.
   Schválené staré onboarding cesty lze používat v jejich dosavadním
   scope; nedokazují způsobilost nové skupiny uživatelů.
3. **Pilot s uzavřenými hranicemi.** Schválené a neschválené zařízení,
   uživatel bez GitHubu, App/full, odmítnutí externího člověka,
   nepřímé propojení, publikace, revokace a obnova. Připravený browser a
   credentials musí odpovídat skutečnému okruhu operátorů.
4. **Jeden aktivní rozhodovací zdroj pro každý cíl.** Síť, brána a
   oprávnění se přepnou koordinovaně. Staré a nové allow podmínky se nikdy
   nespojí pomocí OR; nehotový krok nesmí otevřít širší přístup.
5. **Návrat verze zachová odebraná oprávnění.** Záloha před migrací není
   bezpečný rollback oprávnění. Zachovávají se pozdější revokace,
   platnost identit a aktuální rozhodovací verze. Nekompatibilní starý
   runtime se nepoužije jako návrat, který znovu udělí přístup.
6. **Rozšíření po ověření, pak odstranění staré cesty.** Společný tailnet
   zůstává první prioritou. Postup se eviduje po Organizacích a
   konkrétních cílech; jedna úspěšná relace není důkaz pro celý graf.

Technické zjednodušení k prověření: síť pouští pouze schválené zdroje
k příslušným bránám Organizace, přesný App/full grant vyhodnocuje Auth a
brána při vstupu. Běžné interní sdílení pak nepotřebuje ruční síťový PR.
SSH a delegované operace mají vlastní vynucení. Je to kandidát architektury
k důkazu na consumerovi, nikoli pokyn obejít Machines Plan/Permit/apply.

## Co se musí sjednotit v dokumentaci

- 0192 a aktivní DEV-6640 určují Lazurio/Auth jako account/access autoritu;
  GitHub je autorita repo schopností a publikace. Souběžný zápis v plánu,
  který opět odvozuje všechny uživatele z GitHubu a přidělení z infra,
  potřebuje obsahovou reconciliaci. Nezávislá rozhodnutí o vzhledu,
  viditelnosti a pozorování mapy se zachovají. Čerstvost diagnostiky není
  lhůta revokace oprávnění.
- 0191/DEV-6646 se doplní o hranici privilegovaných přihlášení a bezpečné
  přepřidělení; pouhé varování o sdíleném browseru nestačí k důkazu
  samostatného lidského schválení.
- Staré onboarding a přístupové manuály dostanou přesné rozlišení
  zachovaných a nahrazených kroků. Nadpis „historické“ s rozporným
  normativním postupem pod ním nestačí jako nový onboarding.
- Stávající native Owner a čerstvý GitHub Owner důkaz pro správu Auth se
  neruší potichu. Běžný přístup bez GitHubu není nová cesta k Owner roli.
  Admin Organizace nemůže obnovou globálního Lazurio účtu převzít účty
  člověka v jiných Organizacích nebo jeho Personalspace; obnovu
  autentizátorů drží issuer a jeho samostatný recovery kontrakt.

## Rozhodnutí Operátora po review

Operátor zvolil **důvěrné plné sdílení individuálního pracovního
Environmentu s přijetím rizika**. Původní dvě varianty review nejsou
povinné: systém nevynucuje výměnu účtů, odhlášení, čistou instalaci ani
omezení plného sdílení výhradně na týmové Environmenty.

Dashboard vysvětlí rozsah přímo u udělení přístupu a nabídne odebrání;
nevytváří nový schvalovací rituál. Pro spolupráci bez osobní důvěry slouží
samostatný týmový Environment. V obou případech Operátor výslovně potvrdil
zachování aktivního členství v Organizaci a schválení zařízení Adminem.
Nejde o povolení externích hostů nebo sdílení soukromého Personalspace.

Revokace dalších vstupů zůstává vynucovaná a měřená; odstranění kopií a
zneplatnění externích přihlášení není její automatický účinek. Recovery
při ztrátě důvěry a bezpečné přepřidělení jsou samostatné operace, nikoli
preventivní blokátor každého dočasného sdílení. Publikace zůstává na pokyn
jmenovaného člověka; uvnitř důvěrně sdíleného runtime ji drží proces.

Týmový Environment nemá individuálního přiděleného uživatele, proto jeho
přidělování lidem a propojení spravuje Admin. Samotný plný vstup nepřidává
příjemcovu Lazurio účtu správní roli; přihlášené privilegované účty uvnitř
jsou však technicky použitelné a systém jejich izolaci nepředstírá.

Implementační mechanismy a zbylé migrační důkazy zůstávají kvalifikací
owning repozitářů. Review ani toto rozhodnutí nemění živé přístupy.
