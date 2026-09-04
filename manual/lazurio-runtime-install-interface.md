# Immutable Lazurio runtime a mutable working root

Launchpad a `lazurio update` mají jednu závaznou runtime hranici. Běžící kód
nesmí pocházet z Git checkoutu, který má update změnit.

## Dvě fyzicky oddělené cesty

- `LAZURIO_RUNTIME_ROOT` je read-only, non-Git obsah exact-digest Lazurio
  artefaktu. Hosted doporučená cesta je `/opt/lazurio-runtime`.
- `WORKSPACE_ROOT` je pracovní Lazurio Root s mutable mounty. Hosted profil jej
  generuje jako non-Git a doporučená cesta je `/home/builder/Lazurio`; na běžné
  mašině je fresh/Managed target vždy přesně `<home>/Lazurio`
  (`~/Lazurio` na macOS/Linuxu, `%USERPROFILE%\Lazurio` na Windows). Dnešní
  podporovaný Source profil používá ověřený existující checkout přímo v home a
  smí do migrace zachovat historický název složky. Budoucí Managed profil
  používá canonical generovaný non-Git Root. Picker ani persisted
  root selection nevzniká. Volitelný source checkout po Managed migraci patří
  do `<home>/Lazurio/development/Lazurio`.

Runtime verze se odvozuje z `lazurio.resident.json` a identity instalovaného
artefaktu. Managed Root se odvozuje z jeho generovaného manifestu; Source Root
z ověřeného Lazurio Git checkoutu. Stav jednotlivých Git mountů se v obou
profilech čte z jejich vlastních checkoutů. Source HEAD se nikdy nevydává za
verzi package-managed nebo hosted Launchpad runtime.

## Exact artefakt

Z clean reviewovaného Lazurio source commitu se sestaví existujícím
deterministickým builderem:

```sh
bun distribution/build.mjs \
  --profile workspace \
  --target linux-x64 \
  --version <release-version> \
  --channel stable
```

Výstupem je `lazurio-resident-workspace-*.tar`, `.sha256` sidecar a rozbalený
artifact root. Manifest uvnitř nese exact source commit, target, profil
`workspace` a digest každého payload souboru. Build odmítne dirty source,
secrets, `.git`, worktrees, Personalspace, Organization data i `node_modules`.

Image/release pipeline před instalací ověří sidecar i manifest a zkopíruje
obsah artifact rootu do nové immutable vrstvy. Iotor může tuto vrstvu připnout
exact image digestem a namountovat ji read-only jako `/opt/lazurio-runtime`.
Runtime nemá self-update službu a nevytváří druhý kontejner ani druhou službu.

Lokální `lazurio launchpad install` je od toho oddělený desktopový krok: pouze
dispatchuje existující macOS nebo Windows instalátor uživatelského launcheru,
nemění Git checkout ani immutable runtime a nezavádí další lifecycle autoritu.
Na Windows veřejný CLI vstup instaluje jen spolehlivý Start Menu shortcut bez
Taskbar pinu. Jeho stabilní bootstrap při každém spuštění sestaví process
`PATH` z právě uložených Machine + User hodnot; neukládá vlastní Bun locator a
nemění persistentní environment.
Start Menu-only je bezpečný default i při přímém spuštění rootového PowerShell
instalátoru. Taskbar variantu musí volající vyžádat explicitně přepínačem
`-IncludeTaskbar`; tím výsledek nezávisí na tom, zda vyšší CLI vrstva správně
předala negativní přepínač `-StartMenuOnly`.

Source checkout zpřístupní samotné CLI explicitním `lazurio cli install`
přes standardní Bun global link. Tento per-user krok neupravuje shell/Windows
PATH konfiguraci, nevytváří shim ani state store a nikdy není součástí
`lazurio update`. Resident package nese kompatibilní `bin` metadata, ale prostý
link na symlinkovaný `active` není update-safe: Bun připne fyzický version
realpath. Budoucí Resident activation proto musí active switch, relink,
identity verification a rollback provést jako jednu samostatnou transakci.

Pro localhost source, npm CLI a jeho CI je jedinou autoritou exact testovaného
Bun runtime `package.json#packageManager`. `setup-bun`, Install Core i Doctor
čtou stejnou hodnotu; novější patch se nestává podporovaným automaticky.
Nesoulad pouze vrátí strojově čitelný nález a návod pro Agenta. Změna
externího Bunu vyžaduje explicitní souhlas a standardní postup zjištěného
instalačního mechanismu; není součástí Git-only `lazurio update`.
Immutable Resident/Buddy artefakty mají oddělené profilové toolchain piny,
protože jejich upgrade a rollback patří vlastnímu artefaktovému lifecycle.

