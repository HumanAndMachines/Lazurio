# Účet, zařízení a přístupy k Environmentům

Rozhodnutí Matěje z 2026-10-06, root decision **0192**. Schválený cílový
směr; před publikací se uzavírají hranice sdílených credentials, propojení
a migrace popsané v [architektonickém review](environment-access-review-2026-10-06.md).
Volby v review nejsou dosud schválené. Samotný dokument nemění nasazené přihlášení, členství, brány ani
síť. Plánování vlastní DEV-6640, síťovou realizaci DEV-6641 a účty
DEV-6551/DEV-6552 v Mission Controlu Human and Machine. Každý consumer musí
před přechodem doložit níže uvedené chování. Dosavadní GitHub/Team brány
zůstávají označenou migrační implementací, nikoli cílem k další expanzi.

## Člověk a pracovní schopnosti

Směrem k lidem používáme **uživatel**. Uživatel má jeden Lazurio účet s
neměnným identifikátorem issuer + subject. GitHub je volitelná propojená
identita a pracovní schopnost; připojení samo nevytváří repo grant, právo
schválit PR ani právo spravovat Organizaci. Technické názvy dosavadních
GitHub rolí mohou zůstat v kompatibilitních kontraktech; nejsou druhy lidí.

Lazurio účet může získat oprávnění k individuálnímu i týmovému pracovnímu
Environmentu bez GitHub účtu. Přihlášení, členství v Organizaci, přidělení
Environmentu a GitHub identita používaná uvnitř jsou odlišné vazby.
Stejný e-mail, login ani zobrazované jméno účty neslučují. Odpojení GitHubu
nepřevádí Environment na jiného člověka a samo nemaže Lazurio účet.

Pracovní Environment vlastní Organizace; člověku ho přiděluje. Osobní
Environment a jeho Personalspace zůstávají soukromou hranicí jednoho člověka.
Plný přístup jiného uživatele k jeho Personalspace se tímto rozhodnutím
nezavádí. Vědomě zpřístupněná aplikace či export nesmí obejít tuto hranici.

## Tři samostatné podmínky vstupu

1. **Síť:** klient používá Tailscale připojený ke správnému Headscale tailnetu
   a konkrétní zařízení schválil Admin. OIDC přihlášení ověří účet, ale samo
   zařízení neschválí. Neschválené, odvolané či nahrazené zařízení nemá
   přístup k chráněným Environmentům ani jejich aplikacím; selhání ověření
   nepovolí dřívější souhlas použít pro jiné zařízení.
2. **Organizace:** uživatel je aktivním členem cílové Organizace v Lazuriu.
   Síťová dosažitelnost ani členství v jiné Organizaci sdílející tailnet
   tuto podmínku nenahrazují.
3. **Cíl:** účet má konkrétní oprávnění k celému Environmentu nebo k určené
   aplikaci. Brána kontroluje rozsah na serverové straně.

Nevzniká veřejná alternativní cesta k pracovnímu Environmentu ani k jeho
aplikacím. Přihlašovací/control-plane endpoint nutný k založení požadavku na
připojení není přístupem k pracovním datům. Síťová schválení se vážou na
konkrétní identitu zařízení a účet; jejich přesný mechanismus musí prokázat
DEV-6641 na skutečném Headscale. Nová registrace nesmí získat provozní přístup
v mezeře před schválením. Připojení SSH vyžaduje navíc vlastní oprávnění.

## Kdo může přístup spravovat

Admin schvaluje členství v Organizaci a přijetí zařízení do její sítě,
přiděluje pracovní Environmenty a spravuje oprávnění napříč uživateli.
Jeho role musí být ověřená; nápis Admin ani přítomnost v tailnetu ji nedává.
Stávající pravidla pro GitHub Owner důkaz při správě zdrojů, releasů a
infrastruktury se tím neruší.

Přidělený uživatel smí v rámci svého oprávnění:

