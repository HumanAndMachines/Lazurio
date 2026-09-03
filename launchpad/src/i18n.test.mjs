import { afterEach, expect, test } from "bun:test";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  DEFAULT_LOCALE,
  LOCALE_STORAGE_KEY,
  getLocale,
  initializeI18n,
  normalizeLocale,
  resolveLocale,
  setLocale,
  t,
  tp,
} from "../public/i18n.js";
import { cs } from "../public/locales/cs.js";
import { en } from "../public/locales/en.js";

afterEach(() => setLocale(DEFAULT_LOCALE, { storage: null }));

test("explicit Launchpad preference outranks browser languages", () => {
  expect(resolveLocale({ stored: "en", languages: ["cs-CZ"] })).toBe("en");
  expect(resolveLocale({ stored: "cs", languages: ["en-US"] })).toBe("cs");
});

test("browser languages resolve by primary subtag and Czech remains the fallback", () => {
  expect(resolveLocale({ languages: ["de-DE", "en-GB"] })).toBe("en");
  expect(resolveLocale({ languages: ["sk-SK", "de-DE"] })).toBe("cs");
  expect(normalizeLocale("EN_us")).toBe("en");
});

test("locale is stored per browser and catalogs interpolate semantic keys", () => {
  const writes = [];
  const storage = { setItem: (...args) => writes.push(args) };
  setLocale("en", { storage });
  expect(getLocale()).toBe("en");
  expect(writes).toEqual([[LOCALE_STORAGE_KEY, "en"]]);
  expect(t("workspace.welcomeOrganization", { organization: "AVALTAR" })).toBe("Welcome to the AVALTAR workspace");
  expect(tp("plural.blocker", 2)).toBe("blockers");
});

test("initialization translates text, attributes, document language and locale controls before reveal", () => {
  const nodes = {
    text: [{ dataset: { i18n: "workspace.welcome" }, textContent: "" }],
    placeholder: [{ dataset: { i18nPlaceholder: "workspace.searchPlaceholder" }, setAttribute(name, value) { this[name] = value; } }],
    aria: [{ dataset: { i18nAriaLabel: "locale.label" }, setAttribute(name, value) { this[name] = value; } }],
    title: [{ dataset: { i18nTitle: "topbar.syncTitle" }, setAttribute(name, value) { this[name] = value; } }],
  };
  const attributes = new Map();
  const localeOptions = [
    { dataset: { locale: "en" }, setAttribute(name, value) { this[name] = value; } },
    { dataset: { locale: "cs" }, setAttribute(name, value) { this[name] = value; } },
  ];
  const documentRef = {
    title: "",
    documentElement: { setAttribute: (name, value) => attributes.set(name, value) },
    querySelectorAll: (query) => ({
      "[data-i18n]": nodes.text,
      "[data-i18n-placeholder]": nodes.placeholder,
      "[data-i18n-aria-label]": nodes.aria,
      "[data-i18n-title]": nodes.title,
      "[data-locale]": localeOptions,
    })[query] ?? [],
  };

  initializeI18n({
    storage: { getItem: () => "en" },
    languages: ["cs-CZ"],
    documentRef,
  });

  expect(nodes.text[0].textContent).toBe("Welcome to your workspace");
  expect(nodes.placeholder[0].placeholder).toBe("Search applications…");
  expect(nodes.aria[0]["aria-label"]).toBe("Language");
  expect(attributes.get("lang")).toBe("en");
  expect(attributes.get("data-i18n-ready")).toBe("true");
  expect(localeOptions[0]["aria-pressed"]).toBe("true");
  expect(localeOptions[1]["aria-pressed"]).toBe("false");
});

test("unsupported explicit locale is rejected", () => {
  expect(() => setLocale("de")).toThrow(RangeError);
});

test("Czech and English catalogs expose the same semantic contract", () => {
  expect(Object.keys(en).sort()).toEqual(Object.keys(cs).sort());
  expect(Object.values(cs).every((value) => typeof value === "string" && value.length > 0)).toBe(true);
  expect(Object.values(en).every((value) => typeof value === "string" && value.length > 0)).toBe(true);
});

test("English covers loading, warnings, recovery, personalspace and worktree copy", () => {
  setLocale("en", { storage: null });
  expect(t("loading.title", { title: "Mission Control" })).toBe("Starting Mission Control");
  expect(t("warning.invalidConfig")).toBe("Configuration error");
  expect(t("recovery.timeoutTitle")).toBe("The application is taking too long to start");
  expect(t("personal.loadFailed.title")).toBe("Personal space could not be loaded");
  expect(t("worktree.created", { app: "Infra", worktree: "DEV-1" })).toBe("Infra: worktree created (DEV-1).");
});

test("Czech outgoing changes resolve the few plural category", () => {
  setLocale("cs", { storage: null });
  expect(tp("detail.outgoing", 2)).toBe("Jsou uložené na tomto počítači. Ostatní je zatím nevidí.");
  expect(tp("detail.outgoing", 4)).toBe("Jsou uložené na tomto počítači. Ostatní je zatím nevidí.");
});

test("every literal UI key and integer plural category resolves", async () => {
  const publicRoot = join(import.meta.dirname, "..", "public");
  const files = (await readdir(publicRoot)).filter((file) => file.endsWith(".js"));
  const literalKeys = new Set();
  const pluralKeys = new Set();
  for (const file of files) {
    const source = await readFile(join(publicRoot, file), "utf8");
    for (const match of source.matchAll(/\bt\("([^"]+)"/g)) literalKeys.add(match[1]);
    for (const match of source.matchAll(/\btp\("([^"]+)"/g)) pluralKeys.add(match[1]);
  }
  for (const key of literalKeys) {
    expect(Object.hasOwn(cs, key)).toBe(true);
  }
  for (const [locale, catalog] of [["cs", cs], ["en", en]]) {
    const pluralRules = new Intl.PluralRules(locale);
    const integerCategories = new Set(Array.from({ length: 201 }, (_unused, count) => pluralRules.select(count)));
    for (const key of pluralKeys) {
      for (const category of integerCategories) {
        expect(Object.hasOwn(catalog, `${key}.${category}`)).toBe(true);
      }
    }
  }

  for (const [file, catalog] of [["cs.js", cs], ["en.js", en]]) {
    const source = await readFile(join(publicRoot, "locales", file), "utf8");
    const declaredKeys = [...source.matchAll(/^\s*,?"([^"]+)":/gm)].map((match) => match[1]);
    expect(new Set(declaredKeys).size).toBe(declaredKeys.length);
    expect(declaredKeys.length).toBe(Object.keys(catalog).length);
  }
});
