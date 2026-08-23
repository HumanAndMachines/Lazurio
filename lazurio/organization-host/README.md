# Organization Host contract v1

Tato složka je verzovaný, provider-neutral source kontraktu pro správu
Organization Hostů. Vlastníkem je Lazurio root
(`HumanAndMachines/Lazurio`); konkrétní desired state, provider adapter,
secrets reference, recovery evidence a deploy audit dál vlastní restricted
`infra` repo každé Organizace.

Kontrakt záměrně není `InfraTemplate_GEN3`. Neobsahuje hotový playbook,
provider hodnoty ani environment-specific topologii a žádné existující infra
repo zpětně neoznačuje za template.

## Tři hranice

- **Organization Host** je provider Machine a administrativní hranice, která
  nese vzájemně oddělené Hosted Team Workspace runtime.
- **Hosted Team Workspace** je privátní vývojová Machine jednoho Teamu. Běží
  non-root, nehostuje produkční aplikace a nevlastní provider credentials ani
  hostový orchestrátor.
- **Lazurio Host** je pouze popis Machine s instalovaným Lazurio Residentem.
  Není to třetí IAM, desired-state store ani nová organizační hranice.

## Soubory

- `adapter.v1.schema.json` — co musí deklarovat Organization-owned infra repo;
- `readback.v1.schema.json` — minimální metadata-only odpověď adapteru;
- `contract-lib.mjs` — fail-closed validace, kanonická cesta entrypointu a
  pevný invocation kontrakt;
- `fixtures/` — anonymní archetypy pro rozdílné současné stavy. Nejsou to
  inventory reálných Organizací ani deploy konfigurace.

Schéma `lazurio.organization_host.adapter.v1` a interface version `1` jsou
první compatibility hranice. Breaking změna vyžaduje nový schema marker a
interface version; význam v1 se nepřepisuje potichu.

## Adapter rozhraní

Restricted infra repo deklaruje jeden relativní executable `entrypoint`.
Lazurio mu předá právě jednu pevnou operaci a `--json`:

```text
<entrypoint> validate --json
<entrypoint> plan --json
<entrypoint> apply --json
<entrypoint> readback --json
<entrypoint> rollback --json
```

`validate`, `plan` a `readback` jsou read-only. `apply` a `rollback` jsou
mutační a SDK je nevydá bez všech čtyř gate: explicitní Organization selector,
plan-owned worktree, reviewovaný diff a explicitní deploy souhlas. Adapter
smí uvnitř použít Ansible, Pulumi nebo jiný Organization-owned mechanismus;
kontrakt žádný provider ani tool nepreferuje.

Výstup neobsahuje volný text, hostname, IP, Team jména, provider ID,
credentials ani absolutní cesty. Stav se předává přes omezené enumy a
`reason_code`. Adapter u runtime pinu vrací jeho druh, deklarovanou hodnotu,
stav pozorování a pozorovanou hodnotu; sám netvrdí `match` ani `drift`.
Exact infra repository a Git HEAD pozoruje Lazurio Root ze zvoleného lokálního
checkoutu; adapter je sám netvrdí a kontrakt je necentralizuje.

## Conformance a recovery

Každá deklarace drží stejné invarianty:

- non-root per-Team izolaci a zákaz production hostingu ve Workspace;
- exact runtime piny;
- health kategorie `host`, `workspace`, `access`, `runtime`, `ingress` a
  `storage`;
- metadata-only logy bez secrets;
- checkpoint před mutací, restore readback, clean rebuild a rollback;
- Organization-owned desired state, secrets reference, provider state a
  deploy audit.

`profile_state` rozlišuje `legacy`, `target` a `declared`. Organization
adapter nikdy netvrdí stav `compliant`: ten smí odvodit až Root Doctor z
validního readbacku, shody exact pinů, úplných health checks, recovery evidence
a pozorovaného exact infra HEADu.

## Co v1 nedělá

- neprovádí auto-discovery ani agregovanou inventuru;
- neobsahuje implicitní `apply-all` ani vzdálenou fleet mutaci;
- neukládá credentials, provider state nebo Organization-specific metadata;
- nespouští live host operace a neuděluje k nim oprávnění;
- nebalí kontrakt automaticky do Resident artefaktu.

Read-only Root inventory a Doctor nad tímto kontraktem jsou navazující slice
plánu DEV-6501. Reálná adopce vzniká vždy samostatným PR v infra repu vybrané
Organizace a sériovým canary.
