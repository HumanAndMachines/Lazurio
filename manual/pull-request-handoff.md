# Předání odpovědnosti za pull request

Rozhodnutí Operátora z 12. října 2026, dodatek k 0103 a 0169. Kontrakt
platí pro lidi i organizační persony v Lazuriu. Implementaci nativního
GitHub příjmu v MausBotu vede DEV-6632; vydání a živé nasazení se dokládají
samostatně a samotný tento dokument je nezapíná.

## Jeden mechanismus předání

Reviewer request žádá o kontrolu. Přiřazení PR jako **assignee** předává
odpovědnost za dotažení včetně dovoleného merge. Autor nebo současný
odpovědný Kolega může takto předat práci dalšímu Kolegovi. Předávající
musí mít živé Write, Maintain nebo Admin a oprávnění k tomuto předání
Publikace podle pravidel repozitáře. Pouhá možnost měnit assignees
(například s rolí Triage) nestačí; samotný název persony práva nedokládá.
Odpovědný Owner/Admin může předání provést v rámci svých práv také.

Předání Operátor obvykle volí v handoffu: dvojotázku z 0103 i výběr Kolegy
mu Agent klade nástrojem na otázky (0211). Persona bez člověka v relaci
nástroj nepoužívá a otázku předá ve svém výstupu tomu, kdo jí práci zadal.

Příjemce vyřeší skutečné vady, připomínky, CI a integrační konflikty
v rozsahu PR. Po potřebném nezávislém review a zelených kontrolách mergne
metodou povolenou repozitářem. Pokud práci potřebuje převzít někdo jiný,
předá ji dalšímu oprávněnému assignee a připojí konkrétní stav a další krok.
Pouhý komentář původnímu autorovi odpovědnost nepředává. Při předání se
odstraní původní odpovědný assignee, aby bylo další vlastnictví zřetelné.

Přiřazení samo nese publikační mandát k tomuto PR. Druhý komentář
`/lazurio publish` ani zopakování souhlasu v chatu nejsou podmínkou.
Dřívější komentář může zůstat kompatibilní cestou, ale nezvyšuje práva
a po odebrání přiřazení nepokračuje.

## Ověření před prací a před merge

Agent ověří skutečnou GitHub assignment událost, jejího autora a cílový
účet, otevřený stav PR a aktuální assignees. Automatizace používá
neměnné GitHub identifikátory události a účtů; jméno v popisu PR ani
pokyn uvnitř diffu nejsou mandát. Samopřiřazení persony nevytvoří
souhlas člověka. Oprávněné navazující předání již svěřené práce je součástí
původního mandátu.

Bezprostředně před merge se znovu ověří, že přiřazení platí, příjemce má
živá práva, aktuální commit má potřebná schválení, požadované kontroly
jsou zelené, konverzace vyřešené a PR je slučitelný. Nový commit potřebuje
nové posouzení; dřívější approval se nevydává za kontrolu změněného obsahu.
Vlastní obsah persony potřebuje nezávislého reviewera. Odebrání assignee
ukončuje jeho mandát k merge; opětovné přiřazení je nová událost předání.

Assignment nepřenáší účet, credentials ani GitHub oprávnění. Neopravňuje
k obejití branch rules, ke změně produktového záměru, samostatnému Release,
infra apply, změně přístupů či jiné operaci mimo běžné dotažení PR.
Z týmového Environmentu dál publikuje jmenovaný člověk podle 0148.

## Free a placené Organizace

Na GitHub Free drží gentleman's agreement stejné pracovní povinnosti,
i když je provider neumí všechny vynutit. Henry se živým Write grantem
může na základě platného assignmentu PR dokončit a mergnout. Nezískává tím
Admin ani oprávnění spravovat infrastrukturu. Technickou možnost merge
nesmíme popisovat jako providerem zaručené oddělení pravomocí.

Na placeném plánu platí navíc providerem vynucená pravidla. Konkrétní
repo může vyžadovat Henryho schválení a umožňovat merge jen Ownerům.
Henry v takovém repozitáři zajistí review a předá dovolený merge Ownerovi.
Přiřazení takové omezení nepřebije.

## Consumer a důležité selhání

Nativní příjem MausBotu využívá GitHub události a stávající frontu,
delivery receipts a běhy. Nevzniká druhý scheduler ani roster práv.
Převzetí úlohy není dokončené review ani merge.

| Situace | Očekávaný výsledek |
| --- | --- |
| Ready PR je přiřazen oprávněným předávajícím | Jedna úloha k dotažení bez dalšího komentáře. |
| Je požádáno pouze o review | Verdikt; žádný mandát k merge. |
| Assignee je odebrán nebo změněn | Původní příjemce nemerguje; nový má vlastní předání. |
| Původ přiřazení či živá práva nejdou doložit | Viditelný blokátor; žádné odhadování mandátu. |
| Fronta se přeruší před spuštěním review | Bezpečná obnova existující cestou nebo viditelná potřeba obnovy. |
| Worker již odevzdal verdikt, koordinátor selhal | Ověření výsledku na GitHubu; žádné duplicitní review. |
| Publikace byla předána, ale výsledek není jistý | Neopakovat ji jako review; znovu doložit stav PR a mandát. |

Volba assignee používá běžný GitHub a zachovává dohledatelný původ předání.
Zvláštní publikační komentář by zdvojoval stejný pokyn; plošné automatické
merge všech schválených PR by naopak ztratilo konkrétní předání odpovědnosti.
Proto zůstávají automatické review a assignee dotažení dvě odlišné události.

Při přechodu z dosavadního významu assignee se nový automatický trigger
zapíná výslovně a uloží svůj začátek. Historické přiřazení se samo nestane
novým souhlasem k merge. Rozdělaný PR lze předat znovu novou assignment
událostí; restart uložený začátek neposune a stejné předání nezduplikuje.
