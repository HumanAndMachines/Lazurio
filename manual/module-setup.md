# Module setup pro Agenty

Tento postup je veřejný vstup pro nové i privátní Organizace, včetně těch, ke
kterým maintaineři Lazuria nemají přístup. Autoritou je vždy
`lazurio.module.json` v kořeni Modulu a `lazurio.runtime` v deklarované App.
Manuál ani Organization-specific Doctor nevlastní druhé schéma, port registry
nebo migrační algoritmus.

## Bezpečný pracovní cyklus

Pracuj v task worktree daného Module repozitáře. Primární `main` checkout
nepoužívej pro Draft. Package-managed i development-linked CLI mají stejný
příkaz:

```sh
lazurio module setup <module-root> --root <lazurio-root>
```

`<module-root>` smí být přesný kanonický slot pro read-only kontrolu nebo
task worktree téhož lokálního Git repozitáře pro Draft a `--apply`. Lazurio
worktree přijme jen podle shodného Git common-dir s checkoutem deklarovaným
v Organization slotu. Shodný název nebo remote URL nestačí a cizí kopie se
nikdy nevydá za Modul.

První běh je vždy read-only. Výsledek je právě jeden ze čtyř stavů:

- `current` — kontrakt je platný, Modul splňuje všech 13 kontrol Lazurio
  Module Standardu a nic se nemění;
- `actionable` — CLI připravilo přesný plán, ale nic nezapsalo;
- `completed` — `--apply` zapsal plán a celý stav znovu ověřil;
- `action_required` — před zápisem chybí přístup, Organization deklarace nebo
  skutečné rozhodnutí, případně Modul nesplňuje standard v bodě, který CLI
  mechanicky neopraví (`reason: module_standard_nonconformant`). Agent má
  postupovat podle `issues[].action`, ne hádat.

Po `actionable` spusť stejný příkaz s `--apply`, zkontroluj Git diff a spusť
jej ještě jednou bez `--apply`. Cílem je `current`; zbývající
`module_standard_nonconformant` nálezy oprav v Modulu podle `issues[].action`
a příkaz opakuj. Teprve potom commitni změny a otevři PR podle pravidel
Organizace.

```sh
lazurio module setup <module-root> --root <lazurio-root> --apply
lazurio module setup <module-root> --root <lazurio-root> --json
git diff --check
```

Příkaz je konvergentní: když jej přeruší pád Mašiny mezi vytvořením
`lazurio.module.json` a úpravou App package, tentýž příkaz znovu odvodí
zbývající krok. Lazurio kvůli tomu nemá vlastní workflow databázi ani daemon.
Každý zápis je připnutý k ověřené fyzické složce. Když se checkout během
`--apply` změní, příkaz skončí `action_required` a cizí cestu nepřepíše.

## Migrace existující App

Pro podporovanou single-listener legacy App není potřeba přepisovat JSON
ručně. CLI zachová existující port, odstraní `companyascode.app`, vytvoří
module-owned lease a v App nechá jen reference na lease:

```sh
lazurio module setup ./workspace/moje-aplikace --root /cesta/k/Lazurio
```

Víceprocesový runtime, nejednoznačné listenery, port drift nebo custom source,
který bounded migrátor neumí, skončí `action_required`. Správná oprava je
reviewovaný explicitní `lazurio.module.json` se všemi listenery a portable App
runtime; nerozšiřuj migrátor na obecný JavaScript/TypeScript analyzátor.

## Nový Modul

Úplně nový Modul zakládej příkazem `lazurio module create` z task worktree
root repa Organizace ([module-create.md](module-create.md)): vytvoří slot,
lease, App podle stacku, lockfile a první commit a hned ho změří stejnými
kontrolami jako `lazurio module setup`. Postupy níže platí pro repozitář,
který už slot má a jen dostává Module kontrakt.

## Nový Modul bez aplikace

Repozitář musí být nejdřív deklarovaný jako aktivní `module_slots` položka
owning Organizace. Setup nevytváří GitHub repo, Team, slot ani přístupy.

```sh
lazurio module setup ./workspace/data-model --no-app --root /cesta/k/Lazurio
lazurio module setup ./workspace/data-model --no-app --root /cesta/k/Lazurio --apply
```

