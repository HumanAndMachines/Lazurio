import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { validateAgainstSchema } from "./runtime/json-schema-mini.mjs";
import schema from "./lazurio.organization.v1.schema.json";
import provenance from "./lazurio.organization.v1.schema.provenance.json";

// The Organization manifest's schema belongs to LazurioPlatform (decision
// 0225). The Root carries it byte for byte as pinned by commit and SHA-256 and
// never extends it on its own: a change comes from LazurioPlatform with a new
// pin, and Core follows (lazurio/core/organization-settings-lib.mjs).
test("the Organization schema is LazurioPlatform's, byte for byte as pinned", () => {
  const bytes = readFileSync(new URL("./lazurio.organization.v1.schema.json", import.meta.url));
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(provenance.sha256);
  expect(provenance.sha256).toBe(provenance.source_sha256);
  expect(provenance.source_repository).toBe("Lazurio/LazurioPlatform");
  expect(provenance.source_path).toBe("src/organizations/lazurio.organization.v1.schema.json");
  expect(provenance.source_commit).toMatch(/^[0-9a-f]{40}$/);
  const schema = JSON.parse(bytes.toString("utf8"));
  expect(schema.$id).toBe("https://lazurio.io/schemas/lazurio.organization.v1.schema.json");
});

// The pinned schema forbids a field with a boolean subschema (`false`), as
// JSON Schema 2020-12 allows; the Root's validator must refuse a value there
// and accept anything against `true` (review on HumanAndMachines/Lazurio#710).
test("boolean subschemas: false refuses a value, true accepts every value", () => {
  expect(validateAgainstSchema(1, false, "x")).toEqual(["x: hodnota zde není povolená"]);
  expect(validateAgainstSchema({ a: 1 }, true, "x")).toEqual([]);
  const node = { type: "object", properties: { forbidden: false, free: true } };
  expect(validateAgainstSchema({ forbidden: "y" }, node, "x")).toEqual(["x.forbidden: hodnota zde není povolená"]);
  expect(validateAgainstSchema({ free: ["anything"] }, node, "x")).toEqual([]);
});

test("boolean subschemas hold wherever a subschema stands: items, if/then/else, not, contains, propertyNames", () => {
  const refused = "x: hodnota zde není povolená";
  expect(validateAgainstSchema([1], { type: "array", items: false }, "x")).toEqual(["x[0]: hodnota zde není povolená"]);
  expect(validateAgainstSchema([], { type: "array", items: false }, "x")).toEqual([]);
  expect(validateAgainstSchema([1, "a"], { type: "array", items: true }, "x")).toEqual([]);
  expect(validateAgainstSchema(1, { if: true, then: false, else: true }, "x")).toEqual([refused]);
  expect(validateAgainstSchema(1, { if: false, then: true, else: false }, "x")).toEqual([refused]);
  expect(validateAgainstSchema(1, { not: true }, "x")).toEqual(["x: hodnota odpovídá zakázané 'not' větvi"]);
  expect(validateAgainstSchema(1, { not: false }, "x")).toEqual([]);
  expect(validateAgainstSchema([1], { contains: false }, "x")).toEqual([
    "x: pole neobsahuje žádnou položku odpovídající 'contains'",
  ]);
  expect(validateAgainstSchema([1], { contains: true }, "x")).toEqual([]);
  expect(validateAgainstSchema({ a: 1 }, { type: "object", propertyNames: false }, "x")).toEqual([
    "x.a#propertyName: hodnota zde není povolená",
  ]);
  expect(validateAgainstSchema({}, { type: "object", propertyNames: false }, "x")).toEqual([]);
  expect(validateAgainstSchema(1, { allOf: [true, false] }, "x")).toEqual([refused]);
  expect(validateAgainstSchema(1, { anyOf: [false, true] }, "x")).toEqual([]);
});

test("an unverified binding may not carry a GitHub id, for the Organization and for its root repository", () => {
  const organizationIds = validateAgainstSchema(
    manifest({ organizationBinding: { organization_id: "123" } }),
    schema,
    "organization",
  );
  expect(organizationIds.some((failure) => failure.includes("organization_id"))).toBe(true);
  // `root_repository` is `anyOf` null or the binding, so the whole manifest
  // reports only that no branch matched; the binding on its own names the field.
  expect(validateAgainstSchema(manifest({ rootBinding: { repository_id: "456" } }), schema, "organization")).not.toEqual([]);
  const binding = { $ref: "#/$defs/repositoryForgeBinding", $defs: schema.$defs };
  const repositoryIds = validateAgainstSchema(
    manifest({ rootBinding: { repository_id: "456" } }).root_repository,
    binding,
    "root_repository",
  );
  expect(repositoryIds).toEqual(["root_repository.repository_id: hodnota zde není povolená"]);
  expect(validateAgainstSchema(manifest({}), schema, "organization")).toEqual([]);
});

function manifest({ organizationBinding = {}, rootBinding = {} }) {
  return {
    schema_version: "lazurio.organization.v1",
    kind: "organization",
    organization: {
      slug: "example-org",
      display_name: "Example Organization",
      forge_binding: { forge: "github", locator: "Example", binding_state: "unverified", ...organizationBinding },
      metadata: {},
    },
    root_repository: {
      forge: "github",
      locator: "Example/Example_GEN3",
      default_branch: "main",
      binding_state: "unverified",
      ...rootBinding,
    },
    manifests: { modules: "modules.manifest.json" },
    extensions: { legacy: {} },
    compatibility: {
      legacy_projection: {
        path: "company.gen3.json",
        algorithm: "sha256-canonical-json-v1",
        sha256: `sha256:${"0".repeat(64)}`,
      },
    },
  };
}
