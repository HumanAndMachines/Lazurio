# Cizí tailnety na stanovišti: jeden tailscaled na tailnet

Linuxové Pracovní Prostředí, které pracuje ve více tailnetech zároveň
(stanoviště LazurioDevelopment, 0217), drží každý cizí tailnet ve vlastním
kontejneru s vlastním `tailscaled`. Každé vlákno si tailnet volí u každého
příkazu, nic se nepřepíná globálně a vlastní tailnet Prostředí zůstává
nedotčený. Model zvolil Matěj 2026-10-31 (dodatek 0217, plán DEV-6691);
nástroj je `bun run tailnet` (`scripts/tailnet/`), guard
`scripts/hooks/system-tailnet-guard.mjs`.

## Proč

- Na počítači sdílela všechna vlákna agentů jeden globální profil Tailscale.
  Přepnutí profilu kvůli jednomu tailnetu odpojilo všechna ostatní vlákna.
- Headless klienti (`tailscaled --tun=userspace-networking`, jeden na
  tailnet, SSH přes `ProxyCommand tailscale --socket=<socket> nc %h %p`)
  přepnutí nepotřebují, ale nerozliší split DNS: SOCKS5 a HTTP proxy
  userspace `tailscaled` překládají jména mimo MagicDNS resolverem hostu, ne
  přes 100.100.100.100. Ověřeno ve zdrojích Tailscale; oprava z 2026-10-29
  (commit 96467f7d16) platí jen pro tsnet. Webové aplikace dostupné jen
  z tailnetu proto potřebovaly ručně stavěné mosty a mapy adres.
- Stanoviště má dát každému vláknu současný, deterministický přístup do
  kteréhokoli cizího tailnetu s plným DNS, vybíraný příkazem, a nikdo nesmí
  nic přepnout pro ostatní.

## Model

Každý cizí tailnet `<name>` (`^[a-z0-9][a-z0-9-]{0,38}$`) má:

| Co | Kde |
| --- | --- |
| `tailscaled` v kernel módu (`--tun=tailscale0`) | kontejner `lazurio-tailnet-<name>`, `--restart unless-stopped`, `NET_ADMIN`, `NET_RAW`, `/dev/net/tun` |
| vlastní síť | Docker bridge `lazurio-tailnet-<name>`; kontejnery různých tailnetů na sebe nevidí |
| image | oficiální `tailscale/tailscale:v<verze>` připnutý digestem; výchozí verze je `tailscale version` hostu |
| stav (klíče uzlu) | `/var/lib/lazurio-tailnets/<name>/state` (root, `0700`) → `/var/lib/tailscale` |
| socket | `/var/lib/lazurio-tailnets/<name>/run/tailscaled.sock` → `/var/run/tailscale` |
| entrypoint | `/var/lib/lazurio-tailnets/<name>/entrypoint.sh`, jen pro čtení |
| uživatelé | `/etc/passwd` a `/etc/group` hostu jen pro čtení, aby `--operator=<uživatel>` platil a uživatel používal socket bez sudo |
| proxy | SOCKS5 (`1055`) a HTTP (`1056`) publikované jen na loopback hostu, porty po dvojicích z 10550–10649, zapsané v konfiguraci |
| konfigurace | `~/.config/lazurio/tailnets/<name>.json` (`0600`): login server, jméno uzlu, operátor, digest image, porty |

Proč kontejner a ne další `tailscaled` na hostu: Linuxový DNS manager
`tailscaled` zálohuje `resolv.conf` vedle něj v `/etc` a při zavření může
restartovat systemd-resolved. Více instancí nad jedním `/etc` by se praly;
kontejner má vlastní síťový namespace i vlastní `/etc`.

Proč `/var/lib/lazurio-tailnets` a ne `/var/lib/lazurio/tailnets`:
`/var/lib/lazurio` je na Prostředí jen pro roota (`0700`) a patří jiným
službám, takže socket pod ním by bez sudo nebyl dosažitelný. Proč ne `/run`:
Docker při startu Mašiny obnovuje bind mounty a adresář v `/run` by po
restartu chyběl.

**Entrypoint** před spuštěním `tailscaled` přidá v namespace kontejneru
`unreachable` routy pro `100.64.0.0/10` a, je-li tam IPv6,
`fd7a:115c:a1e0::/48`. Adresa z rozsahu tailnetu, která není peerem právě
tohoto tailnetu, tak selže hned a neodteče přes Docker NAT do vlastního
tailnetu hostu (adresy `100.64.0.x` se v každém tailnetu opakují). Peery to
neblokuje: `tailscaled` drží jejich routy v tabulce 52 za pravidlem 5270,
které se čte před `main` (32766).

