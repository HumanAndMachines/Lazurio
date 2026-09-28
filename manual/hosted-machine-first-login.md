# Hostovaná pracovní VM: první přihlášení a donastavení

Platí pro hostované pracovní Mašiny, které Machines předá jako `workspace-vm`
Organizace (decision 0144). Machines dodá systém, síť, SSH, bránu,
nainstalované Lazurio a identitu Mašiny v `/etc/lazurio/lazurio.machine.json`
(kontrakt `lazurio.machine.v1`, Machines `docs/machine-identity.md`); **všechno
uvnitř je práce operátora a jeho Task Agenta** podle tohoto postupu. Cíl:
operátor nikdy nedostane prostředí, které vypadá hotově, ale není donastavené.

## Které Lazurio na VM běží (stav 2026-09-28)

Na hostované pracovní VM dnes leží dvě instalace vedle sebe:

- **Rezidentní instalace Root Repa:** pracovní Root `~/Lazurio` (není to Git
  checkout), rezidentní Launchpad jako služba `lazurio-launchpad.service` a
  **rezidentní CLI** `~/.local/share/lazurio/resident/active/lazurio/cli.mjs`.
  Instalaci a synchronizaci Organizací dnes dělá jen tato instalace.
- **LazurioPlatform:** install base `~/.local/share/lazurio`, selector
  `~/.local/share/lazurio/bin/lazurio`. Materializaci ani synchronizaci
  Organizací zatím nemá (její rozhodnutí F9 není implementované); jeho
  `lazurio update` aktualizuje jen produkt a Agent ho spouští jen na pokyn
  operátora (decision 0161, dodatek 2026-09-28).