Výsledkem je explicitní `apps: []`, `tcp_port_policy.mode: none` a žádný port.
Datový mount jako `workspace/<module>/db` není samostatný Modul ani App.

## Nový Modul s jednou aplikací

Nejdřív vytvoř skutečný App `package.json` a jeho dev script. Identitu App
zadávej explicitně; CLI ji nehádá z názvu adresáře nebo package:

```sh
lazurio module setup ./workspace/portal \
  --app-package app/v1/package.json \
  --app-id acme-portal-v1 \
  --title "Portal" \
  --dev-script dev \
  --health-path /health \
  --surface internal \
  --tags portal,internal \
  --root /cesta/k/Lazurio
```

CLI vezme další volný port z `company.gen3.json#module_port_pool`, vytvoří
single lease `main`, zapíše explicitní `apps/default_app` a App runtime, který
na lease pouze odkazuje. App musí skutečně poslouchat na Launchpadem
injektovaném `HOST`/`PORT`; hardcoded fallback nesmí znovu vytvořit portovou
autoritu ve source.

## Zachování existujícího stabilního portu

Když deklarovaný existující Modul nemá manifest ani legacy metadata, může
Agent jednorázově převzít doložený stabilní port:

```sh
lazurio module setup ./workspace/portal \
  --app-package app/v1/package.json \
  --app-id acme-portal-v1 \
  --title "Portal" \
  --dev-script dev \
  --adopt-port 5306 \
  --root /cesta/k/Lazurio
```

`--adopt-port` je vědomé tvrzení operátora. Report jej ponechá viditelný pro
review, zkontroluje rozsah a kolizi s Module leases stejné Organizace, ale
nevymýšlí historickou provenienci čísla. Překryv s jinou Organizací zůstává
vědomý runtime takeover kontrakt; není důvodem k přečíslování stabilního portu.
Existující lease CLI nikdy nemění, ani uvnitř poolu, ani mimo něj. Lease mimo
pool je nález standardu (`MS-01`) s navrženým volným portem poolu; přesun je
ruční úprava manifestu v PR Modulu (kapitola níže).

## Co musí připravit Organization Admin

`action_required` je očekávaný výsledek, když:

- slot je stále `planned_slot` nebo chybí v `modules.manifest.json`;
- App Modul potřebuje port, ale Organizace nemá aktivní `module_port_pool`;
- cesta není přesný slot ani prokazatelný Git worktree jeho kanonického
  Module checkoutu, případně vede přes symlink;
- port už vlastní jiný Modul;
- manifest nebo runtime mají cizí identitu či nejednoznačný custom stav.

Admin opraví pouze owning Organization deklaraci a Agent příkaz zopakuje.
Stabilní porty jiných Modulů se kvůli pohodlnější alokaci neposouvají.

## Konformance se standardem (MS-01–MS-13)

Pravidla drží [Lazurio Module Standard](module-standard.md) (decision 0171);
tahle kapitola popisuje jen, jak je `lazurio module setup` měří. Každý report
nese sekci `standard` se stabilním seznamem třinácti kontrol v pořadí
`MS-01`…`MS-13`:

```json
"standard": {
  "checks": [
    {
      "id": "MS-01",
      "status": "fail",
      "summary": "lazurio.module.json platné, id odpovídá slotu, lease v poolu Organizace, pooly disjunktní",
      "details": ["lease main 23500 leží mimo pool 24000-24099; volný port poolu: 24001"],
      "action": "Přepiš port leasu v lazurio.module.json na navržený volný port poolu …"
    }
  ]
}
```

- `status` je `pass`, `fail`, nebo `warn`. `warn` znamená fakt, který kontrola
  nerozhodne (Modul není Git checkout, tsconfig rozšiřuje nenainstalovaný
  preset, Python App). `current` vyžaduje u všech třinácti `pass`.
- Bun App klíč `lazurio.preparation.runtime` vynechává (chybí = bun): čtečka
  LazurioPlatform dnes neznámá pole odmítá, dokud vydání Platformy klíč
  nečte (DEV-6634 W0-5). Explicitní `runtime: bun` je proto `fail` `MS-04`.
