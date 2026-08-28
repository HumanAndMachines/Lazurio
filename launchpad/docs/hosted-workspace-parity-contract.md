# Hosted Workspace machine parity contract

Tento kontrakt je centrální acceptance vstup pro Iotor a další Hosted Team
Workspace lane. Nemění provider, Compose, DNS ani přístupy. Stejný verzovaný
runner sbírá důkaz, že localhost a hosted profil používají stejnou
builder-visible filesystem/process topologii, ale správný lifecycle profil.

Jde o sdílenou vývojovou dílnu, nikoli produkční deployment. Modulový source
zůstává editovatelný, proces se může při práci restartovat nebo hot reloadovat
a katalogový origin je privátní DEV preview uvnitř schváleného Tailscale/VPN
access plane. Produkční Build má vlastní immutable artefakt a runtime bez
Launchpadu, T3, Codexu, dev checkoutů a worktrees.

Produkční lane začíná chráněným source commitem nebo tagem, vytváří immutable
artefakt a nasazuje jej do izolovaného produkčního runtime s explicitním
`public | authenticated | internal` ingressem. Produkční runtime neobsahuje T3,
Codex ani Launchpad a Dashboard jej smí projektovat jen z ověřeného deployment
katalogu, nikdy z Workspace service katalogu.

## Jedna runtime autorita, dva DEV profily

Jeden Team Workspace obsahuje jeden non-root pracovní kontejner se společným
userem, `$HOME`, filesystemem, PID a network namespace pro T3 Code, Codex CLI,
Launchpad, `~/Lazurio`, Organization mounty, worktrees a modulové child procesy.
Tenký init/supervisor obnovuje jen T3 a Launchpad. Nesmí znát app id, source,
URL ani reconcile pravidla; Launchpad zůstává jediným ownerem modulových
procesů. Tailscale a autentizovaný HTTPS ingress jsou infrastrukturní sidecary.
T3 Code a Launchpad jsou `desired-running`; supervisor hlídá pouze T3 Code a
Launchpad. Dashboard Development projektuje pouze jejich stabilní vstupy a
modulový lifecycle nevlastní.

- localhost je session-scoped: restart Launchpadu ukončí všechny managed
  aplikace a nic neobnoví;
- Hosted Team Workspace je always-on dílna: immutable
  `lazurio.team_service_catalog.v2` deklaruje, které DEV preview služby a z
  jakého exact source Launchpad drží zapnuté;
- katalogové kliknutí persistentní intent nemění. `Stop` ani `Switch` nejsou
  pro katalogovou službu povolené; odstranění služby znamená publikovat novou
  revizi katalogu bez ní.

`lazurio.runtime.v1` dál popisuje jen runnable listenery pro Launchpad a Doctor
a jejich vývojový lifecycle. Není deployment, ingress, identity ani MCP
kontraktem produkce.

## Katalog v2

Hosted proces má `LAZURIO_WORKSPACE_PROFILE=hosted`, exact `LAZURIO_TEAM_ID` a
generovaný `LAZURIO_TEAM_SERVICE_CATALOG_JSON`. Katalog váže právě jednu
namountovanou Organizaci a Team. Každá služba nese unikátní `app_id`,
`module_lease_key`, čistý HTTPS `external_origin` a exact source:

- `{ "type": "main" }`; nebo
- `{ "type": "worktree", "slug": "...", "mission_control_plan_code":
  "DEV-...", "branch": "..." }`.

Launchpad před startem ověří Organization, Team membership, discovery a
module lease. Worktree musí současně souhlasit s canonical sidecarem, Mission
Control plánem i branchí; rozpor je permanentní `blocked`, nikdy fallback na
main. Efektivní katalog je součástí Server identity, takže nová revize nemůže
reuseovat Server nastartovaný se starým intentem.

Control plane publikuje readiness dřív než jednotlivé služby. Každá služba má
vlastní reconcile stav. Přechodná chyba se opakuje neomezeně s capped backoffem
a jitterem; trvalý contract/dependency problém zůstane `blocked`. Boot nikdy
neinstaluje balíčky. Náprava je explicitní `Install`/`Repair` nebo
`POST /api/hosted/services/<app-id>/retry`.

