---
name: lazurio-example-smoke-test
description: Use whenever a Task Agent must verify a user-facing Lazurio change end to end (decision 0178) — Dashboard, Launchpad, sign-in and sign-out, onboarding, Environments, a rollout on the Ring 0 reference Organization, or a migration. Signs the agent's own browser profile in as Alena or Bob, the fictional people of LazurioExampleOrganization, from the Organization-local custody, and lets the agent click the change through as a real user.
version: 1.0.0
author: Lazurio
license: MIT
metadata:
  hermes:
    tags: [smoke-test, browser, sign-in, ring-0, lazurio-example-organization]
    related_skills: [worktree-development-discipline]
---

# Smoke test jako Alena nebo Bob

## Overview

`LazurioExampleOrganization` je veřejná referenční Organizace a první vlna
každého rolloutu sdíleného softwaru (decision 0204). „Žijí a pracují“ v ní
dvě smyšlené postavy s vlastními GitHub účty:

| Postava | GitHub login | Role | Prostředí |
| --- | --- | --- | --- |
| Alena (Lazurio Example User) | `lazurio-alena` | člen, Team `workspace` | `team-01`, sdílené `try-01` |
| Bob (Lazurio Example Admin) | `lazurio-bob` | Owner Organizace | `admin-01` |

Operátor (Matěj, 2026-10-17) je určil jako **testovací účty Lazuria pro
všechny Agenty** ve smyslu decision 0178. Účty nedrží nic tajného ani
citlivého, takže je smíš používat volně a bez ptaní. Smyslem je, aby každý
Agent ověřil svou změnu na vlastní kůži, celou cestou od přihlášení po
odhlášení, a Operátor ji nemusel proklikávat sám.

## Kdy použít

- Každá změna, se kterou se člověk potká: UI Dashboardu, Launchpadu nebo
  aplikace, přihlašovací a odhlašovací cesta, onboarding, nasazená aplikace.
  Před Ready PR ji ověřuje autor, po nasazení ten, kdo publikoval (0178).
- Rollout Machines, LazurioPlatform, T3 Code, MausBot nebo změna vstupu
  v Auth a Dashboardu: nejdřív na Example (Ring 0, 0204), akceptace v
  prohlížeči jako Alena a Bob, teprve potom další vlna.
- Migrace a přechody verzí, které člověk uvidí (přihlášení po upgradu,
  zachovaná data, první spuštění).

Nepoužívej Alenu ani Boba v klientských Organizacích a nikdy na ně
nevkládej osobní, klientská ani jinak citlivé údaje: přihlašovací údaje
sdílí všichni Agenti.

## Postup

1. **Údaje.** Leží v Organization-local custody na této Mašině:
   `organizations/LazurioExampleOrganization_GEN3/company/colleagues/<login>/private/secrets/github/<login>/login.json`
   (heslo a TOTP klíč, mód 0600, mimo Git). Když chybí, skript vrátí
   `EXAMPLE_CREDENTIALS_MISSING`. Požádej Operátora, ať je uloží lokálním
   formulářem `python3 -I scripts/save-credentials.py` (vypíše
   `FORM_URL=…`, otevři mu ji). Údaje nikdy nechtěj do chatu.
2. **Vlastní profil.** Každý Agent pracuje ve vlastním Chrome profilu:
   `bun scripts/example-account.mjs signin <alena|bob> --profile-name <tvůj-task>`.
   Skript přihlásí profil do GitHubu (heslo + TOTP) a do Lazuria
   (`dashboard.lazurio.ai`, včetně prvního doplnění profilu) a vypíše
   `EXAMPLE_PROFILE`. Profily Operátorových ikon v Docku
   (`~/.local/share/lazurio/example-chrome/<alena|bob>`) nepoužívej.
3. **Proklikej změnu.** `bun scripts/example-account.mjs open <alena|bob>
   --profile-name <tvůj-task> --url <URL>` otevře profil ve viditelném
   Chrome a vypíše `EXAMPLE_CDP_URL`. Připoj se na něj (Playwright
   `chromium.connectOverCDP`) a projdi hlavní cestu jako uživatel. Máš-li
   vlastní prohlížečový nástroj, můžeš místo toho použít údaje z custody a
   `bun scripts/example-account.mjs totp <alena|bob>` pro aktuální kód.
4. **Celá cesta, ne jen stránka.** Podle změny ověř i odhlášení a nové
   přihlášení, přechod do Prostředí (Bob `admin-01`, Alena `team-01`),
   práva role (člen vs. Owner) a stav po migraci či upgradu. Kde jde o
   výchozí přihlášení nového uživatele, začni z čistého profilu (nové
   `--profile-name`).
5. **Neměň účty.** Heslo, 2FA, e-mail, členství a role Aleny ani Boba měň
   jen na výslovný pokyn Operátora; zamkl bys ostatní Agenty. Data, která
   test vytvoří v Example Organizaci, smíš nechat nebo uklidit; Example je
   zahoditelná.
6. **Výsledek.** Do handoffu pod „Ověřeno“ napiš účet, URL, čas a co
   prošlo nebo selhalo. Selhání produktu zapiš jako issue v owning repu.

## Ověření

```bash
bun scripts/example-account.mjs signin alena --profile-name check
# github: signed in as lazurio-alena
# lazurio: signed in (https://dashboard.lazurio.ai/home)
bun scripts/example-account.mjs open bob --profile-name check --url https://dashboard.lazurio.ai/
# EXAMPLE_CDP_URL=http://127.0.0.1:<port>
```

Návratový kód `signin` je 0 jen tehdy, když prošel GitHub i Lazurio.
`EXAMPLE_PROFILE_IN_USE` znamená, že profil právě drží jiný Chrome: zvol
jiné `--profile-name`.
