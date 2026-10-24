# Práce s forky

Lazurio staví na open-source projektech a jejich forky drží samo Lazurio
(třeba `Lazurio/t3code`, `Lazurio/OpenMausBot`, `Lazurio/hermes-agent`,
`Lazurio/agent-browser` nebo `Lazurio/vaultwarden`). Fork si může založit
i Organizace nebo jednotlivý uživatel. Tento manuál dává agentovi podklad,
jak s forkem pracovat, aby zůstal čitelný, dal se obnovit a nerozešel se
s Lazuriem.

## Nejdřív model Lazuria

Než ve forku navrhneš funkci, rozhraní nebo název, vyjdi z rozhodnutí
(`manual/decision-register.md`) a `ARCHITECTURE.md` Lazuria, ne z modelu
forku. Fork je cesta, jak Lazurio něco dodá. Jeho vlastní pojmy, role
a oprávnění nepřebírej, pokud je Lazurio vědomě nepřijalo; když se model
forku s Lazuriem rozchází, pojmenuj rozpor a volbu vrať uživateli.

## Dva druhy forku

**Distribuční fork** je tenká vrstva nad přesným releasem upstreamu.

- `main` je čitelný snapshot: přesný, neměnný stabilní commit upstreamu
  a nad ním jen aktuální, významově oddělené vlastní commity.
- Aktualizace přichází ze stabilního releasu upstreamu, ne z jeho
  pohyblivého `main`. Vlastní commity se na nový upstream přenesou
  jednotlivě a každý se znovu posoudí; starou vrstvu nepřenášej vcelku.
- Každý publikovaný stav nese chráněný neměnný release tag, aby šel obnovit.
  Tag se nikdy nepoužije znovu.

**Plný fork** jde vlastním směrem. Upstream je jen zdroj vybraných změn,
které se přebírají vědomě (cherry-pick nebo přepis) s odkazem na commit
upstreamu. Lazurio MausBot k plnému forku směřuje (decision 0169, dodatek
z 2026-10-24); do změny jeho release kontraktu platí pravidla, která
deklaruje repo forku.

Jakým druhem fork je, říká jeho repozitář (README nebo release kontrakt).
Když to neříká, zeptej se uživatele dřív, než začneš historií forku hýbat.

## Přepsání branche

Výchozí branch se běžně nepřepisuje. Distribuční fork ji při obnově
z upstreamu přepsat smí, jen pokud to jeho release kontrakt výslovně
dovoluje, a to takto:

1. starý stav je zachycený chráněným release tagem;
2. ověříš každý commit, který z branche zmizí (`git log <nový>..<starý>`):
   každý je v novém stavu, v upstreamu, nebo je vědomě opuštěný.
   Rozhoduje historie, ne jen výsledný strom;
3. zapisuješ jen exact `--force-with-lease=<ref>:<očekávaný-sha>`, nikdy
   obecný `--force`.

## Veřejnost

Forky bývají veřejné. Platí pro ně stejné pravidlo jako pro root: v jejich
commitech, pull requestech, issues ani dokumentaci nejmenuj zákaznické
Organizace, jejich Moduly ani Mašiny a nepiš do nich secrets ani privátní
data.