**Nastavení uzlu** aplikuje `up` pokaždé stejně (`tailscale up --reset`):
`--accept-dns=true` (bez CorpDNS odpovídá 100.100.100.100 jen na záznamy
MagicDNS, ne na split DNS; v kontejneru mění jen jeho `resolv.conf`),
`--shields-up=true`, `--accept-routes=false`, žádný exit node,
`--ssh=false`, `--operator=<uživatel>`, `--hostname=<uzel>` a
`--login-server=<url>`. Mezi tailnety nic neroutuje.

**Vlastní tailnet Prostředí** (systémový `tailscaled` na
`/run/tailscale/tailscaled.sock`, jehož síť spravuje Machines) nástroj nikdy
nemění: `doctor` z něj jen čte. Před omylem ho chrání guard (oddíl Guard).

## Příkazy

`bun run tailnet -- <příkaz>` z rootu. `bun run` spouští skript v kořeni
repozitáře; `run` a `ssh-proxy` proto volej cestou ke skriptu, například
`bun ~/Lazurio/scripts/tailnet/cli.mjs run …`, aby zůstal pracovní adresář.
Na stanovišti leží root v productionspace LazurioDevelopment (0217).

| Příkaz | Co dělá |
| --- | --- |
| `up <name> --login-server <url> --hostname <uzel> [--adopt-state <statedir>] [--image <ref>]` | Připraví adresáře, síť a kontejner a aplikuje nastavení uzlu. Opakované `up` nic nerozbije; kontejner jiné verze nástroje znovu vytvoří, stav zůstane. Čeká-li uzel na přihlášení, vypíše odkaz a skončí kódem 3. Klíče nikdy nevypisuje. |
| `status [<name>] [--json]` | Kontejner, stav uzlu, počet peerů, odkaz k přihlášení, proxy. |
| `doctor [--json]` | Kontroly níže; vlastní tailnet Prostředí jen čte (počet profilů, ControlURL). Kód 1, když povinná kontrola selže. |
| `run <name> -- <příkaz…>` | Spustí příkaz jako uživatel uvnitř tailnetu (viz níže). |
| `proxy <name> [--json]` | `socks5h://127.0.0.1:<port>` a `http://127.0.0.1:<port>` pro prohlížeč a nástroje s proxy. |
| `ssh-proxy <name> <host> <port>` | Pro `ProxyCommand`: ověří, že daemon na socketu tailnetu je přihlášený k zapsanému login serveru, a spustí `tailscale --socket=<socket> nc`. |
| `down <name>` | Zastaví a odstraní kontejner a síť. Stav a konfigurace zůstanou, `up` vrátí tentýž uzel. |

Příklady (zástupná jména):

```sh
bun run tailnet -- up example-org --login-server https://headscale.example.lazurio.io --hostname <login>-<zařízení>-cli
bun run tailnet -- doctor
bun ~/Lazurio/scripts/tailnet/cli.mjs run example-org -- curl -sS https://app.example-host.example-org.lazurio.io
bun run tailnet -- proxy example-org
```

SSH na Mašinu v cizím tailnetu dál bere identitu z Machine Recordu owning
Organizace (pinnutý host klíč přes `HostKeyAlias` a vlastní
`UserKnownHostsFile`, AGENTS.md); mění se jen `ProxyCommand`:

```text
ProxyCommand bun ~/Lazurio/scripts/tailnet/cli.mjs ssh-proxy example-org %h %p
```

Prohlížeč a nástroje s proxy: Chromium s
`--proxy-server=socks5://127.0.0.1:<port>` překládá jména přes proxy, curl
s `--proxy socks5h://127.0.0.1:<port>`, nástroje jen s HTTP proxy
s `HTTPS_PROXY=http://127.0.0.1:<port>`. Proxy běží v namespace kontejneru,
takže jména překládá přes 100.100.100.100 včetně split DNS.

Návratové kódy: 0 hotovo, 1 selhání, 2 použití nebo nepodporovaná platforma,
3 `up` čeká na přihlášení nebo schválení. `run` a `ssh-proxy` vrací kód
spuštěného příkazu. Na macOS nástroj skončí kódem 2: počítač si nechává své
headless klienty s jejich omezením DNS.

