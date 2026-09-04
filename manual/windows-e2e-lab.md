# Native Windows E2E lab

Tento runbook je kanonická veřejná procedura pro fyzický Windows 11 consumer
proof Lazuria. Konkrétní notebook, síťová jména, host-key fingerprinty a secret
custody zůstávají v omezeném owner runbooku Organizace, která laboratoř
provozuje; do veřejného Lazuria nepatří.

## Kdy laboratoř použít

Použij ji pokaždé, když výsledek závisí na skutečném Windows chování, zejména
pro:

- fresh, resume, repair, rerun a rollback instalace Lazuria;
- User nebo Machine `PATH`, WinGet, UAC, nové přihlášení a úplný relaunch Codexu;
- Git for Windows, GitHub CLI, OpenSSH, PowerShell a Bun file dependency;
- Launchpad shortcut, procesní lifecycle, zamčené soubory, porty a cleanup;
- reprodukci Windows-only issue nebo ověření přesného PR HEADu.

Windows CI zůstává rychlý regresní gate, ale nenahrazuje Windows 11 notebook,
standardního interaktivního uživatele, UAC, nový proces ani restart. Notebook
naopak není release, dispatch, GitHub ani testovací identita; je pouze jeden
reálný consumer.

## Hranice a autority

- Mašina má vždy jmenovaného Ownera. Je-li osobní, nestává se Organization-owned
  Mašinou, Machine Recordem ani sdíleným Personalspace jen proto, že se používá
  pro produktový test.
- Headscale je pouze privátní management transport. Přístup vyžaduje zvlášť
  ověřený Headscale Admin device, host-side OpenSSH, dedikovaný klíč, připnutý
  host key a úzký firewall. Síťový grant nenahrazuje žádnou z těchto kontrol.
- Privátní SSH klíč žije pouze v ownerově lokální secret custody. Veřejný
  fingerprint a ne-secret locator smí být v omezeném runbooku; klíč, token,
  Headscale enrollment bundle ani auth URL nikdy v Gitu, issue nebo test logu.
- Chrome Remote Desktop nebo provider console jsou bootstrap/recovery fallback,
  ne běžná agentní servisní cesta.
- Výchozí testovací identita je syntetická `LazurioExampleOrganization`. Jiná
  Organization vyžaduje exact task scope a její živá GitHub práva; klientská
  data, Personalspace a produkční secrets se do laboratoře nekopírují.

## Co znamená „resetovatelná“

Owner může v privátním runbooku výslovně označit Lazurio footprint této Mašiny
jako disposable. Takové označení dovoluje po task-specific mandátu odstranit
pouze přesný canonical Root `<home>\Lazurio`, jeho test-owned runtime state,
desktop integraci Lazuria a test-owned temp artefakty.

Nikdy z něj neodvozuj souhlas:

- přeinstalovat nebo resetovat Windows;
- smazat celý uživatelský profil, `Documents`, browser data nebo jiné aplikace;
- odstranit Tailscale/Headscale identity, OpenSSH servisní přístup, GitHub
  přihlášení nebo obecný toolchain;
- použít wildcard, unresolved proměnnou nebo rekurzivní příkaz nad home či
  nadřazeným adresářem.

Před odstraněním read-only prokaž exact absolutní target, že jde o podporovaný
Lazurio Root, a že v něm není cizí nepublikovaná práce. Task Agent zastaví jen
procesy vlastněné tímto Rootem a po resetu znovu prokáže, že mimo exact target
nic nezměnil.

## Připojení a preflight

1. V omezeném owner runbooku zjisti přesný device name, Ownera, DNS jméno,
   uživatele, veřejný fingerprint servisního klíče, host-key fingerprint a
   lokální custody locator. Deklarace sama není důkaz přístupu.
2. Ověř Headscale node jako online, untagged zařízení přes existující
   Admin-device `verify` lifecycle. Nevytvářej vedle něj vlastní inventář.
3. Připoj se klasickým OpenSSH přes Headscale DNS, s `IdentitiesOnly=yes`,
   exact klíčem a `StrictHostKeyChecking=yes`. První host key přijmi jen po
   out-of-band porovnání fingerprintu z Windows.
4. Z čisté SSH relace ověř Windows edici/build/architekturu, skutečný OS home,
   jméno počítače, uživatele, úroveň elevation, stav napájení a dostatek místa.
5. Inventarizuj Root, procesy, User/Machine `PATH`, Git, `gh`, Node.js, Codex,
   Bun, Tailscale, OpenSSH a GitHub identitu. Read-only baseline ulož pouze jako
   sanitizovanou evidenci tasku.

Pokud připojení selže, rozliš transport, policy, firewall, host key a SSH
autentizaci. Neobcházej selhání vypnutím host-key kontroly, otevřením veřejného
portu 22 ani sdíleným univerzálním klíčem.

