# Vydání Lazurio CLI přes npm

Tento runbook drží jedinou veřejnou distribuční cestu příkazu `lazurio`.
Využívá standardní npm package, dist-tagy, staged publishing a trusted
publishing; Lazurio nestaví vlastní registr, packer, release manifest ani
paralelní důkazní archiv.

Publikace nové npm verze, schválení staged package i přesun `latest` jsou
**Release**. Agent je smí provést jen po explicitním pokynu oprávněného
Principála pro přesnou verzi nebo tagovou operaci.

## 0. Zmraz package coordinate

Tracked package žije v `lazurio/package.json`; root `package.json` zůstává
privátní workspace orchestrátor. Dnešní `@lazurio/runtime` je pouze
nepublikovaný fallback, aby šlo package shape a instalaci ověřit před live
provider gatem. Před prvním npm publish ověř dostupnost, správu a dlouhodobou
custody jména přímo u npm:

- preferuj unscoped `lazurio`, pokud je claimnutelné a Lazurio má jeho trvalou
  správu;
- jinak zmraz `@lazurio/runtime` pod spravovaným npm scope;
- po zmrazení změň package name, install dokumentaci a workflow v jednom PR;
  dvě veřejné package identity ani alias package nevznikají.

Dokud tento gate neproběhne, žádný obsah současného manifestu se na npm
nepublikuje.

## 1. Připrav verzi v source

Na reviewovaném clean commitu nastav v `lazurio/package.json` novou SemVer
verzi. Package manifest je jediná autorita verze i standardního npm packlistu.
Potom spusť:

```sh
bun install --frozen-lockfile
bun run npm-package:gate
bun run check
bun run doctor
```

`npm-package:gate` nejprve použije `npm pack --dry-run --json` jako autoritu
skutečného packlistu, nad fyzickými soubory provede privacy a production-closure
kontrolu a skutečný `npm pack` nainstaluje do izolovaného Bun global prefixu.
Smoke spouští nainstalovaný `lazurio`, top-level install, Organization install
i updater assets. Současně dokládá dnešní package code-origin hranici:
`lazurio launchpad serve` z npm package, který ještě neobsahuje celý Launchpad
Server/UI, musí před spawnem skončit stabilní chybou
`LAZURIO_LAUNCHPAD_RUNTIME_UNAVAILABLE` a nesmí použít měnitelný Launchpad
z instalovaného Rootu. Gate nic nepublikuje a tarball po ověření smaže.

Stejný package nemá OS/arch varianty. GitHub checks spouštějí tentýž gate na
macOS, Linuxu a Windows; nevyrábějí vlastní manifest, retained candidate,
cross-job JSON parity ani release artefakt.

## 2. Jednorázově založ package

Staged publishing vyžaduje už existující npm package. Pouze první claim proto
proběhne standardním `npm publish` z adresáře `lazurio/`, s interaktivním npm
přihlášením a 2FA oprávněného release operátora:

```sh
cd lazurio
npm publish --access public --tag next --provenance=false
```

První release zůstane pod `next`; `latest` se tímto krokem neposouvá. Explicitní
override vypíná provenance pouze pro tento lokální bootstrap, protože npm ji
umí vytvořit až v podporovaném CI. Po publish ověř package name, verzi,
packlist, registry integrity a funkční instalaci přes veřejný registr. Jméno a
verzi nelze po publikaci znovu použít, proto při jakémkoli rozporu vydej novou
opravenou SemVer verzi. Všechny další verze už používají trusted publisher a
automatickou provenance.

## 3. Zapni trusted a staged publishing

Po založení package nastav na npm právě jeden GitHub Actions trusted publisher
pro public repo `HumanAndMachines/Lazurio` a konkrétní release workflow.
Workflow používá GitHub-hosted runner, `id-token: write`, Node alespoň 22.14 a
npm alespoň 11.15. Dlouhodobý write token se nezavádí.

Trust relationship povol pouze `npm stage publish`, ne přímý `npm publish`.
Package access nastav na vyžadovanou 2FA a zakázané tokeny. Trusted publish z
public GitHub repa automaticky přidá npm provenance, která váže package na
source commit a workflow; Lazurio proto nevkládá commit ani vlastní digest do
`package.json`.

Workflow po zelených gates běží z `lazurio/`:

```sh
npm stage publish --tag next
```

Staging není Release navenek: package ještě není veřejně dostupný. Oprávněný
Principál zkontroluje metadata a přesně staged bytes přes npm:

```sh
npm stage list <package-name>
npm stage view <stage-id>
npm stage download <stage-id>
```

Teprve explicitně schválený kandidát publikuje s proof-of-presence a 2FA:

```sh
npm stage approve <stage-id>
```

Špatný kandidát se neschvaluje; po kontrole jej oprávněný operátor odmítne a
source dostane novou verzi. Tag zvolený při stagingu je součástí kandidáta a
později se v něm nepřepisuje.

## 4. Promuj ověřenou verzi na stable

Po dogfoodu verze pod `next` a explicitním Release pokynu nepřestavuj package.
Ověř registry integrity a provenance a přesuň pouze standardní npm dist-tag:

```sh
npm dist-tag add <package-name>@<version> latest
```

GitHub Release označí tentýž source commit a changelog stejné npm verze; package
bytes znovu nehostuje jako druhý distribuční kanál. Rollback stabilního kanálu
je vědomý přesun `latest` na dříve ověřenou immutable verzi, ne přepis nebo
mazání již vydaných bytes.

## Failure modes

- Dirty checkout, neplatná SemVer, neúspěšný pack/install/smoke, privacy nález
  nebo production import mimo package blokuje před npm.
- Provider gate bez prokázané custody jména blokuje první publish.
- Existující nebo staged npm verzi znovu nepoužívej; oprav source a zvol novou
  verzi.
- Selhání trusted publisheru neobcházej write tokenem. Oprav provider setup
  nebo workflow.
- Staged package bez přesného lidského review a explicitního Release pokynu
  neschvaluj.
- `latest` neposouvej na verzi, která neprošla `next` dogfoodem a explicitním
  schválením.

Provider autority: [npm staged publishing](https://docs.npmjs.com/staged-publishing/),
[npm trusted publishing](https://docs.npmjs.com/trusted-publishers/) a
[npm dist-tags](https://docs.npmjs.com/adding-dist-tags-to-packages/).
