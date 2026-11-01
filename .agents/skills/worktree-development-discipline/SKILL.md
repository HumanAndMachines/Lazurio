---
name: worktree-development-discipline
description: Povinná disciplína pro každou Git změnu, branch, PR, review, předávku a cleanup z Lazurio rootu. Drží primary checkout na main, worktrees v .worktrees/root pod owner repem, sidecar a bezpečné cleanup guardy.
---

# Worktree development discipline

## Kdy použít

Použij před každou změnou Git-trackovaného obsahu v Lazurio rootu a při
inventuře, předávce nebo úklidu worktrees. Kanonický plán drží Mission Control
Organizace, která práci vlastní; tato lokálně verzovaná kopie je samostatně
použitelný consumer kontrakt pro agenta, který startoval přímo zde. Veřejný
root kvůli němu nepotřebuje privátní Knowledgebase ani vlastní plánovací
autoritu.

## Postup

1. Primární checkout `<Lazurio>` je reference pro Launchpad/Doctor.
   Neměň v něm trackovaný obsah, nezakládej v něm feature branch a drž ho na
   `main`, pokud tomu nebrání už existující zachovaná práce. Před převzetím
   každého tasku v něm spusť nejdřív `lazurio update` a po jeho úspěchu
   `bun run doctor:task`. Update po vrstvách srovná Lazurio Root, Organization
   Rooty, namountovaná org-level repa a Workspace Moduly na clean `main` jen
   fast-forwardem; repozitáře jedné vrstvy běží souběžně. Náhodné dirty změny uloží do ověřeného
   recovery stashe bez automatického obnovení, cizí branch přepne na `main` a
   její commity zachová. U skutečně změněného source ověří package rooty
   deklarovaných Apps a neúspěšné ověření jednou zopakuje jako čistou frozen
   instalaci s rollbackem. Ahead/diverged main, nebezpečný detached stav,
   rozpracovaný merge/rebase/am a neplatný lockfile zůstanou blocked s promptem
   pro Codex; Agent je nikdy neopravuje resetem, přepisem historie ani
   generováním jiného dependency stromu. Productionspace, Personalspace,
   worktrees a root-space repository-db update nepřekračuje.
2. Než něco vytvoříš, spusť `bun run worktrees:status`. Audit čte Git registry,
   takže ukáže i linked worktrees mimo root. Je to informativní inventura;
   `bun run worktrees:check` je fail-closed kontrola umístění, metadat a Git
   zachování. Její PASS není cleanup autorizace.
3. Použij existující Mission Control plán jeho vlastníka a worktree založ
   kanonickou lane `bun run worktrees:create -- --plan <KOD-XXXX>` — odvodí
   basename z kanonického plan souboru, založí branch z čerstvého
   `origin/main` a vygeneruje schema-validní sidecar. Jeden worktree patří
   jednomu pull requestu, ne celému plánu: každý další pull request téhož
   plánu založ s `--name <kebab-case>` (vznikne `<KOD-XXXX>-<name>` s branchí
   `agent/<KOD-XXXX>-<name>` a vlastním sidecarem téhož plánu), takže
   souběžná vlákna na sebe nečekají a práci nikdo nepřikládá do cizího PR.
   Sourozenecký worktree mimo create lane nezakládej. Create lane vyhledá exact
   kód plánu v připojených
   `organizations/*/mission-control/db`; přijme právě jednu shodu a při nule
   nebo více shodách failne. Připojenou Organization lze výslovně zvolit
   generickým `MISSION_CONTROL_AUTHORITY_ROOT=<organization-root-or-db>`;
   externí checkout se pro nový worktree nepřijímá.
   Organization authority musí být lokální
   `organizations/<organization>/mission-control/db`; create lane ji do
   tohoto tvaru normalizuje, uloží do sidecaru a nikdy nevytváří duplicitní
   plán v jiném repu.
   Lazurio Root je výchozí edit repository. Pro změnu Organization rootu
   předej explicitní `--repository organizations/<Org-mount>`; selector přijme
   jen clean primary checkout na `main`, jehož nesymlinkovaná cesta, Git root,
   origin a runtime Organization manifest tvoří jednu identitu. Personalspace,
   Productionspace, repository-db, moduly, traversal a libovolná externí cesta
   jsou v této úzké lane odmítnuté. Worktree cesta je výhradně
   `<owner-repo>/.worktrees/root/<environment-id>/`; Environment ID je název
   kanonického plan souboru bez `.yaml`, nebo `<KOD-XXXX>-<name>` z `--name`.
   Branch obsahuje kód plánu. Vlastník edit checkoutu a vlastník Mission
   Control plánu smějí být dvě různé Organizace; sidecar drží obě identity
   a plán se nekopíruje.
   Review cizího pull requestu, ve kterém nic neměníš, plán nepotřebuje:
   udělej ho v odpojeném checkoutu přesného headu
   `git worktree add --detach .worktrees/review/<repo>-pr-<číslo> <head>`
   v owner repu, bez sidecaru, a po verdiktu ho smaž (`git worktree remove`,
   `git worktree prune`). Inventura ho vede jako `review` a odmítne ho, když
   stojí na branchi. Mission Control Organizace, které plán patří, k tomu
   nemusí být připojený. Když v pull requestu začneš měnit, jde to přes create
   lane a plán jako každá jiná změna.
