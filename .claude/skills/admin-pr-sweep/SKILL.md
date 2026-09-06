---
name: admin-pr-sweep
description: Use when an Organization Admin asks to inventory and close out every open pull request authored by other people across all GitHub Organizations they administer. Builds a cross-Organization queue, processes one PR at a time in its own worktree, fixes or rebases within the Admin's live GitHub rights, merges, closes superseded work, or hands blocked work to a named owner, and finishes with a ledger and clean primary checkouts.
version: 1.0.0
author: Lazurio
license: MIT
metadata:
  hermes:
    tags: [organization-admin, github, pull-requests, cross-organization, sweep]
    related_skills: [nightly-steward-pr-sweep, worktree-development-discipline, architecture-shaping]
---

# Admin PR Sweep

## Overview

Admin PR Sweep je práce **Organization Admina** napříč všemi GitHub
Organizacemi, kde jeho účet drží admin práva. Cíl: každý otevřený PR od jiného
autora dostat do koncového stavu — merged, closed jako nahrazený, nebo
předaný jmenovanému ownerovi s konkrétní next action. Task Agent tvoří Drafty
a provádí Publikaci (merge/close) jen na explicitní pokyn Principála platný
v aktuálním threadu.

Liší se od `nightly-steward-pr-sweep`: ten běží pro právě jednu Organizaci
pod Steward seatem a Steward autoritou. Admin sweep je interaktivní,
cross-Organization, a používá živá admin práva Principála — včetně bypassu
tam, kde ho ruleset dovolí a kde je to zdůvodněné.

## Kdy použít

- Principál (Admin) chce přehled cizích PR napříč Organizacemi a jejich
  dotažení „na main“.
- Fronta obsahuje PR od Kolegů, AI Kolegů, botů i klientských Organizací.

Nepoužívej pro vlastní PR Principála (ty si řeší sám), pro Release, ani jako
náhradu review v jedné Organizaci se Steward seatem.

## Předpoklady

- `gh auth status` je přihlášený účet Principála; `gh api user --jq .login`
  vrací jeho login — filtr „cizí PR“ se odvozuje od něj.
- Primární Lazurio checkout prošel `lazurio update` a `bun run doctor:task`.
- Explicitní mandát Principála k Publikaci pro celý sweep (merge, close,
  force-push s lease do cizích PR branchí, komentáře a assignee).
- Principál před startem rozhodl sporné skupiny: legacy repa (např. staré
  dependabot fronty), cizí Drafty, productionspace repa s vlastním branch
  modelem, Windows testovací Mašina.

## Postup

### 1. Inventura

```bash
gh api user/orgs --paginate --jq '.[].login' > /tmp/orgs.txt
for org in $(cat /tmp/orgs.txt); do
  gh search prs --owner "$org" --state open --limit 200 \
    --json repository,number,title,author,isDraft,createdAt,updatedAt,url
done | jq -c '.[]' > /tmp/all_prs.jsonl
```

Zkontroluj, že žádná Organizace nenarazila na limit 200. Vyfiltruj
`author != <login>`. Ke každému PR doplň `gh pr view --json
reviewDecision,mergeable,mergeStateStatus,statusCheckRollup,isDraft`.

### 2. Ledger a pořadí

Založ lokální ledger (gitignored, např. `drafts/pr-sweep-<datum>-ledger.md`)
s řádkem na PR: repo#číslo, autor, stav před, verdikt, poznámka. Aktualizuj ho
po každém PR; je to jediná paměť sweepu při ztrátě kontextu.

Pořadí: **Lazurio jádro → sdílené šablony → mateřská Organizace → ostatní
Organizace → klienti.** Uvnitř repa nejdřív PR bez konfliktu, potom
konfliktní; závislosti z popisů PR (owner PR před root PR) respektuj.

### 3. Jeden PR = jeden worktree

- Mountované repo: `git -C <repo> worktree add
  <Lazurio>/.worktrees/sweep/<repo>-pr<N> origin/<branch>`. Nemountované
  repo: scratch clone v `~/.cache/lazurio-pr-sweep/<owner>/<repo>` (na konci
  smazat).
