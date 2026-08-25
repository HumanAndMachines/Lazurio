# Lazurio Core

Tato složka je jediná interní vlastnická hranice pro doménovou logiku, kterou
sdílí Lazurio CLI a Launchpad. Je součástí stejného repozitáře a není veřejným
ani verzovaným API.

Core smí importovat jen Node/Bun standardní knihovny a jiné Core moduly. Nesmí
importovat Lazurio CLI, search adapter, Launchpad server, UI ani runtime
composition. Směr závislosti je vždy opačný: surfaces importují Core.

První behavior-preserving řezy vlastní klasifikaci Organization repository
slotů, jejich normalizovanou katalogovou prezentaci, kanonickou filesystem
containment hranici, deklaraci Modulu a čistý kontrakt runtime deklarace
Modulové aplikace.
`resolveModuleApplications()` je jediný vlastník vazby deklarovaný Modul → jeho
Apps → výchozí lokální open target. Konzumenti spojují záznamy přes kanonickou
cestu kořene Modulu; katalogový slug ani UI pořadí nejsou identita.
`server-identity-lib.mjs` vlastní oddělenou identitu Rootu, přesné instalace a
běžící Server instance. Jediný deterministický digest runtime zdrojů je
install generation pro source checkout i directory-only instalaci; Server jej
zmrazí při bootu a launcher smí znovu použít jen exact compatible identitu.
`cli-provenance-lib.mjs` je jediný vlastník rozlišení development Git checkoutu
a immutable Resident instalace. Smí číst pouze lokální Git metadata nebo
`lazurio.resident.json`; současný výskyt obou markerů je konflikt, ne fallback.
Úplný tvar Resident manifestu vlastní `resident-manifest-lib.mjs`; provenance,
Doctor, build i updater používají tentýž validátor.
`install-core-lib.mjs` vlastní jedinou read-first sekvenci capability probes a
locale-neutral instalační stav pro CLI, Agent JSON a budoucí GUI. Nemá registry
kroků, dependency DAG ani persisted workflow; UI, překlady, consent dialogy a
veřejná serializace zůstávají v površích nad Core.
`organization-activation-lib.mjs` vlastní čisté odvození živých GitHub,
repository a resolver faktů na tři veřejné outcomes. Nevolá síť ani GitHub CLI,
neukládá desired state a nemá workflow engine. Povrchový provider adapter pouze
načte read-only fakta a Core nikdy nezamění technické selhání za známý stav
Organization. Legacy identity-pair resolver je úzká compatibility kontrola;
canonical manifest parser zůstává u DEV-6488 a activation jej neduplikuje.
`organization-scaffold-lib.mjs` vlastní jediný čistý GEN3-compatible baseline
generátor pro budoucí explicitní activation writer. Přijímá až živě ověřené
immutable Organization/repository ID, zapisuje je do kořenového Forge bindingu
a vrací předem validovatelný, deterministický Git tree. Nevolá provider, Git ani
filesystem a nevytváří activation profil, registry nebo druhý manifest reader.
`github-provider-lib.mjs` vlastní jediný read-only GitHub CLI transport pro
Lazurio Core. Vybere přesnou důvěryhodnou executable, pustí ji bez shellu se
sanitizovaným prostředím a vrací strukturované transport/HTTP/response chyby.
Organization activation i cross-Organization audity tento seam konzumují;
nespouštějí ambientní `gh` ani si nevedou vlastní provider lane.
`ui_exposure` zůstává pouze prezentační policy; nevytváří identitu resource ani
access autoritu. Další doménové vrstvy se přesunují samostatnými PR až nad
zeleným parity baseline; fyzický přesun souboru sám nesmí měnit schéma ani
chování.

Search, QMD, Dashboard login, parsery nových příkazů, veřejná schémata a
samostatný runtime proces do Core nepatří. Core smí lokálně ověřit stav GitHub
CLI přihlášení, ale nevlastní login flow, credentials ani GitHub access model.