Ingress používá `GET /api/hosted/services/<app-id>/readiness`: zdravá služba
vrací `200`, start/backoff/blocked řízené `503` a `Retry-After`. Odpověď
projektuje jen schválený HTTPS origin, ne interní loopback URL. Souhrn poskytuje
`GET /api/hosted/services`.

Schéma v1 a `LAUNCHPAD_HOSTED_APP_URLS_JSON` jsou jen dočasná read-compatible
migrační lane. V2 canary je nesmí vydávat za source of truth.

## Runner

Runner žije v `launchpad/src/workspace-parity-runner.mjs`. Hosted live důkaz:

```bash
bun run parity:workspace -- \
  --profile hosted \
  --phase live \
  --organization IotorLazurio_GEN3 \
  --app-id <app-id> \
  --worktree-slug <t3-created-canonical-slug> \
  --expected-worktree-created-by <t3-creation-identity> \
  --launchpad-url http://127.0.0.1:4174 \
  --expected-origin https://<exact-team-origin>/ \
  --expected-catalog-revision <immutable-revision> \
  --t3-pid <pid> \
  --codex-pid <pid> \
  --launchpad-pid <pid>
```

Lokální běh používá `--profile local` a nevyžaduje catalog revision, external
origin ani PID namespace evidence. Oba profily používají builder-visible
`~/Lazurio`; jiný root je fail, ne runner override.

Hosted `live` a `post-restart` nic neotevírají ani nepřepínají. Ověřují:

1. `$HOME`, non-root UID, Organization mount, toolchain, discovery a Doctor;
2. `lazurio.module.v1`/`lazurio.runtime.v1` static lease;
3. Launchpad-visible worktree, ownership a exact T3 `created_by` provenienci;
4. katalogovou revizi, exact worktree source, managed/current-instance health
   a schválený external origin přes readiness API;
5. společný UID, HOME, PID a network namespace T3, Codexu, Launchpadu,
   runneru a modulového child procesu;
6. lokálně pozorovatelnou negativní security matrix.

## Restart, reboot a odstranění

1. Ulož JSON evidence z `--phase live`.
2. Restartuj celý pracovní kontejner; tenký init obnoví T3 a Launchpad.
3. Spusť `--phase post-restart` se stejnou katalogovou revizí. Služba musí být
   zdravá na exact source bez `/open`.
4. Proveď host reboot a po návratu zopakuj `post-restart`.
5. Publikuj novou immutable revizi katalogu bez testované služby a restartuj
   Launchpad. Graceful replacement ukončí managed child staré revize.
6. Spusť `--phase expect-removed` s novou revizí. Runner musí potvrdit absenci
   služby v katalogovém summary, `managed=false`, `status=stopped`, žádného port
   ownera, neúspěšný health probe a nedosažitelný raw TCP listener přes
   deklarovaný host i aliasy `127.0.0.1` a `::1`.

Chybějící, invalidní nebo již nevlastněný worktree v aktivním katalogu je
`blocked`; jakýkoli fallback na main je failure. `--stop-after` je pro hosted
katalog záměrně zakázaný.

## Negative security matrix a vnější důkazy

Runner uvnitř kontejneru vyžaduje absenci Docker/Tailscale LocalAPI/Caddy admin
socketů, GitHub App private key, host mountů, passwordless sudo a efektivních
Linux capabilities. Zvenku musí infra lane doložit:

- autentizovaný Team HTTPS/WSS ingress na 443;
- že origin je privátní DEV preview, nikoli public production endpoint;
- že module port není přímo dosažitelný přes Tailnet/VPN;
- cross-Team izolaci filesystemu, procesů i ingressu;
- broker deny pro repo mimo generovaný Team allowlist;
- skutečný host reboot před post-restart evidencí.

Infra lane připne exact centrální commit a přiloží JSON runneru i vnější důkazy
ke gate `workspace_machine_parity_live_apply`. Teprve úplný green evidence set
dovoluje gate změnit; centrální PR sám live apply neautorizuje.