Na login `PATH` operátora dnes není žádný příkaz `lazurio`; `~/.local/bin/lazurio`
vytvoří až release LazurioPlatform novější než 0.1.7. Holý příkaz `lazurio`
proto v postupu níže nepoužívej. **Rezidentním CLI** se tu myslí
`bun ~/.local/share/lazurio/resident/active/lazurio/cli.mjs` spuštěné se stejným
prostředím, jaké má služba `lazurio-launchpad.service` (proměnné vypíše
`systemctl show lazurio-launchpad.service -p Environment`, u uživatelské
jednotky s `--user`). Přechod VM na LazurioPlatform včetně práce s Organizacemi
je rozpracovaný a sleduje ho LazurioPlatform (issue #50); do té doby tento
manuál popisuje rezidentní instalaci.

## Kdo se přihlašuje (decisions 0159 a 0168)

Dokud vazbu Mašina → GitHub účet neřídí Lazurio Account v Dashboardu,
přihlásí operátor osobní pracovní VM **libovolným GitHub účtem**.
`owner.assignment` v `/etc/lazurio/lazurio.machine.json` přihlášení
neomezuje: Agent kvůli chybějícímu, neplatnému ani odlišnému přiřazení
neblokuje a jiný přihlášený účet není blocker. Týmová VM se osobním účtem
nepřihlašuje nikdy: pracuje přes bota Organizace (níže, decision 0168).
GitHub dál rozhoduje, co přihlášený účet smí.

## Jak Agent pozná, o jakou Mašinu jde

Rozlišovací znak je `owner.assignment.kind` v
`/etc/lazurio/lazurio.machine.json`; Agent ho přečte přímo ze souboru (žádný
CLI příkaz na to není) a **nikdy ho neodvozuje** z `owner.team`, hostname,
OS účtu ani velikosti Teamu — jednočlenný Team nedělá z Mašiny osobní VM.
Určuje postup (osobní vs. týmová VM) a od decision 0168 i to, kdo se přihlašuje: na týmové VM nikdo osobním účtem, jen bot Organizace; na osobní pracovní VM dál kdokoli podle decision 0159.
Uživatelsky jde o druhy Environmentu podle decision 0165: osobní pracovní VM
je Pracovní, týmová VM Pracovní týmové a osobní Mašina Principála Osobní.

- `machine.kind: workspace-vm`, `owner.kind: organization` a `owner.assignment.kind: operator`
  (s `github_login` a `github_id` operátora) = **osobní pracovní VM** jednoho
  operátora vlastněná Organizací (preset `hosted-organization-personal`).
- `machine.kind: workspace-vm`, `owner.kind: organization` a `owner.assignment.kind: team` = **týmová VM**
  (preset `hosted-organization-team`). Pro ni platí
  [samostatná sekce níže](#týmová-vm-identita-organizace-ne-člověka).
- `machine.kind: personal-vm` s `owner.kind: principal` = osobní Mašina
  Principála podle [`hosted-buddy-vps.md`](hosted-buddy-vps.md); tento manuál
  se na ni nevztahuje.
- Soubor chybí, nevaliduje, nebo `owner.assignment` není deklarovaný: Agent
  typ nehádá a **osobní přihlášení `gh` neprovede** — bez platného handoveru
  nejde vyloučit, že jde o týmovou VM, na které je osobní účet zakázaný
  (rozhodnutí 0168). Stav nahlásí operátorovi a požádá provozovatele Machines,
  ať handover ověří nebo doplní (`lazurio machine inspect` rezidentního CLI
  vypíše přesné odmítnutí); teprve potom pokračuje. Práce, která přihlášení
  nepotřebuje, blokovaná není.

## Osobní pracovní VM: identita operátora

Osobní pracovní VM funguje jako pracovní stanice svého operátora v cloudu:
GitHub je jediná autorita přístupů, a proto je `gh` na této Mašině přihlášený
účtem, který si operátor zvolí (decision 0159). Bez přihlášení nemá Agent
žádnou Organizaci, žádné moduly a žádná repa; má jen čisté Lazurio.

Agent **před prací ověří, že `gh` je přihlášený** a jakým účtem
(`gh api user`), a operátorovi ten login řekne; jiný účet než
`owner.assignment` blocker není. Chce-li operátor jiný účet, odhlásí ho
tlačítkem **Odhlásit** v Launchpadu a přihlásí znovu; přehlášení provede jen
operátor sám. Když `gh` přihlášený není
(`gh auth status --hostname github.com`), Agent **nepokračuje v úkolu, dokud
operátora neprovede přihlášením**, a vysvětlí mu proč: je to jeho osobní pracovní VM, GitHub
rozhoduje, co v ní smí Agent vidět a měnit, a všechna práce z této Mašiny
bude připsaná jeho účtu.

**Preferovaná cesta je tlačítko v rezidentním Launchpadu.** Ozubené kolo v
hlavičce Launchpadu této Mašiny otevře **Nastavení**, sekce **Zdrojové kódy (GitHub)**,
a tlačítko **Přihlásit GitHub** provede kroky 1 a 2 celé: `gh` login se SSH protokolem, jednorázový
kód jen na přihlášené stránce, SSH klíč jen když chybí a SSH přístup ještě
nefunguje, nahrání veřejné části na právě ověřený účet a důkaz přes `ssh -T`
a `git ls-remote` root repa. Kroky 3 a 4 nabídne jako další tlačítka.
**Odhlásit** vrátí jakékoli přihlášení (jiný účet, rozbitá konfigurace `gh`):
odebere z účtu SSH klíč této Mašiny a odhlásí `gh`, aby šel přihlásit jiný
účet. Agent operátora na tuto stránku pošle a ruční
postup níže použije jen tam, kde Launchpad Mašiny není dostupný.

Ruční postup je stejný jako na pracovní stanici
(kanonicky skill `lazurio-workstation-install`, sekce o GitHub účtu):

1. `gh auth login --hostname github.com --git-protocol ssh --web` bez
   `--clipboard`. Agent předá operátorovi jednorázový ověřovací (device) kód a
   adresu `https://github.com/login/device` **jen v aktuálním soukromém
   chatu**; nikdy do schránky, issue, repa nebo trvalého logu. Interní
   `device_code`, access token ani privátní klíč nikdy nevypíše.
2. Po souhlasu operátora nechá tentýž flow nahrát veřejný SSH klíč Mašiny
   k jeho účtu a přes `gh api user` ověří, kterým účtem je přihlášený.
   Pak ověří `gh auth status` a `git ls-remote` na root repo Organizace.
3. Rezidentní CLI `update`: synchronizuje checkouty Root Repa (decision 0129);
   bez přihlášení Organizaci nenatáhne. Nejde o `lazurio update`
   LazurioPlatform.
4. Rezidentní CLI `organization install <setup-organizace> --role builder --json`
   (u Iotoru `IotorLazurio`). Gate read-only ověří živé členství operátora
   v Organizaci a Teamech a WRITE capability na aktivních Builder repech,
   pak zmaterializuje Organizaci a její moduly do `~/Lazurio/organizations/`.
   Restricted Admin-only sloty (`infra`) Buildera neblokují a nemountují se.
5. `bun run doctor:task` v primárním checkoutu Organizace a rezidentní CLI
   `doctor` v rootu: dokud hlásí required `fail`, `blocked` nebo `incomplete`, není
   Mašina donastavená a Agent to operátorovi řekne místo „hotovo“.
6. Teprve potom Agent pokračuje v původním úkolu. Vstup do T3 Code z
   prohlížeče vede přes Launchpad Mašiny tlačítkem **Chat**, které vydá
   jednorázový párovací token; ruční kopírování párovacích odkazů není
   potřeba.

Co Agent nedělá: sám nevybírá účet za operátora, nepoužívá sdílený
token Organizace, nemountuje cizí Personalspace a nepřenáší přihlášení z jiné
Mašiny. Když operátor přihlášení odmítne nebo nemá potřebná práva, Agent
zapíše přesný blocker a zastaví se.

## Týmová VM: identita Organizace, ne člověka

**Bez výjimky (decision 0168).** Dočasná výjimka 0159 pro týmovou VM
skončila: týmová VM má fungovat s botem Organizace hned po předání. Když na ní
bot neběží (chybí `/etc/lazurio/github-broker/environment`), je to vada
Machines k opravě vpřed, ne důvod přihlásit člověka: Agent osobní přihlášení
nespouští ani nenavrhuje, zapíše blocker pro Organization Admina (níže) a
zastaví se. Osobní účet, který na týmové VM zůstal přihlášený z dřívějška,
operátor odhlásí.

Sdílená týmová VM (`owner.assignment.kind: team`) nemá osobního operátora a
pracuje na ní více lidí z Teamu. Podle rozhodnutí 0147–0149 jedná na GitHubu
**jen jako bot Organizace `lazurio-for-github[bot]` přes broker Organizace**
(Lazurio for GitHub), nikdy jako účet člověka, který je právě přihlášený.
Machines na takové VM nainstaluje brokered `gh`, Git credential helper a
soubor `/etc/lazurio/github-broker/environment` (Machines
`workspace_guest.github_broker`); privátní klíč App na VM nikdy není.

Na Mašině s `owner.assignment.kind: team` a nasazeným brokerem Agent
**před každou prací ověří identitu** — před rezidentním `update`, instalací
i původním úkolem:

- `/etc/lazurio/github-broker/environment` existuje a
  `gh auth status --json hosts` hlásí právě `lazurio-for-github[bot]` (jeden
  host `github.com`, jedna položka, žádná další identita).
- `gh` bota nehlásí, nebo se vedle bota objeví jiný
  účet, je to blocker pro Organization Admina (níže): Agent nepokračuje,
  nespouští rezidentní `update` ani install a nenavrhuje osobní přihlášení.
- `gh auth login`, `gh auth token` a ostatní `gh auth`/`gh config` příkazy
  brokered `gh` záměrně odmítne. **Osobní přihlášení Agent nikdy nespouští,
  nenavrhuje a neobchází** (žádný osobní token v `GH_TOKEN`, žádný osobní SSH
  klíč na GitHub, žádné `~/.config/gh/hosts.yml`). Readback Machines by takové
  přihlášení nahlásil jako drift.

Donastavení (místo kroků 1–5 osobní VM; krok 6 platí stejně):

1. Rezidentní CLI `update`.
2. Rezidentní CLI `organization install <setup-organizace> --json` **bez
   `--role`** (u Iotoru `IotorLazurio`): bot nemá lidskou roli. Lazurio ověří
   bota, zmaterializuje root Organizace a jen ty moduly, jejichž repozitáře
   jsou v klientském rozsahu této VM (repository policy v
   `/etc/lazurio/github-broker/environment`); ostatní sloty vrátí jako
   `excluded_by_broker_policy` bez jediné GitHub operace. Ten rozsah je jen
   lokální omezení klonování, ne autorita: o každém tokenu rozhoduje broker
   Organizace a autoritou přístupu zůstávají živé GitHub granty Teamu. Repo v
   rozsahu, ke kterému broker token odmítne (např. po odebrání grantu), je
   blocker pro Organization Admina, ne důvod k jinému přihlášení.
3. Rezidentní CLI `doctor`: `platform.github_auth` musí hlásit bota. Required
   `fail`/`blocked`/`incomplete` znamená, že VM není donastavená.

Pravidla práce na týmové VM (0148):

- Author commitu je Teamová pseudo-identita
  (`<Organizace> Team <slug> <team.<slug>@<doména>>`), committer bot; obojí
  nastavuje systémová Git konfigurace, Agent je nepřepisuje.
- Každý commit nese trailer `Lazurio-Workspace: <organization-slug>/<team-slug>`.
- Do `main` Agent nikdy nepushuje. Každá změna jde přes pull request otevřený
  botem z branche, s labelem `team:<slug>` (pokud v repu existuje) a
  hlavičkou popisu „Navrhuje Team <slug> z Team Workspace“. Merguje
  oprávněný člověk (Operátor s právy), který tím přebírá odpovědnost; na
  GitHub Free to drží proces, ne technika.
- Repozitář mimo rozsah brokeru Agent neklonuje jinou cestou; přístup Teamu
  mění Organization Admin grantem GitHub Teamu, ne Agent.

Když brokered identita chybí nebo selhává (`gh auth status` nehlásí bota,
Doctor `github_broker_*`, Machines readback `vm-<vmid>-github-broker: fail`),
je to diagnóza pro Organization Admina (`hosted-machine-handover.md`), ne
důvod přihlásit něčí účet. Agent zapíše přesný blocker a zastaví se.

## Co drží kdo

- Machines: Mašina online, `/etc/lazurio/lazurio.machine.json` včetně
  případného `owner.assignment` (popisné; přihlášení omezuje jen tím, že týmová VM se osobním účtem nepřihlašuje, decision 0168), brána, nainstalované Lazurio a Chat vstup Launchpadu
  (`LAZURIO_T3CODE_URL`, párovací příkaz).
- Rezidentní instalace Root Repa (tento manuál, skill
  `lazurio-workstation-install`, rezidentní CLI `organization install`): první
  přihlášení, materializace Organizace, Doctor.
- LazurioPlatform (`docs/workspace-presets.md`): presety a generovaný
  `AGENTS.md` Folderu; až bude `folder-init` součástí handoveru, převezme
  tento text jeho preset a manuál zůstane jen odkazem.
