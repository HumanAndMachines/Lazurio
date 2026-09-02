import { afterEach, expect, test } from "bun:test";
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
