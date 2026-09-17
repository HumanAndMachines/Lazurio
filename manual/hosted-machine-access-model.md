# Přístup Operátorů k hostovaným Mašinám — návrh modelu (draft, 2026-09-17)

Stav: **orientační návrh** sepsaný po prvním živém onboardingu operátora
(ConceptLine, DEV-6501). Není to decision record; má sloužit jako podklad pro
decision record a pro issues v owning repech. Kde návrh naráží na dnešní
implementaci, je to řečeno výslovně v „Otevřené body“.

## Proč

Dnešní napojení operátora do hostovaného workspace stojí na Adminovi:
registrace zařízení v Headscale, lane PR s Permit pro každý grant zařízení →
VM, přenos SSH klíče přes chat agenta, párovací token T3 Code vydávaný
Adminem. Každý krok je bezpečný, ale žádný neškáluje na tým a každý vyžaduje
rollout. Cíl: Operátor si v mezích toho, co Owner deklaroval, obslouží
přístup sám; Admin dělá jen Owner‑level rozhodnutí.

## Pojmy

- **Operátor** — člověk přihlášený Lazurio účtem (GitHub identita přes
  Lazurio Sign‑In). Práva plynou z GitHub Organizace a Teamů (decision 0102:
  GitHub je jediná autorita přístupů).
- **Mašina** — uzel tailnetu Organizace (decision 0144: Conglomerate =
  Headscale na Conglomerate Hostu). Buď **hostovaná Mašina** (workspace VM
  Teamu, `<vm>.<org>.lazurio.io`), nebo **osobní Mašina** Operátora (notebook,
  telefon), přes kterou Operátor k hostovaným Mašinám přistupuje.
- **Owner** — Organization Admin; jediný, kdo Mašinu do Conglomerate přidává
  a kdo deklaruje, který Operátor kam smí (Owner‑level operace).
- **Deklarace přístupu** — záznam „Operátor ↔ hostované Mašiny ↔ úroveň“.
  Zdroj pravdy: GitHub Teamy (členství = kdo je Operátor Teamu) a Dashboard
  (rozšíření o úroveň a o osobní Mašiny). Conglomerate ji **promítá**
  do Headscale policy a brány VM; nikde jinde druhý ACL nevzniká.

## Úrovně přístupu k hostované Mašině

| Úroveň | Co Operátor dostane | Mechanismus |
| --- | --- | --- |
| **Uživatel aplikací** | Aplikace dílny (`<app>.<vm>.<org>`) kromě T3 Code; žádný SSH, žádný zdrojový kód modulů | Headscale grant tcp/443 na VM; brána VM admituje Team `<vm>-users` (nebo Team `<vm>` s rolí user) pro všechny origins mimo `t3code.<vm>` |
| **Operátor** | + T3 Code (agent, terminál, zdrojový kód) | brána admituje Team `<vm>` i na `t3code.<vm>`; párování T3 Code automatické (viz níže) |
| **Operátor s SSH** | + SSH z jeho osobních Mašin (Codex Desktop remote, CLI) | Headscale grant tcp/22 `operátor@ → VM` pro uzly toho Operátora; klíč Operátora v `~/.ssh/authorized_keys` účtu VM (Machines v0.12.30 toleruje a hlásí operátorské klíče) |

Úroveň se váže na Operátora a hostovanou Mašinu, ne na zařízení: každá
osobní Mašina Operátora dědí jeho úrovně. „Bez SSH“ je tedy běžná varianta:
Owner dá někomu přístup do aplikací dílny, aniž by viděl T3 Code nebo kód.

## Toky

### Přidání osobní Mašiny (Owner‑level, ale bez PR)

1. Operátor na své Mašině: Tailscale + Lazurio (instalační postup), Launchpad
   → „Přihlásit Lazurio účtem“.
2. Launchpad → „Připojit tuto Mašinu ke Conglomerate Organizace“: Tailscale
   login proti Headscale Organizace přes Lazurio Sign‑In (Headscale OIDC).
   Uzel vznikne pod userem = Lazurio účet Operátora, zatím bez grantů.
3. Owner v Dashboardu vidí novou osobní Mašinu Operátora a potvrdí ji
   (schválení uzlu). Deklarace přístupu Operátora už existuje (Team), takže
   Conglomerate promítne per‑user granty a Mašina okamžitě vidí, kam má.
4. Odebrání: Owner uzel zruší nebo Operátora vyřadí z Teamu; projekce granty
   odebere, sessions brány a T3 Code se revokují.

### SSH k hostované Mašině (bez Adminu)

1. Launchpad (nebo `lazurio`) na osobní Mašině vygeneruje klíč a nabídne
   „Nastavit SSH k `<vm>`“.
