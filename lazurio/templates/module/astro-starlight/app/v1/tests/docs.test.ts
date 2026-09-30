import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const docs = resolve(import.meta.dir, "../src/content/docs");

test("the root page exists and declares a title", () => {
  const index = resolve(docs, "index.md");
  expect(existsSync(index)).toBe(true);
  const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(readFileSync(index, "utf8"))?.[1] ?? "";
  expect(frontmatter).toMatch(/^title: \S/m);
});
