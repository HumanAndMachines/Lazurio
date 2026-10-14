# Lazurio a Microsoft 365: stránka pro vaše IT

Tuto stránku můžete předat správci Microsoftu 365 ve vaší firmě. Postup krok
po kroku je v [runbooku](microsoft-365.md#postup-it-firmy-výchozí).

## Co to je

Lazurio dává každému člověku ve firmě vlastní pracovní Environment,
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

Agent jedná vždy za konkrétního přihlášeného člověka a dosáhne jen tam, kam
smí ten člověk sám. Správcovské role člověka k tomu nic nepřidávají.

| Oprávnění | Co dovoluje |
| --- | --- |
| `Mail.ReadWrite` | číst, třídit, přesouvat a mazat poštu, připravovat koncepty |
| `Calendars.ReadWrite` | číst, zakládat, měnit a rušit schůzky; účastníkům tím odcházejí pozvánky a zrušení |
| `Files.ReadWrite.All` | číst, nahrávat, měnit a mazat soubory v OneDrivu a knihovnách SharePointu, vytvářet odkazy ke sdílení a zvát lidi |
| `Sites.Read.All` | najít weby SharePointu, jejich knihovny a seznamy |
| `openid`, `profile`, `email`, `offline_access`, `User.Read` | přihlášení, vlastní profil, obnova přihlášení |

Co aplikace nemá:

- `Mail.Send`: agenti nemohou odeslat e-mail, jen připravit koncept;
- žádná aplikační oprávnění ani přístup k adresáři, uživatelům, skupinám
  nebo nastavení tenantu;
- Teams zatím ne.

Zápisy a mazání nebrání oprávnění, ale pravidla práce agentů: navenek
viditelnou změnu dělají jen na pokyn člověka.

## Kudy tečou data

1. Microsoft Graph → Environment toho člověka, hostovaný pro vaši
   Organizaci. Mezi tím není žádná další služba.
2. Co agent při práci přečte, odchází k poskytovateli AI modelu, se kterým
   Environment pracuje.
3. Přihlašovací tokeny leží v Environmentu jako nešifrovaný soubor čitelný
   jen jeho uživatelem. Čtou ho všichni agenti v tom Environmentu, správce
   (root) hostitele, na kterém Environmenty Organizace běží, a každý, kdo
   má zálohu Environmentu.

## Kdo se připojuje

Každý člověk sám, ve svém prohlížeči a svým pracovním účtem. Bez souhlasu
nic nevznikne. Doporučujeme v *Enterprise applications* zapnout *Assignment
required* a přiřadit skupinu lidí, kteří se smějí připojit. Podle Microsoftu
to neomezuje Global Administratory.

## Podmíněný přístup

- Přihlášení se vyhodnocuje na adrese a zařízení člověka, obnova tokenu a
  volání Graphu na odchozí adrese Environmentu. Pokud máte zásady podle
  lokality, vyžádejte si odchozí adresy Environmentů vaší Organizace.
- Zásada vyžadující vyhovující nebo spravované zařízení zablokuje přihlášení
  z prohlížeče Environmentu (`AADSTS53000`).
- Frekvence přihlášení připojení po uplynutí ukončí (`AADSTS70043`). Člověk
  se pak připojí znovu.
- Změna hesla může ukončit připojení vzniklé přihlášením heslem, připojení
  z přihlášení bez hesla ale platí dál. K ukončení přístupu proto použijte
  zablokování účtu nebo odvolání relací (níže).

## Jak přístup ukončit

- **Jeden člověk:** zablokujte účet nebo odvolejte jeho přihlášení. Už vydaný
  přístupový token platí dál, takže přístup skončí až asi do 90 minut.
- **Celá firma:** v *Enterprise applications* nastavte *Enabled for users to
  sign in* na *No*, nebo odeberte souhlas či aplikaci smažte. To je skutečný
  vypínač; odebrání nastavení v Lazuriu existující připojení neodpojí.

## Kde to uvidíte

- **Přihlašovací protokoly Entra** (*Sign-in logs*): každé přihlášení a
  obnovu tokenu aplikace „Lazurio (<Organizace>)“, včetně adresy.
- **Jednotný protokol auditu** Microsoft Purview: operace s poštou a soubory
  pod účtem daného člověka.

## Proč u aplikace stojí „Unverified“

Aplikaci jste zaregistrovali vy ve svém tenantu, takže vydavatelem je vaše
firma, ne Lazurio. Ověření vydavatele (publisher verification) se týká
aplikací nabízených cizím tenantům; u aplikace jen pro váš tenant se
souhlasem správce na fungování nic nemění.

## Kontakt

- Lazurio: <jméno, e-mail, telefon>
- Správce vaší Organizace v Lazuriu: <jméno, e-mail>
