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
  skutečné rozhodnutí, případně Modul nesplňuje standard
  (`reason: module_standard_nonconformant`). Nálezy standardu CLI nikdy
  neopravuje; Agent postupuje podle `issues[].action`, ne hádá.

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
- `details` jsou konkrétní nálezy s cestou relativní ke kořeni Modulu;
  `action` říká, co má Agent udělat.
- Kontroly jsou read-only a levné: čtou soubory, JSON a zdrojáky App (bez
  `node_modules`, `dist` a testů), jednou volají `git ls-files` kvůli
  commitnutému lockfilu. Nikdy nespouštějí skripty Modulu ani síť; `bun run
  check` a `bun test` spouští CI Modulu.
- `standard` je `null`, když setup skončí dřív na samotném Module kontraktu
  (například chybí pool nebo slot). Nejdřív oprav kontrakt.
- `runtime` zůstává vyplněný, kdykoli je Module kontrakt platný, i když
  standard hlásí nálezy: Launchpad nekonformní Modul do cutoveru spouští
  s varováním (kapitola 10 standardu).

**Standard CLI jen měří.** `--apply` zapisuje výhradně Module kontrakt
(`lazurio.module.json` a runtime deklaraci App z kapitol výše); žádný nález
`MS-01`–`MS-13` se nikdy nestane zápisem. Převod Modulu na standard je práce
Agenta v PR Modulu podle skillu `lazurio-module-standard`: Agent zná záměr
standardu, cílový stav i to, jak si výsledek ověřit, a tenhle report je jeho
kontrola hotové práce, ne nástroj, který převod udělá za něj. Automatická
oprava by musela dokazovat vlastní úplnost a byla by křehčí než úprava, kterou
nahrazuje.

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
