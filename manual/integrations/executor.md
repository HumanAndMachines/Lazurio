# Executor 1: přímé Integrace Environmentu

Stav ověřen 2026-10-09 na Executoru 1.6.10 (Linux, pilot na jednom pracovním
Environmentu).

Executor je open source MCP brána ([executor.sh](https://executor.sh),
[UsefulSoftwareCo/executor](https://github.com/UsefulSoftwareCo/executor),
licence MIT). V Lazuriu drží přímé Integrace Environmentu a jeho vlastní
MCP servery: Integrace se připojí jednou a všichni agenti v Chatu i boti
v Automate ji dostanou přes jedno napojení. Platí rozhodnutí 0162, dodatek
z 2026-10-09.

## Model

- Executor je povinná součást každého Environmentu a instaluje ho Lazurio.
  Běží jako služba uživatele Environmentu, jen na localhostu. Neběží na
  Conglomerate Hostu, nesdílí se mezi Environmenty a Executor Cloud se
  nepoužívá.
- Lidé Executor ovládají jen z Launchpadu (Apps → Integrace) a do konzole
  Executoru nemají žádný vstup; používají ji agenti a servisní přístup při
  potížích. Dokud stránka Integrace na Environmentu není, platí přechodný
  postup ze sekce MCP servery a připojení.
- Připojení a hesla, která v něm vzniknou, zůstávají v Environmentu. Kdo
  potřebuje jiné přístupy, zakládá další Environment.
- Každá Integrace má v Environmentu jednu cestu: nástrojem z Nastavení →
  Nástroje, přímo přes Executor, nebo přes Composio s vlastním účtem
  člověka ([composio.md](composio.md)), pokud je povolené. Agent ji použije
  v pořadí nástroj aplikace, Executor, Composio.
- Firemní aplikace Google Workspace a Microsoft 365 nastavuje Admin
  v Dashboardu s agentem; do Executoru každého Environmentu se dostanou
  podle rozhodnutí 0194. Pak se Gmail, Outlook a další připojují přímo.
- Teď používáme Executor 1. Na Executor 2 přejdeme, až vyjde stabilní.
  Executor neforkujeme; co nám chybí, posíláme upstreamu.

## Instalace

Instaluj pod uživatelem Environmentu do vlastní složky podle verze. Verze
pak jde vyměnit bez zásahu do ostatních nástrojů.

```sh
V=1.6.10
npm install -g --prefix "$HOME/.local/share/executor-cli/$V" "executor@$V"
ln -sfn "$HOME/.local/share/executor-cli/$V/bin/executor" "$HOME/.local/bin/executor"
EXECUTOR_DISABLE_ANALYTICS=1 executor install
```

`executor install` založí trvalou službu `sh.executor.daemon` (na Linuxu
`systemd --user`) a spustí ji jen na localhostu. V pilotu poslouchá na
`127.0.0.1:4789`; přesnou adresu ukáže `executor service status`. Data jsou
v `~/.executor`. Na Linuxu přidej do služby vypnutí kontroly aktualizací:

```ini
# ~/.config/systemd/user/sh.executor.daemon.service.d/lazurio.conf
[Service]
Environment=EXECUTOR_DISABLE_ANALYTICS=1
Environment=EXECUTOR_DISABLE_UPDATE_CHECK=1
```

Potom `systemctl --user daemon-reload` a
`systemctl --user restart sh.executor.daemon.service`.

- `EXECUTOR_DISABLE_ANALYTICS=1` vypne analytiku.
  `EXECUTOR_DISABLE_UPDATE_CHECK=1` vypne dotaz na novou verzi; verzi
  měníme vědomě.
- `DO_NOT_TRACK=1` nepoužívej. Vypne i stahování katalogu integrací
  z integrations.sh, které posílá jen verzi Executoru, a přidávání
  integrací v konzoli tím přijde o nabídku.
- Aby služba běžela i bez přihlášení, musí mít uživatel zapnutý lingering
  (`loginctl show-user <uživatel> -p Linger`).
- Pilot ověřil Linux. Na macOS vytvoří `executor install` službu launchd;
  postup pro macOS doplníme po ověření.
- Nároky v pilotu: balíček zabere asi 470 MB na disku a běžící služba asi
  250 MB paměti.

## Napojení agentů

Agenti se připojují přes příkaz `executor mcp`. Ten si přístupový token
přečte sám z `~/.executor`, takže se nikam nekopíruje.

```sh
codex mcp add executor --env EXECUTOR_DISABLE_ANALYTICS=1 \
  --env EXECUTOR_DISABLE_UPDATE_CHECK=1 -- "$HOME/.local/bin/executor" mcp
claude mcp add --scope user executor -e EXECUTOR_DISABLE_ANALYTICS=1 \
  -e EXECUTOR_DISABLE_UPDATE_CHECK=1 -- "$HOME/.local/bin/executor" mcp
```

Ověř to přes `codex mcp list` a `claude mcp list`; Claude Code ukáže
„Connected“. Agent pak v Executoru vidí nástroje `skills` a `execute`. Přes
ně najde a zavolá nástroj kterékoli integrace. Boti v Automate se napojí
stejně, jakmile to umí fork MausBotu (plán DEV-6626).

## MCP servery a připojení

Lidé připojují Integrace v Launchpadu (Apps → Integrace); Launchpad k tomu
používá rozhraní Executoru uvnitř Environmentu. **Přechodně, dokud stránka
Integrace na Environmentu není,** připojí Integraci agent jen na výslovný
pokyn člověka příkazovou řádkou. Přihlášení nebo klíč dokončí člověk sám na
stránce, kterou mu agent otevře v prohlížeči Environmentu; jinam do konzole
nechodí:

```sh
executor call executor mcp probeEndpoint '{"endpoint":"https://mcp.example.com/mcp"}'
executor call executor mcp addServer '{"transport":"remote","name":"Example","slug":"example","endpoint":"https://mcp.example.com/mcp","remoteTransport":"auto","auth":{"kind":"none"}}'
executor call executor coreTools connections create '{"owner":"org","name":"default","integration":"example","template":"none"}'
```

- `probeEndpoint` řekne, jestli server potřebuje OAuth a jestli umí
  dynamickou registraci klienta. Takový server (v pilotu například Linear
  nebo Notion) potřebuje jen souhlas operátora v prohlížeči, žádnou
  vlastní OAuth aplikaci.
- Bez dynamické registrace, typicky u Googlu a Microsoftu, je potřeba
  OAuth aplikace Organizace podle runbooku poskytovatele.
- Souhlas dá člověk v prohlížeči Environmentu. Executor vrací přihlášení na
  `localhost`, jinde se nedokončí.
- Klíč nebo token, který služba chce, zadá člověk sám na stránce předání
  (`connections.createHandoff`), kterou mu agent otevře v prohlížeči
  Environmentu; do chatu ho nikdy nepíše.
- Executor ve výchozím nastavení přidání serveru i vytvoření připojení
  pozastaví a čeká na schválení. Výslovný pokyn člověka k připojení je tím
  schválením; agent ho potvrdí příkazem
  `executor resume --execution-id <id> --action accept --content '{}'`.
  Čtecí nástroje v pilotu běžely bez schvalování.
- Schválení v Executoru není souhlas s Publikací. Pro zápisy navenek platí
  sekce Draft a Publikace ve
  [standardu](../external-app-integrations.md#draft-a-publikace-ve-write-operacích).

## Volání nástrojů

```sh
executor tools search "send email"
executor tools integrations
executor call tools <integrace> <owner> <připojení> <nástroj> '<json>'
```

Například
`executor call tools deepwiki org default read_wiki_structure '{"repoName":"owner/repo"}'`.

## Konzole (jen pro agenty a servisní přístup)

Lidé do konzole nechodí a cílově všechno dělají v Launchpadu; přechodně jen
dokončí přihlášení nebo klíč na stránce, kterou jim agent otevře. Agent nebo
servisní přístup ji při potížích otevře v prohlížeči Environmentu na
`http://localhost:4789`; `executor open` ji otevře rovnou přihlášenou.

- Karta „Connect an agent“ ukazuje přístupový token čitelně. Nesdílej
  screenshot ani obrazovku s ní a token z ní nekopíruj; agenti ho
  nepotřebují.
- Když token unikne, spusť `executor server rotate-token > /dev/null`
  (příkaz nový token vypíše), potom `executor service restart` a konzoli
  otevři znovu. Starý token pak Executor odmítne.

## Data a custody

- Všechno je v `~/.executor`: databáze, přístupový token konzole
  (`server-control/auth.json`) a tokeny připojení.
- Soubory čte jen uživatel Environmentu (`0600`) a nejsou šifrované, stejně
  jako přihlášení `gh`, Codexu nebo Claude Code. Šifrované úložiště přinese
  Executor 2.
- Záloha celého Environmentu tyto tokeny obsahuje. Ochrana záloh a disků
  patří hranici Mašiny.
- `~/.executor` se mezi Environmenty nekopíruje. Každý Environment má svá
  připojení.

## Co agent smí

- Používat všechny integrace Executoru. Uvnitř Environmentu se přístupy
  nedělí.
- Integraci nikdy nepřipojit sám: přihlášení je souhlas člověka, proto
  agent pošle odkaz na kartu v Apps → Integrace. Dokud stránka Integrace
  není, připojí ji jen na výslovný pokyn člověka postupem výše.
- Vlastní MCP server přidat jen na výslovný pokyn člověka, vždy do
  Executoru Environmentu, ne jen do svého nástroje.
- Navenek viditelný zápis udělat jen na pokyn Operátora.
- Kde Executor neběží, nainstalovat ho na pokyn operátora podle tohoto
  runbooku.

## Odebrání

`executor service uninstall` službu zastaví a odebere. Připojení odvolej
u poskytovatele. `~/.executor` smaž, až když je jisté, že ho nikdo
nepotřebuje.

## Executor 2

Executor 2 je zatím beta a funguje jinak: nemá příkazovou řádku pro volání
nástrojů a úložiště šifruje. Neinstaluj ho. Přechod připravíme v plánu
DEV-6626, až vyjde stabilní.