### Co přesně dělá `run`

1. Při každém volání zjistí PID kontejneru (po restartu je jiný) a ověří,
   že PID pořád patří tomuto kontejneru.
2. Přes `sudo` a `nsenter --net` vstoupí do síťového namespace tailnetu
   a `unshare --mount --propagation private` mu dá soukromý mount namespace,
   takže nic z dalších kroků nevidí zbytek Mašiny.
3. Přes `/etc/resolv.conf` připojí `resolv.conf` kontejneru (Docker
   `ResolvConfPath`; `tailscaled` ho přepisuje na místě) a přes
   `/run/tailscale` socket tailnetu. Holé `tailscale` uvnitř `run` tak mluví
   s tímto tailnetem, ne s vlastním tailnetem Prostředí.
4. `setpriv` vrátí uživatele a jeho skupiny. Přesné prostředí volajícího,
   umask a `LAZURIO_TAILNET=<name>` přenese soubor `0600`, který se hned
   po načtení smaže; `sudo` by jinak přepsalo `PATH`, `USER` a `HOME`
   a zahodilo proměnné jako `PYTHONPATH` nebo `LD_LIBRARY_PATH`.
5. Pracovní adresář, stdin, stdout a návratový kód zůstávají příkazu.

## Záruky

- Nic se nepřepíná globálně. Vlastní `tailscaled` Prostředí zůstává jeden
  s jedním profilem; každý cizí tailnet má vlastní daemon, stav, socket
  a síťový namespace.
- Tailnet volí příkaz: `run <name>`, proxy daného tailnetu, nebo socket
  daného tailnetu.
- Mezi tailnety nic neroutuje: žádné subnet routy, exit node ani
  přeposílání, každý kontejner má vlastní bridge.
- Proxy jsou jen na loopbacku hostu.
- Adresa tailnetu, která není peerem daného tailnetu, selže hned.
- Stav uzlu přežije restart i znovuvytvoření kontejneru a restart Mašiny.

## Co to není

- **Bezpečnostní hranice mezi vlákny jednoho Prostředí to není.** Všechna
  vlákna běží pod tímtéž uživatelem s plným přístupem (0172), sudo a Dockerem
  a každé smí použít kterýkoli tailnet. Hranicí je Prostředí; kdo potřebuje
  tvrdou hranici, dostane samostatné Prostředí.
- Most mezi tailnety to není a správa vlastního tailnetu Prostředí také ne
  (Machines).
- Na počítači se nepoužívá: macOS si nechává headless klienty a jejich
  omezení DNS.

## Převzetí existujícího headless klienta

Uzel si zachová identitu (klíč uzlu ve stavu), takže Admin cizího tailnetu
nic znovu neschvaluje:

1. Zjisti statedir klienta (`--statedir` v jeho jednotce), login server
   a jméno uzlu.
2. Zastav jeho jednotku. `up --adopt-state` odmítne stav, který ještě
   používá běžící `tailscaled`: dva daemony s jedním klíčem uzlu se o uzel
   perou.
3. `bun run tailnet -- up <name> --login-server <url> --hostname <stejné jméno uzlu> --adopt-state <statedir>`.
   Stav se zkopíruje do prázdného stavového adresáře tailnetu; do
   neprázdného `up` nekopíruje.
4. `bun run tailnet -- doctor`, pak přepni `ProxyCommand` a proxy na nové
   příkazy.
5. Starý statedir nech, dokud nový uzel neprojde ověřením; starý klient už
   nikdy nesmí běžet souběžně s novým.

## Guard

`scripts/hooks/system-tailnet-guard.mjs` je PreToolUse hook pro Claude Code
a Codex se stejným protokolem a chováním jako custody guard
(`manual/security/local-secret-custody.md`): při shodě vrátí `deny`,
jinak nic, a při vlastní chybě příkaz pustí (fail open). Přepínač ani
proměnná ho nevypnou.

- **Zamítne** `tailscale up|down|login|logout|switch|set|set-operator|serve|funnel|update`
  bez `--socket` nebo se systémovým socketem; `systemctl
  stop|restart|try-restart|reload-or-restart|force-reload|kill|disable|mask`
  jednotky `tailscaled` (ne `--user`); `service tailscaled stop|restart`;
  `pkill` a `killall`, jejichž vzor zasáhne systémový `tailscaled`. Vidí
  skrz `sudo`, `env`, `timeout` a podobné obaly, `sh -c`, `su -c`, `eval`,
  command substitution a skript poslaný shellu na stdin.
