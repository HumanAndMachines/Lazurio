---
name: admin-pr-sweep
description: Use when an Organization Admin asks to inventory and close out open pull requests authored by other people across administered GitHub Organizations, or a named author's open PRs in those Organizations. Builds a cross-Organization queue, processes one PR at a time, opens a worktree only when the branch needs rebase, conflict repair or a fix, merges within the Admin's live GitHub rights, closes superseded work, or hands blocked work to a named owner, and finishes with a ledger and clean primary checkouts.
version: 1.1.0
author: Lazurio
license: MIT
metadata:
  hermes:
    tags: [organization-admin, github, pull-requests, cross-organization, sweep]
    related_skills: [nightly-steward-pr-sweep, worktree-development-discipline, architecture-shaping]
---

# Admin PR Sweep

## Overview

Admin PR Sweep je práce **Organization Admina** napříč GitHub Organizacemi,
kde jeho účet drží admin práva. Cíl: každý vybraný otevřený PR od jiného
autora dostat do koncového stavu — merged na **živou default branch**
repa, closed jako nahrazený, nebo předaný jmenovanému ownerovi s konkrétní
next action. Task Agent tvoří Drafty a provádí Publikaci (merge/close) jen
na explicitní pokyn Principála platný v aktuálním threadu.

Liší se od `nightly-steward-pr-sweep`: ten běží pro právě jednu Organizaci
pod Steward seatem a Steward autoritou. Admin sweep je interaktivní,
cross-Organization, a používá živá admin práva Principála — včetně bypassu
tam, kde ho ruleset dovolí a kde je to zdůvodněné.

Merge na default branch **není** production Release. Když merged PR potřebuje
samostatný deploy gate (Cloudflare Pages, GA4 property, hosted runtime),
zapiš ho do ledgeru jako next action; nenasazuj ho ze sweepu bez odděleného
mandátu.

## Kdy použít

- Principál (Admin) chce přehled cizích PR napříč spravovanými Organizacemi
  a jejich dotažení na default branch.
- Principál zúží frontu na jednoho autora (`gh search prs --author <login>`)
  nebo na GitHub App (`gh search prs --app <slug>`, např. `dependabot`).
- Fronta obsahuje PR od Kolegů, AI Kolegů, botů i klientských Organizací.

Nepoužívej pro vlastní PR Principála (ty si řeší sám), pro Release, ani jako
náhradu review v jedné Organizaci se Steward seatem.

## Předpoklady

- `gh auth status` je přihlášený účet Principála; `gh api user --jq .login`
  vrací jeho login — filtr „cizí PR“ se odvozuje od něj.
- Primární Lazurio checkout prošel `lazurio update` a `bun run doctor:task`.
  Když update/doctor spadne, zapiš blocker do ledgeru. **Blokovaný lokální
  checkout nepoužívej** — žádné `cd`, test-merge, rebase ani push z něj.
  Inventuru a merge čistých PR veď z živého GitHubu (`gh`). Lokální rebase
  nebo opravu v zasažené Organizaci dělej ze scratch clone / nového
  worktree z `origin`, ne z toho blocked mountu. Closeout update zopakuje;
  nesouvisející blocker neschovávej.
- Explicitní mandát Principála k Publikaci pro celý sweep (merge, close,
  force-push s lease do cizích PR branchí, komentáře a assignee).
- Principál před startem rozhodl sporné skupiny: legacy repa (např. staré
  dependabot fronty), cizí Drafty, productionspace repa s vlastním branch
  modelem, Windows testovací Mašina.

## Postup

### 1. Inventura

Nejdřív seznam Organizací, které Principál **administruje**. Membership
nestačí — cizí org, kde je jen contributor, do fronty nepatří.

```bash
gh api user/memberships/orgs --paginate \
  --jq '.[] | select(.role=="admin") | .organization.login' \
  > /tmp/admin-orgs.txt
```

**Plná Admin fronta** (každý cizí otevřený PR ve spravovaných orgs):

```bash
: > /tmp/all_prs.jsonl
while IFS= read -r org; do
  gh search prs --owner "$org" --state open --limit 1000 \
    --json repository,number,title,author,isDraft,createdAt,updatedAt,url \
    | jq -c '.[]' >> /tmp/all_prs.jsonl
done < /tmp/admin-orgs.txt
```

**Author-scoped fronta** (Principál jmenoval lidského / AI autora):

