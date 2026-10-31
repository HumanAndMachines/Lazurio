---
name: henry-review
description: Použij, když pull request potřebuje review persony Organizace (Henry), nebo jí chceš předat jeho dotažení. Žádost i předání jdou přes GitHub a přebírá je nativní GitHub intake Lazurio MausBotu; verdikt ověříš na přesném headu. Pablo (vývoj Lazuria) je stejný mechanismus, jeho odchylky drží skill `pablo-review` Organizace LazurioDevelopment. Nepoužívej k obcházení review, merge, nasazení ani ke změnám přístupů.
version: 1.0.0
author: Lazurio
license: MIT
metadata:
  hermes:
    tags: [github, pull-requests, review, persona, mausbot]
    related_skills: [worktree-development-discipline]
---

# Henry review

Henry je persona Prostředí Henry Organizace (0169): tým Steward v Lazurio
MausBotu pod vlastním GitHub účtem persony a s odpovědným uživatelem. Persona
nemá vlastní práva; jedná v živých grantech svého účtu. Pablo je tentýž
mechanismus v Organizaci LazurioDevelopment.

Práci přebírá jen nativní GitHub intake MausBotu (`docs/lazurio-github-intake.md`
ve forku `Lazurio/OpenMausBot`). Zhruba každých 90 s hledá otevřený Ready PR,
kde je účet persony:

- požádaný reviewer: review aktuálního headu;
- dřívější reviewer: review každého nového headu bez nové žádosti;
- assignee od živého pisatele repozitáře: dotažení PR včetně dovoleného merge.

Draft intake přeskočí, dokud ho nepřepneš na Ready. PR, jehož autorem je účet
persony, nereviewuje: schvaluje ho člověk.

## Kdy použít

- Hotový PR potřebuje review persony.
- Uživatel chce, aby persona PR dotáhla (přiřazení jako assignee).
- Review nepřišlo a potřebuješ zjistit proč.

## Postup

1. **Login.** Vezmi ho z `AGENTS.md` Organizace, které repozitář patří. Když ho
   nejmenuje, je to Pablo `agentrozjedemeai` (skill `pablo-review`).
2. **Příprava.** PR má popis s kontextem a zelené CI na headu a je Ready:
   `gh pr ready <n> -R <owner>/<repo>`.
3. **Review.** `gh pr edit <n> -R <owner>/<repo> --add-reviewer <login>`.
   Žádost znamená „vyžádáno“, ne „hotovo“. Neopakuješ ji, ani po pushi,
   a nezakládáš druhou cestu (soubor, skript, SSH, zprávu do vlákna).
4. **Dotažení**, jen na pokyn uživatele nebo podle stálého mandátu:
   `gh pr edit <n> -R <owner>/<repo> --add-assignee <login>`, sebe jako
   předávajícího assignee odeber a do komentáře napiš stav, ověření a další
   krok. Předávající potřebuje živé Write, Maintain nebo Admin; samopřiřazení
   ani reviewer request mandát k merge nejsou (`manual/pull-request-handoff.md`).
5. **Nálezy.** Skutečnou vadu opravíš, na zbytek odpovíš věcnou námitkou
   (0163). Nový head persona reviewuje sama.

Přiřazení nepřidává práva a neobchází branch rules. Release, apply,
přístupy, secrets a změna záměru mají vlastní mandát. Kde repozitář dovoluje
merge jen Ownerovi (typicky `infra`), persona po review předá dokončení
Ownerovi.

## Ověření

- **Verdikt** platí jen od loginu persony s `commit_id` rovným aktuálnímu
  headu:
  `gh api repos/<owner>/<repo>/pulls/<n>/reviews --jq '.[] | select(.user.login == "<login>") | [.state, .commit_id] | @tsv'`
  proti `gh pr view <n> -R <owner>/<repo> --json headRefOid --jq .headRefOid`.
  Schválení, které GitHub po rebase přenese na nový head, se nepočítá.
- **Dotažení** je hotové, až je PR mergnutý do zamýšlené báze, nebo předaný
  dalšímu jmenovanému assignee se stavem a dalším krokem. Samotný komentář
  ani APPROVED dotažení nejsou.
- **Bez verdiktu po hodině:** ověř Ready, login a že je v
  `requested_reviewers` nebo už reviewoval
  (`gh api repos/<owner>/<repo>/pulls/<n> --jq '{draft, requested: [.requested_reviewers[].login]}'`).
  Pak to řekni uživateli; bot tomu, kdo mu práci zadal. Druhou cestu
  nezakládej. Pozastavený intake, chybějící přihlášení nebo plná fronta jsou
  konkrétní blokátory pro odpovědného uživatele Prostředí persony.