2. Veřejný klíč doručí na VM autorizovaným kanálem: požadavek přes bránu VM,
   kde je Operátor přihlášený (Launchpad VM / broker zapíše klíč do
   `~/.ssh/authorized_keys` účtu VM). Alternativa: VM si klíče Operátorů
   čte z GitHubu (`github.com/<login>.keys`) — stejná autorita, bez kanálu.
3. Zapíše SSH config, známé host keys (publikované Machines z readbacku) a
   remote do Codex Desktop. `ssh conceptline-<vm>` funguje, jakmile je grant
   tcp/22 v policy.

### T3 Code bez tokenu od Adminu

- **Launchpad / CLI na VM**: dlaždice „Otevřít T3 Code“ vydá jednorázový
  credential s plnými scopes včetně `access:write` (`t3 auth pairing create
  --scopes …`) a přesměruje na `/pair#token=…`; Operátor token nevidí. CLI
  totéž (`lazurio workspace t3code pair-link`), i přes SSH remote z osobní
  Mašiny.
- **Broker v bráně VM** pro klienty bez Launchpadu (telefon): po přihlášení
  GitHubem na `t3code.<vm>` brána spáruje sama. Stejný mechanismus, bez UI.
- Dashboard **není** kanál pro tokeny (veřejný control plane mimo tailnet,
  tajemství přes třetí systém, další stav k revokaci). Dashboard je vstupní
  katalog a místo deklarace.

## Launchpad jako control plane Mašiny

Launchpad ukazuje, „která Mašina jsem, kam vidím a jak“: diagram sestavený
z Headscale policy (granty, úrovně) a `lazurio.machine.json` (identita
Mašiny). Odtud: Otevřít T3 Code, Nastavit SSH, moduly Organizace, později
Buddy/OpenMausBot. CLI je totéž pro Agenty; Launchpad i CLI volají stejné
funkce `lazurio`.

## Odpovědnosti (kde co žije)

| Repo | Změna |
| --- | --- |
| Machines | per‑user Headscale granty z deklarace (místo per‑device `workspace_ssh_grants`), Headscale OIDC přes Lazurio Sign‑In + schválení uzlu, admission per aplikace v bráně (T3 Code jen pro Operátory), broker párování v bráně, publikace host keys VM, klíče Operátorů (`authorized_keys`: přijímací kanál nebo z GitHubu) |
| Dashboard | přehled osobních Mašin per Operátor, schválení uzlu Ownerem, deklarace úrovně přístupu, projekce do Conglomerate |
| Lazurio (Launchpad/CLI) | přihlášení Lazurio účtem, join Conglomerate, Nastavit SSH, Otevřít T3 Code (pair‑link), diagram Mašiny |
| t3code fork | `auth pairing create --scopes` |
| LazurioPlatform | Profil `workspace` pro hostovanou VM (Folder + CLI), aby resident root byl regulérní Lazurio Folder |

## Bezpečnostní invarianty

- GitHub je jediná autorita: Team = kdo je Operátor; Owner deklaruje úroveň
  a schvaluje Mašiny; nic z toho se nedá obejít z VM.
- Mašina je hranice: session brány i T3 Code jsou per VM; SSH grant je per
  Operátor, ale vždy na konkrétní VM.
- Žádné tajemství přes třetí systém: párování i klíče vznikají na VM nebo
  na osobní Mašině a putují jen autorizovaným kanálem brány nebo SSH.
- Přidání Mašiny do Conglomerate je Owner‑level; Operátor si nemůže grant
  vyrobit, jen použít.
- Auditovatelnost: readback hlásí operátorské klíče (`observation.workspace_guests`),
  Dashboard loguje schválení a deklarace, T3 Code vede sessions.

## Otevřené body

1. Headscale OIDC přes Lazurio Sign‑In: mapování userů (per Operátor místo
   `org-<org>`), schválení uzlu (Headscale nemá nativní „pending“; řešit
   nulovým grantem do schválení v Dashboardu).
2. Admission per aplikace v bráně VM (`t3code.<vm>` jen Team `<vm>`, ostatní
   i Team `<vm>-users`): rozšíření katalogu brány o allowed groups per origin.
3. Odvození policy z deklarace: kde žije deklarace (GitHub Teamy + Dashboard
   projekce podobná dnešní DNS projekci) a jak ji Conglomerate rekonciluje.
4. Klíče Operátorů: přijímací endpoint za bránou vs. čtení z GitHubu; obojí
   dává `authorized_keys` bez rolloutu. Rozhodnout jedno.
5. `pairing create --scopes` v t3code forku; broker v bráně pro telefony.
6. Host keys VM: publikace z readbacku do org repa pro `known_hosts`.
7. Profil `workspace` v LazurioPlatform a doctor na hostované VM.
8. Migrace ConceptLine na 0146 (Machines v0.12.30) je předpoklad: hostname
   origins pro admission per aplikace, `authorized_keys` bez `authorized_keys2`.
9. Číslo decision recordu a promítnutí do `manual/decision-register.md`.
