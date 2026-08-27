import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { buildReservedTabStatusDocument } from "../public/reserved-tab-status.js";

const canonicalSymbolSha256 = "6334e2b815cd83c8be7e601aa7bfab740a34d74848f522803065026a6f18609b";

test("reserved app tab uses the canonical Lazurio visual identity", () => {
  const html = buildReservedTabStatusDocument({
    title: "Knowledgebase",
    message: "Aplikace ještě startuje...",
    origin: "http://127.0.0.1:4174",
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
  expect(html).toContain("Knowledgebase</strong> se otevře v tomto panelu, jakmile bude připravená.");
  expect(html).not.toContain("health endpoint");
  expect(html).not.toContain("#6d5dfc");
  expect(html).not.toContain(">↗<");
  expect(html).not.toContain('class="progress"');
});

test("reserved app tab keeps the canonical symbol and a non-layout loading motion", async () => {
  const symbol = await readFile(new URL("../public/vendor/lazurio/symbol-color.svg", import.meta.url));
  const symbolSha256 = createHash("sha256").update(symbol).digest("hex");
  const html = buildReservedTabStatusDocument({
    title: "Knowledgebase",
    message: "Aplikace ještě startuje...",
    origin: "http://127.0.0.1:4174",
  });

  expect(symbolSha256).toBe(canonicalSymbolSha256);
  expect(html).toContain(".brand-symbol{position:relative;width:80px;height:80px");
  expect(html).toContain("background-size:240% 100%");
  expect(html).toContain("@keyframes lazurio-facets{0%,14%{background-position:130% 0;opacity:.28}48%{opacity:.9}86%,100%{background-position:-130% 0;opacity:.28}}");
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
  });

  expect(html).toContain("&lt;Deals &amp; &quot;Quotes&quot;&gt;");
  expect(html).toContain("Spouštím &lt;aplikaci&gt;");
  expect(html).not.toContain('<Deals & "Quotes">');
});
