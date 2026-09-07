import { expect, test } from "bun:test";
import { posix, win32 } from "path";
import { readFile } from "node:fs/promises";
import { validateAgainstSchema } from "../lazurio/runtime/json-schema-mini.mjs";

import {
  PERSONAL_SCHEMA_VERSION,
  PERSONALSPACE_TEMPLATE,
  PERSONALSPACE_TEMPLATE_VERSION,
  parseCreateArgs,
  createPersonalspace,
  targetForRoot,
  validateGbrainRepoOption,
  validateTemplateMarker,
} from "./create-personalspace.mjs";

test("create parser drží apply a gbrain instalaci explicitní", () => {
  expect(parseCreateArgs([
    "--display-name",
    "Example Owner",
    "--apply",
    "--install-gbrain",
  ])).toMatchObject({
    displayName: "Example Owner",
    apply: true,
    installGbrain: true,
    ownerType: "human",
  });
  expect(() => parseCreateArgs(["--with-buddy"])).toThrow("Neznámý argument");
  expect(() => parseCreateArgs(["--buddy-repo", "example/example-assistant"])).toThrow(
    "Neznámý argument",
  );
  expect(PERSONALSPACE_TEMPLATE).toBe("Lazurio/PersonalspaceTemplate_GEN3");
});

test("cílový mount je deterministický v POSIX i Windows cestě", () => {
  expect(targetForRoot("/home/example/Conglomerate", "example", posix)).toBe(
    "/home/example/Conglomerate/personalspace/example_GEN3",
  );
  expect(targetForRoot("D:\\Home\\Example\\Conglomerate", "example", win32)).toBe(
    "D:\\Home\\Example\\Conglomerate\\personalspace\\example_GEN3",
  );
});

test("neznámý argument a chybějící hodnota failují", () => {
  expect(() => parseCreateArgs(["--unknown"])).toThrow();
  expect(() => parseCreateArgs(["--display-name"])).toThrow();
});

test("template marker váže přesný upstream a verzi personal kontraktu", () => {
  expect(validateTemplateMarker({
    schema_version: PERSONALSPACE_TEMPLATE_VERSION,
    template_repo: PERSONALSPACE_TEMPLATE,
    personal_schema_version: PERSONAL_SCHEMA_VERSION,
  })).toEqual([]);
  expect(validateTemplateMarker({
    schema_version: "unknown",
    template_repo: "other/repo",
    personal_schema_version: "legacy",
  })).toHaveLength(3);
});

test("custom gbrain repo patří ownerovi a nikdy nealiasuje owner repo", () => {
  expect(validateGbrainRepoOption("example", "example/example-gbrain")).toEqual([]);
  expect(validateGbrainRepoOption("example", "other/example-gbrain")).toHaveLength(1);
  expect(validateGbrainRepoOption("example", "example/example_GEN3")).toHaveLength(1);
  expect(validateGbrainRepoOption("example", "invalid")).toHaveLength(1);
});

test("new non-human Personalspace fails before filesystem or provider operations", async () => {
  const root = "/nonexistent-lazurio-mandate-test";
  for (const ownerType of ["ai-colleague", "unknown"]) {
    await expect(createPersonalspace({ ownerType, apply: true }, { root }))
      .rejects.toThrow("Nový Personalspace patří pouze člověku");
  }
  // Human creation proceeds to the existing root preflight, without touching GitHub.
  await expect(createPersonalspace({ ownerType: "human", apply: false }, { root }))
    .rejects.toThrow("Příkaz spusť z kořene Lazuria");
});

test("legacy Personalspace owner records remain readable without reclassification", async () => {
  const schema = JSON.parse(await readFile(new URL("../lazurio/schemas/personal.gen3.schema.json", import.meta.url), "utf8"));
  for (const type of ["human", "ai-colleague"]) {
    expect(validateAgainstSchema({ github_username: "example", display_name: "Example", type }, schema.properties.owner, "owner")).toEqual([]);
  }
});
