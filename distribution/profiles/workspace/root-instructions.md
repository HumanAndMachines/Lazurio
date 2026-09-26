<!-- generated:lazurio-resident-profile=workspace -->

# Lazurio Runtime — profil Workspace

Tento adresář je immutable Lazurio runtime artefakt. Není to pracovní Git
checkout a nesmí se v něm vytvářet branche, commity, stashe ani lokální
hotfixy. Jeho exact source commit a digest dokazuje `lazurio.resident.json`.

Pracovní prostor Kolegy nebo AI Kolegy žije v odděleném mutable Lazurio Rootu.
Lokálně i hosted používá stejný model a stejné mechanismy; lišit se smí pouze
transport, custody, aktivní Team projekce a provozní nasazení runtime.

## Mašina tohoto profilu

Mašina je jedna sdílená runtime, bezpečnostní a recovery hranice se známým
Ownerem, ne typ hardwaru. Lokální workstation může být Mašinou jednoho
Principála. Celý Hosted Team Workspace se na tenantní vrstvě počítá jako
Mašina Teamu jen díky podporovanému infrastrukturnímu obalu se samostatnými
soubory, procesy, sítí, credentials, lifecycle a obnovou; samotný kontejner,
Unixový účet, proces, Modul ani worktree Mašinou nejsou.

Ownerem Hosted Team Workspace je Organizace a členové Teamu jsou jeho
oprávnění uživatelé. Workspace nepřebírá jejich Personalspace ani org-wide
pravomoci. Root nebo srovnatelná autorita Organization Hostu zůstává vyšší
doménou kompromitace a obnovy, i když jsou sourozenecké Team Workspaces na
tenantní vrstvě oddělené. Pojem Mašina nevytváří vlastní IAM, roli, manifest
ani centrální registr; access dál dokazují živá provider oprávnění.

Launchpad se spouští z tohoto runtime rootu a pracovní checkout dostává jako
explicitní `WORKSPACE_ROOT`/`--root`. `LAZURIO_RUNTIME_ROOT` musí přesně
ukazovat na tento adresář. Pokud se runtime a working root překrývají, update
se musí zablokovat před první Git mutací.

`lazurio update` spravuje jen Lazurio Root → Organization Rooty → Workspace
Moduly. Productionspace, Personalspace, task/PR worktrees a root-space
repository-db včetně Mission Control dat mají vlastní lifecycle a zůstávají
nedotčené. Update je vždy explicitní; první Launchpad render je GET-only a
nespouští fetch ani mutaci.

Skutečné přístupy určuje přihlášená identita a živá GitHub práva. Runtime,
textová role ani prompt nevytvářejí druhý ACL.

## Hostovaná pracovní Mašina: identita před prací

Na hostované pracovní VM Organizace (`/etc/lazurio/lazurio.machine.json`,
`machine.kind: workspace-vm`) se před první prací i před `lazurio update` řiď
`manual/hosted-machine-first-login.md` v tomto runtime rootu. Dočasně
(decision 0159) operátor přihlásí `gh` libovolným GitHub účtem;
`owner.assignment` přihlášení neomezuje a jiný účet ani chybějící přiřazení
nejsou blocker. Rozlišovacím znakem postupu je `owner.assignment.kind`:

- `operator`, chybějící nebo neplatné přiřazení: osobní postup. Agent ověří,
  že `gh` je přihlášený, a řekne operátorovi kterým účtem; přihlášení
  a přehlášení provede operátor sám (Launchpad → Nastavení → Zdrojové kódy).
- `team` s nasazeným brokerem: GitHub identitou je výhradně bot Organizace
  `lazurio-for-github[bot]`; osobní přihlášení Agent nespouští ani
  nenavrhuje. Bez brokeru postupuje jako na osobní VM a upozorní, že všichni
  na VM pracují pod přihlášeným účtem.

Nejasný nebo nebezpečný Git stav
se neopravuje odhadem: zachová se a předá Kolegovi jako prompt pro Codex.

## Architektonická odpovědnost při změně source kódu

Principál určuje chtěný výsledek a má poslední slovo, ale jeho zadání není
automaticky hotovou architektonickou specifikací. Před každou tvorbou nebo
změnou source kódu v odděleném pracovním checkoutu kriticky ověř navržený
prostředek proti autoritám a principům Lazuria, navrhni nejmenší úplné řešení a
rozpor otevřeně pojmenuj. Hloubka je úměrná riziku:

- Rychlá kontrola stačí jen tehdy, když změna zachovává existující
  architekturu, ownership i source of truth, nepřidává trvalou abstrakci,
  závislost, stav, konfiguraci ani fallback, nemění access, security, data,
  lifecycle ani cross-scope kontrakt a má malý blast radius se zřejmým
  rollbackem. Taková změna nepotřebuje nový dokument ani externí review.
- Jinak, a vždy u nové dlouhodobé abstrakce, stavu, autority, hranice,
  rozhraní, závislosti, distribuce nebo obtížně vratné migrace, proveď plný
  shaping: odděl cíl od navrženého prostředku, porovnej skutečné varianty
  včetně baseline bez nového mechanismu, projdi failure modes a rollback a
  zvolené řešení dokaž na skutečném nebo věrném consumerovi. Každý nový trvalý
  koncept má ownera, consumera, lifecycle a vztah k tomu, co nahrazuje.
- Nedostupný konkrétní reviewer, model, CLI či subagent není blocker; místo
  nezávislé protiváhy pak proveď pravdivě označený solo inversion pass.

Má-li se změnit samotný princip, routuj rozhodnutí k jeho kanonické autoritě
místo tichého vedlejšího diffu.

Runtime nemá self-update službu. Novou verzi instaluje image/release pipeline
z exact-digest artefaktu; mutable working root se aktualizuje výhradně
centrálním Lazurio update enginem.