- zpřístupnit svůj pracovní Environment jinému **již aktivnímu členovi téže
  Organizace**, buď celý, nebo jen vybrané aplikace;
- odvolat takto udělený přístup;
- povolit orientované propojení dvou Environmentů přidělených jemu v téže
  Organizaci, včetně deklarovaného účtu a rozsahu vzdálených operací.

Každé takové sdílení nepotřebuje nové ruční schválení Adminem. Uživatel ale
nemůže pozvat externího člověka, vytvořit členství, schválit zařízení,
přidělit si cizí Environment nebo obejít organizační hranici. Admin může
propojit Environmenty napříč uživateli v Organizaci. Přidělení dvou
Environmentů z různých Organizací samo nepovoluje propojení jejich dat.
Přeshraniční servisní granty vyžadují vlastní výslovnou autoritu a zachovávají
svůj omezený rozsah; tento model je automaticky nerozšiřuje.

## Celý Environment, aplikace a vzdálené operace

| Oprávnění | Důsledek |
|---|---|
| Celý Environment | Launchpad, Chat, Automatizace, pracovní soubory a schopnosti dostupné uvnitř. Nejde o izolovaný účet uvnitř sdíleného runtime. |
| Vybraná aplikace | Pouze konkrétní aplikace a její vlastní role. Žádný shell, Chat, Automatizace, jiné aplikace ani přebírání přihlašovacích údajů Environmentu. |
| Environment A → Environment B | Přesně vymezené vzdálené operace; u SSH také cílový OS účet, přihlašovací mechanismus a rozsah. Povolený port sám nestačí. |
| Environment → integrace | Schopnosti připojeného účtu nebo brokeru. Osobní přihlášení návštěvníka se automaticky nevkládá do sdíleného Environmentu. |

Oprávnění k aplikaci musí držet skutečná brána včetně API, WebSocketů,
downloadů a přímých URL; skrytí navigace nestačí. Role uvnitř aplikace a její
datová oprávnění patří aplikaci. Plný přístup k Environmentu není oprávněním
automaticky měnit seznam jeho uživatelů nebo členství Organizace.

Agent je běh uvnitř Environmentu, nikoli další uživatelská role. Používá
schopnosti tohoto Environmentu. SSH nepředstavuje výhradně agenty a HTTPS
výhradně lidi: obojí mohou používat lidé i automatizace.

Pokud mají další lidé plný přístup do A a A může přes SSH ovládat B, získávají
tím nepřímý přístup k B. Dashboard musí při propojení ukázat tento dopad a
ověřit oprávnění k takové delegaci. Samotná kontrola přímých grantů nestačí;
nepřímá cesta nesmí obejít zákaz externího či cross-organization přístupu.
Audit rozliší člověka, zdrojový Environment, cíl a použitou pracovní identitu.

## GitHub a publikace

GitHub Team vymezuje repozitářové schopnosti týmového Environmentu, není
povinnou vstupenkou každého jeho uživatele. Lazurio for GitHub je instalace
Organizace; broker omezuje její operace na příslušný Team a repozitáře.

Uživatel bez GitHubu smí přes týmový Environment připravit změnu, vytvořit PR
jeho identitou a použít preview v povoleném rozsahu. GitHub účet není potřeba
k tomu, aby byl autor požadavku auditovatelný jako Lazurio subject.
Schválení a Publikaci provádí jmenovaný člověk s živým GitHub oprávněním.
Broker, přihlašovací údaje a ochrana větví musí prokazatelně zabránit tomu,
aby sdílený Environment sám provedl merge nebo přímý zápis do chráněné
větve. Bez tohoto důkazu se přístup nové skupině uživatelů nerozšíří.

## Autority a mapa Conglomerate

