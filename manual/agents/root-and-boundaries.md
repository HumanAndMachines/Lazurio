# Tento root, hranice a zdroje pravdy

Závazná součást pravidel pro agenty v Lazurio rootu. Platí stejně jako
`AGENTS.md`, který na tento manuál odkazuje a drží jeho závazné jádro. Načti
ho, když pracuješ s objevováním Organizací v Launchpadu, s Conglomerate a jeho
tailnetem, s Personalspace, s přístupy, se secrets, s tím, kdo je na kterém
Prostředí uživatel, na stanovišti LazurioDevelopment, s rozdílem GEN3 a GEN4,
s pojmem Mašina nebo když hledáš často potřebný manuál.

Text níže byl přesunut z `AGENTS.md` beze změny znění. Oddíly nesou názvy
oddílů `AGENTS.md`, ze kterých pocházejí; body, které v `AGENTS.md` zůstaly
doslova, tu nejsou.

## Tento root

- Launchpad objevuje Organizace sám (auto-discovery, decision 0042) a pro
  objevené mounty platí stejně přísné kontroly; `launchpad.gen3.json` drží
  jen sdílená metadata a není allowlist. Checkout šablony žije jako nested
  repo v `productionspace/` Admin Organizace, ne jako další Organizace
  (0127). Podrobnosti drží `launchpad/README.md` a `MAP.md`.
- Conglomerate je hranice důvěry svého zakladatele pro sdílený tailnet
  Conglomerate Hostu, ne další access hranice. Do tailnetu se smí přihlásit
  člen kterékoli Organizace, kterou host obsluhuje, ale data, členství,
  schválení zařízení ani granty se mezi Organizacemi nepřenášejí a vstup do
  jejich Prostředí dál drží členství a grant dané Organizace (0184
  s dodatkem z 2026-10-23, 0192). Výjimkou je osobní kontext: v Osobním
  Prostředí se data Organizací jeho Conglomerate smějí potkat ve výstupech
  pro jeho člověka, nikdy v jiné Organizaci (0224).
- Root s více Organizacemi nese váš počítač a stanoviště Organizace
  LazurioDevelopment. Stanoviště je Pracovní Prostředí jednoho člověka, které
  je pro ostatní Organizace jeho klientem a nese jen jeho přihlášení;
  Personalspace na něm není. Root tam patří do productionspace
  LazurioDevelopment jako její repozitář a root CLI se tam spouští
  `bun run lazurio -- …` z rootu, protože `lazurio` je tam Platforma (0217
  s dodatky; nasazuje plán DEV-6691).
- GEN3 je oficiální označení Lazurio Rootu na počítači, GEN4 Lazurio
  Platform s Lazurio Folderem a Prostředími (0225, mění 0219). Platí
  v textech; repozitáře ani složky se nepřejmenovávají. GEN3 zůstává
  udržovaná pro zákazníky, kteří na ní pracují, ale nové normy se píšou jen
  do GEN4 a root na ně odkazuje. Na mechanismech Folderu se root sjednocuje
  (0219).

## Hranice

- **Personalspace** je intimní prostor právě jednoho uživatele a jeho Buddyho
  (0091). Každý Kolega má vlastní mašinu s plnými lokálními právy a vlastní
  privátní Personalspace. Nikdo cizí ho nečte, ani Steward, Admin nebo
  provozovatel hostingu, a nikdy se nesdílí. Cizí Personalspace se na
  mašinu nemountuje, Launchpad ho nematerializuje a ty ho nečteš.
  Spolupráce patří do Organizace nebo do vědomě exportovaného výstupu;
  sdílená Mašina Organizace Personalspace uživatele nepřebírá.
- **Přístupy.** GitHub je autorita přístupů ke zdrojovému kódu: repozitáře,
  schopnosti Teamů, branch rules, review a Publikace. Vstup do Prostředí drží
  Lazurio účet, aktivní členství a konkrétní grant a síť Adminem schválené
  zařízení v Headscale (0192; cílový kontrakt, ne tvrzení o nasazení, viz
  `manual/environment-access-model.md`). Zvolí-li si Organizace veřejné DNS
  (0213), lidé vstupují bez tailnetu jen branami Prostředí a trezor zůstává
  v tailnetu. Druhý paralelní ACL nevzniká
  a aktuální práva se neobcházejí.
- **Mašina je hranice**, ne typ hardwaru: fyzické zařízení, virtuální server
  nebo providerem izolovaný hostovaný prostor, který tvoří jednu runtime,
  bezpečnostní a recovery hranici se známým Ownerem. Proces, Modul,
  worktree, Unixový účet ani kontejner Mašinou nejsou a Mašina není IAM,
  role ani položka centrálního registru. Ownerem sdílené Mašiny je
  Organizace, ne právě přihlášený uživatel. Při práci pojmenuj
  konkrétní Mašinu, jejího Ownera a případnou vyšší provider nebo operator
  hranici (`ARCHITECTURE.md`).
- **Secrets** drž jen v lokálních ignored custody cestách podle
  `manual/security/local-secret-custody.md`: secrets rootu a uživatele
  v `personalspace/<owner>_GEN3/secrets/…`, secrets Organizace a jejích
  Prostředí Henry v jejím `private/secrets/…`. Hodnoty nikdy nevypisuj;
  strukturu ukáže `scripts/custody/custody-shape.mjs` a výpis hlídá
  `scripts/custody/custody-guard.mjs`. Do Gitu patří jen standard, pointery
  a metadata-only ověření.

## Kdo je kdo

- **Uživatel** je člověk, pro kterého a s nímž agenti pracují; je to vztah,
  ne role v Organizaci. Kdo Prostředí ovládá, ovládá i agenty, které v něm
  spouští: jednají za něj v jeho živých právech a poslední slovo má on. Na
  Osobním Prostředí je to jeho Owner, na Pracovním ten, komu ho Organizace
  přiřadila, na Týmovém ten, kdo je připojený a má oprávnění, a na Prostředí
  Henry odpovědný Owner nebo Admin Organizace (0175, 0192). Starší záznamy mu
  říkají Operátor nebo Principál. Provozovatel hostingu je jiná role.

## Zdroje pravdy

- Často potřebné manuály: instalace mašiny `manual/lazurio-root-for-agents.md`
  a `manual/organization-install.md`, první přihlášení na hostované VM
  `manual/hosted-machine-first-login.md`, Windows `manual/windows-e2e-lab.md`,
  rollout a migrace Organizace `manual/first-client-organization-rollout.md`
  a `manual/gen2-to-gen3-migration.md`, worktrees
  `manual/worktree-management.md`, předání PR `manual/pull-request-handoff.md`,
  přístupy `manual/environment-access-model.md`, Integrace
  `manual/external-app-integrations.md`, forky `manual/forks.md`; closeout
  cizích PR Adminem drží skill `admin-pr-sweep`.
