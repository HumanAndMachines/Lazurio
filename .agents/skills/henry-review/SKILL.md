---
name: henry-review
description: Použij, když pull request potřebuje review Henryho Organizace, nebo mu chceš předat jeho dotažení. Žádost i předání jdou přes GitHub a přebírá je nativní GitHub intake Lazurio MausBotu; verdikt ověříš na přesném headu. Pablo (vývoj Lazuria) je stejný mechanismus, jeho odchylky drží skill `pablo-review` Organizace LazurioDevelopment. Nepoužívej k obcházení review, merge, nasazení ani ke změnám přístupů.
version: 1.0.0
author: Lazurio
license: MIT
metadata:
  hermes:
    tags: [github, pull-requests, review, persona, mausbot]
    related_skills: [worktree-development-discipline]
---

# Henry review

Henry Organizace je agent, který je pravou rukou Admina Organizace (0169,
0250). Běží v Prostředí s automatizacemi této Organizace jako tým Steward
v Lazurio MausBotu, pod vlastním účtem na GitHubu, který je Členem Organizace
s přesně nastavenými právy, a s odpovědným uživatelem. Kontroluje změny jako
druhé oči, a kde to pravidla dovolí, je schvaluje, slučuje a nasazuje. Jedná
jen v živých grantech svého účtu. Organizaci, která vlastního Henryho nemá,
slouží Henry integrátora; ten neběží v Prostředí s automatizacemi té
Organizace. Organizace může Henrymu dát jiné jméno, role se vždy jmenuje
Henry Organizace; persona je jen to jméno a charakter, nikdy účet ani
autorita (0156). Pablo je tentýž mechanismus v Organizaci LazurioDevelopment.

Práci přebírá jen nativní GitHub intake MausBotu (`docs/lazurio-github-intake.md`
ve forku `Lazurio/OpenMausBot`). Zhruba každých 90 s hledá otevřený Ready PR
v repozitářích vlastníků ze svého nastavení (`OMB_GITHUB_INTAKE_OWNERS`), kde
je účet Henryho:

- požádaný reviewer: review aktuálního headu;
- dřívější reviewer: review každého nového headu bez nové žádosti;
- assignee od živého pisatele repozitáře, jen se zapnutým předáním
  (`OMB_GITHUB_INTAKE_ASSIGNMENTS=1`): dotažení PR včetně dovoleného merge.

Repozitář mimo vlastníky intake nikdo nezpracuje, i když GitHub žádost přijme.

Draft intake přeskočí, dokud ho nepřepneš na Ready. PR, jehož autorem je účet
Henryho, nereviewuje: schvaluje ho člověk.

## Kdy použít

- Hotový PR potřebuje review Henryho Organizace.
- Uživatel chce, aby Henry PR dotáhl (přiřazení jako assignee).
- Review nepřišlo a potřebuješ zjistit proč.

## Postup

1. **Login.** Vezmi ho z `AGENTS.md` Organizace, které repozitář patří: je to
   Henry, jehož intake tuto Organizaci pokrývá. Když ho nejmenuje, je to
   Pablo `agentrozjedemeai`; jeho rozsah drží skill `pablo-review`.
2. **Příprava.** PR má popis s kontextem a zelené CI na headu a je Ready:
   `gh pr ready <n> -R <owner>/<repo>`.
3. **Review.** `gh pr edit <n> -R <owner>/<repo> --add-reviewer <login>`.
   Žádost znamená „vyžádáno“, ne „hotovo“. Neopakuješ ji, ani po pushi,
   a nezakládáš druhou cestu (soubor, skript, SSH, zprávu do vlákna).
   Když GitHub odpoví 422 „Reviews may only be requested from
   collaborators“, je login špatně, nebo účet Henryho nemá k repozitáři
   přístup; přístup nepřidáváš, řekneš to uživateli.
4. **Dotažení**, jen na pokyn uživatele nebo podle stálého mandátu:
   `gh pr edit <n> -R <owner>/<repo> --add-assignee <login>`, sebe jako
   předávajícího assignee odeber a do komentáře napiš stav, ověření a další
   krok. Předávající potřebuje živé Write, Maintain nebo Admin; samopřiřazení
   ani reviewer request mandát k merge nejsou (`manual/pull-request-handoff.md`).
5. **Nálezy.** Skutečnou vadu opravíš, na zbytek odpovíš věcnou námitkou
   (0163). Nový head Henry reviewuje sám.

Přiřazení nepřidává práva a neobchází branch rules. Release, apply,
přístupy, secrets a změna záměru mají vlastní mandát. Kde repozitář dovoluje
merge jen Vlastníkovi Organizace (typicky `infra`), Henry po review předá
dokončení Vlastníkovi Organizace.

**Změna přístupu** (členství, role, Teamy, zařízení lidí) má vlastní pravidlo
(0250). Zakládá ji jako pull request v `infra` jen Vlastník Organizace. Henry
Organizace ji jako druhé oči posoudí podle principů Lazuria, a když sedí, smí
ji schválit a po sloučení nasadit. Kde Organizace vlastního Henryho nemá,
dělá to Henry integrátora. Jiný agent změnu přístupu jen navrhuje a sám ji
neschvaluje. Ve Free Organizaci to drží dohoda, v placené pravidla repozitáře
`infra`; jejich vynucení se v placených Organizacích teprve zavádí, do té doby
platí dohoda i tam.

## Ověření

- **Verdikt** platí jen od loginu Henryho s `commit_id` rovným aktuálnímu
  headu:
  `gh api repos/<owner>/<repo>/pulls/<n>/reviews --jq '.[] | select(.user.login == "<login>") | [.state, .commit_id] | @tsv'`
  proti `gh pr view <n> -R <owner>/<repo> --json headRefOid --jq .headRefOid`.
  Přenesené schválení se nepočítá: po merge base větve nebo rebase beze
  změny diffu má `commit_id` nového headu, ale `submitted_at` starší než
  datum commitu headu.
- **Dotažení** je hotové, až je PR mergnutý do zamýšlené báze, nebo předaný
  dalšímu jmenovanému assignee se stavem a dalším krokem. Samotný komentář
  ani APPROVED dotažení nejsou.
- **Když verdikt ani důvod nepřichází:** ověř Ready, login a že je v
  `requested_reviewers` nebo už reviewoval
  (`gh api repos/<owner>/<repo>/pulls/<n> --jq '{draft, requested: [.requested_reviewers[].login]}'`).
  Pak to řekni uživateli; bot tomu, kdo mu práci zadal. Druhou cestu
  nezakládej. GitHub owner repozitáře mimo rozsah intake, vypnuté předání, pozastavený intake,
  chybějící přihlášení nebo plná fronta jsou konkrétní blokátory pro
  odpovědného uživatele Prostředí Henryho.