Troubleshooting vývojové mašiny používá explicitní
`lazurio doctor --tool-updates`. Běžný Doctor tím nezískává skrytou síťovou
závislost: teprve přepínač načte oficiální stabilní release metadata pro Git,
GitHub CLI, Codex dostupný v `PATH` a volitelně nainstalovaný Claude Code.
Nedostupný Codex je warning; chybějící Claude je neutrální. Výsledek je pouze
advisory. `update_available` instruuje Agenta, aby požádal Principála o souhlas;
samotný Doctor nikdy nespouští updater ani package manager. Neověřitelná
aktuálnost zůstává `warn`, ne falešné `ok`. Bun do obecného latest-release
porovnání nevstupuje — jeho localhost autoritou zůstává exact pin výše.

## Launchpad process interface

Supervisor ve stejném workspace kontejneru nastaví:

```sh
export LAZURIO_RUNTIME_ROOT=/opt/lazurio-runtime
export LAZURIO_LAUNCHPAD_STATE_ROOT=/home/builder/.local/state/lazurio/launchpad
export WORKSPACE_ROOT=/home/builder/Lazurio
exec bun "$LAZURIO_RUNTIME_ROOT/launchpad/src/server-launcher.mjs" \
  --root "$WORKSPACE_ROOT"
```

Launcher zachová exact Bun runtime a všechny argumenty Serveru. Na macOS jej
spustí přes dočasný hardlink pojmenovaný `Lazurio Launchpad`, aby standardní
listener discovery zobrazila přesný produktový název. Na Linuxu použije
dočasný symlink se stejným názvem; linuxový `comm` jej ve spotřebitelích typu
T3 Code zkrátí na přijaté `Lazurio Launchp`. Při nedostupném aliasu nebo na
Windows bezpečně použije kanonický Bun executable. Locator, lifetime lease a
samotný Server dál vlastní stávající runtime kontrakt.

`--root` má přednost před `WORKSPACE_ROOT`. Server při startu ověří, že
`LAZURIO_RUNTIME_ROOT` přesně odpovídá cestě, ze které byl načten. Update před
první Git mutací ověří, že runtime neleží uvnitř working rootu. Překryv vrátí
`blocked/runtime_not_isolated`; detached working checkout se proto nesmí
odpinovat, dokud není tento runtime artefakt skutečně nasazený.

Hosted profil navíc vyžaduje absolutní `LAZURIO_LAUNCHPAD_STATE_ROOT` mimo
immutable runtime i mutable working root. Launchpad do této perzistentní
builder-owned cesty ukládá pouze svůj provozní stav, ownership a source evidence
právě managed procesů, lease a aplikační logy. Tento záznam není lifecycle
intent: požadovaná hosted množina se po každém startu znovu odvodí z Teamu a
manifestů Modulů. Lokální profil bez této proměnné zachovává dosavadní umístění
pod source Launchpadu, takže localhost workflow se nemění.

Lokální krátký příkaz `lazurio update` si pro jeden běh vytvoří úplný dočasný
bundle enginu mimo working root a po skončení jej odstraní. Dlouho běžící
Launchpad tuto výjimku nepoužívá: musí vždy běžet z instalovaného runtime.

## Update a rollout

Explicitní Launchpad `Synchronizovat`, `/api/update`, legacy pull adaptéry i
CLI volají stejný sekvenční engine. První render používá jen GET lokálního
snapshotu bez fetch/mutace. Runtime release a working checkout update jsou dvě
oddělené operace:

1. image/release pipeline instaluje nový immutable runtime artefakt;
2. `lazurio update` v dnešním Source profilu fast-forwarduje Source Root; po
   Managed migraci aktualizuje canonical development checkout pouze tehdy,
   když existuje a je aktivní source provenance. V každém profilu dál
   reconciliuje Organization Rooty → namountovaná org-level repa → Workspace
   Moduly;
3. Productionspace, Personalspace, worktrees a root-space repository-db
   zůstávají mimo obecný update engine.

Nevalidní Organization nebo module slot není totéž co nedostupný inventář.
Engine vrací strukturovaný scoped issue, vadný slot vyřadí z discovery i Git
akcí a pokračuje se zdravými Organizacemi a moduly. Po změně Organization
manifestu navíc před materializací hledá přes stabilní `lazurio.module.json`
identitu starý checkout: jedna shoda se stane karanténou s Agent repair akcí,
více shod nebo současná stará a cílová cesta je ambiguity. Ani jeden stav
nesmí vytvořit duplicitní clone. Stejný přechodový no-clone guard zachová
jakýkoli počáteční scoped issue stejného stabilního modulu; case-only stará
cesta se bezpečně sváže se skutečným contained entry a nečitelná známá cesta
se nikdy neinterpretuje jako absence.

