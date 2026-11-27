import { expect, test } from "bun:test";

import {
  isValidForgeBindingShape,
  isValidOrganizationForgeBinding,
  ORGANIZATION_FORGE_BINDING_VERSION,
} from "./organization-forge-binding-lib.mjs";

// LazurioPlatform#1281: a rename of the Organization on GitHub keeps its root
// repository, its id and its name (`<earlier login>_GEN3`). The root binds by
// the immutable ids; its name only has to be a root name owned by the login.
const binding = (login, fullName) => ({
  schema_version: ORGANIZATION_FORGE_BINDING_VERSION,
  provider: "github",
  organization: { id: "12345678", asserted_login: login },
  repository: { id: "87654321", asserted_full_name: fullName, default_branch: "main" },
});

test("a renamed Organization's root keeps the name it was created under", () => {
  for (const fullName of ["Renamed/Example_GEN3", "Renamed/Example_GEN4", "renamed/Renamed_GEN3"])
    expect(isValidForgeBindingShape(binding("Renamed", fullName))).toBe(true);
  // Bound by the live ids and names the callers read.
  expect(isValidOrganizationForgeBinding(binding("Renamed", "Renamed/Example_GEN3"), {
    organizationId: "12345678",
    organizationLogin: "Renamed",
    repositoryId: "87654321",
    repositoryFullName: "Renamed/Example_GEN3",
  })).toBe(true);
  expect(isValidOrganizationForgeBinding(binding("Renamed", "Renamed/Example_GEN3"), {
    repositoryId: "99999999",
  })).toBe(false);
  expect(isValidOrganizationForgeBinding(binding("Renamed", "Renamed/Example_GEN3"), {
    organizationId: "99999999",
  })).toBe(false);
});

test("the root is still a root name owned by the Organization's login", () => {
  for (const fullName of [
    "Other/Example_GEN3", // another owner
    "Renamed/Example", // no root suffix
    "Renamed/Example_GEN5",
    "Renamed/_GEN3",
    "Renamed/Example_GEN3/extra",
    "Renamed",
  ])
    expect(isValidForgeBindingShape(binding("Renamed", fullName))).toBe(false);
});
