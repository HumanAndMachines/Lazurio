# Aktualizace už nainstalovaného Lazurio Residenta

Tento manuál rozlišuje dvě lane, které se nesmějí zaměnit:

- **Managed Resident** je normální cesta pro Buddy a AI Kolegu. Machines
  konverguje host, exact Lazurio artefakt, Hermes, GBrain, bindingy, osobní
  Zulip, firewall i šifrovaný checkpoint jednou reviewovanou operací.
- **Legacy assisted Buddy** mění jen immutable Lazurio Root v existující
  instalaci a skládá jeho cutover se starší jednou Hermes/bridge službou.
  Neumí dokazovat zdraví celé Managed Mašiny.

Žádná lane není background daemon, fleet command ani automatická maintenance
window. Každá mutace je viditelná, svázaná s jednou přesnou Mašinou a má
last-known-good nebo obnovovací checkpoint.

## 1. Nejdřív zjisti stav a lane

Na Managed Mašině je jediný content-free provozní vstup:

```sh
sudo lazurio-resident-status
```

Vrací profil (`buddy` nebo `ai-colleague`), exact artifact, aplikované
Deployment/Machines HEADy, služby, binding count, sandbox, poslední šifrovanou
zálohu a kompatibilní checkpoint. Pokračuj jen když odpovídají reviewovanému
Machine Recordu a cílovému Plánu. Zelený samotný proces není důkaz zdravé
Mašiny.

Následující přímý příkaz patří pouze legacy assisted instalaci:

Z aktivního rootu spusť:

```sh
bun /opt/lazurio/active/resident/updater.mjs status \
  --install-root /opt/lazurio --profile buddy
```

Pokračuj pouze když výstup označí aktivní artefakt, profil `buddy` a health
`pass`. Pro legacy AI Kolegu lze místo něj použít `--profile ai-colleague`, ale
vznik nové AI Colleague Mašiny patří do Managed lane. `fail`, nečitelný
manifest, chybějící mount nebo lokální drift nejsou důvodem vynutit update;
jsou důvodem nejdřív určit, co se změnilo.

Do sdílené evidence zapisuj jen content-free fakta: artifact id, source commit,
čas, jméno checku a výsledek. Nezapisuj obsah Personalspace, konverzace,
credentials ani runtime logy se soukromým obsahem.

## 2. Lokální úprava je legitimní drift

Principál vlastní Mašinu a může aktivní root vědomě opravit. Doctor takovou
změnu zviditelní, ale nevydává ji za útok ani ji automaticky nevrací. Updater
ji nesmí potichu přepsat.

Před dalším update Principál nebo jeho operátor vědomě zvolí jednu možnost:

1. hotfix zatím zachovat a update odložit;
2. přenést opravu do odděleného Lazurio source checkoutu a vydat nový artefakt;
3. vrátit soubor na kanonickou release podobu a znovu spustit status.

## 3. Managed deploy, návrat artefaktu a budoucí obnova

Managed změna začíná v provider-custody Deployment Repo, ne SSH příkazem na
hostu. Změň exact Lazurio artifact pin nebo jiný desired state jedné Mašiny a
proveď stejný uzavřený lifecycle jako při první instalaci:

```text
fresh readback → canonical Plan → review/merge → one-use Permit
  → apply s pre/post-change checkpoint policy → fresh readback
```

Machines Adapter přes SSH předá controlleru uzavřený kontrakt a dva oddělené
purpose-scoped secret bundly: runtime credentials a checkpoint credentials.
Controller atomicky aktivuje exact Lazurio Root,
ověří exact Hermes a GBrain checkouty, znovu vygeneruje binding-scoped služby,
pro Buddyho zkonverguje osobní Zulip a po mutaci vyžaduje čerstvou šifrovanou
zálohu. Runtime si Permit nevydává a jeho service account nemá dostat
Deployment Repo, provider credential ani checkpoint credential.

Machines volá updater s explicitním `--mode managed` a oběma mount source.
Výchozí `assisted` mode u Buddyho Organizations mount odmítne, aby stará jediná
osobní bridge služba omylem nezískala společný pohled na více Organizací.

Veřejný Adapter v3 má jen `validate`, `readback`, `plan` a Permit-backed
`apply`. Návrat kódu proto není druhý protokol: v Machine Recordu se zvolí
předchozí exact kompatibilní artefakt a projde se stejný Deploy. Selhání
atomické aktivace vrátí last-known-good artefakt ještě uvnitř této transakce.