Jediná compatibility výjimka odděluje in-place Git update od runtime a
relokační autority: běžný Git checkout přesně na deklarované canonical cestě,
kterému pouze chybí `lazurio.module.json`, zůstane v Git inventáři. Standardní
origin/main/history/dirty guardy jej tak mohou fast-forwardnout na reviewovaný
commit, který marker publikuje. Bez markeru se dál nespouští jako App a nesmí
autorizovat přesun; markerless checkout na jiné cestě zůstává v karanténě a
blokuje duplicitní clone.

Rename/transfer oprava nepatří do obecného `Synchronizovat`. Agent spustí
check-only `lazurio repair module-location --org <org> --module <slug>`, zkontroluje
vrácený plán a teprve `--apply --expect <fingerprint>` dovolí CLI pod update
lockem změnit origin a parent directory. Nejasné identity a Git práce zůstávají
Agentovu úsudku; bezpečnou mechaniku, readback a rollback vlastní CLI. Úspěch
dokončí další idempotentní `lazurio update`.

Repair plán přijímá oba Organization manifesty jako mutační autoritu jen z
Organization rootu, který je samostatný clean `main` s přesnou shodou `HEAD`,
lokálního `main` a cached `origin/main`. Právě jeden root `origin` musí
odpovídat canonical repository a `company.gen3.json` i
`modules.manifest.json` musí být běžné trackované bloby stejného `HEAD`;
stejný published-blob důkaz platí pro Module `lazurio.module.json`. Lokální
Draft, ignored/untracked autoritativní JSON, stale root nebo konfliktní či
malformed repository/branch aliasy zůstanou fail-closed před target fetchem,
změnou `origin` i filesystem relokací. Root autorita zahrnuje i
`forge_binding` a `governance.default_branch`; immutable binding, legacy
lokátory, GitHub owner a main se nesmějí rozcházet. Aktivní `governance` musí
být objekt a explicitní `governance.access_authority` musí být přesně
`github`; nepřítomné legacy pole se neinterpretuje jako druhá autorita.
Nasazené Organization rooty používají přesné
`organization_generation: "gen3"`; budoucí explicitní `schema_version` má
přednost a musí odpovídat podporované verzi. V obou případech repair navíc
vyžaduje právě jednu shodnou stable-slug deklaraci v obou publikovaných
manifestech, takže compatibility vstup neoslabuje path, remote, owner ani
branch důkaz.

No-clone důkaz je odvozený z každého přímého Git checkoutu s neověřitelným
markerem, ne pouze z adresáře shodného se stable slugem. Proto přežije čerstvý
inventory scan i restart po manifest cutoveru a skutečně volný canonical
target zůstane blokovaný. Přesný markerovaný checkout nebo existující běžný
legacy target zdravého sourozence má před generickým nepřiřazeným suspectem
přednost, takže jedna nejasná složka neshodí ostatní použitelné moduly.

Guarded repair je omezený na rename/změnu GitHub souřadnic uvnitř jedné
Lazurio Organization access hranice. `github_org`, remote a cesta se musí
shodnout v obou jejích manifestech. Přesun mezi dvěma Lazurio Organizacemi je
source/access migrace, ne location repair: Organization-scoped slug není
globální identita, foreign owner dostane `slot_remote_owner_mismatch` a Agent
musí nejprve reviewovaně ustanovit cílovou deklaraci a přístup. Automatický
cross-Organization přesun by vyžadoval nový explicitní neměnný migration token;
současný mechanismus jej z názvu, remote redirectu ani lokálního markeru nehádá.

Kanonické task worktrees mohou fyzicky ležet v `.worktrees/` svého owner repa,
ale nejsou jeho zdrojová změna. Když `lazurio update` prokáže, že jde o skutečně
registrovaný Git worktree tohoto repa, automaticky doplní lokální
přesnou cestu worktree a jejího sidecaru do Git `info/exclude`. Celou
`.worktrees/` složku nikdy neignoruje. Uživatel nic nenastavuje, primární
checkout zůstane čistý a jakýkoli neznámý soubor dál skončí v recovery stashi
nebo update bezpečně zablokuje.

Instalace desktopového Launchpadu není implicitní čtvrtý krok tohoto update
pořadí; uživatel nebo rollout ji spouští explicitně příkazem
`lazurio launchpad install`.

Odstranění hosted checkout pinu je bezpečné až po nasazení a health ověření
immutable runtime vrstvy. Rollback runtime přepne image/artifact digest;
nevrací ani nemaže pracovní Git checkouty a jejich recovery stashe.
