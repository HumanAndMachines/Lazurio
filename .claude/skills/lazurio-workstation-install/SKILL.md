---
name: lazurio-workstation-install
description: Nainstaluje, opraví nebo dokončí localhost Lazurio na macOS, Linuxu či Windows včetně toolchainu, GitHub přihlášení, Organization materializace, Launchpadu a finálního Doctor gate. Použij pro novou pracovní Mašinu nebo nedokončený workstation onboarding; nepoužívej pro hosted Buddy/AI Kolega runtime ani běžný update hotového Rootu.
---

# Lazurio workstation install

## Kdy použít

Použij pro fresh instalaci, repair, resume nebo dokončení localhost Lazurio
na Mašině Kolegy. Cílem je prokázaný funkční stav, ne první diagnostický
výpis. Hosted Resident, Buddy VPS a Organization User bez lokálního footprintu
mají jiný lifecycle.

Před první mutací přečti root `AGENTS.md`,
[`manual/lazurio-root-for-agents.md`](../../../manual/lazurio-root-for-agents.md)
a pro cílovou Organizaci celý
[`manual/organization-install.md`](../../../manual/organization-install.md).
Při publikačním mandátu pro instalační vady přečti také
[`manual/github-issues.md`](../../../manual/github-issues.md).

## Postup

1. **Ukotvi Mašinu a mandát.** Read-only zjisti platformu, skutečný OS home,
   Ownera Mašiny, případnou vyšší device-management hranici, existující Root,
   nástroje a User/Machine `PATH`. Prompt musí zvlášť autorizovat instalace,
   upgrade existujících nástrojů, systémový package manager,
   Machine/system-wide `PATH`, SSH access změnu a publikaci Issues. Jedna
   kategorie se neodvozuje z jiné.
2. **Zachovej jeden Root.** Fresh target je `<home>/Lazurio`. Dnešní podporovaný
   profil je Source Root; existující ověřený Source Root smí zachovat historický
   název. Nezakládej alternativní Root, nepřesouvej source ručně a nevytvářej
   Managed profil dřív, než jej zpřístupní samotné `lazurio install`.
3. **Ukotvi fresh Source Root před Bunem.** Pokud Root chybí a
   package-managed Managed install ještě není dostupný, nainstaluj nejdřív jen
   chybějící oficiální Git a clone jediný canonical Lazurio source do
   `<home>/Lazurio`. Clone Bun nepotřebuje. Ponech primární checkout na clean
   `main` a přečti z něj exact Bun pin. Existující cizí, dirty, diverged nebo
   nejasný adresář nepřepisuj.
4. **Konverguj toolchain z oficiálních zdrojů.** Povinné capability jsou Git,
   GitHub CLI, Node.js, Codex CLI a Bun. S rozšířeným mandátem aktualizuj Git,
   GitHub CLI a Codex na aktuální oficiální stable a Node na podporované
   aktuální LTS. Bun nastav vždy na exact stabilní verzi z aktuálního clean
   `lazurio/package.json#packageManager`; upstream latest ani canary není
   autorita. Po dostupnosti exact Bunu registruj source CLI jen podporovaným
   `bun run lazurio -- cli install`. Claude Code je volitelný a kontroluje se
   jen tam, kde je instalovaný.
5. **Měň jen autorizovanou PATH vrstvu.** Výchozí mandát dovoluje User `PATH`.
   Machine/system-wide `PATH`, elevation a systémový package manager použij jen
   při jejich explicitním povolení. Přidej canonical instalační adresář, ne
   `.exe`, cache, dočasnou cestu ani worktree; zachovej nesouvisející platné
   položky a odstraň pouze prokázaný stale/shadow záznam téhož nástroje.
   Neobcházej UAC ani správu zařízení.
6. **Prokaž nový proces.** Po Windows instalaci obnov pouze process `PATH` z
   čerstvých Machine + User hodnot, aby mohla pokračovat stejná relace. Tento
   proces není acceptance: otevři nový čistý proces a ověř `bun`, `git`, `gh`,
   `node`, `codex` a po registraci `lazurio cli status --json` včetně jejich
   canonical identity.
7. **Spáruj GitHub jen jednou.** Použij
   `gh auth login --hostname github.com --git-protocol ssh --web`, nech
   Principála dokončit osobní web krok a neloguj device kód, token ani privátní
   klíč. Nový ed25519 klíč a upload jeho veřejné části proveď pouze s
   explicitním access mandátem. API login není transportní důkaz; před
   materializací musí projít exact `git ls-remote` cílového root repa a branche.
8. **Odděl ownera od Buildera.** Organization owner ověří jednorázovou GitHub
   App aktivaci přes immutable Organization ID. Běžný Builder owner gate
   neopakuje a použije `lazurio organization install <login> --role builder
   --json`. Aktuální CLI nepřijímá `--role admin`; owner/admin stav dokazuj
   živými GitHub právy a základní materializaci bez vymyšlené role. Builder
   Team readiness a owner/admin oprávnění reportuj odděleně.
9. **Opakuj jediný konvergenční tok.** Spusť `lazurio install --json`,
   `lazurio doctor --tool-updates --json`, exact Organization install a finální
   `lazurio doctor`. Required `fail`, `blocked` nebo `incomplete` v uděleném
   mandátu oprav a probe zopakuj. Warning dostane explicitní disposition; required
   nález se nevydává za hotovou instalaci.
10. **Publikuj jen autorizované instalační Issues.** Pokud prompt jmenuje exact
    repo, u každého obecného reprodukovaného problému prohledej otevřené i
    zavřené duplicity, sanitizuj username, absolutní cesty, secrets,
    Personalspace a Organization data a issue vytvoř nebo doplň pomocí body
    file. U téhož nálezu se znovu neptej. Transient nebo domněnku nepublikuj;
    issue bez dalšího mandátu nezavírej, nepřiřazuj ani neprioritizuj.
11. **Dokonči povrch.** Podporovanou CLI cestou nainstaluj desktop Launchpad,
    spusť jej pro exact Organization scope, použij vrácenou URL a ověř health
    aktivních aplikací. Port ani route neodvozuj ručně.

## Oveření

Instalace je hotová teprve tehdy, když:

- Root a CLI provenance odpovídají podporovanému profilu;
- povinné nástroje i `lazurio` fungují z nového čistého procesu a Bun odpovídá
  exact pinu;
- `lazurio install --json` je `completed`, Organization install je `current`
  nebo bezpečně `updated` a finální Doctor nemá required selhání;
- GitHub identity, role/Team gate a exact Git transport jsou reportované
  odděleně a pravdivě;
- Launchpad a aktivní aplikace prošly health kontrolou;
- každý warning má disposition a každé publikované Issue URL je v handoffu.

Handoff obsahuje matici `runtime ready` / `editing ready` / `publishing ready`,
skutečné verze a canonical cesty nástrojů, stav User/Machine `PATH`,
Organization a `mission-control/db`, Launchpad health, nevyřešené blockery a
Issue odkazy. Issue mandát nikdy sám nepovoluje source push, merge, release nebo
deploy.