- Python App (`runtime: uv` nebo `pyproject.toml` vedle App) nese deklaraci
  v `app/v<N>/pyproject.toml` `[tool.lazurio]`. Dokud ji Core nečte, `MS-04`
  hlásí `warn`; viditelná deklarace s `runtime: uv` bez `uv_version` je `fail`.
- `MS-07` hlásí `.env*` na start cestě, `dotenv` a každé volání Bun ve
  skriptech start cesty (`dev` a skripty, které spouští) bez `--no-env-file`
  před vstupem (Bun jinak `.env`, `.env.local` a `.env.<NODE_ENV>` načte
  sám; flag za souborem nebo jménem skriptu dostane skript jako argument)
  nebo s `--env-file` (ten Bun načte i s `--no-env-file`). Volby čte mezi
  `bun` a vstupem i mezi `bun run` a jménem skriptu. Náhradou
  za `.env` u tajemství je deklarace `lazurio.runtime.secrets`: Launchpad
  hodnoty předá z trezoru Environmentu (standard kap. 4.3, decision 0177).
  Tvar deklarace (jména `^[A-Z][A-Z0-9_]*$`, neprázdné, bez duplicit)
  hlídá Core runtime kontrakt; vadná deklarace končí `runtime_contract_invalid`.
  Platná deklarace je `warn` `MS-03`, dokud ji vydání Launchpadu nečte.
- `MS-06` hlásí čtení `LAZURIO_RUNTIME_SIBLING_<SLUG>_ORIGIN` (adresa API
  sousedního Modulu, standard kap. 4.2) pro souseda, kterého App nedeklaruje
  v `lazurio.runtime.required_module_slots` jako slot Modulu
  `workspace/<slug>`; datový mount `workspace/<slug>/db` adresu nedává.
  Počítá jen čtení z prostředí: `process.env`, `Bun.env` a `import.meta.env`
  (tečkou, v hranatých závorkách i destrukturováním) ve zdrojích JS/TS/Astro
  a `os.environ[...]`, `os.environ.get(...)`, `os.getenv(...)` v Pythonu
  (mimo testy). Komentáře (i HTML a JSX komentáře v Astro šabloně) a pouhou
  zmínku jména v textu nebo hlášce nepočítá; jméno předané přes konstantu
  nebo skládané za běhu nevidí. Řetězce a text šablony nemaskuje: text,
  který čtení doslova opisuje (například `"process.env.<JMÉNO>"` v hlášce
  nebo v markupu Astro), hlásí jako čtení. Nález opravíš přeformulováním
  textu nebo deklarací souseda.
- `details` jsou konkrétní nálezy s cestou relativní ke kořeni Modulu;
  `action` říká, co udělat; `repairs` jsou mechanické opravy, které zapíše
  `--apply`.
- Kontroly jsou read-only a levné: čtou soubory, JSON a zdrojáky App (bez
  `node_modules`, `dist` a testů), jednou volají `git ls-files` kvůli
  commitnutému lockfilu. Nikdy nespouštějí skripty Modulu ani síť; `bun run
  check` a `bun test` spouští CI Modulu.
- `MS-09` posuzuje importy i relativní cesty zapsané ve zdrojích
  (`import.meta.glob`, `resolve(import.meta.dirname, "…")`,
  `new URL("…", import.meta.url)`) vůči adresáři souboru; cesty jen
  v komentářích nepočítá (zdroj nejdřív projde transpilerem Bunu, u `.astro`
  jen frontmatter; zdroj, který transpiler odmítne, měří tak, jak je) a cestu
  začínající `./` normalizuje. Cesta, která je
  prvním argumentem volání bez kotvy na soubor (`readFile("../…")`,
  `resolve("../…")`), se posuzuje i vůči kořeni App, protože ji takové API
  řeší vůči pracovnímu adresáři procesu. Cesta do `../<slug>/` projde jen
  tehdy, když App souseda deklaruje v `lazurio.runtime.required_module_slots`
  a čte jeho `db/` nebo `generated/` (decision 0176). Cesty skládané až za
  běhu nebo uložené do proměnné kontrola nevidí. Posouzení vůči kořeni App
  je heuristika nad textem zdroje, ne parser: volání zapsané uvnitř
  šablonového řetězce (`${…}`) nemusí rozpoznat a takové čtení projde.
  `MS-09` je měření, ne hranice; hranici drží standard a review.