```bash
gh search prs --author "$AUTHOR" --state open --limit 1000 \
  --json repository,number,title,author,isDraft,createdAt,updatedAt,url \
  | jq -c '.[]' > /tmp/all_prs.jsonl
```

GitHub App (Dependabot a podobně) hledej `--app "$APP"`, ne `--author`.
`--author dependabot` frontu vyprázdní.

Když počet výsledků == `--limit`, stránka je useknutá. Dosaď per-org
`--owner "$org"` (a u autora i `--author` / `--app`) a slož frontu z
úplných org stránek. Stejný cap při closeout inventuře nestačí — znovu
ověř, že žádný dotaz nestopl na limitu.

Potom vyřaď PR mimo `/tmp/admin-orgs.txt`. Search napříč GitHubem jinak
vrátí i Drafty v cízích orgs (forks, upstream contrib).

Vyfiltruj `author != <login Principála>`. Ke každému PR doplň
`gh pr view --json baseRefName,reviewDecision,mergeable,mergeStateStatus,statusCheckRollup,isDraft`
a zvlášť `gh repo view --json defaultBranchRef --jq .defaultBranchRef.name`.
**Neslučuj** `baseRefName` s default branch — PR na `release/*` nebo
údržbovou větev default **není**. Default není vždy `main` (Mission
Control data používá `v3`). Když `baseRefName != defaultBranchRef`,
nesplňuje cíl „na default branch“: nechej otevřené s next action, pokud
Principál ten cílový branch výslovně nezařadil.

Před closeoutem inventuru **zopakuj**. Během běhu mohou vzniknout nové PR
stejného autora nebo závislosti; tabulka z první chvíle není konečná.

### 2. Ledger a pořadí

Založ lokální ledger (gitignored, např. `drafts/pr-sweep-<datum>-ledger.md`)
s řádkem na PR: repo#číslo, autor, stav před, verdikt, poznámka. Aktualizuj ho
po každém PR; je to jediná paměť sweepu při ztrátě kontextu.

Pořadí: **Lazurio jádro → sdílené šablony → mateřská Organizace → ostatní
Organizace → klienti.** Uvnitř repa nejdřív PR bez konfliktu, potom
konfliktní; závislosti z popisů PR (owner PR před root PR) respektuj.

Hned na začátku každého PR přiřaď Principála: `gh pr edit N --repo owner/repo
--add-assignee <login>`. Cizího assignee (např. review bota) odstraň, jen
když má Principál zůstat jediným ownerem dotažení.

### 3. Worktree jen když je potřeba

Worktree **není** daň za každý PR.

| Stav PR | Worktree |
|---|---|
| CLEAN, CI zelené, mergeable, bez požadované opravy | ne — review + merge z `gh` |
| BEHIND bez konfliktu a GitHub rebase/update-branch stačí | ne — `gh pr update-branch` nebo merge metoda rebase |
| Konflikt, lokální rebase, oprava, derived artefakt, test-merge | ano — jeden PR = jeden worktree |

Mountované repo:

```bash
local_branch="sweep/${repo_slug}-pr${N}"
git -C <repo> fetch origin "+refs/heads/${b}:refs/remotes/origin/${b}"
git -C <repo> worktree add -b "$local_branch" \
  <Lazurio>/.worktrees/sweep/<repo>-pr<N> origin/"${b}"
```

Lokální větev je **sweep-owned** (`sweep/<repo>-pr<N>`), ne reset jména
PR branche `"${b}"`. Když `worktree add -b` selže, protože `$local_branch`
už existuje nebo ji drží jiný worktree, **nesahaj** na `switch -C` ani
na existující `"${b}"` — najdi ten worktree, nebo zvol jiné jméno.
`git switch -C "$b"` by zahodil lokální commity na `"${b}"`.

Kdyby HEAD přesto zůstal detached, vytvoř novou větev jen malým `-c`
(selže, když jméno už je):

```bash
git -C <worktree> switch -c "$local_branch"
```

Nemountované repo: scratch clone v `~/.cache/lazurio-pr-sweep/<owner>/<repo>`
(na konci smazat). Nested repa mívají omezený `remote.origin.fetch`; branch
fetchni explicitním refspec výše. V zsh vždy `"${b}"` — `$b:refs` spustí
modifikátor `:r`.

Před každou dávkou příkazů ověř, že worktree existuje — `cd`, které selže,
nechá příkazy běžet v primárním checkoutu.

**zsh:** nikdy neskládej `owner/repo` a číslo do jednoho unquoted slova
(`for spec in owner/repo 12` rozbije lomítko / číslo). Iteruj takto:

