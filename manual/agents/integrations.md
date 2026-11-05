# Integrace

Závazná součást pravidel pro agenty v Lazurio rootu. Platí stejně jako
`AGENTS.md`, který na tento manuál odkazuje a drží jeho závazné jádro. Načti
ho, než připojíš, nastavíš nebo navrhneš napojení na externí aplikaci, a před
prací ve Figmě.

Text níže byl přesunut z `AGENTS.md` beze změny znění. Oddíly nesou názvy
oddílů `AGENTS.md`, ze kterých pocházejí; body, které v `AGENTS.md` zůstaly
doslova, tu nejsou.

## Integrace

- Integraci nikdy nepřipojuješ sám: přihlášení je souhlas uživatele. Pošleš
  mu odkaz na její kartu v Apps → Integrace; kde stránka Integrace ještě
  není, připojíš ji jen na jeho výslovný pokyn podle
  `manual/integrations/executor.md` nebo `manual/integrations/composio.md`
  a přihlášení dokončí on sám. Vlastní MCP server do Executoru přidáš, nebo
  Executor nastavíš, jen na jeho výslovný pokyn. Nastavení celé Organizace
  (povolení Composia, firemní aplikace) mění Admin v Dashboardu (0194).
  Integrační službu Služeb serveru (0209)
  povoluje Admin a ty ji nepřidáváš, neodebíráš ani k ní nikoho
  nepřihlašuješ.
- Nové napojení: oficiální MCP poskytovatele v Executoru → oficiální CLI →
  Composio → reviewnutý pinned OSS → browser. Scraping a cookie-session
  servery nikdy, nový ChatGPT nebo claude.ai konektor také ne. Aplikace,
  pluginy a konektory účtu ChatGPT v harnessu v Prostředí nepoužíváš, dokud
  je Organizace (v Osobním Prostředí uživatel) nepovolí, a i pak jen pro
  aplikaci mimo Integrace (0162, dodatek z 2026-10-27). Napojená
  aplikace je ve výchozím stavu ke čtení, zápisu i mazání a rozsah omezuje
  uživatel; schopnost zápisu není souhlas s Publikací. Na mašině s více
  Organizacemi použiješ nástroj té, pro kterou pracuješ, a data mezi nimi
  nepřenášíš. Účty Composia, katalog a postupy drží
  `manual/external-app-integrations.md` a `manual/integrations/`; zaseknutý
  nebo zastaralý postup opravíš PR na standard, ne poznámkou v chatu.
- **Figma:** kanonický design Lazuria je jen
  <https://www.figma.com/design/o14eNlc08MDmwnrtoeb91M/Lazurio>; paralelní
  soubor bez pokynu nezakládáš. Ve Figmě pracuješ výhradně přes vestavěný
  Browser Use v přihlášené relaci uživatele, nikdy přes Figma MCP, který je
  placený. Když Browser Use nebo relace chybí, zastavíš a požádáš uživatele
  o nápravu.
