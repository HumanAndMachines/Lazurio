import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  GuideContentError,
  ORGANIZATION_INSTALL_GUIDE_SCHEMA,
  ORGANIZATION_INSTALL_GUIDE_SOURCES,
  ORGANIZATION_INSTALL_PROMPT_END,
  ORGANIZATION_INSTALL_PROMPT_START,
  buildOrganizationInstallGuide,
  extractOrganizationInstallPrompt,
  readOrganizationInstallGuide,
} from "./guide-content-lib.mjs";

const repositoryRoot = join(import.meta.dirname, "..", "..");
const manuals = Object.fromEntries(await Promise.all(
  Object.entries(ORGANIZATION_INSTALL_GUIDE_SOURCES).map(async ([locale, source]) => [
    locale,
    await readFile(join(repositoryRoot, source.path), "utf8"),
  ]),
));

function inlineCodeInventory(source) {
  return source
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith("```"))
    .flatMap((line) => [...line.matchAll(/`([^`]+)`/g)].map((match) => match[1]))
    .sort();
}

function fencedCodeInventory(source) {
  return [...source.matchAll(/```[^\n]*\n([\s\S]*?)```/g)]
    .map((match) => match[1])
    .sort();
}

test("Guide projects a complete locale-paired prompt and policy contract", () => {
  for (const locale of ["cs", "en"]) {
    const guide = buildOrganizationInstallGuide(manuals[locale], { locale });
    expect(guide).toMatchObject({
      schema_version: ORGANIZATION_INSTALL_GUIDE_SCHEMA,
      locale,
      source: {
        path: ORGANIZATION_INSTALL_GUIDE_SOURCES[locale].path,
        authority: "lazurio-root-manual",
      },
    });
    expect(guide.short_prompt).toContain("Lazurio for GitHub");
    expect(guide.short_prompt).toContain("All repositories");
    expect(guide.short_prompt).toContain("base repository permission `none`");
    expect(guide.short_prompt).toContain("Team `builders`");
    expect(guide.short_prompt).toContain("`WRITE`");
    expect(guide.short_prompt).toContain("`infra`");
    expect(guide.short_prompt).toContain("Node.js LTS");
    expect(guide.short_prompt).toContain("Machine/system-wide `PATH`");
    expect(guide.short_prompt).toContain("Terminal");
    expect(guide.short_prompt).toContain("PowerShell");
    expect(guide.short_prompt).toContain("`--clipboard`");
    expect(guide.short_prompt).toContain("`device_code`");
    expect(guide.short_prompt).toContain("OpenAI standalone");
    expect(guide.short_prompt).toContain("Homebrew, npm");
    expect(guide.short_prompt).toContain(
      "lazurio organization install <github-organization> --role builder --json",
    );
    expect(guide.short_prompt).toContain("versioned Organization manifest");
    expect(guide.short_prompt).toContain("runtime ready");
    expect(guide.short_prompt).not.toContain(ORGANIZATION_INSTALL_PROMPT_START);
    expect(guide.policy_markdown).toBe(manuals[locale]);
  }
  expect(buildOrganizationInstallGuide(manuals.cs, { locale: "cs" }).short_prompt)
    .toContain("soukromého chatu");
  expect(buildOrganizationInstallGuide(manuals.en, { locale: "en" }).short_prompt)
    .toContain("private chat");
  expect(manuals.en).not.toContain("Připrav tuto Mašinu");
});

test("paired manuals preserve markers and exact technical code inventory", () => {
  for (const marker of [ORGANIZATION_INSTALL_PROMPT_START, ORGANIZATION_INSTALL_PROMPT_END]) {
    expect(manuals.cs.split(marker)).toHaveLength(2);
    expect(manuals.en.split(marker)).toHaveLength(2);
  }
  expect(inlineCodeInventory(manuals.en)).toEqual(inlineCodeInventory(manuals.cs));
  expect(fencedCodeInventory(manuals.en)).toEqual(fencedCodeInventory(manuals.cs));
});

test("Guide requires an explicit supported locale", () => {
  for (const locale of [undefined, "de", "en-US"]) {
    try {
      buildOrganizationInstallGuide(manuals.cs, { locale });
      throw new Error("expected the locale gate to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(GuideContentError);
      expect(error.code).toBe("guide_locale_unsupported");
    }
  }
});

test("Guide fails closed when either prompt marker is missing or duplicated", () => {
  for (const manual of [
    manuals.cs.replace(ORGANIZATION_INSTALL_PROMPT_START, ""),
    manuals.cs.replace(ORGANIZATION_INSTALL_PROMPT_END, ""),
    `${ORGANIZATION_INSTALL_PROMPT_START}\n${manuals.cs}`,
  ]) {
    expect(() => extractOrganizationInstallPrompt(manual, { locale: "cs" }))
      .toThrow(GuideContentError);
    try {
      extractOrganizationInstallPrompt(manual, { locale: "cs" });
    } catch (error) {
      expect(error.code).toBe("guide_prompt_markers_invalid");
    }
  }
});

test("Guide rejects malformed blockquote and missing safety contract", () => {
  const malformed = manuals.cs.replace(
    "> Připrav tuto Mašinu",
    "Připrav tuto Mašinu",
  );
  expect(() => extractOrganizationInstallPrompt(malformed, { locale: "cs" })).toThrow(
    "Krátký instalační prompt musí být jeden souvislý Markdown blockquote.",
  );

  const weakened = manuals.en.replace("All repositories", "selected repositories");
  expect(() => extractOrganizationInstallPrompt(weakened, { locale: "en" }))
    .toThrow("All repositories");

  const broadBasePermission = manuals.en.replace(
    "base repository permission `none`",
    "base repository permission `read`",
  );
  expect(() => extractOrganizationInstallPrompt(broadBasePermission, { locale: "en" }))
    .toThrow("base repository permission `none`");

  const leakedRestrictedRepo = manuals.en.replace("`infra`", "`infrastructure`");
  expect(() => extractOrganizationInstallPrompt(leakedRestrictedRepo, { locale: "en" }))
    .toThrow("`infra`");

  const clipboardFlow = manuals.en.replace("`--clipboard`", "clipboard");
  expect(() => extractOrganizationInstallPrompt(clipboardFlow, { locale: "en" }))
    .toThrow("`--clipboard`");

  const exposedConsole = manuals.en.replaceAll("PowerShell", "a command window");
  expect(() => extractOrganizationInstallPrompt(exposedConsole, { locale: "en" }))
    .toThrow("PowerShell");
});

test("Reader selects only the requested source and exposes no absolute path", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "lazurio-guide-content-"));
  for (const locale of ["cs", "en"]) {
    const target = join(fixture, ORGANIZATION_INSTALL_GUIDE_SOURCES[locale].path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, manuals[locale]);
  }

  for (const locale of ["cs", "en"]) {
    const guide = await readOrganizationInstallGuide({ rootPath: fixture, locale });
    expect(guide.locale).toBe(locale);
    expect(guide.source.path).toBe(ORGANIZATION_INSTALL_GUIDE_SOURCES[locale].path);
    expect(JSON.stringify(guide)).not.toContain(fixture);
  }

  const missing = await mkdtemp(join(tmpdir(), "lazurio-guide-missing-"));
  await expect(readOrganizationInstallGuide({ rootPath: missing, locale: "en" }))
    .rejects.toMatchObject({ code: "guide_content_unavailable" });
});
