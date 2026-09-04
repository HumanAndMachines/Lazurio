import { open } from "node:fs/promises";
import { join } from "node:path";

export const ORGANIZATION_INSTALL_GUIDE_SCHEMA = "lazurio.guide.organization_install.v2";
export const ORGANIZATION_INSTALL_PROMPT_START = "<!-- lazurio-guide:organization-install-short:start -->";
export const ORGANIZATION_INSTALL_PROMPT_END = "<!-- lazurio-guide:organization-install-short:end -->";

export const ORGANIZATION_INSTALL_GUIDE_SOURCES = Object.freeze({
  cs: Object.freeze({
    path: "manual/organization-install.md",
    segments: Object.freeze(["manual", "organization-install.md"]),
    languageContract: "uživatelský `PATH`",
  }),
  en: Object.freeze({
    path: "distribution/locales/en/manual/organization-install.md",
    segments: Object.freeze(["distribution", "locales", "en", "manual", "organization-install.md"]),
    languageContract: "user `PATH`",
  }),
});

const sharedRequiredPromptFragments = Object.freeze([
  "<github-organization>",
  "Lazurio for GitHub",
  "All repositories",
  "gh auth login --hostname github.com --git-protocol ssh --web",
  "Node.js LTS",
  "versioned Organization manifest",
  "lazurio doctor --tool-updates --json",
  "runtime ready",
  "editing ready",
  "publishing ready",
]);

export class GuideContentError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "GuideContentError";
    this.code = code;
  }
}

function markerCount(source, marker) {
  return source.split(marker).length - 1;
}

function guideSource(locale) {
  const source = ORGANIZATION_INSTALL_GUIDE_SOURCES[locale];
  if (!source) {
    throw new GuideContentError(
      "guide_locale_unsupported",
      `Unsupported Guide locale: ${locale ?? "missing"}`,
    );
  }
  return source;
}

export function extractOrganizationInstallPrompt(manual, { locale } = {}) {
  const source = guideSource(locale);
  if (typeof manual !== "string" || manual.trim() === "") {
    throw new GuideContentError(
      "guide_manual_empty",
      "Instalační manuál je prázdný nebo nečitelný.",
    );
  }
  if (
    markerCount(manual, ORGANIZATION_INSTALL_PROMPT_START) !== 1
    || markerCount(manual, ORGANIZATION_INSTALL_PROMPT_END) !== 1
  ) {
    throw new GuideContentError(
      "guide_prompt_markers_invalid",
      "Instalační manuál nemá právě jeden označený krátký prompt.",
    );
  }

  const start = manual.indexOf(ORGANIZATION_INSTALL_PROMPT_START)
    + ORGANIZATION_INSTALL_PROMPT_START.length;
  const end = manual.indexOf(ORGANIZATION_INSTALL_PROMPT_END);
  if (end <= start) {
    throw new GuideContentError(
      "guide_prompt_markers_invalid",
      "Označení krátkého instalačního promptu je v neplatném pořadí.",
    );
  }

  const markedPrompt = manual.slice(start, end).trim();
  const lines = markedPrompt.split(/\r?\n/);
  if (lines.some((line) => line !== "" && !line.startsWith(">"))) {
    throw new GuideContentError(
      "guide_prompt_format_invalid",
      "Krátký instalační prompt musí být jeden souvislý Markdown blockquote.",
    );
  }
  const prompt = lines
    .map((line) => line === ">" ? "" : line.replace(/^> ?/, ""))
    .join("\n")
    .trim();
  const requiredPromptFragments = [...sharedRequiredPromptFragments, source.languageContract];
  const missing = requiredPromptFragments.filter((fragment) => !prompt.includes(fragment));
  if (missing.length > 0) {
    throw new GuideContentError(
      "guide_prompt_contract_invalid",
      `Krátký instalační prompt postrádá povinný kontrakt: ${missing.join(", ")}`,
    );
  }
  return prompt;
}

export function buildOrganizationInstallGuide(manual, { locale } = {}) {
  const source = guideSource(locale);
  return {
    schema_version: ORGANIZATION_INSTALL_GUIDE_SCHEMA,
    locale,
    source: {
      path: source.path,
      authority: "lazurio-root-manual",
    },
    short_prompt: extractOrganizationInstallPrompt(manual, { locale }),
    policy_markdown: manual,
  };
}

export async function readOrganizationInstallGuide({ rootPath, locale }) {
  const source = guideSource(locale);
  const sourcePath = join(rootPath, ...source.segments);
  let handle;
  try {
    handle = await open(sourcePath, "r");
    const metadata = await handle.stat();
    if (!metadata.isFile()) {
      throw new GuideContentError(
        "guide_manual_not_regular_file",
        "Instalační manuál není běžný soubor.",
      );
    }
    return buildOrganizationInstallGuide(await handle.readFile("utf8"), { locale });
  } catch (error) {
    if (error instanceof GuideContentError) throw error;
    throw new GuideContentError(
      "guide_content_unavailable",
      "Autoritativní instalační manuál teď nelze bezpečně načíst.",
    );
  } finally {
    await handle?.close();
  }
}