## Fresh install a repair gate

Použij `.agents/skills/lazurio-workstation-install/SKILL.md` a
`manual/organization-install.md`; tento runbook jejich instalační kontrakt
neduplikuje. Pro skutečný E2E běh navíc dodrž:

1. Zachyť baseline a podle exact mandátu případně odstraň jen disposable
   Lazurio footprint.
2. Instaluj nebo aktualizuj pouze jmenované nástroje z oficiálních zdrojů.
   Git, GitHub CLI a Codex míří na stable, Node na podporované LTS a Bun vždy
   na exact `packageManager` pin clean Lazurio source.
3. Machine `PATH` měň pouze s rozšířeným mandátem, zachovej nesouvisející
   hodnoty a přidej jen canonical instalační adresáře.
4. Fresh Source Root ukotvi v `<home>\Lazurio`, potom spusť podporovanou CLI
   registraci a konvergentně `lazurio install --json`,
   `lazurio doctor --tool-updates --json`, exact Organization install a finální
   `lazurio doctor`.
5. Kroky vyžadující Windows desktop provede jmenovaný Owner nebo Task Agent s
   explicitně autorizovanou aktivní interaktivní relací; samotné SSH je
   neprokazuje. Po PATH/tool změně vykonavatel úplně ukončí všechna okna Codexu,
   spustí nový Codex a z jeho nové relace zaznamená start-time/PID parent procesu,
   efektivní `PATH` a verze nástrojů. Nový child terminál starého Codexu není
   acceptance; bez interaktivního vykonavatele je tento gate `unavailable`, ne
   `pass`, a restart Windows je až fallback.
6. Tentýž interaktivní vykonavatel ověří skutečný Start Menu shortcut a otevření
   Launchpadu; SSH relace samostatně ověří jeho lifecycle/health a vlastnictví
   procesu. Shoda obou důkazů, druhý idempotentní běh a taskem požadovaný restart
   nebo rollback tvoří acceptance. Required `fail`, `blocked`, `incomplete` nebo
   chybějící interaktivní důkaz není dokončená instalace.

## Bug a PR gate

Pro Windows-only bug nejprve reprodukuj stav na `main`, potom ve fresh task
worktree ověř exact PR HEAD a nakonec relevantní negativní scénář. Neměň
primární checkout, nepoužívej pracovní větev jako permanentní CLI/PATH target a
nevynechávej plný root check jen proto, že focused reprodukce prošla.

PR gate nesmí volat permanentně nainstalovaný `lazurio`, protože ten dál patří
canonical `main`. Z kořene exact worktree:

1. ověř `git rev-parse HEAD` proti požadovanému PR SHA a clean stav;
2. spusť `bun run lazurio -- --version --json` a vyžaduj `root_kind: source`,
   stejný commit a `dirty: false`;
3. pouze u příkazu, který podporuje explicitní Root, volej worktree kód jako
   `bun run lazurio -- <příkaz> --root <canonical-root> ...`; výstup musí nést
   očekávaný Root a evidence zaznamená celý argv bez secrets;
4. focused test i `bun run check` spouštěj z téhož exact worktree.

Příkaz, který `--root` záměrně nepřijímá nebo vyžaduje canonical primary source,
se tímto způsobem za nativně PR-ověřený nevydává. Dokud nemá vlastní podporovaný
test harness, zůstává jeho native PR gate `unavailable`; Agent nesmí dočasně
přelinkovat CLI, přesunout Root ani přepnout primary checkout z `main`, aby tuto
hranici obešel.

Issue publikuj do exact owning repa pouze s publikačním mandátem podle
`manual/github-issues.md`. Sanitizuj lokální username, absolutní cesty, device
name, tailnet, IP, host keys, Organization data a secrets. Do issue patří
obecná reprodukce a očekávaný kontrakt; konkrétní lab evidence zůstává v
omezeném task/owner scope.

## Povinný closeout

Výsledek uvádí alespoň:

- exact Windows edici/build/architekturu a standard-user/elevation hranici;
- source/PR HEAD, skutečné verze a canonical cesty nástrojů;
- User/Machine `PATH` a důkaz nového Codex procesu nebo odůvodněný fallback;
- `runtime ready` / `editing ready` / `publishing ready` odděleně;
- install, Organization, Doctor, Launchpad, rerun, restart a rollback výsledek;
- sanitizované issue/PR odkazy a explicitní disposition každého warningu;
- co bylo odstraněno a potvrzení, že reset nepřekročil Lazurio footprint.

Konkrétní notebook je použitelný teprve po současně zeleném Headscale verify,
OpenSSH smoke a owner runbooku. Nedostupnost laboratoře blokuje pouze tvrzení o
native Windows acceptance; sama neautorizuje náhradní simulaci ani změnu
release gate.