4. Sidecar `<environment-id>.worktree.json` (schema
   `companiesascode.worktree.v1`) generuje create lane — zkontroluj ho,
   nevytvářej podruhé a nepřepisuj odvozená identity/path pole; doplň jen
   to, co skript nemohl bezpečně odvodit: `last_touched`, PR URL, purpose
   a cleanup pravidlo. Organization-scoped plán nese odvozený relativní
   `mission_control_authority_path`; nepřepisuj ho absolutní cestou ani
   traversalem. Platný sidecar navíc obsahuje
   `conversation_origin` a
   `recovery_handoff` (stav, stručné netajné summary, blocker, next action,
   `updated_at`) podle interního kontraktu v
   `manual/worktree-management.md`. U staršího schema-valid sidecaru jsou
   absence těchto polí advisory, ne falešná nevalidita. Owner se čte z plánu,
   sidecar není druhá autorita. Neukládej raw transcript, chain-of-thought,
   secrets ani absolutní transcript path.
5. Nevytvářej nové worktrees v `/tmp`, vedle repa, v
   `~/.hermes/worktrees`, `.claude/worktrees`, `.codex-tmp`,
   `.pr-worktrees`, legacy `.worktrees/<code>` ani uvnitř jiného repa.
6. Pokud primary není na `main` nebo je dirty, nic ručně nezahazuj ani
   neobnovuj. `lazurio update` zachová cizí branch/commity a případnou
   necommitnutou práci uloží do pojmenovaného recovery stashe. Nový task
   přesto zakládej výhradně v worktree z ověřeného `origin/main`; pokud update
   vrátí blocked, použij jeho Codex prompt a zachovej všechny commity i stashe.
7. Ještě před otevřením nebo předáním PR napiš rozhodnutelný popis: motivaci a
   relevantní souvislosti, cílový stav a přínos merge, skutečný rozsah včetně
   vědomě vynechaných částí, ověření a zbývající rizika, blokery či navazující
   kroky. Steward nesmí být nucen odvozovat „proč" jen z diffu. Popis po změně
   scope, rebase nebo zásadním review nálezu srovnej se skutečným HEADem a
   Mission Control plánem; samotný seznam souborů, commitů nebo testů není
   dokončený handoff.
8. Před každým pushem PR branche spusť preflight s cwd v edit worktree.
   `bun run pr:preflight` použij jen tehdy, když tento script deklaruje vlastní
   root `package.json` editovaného repa. U nested repa bez něj spusť přímo
   `bun <Lazurio-root>/scripts/pr-preflight.mjs`; Bun jinak může tiše vystoupat
   k nadřazenému `package.json` a zkontrolovat jiné repo. Gate fetchne
   `origin/main`, vyžaduje clean commit a čerstvý main jako předka HEAD. Pokud
   neprojde, udělej `git rebase origin/main`,
   zopakuj validace a gate; přepsanou branch pushni pouze příkazem s exact
   `--force-with-lease`, který gate vypíše. Po pushi ověř na GitHubu PR base
   `main`, exact head, mergeability a checks.
   Při rebase i merge drž tři pravidla:
   - Konflikt řeš po jednotlivých úsecích. Na konfliktní soubor nikdy
     nepoužij `git checkout --ours/--theirs <soubor>`: tiše zahodí i čisté
     změny druhé strany v tomto souboru. Konflikt obnovíš
     `git checkout -m <soubor>` a upravíš jen sporné úseky.
   - Než branch přepíšeš, ověř každý commit, který z ní zmizí
     (`git log <nový-head>..<starý-head>`): rozhoduje historie, ne jen
     výsledný strom.
   - Text pro `gh` (popis PR, komentář, review, issue) předávej souborem
     (`--body-file`, `-F`), nikdy v uvozovkách na příkazové řádce: backticky
     v textu shell spustí jako příkazy.
