import { cs } from "./locales/cs.js";
import { en } from "./locales/en.js";

export const DEFAULT_LOCALE = "cs";
export const SUPPORTED_LOCALES = Object.freeze(["cs", "en"]);
export const LOCALE_STORAGE_KEY = "launchpad.locale";

const catalogs = Object.freeze({ cs, en });
let activeLocale = environmentLocale();

function environmentLocale() {
  let stored = null;
  try {
    stored = globalThis.localStorage?.getItem(LOCALE_STORAGE_KEY);
  } catch {}
  return resolveLocale({
    stored,
    languages: globalThis.navigator?.languages ?? [globalThis.navigator?.language],
  });
}

export function normalizeLocale(value) {
  const primary = String(value ?? "").trim().toLowerCase().split(/[-_]/)[0];
  return SUPPORTED_LOCALES.includes(primary) ? primary : null;
}

export function resolveLocale({ stored, languages = [] } = {}) {
  const explicit = normalizeLocale(stored);
  if (explicit) return explicit;
  for (const language of languages ?? []) {
    const candidate = normalizeLocale(language);
    if (candidate) return candidate;
  }
  return DEFAULT_LOCALE;
}

export function initializeI18n({ storage, languages, documentRef } = {}) {
  const browserStorage = storage ?? globalThis.localStorage;
  const browserLanguages = languages ?? globalThis.navigator?.languages ?? [globalThis.navigator?.language];
  let stored = null;
  try {
    stored = browserStorage?.getItem(LOCALE_STORAGE_KEY);
  } catch {}
  activeLocale = resolveLocale({ stored, languages: browserLanguages });
  localizeDocument(documentRef ?? globalThis.document);
  return activeLocale;
}

export function getLocale() {
  return activeLocale;
}

export function setLocale(locale, { storage } = {}) {
  const normalized = normalizeLocale(locale);
  if (!normalized) throw new RangeError(`Unsupported Launchpad locale: ${locale}`);
  activeLocale = normalized;
  try {
    (storage ?? globalThis.localStorage)?.setItem(LOCALE_STORAGE_KEY, normalized);
  } catch {}
  return normalized;
}

export function t(key, params = {}, { locale = activeLocale } = {}) {
  const normalized = normalizeLocale(locale) ?? DEFAULT_LOCALE;
  const template = catalogs[normalized]?.[key] ?? catalogs[DEFAULT_LOCALE]?.[key];
  if (typeof template !== "string") return `[${key}]`;
  return template.replace(/\{([A-Za-z0-9_]+)\}/g, (_match, name) => String(params[name] ?? `{${name}}`));
}

export function pluralCategory(count, { locale = activeLocale } = {}) {
  const normalized = normalizeLocale(locale) ?? DEFAULT_LOCALE;
  return new Intl.PluralRules(normalized).select(Number(count));
}

export function tp(key, count, params = {}, options = {}) {
  return t(`${key}.${pluralCategory(count, options)}`, { ...params, count }, options);
}

export function formatNumber(value, options = {}) {
  return new Intl.NumberFormat(activeLocale, options).format(value);
}

export function formatDate(value, options = {}) {
  return new Intl.DateTimeFormat(activeLocale, options).format(value);
}

export function localizeDocument(documentRef = globalThis.document) {
  if (!documentRef) return;
  documentRef.documentElement?.setAttribute("lang", activeLocale);
  for (const node of documentRef.querySelectorAll?.("[data-i18n]") ?? []) {
    node.textContent = t(node.dataset.i18n);
  }
  for (const node of documentRef.querySelectorAll?.("[data-i18n-placeholder]") ?? []) {
    node.setAttribute("placeholder", t(node.dataset.i18nPlaceholder));
  }
  for (const node of documentRef.querySelectorAll?.("[data-i18n-aria-label]") ?? []) {
    node.setAttribute("aria-label", t(node.dataset.i18nAriaLabel));
  }
  for (const node of documentRef.querySelectorAll?.("[data-i18n-title]") ?? []) {
    node.setAttribute("title", t(node.dataset.i18nTitle));
  }
  for (const option of documentRef.querySelectorAll?.("[data-locale]") ?? []) {
    const isActive = option.dataset.locale === activeLocale;
    option.setAttribute("aria-pressed", String(isActive));
  }
  documentRef.title = t("meta.documentTitle");
  documentRef.documentElement?.setAttribute("data-i18n-ready", "true");
}