```bash
repo='HumanAndMachine-ai/knowledgebase'
n=87
gh pr view "$n" --repo "$repo"
# nebo
while IFS=' ' read -r repo n; do
  gh pr view "$n" --repo "$repo"
done <<'EOF'
HumanAndMachine-ai/knowledgebase 87
EOF
```

V zsh se `for f in $U` nerozdělí na slova; iteruj přes `while read` nebo
`${=U}`.

### 4. Posouzení

Čti popis PR, diff a review vlákna (včetně botů). Rozhoduj podle:

| Situace | Verdikt |
|---|---|
| Souladné, CI zelené, mergeable | approve + merge |
| Souladné, za default branch / konflikt | rebase ve worktree, opravit, preflight, `--force-with-lease`, merge |
| Review vyžaduje změny, opravitelné v mandátu | opravit, odpovědět ve vláknu, resolve, merge |
| Nahrazeno novější prací na default branch nebo jiným PR | close s odkazem na náhradu |
| Repo archivované/deprecated | unarchive → close s komentářem → re-archive |
| Fork Organizace mění sdílenou implementaci | upstream-first: nechat otevřené, next action = PR do template |
| Rescue/WIP Draft s citlivými firemními daty | nechat otevřené, komentář + assignee owner |
| Blokované externí závislostí (nepublikovaný producer, chybějící tooling) | nechat otevřené, jmenovat ownera a přesnou next action |

Nesouladné s hodnotami Lazuria (druhý ACL, paralelní mechanismus, duplicitní
autorita) zavři s vysvětlením, ne s mlčením.

### 5. Ověření před merge

- Spusť testy/check daného repa ve worktree; u PR za default branch udělej
  lokální test-merge (`git merge --no-commit --no-ff origin/<default>`,
  testy, abort).
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
- Když GitHub řekne `This branch can't be rebased` a squash je povolený,
  **fallback na squash** — nenech PR viset kvůli merge commitům na branchi.
- Strict status checks: po merge jiného PR je branch BEHIND — `gh pr
  update-branch` a počkat na CI.
- Ruleset „approval od někoho jiného než posledního pushera“: po vlastním
  rebase nemůžeš schválit; předej review Stewardovi (`--add-reviewer
  --add-assignee` + komentář).
- `--admin` bypass použij jen pro známou environmentální CI baseline
  (stejná chyba na default branch/ostatních PR), a důvod napiš do review.
- Po merge worktree odstraň (`git worktree remove`, `worktree prune`,
  smazat lokální branch) dřív, než začneš další PR. Maž **jen** worktree
  tohoto PR, ne celý `.worktrees/sweep/`.

### 7. Closeout

- Zopakuj inventuru (krok 1). Ledger bez `TODO`; každý zbývající otevřený PR
  má komentář s ownerem a next action.
- Smaž scratch clones a worktrees **tohoto** sweepu
  (`.worktrees/sweep/<repo>-pr<N>`). **Nemaž** `rm -rf .worktrees/sweep/` —
  v adresáři můžou viset leftover z jiné relace (jiný PR, jiný Agent).
- V primárním checkoutu `lazurio update` a `bun run doctor:task`; ověř, že
  primary je na `main` bez lokálních změn. Nesouvisející blocker zapiš do
  handoffu, neskrývej ho.
- Handoff Principálovi: tabulka merged / closed / open-with-owner, leftover
  worktrees z dřívějších relací, deploy/Release závislosti, doporučené
  navazující kroky.

Když Principál **už v tomto threadu** udělil publikační mandát na celý
sweep, po closeoutu **neopakuj** otázku „Mám změny Publikovat tvým jménem?“.
Mandát se spotřeboval merge/close jednotlivých PR. Dvojotázka patří jen
novému source PR, který ze sweepu vznikl (oprava skillu, follow-up v jiném
repu) a sweepem ještě nebyl publikovaný.

## Ověření

```bash
gh api user --jq .login
gh api user/memberships/orgs --paginate --jq '.[] | select(.role=="admin") | .organization.login'
gh search prs --author <login> --state open --limit 1000 --json url,repository
gh repo view <owner/repo> --json defaultBranchRef --jq .defaultBranchRef.name
git -C <repo> worktree list
bun <Lazurio>/scripts/pr-preflight.mjs
gh pr view <N> --repo <owner/repo> --json state,mergeStateStatus,reviewDecision,baseRefName
bun run doctor:task
```