Datový recover zatím není spustitelná Machines capability. Checkpoint nese
metadata-only katalog a compatibility fingerprint Mašiny, Profilu, persistent
state schématu, authority/binding topology a u Buddyho Zulip PostgreSQL majoru.
Artifact id a Git HEADy jsou auditní provenience, ne podmínka kompatibility.
Budoucí recover dostane vlastní aditivní, jednorázový Plan/Permit kontrakt až
po clean-host restore, revocation a recovery-key drillu. Musí nejdřív
zkonvergovat aktuální desired state a živou autoritu; ze checkpointu nikdy
neoživí odvolané bindingy ani credentials.

`rebuild` je orchestrace přes provider boundary: provision blank hostu,
Resident Deploy a teprve potom autorizovaný recover. Není to Resident verb a
nesmí schovat nákup, smazání nebo nahrazení VPS za `apply`. Dokud tyto brány
nejsou doložené, oba Managed Resident Profily zůstávají `shaping`. Konkrétní
custody pravidla a promotion gates drží verzovaný Machines release v
`docs/resident-machines.md`.

## 4. Legacy assisted Buddy update

Použij exact artefakt a jeho `.sha256` sidecar z jednoho reviewovaného release.
Produkční Buddy rollout spouštěj z exact operator kitu nebo přes reviewovaný
Ansible playbook. Samotný resident updater mění pouze verzovaný Lazurio Root;
`buddy-rollout` navíc skládá Hermes a bridge service gate do jedné kompenzované
operace.

Přímý servisní tvar je:

```sh
sudo bun /cesta/k/operator-kitu/runtime/buddy-rollout.mjs update \
  --archive /cesta/k/lazurio-resident-buddy-VERSION-linux-x64.tar \
  --checksum /cesta/k/lazurio-resident-buddy-VERSION-linux-x64.tar.sha256 \
  --install-root /opt/lazurio \
  --channel candidate \
  --mount-source personalspace=/existujici/personalspace \
  --environment-file /existujici/custody/buddy-bridge.env \
  --hermes-root /opt/buddy-runtime/hermes \
  --bun /absolutni/cesta/k/bun
```

Placeholdery nikdy nevyplňuj odhadem. Operator kit, Bun, Personalspace,
EnvironmentFile a Hermes checkout jsou vstupy konkrétní instalace; jejich
existenci a oprávnění musí preflight skutečně přečíst.

Úspěch znamená současně:

- digest, manifest, profil a kompatibilita prošly;
- nový root byl rozbalen vedle předchozího;
- Personalspace zůstal stejným mutable mountem;
- Resident Doctor prošel;
- Hermes health prošel;
- bridge se čerstvě zaregistroval;
- `active` ukazuje na očekávaný artifact id.

Samotný zelený příkaz, běžící systemd unit nebo existence nového adresáře není
postačující důkaz.

## 5. Legacy rollback

Při selhání před přepnutím zůstává původní active verze beze změny. Selže-li
service gate po přepnutí, `buddy-rollout` se pokusí vrátit předchozí active root
i jeho service vstupy.

Explicitní návrat na last-known-good:

```sh
sudo bun /opt/lazurio/active/resident/updater.mjs rollback \
  --install-root /opt/lazurio --profile buddy
```

Potom znovu ověř status, Hermes health a čerstvou registraci bridge. Rollback
nikdy nemaže Personalspace, Organization checkouty ani starší verzované rooty.
Obnova secrets, dat nebo přístupů je jiná operace a vyžaduje přesný souhlas
Principála.

## 6. Kdy použít Managed operator plane místo updateru

Vrať se k operator runbooku, když je problém v některé z těchto vrstev:

- chybějící nebo poškozený OS package, účet, filesystem či síť;
- změna pinu nebo materializace Hermesu či GBrainu;
- nefunkční systemd/launchd základ mimo resident service cutover;
- obnova celé Mašiny, custody souborů nebo zálohy;
- první instalace na blank host.

Updater není Ansible a Ansible není updater. Managed operator plane konverguje
Mašinu, Resident controller skládá její runtime a updater atomicky spravuje
jednu aktivní verzi Lazurio Rootu. Doctor pozoruje artefaktovou hranici;
`lazurio-resident-status` dokazuje health celé Managed kompozice.
