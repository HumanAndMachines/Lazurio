import { expect, test } from "bun:test";
import { buildReservedTabStatusDocument } from "../public/reserved-tab-status.js";

test("reserved app tab uses the canonical Lazurio visual identity", () => {
  const html = buildReservedTabStatusDocument({
    title: "Knowledgebase",
    message: "Aplikace ještě startuje...",
    origin: "http://127.0.0.1:4174",
  });

  expect(html).toContain('href="http://127.0.0.1:4174/fonts/fonts.css"');
  expect(html).toContain('href="http://127.0.0.1:4174/vendor/lazurio/tokens.css"');
  expect(html).toContain('src="http://127.0.0.1:4174/favicon.svg"');
  expect(html).toContain("var(--lz-font-sans");
  expect(html).toContain("var(--lz-paper");
  expect(html).toContain("var(--lz-accent");
  expect(html).toContain("prefers-reduced-motion:reduce");
  expect(html).toContain('aria-live="polite"');
  expect(html).toContain("Knowledgebase</strong> se otevře v tomto panelu, jakmile bude připravená.");
  expect(html).not.toContain("health endpoint");
  expect(html).not.toContain("#6d5dfc");
  expect(html).not.toContain(">↗<");
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