- `standard` je `null`, když setup skončí dřív na samotném Module kontraktu
  (například chybí pool nebo slot). Nejdřív oprav kontrakt.
- `runtime` zůstává vyplněný, kdykoli je Module kontrakt platný, i když
  standard hlásí nálezy: Launchpad nekonformní Modul do cutoveru spouští
  s varováním (kapitola 10 standardu).

`--apply` jen doplňuje to, co v Modulu chybí a jde zapsat jednoznačně
(decision 0173: skript smí přidat novou věc; přestavbu existující struktury
dělá Agent). Nic existujícího nepřepisuje ani nepřesouvá:

| Kontrola | Oprava | Kdy se neprovede |
| --- | --- | --- |
| `MS-02` | doplní chybějící `packageManager` na přesný Bun z `lazurio/package.json` | jiná existující hodnota (jen nález) |
| `MS-04` | doplní skeleton `lazurio.preparation` (`schema_version`, `owner_package` = App, `check_script` jen když existuje skript `check:prepared`; klíč `runtime` nezapisuje, chybí = bun) | existující deklarace se nikdy nepřepisuje: explicitně zapsané `runtime: bun` je jen nález; App bez `lazurio.runtime`, Python App, App v kořeni Modulu místo `app/v<N>/`; `prepare_script`/`check_script` s npm lifecycle jménem (`prepare`, `preprepare`, `postprepare`, `install`, `preinstall`, `postinstall`, `prepublish`, `prepublishOnly`, `prepack`, `postpack`, `dependencies`) je jen nález, protože je `bun install` spouští sám; stejně jméno mimo gramatiku čtečky Platformy `^[A-Za-z][A-Za-z0-9:_-]*$` (pravidla čte ze schématu); přejmenuj je na `prepare:app` / `check:prepared` |

Chybějící `check`/`test` skripty, lockfile, tsconfig, importy, `.env` ani
víceprocesový `dev` skript CLI nevymýšlí; zůstávají nálezem s `action`.

**Lease mimo pool CLI nepřesouvá.** `MS-01` nahlásí lease a nejnižší volný port
poolu (`volný port poolu: N`; víc leasů jednoho Modulu dostane různé porty).
Návrh platí pro stav checkoutu v okamžiku běhu: při převodu více Modulů jedné
Organizace přiděluj porty postupně, kolizi dvou leasů hlásí `MS-01`. Přesun dělá Agent
v PR Modulu ve třech krocích: přepíše `port` leasu v `lazurio.module.json`,
odstraní port zapsaný natvrdo, pokud ho hlásí `MS-06`, a doloží start App na
novém portu (`lazurio module start`, URL odpoví, `lazurio module stop`). Port
žije jen v leasu a App ho čte z `LAZURIO_RUNTIME_LISTENER_<ID>_PORT`, takže
jiné místo k úpravě konformní Modul nemá; důkazem je skutečný start, ne
prohledávání souborů.

Root doctor má navíc kontrolu `module_standard.port_pools`: napříč
namountovanými Organizacemi hlásí překryv poolů, cross-Organization kolize
leasů, leasy mimo pool a Organizace bez poolu. Do cutoveru W3 je to
`warn`; centrální registr portů nevzniká.

## Exit kódy pro Agenty a automatizaci

| Exit | Význam |
| --- | --- |
| `0` | `current` nebo reverified `completed` |
| `1` | read-only `actionable` plán; pro zápis je potřeba `--apply` |
| `2` | `action_required`; před zápisem je nutná přesná náprava |
| `3` | chybná syntaxe nebo nepoužitelný runtime/Root |

Automatizace rozhoduje podle `status`, `reason` a `issues[].code` v `--json`,
nikoli podle lokalizované věty. Na macOS, Linuxu i Windows se používá stejný
argumentový kontrakt; PowerShell nevyžaduje separátní migrátor.

Paralelní Drafty nejsou port registry. Lock serializuje okamžik alokace na
jedné Mašině, ale nepředstírá, že vidí nepublikované worktrees jiných Agentů.
Kolizi proto musí před merge znovu zachytit Organization Doctor a review.