- Nested repa mívají omezený fetch refspec; branch fetchni explicitně
  `git fetch origin "+refs/heads/${b}:refs/remotes/origin/${b}"` (v zsh vždy
  `${b}`, jinak `$b:refs` vyhodnotí modifikátor `:r`).
- Před každou dávkou příkazů ověř, že worktree existuje — `cd`, které selže,
  nechá příkazy běžet v primárním checkoutu.
- V zsh se `for f in $U` nerozdělí na slova; iteruj přes `while read` nebo
  `${=U}`.

### 4. Posouzení

Čti popis PR, diff a review vlákna (včetně botů). Rozhoduj podle:

| Situace | Verdikt |
|---|---|
| Souladné, CI zelené, mergeable | approve + merge |
| Souladné, za main / konflikt | rebase ve worktree, opravit, preflight, `--force-with-lease`, merge |
| Review vyžaduje změny, opravitelné v mandátu | opravit, odpovědět ve vláknu, resolve, merge |
| Nahrazeno novější prací na main nebo jiným PR | close s odkazem na náhradu |
| Repo archivované/deprecated | unarchive → close s komentářem → re-archive |
| Fork Organizace mění sdílenou implementaci | upstream-first: nechat otevřené, next action = PR do template |
| Rescue/WIP Draft s citlivými firemními daty | nechat otevřené, komentář + assignee owner |
| Blokované externí závislostí (nepublikovaný producer, chybějící tooling) | nechat otevřené, jmenovat ownera a přesnou next action |

Nesouladné s hodnotami Lazuria (druhý ACL, paralelní mechanismus, duplicitní
autorita) zavři s vysvětlením, ne s mlčením.

### 5. Ověření před merge

- Spusť testy/check daného repa ve worktree; u PR za main udělej lokální
  test-merge (`git merge --no-commit --no-ff origin/main`, testy, abort).
- Derived artefakty přegeneruj (např. Deals `materialize` + `validate`),
  nikdy neřeš konflikt v generovaném souboru ručně.
- JSON ledgery (`TODO/DONE/ISSUES`) sluč podle `id`; CHANGELOG zachovej obě
  strany; navigační soubory (sidebar) sluč, nikdy neber jen jednu stranu —
  ztratíš položky z mezitím mergnutých PR.
- Push jen příkazem z `bun <Lazurio>/scripts/pr-preflight.mjs`
  (exact `--force-with-lease`).

### 6. Merge

- Metodu urči z `gh repo view --json rebaseMergeAllowed,squashMergeAllowed,
  mergeCommitAllowed`; při více povolených drž zvyklost repa (Lazurio root
  merge commit, template repa rebase).
- Strict status checks: po merge jiného PR je branch BEHIND — `gh pr
  update-branch` a počkat na CI.
- Ruleset „approval od někoho jiného než posledního pushera“: po vlastním
  rebase nemůžeš schválit; předej review Stewardovi (`--add-reviewer
  --add-assignee` + komentář).
- `--admin` bypass použij jen pro známou environmentální CI baseline
  (stejná chyba na main/ostatních PR), a důvod napiš do review.
- Po merge worktree odstraň (`git worktree remove`, `worktree prune`,
  smazat lokální branch) dřív, než začneš další PR.

### 7. Closeout

- Ledger bez `TODO`; každý otevřený PR má komentář s ownerem a next action.
- Smaž scratch clones a `.worktrees/sweep/`.
- V primárním checkoutu `lazurio update` a `bun run doctor:task`; ověř, že
  primary je na `main` bez lokálních změn.
- Handoff Principálovi: tabulka merged / closed / open-with-owner, stale
  worktrees z dřívějších relací, doporučené navazující kroky.

## Ověření

```bash
gh api user --jq .login
gh search prs --owner <org> --state open --limit 200 --json number | jq length
git -C <repo> worktree list
bun <Lazurio>/scripts/pr-preflight.mjs
gh pr view <N> --repo <owner/repo> --json state,mergeStateStatus,reviewDecision
bun run doctor:task
```
