import { expect, test } from "bun:test";

import {
  ORGANIZATION_ROOT_REPOSITORY_GENERATIONS,
  ORGANIZATION_ROOT_SCAFFOLD_GENERATION,
  declaredOrganizationRootLocator,
  isOrganizationRootRepositoryName,
  organizationRootDeclaresItself,
  organizationRootFolderMatchesRepository,
  organizationRootRepositoryNames,
  parseOrganizationRootRepositoryName,
  selectOrganizationRootRepository,
  stripOrganizationRootGeneration,
} from "./organization-root-repository-lib.mjs";
import { isValidForgeBindingShape } from "./organization-forge-binding-lib.mjs";
import { createOrganizationScaffold } from "./organization-scaffold-lib.mjs";
import {
  githubRepositoryCoordinateIdentity,
  githubRepositoryUrlIdentity,
} from "../organization-compiler/repository-identity.mjs";

// LZD-0041 G1: the suffix names the candidates, the declaration picks the root.

test("names: GEN4 is preferred, GEN3 stays, nothing else is a root name", () => {
  expect(ORGANIZATION_ROOT_REPOSITORY_GENERATIONS).toEqual(["GEN4", "GEN3"]);
  expect(organizationRootRepositoryNames("Example")).toEqual(["Example_GEN4", "Example_GEN3"]);
  expect(parseOrganizationRootRepositoryName("Example-ai_GEN4")).toEqual({ login: "Example-ai", generation: "GEN4" });
  expect(parseOrganizationRootRepositoryName("Example_GEN5")).toBeNull();
  expect(parseOrganizationRootRepositoryName("Example")).toBeNull();
  expect(parseOrganizationRootRepositoryName("-bad_GEN3")).toBeNull();
  expect(isOrganizationRootRepositoryName("example_GEN3", "Example")).toBe(true);
  expect(isOrganizationRootRepositoryName("Other_GEN4", "Example")).toBe(false);
  expect(stripOrganizationRootGeneration("Example_GEN4")).toBe("Example");
  expect(stripOrganizationRootGeneration("Example_GEN3")).toBe("Example");
  expect(stripOrganizationRootGeneration("knowledgebase")).toBe("knowledgebase");
  expect(() => organizationRootRepositoryNames("bad login")).toThrow();
});

test("folder and repository: same name, or the same login with the other suffix (decision N2)", () => {
  const exact = (left, right) => left === right;
  expect(organizationRootFolderMatchesRepository("Example_GEN4", "Example_GEN4", { sameName: exact })).toBe(true);
  expect(organizationRootFolderMatchesRepository("Example_GEN3", "Example_GEN4", { sameName: exact })).toBe(true);
  expect(organizationRootFolderMatchesRepository("Example_GEN4", "Example_GEN3", { sameName: exact })).toBe(true);
  expect(organizationRootFolderMatchesRepository("example_GEN3", "Example_GEN4", { sameName: exact })).toBe(false);
  expect(organizationRootFolderMatchesRepository("Other_GEN3", "Example_GEN4", { sameName: exact })).toBe(false);
  expect(organizationRootFolderMatchesRepository("Example", "Example_GEN4", { sameName: exact })).toBe(false);
  const folded = (left, right) => left.toLowerCase() === right.toLowerCase();
  expect(organizationRootFolderMatchesRepository("EXAMPLE_GEN3", "Example_GEN4", { sameName: folded })).toBe(true);
});

test("declaration: the canonical manifest is the authority; legacy declares only without it", () => {
  const canonical = {
    organization: { forge_binding: { locator: "Example" } },
    root_repository: { locator: "Example/Example_GEN4" },
  };
  const company = { company: { github_org: "Example", root_repository: "Example/Example_GEN3" } };
  expect(declaredOrganizationRootLocator({ canonicalManifest: canonical, companyManifest: company }))
    .toEqual({ login: "Example", locator: "Example/Example_GEN4" });
  expect(declaredOrganizationRootLocator({ companyManifest: company }))
    .toEqual({ login: "Example", locator: "Example/Example_GEN3" });
  expect(declaredOrganizationRootLocator({ canonicalManifest: { ...canonical, root_repository: null } })).toBeNull();
  expect(organizationRootDeclaresItself({ fullName: "example/example_gen4", login: "EXAMPLE", canonicalManifest: canonical })).toBe(true);
  expect(organizationRootDeclaresItself({ fullName: "Example/Example_GEN3", login: "Example", canonicalManifest: canonical })).toBe(false);
  expect(organizationRootDeclaresItself({ fullName: "Example/Example_GEN4", login: "Other", canonicalManifest: canonical })).toBe(false);
});

