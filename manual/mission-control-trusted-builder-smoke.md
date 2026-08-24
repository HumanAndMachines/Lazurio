# Mission Control trusted Builder smoke

`bun run mission-control:smoke` je živý, read-only audit Mission Controlu ve
všech lokálně namountovaných Organizacích Lazuria. Není součástí běžného
Builder publish hot pathu a nevytváří druhé ACL. GitHub členství, Teamy a repo
granty zůstávají jedinou autoritou zápisu.

Smoke z worktree automaticky najde primární checkout stejného Lazurio repa;
prázdný checkout bez Organizací vždy selže, aby nemohl vrátit false green.
Jiný přesný root lze předat jen explicitně:

```sh
bun run mission-control:smoke
bun scripts/mission-control-trust-smoke.mjs --workspace-root /exact/Lazurio/root
```

Audit používá stejný trusted GitHub provider seam jako Organization activation:
přesně nalezené `gh`, spuštění bez shellu, sanitizované prostředí a
strukturované chyby. Vyžaduje přihlášení s právem číst privátní repa, jejich
collaboratory, branch protection a repo/org rulesety. Pro důkaz, že 404 opravdu
znamená neexistující privátní repo, vyžaduje aktivní Organization Owner roli;
bez ní 404 selže zavřeně jako neověřený stav. Audit ověřuje zejména:

- lokální Organization root, jeho živý GitHub owner a `mission-control-data`
  jsou svázané přes immutable Organization/repository ID; přejmenovatelný
  login nebo URL slouží jen jako locator;
- planned slot bez dosud zapsané URL používá standardní název
  `mission-control-data` pouze k read-only lookupu pod živě ověřeným ownerem;
  výsledek se přijme až po shodě immutable Organization/repository ID;
- deklarovaný active/planned stav odpovídá živé existenci data repa; jen
  GitHub 404 potvrzené aktivní Owner rolí znamená „repo neexistuje“, jiné
  chyby audit zastaví;
- `provider-enforced` zakazuje force push, delete a bypass buď klasickou
  branch protection, nebo efektivním repo/org rulesetem;
- silnější nativní GitHub policy — například povinný PR, status checks,
  podpisy nebo workflow gate — je platný růstový stav. Smoke ji popíše jako
  `native-gated`, ale nezakazuje ji ani všem Organizacím nepředepisuje jediný
  publish režim;
- v `trusted-process` je každý lidský GitHub collaborator s write právem
  pozitivně potvrzeným členem Organizace; nelidský collaborator audit zastaví.

Smoke není druhý IAM ani úplný credential audit. Počet writerů vychází z
GitHub collaborators API; write-enabled deploy keys, instalace GitHub Apps a
workflow tokeny záměrně neinventarizuje. Ty spravuje Organization Admin v
nativních GitHub surfaces a před přidáním takové unattended write cesty musí
aktivovat `provider-enforced` ochranu.

Výstup vždy ukazuje skutečný počet writerů. Číslo není druhý ACL ani hardcoded
limit: Organization Admin posoudí, kdy kruh přestává být malý a osobně
dohlédnutelný. Před přidáním automatizace, externího writera nebo jiným
materiálním rozšířením aktivuje placený plán a `provider-enforced` ochranu.

Organization-internal kontrakty — data schema, reference, supersession cykly,
writer mode a app/data parita — vlastní Organization doctor a CI data repa.
Kanonický repository-db validator zůstává Organization-owned semantic gate,
který Lazurio worktree kontrola spouští izolovaným CLI procesem. Root smoke
jeho sémantiku znovu neimplementuje ani negrepuje vzdálený source kód a prózu.

`STAGED` znamená, že privátní data repo už existuje, ale manifest ještě
neaktivoval writer. `planned` znamená, že repo není materializované. Ani jeden
stav nesmí předstírat aktivní publikaci. Live audit je záměrně oddělený od
offline `bun run check`; unit kontrakt smoke helperů je jeho součástí jako
`bun run mission-control:smoke:test`.
