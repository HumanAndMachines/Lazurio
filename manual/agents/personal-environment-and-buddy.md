# Osobní Prostředí a Buddy

Závazná součást pravidel pro agenty v Lazurio rootu. Platí stejně jako
`AGENTS.md`, který na tento manuál odkazuje a drží jeho závazné jádro. Načti
ho, když pracuješ s Osobním Prostředím, Buddym, Pracovním přístupem, osobními
nebo organizačními adresami aplikací nebo přidělováním Prostředí.

Text níže byl přesunut z `AGENTS.md` beze změny znění. Oddíly nesou názvy
oddílů `AGENTS.md`, ze kterých pocházejí; body, které v `AGENTS.md` zůstaly
doslova, tu nejsou.

## Osobní Prostředí a Buddy

- Uživatel má právě jednu hostovanou osobní Mašinu, své Osobní Prostředí
  (0153). Další hostované Mašiny patří Organizaci, kde je koordinuje GitHub;
  dočasnou potřebu řeš uvnitř své Mašiny snapshotem nebo kontejnerovou či
  procesní izolací, každý další virtuální server už je Mašina. Vlastní
  hardware uživatele je klient mimo pool. Osobní Owner není host-admin
  a Osobní Prostředí nemá repozitáře Organizací; pracovní klony a běhy patří
  na přidělená Prostředí Organizace.
- Buddy je jen pro člověka: nabrífovaný Hermes Agent z forku
  `Lazurio/hermes-agent` s pamětí v gbrainu, který běží přímo v Osobním
  Prostředí (0210, `manual/buddy.md`). Je koordinátor: jednoduchý úkol zhruba
  do dvou minut udělá sám, ostatní práci dává botům MausBotu v Prostředí, kam
  patří. Vlákna T3 Code smí číst, ale zakládá a vede je jen na žádost
  uživatele. Agenti ve vláknech s ním nekomunikují.
  Jeho instalace, paměť a konverzace patří Osobnímu Prostředí a Personalspace
  jeho Ownera; z jiného Prostředí do nich bez pokynu Ownera nesaháš.
  Přístup do Osobního Prostředí patří uživateli, ne agentovi, i když ho
  lokální mašina technicky dovolí použít. Dashboard řídí jen životní cyklus
  hostu, ne každodenní práci Buddyho.
- Buddy z Produktu 1 nemá tailnet ani SSH: vstupuje se do něj Lazurio účtem
  z webu (0207) a Headscale mu nezakládej. Osobní Prostředí, které v tailnetu
  už je (piloty, Produkt 2), je výhradně nodem Headscale tailnetu Conglomerate
  Hostu pod osobním Headscale userem svého uživatele. Samostatný VPN,
  WireGuard tunel, veřejný port ani DNAT pro něj nezakládej (0154).
- **Pracovní přístup** (0224): z Osobního Prostředí vede automaticky SSH do
  Pracovních Prostředí jeho člověka ve všech Organizacích Conglomerate; do
  Týmových Prostředí a jako Admin do ostatních Prostředí Organizace se jde
  dál přes vlastní Pracovní Prostředí. Přístup na zařízení zapíná jeho
  Owner. Používáš jen cesty, které zapsalo Lazurio, a chybějící cestu
  nahlásíš; ruční alias ani nový grant nezakládáš. Model přístupů drží
  LazurioPlatform `docs/environment-access.md`, podrobnosti GEN3
  `manual/environment-access-model.md`.
- Osobní URL je `<app>.<personal-dns-slug>.lazurio.io`, organizační
  `<app>.<machine>.<github-org-login>.lazurio.io`; osobní DNS slug je
  lowercase login zmrazený při přidělení Prostředí (0153, 0154, 0216,
  `ARCHITECTURE.md`).
- Prostředí vznikají předem do zásoby jako volná a lidem se přidělují
  zápisem v Lazurio Auth; použité Prostředí se nepředává, zanikne a vznikne
  nové (0216; cíl, zatím nenasazený, plán DEV-6688).
