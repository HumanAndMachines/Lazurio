import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GuideContentError,
  ORGANIZATION_INSTALL_GUIDE_SCHEMA,
  ORGANIZATION_INSTALL_PROMPT_END,
  ORGANIZATION_INSTALL_PROMPT_START,
  buildOrganizationInstallGuide,
  extractOrganizationInstallPrompt,
  readOrganizationInstallGuide,
} from "./guide-content-lib.mjs";

const repositoryRoot = join(import.meta.dirname, "..", "..");
const manualPath = join(repositoryRoot, "manual", "organization-install.md");
const actualManual = await readFile(manualPath, "utf8");

test("Guide projects the marked short prompt and full policy from one manual", () => {
  const guide = buildOrganizationInstallGuide(actualManual);
  expect(guide).toMatchObject({
    schema_version: ORGANIZATION_INSTALL_GUIDE_SCHEMA,
    source: {
      path: "manual/organization-install.md",
      authority: "lazurio-root-manual",
    },
  });
  expect(guide.short_prompt).toContain("Lazurio for GitHub");
  expect(guide.short_prompt).toContain("All repositories");
  expect(guide.short_prompt).toContain("Node.js LTS");
  expect(guide.short_prompt).toContain("versioned Organization manifest");
  expect(guide.short_prompt).toContain("runtime ready");
  expect(guide.short_prompt).not.toContain(ORGANIZATION_INSTALL_PROMPT_START);
  expect(guide.policy_markdown).toBe(actualManual);
});

test("Guide fails closed when either prompt marker is missing or duplicated", () => {
  for (const manual of [
    actualManual.replace(ORGANIZATION_INSTALL_PROMPT_START, ""),
    actualManual.replace(ORGANIZATION_INSTALL_PROMPT_END, ""),
    `${ORGANIZATION_INSTALL_PROMPT_START}\n${actualManual}`,
  ]) {
    expect(() => extractOrganizationInstallPrompt(manual)).toThrow(GuideContentError);
    try {
      extractOrganizationInstallPrompt(manual);
    } catch (error) {
      expect(error.code).toBe("guide_prompt_markers_invalid");
    }
  }
});

test("Guide rejects malformed blockquote and missing safety contract", () => {
  const malformed = actualManual.replace(
    "> Připrav tuto Mašinu",
    "Připrav tuto Mašinu",
  );
  expect(() => extractOrganizationInstallPrompt(malformed)).toThrow(
    "Krátký instalační prompt musí být jeden souvislý Markdown blockquote.",
  );

  const weakened = actualManual.replace("All repositories", "vybraný rozsah");
  expect(() => extractOrganizationInstallPrompt(weakened)).toThrow("All repositories");
});

test("Reader exposes no absolute source path and sanitizes missing-file failure", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "lazurio-guide-content-"));
  await mkdir(join(fixture, "manual"));
  await writeFile(join(fixture, "manual", "organization-install.md"), actualManual);

  const guide = await readOrganizationInstallGuide({ rootPath: fixture });
  expect(guide.source.path).toBe("manual/organization-install.md");
  expect(JSON.stringify(guide)).not.toContain(fixture);

  const missing = await mkdtemp(join(tmpdir(), "lazurio-guide-missing-"));
  await expect(readOrganizationInstallGuide({ rootPath: missing })).rejects.toMatchObject({
    code: "guide_content_unavailable",
    message: "Autoritativní instalační manuál teď nelze bezpečně načíst.",
  });
});
