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

- `current` — kontrakt je platný, nic se nemění;
- `actionable` — CLI připravilo přesný plán, ale nic nezapsalo;
- `completed` — `--apply` zapsal plán a celý stav znovu ověřil;
- `action_required` — před zápisem chybí přístup, Organization deklarace nebo
  skutečné rozhodnutí. Agent má postupovat podle `issues[].action`, ne hádat.

Po `actionable` spusť stejný příkaz s `--apply`, zkontroluj Git diff a spusť
jej ještě jednou bez `--apply`. Poslední běh musí být `current`. Teprve potom
commitni změny a otevři PR podle pravidel Organizace.

```sh
lazurio module setup <module-root> --root <lazurio-root> --apply
lazurio module setup <module-root> --root <lazurio-root> --json
git diff --check
```

Příkaz je konvergentní: když jej přeruší pád Mašiny mezi vytvořením
`lazurio.module.json` a úpravou App package, tentýž příkaz znovu odvodí
zbývající krok. Lazurio kvůli tomu nemá vlastní workflow databázi ani daemon.

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
Existující platný lease se automaticky nemění.

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