test("selection: one candidate as before, both declared prefers GEN4, otherwise fail closed", () => {
  const gen3 = (presence, declares) => ({ generation: "GEN3", presence, declares });
  const gen4 = (presence, declares) => ({ generation: "GEN4", presence, declares });
  expect(selectOrganizationRootRepository([gen4("absent", false), gen3("absent", false)])).toMatchObject({ status: "absent" });
  // Only GEN3 (today), declared or not (a local-first legacy root declares none).
  expect(selectOrganizationRootRepository([gen4("absent", false), gen3("present", false)]).candidate.generation).toBe("GEN3");
  expect(selectOrganizationRootRepository([gen4("present", true), gen3("absent", false)]).candidate.generation).toBe("GEN4");
  // Both exist, the GEN4 copy still declares GEN3.
  expect(selectOrganizationRootRepository([gen4("present", false), gen3("present", true)]).candidate.generation).toBe("GEN3");
  // Both declare themselves.
  expect(selectOrganizationRootRepository([gen4("present", true), gen3("present", true)]))
    .toMatchObject({ status: "selected", candidate: { generation: "GEN4" }, reason: "both_declare_gen4_preferred" });
  // A freshly created empty GEN4 never displaces a working GEN3.
  expect(selectOrganizationRootRepository([gen4("empty", false), gen3("present", false)]).candidate.generation).toBe("GEN3");
  // Two working candidates and no declaration to decide by.
  expect(selectOrganizationRootRepository([gen4("present", false), gen3("present", false)]))
    .toMatchObject({ status: "conflict", reason: "canonical_root_candidate_conflict" });
  expect(selectOrganizationRootRepository([gen4("empty", false), gen3("empty", false)])).toMatchObject({ status: "conflict" });
});

test("readers: forge binding, repository identity and the company.gen3 schema accept both names", async () => {
  const binding = (fullName) => ({
    schema_version: "lazurio.forge-binding.github.v0",
    provider: "github",
    organization: { id: "1", asserted_login: "Example" },
    repository: { id: "2", asserted_full_name: fullName, default_branch: "main" },
  });
  expect(isValidForgeBindingShape(binding("Example/Example_GEN3"))).toBe(true);
  expect(isValidForgeBindingShape(binding("Example/Example_GEN4"))).toBe(true);
  expect(isValidForgeBindingShape(binding("Example/Example_GEN5"))).toBe(false);
  // A root keeps the name it was created under when its Organization is
  // renamed (LazurioPlatform#1281): any root name the login owns, bound by
  // the repository's immutable id.
  expect(isValidForgeBindingShape(binding("Example/Other_GEN4"))).toBe(true);
  expect(isValidForgeBindingShape(binding("Other/Example_GEN4"))).toBe(false);
  expect(githubRepositoryUrlIdentity("git@github.com:Example/Example_GEN4.git")).toBe("example/Example_GEN4");
  expect(githubRepositoryCoordinateIdentity("Example/Example_GEN4")).toBe("example/Example_GEN4");
  expect(githubRepositoryCoordinateIdentity("Example/Example_GEN5")).toBeNull();
  const schema = await Bun.file(new URL("../schemas/company.gen3.schema.json", import.meta.url)).json();
  const company = schema.properties.company.properties;
  for (const [field, value] of [["root_repository", "Example/Example_GEN4"], ["repository", "git@github.com:Example/Example_GEN4.git"]]) {
    expect(new RegExp(company[field].pattern, "u").test(value)).toBe(true);
    expect(new RegExp(company[field].pattern, "u").test(value.replace("GEN4", "GEN5"))).toBe(false);
  }
});

test("the scaffold keeps founding GEN3 roots until the founding gate (decision N4)", () => {
  expect(ORGANIZATION_ROOT_SCAFFOLD_GENERATION).toBe("GEN3");
  const scaffold = (name) => createOrganizationScaffold({
    organization: { id: "1", login: "Example", slug: "example-org", displayName: "Example" },
    repository: { id: "2", name, fullName: `Example/${name}`, defaultBranch: "main" },
  });
  expect(scaffold("Example_GEN3").forge_binding.repository.asserted_full_name).toBe("Example/Example_GEN3");
  expect(() => scaffold("Example_GEN4")).toThrow("Example_GEN3");
});
