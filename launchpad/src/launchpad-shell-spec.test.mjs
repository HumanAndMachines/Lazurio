import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

const specUrl = new URL("../docs/launchpad-gen3-redesign-spec.md", import.meta.url);

function normalized(paragraph) {
  return paragraph.replace(/\s+/g, " ").trim();
}

test("schválená revize shellu odděluje prostor, Prostředí a jejich autority", async () => {
  const spec = await readFile(specUrl, "utf8");
  const revision = spec.split("Revidováno 2026-09-21 (owner-approved, horní část shellu; plán DEV-6615) —")[1]
    ?.split("Implementation surface:")[0];
  expect(revision).toBeTruthy();

  const paragraphs = revision.split(/\n\s*\n/).map(normalized);
  const rail = paragraphs.find((paragraph) => paragraph.includes("v rozbaleném stavu"));
  const header = paragraphs.find((paragraph) => paragraph.startsWith("Horní lišta"));
  const environment = paragraphs.find((paragraph) => paragraph.startsWith("Upřesnění 2026-09-24"));

  expect(rail).toMatch(/Rail volí \*\*prostor\*\*: Osobní prostor nebo Organizaci; jednotlivou Mašinu nevybírá\./);
  expect(header).toMatch(/Hlavička drží značku Organizace a její název/);
  expect(environment).toMatch(/přepínač \*\*Prostředí\*\* vedle názvu aktivního prostoru/);
  expect(environment).toMatch(/v Organizaci týmové a pracovní VM.*v Osobním prostoru jedinou osobní VM.*na workstationu „Tento počítač“/);
  expect(environment).toMatch(/Přepnutí otevře Launchpad zvolené Mašiny na jiném originu přes SSO/);
  expect(environment).toMatch(/Dashboard vlastní seznam dostupných Prostředí.*Launchpad jej pouze konzumuje/);
  expect(environment).toMatch(/Nastavení.*vybraného Prostředí.*#414/);
});
