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

test("reserved app tab loads Lazurio assets from the Launchpad origin and announces its status", () => {
  const html = buildReservedTabStatusDocument({
    title: "Knowledgebase",
    message: "Aplikace startuje...",
    origin: "http://127.0.0.1:4174",
    tip: "Commit je uložený krok historie, ke kterému se lze vrátit.",
  });

  expect(html).toContain('href="http://127.0.0.1:4174/fonts/fonts.css"');
  expect(html).toContain('href="http://127.0.0.1:4174/vendor/lazurio/tokens.css"');
  expect(html).toContain('src="http://127.0.0.1:4174/vendor/lazurio/symbol-color.svg"');
  expect(html).toContain('mask:url("http://127.0.0.1:4174/vendor/lazurio/symbol-color.svg")');
  expect(html).toContain("prefers-reduced-motion:reduce");
  expect(html).toContain('aria-live="polite"');
  expect(html).toContain("Aplikace startuje...");
  expect(html).toContain('<p class="hint">Commit je uložený krok historie, ke kterému se lze vrátit.</p>');
});

test("reserved app tab keeps one hint per tab", () => {
  const tab = {};

  expect(loadingHintForTab(tab, () => 0)).toBe(LAZURIO_LOADING_HINTS[0]);
  expect(loadingHintForTab(tab, () => 0.999)).toBe(LAZURIO_LOADING_HINTS[0]);
  expect(loadingHintForTab({}, () => 0.999)).toBe(LAZURIO_LOADING_HINTS.at(-1));
});

test("reserved app tab vendors the canonical Lazurio symbol", async () => {
  const symbol = await readFile(new URL("../public/vendor/lazurio/symbol-color.svg", import.meta.url));
  const symbolSha256 = createHash("sha256").update(symbol).digest("hex");

  expect(symbolSha256).toBe(canonicalSymbolSha256);
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