9. Commituj a pushuj do PR branche průběžně — po každém uzavřeném pracovním
   kroku, nejpozději před každou odpovědí uživateli, která ohlašuje stav
   práce. Po prvním pushi branch hned otevři PR proti správné base branchi
   jako GitHub Draft PR. Kde plán repozitáře Draft PR neumí (soukromé
   repozitáře na GitHub Free), otevři běžný PR a do popisu napiš, že je
   rozpracovaný. Pokud uživatel výslovně zakázal PR otevřít,
   nepokračuj za hranici lokálního experimentu a před dalším pushem nebo
   koncem práce si nástrojem na otázky vyžádej rozhodnutí: práci zahodit,
   nebo PR povolit —
   samotná remote branch bez PR není přípustná náhrada.
   Jakmile je práce hotová a ověřená, přepni PR na Ready for review
   sám, ještě před handoffem — Ready není Publikace, říká jen „připraveno
   ke kontrole"; hotová práce nezůstává viset jako GitHub Draft. Remote
   branch bez PR není dokončený handoff: snadno zapadne, Steward ji nemusí
   vidět a další agent ji nemusí převzít. Rozdělaná práce, která existuje
   jen lokálně, je porušení disciplíny (decisions 0103/0112).
10. Při pauze, blockeru, předání a před koncem agentního běhu aktualizuj
   `last_touched`, conversation origin aktuálního writera a recovery handoff.
   Při obnově práce lze podle lokálního vodítka dohledat původní chat, ale před
   commitem, pushem, PR rozhodnutím nebo cleanupem vždy ověř Git status/diff,
   remote, PR/checks, runtime a Mission Control.
11. Před handoffem aktualizuj sidecar a znovu spusť audit i
   `bun run worktrees:check`. Check je nutný, ale ne dostačující — teprve po
   něm pokládej otázku na Publikaci.
