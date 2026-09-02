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

test("initialization translates text, attributes, document language and selector before reveal", () => {
  const nodes = {
    text: [{ dataset: { i18n: "workspace.welcome" }, textContent: "" }],
    placeholder: [{ dataset: { i18nPlaceholder: "workspace.searchPlaceholder" }, setAttribute(name, value) { this[name] = value; } }],
    aria: [{ dataset: { i18nAriaLabel: "locale.label" }, setAttribute(name, value) { this[name] = value; } }],
    title: [{ dataset: { i18nTitle: "topbar.syncTitle" }, setAttribute(name, value) { this[name] = value; } }],
  };
  const attributes = new Map();
  const selector = { value: "" };
  const documentRef = {
    title: "",
    documentElement: { setAttribute: (name, value) => attributes.set(name, value) },
    querySelectorAll: (query) => ({
      "[data-i18n]": nodes.text,
      "[data-i18n-placeholder]": nodes.placeholder,
      "[data-i18n-aria-label]": nodes.aria,
      "[data-i18n-title]": nodes.title,
    })[query] ?? [],
    querySelector: (query) => query === "#localeSwitcher" ? selector : null,
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
  expect(selector.value).toBe("en");
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

test("every literal UI key resolves and locale sources contain no duplicate keys", async () => {
  const publicRoot = join(import.meta.dirname, "..", "public");
  const files = (await readdir(publicRoot)).filter((file) => file.endsWith(".js"));
  const literalKeys = new Set();
  for (const file of files) {
    const source = await readFile(join(publicRoot, file), "utf8");
    for (const match of source.matchAll(/\b(?:t|tp)\("([^"]+)"/g)) literalKeys.add(match[1]);
  }
  for (const key of literalKeys) {
    const resolvesDirectly = Object.hasOwn(cs, key);
    const resolvesAsPlural = Object.keys(cs).some((candidate) => candidate.startsWith(`${key}.`));
    expect(resolvesDirectly || resolvesAsPlural).toBe(true);
  }

  for (const [file, catalog] of [["cs.js", cs], ["en.js", en]]) {
    const source = await readFile(join(publicRoot, "locales", file), "utf8");
    const declaredKeys = [...source.matchAll(/^\s*,?"([^"]+)":/gm)].map((match) => match[1]);
    expect(new Set(declaredKeys).size).toBe(declaredKeys.length);
    expect(declaredKeys.length).toBe(Object.keys(catalog).length);
  }
});
