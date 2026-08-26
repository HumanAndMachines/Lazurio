# Module lifecycle přes Lazurio CLI

Tento veřejný kontrakt umožňuje Agentům, starším UI klientům a automatizovaným
smoke testům obsloužit aplikaci Modulu bez vlastního parseru manifestu, portové
mapy nebo process manageru. Autoritou zůstává aktivní Lazurio Server nad
kanonickým Organization checkoutem.

## Předpoklad

Na Mašině musí běžet nainstalovaný Lazurio Launchpad. CLI čte jediný
OS-standard per-user Server locator, ověří přesnou živou Server identitu a
potom používá jeho veřejné HTTP lifecycle rozhraní. Chybějící, nečitelný,
nekompatibilní nebo identity-mismatched Server skončí fail-closed. CLI
nezkouší jiný port a nepřijímá `--root`, protože by tím vznikla druhá volba
Server autority.

## Stav všech explicitně deklarovaných Module Apps

```sh
lazurio module status --json
```

Jeden příkaz vrátí jeden verzovaný snapshot
`lazurio.module_lifecycle.report.v1`. Je určený i pro UI, které periodicky
obnovuje více karet: klient nesmí spouštět jeden CLI proces pro každou kartu.
Snapshot obsahuje pouze Apps, které Core projektuje z explicitních
`apps/default_app` deklarací. Legacy App se do tohoto kontraktu nepovýší.

## Jedna výchozí nebo explicitní App

```sh
lazurio module status Spectoda/invoices --json
lazurio module open Spectoda/invoices --json
lazurio module start Spectoda/invoices --app-package app/v2/package.json --json
lazurio module stop Spectoda/invoices --app-package app/v2/package.json --json
```

Bez `--app-package` CLI přijme pouze právě jednu App označenou Core jako
výchozí. Nevybírá první položku, nejnovější generaci ani App podle názvu.
Selektor Organization/Module je case-insensitive; relativní App package musí
být bezpečná POSIX cesta deklarovaná Module kontraktem.

## Cross-Organization takeover

Když stejný stabilní lease právě používá známá App jiné Organizace, první
`start` nebo `open` vrátí
`cross_organization_takeover_confirmation_required` a přesné
`replace_app_id`. Agent nebo UI musí uživateli pojmenovat nahrazovanou App i
Organizaci. Teprve po jeho výslovném potvrzení smí zopakovat přesně tutéž akci:

```sh
lazurio module open Spectoda/invoices \
  --confirm-replace macano-tech-website-v1 \
  --json
```

CLI potvrzení nikdy nedoplní samo. Server pod Module lockem ověří konkrétního
peera, vypne jeho desired runtime, bezpečně převezme listener a zapíše audit.
`stop` potvrzení nepřijímá a dál ovládá jen current-instance managed proces.

## Exit kódy a report

- `0` — snapshot/status je aktuální nebo akce proběhla;
- `3` — je potřeba bezpečná akce člověka či Agenta (Server není spuštěný,
  selector není aktivní, takeover čeká na potvrzení, App není ready);
- `1` — Server nebo runtime selhal technicky.

Serverová odpověď zůstává beze ztráty v `result`; stabilní obálka nese
`status`, `reason`, `server`, canonical App projekci, `http_status` a
`issues`. Klient má rozhodovat podle reason/error kódů, ne parsovat českou
větu.

## GEN2 compatibility klient

Starší Launchpad smí pro migrovanou kartu držet pouze dočasný selector
`Organization/Module/app-package`. Nesmí současně držet legacy port ani
lokální lifecycle cestu. Selector musí při každém snapshotu existovat v živé
Core projekci; chybějící selector je viditelný blocked stav, nikdy fallback na
starý port. Compatibility vrstva se odstraní s posledním GEN2 klientem a není
šablonou pro nové moduly.
