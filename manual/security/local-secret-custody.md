# Local secret custody in GEN3

GEN3 musí mít jedno standardní místo, kam patří lokální secret soubory uživatele i Organizace, aby se neopakovalo ad-hoc hledání v `Downloads`, `Desktop`, tool cache složkách nebo chatových handoffech.

## Pravidlo

Secrets a OAuth client soubory se **nikdy necommitují**. Do Gitu patří jen:

- standardní cesta,
- no-secret runbook,
- pointer na lokální umístění,
- metadata-only ověření (`present`, `mode`, `mtime`, `account/domain`, `doctor=ok`),
- nikdy hodnota secretu, tokenu, refresh tokenu, hesla ani obsah JSONu.

## Root / Buddy / user secrets

Pro secrets, které patří vlastníkovi Launchpad rootu, Buddymu nebo uživateli stroje, je custody místo owner-scoped uvnitř jeho personalspace:

```text
personalspace/<owner>_GEN3/secrets/<provider>/<scope>/<purpose>
```

Příklad pro Google OAuth Desktop client Organizace:

```text
personalspace/<owner>_GEN3/secrets/google-oauth/<domain>/client-desktop.json
```

`personalspace/<owner>_GEN3/secrets/` je gitignored v nested personalspace repu; tracked zůstávají jen manifesty/README. Secret adresáře mají mít mód `0700`, secret soubory `0600`.

## Secrets Organizace a jejích Prostředí Henry

Pro secrets, které patří konkrétnímu kolegovi nebo Prostředí Henry uvnitř konkrétní Organizace, používej organization-local private overlay:

```text
organizations/<org>/company/colleagues/<os-user>/private/secrets/<provider>/<scope>/<purpose>
```

Příklad:

```text
organizations/<Org>_GEN3/company/colleagues/<agent-user>/private/secrets/google-oauth/<domain>/client-desktop.json
```

`private/` je lokální a ignorovaný Git pravidly dané Organizace. Pokud je secret potřeba z runtime cesty nástroje, runbook ho může lokálně zkopírovat nebo symlinknout do tool-specific path, ale custody source zůstává v `private/secrets/...` nebo `personalspace/<owner>_GEN3/secrets/...`.

## Custody celé Mašiny

Credential mapy a dokumenty, na které ukazují (předávají se nástrojům jako
`machines-operate --credential-map …` nebo skriptům kitu), drží Mašina
mimo repozitáře:

```text
~/.config/lazurio/credentials/<lane>/...
~/.config/lazurio/custody/<run>/...
```

Platí pro ně stejná pravidla jako pro `private/secrets/` a
`personalspace/<owner>_GEN3/secrets/`: adresáře `0700`, soubory `0600`, do
Gitu nikdy. Netajné výstupy (logy, receipty, inventury) do custody nepatří;
patří do pracovního adresáře úlohy (`drafts/…`), aby je šlo číst.

## Hodnoty se nikdy nevypisují

Agent hodnotu z custody nikdy nevypíše do svého transcriptu: ani výstupem
příkazu, ani nástrojem Read. Custody je kořen
`~/.config/lazurio/credentials/`, `~/.config/lazurio/custody/`, každé
`**/private/secrets/` a `personalspace/<owner>/secrets/`. Veřejný klíčový
materiál uvnitř (`*.pub`, `known_hosts`) secret není.

- **Strukturu ukáže helper**, nikdy improvizovaný filtr (`jq` filtr, který
  propadne na hodnotu, byl incident z 2026-10-22):

  ```sh
  bun <Lazurio>/scripts/custody/custody-shape.mjs [--fingerprint] <soubor>...
  ```

  Vypíše cesty klíčů, typy a délky, jména `KEY=value` řádků i env bloků
  uložených v JSON stringu, PEM labely a mód souboru; hodnotu nikdy. Ukáže
  jen string, který je existující cestou, aby šlo sledovat `{"path": …}`
  pointery. `--fingerprint` přidá 8 hex znaků HMAC-SHA256 s náhodným klíčem
  jednoho běhu: stejné hodnoty v souborech jednoho běhu mají stejný
  fingerprint a nic z nich nejde zpětně dohledat. Hodnoty se tedy porovnávají
  předáním obou souborů jednomu běhu; celé soubory porovná `cmp`.
- **Hodnoty jen předávej.** Cestu dej nástroji nebo skriptu (`--credential-map
  …`, `apply.sh <lane-dir>`), hodnotu do proměnné nebo stdin nástroje, který
  ji nevypisuje, a výstup, který hodnoty obsahovat může, přesměruj do souboru
  v custody. Custody stavěj a kopíruj skriptem spuštěným podle cesty; inline
  kód (`python3 -c`, heredoc, `node -e`) nad custody je zakázaný, protože ho
  nikdo nekontroluje.
- Povolené jsou `ls`, `stat`, `test`, `chmod`, `cp`, `mv`, `mkdir`, `wc -c`,
  `shasum`, `cmp`, `grep -q/-l/-c`, `jq … > soubor` i spuštění helperu.

### Mechanismus: guard pro Claude Code

