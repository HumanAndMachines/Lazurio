function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[char]));
}

export const LAZURIO_LOADING_HINTS = Object.freeze([
  "Push odešle commity pracovní větve na GitHub. Do main se tím nic nemerguje.",
  "Commit je uložený krok historie, ke kterému se lze vrátit.",
  "Pull stáhne aktuální změny z GitHubu.",
  "PR je návrh změny ke kontrole, ne Publikace.",
  "Ready for review znamená, že je změna ověřená a čeká na kontrolu.",
  "Merge přijme změnu do cílové větve.",
  "Pushnutá pracovní větev má mít otevřený PR, aby práce nezapadla.",
  "Lokální náhled z worktree ještě není publikovaná změna.",
  "Testy dokládají technický stav. O Publikaci rozhoduje Principál.",
  "Dobré ráno synchronizuje Workspace a připraví krátký přehled rozdělané práce.",
  "Dobrou noc ověří změny, připraví PR a uklidí pracovní stůl.",
  "Draft je vratný a editovatelný výsledek.",
  "Publikace vyžaduje vědomé rozhodnutí oprávněného Principála.",
  "Souhlas s Publikací platí jen v aktuálním vlákně.",
  "Steward kontroluje kvalitu, řeší technické blokátory a hlídá cestu k Publikaci.",
  "Review je kontrola Draftu. Samo o sobě nic nepublikuje.",
  "V Lazuriu můžete pracovat v několika vláknech současně.",
  "Samostatná vlákna fungují nejlépe, když má každé jeden jasný úkol.",
  "Paralelní úkoly používají oddělené worktrees, aby si změny nepřekážely.",
  "Launchpad umí otevřít aplikaci z main i z pracovního worktree.",
  "GitHub je autorita pro přístupy k repozitářům.",
  "Každá Organizace tvoří samostatnou hranici dat a oprávnění.",
  "Personalspace je soukromý a s Organizací se automaticky nesdílí.",
  "Jedna Mašina představuje jednu lokální bezpečnostní hranici.",
  "Mission Control drží plány, úkoly a otevřená rozhodnutí.",
  "Knowledgebase uchovává znalosti, které mají přežít jednotlivý chat.",
  "Chat je pracovní kontext. Trvalé poznatky patří do zdroje pravdy.",
  "Launchpad ukazuje jen Organizace a moduly, ke kterým máte lokální přístup.",
  "Chybějící modul nemusí být chyba — může jít o přístupovou hranici.",
]);

const reservedTabHints = new WeakMap();

export function loadingHintForTab(tab, random = Math.random) {
  if (!reservedTabHints.has(tab)) {
    const index = Math.floor(random() * LAZURIO_LOADING_HINTS.length);
    reservedTabHints.set(tab, LAZURIO_LOADING_HINTS[index] ?? LAZURIO_LOADING_HINTS[0]);
  }
  return reservedTabHints.get(tab);
}

export function buildReservedTabStatusDocument({ title, message, origin, tip = LAZURIO_LOADING_HINTS[0] }) {
  const launchpadOrigin = new URL(origin).origin;
  const fontUrl = new URL("/fonts/fonts.css", launchpadOrigin).href;
  const tokensUrl = new URL("/vendor/lazurio/tokens.css", launchpadOrigin).href;
  const symbolUrl = new URL("/vendor/lazurio/symbol-color.svg", launchpadOrigin).href;
  const safeTitle = escapeHtml(title);
  const safeTip = escapeHtml(tip);

  return `<!doctype html>
<html lang="cs">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Spouštím ${safeTitle}</title>
  <link rel="stylesheet" href="${escapeHtml(fontUrl)}">
  <link rel="stylesheet" href="${escapeHtml(tokensUrl)}">
  <style>
    *{box-sizing:border-box}
    body{margin:0;min-height:100vh;display:grid;place-items:center;padding:var(--lz-space-32,32px);font-family:var(--lz-font-sans,"Inter Tight Variable","Inter Tight",Inter,system-ui,sans-serif);color:var(--lz-ink,#090909);background:var(--lz-paper,#fbfaf9)}
    main{width:min(100%,32rem);text-align:center}
    .brand-symbol{position:relative;width:80px;height:80px;margin:0 auto var(--lz-space-24,24px)}
    .brand-symbol__image{display:block;width:100%;height:100%}
    .brand-symbol::after{content:"";position:absolute;inset:0;background:linear-gradient(115deg,transparent 16%,rgba(168,185,251,.28) 32%,rgba(255,255,255,.98) 46%,rgba(210,221,253,.62) 56%,transparent 76%);background-size:250% 100%;mask:url("${escapeHtml(symbolUrl)}") center/contain no-repeat;-webkit-mask:url("${escapeHtml(symbolUrl)}") center/contain no-repeat;mix-blend-mode:screen;animation:lazurio-facets 3.2s cubic-bezier(.45,0,.55,1) infinite alternate}
    h1{margin:0;font-size:var(--lz-size-title,20px);font-weight:var(--lz-weight-title,600);line-height:var(--lz-leading-title,1.3);letter-spacing:var(--lz-track-title,-.02em);text-wrap:balance}
    .tip{max-width:32rem;margin:var(--lz-space-16,16px) auto 0;color:var(--lz-ink-muted,#707070);font-size:var(--lz-size-meta,14px);line-height:1.5;text-wrap:pretty}
    .tip-label{color:var(--lz-ink,#090909);font-weight:var(--lz-weight-akce,600)}
    @keyframes lazurio-facets{0%{background-position:130% 0;opacity:.42}50%{opacity:1}100%{background-position:-130% 0;opacity:.42}}
    @media (prefers-reduced-motion:reduce){.brand-symbol::after{display:none}}
  </style>
</head>
<body>
  <main aria-live="polite" aria-busy="true">
    <div class="brand-symbol" aria-hidden="true">
      <img class="brand-symbol__image" src="${escapeHtml(symbolUrl)}" width="80" height="80" alt="">
    </div>
    <h1>${escapeHtml(message)}</h1>
    <p class="tip"><span class="tip-label">Tip:</span> ${safeTip}</p>
  </main>
</body>
</html>`;
}

export function writeReservedTabStatus(tab, { title, message }) {
  if (!tab || tab.closed) return;
  try {
    tab.document.open();
    tab.document.write(buildReservedTabStatusDocument({
      title,
      message,
      origin: window.location.origin,
      tip: loadingHintForTab(tab),
    }));
    tab.document.close();
  } catch {
    // Reserved about:blank tab is best-effort; the runtime flow remains authoritative.
  }
}
