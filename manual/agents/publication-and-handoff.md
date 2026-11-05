# Pull request, Publikace a handoff

Závazná součást pravidel pro agenty v Lazurio rootu. Platí stejně jako
`AGENTS.md`, který na tento manuál odkazuje a drží jeho závazné jádro. Načti
ho, než napíšeš popis PR, přepíšeš branch nebo řešíš konflikt, přepneš PR na
Ready, odpovíš na review a než napíšeš závěrečnou zprávu s handoffem.

Text níže byl přesunut z `AGENTS.md` beze změny znění. Oddíly nesou názvy
oddílů `AGENTS.md`, ze kterých pocházejí; body, které v `AGENTS.md` zůstaly
doslova, tu nejsou.

## Pull request a Publikace

- **Popis PR** nese kontext k rozhodnutí: motivaci, cílový stav, co se mění
  i záměrně nemění, ověření, rizika a navazující kroky. Po změně scope nebo
  rebase odpovídá aktuálnímu headu.
- **Git a GitHub** (podrobně skill `worktree-development-discipline`):
  schválení platí jen pro přesný head, ke kterému bylo dáno, a merge jde
  s `--match-head-commit`. Konflikt řešíš po úsecích, nikdy
  `git checkout --ours/--theirs <soubor>`. Před přepsáním branche ověříš
  každý commit, který zmizí. Text pro `gh` předáváš souborem, ne
  v uvozovkách. Před smazáním branche přesuneš pull requesty, které na ní
  stojí, na `main`.
- **Ověření v prohlížeči** (0178): změnu, se kterou se uživatel potká, sám
  otevřeš v prohlížeči před Ready a po nasazení: stránka se vykreslí a hlavní
  cesta funguje. Přihlášení projdeš testovacím účtem, který určil uživatel
  nebo Organizace; vlastní účet nezakládáš, jinak požádáš o jedno přihlášení.
  Výsledek, nebo že ověření chybí, uvedeš v handoffu pod „Ověřeno“. Vzhled
  stránky nehlídá vlastní automatický test vykreslení; testy drží kontrakt
  chování.
- **Review** bereš vážně, ale ne bez výhrad (0163). Skutečnou vadu opravíš
  hned: špatné chování, rozpor mezi texty, tvrzení bez důkazu, únik
  citlivého obsahu. Na drobnost bez dopadu, spekulaci nebo rozšíření záběru
  odpovíš věcnou námitkou v PR a požádáš o verdikt na nezměněném headu.
  Trvá-li reviewer na svém, předložíš obě stanoviska uživateli. Nález, který
  má cenu, ale do PR nepatří, zapíšeš jako issue.

## Handoff

Uživatel nemusí rozumět Gitu ani GitHubu; jsi jeho průvodce. Před handoffem
uveď, které scope a repo se změnily, jaké příkazy opravdu
proběhly a s jakým výsledkem, co zůstalo lokálně, přesnou PR URL, base
a pushnutý head každého editovaného repa a kam je zapsaný blocker nebo další
krok. Po změně root configu, Launchpadu, Guide nebo mountpointů spusť
`bun run check` a `bun run doctor`.

Závěrečná zpráva chatu, ve kterém vznikl PR, začíná blokem (0103):

```
## Handoff
Připravil jsem vám pull request: <URL> (base: <branch>, HEAD: <sha>)
Co Publikace zavede: <lidské a praktické shrnutí hlavního směru, dopadu,
záměrných non-goals, podstatných rollout/rizik a otevřených otázek>
Ověřeno: <checks/testy a výsledek>
Zkontrolujte si to v aplikaci: <URL běžící z worktree, pokud existuje>
Lokálně nezůstává nic mimo PR.
```

Shrnutí musí být srozumitelné bez otevření PR: hlavní směr, praktický dopad,
co se záměrně nemění, rollout, rizika a otevřené otázky. Není to seznam
souborů, commitů ani testů. Blok zůstává textem zprávy. Pod ním položíš
nástrojem na otázky dvojotázku „Mám změny Publikovat vaším jménem? Nebo mám
požádat jiného Kolegu o kontrolu a Publikaci?“ s volbami „Publikovat vaším
jménem“ a „Požádat jiného Kolegu“; žádnou neoznačíš jako doporučenou. Bez
nástroje ji napíšeš jako očíslované volby a dodáš, že čekáš na odpověď.
Když ti uživatel Publikaci dovolil předem a neodvolal ji, dvojotázku
nepokládáš: publikuješ a v handoffu to oznámíš.

Před otázkou zjistíš živá GitHub práva uživatele. Zvolí-li Publikaci a smí
merge, mergneš metodou, kterou repozitář povoluje, na ověřeném headu,
aktualizuješ `main` a uklidíš worktree. Zvolí-li předání, vyžádáš review
zvoleného oprávněného Kolegy, přiřadíš mu PR jako assignee a @zmínkou mu
předáš odpovědnost za dotažení; reviewer request je jen kontrola, assignee
je owner další práce (`manual/pull-request-handoff.md`). Uživateli řekneš,
kdo teď dotažení vlastní. Když GitHub merge nedovolí, řekneš to rovnou;
merge neobcházíš a bez zeleného PR se nic neděje. Na Týmovém Prostředí místo
dvojotázky položíš otázku „Komu mám říct, aby tyhle změny publikoval?“
a následuje vždy předání jmenovanému uživateli (0148).
