# Vydání Lazurio CLI přes npm

Tento runbook drží jedinou veřejnou distribuční cestu příkazu `lazurio`.
Nevytváří vlastní registr ani release server: immutable package verzi vlastní
npm a GitHub Release na ni pouze odkazuje. `nightly` a `latest` jsou npm
dist-tagy nad stejnou verzí, nikoli dvě různá sestavení.

Publikace npm package i změna stabilního dist-tagu jsou **Release**. Agent je
smí provést jen po explicitním pokynu oprávněného Principála pro přesnou verzi.

## 1. Připrav exact kandidáta

Začni na clean, reviewovaném commitu, jehož běžný GitHub `checks` workflow je
zelený na Ubuntu a Windows a jeho npm package gate + content parity jsou zelené
na macOS, Linuxu a Windows. Zvol novou SemVer verzi a spusť:

```sh
bun run npm-package:gate -- \
  --release-version <version> \
  --archive-dir dist/npm-release/<version>
```

Gate sestaví package výhradně z exact Git tree, nainstaluje skutečný tarball do
izolovaného Bun home, spustí CLI smoke a teprve potom uloží stejné ověřené bytes
spolu s JSON evidence. Cílový adresář nesmí existovat; gate nikdy nepřepisuje
staršího kandidáta. `dist/` je lokální ignored výstup a nesmí se commitovat ani
přenášet přes GitHub Actions artifact.

Cross-platform CI ověřuje stejný builder, source commit, package obsah a
instalovaný CLI kontrakt. Explicitní release verze se vybírá až v tomto
release gate; není uložená v source `package.json`, samostatném `VERSION`
souboru ani v runtime konfiguraci.

## 2. Jednorázově založ npm package

Trusted publishing lze u npm nastavit až pro existující package. Proto pouze
první claim jména `lazurio` proběhne z lokálního ověřeného tarballu přes
standardní npm CLI a interaktivní 2FA:

```sh
npm publish dist/npm-release/<version>/lazurio-<version>.tgz \
  --access public \
  --tag nightly
```

Po publish ověř přes npm, že publikovaná verze má očekávaný digest, source
commit a funkční `lazurio --version --json`. První nightly záměrně nevytváří
`latest`; uživatelé stabilní package ještě nedostanou.

## 3. Zapni provider-native trusted publishing

Po založení package nastav v npm právě jeden GitHub Actions trusted publisher
pro public repo `HumanAndMachines/Lazurio` a samostatný release workflow.
Workflow musí používat GitHub-hosted runner, npm alespoň 11.5.1, Node alespoň
22.14 a oprávnění `id-token: write`. Dlouhodobý `NPM_TOKEN` se nezavádí.

Release workflow dostane explicitní verzi, znovu použije tentýž package gate,
publikuje ověřený tarball přes `npm publish --tag nightly` a uloží jen evidence
a GitHub Release metadata. Tarball se mezi joby nepřenáší jako neautoritativní
Actions artifact. Workflow se přidá až po provider-side trusted publisher
setup; do té doby by nešlo jeho publish větev pravdivě otestovat.

Npm trusted publishing nepodporuje změnu dist-tagu. Ta proto zůstává krátkým
interaktivním krokem oprávněného release operátora, nikoli důvodem pro trvalý
token.

## 4. Promuj stejnou verzi na stable

Po nightly dogfoodu a explicitním Release pokynu nepřestavuj package. Ověř
publikovaný digest a přesuň pouze standardní npm tag:

```sh
npm dist-tag add lazurio@<version> latest
```

Operace používá interaktivní npm přihlášení a 2FA. GitHub Release označí stejný
source commit a stejnou npm verzi. Rollback stabilního kanálu je obdobně pouze
vědomý přesun `latest` na dříve ověřenou immutable verzi; žádné bytes se
nepřepisují ani nemažou.

## Failure modes

- Dirty checkout, neplatná verze, neúspěšný install/smoke nebo rozdílný digest
  kandidáta blokuje ještě před npm.
- Existující output adresář se nikdy nepřepíše. Po přerušeném běhu jej Agent
  nejdřív zkontroluje a teprve potom vědomě odstraní nebo zvolí nový adresář.
- Existující npm verzi znovu nepublikuj. Oprav zdroj, zvol novou verzi a projdi
  celý gate znovu.
- Selhání trusted publisheru neobcházej tokenem. Oprav provider setup nebo
  workflow a zopakuj Release stejné dosud nepublikované verze.
- `latest` nikdy neposouvej na verzi, která neprošla nightly dogfoodem a
  explicitním schválením.

Provider požadavky: [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/)
a [npm dist-tags](https://docs.npmjs.com/adding-dist-tags-to-packages/).
