import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";

// The preparation schema must not accept what the LazurioPlatform reader
// (parsePreparationDeclaration, F25) refuses; otherwise MS-04 could call a
// Module conformant that the Platform cannot start. The reader's grammar is
// mirrored here as regular expressions from the schema file itself.
const schema = JSON.parse(readFileSync(new URL("./schemas/lazurio-preparation.schema.json", import.meta.url), "utf8"));
const ownerPattern = new RegExp(schema.properties.owner_package.pattern);
const scriptPattern = new RegExp(schema.properties.prepare_script.pattern);
const lifecycle = new Set(schema.properties.prepare_script.not.enum);
const scriptAccepted = (name) => scriptPattern.test(name) && !lifecycle.has(name);

// Same regular expressions the Platform reader uses (src/modules/preparation-declaration.ts).
const platformOwner = /^(?:(?!\.{1,2}\/)[A-Za-z0-9._-]+\/)*package\.json$/;
const platformScript = /^[A-Za-z][A-Za-z0-9:_-]*$/;

test("owner_package: every Bun path the schema accepts is one the Platform reader accepts", () => {
  for (const path of ["app/v1/package.json", "app/v3/package.json", "apps/web-1.0/package.json"]) {
    expect(ownerPattern.test(path)).toBe(true);
    expect(platformOwner.test(path)).toBe(true);
  }
  // Refused by the reader (traversal, absolute, spaces, wrong file) and by the schema.
  for (const path of ["../app/package.json", "app/../package.json", "/app/v1/package.json", "app/v 1/package.json", "app/v1/Package.json", "app/v1/package.json/", "app/v1"]) {
    expect(platformOwner.test(path)).toBe(false);
    expect(ownerPattern.test(path)).toBe(false);
  }
  // Stricter than the reader on purpose: the App never sits in the Module root.
  expect(platformOwner.test("package.json")).toBe(true);
  expect(ownerPattern.test("package.json")).toBe(false);
  // Reserved Python form: accepted by the schema, not by today's reader (documented).
  expect(ownerPattern.test("app/v1/pyproject.toml")).toBe(true);
  expect(platformOwner.test("app/v1/pyproject.toml")).toBe(false);
});

test("script names: the schema grammar equals the reader's and adds the lifecycle ban", () => {
  for (const name of ["prepare:app", "check:prepared", "build_client", "prepareData-2"]) {
    expect(platformScript.test(name)).toBe(true);
    expect(scriptAccepted(name)).toBe(true);
  }
  for (const name of ["", "1build", "-x", "bun run build", "prepare app", "check.prepared", "vite build && echo", "prepare:app\n"]) {
    expect(platformScript.test(name)).toBe(false);
    expect(scriptAccepted(name)).toBe(false);
  }
  for (const name of ["prepare", "preprepare", "postprepare", "install", "preinstall", "postinstall", "prepublishOnly", "prepack"]) {
    expect(platformScript.test(name)).toBe(true);
    expect(scriptAccepted(name)).toBe(false);
  }
});

test("runtime: uv requires uv_version, bun is the absent default", () => {
  expect(schema.properties.runtime.enum).toEqual(["bun", "uv"]);
  expect(schema.properties.runtime.default).toBe("bun");
  expect(schema.if).toEqual({ properties: { runtime: { const: "uv" } }, required: ["runtime"] });
  expect(schema.then).toEqual({ required: ["uv_version"] });
  expect(schema.required).toEqual(["schema_version", "owner_package", "check_script"]);
});
