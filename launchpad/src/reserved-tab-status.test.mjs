import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  buildReservedTabStatusDocument,
  LAZURIO_LOADING_HINTS,
  loadingHintForTab,
} from "../public/reserved-tab-status.js";
import { setLocale } from "../public/i18n.js";

afterEach(() => setLocale("cs", { storage: null }));

const canonicalSymbolSha256 = "6334e2b815cd83c8be7e601aa7bfab740a34d74848f522803065026a6f18609b";

test("reserved app tab uses the canonical Lazurio visual identity", () => {
  const html = buildReservedTabStatusDocument({
    title: "Knowledgebase",
    message: "Aplikace startuje...",
    origin: "http://127.0.0.1:4174",
    tip: "Commit je uložený krok historie, ke kterému se lze vrátit.",
  });

  expect(html).toContain('href="http://127.0.0.1:4174/fonts/fonts.css"');
  expect(html).toContain('href="http://127.0.0.1:4174/vendor/lazurio/tokens.css"');
  expect(html).toContain('src="http://127.0.0.1:4174/vendor/lazurio/symbol-color.svg"');
  expect(html).toContain("var(--lz-font-sans");
  expect(html).toContain("var(--lz-paper");
  expect(html).toContain("prefers-reduced-motion:reduce");
  expect(html).toContain("@keyframes lazurio-facets");
  expect(html).toContain('mask:url("http://127.0.0.1:4174/vendor/lazurio/symbol-color.svg")');
  expect(html).toContain('aria-live="polite"');
  expect(html).toContain("Aplikace startuje...");
  expect(html).not.toContain("Aplikace ještě startuje");
  expect(html).not.toContain("se otevře v tomto panelu");
  expect(html).toContain('<p class="hint">Commit je uložený krok historie, ke kterému se lze vrátit.</p>');
  expect(html).toContain(".hint{width:min(100%,28rem)");
  expect(html).toContain("text-wrap:balance");
  expect(html).not.toContain("Tip:");
  expect(html).not.toContain("health endpoint");
  expect(html).not.toContain("#6d5dfc");
  expect(html).not.toContain(">↗<");
  expect(html).not.toContain('class="progress"');
});

test("reserved app tab uses only the curated hint set and keeps one hint per tab", () => {
  const excludedHints = [
    "Doctor kontroluje zdraví Workspace a upozorní na problémy.",
    "Dirty repozitář nemusí znamenat chybu. Často jen obsahuje rozdělanou práci.",
    "Synchronizace aktualizuje jen repozitáře, u kterých je to bezpečné.",
    "Worktree drží jeden úkol odděleně, zatímco hlavní checkout zůstává na main.",
    "Každý pracovní úkol má mít jasný scope a vlastní předání.",
    "Agent pracuje pro svého Principála a nemá vlastní oprávnění.",
    "Poslední slovo má vždy Principál.",
    "Admin rozhoduje o směru, přístupech a změnách s velkým dopadem.",
    "Builder převádí schválený plán do ověřené změny a PR.",
  ];
  const tab = {};

  expect(LAZURIO_LOADING_HINTS).toHaveLength(29);
  for (const excludedHint of excludedHints) {
    expect(LAZURIO_LOADING_HINTS).not.toContain(excludedHint);
  }
  expect(loadingHintForTab(tab, () => 0)).toBe(LAZURIO_LOADING_HINTS[0]);
  expect(loadingHintForTab(tab, () => 0.999)).toBe(LAZURIO_LOADING_HINTS[0]);
  expect(loadingHintForTab({}, () => 0.999)).toBe(LAZURIO_LOADING_HINTS.at(-1));
});

test("reserved app tab keeps the canonical symbol and a non-layout loading motion", async () => {
  const symbol = await readFile(new URL("../public/vendor/lazurio/symbol-color.svg", import.meta.url));
  const symbolSha256 = createHash("sha256").update(symbol).digest("hex");
  const html = buildReservedTabStatusDocument({
    title: "Knowledgebase",
    message: "Aplikace startuje...",
    origin: "http://127.0.0.1:4174",
  });

  expect(symbolSha256).toBe(canonicalSymbolSha256);
  expect(html).toContain(".brand-symbol{position:relative;width:80px;height:80px");
  expect(html).toContain("background-size:250% 100%");
  expect(html).toContain("mix-blend-mode:screen");
  expect(html).toContain("animation:lazurio-facets 3.2s cubic-bezier(.45,0,.55,1) infinite alternate");
  expect(html).toContain("@keyframes lazurio-facets{0%{background-position:130% 0;opacity:.42}50%{opacity:1}100%{background-position:-130% 0;opacity:.42}}");
  expect(html).toContain("@media (prefers-reduced-motion:reduce){.brand-symbol::after{display:none}}");
  expect(html).not.toContain("@keyframes lazurio-facets{0%{width:");
  expect(html).not.toContain("@keyframes lazurio-facets{0%{height:");
  expect(html).not.toContain("@keyframes lazurio-facets{0%{transform:");
});

test("reserved app tab escapes dynamic copy", () => {
  const html = buildReservedTabStatusDocument({
    title: '<Deals & "Quotes">',
    message: "Spouštím <aplikaci>",
    origin: "http://127.0.0.1:4174",
    tip: "Tip s <tagem> & znakem",
  });

  expect(html).toContain("&lt;Deals &amp; &quot;Quotes&quot;&gt;");
  expect(html).toContain("Spouštím &lt;aplikaci&gt;");
  expect(html).toContain("Tip s &lt;tagem&gt; &amp; znakem");
  expect(html).not.toContain('<Deals & "Quotes">');
});

test("reserved app tab follows the active English locale", () => {
  setLocale("en", { storage: null });
  const html = buildReservedTabStatusDocument({
    title: "Knowledgebase",
    message: "Application is starting...",
    origin: "http://127.0.0.1:4174",
    tip: "A worktree keeps the task isolated.",
  });

  expect(html).toContain('<html lang="en">');
  expect(html).toContain("<title>Starting Knowledgebase</title>");
  expect(html).toContain("Application is starting...");
});
