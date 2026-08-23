import { expect, test } from "bun:test";
import {
  findLocalOrganizationPortPoolOverlaps,
  nextFreeModulePort,
  normalizeOrganizationPortPool,
  validateModuleLeasesAgainstOrganizationPools,
} from "./organization-port-policy-lib.mjs";

test("Organization manifest owns one bounded local allocation pool", () => {
  expect(normalizeOrganizationPortPool({
    manifest: { module_port_pool: { start: 24_200, end: 24_299 } },
    source: "company.gen3.json",
  })).toEqual({ pool: { start: 24_200, end: 24_299 }, issues: [] });

  const invalid = normalizeOrganizationPortPool({
    manifest: { module_port_pool: { start: 24_300, end: 24_299, global: true } },
    source: "company.gen3.json",
  });
  expect(invalid.pool).toBeNull();
  expect(invalid.issues.join("\n")).toContain("global není povolené pole");
  expect(invalid.issues.join("\n")).toContain("start nesmí být větší než end");
});

test("module leases must be unique while established leases may stay outside the new-allocation pool", () => {
  const organizations = [
    { slug: "Alpha", module_port_pool: { start: 24_000, end: 24_099 } },
    { slug: "Beta", module_port_pool: { start: 24_000, end: 24_099 } },
  ];
  const modules = [
    moduleLease("Alpha", "one", 24_001),
    moduleLease("Alpha", "two", 24_001),
    moduleLease("Alpha", "outside", 24_200),
    moduleLease("Beta", "same-number-other-org", 24_001),
    { ...moduleLease("Alpha", "no-app", 24_002), port_leases: [] },
  ];
  const issues = validateModuleLeasesAgainstOrganizationPools({ modules, organizations });
  expect(issues.join("\n")).toContain(
    "port 24001 je v Alpha deklarovaný dvakrát: one/main "
      + "(organizations/Alpha/workspace/one/lazurio.module.json) a two/main "
      + "(organizations/Alpha/workspace/two/lazurio.module.json)",
  );
  expect(issues.join("\n")).not.toContain("outside");
  expect(issues.join("\n")).not.toContain("Beta");
});

test("duplicate leases inside one Module identify both lease IDs instead of claiming two Modules", () => {
  const module = moduleLease("Alpha", "split", 24_001);
  module.port_leases.push({ id: "api", host: "127.0.0.1", port: 24_001 });
  const issues = validateModuleLeasesAgainstOrganizationPools({
    modules: [module],
    organizations: [{ slug: "Alpha", module_port_pool: { start: 24_000, end: 24_099 } }],
  });
  expect(issues).toEqual([
    "port 24001 je v Alpha deklarovaný dvakrát: split/main "
      + "(organizations/Alpha/workspace/split/lazurio.module.json) a split/api "
      + "(organizations/Alpha/workspace/split/lazurio.module.json)",
  ]);
});

test("a mounted Organization with App leases must declare its pool", () => {
  const issues = validateModuleLeasesAgainstOrganizationPools({
    modules: [moduleLease("Alpha", "one", 24_001)],
    organizations: [{ slug: "Alpha", module_port_pool: null }],
  });
  expect(issues).toContain("Alpha/one má port lease, ale jeho Organizace nemá module_port_pool");
});

test("local pool overlaps are visible but do not invent a global registry", () => {
  const overlaps = findLocalOrganizationPortPoolOverlaps([
    { slug: "Alpha", path: "organizations/Alpha", module_port_pool: { start: 24_000, end: 24_099 } },
    { slug: "Beta", path: "organizations/Beta", module_port_pool: { start: 24_050, end: 24_149 } },
    { slug: "Gamma", path: "organizations/Gamma", module_port_pool: { start: 25_000, end: 25_099 } },
  ]);
  expect(overlaps).toHaveLength(1);
  expect(overlaps[0]).toMatchObject({ start: 24_050, end: 24_099 });
  expect(overlaps[0].organizations.map((organization) => organization.company)).toEqual(["Alpha", "Beta"]);
});

test("allocator chooses the first free exact Module port inside one Organization", () => {
  expect(nextFreeModulePort({
    pool: { start: 24_000, end: 24_003 },
    company: "Alpha",
    modules: [
      moduleLease("Alpha", "one", 24_000),
      moduleLease("Beta", "same-number-other-org", 24_001),
      moduleLease("Alpha", "three", 24_002),
    ],
  })).toBe(24_001);
});

function moduleLease(company, id, port) {
  return {
    schema_version: "lazurio.module.v1",
    id,
    company,
    module_path: `organizations/${company}/workspace/${id}/lazurio.module.json`,
    port_leases: [{ id: "main", host: "127.0.0.1", port }],
  };
}
