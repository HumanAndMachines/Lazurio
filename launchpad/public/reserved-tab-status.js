function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[char]));
}

export function buildReservedTabStatusDocument({ title, message, origin }) {
  const launchpadOrigin = new URL(origin).origin;
  const fontUrl = new URL("/fonts/fonts.css", launchpadOrigin).href;
  const tokensUrl = new URL("/vendor/lazurio/tokens.css", launchpadOrigin).href;
  const symbolUrl = new URL("/favicon.svg", launchpadOrigin).href;
  const safeTitle = escapeHtml(title);

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
    .brand-symbol{display:block;width:64px;height:64px;margin:0 auto var(--lz-space-24,24px);border-radius:var(--lz-radius-md,10px)}
    h1{margin:0 0 var(--lz-space-8,8px);font-size:var(--lz-size-title,20px);font-weight:var(--lz-weight-title,600);line-height:var(--lz-leading-title,1.3);letter-spacing:var(--lz-track-title,-.02em);text-wrap:balance}
    p{margin:0;color:var(--lz-ink-muted,#707070);font-size:var(--lz-size-body,16.5px);font-weight:var(--lz-weight-body,400);line-height:var(--lz-leading-body,1.6);letter-spacing:var(--lz-track-body,-.005em);text-wrap:pretty}
    strong{color:var(--lz-ink,#090909);font-weight:var(--lz-weight-akce,600)}
    .progress{position:relative;width:128px;height:2px;margin:var(--lz-space-24,24px) auto 0;overflow:hidden;background:var(--lz-line,#dddcdb)}
    .progress::after{content:"";position:absolute;inset:0 auto 0 0;width:42%;background:var(--lz-accent,#0d12db);animation:lazurio-loading 1.4s ease-in-out infinite}
    @keyframes lazurio-loading{0%{transform:translateX(-110%)}50%{transform:translateX(80%)}100%{transform:translateX(245%)}}
    @media (prefers-reduced-motion:reduce){.progress::after{width:100%;opacity:.55;animation:none}}
  </style>
</head>
<body>
  <main aria-live="polite" aria-busy="true">
    <img class="brand-symbol" src="${escapeHtml(symbolUrl)}" width="64" height="64" alt="">
    <h1>${escapeHtml(message)}</h1>
    <p><strong>${safeTitle}</strong> se otevře v tomto panelu, jakmile bude připravená.</p>
    <div class="progress" aria-hidden="true"></div>
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
    }));
    tab.document.close();
  } catch {
    // Reserved about:blank tab is best-effort; the runtime flow remains authoritative.
  }
}
