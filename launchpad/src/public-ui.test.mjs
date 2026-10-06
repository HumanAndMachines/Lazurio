import { expect, test } from "bun:test";
import { readFile as readRawFile, readdir } from "fs/promises";
import { join } from "path";

const publicRoot = join(import.meta.dirname, "..", "public");

function normalizeLineEndings(value) {
  return value.replace(/\r\n?/g, "\n");
}

async function readFile(path, encoding) {
  return normalizeLineEndings(await readRawFile(path, encoding));
}

test("každá kanonická Lazurio ikona odkazovaná UI existuje", async () => {
  const js = await readFile(join(publicRoot, "app.js"), "utf8");
  const iconDirectory = join(publicRoot, "app-icons", "lazurio");
  const files = new Set(await readdir(iconDirectory));
  const iconMapBlock = js.slice(
    js.indexOf("const LAZURIO_APP_ICON_FILES"),
    js.indexOf("const APP_ICON_STYLES"),
  );
  const referencedFiles = [...iconMapBlock.matchAll(/"([a-z0-9-]+\.png)"/g)].map((match) => match[1]);

  expect(referencedFiles.length).toBeGreaterThan(0);
  for (const file of referencedFiles) expect(files.has(file)).toBe(true);
});

test("každý Lazurio kámen má vlastní shodnou barvu hover hrany", async () => {
  const js = await readFile(join(publicRoot, "app.js"), "utf8");
  const fileMapBlock = js.slice(
    js.indexOf("const LAZURIO_APP_ICON_FILES"),
    js.indexOf("const LAZURIO_APP_ICON_ACCENTS"),
  );
  const accentMapBlock = js.slice(
    js.indexOf("const LAZURIO_APP_ICON_ACCENTS"),
    js.indexOf("const APP_ICON_STYLES"),
  );
  const iconFiles = new Set([...fileMapBlock.matchAll(/"([a-z0-9-]+\.png)"/g)].map((match) => match[1]));
  const accentFiles = new Set([...accentMapBlock.matchAll(/"([a-z0-9-]+\.png)"\s*:/g)].map((match) => match[1]));

  expect([...accentFiles].sort()).toEqual([...iconFiles].sort());
});

// Every client request goes through launchpadFetch, which owns the hosted
// session-expiry handling; a raw fetch() would bypass that boundary.
test("client code reaches the Server only through launchpadFetch", async () => {
  const js = await readFile(join(publicRoot, "app.js"), "utf8");
  const personalspaceJs = await readFile(join(publicRoot, "personalspace.js"), "utf8");
  expect(js).toContain('import { launchpadFetch } from "./session-aware-fetch.js";');
  expect(personalspaceJs).toContain('import { launchpadFetch } from "./session-aware-fetch.js";');
  expect(js).not.toMatch(/\bfetch\(/);
  expect(personalspaceJs).not.toMatch(/\bfetch\(/);
});

test("render-time constants initialize before the first data load", async () => {
  const js = await readFile(join(publicRoot, "app.js"), "utf8");

  const firstDataLoad = js.indexOf("\nawait loadData();");
  expect(firstDataLoad).toBeGreaterThan(-1);
  expect(js.indexOf("const APP_ICON_STYLES")).toBeLessThan(firstDataLoad);
  expect(js.indexOf("const APP_ICON_PATHS")).toBeLessThan(firstDataLoad);
  expect(js.indexOf("const APP_DESCRIPTION_FALLBACKS")).toBeLessThan(firstDataLoad);
  expect(js.indexOf('const REPORTED_CHECK_STATUSES = new Set(["fail", "warn", "blocked"])'))
    .toBeLessThan(firstDataLoad);
});