12. Handoff veď průvodcovsky (decisions 0103/0112): závěrečná zpráva začíná
   standardizovaným handoff blokem (PR URL, base, exact HEAD, lidské
   shrnutí, ověření, odkaz na aplikaci běžící z worktree), který zůstává
   textem zprávy. Pod ním polož nástrojem na otázky (decision 0211)
   standardizovanou dvojotázku „Mám změny Publikovat vaším jménem? Nebo mám
   požádat jiného Kolegu o kontrolu a Publikaci?" — obě volby vždy nabídni,
   žádnou neoznačuj jako doporučenou a nedomýšlej volbu za uživatele. Na
   týmovém Environmentu místo dvojotázky polož stejně nástrojem otázku
   „Komu mám říct, aby tyhle změny publikoval?", nikdy nemerguj (ani na
   „Publikuj") a pokračuj předáním níže (decision 0148, dodatek
   z 2026-10-05). Bez nástroje na otázky se zeptej textem s očíslovanými
   volbami a napiš, že čekáš na odpověď. Před otázkou zjisti
   živá GitHub práva uživatele a řiď se jimi, ne textovým labelem role —
   např. `gh api repos/<owner>/<repo> --jq .permissions`,
   `gh api repos/<owner>/<repo>/branches/<base>/protection`,
   `gh repo view <owner>/<repo> --json
   rebaseMergeAllowed,squashMergeAllowed,mergeCommitAllowed`,
   `gh pr view <číslo> --json headRefOid,mergeable,mergeStateStatus,reviewDecision`.
   `reviewDecision` sám schválení aktuálního obsahu nedokazuje: GitHub
   ponechá staré schválení i po novém commitu, pokud repozitář stará
   schválení nezahazuje. Požadované schválení musí patřit přesnému headu,
   tedy `commit_id` review z
   `gh api repos/<owner>/<repo>/pulls/<číslo>/reviews` se rovná
   `headRefOid`.
   Když uživatel v threadu zvolí Publikaci (v nástroji na otázky nebo
   explicitním „Publikuj"), PR mergni metodou, kterou repozitář
   povoluje, a to přes `gh pr merge <číslo> --<metoda> --match-head-commit
   <headRefOid>`, aby se mergnul právě ověřený head (při více povolených je default rebase, pokud Organizace ve svém
   `AGENTS.md` nedeklaruje jinak; synchronizaci šablony slučuj merge commitem
   až po ověření `git merge-base --is-ancestor <commit šablony> <head>` a
   povoleného merge commitu, jinak nesluč a nahlas to — decision 0174), v primárním checkoutu spusť
   `lazurio update`, potom `bun run doctor:task` a pokračuj cleanup guardy
   v kroku 13. Když uživatel zvolí předání, nebo mu GitHub merge
   nedovoluje, vyžádej review Kolegy, kterého uživatel zvolil, PR mu zároveň
   přiřaď a @zmínkou mu výslovně předej odpovědnost za dotažení
   (`gh pr edit --add-reviewer <login> --add-assignee <login>` + komentář PR).
   Reviewer request znamená kontrolu; assignee je owner další práce. Když
   Task Agent operuje pod přiřazeným GitHub účtem, pracuje přímo na PR
   branchi: řeší připomínky a CI, rebasuje a po preflightu smí použít jím
   vypsaný exact `--force-with-lease`. Nesmí změnu vrátit autorovi pouhým
   komentářem, pokud ji v rámci živých práv a scope může dotáhnout sám.
   Platné předání přes assignee je scoped pokyn k dotažení PR včetně dovoleného
   merge; další publikační komentář není nutný. Ověř původ a stále platné
   přiřazení podle `manual/pull-request-handoff.md`: předávající potřebuje
   živé Write/Maintain/Admin a právo předat Publikaci podle pravidel repa;
   samotné Triage oprávnění přiřadit PR nestačí. Assignee práci dokončí,
   nebo ji předá dalšímu oprávněnému assignee s konkrétním stavem. Assignment
   nevytváří GitHub práva ani neobchází review a branch rules. Samostatný
   Release, infra apply a změny přístupů mají vlastní podmínky.
   Pokud uživatel nikoho neurčil, polož mu volbu nástrojem na otázky
   — Stewarda použij bez další otázky jen tehdy, když ho jako výchozí
   rozhodující osobu určuje politika repa. Předej uživateli, kdo teď
   dotažení vlastní. Merge neobcházej ani na
   opakovanou žádost — GitHub ho fyzicky blokuje. Bez zelené PR zůstává
   otevřený a nic se neděje.
13. Worktree odstraň jen když je clean včetně untracked souborů, nemá
   local-only commit, exact HEAD je na remote (živá branch,
   `refs/pull/<číslo>/head` nebo předek čerstvého `origin/main`), jeho PR je
   merged nebo explicitně abandoned se snapshotem, runtime ho nepoužívá
   a neexistuje aktivní writer. Rozhoduje PR worktree, ne stav Mission
   Control plánu: worktree mergnutého PR ukliď hned, i když plán dál běží
   v jiných worktrees.
   Pak použij owner repo `git worktree remove <path>` a `git worktree prune`;
   sidecar smaž až potom. Než smažeš remote branch mergnutého PR, přesuň
   pull requesty, které na ní stojí, na `main`
   (`gh pr edit <číslo> --base main`); smazání branche (třeba přes refs API)
   by je jinak mohlo zavřít.
14. Plošné `rm -rf`, `--force`, `git branch -D` a automatické mazání podle stáří
   nejsou běžný cleanup. Nesplněný guard se předává konkrétně.

## Ověření

```bash
bun run worktrees:create -- --plan <KOD-XXXX> --dry-run
# každý další pull request téhož plánu má vlastní worktree:
bun run worktrees:create -- --plan <KOD-XXXX> --name <kebab-case> --dry-run
bun run worktrees:create -- --plan <KOD-XXXX> --repository organizations/<Org-mount> --dry-run
# pouze pro výslovný výběr připojené Organization; běžně se objeví automaticky:
MISSION_CONTROL_AUTHORITY_ROOT=<organization-root-or-db> bun run worktrees:create -- --plan <KOD-XXXX> --dry-run
bun run worktrees:status
bun run worktrees:check
# pouze před taskem z primárního main checkoutu
lazurio update
bun run doctor:task
# před každým PR pushem z edit worktree
# pokud vlastní root package.json deklaruje pr:preflight:
bun run pr:preflight
# jinak, stále s cwd v edit worktree:
bun <Lazurio-root>/scripts/pr-preflight.mjs
git status --short --branch
git -C <worktree> status --short --branch
jq '{conversation_origin, recovery_handoff}' <sidecar.worktree.json>
bun run check
bun run doctor
```

Povinný obsah a zakončení handoffu drží krok 12; navíc uveď stav primary
checkoutu, worktree cestu/branch/plán/sidecar, provedené ověření a výsledek
cleanupu nebo konkrétní důvod ponechání.
