# Organization install pro Agenty

Tento postup přidá do existujícího Lazurio Rootu už aktivní GitHub Organization,
ke které má přihlášený uživatel read access. Je stejný pro veřejnou referenční,
privátní klientskou i vlastní Organization; CLI nezná žádnou jmennou výjimku.

## Předpoklady

- produkční nebo development-linked příkaz `lazurio` je v `PATH`;
- Git, Bun a GitHub CLI jsou dostupné;
- `gh auth status --hostname github.com` potvrzuje správný účet;
- kanonický Lazurio Root `<home>/Lazurio` už prošel `lazurio install` a má
  skutečnou složku `organizations/`;
- Organization root repo `<login>/<login>_GEN3` existuje na `main`, obsahuje
  validní Forge binding a uživatel jej může číst.

Příkaz je local-only. Nikdy nevytváří nebo nemění GitHub repo, GitHub App grant,
Team membership, branch rules, visibility, port ani commit. K založení remote
Organization slouží oddělený explicitní activation postup.

## Konvergentní postup

```sh
lazurio organization install <github-login> --json
lazurio organization install <github-login> --json
lazurio doctor
```

CLI Root nevybírá ani neukládá jako další konfiguraci. Produkční instalace
vždy používá `~/Lazurio` na macOS/Linuxu a `%USERPROFILE%\\Lazurio` na
Windows. Tím mají lidé i Agenti jednu předvídatelnou cestu a absolutní cesta
současně nese uživatele Mašiny. `--root` proto tato operace nepřijímá.

První běh materializuje exact Organization root do
`organizations/<CanonicalLogin>_GEN3` a přes běžný update reconciler doplní
dostupné deklarované Moduly. Druhý běh musí být `current`, pokud se mezitím
nezměnil remote nebo lokální stav. Agent rozhoduje podle stabilních polí
`state`, `target.reason` a vnořeného update reportu, ne podle lokalizované věty.

Veřejné stavy jsou pouze:

- `current` — root i dostupná deklarovaná hierarchie už odpovídají `main`;
- `updated` — alespoň jeden bezpečný checkout byl doplněn nebo fast-forwardnut;
- `blocked` — alespoň jedna část potřebuje přístup nebo bezpečnou nápravu.

`blocked` neznamená rollback už ověřených checkoutů. Typickým případem je
private Modul, který přihlášený uživatel nevidí: dostupné Moduly zůstanou
nainstalované a report označí jen nedostupný slot. Po opravení GitHub accessu
Agent spustí stejný příkaz znovu.

## Kdy Agent nesmí stav opravovat odhadem

CLI failne před přepsáním dat, když cílová cesta:

- je symlink/junction alias, soubor nebo case-insensitive kolize;
- obsahuje dirty tracked či untracked změny;
- používá jiný GitHub origin nebo cizí Forge binding;
- nemá čistý checkout deklarované default branche;
- po fetchi obsahuje ahead/diverged historii nebo neplatný manifest.

V takovém případě zachovej všechny commity a soubory, pracuj v task worktree a
oprav přesnou příčinu. Nepoužívej `reset --hard`, force push ani ruční přesun
cizího checkoutu. Login je jen locator: immutable Organization a repository ID
se ověřují před klonem, ve stagingu i znovu před atomickým přesunem, takže rename
race nebo znovupoužitý namespace nemůže tiše nainstalovat cizí root.

## Handoff

Do PR nebo instalačního reportu uveď exact CLI verzi, GitHub login, immutable
ID z JSON reportu, výsledný target, celkový stav a všechny blocked repo reasons.
Secrets, provider stderr ani obsah jiné Organization do reportu nekopíruj.