| Pravda | Vlastník |
|---|---|
| Lazurio účty, propojené identity, členství a oprávnění ke vstupu | Auth na standardním identity provideru; Dashboard je spravuje, nevytváří druhý seznam ACL. |
| Technická existence, vlastník a nasazené verze Environmentu; konfigurace a důkazy sítě | Deployment Repo vlastníka a řízený apply Machines. |
| Přidělení uživatele a delegované sdílení | Jeden autoritativní account/access kontrakt Auth spravovaný přes Dashboard. Dosavadní infra assignment je migrační vstup, ne druhý nezávislý writer. |
| Repozitáře, Team capability, schválení PR a branch rules | GitHub. |
| Tajné hodnoty | Příslušný trezor/custody; ostatní vrstvy drží reference. |
| Zobrazení vztahů a stavu | Dashboard, odvozeně z oprávnění, deklarací, evidence apply a čerstvého hlášení hostu. |

Mapa má vrstvy **Uživatelé → Zařízení → Environmenty → Připojené aplikace**,
seskupené po Organizacích. Rozlišuje plný a aplikační přístup, směrové
Environment-to-Environment operace, přidělení a vlastnictví. Ukazuje také
čekající schválení, požadovaný, nasazený, živý a odvolávaný stav. Není novou
autoritou. Uživatel bez GitHubu smí vidět své autorizované prostředky bez
práva číst celý infra repozitář; backend poskytne jen příslušnou projekci.

```mermaid
flowchart LR
  U[Uživatel: Lazurio účet] --> D[Zařízení schválené Adminem]
  D --> H[Headscale tailnet]
  H --> G[Brána: členství a konkrétní oprávnění]
  G -->|celý Environment| A[Environment A]
  G -->|jen aplikace| P[Aplikace v Environmentu]
  A -->|schválené vzdálené operace| B[Environment B]
  A --> I[Připojené integrace a GitHub capability]
```

Síťová pravidla jsou odvozený nasazený výstup schválené politiky a konkrétního
zařízení. Změny infrastruktury dál používají řízené plánování, apply a
evidenci; Dashboard nesmí obejít tyto kontroly přímým zápisem do Headscale.
To neznamená nutnost osobního GitHub účtu nebo dalšího kliknutí Admina pro
každé dovolené interní sdílení. Servisní vykonavatel smí mít jen rozsah
schválené operace a nesmí vytvářet vlastní přístupovou autoritu.

## Přechod a ověření

Rozhodnutí nahrazuje v cílovém modelu 0184 a DEV-6641 vazbu identity na
GitHub ID, automatické schválení zařízení a O10 jako dostatečnou vstupní
politiku. Nahrazuje také výklad 0183/DEV-6640, že každé uživatelské sdílení
musí být ruční PR a viditelnost mapy vyžaduje osobní read grant do infra.
GitHub ID se zachová jako ověřený link a migrační důkaz. Existující DNS
slugs, adresy, klíče ani servisní granty se bez přesného plánu nepřepisují.

Před realizací musí owning repa prokázat: uživatele bez GitHubu; nové a
odvolané zařízení; plný versus aplikační přístup; zákaz externího pozvání;
sdílení uvnitř Organizace bez dalšího Admin kroku; propojení vlastních a
cizích Environmentů včetně nepřímého přístupu; PR/preview bez publikace;
bezpečné přepřidělení včetně starých relací a credentials; odmítnutí při
výpadku autority a odvolání členství/přístupu. Odvolání musí mít změřené
chování i pro existující browser, WebSocket a SSH relace. Žádný konkrétní
čas ani okamžitá revokace nejsou tímto textem vydávanou zárukou.

DEV-6640 drží společný kontrakt a mapu; DEV-6551 Auth autoritu,
DEV-6552 přihlášení Dashboardu, DEV-6638 registraci a přidělení,
DEV-6639 seznam a shell, DEV-6644 onboarding a DEV-6645 ovládání Dashboardu.
DEV-6641 nasadí síť až po nové kvalifikaci. Dřívější úspěšné testy
GitHub-only admission dokazují pouze starý kontrakt. Tato dokumentační změna
nespouští rollout ani nezve žádného uživatele do skutečné sítě.
