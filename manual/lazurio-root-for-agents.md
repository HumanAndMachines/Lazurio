# Lazurio Root pro Agenty

Tento stručný manuál je kanonický vstup pro Task Agenta, který instaluje,
diagnostikuje nebo vyvíjí localhost Lazurio. Nezavádí další instalační engine;
vede Agenta přes veřejné `lazurio` CLI a jeho existující Core.

## Jeden Root, dvě podporované provenance CLI

Pracovní Root je vždy odvozený z home uživatele Mašiny:

| Platforma | Kanonický Root | Volitelný source checkout |
| --- | --- | --- |
| macOS / Linux | `~/Lazurio` | `~/Lazurio/development/Lazurio` |
| Windows | `%USERPROFILE%\Lazurio` | `%USERPROFILE%\Lazurio\development\Lazurio` |

Root je generovaný non-Git adresář pro instrukce, konfiguraci, data a mounty.
Repozitáře Organizací, Modulů a Personalspace mají vlastní Git hranice. Samotný
Root Git repozitářem není.

Příkaz `lazurio` má vždy právě jednu aktivní code provenance:

- `package` — běžná immutable instalace; source checkout není potřeba;
- `source` — vědomý development override z přesné kanonické cesty výše.

Source checkout není druhý Root ani druhá instalace. Je to jediný volitelný
vývojový zdroj stejného CLI/Core. Zakázaná „druhá runtime kopie“ znamená skrytý
vendor/generated klon vedle package nebo source linku.

## Každý Agent začíná read-only readbackem

```sh
lazurio --version --json
lazurio doctor
```

`--version` popisuje spuštěné CLI, včetně `root_kind` a ověřené source/package
provenience. Doctor pouze pozoruje současný stav a vrátí konkrétní důvody,
které je potřeba řešit.

## Install a běžná údržba jsou explicitní mutace

```sh
lazurio install --json
lazurio doctor
```

`install` používá kanonický Root automaticky, nepřijímá `--root` a lze jej
bezpečně zavolat opakovaně. Je to ale konvergenční instalační operace: podle
verze CLI může po plánu a potřebném potvrzení měnit stav Mašiny. Nevydávej ji
za read-only diagnostiku.

`lazurio update` je samostatná vědomá údržba. Může fetchovat, uložit lokální
změny do recovery stashe, vrátit primary checkout na `main`, fast-forwardnout
repa, materializovat dostupné Moduly a reconciliovat dependencies. Agent jej
spustí až podle pravidel aktivního Rootu a po přečtení scoped reportu; nikdy
jím pouze „nezjišťuje stav“.

Když package-only instalace source checkout nemá, není to závada. Agent použije
package-managed CLI a neklonuje veřejný repozitář bez výslovného development
záměru. Když development checkout dostupný je a Agent v něm připravuje source
změnu, přidá repo-specific preflight `bun run doctor:task` podle jeho
`AGENTS.md`.

## Development override

Development checkout založ pouze tehdy, když Principál chce Lazurio vyvíjet.
Patří přesně do `<home>/Lazurio/development/Lazurio`; task/PR worktree se nikdy
nestává permanentním `PATH` targetem.

```sh
cd "$HOME/Lazurio/development/Lazurio"
bun run lazurio -- cli install
lazurio --version --json
```

Na Windows použij stejnou cestu pod `$env:USERPROFILE` a stejné CLI příkazy.
Po linku musí `root_kind` odpovídat `source` a provenance musí ukazovat právě
kanonický development checkout. Produkční chování ověřuj také přes skutečně
zabalený package gate; source link sám není důkaz nainstalovaného artefaktu.

## Co Agent nesmí obcházet

- nevytváří root picker, lokální `root-path` config ani alternativní aktivní
  Root;
- nepředává top-level `lazurio install --root ...`;
- neklonuje source automaticky v package-only profilu;
- nelinkuje permanentní `lazurio` na task worktree;
- nekopíruje CLI nebo Launchpad do generovaného Rootu jako druhou runtime
  autoritu;
- nemění strojové cesty podle jazyka;
- nepřesouvá legacy Git Root ručně a nestashuje či nemaže jeho worktrees
  odhadem.

## Legacy nebo částečná instalace

`lazurio install` je konvergenční příkaz: volej jej znovu i po částečném
selhání a řiď se finálním reportem. Když najde legacy Git Root, foreign obsah,
neověřitelnou provenance nebo stav vyžadující přihlášení, zachovej data a
předej přesný report Principálovi. Migraci smí provést pouze verzovaný,
detekovaný migrační krok Lazuria s inventurou a rollbackem; ruční přesun
adresářů není podporovaná oprava.

Pro hlubší diagnostiku použij [`lazurio/README.md`](../lazurio/README.md), pro
celkový filesystem model [`MAP.md`](../MAP.md) a pro hranice instalace
[`ARCHITECTURE.md`](../ARCHITECTURE.md#source-instalace-a-aktualizace).
