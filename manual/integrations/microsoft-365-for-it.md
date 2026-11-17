# Lazurio a Microsoft 365: stránka pro vaše IT

Tuto stránku můžete předat správci Microsoftu 365 ve vaší firmě. Postup krok
po kroku je v [runbooku](microsoft-365.md#postup-it-firmy-výchozí).

## Co to je

Lazurio dává každému uživateli ve firmě vlastní pracovní Environment,
hostované pracovní prostředí, ve kterém za něj pracují AI agenti. Aby agenti mohli pracovat
s poštou, kalendářem a soubory, založíte ve svém tenantu jednu aplikaci
Microsoft Entra „Lazurio (<Organizace>)“:

- jen pro účty vašeho tenantu (single-tenant);
- jen delegovaná oprávnění Microsoft Graph, žádná aplikační;
- veřejný klient (PKCE), bez tajného klíče a certifikátu;
- jeden souhlas jménem organizace, který udělíte vy.

Aplikaci zakládáte a spravujete vy ve svém prohlížeči. Lazurio od vás dostane
jen id tenantu a id aplikace, které nejsou tajné.

## Co může a co ne

Agent jedná vždy za konkrétního přihlášeného uživatele a dosáhne jen tam, kam
smí ten uživatel sám. Správcovské role uživatele k tomu nic nepřidávají.

| Oprávnění | Co dovoluje |
| --- | --- |
| `Mail.ReadWrite` | číst, třídit, přesouvat a mazat poštu, připravovat koncepty |
| `Mail.Send` (volitelně) | odeslat koncept, který uživatel schválil, z jeho vlastní schránky; jen kde Organizace odesílání zapne |
| `Calendars.ReadWrite` | číst, zakládat, měnit a rušit schůzky; účastníkům tím odcházejí pozvánky a zrušení |
| `Files.ReadWrite.All` | číst, nahrávat, měnit a mazat soubory v OneDrivu a knihovnách SharePointu, vytvářet odkazy ke sdílení a zvát lidi |
| `Sites.Read.All` | najít weby SharePointu, jejich knihovny a seznamy |
| `openid`, `profile`, `email`, `offline_access`, `User.Read` | přihlášení, vlastní profil, obnova přihlášení |

Co aplikace nemá:

- `Mail.Send`, dokud Organizace odesílání nezapne: agenti pak jen připravují
  koncepty;
- `Mail.Send.Shared` ani odesílání za jiného („send as“, „send on behalf“):
  odesílá se jen z vlastní schránky přihlášeného uživatele;
- žádná aplikační oprávnění ani přístup k adresáři, uživatelům, skupinám
  nebo nastavení tenantu;
- Teams zatím ne.

Zápisy a mazání nebrání oprávnění, ale pravidla práce agentů: navenek
viditelnou změnu dělají jen na pokyn uživatele.

## Odesílání pošty

Odesílání je volitelné. Organizace ho zapne v Lazuriu a vy k aplikaci
přidáte delegované oprávnění `Mail.Send` se souhlasem jménem organizace.
Když ho nepovolíte, pošta, kalendář a soubory fungují dál a agenti jen
připravují koncepty.

Kde je zapnuté, platí:

- **Pravidlo:** agent e-mail nejdřív uloží jako koncept ve schránce
  uživatele a pošle mu odkaz na něj. Odešle ho, až když uživatel schválí jeho
  přesné znění („publikuj“). Když se koncept po schválení změní, agent ho
  ukáže znovu a odešle až po novém souhlasu. To je pravidlo práce agentů, ne
  technická zábrana.
- **Pojistka v Lazuriu:** agentům je k dispozici jen operace „odeslat
  existující koncept“. Okamžité odeslání (`sendMail`) ani odpověď nebo
  přeposlání bez konceptu přes Lazurio dostupné nejsou. Odeslat tedy jde jen
  existující koncept ve schránce uživatele (v kterékoli složce). Pojistka
  hlídá jen druh operace: nekontroluje, o který koncept jde, jeho obsah ani
  to, jestli se po schválení nezměnil. Že odchází právě schválené znění,
  drží pravidlo výše.
- **Co pojistka nezaručí:** přihlašovací tokeny leží v Environmentu (viz
  níže). Agent, který by pravidlo porušil, by mohl zavolat Microsoft Graph
  napřímo. Skutečnou hranici drží váš souhlas s `Mail.Send` a vypínače
  v Entra.
- **Kde to uvidíte:** odeslané zprávy jsou ve složce Odeslané uživatele a
  v jednotném protokolu auditu Microsoft Purview pod jeho účtem.

Pokud `Mail.Send` přidáte k aplikaci, která už je v provozu, dejte znovu
souhlas jménem organizace.

## Kudy tečou data

1. Microsoft Graph → Environment toho uživatele, hostovaný pro vaši
   Organizaci. Mezi tím není žádná další služba.
2. Co agent při práci přečte, odchází k poskytovateli AI modelu, se kterým
   Environment pracuje.
3. Přihlašovací tokeny leží v Environmentu jako nešifrovaný soubor čitelný
   jen jeho uživatelem. Čtou ho všichni agenti v tom Environmentu, správce
   (root) hostitele, na kterém Environmenty Organizace běží, a každý, kdo
   má zálohu Environmentu.

## Kdo se připojuje

Každý uživatel sám: v Lazuriu zvolí „Přidat účet“ a jednou se ve svém
prohlížeči přihlásí pracovním účtem. Tím agenti v jeho Environmentu dostanou
poštu, kalendář, OneDrive a SharePoint toho účtu. Víc účtů vedle sebe je jeho
volba. Lazurio samo žádný účet neodpojí: odpojí ho uživatel tlačítkem
„Odpojit“, nebo vy v Entra (níže). Když Environment přechází na jiného
uživatele, odpojí ten, kdo v něm pracuje, účty, které už používat nemá; na
týmovém Environmentu připojený účet používají všichni jeho agenti. Doporučujeme v *Enterprise applications* zapnout *Assignment
required* a přiřadit skupinu uživatelů, kteří se smějí připojit. Podle Microsoftu
to neomezuje Global Administratory.

## Podmíněný přístup

- Přihlášení se vyhodnocuje na adrese a zařízení uživatele, obnova tokenu a
  volání Graphu na odchozí adrese Environmentu. Pokud máte zásady podle
  lokality, vyžádejte si odchozí adresy Environmentů vaší Organizace.
- Zásada vyžadující vyhovující nebo spravované zařízení zablokuje přihlášení
  z prohlížeče Environmentu (`AADSTS53000`).
- Frekvence přihlášení připojení po uplynutí ukončí (`AADSTS70043`). Uživatel
  se pak připojí znovu.
- Změna hesla může ukončit připojení vzniklé přihlášením heslem, připojení
  z přihlášení bez hesla ale platí dál. K ukončení přístupu proto použijte
  zablokování účtu nebo odvolání relací (níže).

## Jak přístup ukončit

- **Jeden uživatel:** zablokujte účet nebo odvolejte jeho přihlášení. Už vydaný
  přístupový token platí dál, takže přístup skončí až asi do 90 minut. To
  platí i pro odchod z firmy: Lazurio samo nic neodpojí.
- **Celá firma:** v *Enterprise applications* nastavte *Enabled for users to
  sign in* na *No*, nebo odeberte souhlas či aplikaci smažte. To je skutečný
  vypínač; odebrání nastavení v Lazuriu existující připojení neodpojí.

## Kde to uvidíte

- **Přihlašovací protokoly Entra** (*Sign-in logs*): každé přihlášení a
  obnovu tokenu aplikace „Lazurio (<Organizace>)“, včetně adresy.
- **Jednotný protokol auditu** Microsoft Purview: operace s poštou a soubory
  pod účtem daného uživatele.

## Proč u aplikace stojí „Unverified“

Aplikaci jste zaregistrovali vy ve svém tenantu, takže vydavatelem je vaše
firma, ne Lazurio. Ověření vydavatele (publisher verification) se týká
aplikací nabízených cizím tenantům; u aplikace jen pro váš tenant se
souhlasem správce na fungování nic nemění.

## Kontakt

- Lazurio: <jméno, e-mail, telefon>
- Admin vaší Organizace v Lazuriu: <jméno, e-mail>
