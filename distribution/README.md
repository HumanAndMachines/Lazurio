# Lazurio resident distributions

> **Buddy nemá Resident profil (decision 0210).** Buddy je Hermes Agent
> v Osobním Prostředí svého člověka ([manuál Buddyho](../manual/buddy.md)).
> Profil `buddy`, jeho Zulip bridge, service a rollout příkazy a operator plane
> pro jeho hosty se z tohoto source odstranily. Dosavadní hostované instalace
> Buddyho běží dál ze svých nainstalovaných artefaktů podle pravidel svého
> hostu, dokud je někdo nemigruje.

Tato vrstva skládá celý non-Git Lazurio Root z exact commitu společného source.
Sdílený produkt zůstává v běžných adresářích rootu; nevzniká paralelní
`common/` strom. Pod `distribution/` žijí pouze build kontrakt, profilové
fragmenty, dependency piny, evaly, runtime lifecycle soubory a locale projekce
dlouhých Root-owned dokumentů, které musí resident build dodat spolu s jejich
consumerem. Anglická projekce Organization install Guide proto žije v
`locales/en/manual/organization-install.md`; český kanonický zdroj zůstává v
`../manual/organization-install.md`.

Kurátorovaný přechod ze starších produktových repozitářů drží
`migrations/`. Inventář zapisuje exact source commit a disposition každé
skupiny; není to svolení ke kopii privátního repozitáře ani vstup buildu.

Profilový fragment se záměrně jmenuje `root-instructions.md`, nikoli
`AGENTS.md`. V source checkoutu proto není aktivní instrukční scope. Builder z
něj vytvoří jediný root `AGENTS.md` až ve výsledném artefaktu.

## Build

Builder přijímá pouze čistý checkout a čte všechny vstupy jako Git blobs z
exact `HEAD`; ignored nebo necommitnutý obsah se do artefaktu nedostane.
Kanonická identita source repozitáře je verzovanou součástí build kontraktu,
nikoli hodnotou odvozenou z lokálního `remote.origin.url`.

```sh
bun run resident:build -- --profile workspace --target linux-x64 \
  --version 0.1.0-candidate.1 --channel candidate
```

Výstup pod `dist/resident/` obsahuje adresář, deterministický USTAR archiv a
jeho SHA-256 sidecar. Existující výstup se nikdy nepřepisuje. Pro stejné
source SHA, profil, target, verzi, channel a build contract vzniknou stejné
bytes.

Volitelné opakované `--forbid-term <text>` dovoluje rollout gate doplnit
jmenovité termy, které se nesmějí objevit v public artefaktu, aniž by je
ukládalo do source nebo manifestu.

Package-managed localhost CLI je standardní publishable workspace package pod
`lazurio/`; privátní root package zůstává pouze orchestrátor. Standardní
`npm pack` packlist, privacy/closure kontrola a instalace skutečného tarballu
na všech OS nic nepublikují. Provider gate, staged publishing a trusted
publishing drží
[npm CLI release runbook](../manual/npm-cli-release.md).

## Hranice manifestu

`lazurio.resident.json` inventarizuje a hashuje každý immutable payload soubor.
„Immutable“ tu označuje kanonickou, verzovanou podobu release, ne zákaz zápisu
pro Principála na jeho vlastní Mašině. Principál může udělat lokální opravu;
Resident Doctor ji transparentně ohlásí jako drift a updater ji nikdy potichu
nepřepíše. Manifest sám není v cirkulárním file inventory; celý archiv včetně
manifestu kryje vnější `.tar.sha256` sidecar. Doctor navíc zachytí chybějící
nebo neočekávaný soubor, nesprávnou platformu, `.git`, jiný profil a drift
exact Hermes pinu.

`organizations/` a `personalspace/` nejsou payload. Installer je později
připojí jako explicitní perzistentní mutable mounty; Doctor jejich obsah
nečte ani nehashuje.

## Assisted install, update a rollback

Updater v1 je explicitní operátorský příkaz, ne daemon. Spouští se z exact
reviewovaného operator kitu mimo instalovaný artefakt: kit nese
`package.json`, `distribution/runtime/updater-lib.mjs`,
`distribution/runtime/integrity.mjs` a `lazurio/core/resident-manifest-lib.mjs`
z jednoho source commitu. Tímto kitem instaluje a kontroluje Workspace
Residenta Machines. Instalovaná Mašina proto nepotřebuje Git checkout Lazuria
a samotný artefakt updater nenese.

```sh
bun distribution/runtime/updater.mjs install \
  --archive /staging/lazurio-resident-workspace-<version>-linux-x64.tar \
  --checksum /staging/lazurio-resident-workspace-<version>-linux-x64.tar.sha256 \
  --install-root /opt/lazurio --profile workspace --channel candidate

bun distribution/runtime/updater.mjs status \
  --install-root /opt/lazurio --profile workspace

bun distribution/runtime/updater.mjs rollback \
  --install-root /opt/lazurio --profile workspace
```

Lifecycle layout je záměrně malý:

```text
/opt/lazurio/
├── active -> versions/<artifact-id>
├── versions/<artifact-id>/       # immutable, non-Git Lazurio Root
└── state/
    ├── lifecycle.v1.json         # content-free active/LKG metadata
    ├── mounts.v1.json            # root-owned local mount contract
    ├── organizations/            # persistent mutable mount
    └── personalspace/            # directory, or declared link to existing data
```

`state/` je root-owned traverse-only (`0711`); lifecycle a mount metadata
zůstávají `0600`. Runtime tak může projít známou cestou k externímu mountu,
ale nemůže vylistovat ani číst updater metadata. Obsahová oprávnění dál drží
původní Personalspace strom.

Updater nejdřív ověří externí SHA-256, bezpečně parsuje pouze regular-file a
directory USTAR entries, kontroluje manifest, profil, platformu, build a
rollback kompatibilitu a exact payload hashe. Kandidát se rozbalí do nové
staging cesty, dostane odkazy na existující mutable mounty a projde Resident
Doctorem. Teprve potom atomický relativní symlink přepne `active`. Selže-li
post-switch gate, původní pointer se obnoví; verzované rooty se automaticky
nemažou.

První instalace může explicitním `--mount-source NAME=/absolute/path` adoptovat
existující mutable strom bez kopie nebo přesunu. Updater uloží resolved target
do mode-0600 `mounts.v1.json`; každý další update, status i rollback ověřuje,
že lokální link stále míří přesně tam. Jiný target se odmítne a neprázdný
managed adresář se nikdy neschová pod externím mountem.

V1 používá POSIX atomic-symlink adapter pro Linux a macOS. Windows Kolegové
zůstávají na stávajícím Git checkoutu a Windows resident lifecycle se
nezapne, dokud nebude mít vlastní atomický pointer adapter a failure testy.

## Stav první fáze

Build contract v1 vydává pouze profil `workspace`. Schema, builder, integrity
engine a updater jsou profilově neutrální; každý další runtime profil nebo
overlay se publikuje teprve s vlastním reviewovaným kontraktem a ověřením.
Manifest v1 dál nese exact piny Hermesu, GBrainu a toolchainu: Resident Doctor
je ověřuje a CLI provenance bez nich manifest nepřijme. Build ani updater sám
neopravňuje přístup na živý host, Release nebo production cutover.
