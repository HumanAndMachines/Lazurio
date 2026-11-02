import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

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
