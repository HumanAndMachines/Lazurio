import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const launchpadRoot = join(import.meta.dir, "..");
const repositoryRoot = join(launchpadRoot, "..");

const documents = [
  readFileSync(join(repositoryRoot, "ARCHITECTURE.md"), "utf8"),
  readFileSync(join(launchpadRoot, "README.md"), "utf8"),
  readFileSync(join(launchpadRoot, "docs", "hosted-workspace-parity-contract.md"), "utf8"),
  readFileSync(join(launchpadRoot, "docs", "launchpad-gen3-redesign-spec.md"), "utf8"),
];

function expectAny(document, patterns) {
  expect(patterns.some((pattern) => pattern.test(document))).toBe(true);
}

test("hosted workspace docs keep development preview separate from production", () => {
  for (const document of documents) {
    expect(document).toMatch(/development workshop|vývojov\S*\s+díln\S*|vývojový preview/i);
    expect(document).toMatch(/private|privátní/);
    expect(document).toMatch(/Tailscale|VPN/);
    expectAny(document, [
      /not (?:a )?production/i,
      /ne produkční|nikoli produkční|není produkce/i,
    ]);
  }
});

test("runtime docs keep production delivery outside lazurio.runtime.v1", () => {
  for (const document of documents) {
    expect(document).toContain("lazurio.runtime.v1");
    expectAny(document, [/Launchpad.{0,40}Doctor/s, /Doctor.{0,40}Launchpad/s]);
    expectAny(document, [
      /protected source\/tag/,
      /chráněn\S*\s+source\/tag\S*/,
      /chráněn\S*\s+source\s+commitem\s+nebo\s+tagem/,
    ]);
    expectAny(document, [
      /immutable artifact|immutable artefakt/,
      /neměnn\S*(?:\s+\(immutable\))?\s+artefakt/,
    ]);
    expectAny(document, [
      /isolated\s+production\s+runtime/,
      /izolovan\S*\s+produkční\S*\s+runtime/,
      /izolovan\S*.{0,20}produkční\S*\s+runtime/s,
    ]);
    expect(document).toMatch(/public.{0,20}authenticated.{0,20}internal/s);
    expect(document).toMatch(/no T3|neobsahuje T3/i);
  }
});

test("hosted workspace docs keep Dashboard and supervisor authority narrow", () => {
  for (const document of documents) {
    expectAny(document, [
      /T3 Code (?:a|and) Launchpad\s+(?:jsou|are)\s+`desired-running`/,
      /supervisor.{0,40}(?:udržuje|hlídá|watches).{0,40}T3 Code.{0,20}Launchpad/is,
    ]);
    expect(document).toMatch(/supervisor.{0,40}(?:pouze|only)/is);
    expectAny(document, [
      /Dashboard(?: Development)?.{0,40}(?:právě|jen|pouze|only).{0,20}(?:projektuje|projektovat|projects|zpřístupňuje)/is,
      /Dashboard(?: Development)?.{0,40}(?:projektuje|projektovat|projects).{0,20}(?:právě|jen|pouze|only)/is,
    ]);
    expectAny(document, [
      /deployment\s+katalogu|deployment\s+catalog/,
      /katalogu\s+produkčních\s+nasazení/,
    ]);
    expectAny(document, [
      /nikdy\s+z\s+Workspace\s+service\s+katalogu/,
      /never\s+from\s+the\s+Workspace\s+service\s+catalog/,
      /nikdy\s+ze\s+seznamu\s+vývojových\s+služeb\s+Workspace/,
    ]);
  }
});