Pravidlo vynucuje PreToolUse hook `scripts/custody/custody-guard.mjs`. Odmítne
volání nástroje, které by obsah custody dostalo na stdout/stderr: čtecí
program (`cat`, `head`, `tail`, `less`, `bat`, `jq`, `yq`, `grep`, `rg`, `sed`,
`awk`, `cut`, `od`, `xxd`, `strings`, `base64`, `diff` bez `-q`, `plutil -p`,
inline interpretery, `bash -c`, `dd`, archiv nebo komprese na stdout …)
nakrmený cestou do custody, a to i přes proměnnou, `$(…)`, rouru, `xargs`,
`find -exec`, `cd` do custody, `source` se `set -x` nebo výpisem prostředí,
nebo kopii pořízenou tímtéž příkazem. Přesměrování vyhodnocuje zleva doprava
jako shell, a to zvlášť podle pravidel bashe i zsh (Claude Code na macOS
pouští příkazy v zsh, kde jeden deskriptor přesměrovaný dvakrát píše do všech
cílů a samotné `< soubor` soubor vypíše); zamítne, když by obsah vypsal
kterýkoli z nich. Inline kód a programy `awk`, `sed` nebo `jq`, které umějí psát na
stderr, musí mít přesměrovaný i stderr (`> soubor 2>&1`). Dále
Read souboru v custody a Grep v content módu nad custody, nad `~/.config`
nebo nad `~`. Zamítnutí vysvětlí důvod a ukáže helper. Výjimku nemá: žádná
proměnná ani přepínač ho nevypne, jen odebrání hooku z nastavení, což je
lidské rozhodnutí. Při vlastní chybě hook příkaz pustí (fail open), aby
nezablokoval práci agentů na Mašině.

Instalace pro Claude Code je uživatelská, protože custody je celé Mašiny a
relace začínají v různých adresářích. V `~/.claude/settings.json` přidej do
`hooks.PreToolUse` položku s matcherem `Bash|Read|Grep|Monitor` a příkazem,
který bez Bunu nebo bez skriptu nic neudělá:

```sh
B="$HOME/.bun/bin/bun"; [ -x "$B" ] || B="$(command -v bun)"; S="$HOME/Lazurio/scripts/custody/custody-guard.mjs"; [ -n "$B" ] && [ -f "$S" ] && exec "$B" "$S"; exit 0
```

Hook platí pro relace spuštěné po instalaci. Codex od verze 0.163 umí
PreToolUse hooky se stejným protokolem (`tool_name` `Bash`) v
`~/.codex/hooks.json`; každý hook musí člověk v Codexu jednou schválit
(trusted hash). Codex execpolicy pravidla (`prefix_rule`) umí jen prefix
příkazu, ne „argument v custody“, a jako guard nestačí.

### Známé limity

Guard chrání před nehodou, není to sandbox:

- skript spuštěný podle cesty a neznámý program jsou důvěryhodné nástroje;
  co vypíšou, guard neví;
- soubor zapsaný z custody dřívějším příkazem je pro pozdější příkaz obyčejný
  soubor (stejný příkaz ho hlídá);
- proměnné a aliasy z dřívějších volání guard nevidí; z prostředí bere jen
  `TMPDIR`, `XDG_*` a `USER` (jiné proměnné můžou držet tokeny a hodnota by se
  dostala do důvodu zamítnutí); cestu poskládanou až za běhu nepozná;
- custody na vzdáleném hostu hlídá jen v textu vzdáleného příkazu;
- inline kód nad custody je zakázaný celý, i když by vypsal jen klíče: na to
  je helper;
- `jq … > soubor` zůstává povolené, ale chybová hláška jq o typu hodnoty umí na
  stderr ocitovat zhruba prvních 10 znaků hodnoty; při zápisu custody přes jq
  proto přesměruj i stderr (`2>/dev/null` nebo do souboru v custody);
- čtení přes `find` nebo `grep -r` z adresáře, který custody obsahuje (třeba
  kořen Organizace), je zakázané celé; `rg` a nástroj Grep custody ignorovanou
  Gitem přeskočí;
- tool runtime cesty (`~/.config/gh`, `~/.codex/auth.json`,
  `~/.claude/settings.json`) custody nejsou a guard je nehlídá.

## Tool runtime paths are not custody paths

Tool-specific cesty jako:

```text
~/.config/gogcli/client-desktop.json
~/.local/share/gog-oauth-setup/google-oauth-client-desktop.json
```

jsou runtime/cache/adaptér cesty. Nejsou zdroj pravdy pro držení secretů. Runbook musí umět z custody source připravit runtime path bez toho, aby secret tisknul nebo commitoval.

## User-action boundary

Když je potřeba OAuth consent nebo zadání hesla:

1. Agent připraví lokální `.command` / wizard / aplikaci na cílovém Macu.
2. Uživatel dokončí pouze lokální krok na cílové obrazovce.
3. Uživatel neposílá heslo, kód, token, OAuth URL ani JSON do chatu.
4. Agent potom čte jen metadata-only výsledek a funkční smoke.

## Metadata-only verification

Pro hostovaný servis navazuje
[návrh standardu servisní připravenosti](../agent-service-readiness.md):
přítomnost credentialu není důkaz funkčního přístupu. Onboarding má ověřit
neinteraktivní použití, rotaci, revokaci a nezávislou obnovu v owner scope.

Minimální closeout pro OAuth/Gmail gate:

- expected account/domain match,
- `auth doctor --check` status `ok`,
- read-only functional smoke, například `gmail labels list` s `rc=0`,
- result file mode `0600`,
- keyring/env file mode `0600`,
- `no_secret_values_printed=true`,
- `result_contains_secret_values=false`.

Strukturu custody souboru pro takový closeout ukáže
`scripts/custody/custody-shape.mjs` (sekce „Hodnoty se nikdy nevypisují“).

## Anti-patterns

- Hledat secrets v `Downloads` během kritického unblocku.
- Posílat OAuth client JSON, token, heslo nebo URL do chatu.
- Commitovat reálné secret JSONy, `.env`, service-account keys nebo token stores.
- Nechat tool-specific runtime path být jediným místem, kde secret existuje.
- Plést OAuth Desktop client JSON s cílovým uživatelským účtem; účet se vybírá při consentu a musí odpovídat organizačnímu invariantnímu účtu.
