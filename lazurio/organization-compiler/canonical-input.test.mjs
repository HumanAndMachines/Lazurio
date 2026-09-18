import { describe, expect, test } from "bun:test";
import { cp, mkdtemp, readFile, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { prepareOrganizationCompilation } from "./compiler-core.mjs";

const fixtures = join(import.meta.dirname, "..", "migrations", "organization-manifest", "fixtures");
// Explicit offline dry-run: the fixture has no checkout origin to observe.
const offline = { status: "offline" };

describe("Organization compiler input", () => {
  test("a transition root compiles from lazurio.organization.json through its deterministic projection", async () => {
    const legacyRoot = await fixtureCopy("gen3-organization");
    const transitionRoot = await fixtureCopy("gen3-organization-transition");
    try {
      const legacy = await prepareOrganizationCompilation({ organizationRoot: legacyRoot, repositoryObservation: offline });
      const transition = await prepareOrganizationCompilation({ organizationRoot: transitionRoot, repositoryObservation: offline });

      expect(legacy.report.config_path).toBe("company.gen3.json");
      expect(transition.report.config_path).toBe("lazurio.organization.json");
      expect(transition.report.context.map((item) => item.path)).toEqual([
        "lazurio.organization.json",
        "company.gen3.json",
        "modules.manifest.json",
      ]);
      const summary = JSON.parse(transition.writes.find((write) => write.path === "generated/company-summary.json").content);
      expect(summary.source_files).toEqual(["lazurio.organization.json", "modules.manifest.json"]);
      expect(transition.writes.find((write) => write.path === "generated/business-context.md").content)
        .toContain("generovaný z `lazurio.organization.json`");

      // Same Organization, same generated content regardless of which
      // document is the input: the projection is the normalized legacy shape
      // (its modules[] is sorted by path, so compare modules as a set).
      const generated = (prepared, path) => prepared.writes.find((write) => write.path === path).content
        .replaceAll("lazurio.organization.json", "company.gen3.json");
      for (const path of ["generated/business-context.md", "generated/generation-policy.md"]) {
        expect(generated(transition, path)).toBe(generated(legacy, path));
      }
      const modulesIndex = (prepared) => JSON.parse(generated(prepared, "generated/modules.index.json"));
      const byPath = (entries) => [...entries].sort((left, right) => left.path.localeCompare(right.path));
      expect(byPath(modulesIndex(transition).modules)).toEqual(byPath(modulesIndex(legacy).modules));
      expect(modulesIndex(transition).manifest_slots).toEqual(modulesIndex(legacy).manifest_slots);
      expect(modulesIndex(transition).teams).toEqual(modulesIndex(legacy).teams);

      // Once the canonical file exists, the on-disk legacy document is never
      // the input: a stale hand edit surfaces as an authority conflict.
      const staleLegacyRoot = await fixtureCopy("gen3-organization-transition");
      try {
        const legacyPath = join(staleLegacyRoot, "company.gen3.json");
        const company = JSON.parse(await readFile(legacyPath, "utf8"));
        company.company.display_name = "Edited by hand";
        await Bun.write(legacyPath, `${JSON.stringify(company, null, 2)}\n`);
        await expect(prepareOrganizationCompilation({ organizationRoot: staleLegacyRoot, repositoryObservation: offline })).rejects.toMatchObject({
          name: "OrganizationCompilerError",
          message: expect.stringContaining("Organization authority conflict: conflict"),
        });
      } finally {
        await rm(staleLegacyRoot, { recursive: true, force: true });
      }

      // `current` (canonical only) compiles from the same projection.
      await unlink(join(transitionRoot, "company.gen3.json"));
      const current = await prepareOrganizationCompilation({ organizationRoot: transitionRoot, repositoryObservation: offline });
      expect(current.report.config_path).toBe("lazurio.organization.json");
      expect(current.report.context.map((item) => item.path)).toEqual(["lazurio.organization.json", "modules.manifest.json"]);
    } finally {
      await rm(legacyRoot, { recursive: true, force: true });
      await rm(transitionRoot, { recursive: true, force: true });
    }
  });

  test("a root without any Organization manifest fails with the canonical filename first", async () => {
    const root = await mkdtemp(join(tmpdir(), "organization-compiler-empty-"));
    try {
      await expect(prepareOrganizationCompilation({ organizationRoot: root })).rejects.toMatchObject({
        message: expect.stringContaining("Chybí Organization manifest (lazurio.organization.json nebo company.gen3.json)"),
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function fixtureCopy(name) {
  const root = await mkdtemp(join(tmpdir(), "organization-compiler-canonical-"));
  await cp(join(fixtures, name), root, { recursive: true });
  return root;
}