- **Pustí** čtení (`status`, `ping`, `netcheck`, `ip`, `whois`, `version`,
  `dns status`, `debug prefs`, `switch --list`, `serve status`,
  `funnel status`, `update --dry-run`, nápovědu), cokoli se `--socket`
  mimo systémový socket a `bun run tailnet -- …`. Nevidí příkaz složený až
  za běhu, skript spuštěný cestou ani příkaz na jiném stroji (`ssh`) či
  v jiném kontejneru (`docker exec`).

Instalace je uživatelská jako u custody guardu: v `~/.claude/settings.json`
další položka `hooks.PreToolUse` s matcherem `Bash|Monitor`, v
`~/.codex/hooks.json` s matcherem `Bash` (Codex hook schvaluje člověk), a
příkaz, který bez Bunu nebo skriptu nic neudělá:

```sh
B="$HOME/.bun/bin/bun"; [ -x "$B" ] || B="$(command -v bun)"; S="$HOME/Lazurio/scripts/hooks/system-tailnet-guard.mjs"; [ -n "$B" ] && [ -f "$S" ] && exec "$B" "$S"; exit 0
```

Na stanovišti `S` míří do rootu v productionspace LazurioDevelopment, stejně
jako custody guard.

## Ověření

`bun run tailnet -- doctor` pro každý tailnet ověří: kontejner běží
s `unless-stopped` a připnutým image; uzel je `Running`; ControlURL je
zapsaný login server; jméno uzlu a operátor sedí; `ShieldsUp`,
`RouteAll=false`, `CorpDNS=true`, žádný exit node, Tailscale SSH vypnuté;
v namespace je `unreachable 100.64.0.0/10`; proxy jsou publikované jen na
`127.0.0.1` a SOCKS5 odpovídá; `resolv.conf` kontejneru má jediný
nameserver 100.100.100.100. Varováním hlásí chybějící IPv6 route,
nedostupný socket bez sudo a kontejner ze starší verze nástroje. Vlastní
tailnet Prostředí jen čte: jeden profil a jeho ControlURL.

Ruční průchod:

```sh
bun ~/Lazurio/scripts/tailnet/cli.mjs run example-org -- cat /etc/resolv.conf   # nameserver 100.100.100.100
bun ~/Lazurio/scripts/tailnet/cli.mjs run example-org -- ip route get 100.64.200.200   # unreachable, není-li to peer
tailscale --socket=/var/lib/lazurio-tailnets/example-org/run/tailscaled.sock status   # bez sudo
```

## Selhání a co s nimi

- **Kontejner spadne:** Docker ho podle `unless-stopped` spustí znovu, PID
  se změní a `run` si ho zjistí. Trefí-li se `run` přesně do restartu,
  skončí kódem 125; stačí ho zopakovat.
- **Restart Dockeru:** bez `live-restore` (výchozí stav) restart `dockerd`
  zastaví a znovu spustí všechny kontejnery, tailnety na chvíli vypadnou
  a samy se vrátí. S `live-restore` běží dál.
- **Restart Mašiny:** Docker kontejnery spustí sám; mounty jsou z `/var/lib`
  a entrypoint routy přidá znovu.
- **Chybí schválení Admina:** uzel je `NeedsLogin` a `up` i `status`
  ukážou odkaz k přihlášení. Schválený uzel bez grantů je `Running` s nula
  peery; to opraví grant Admina té Organizace, ne tento nástroj.
- **Tailnet nenabízí split DNS:** jména mimo MagicDNS se přeloží jen tehdy,
  když je Admin tailnetu nastaví; ostatní jména 100.100.100.100 pošle
  resolveru Dockeru, tedy do veřejného DNS.
- **Login server za adresou z `100.64.0.0/10`** (dosažitelný jen přes jiný
  tailnet) je z kontejneru úmyslně nedosažitelný.
- **Nová verze Tailscale:** `up … --image tailscale/tailscale:v<verze>`
  připne nový digest a kontejner znovu vytvoří; stav zůstane.
- **Změní se `/etc/passwd` hostu** (nový uživatel): kontejner vidí soubor
  z doby spuštění; `docker restart lazurio-tailnet-<name>` načte nový.
