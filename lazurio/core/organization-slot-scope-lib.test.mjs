import { describe, expect, test } from "bun:test";

import {
  isCanonicalOrganizationRepositorySlotPath,
  isOrganizationRepositoryDbSlot,
  organizationRootRepositoryAliasIssues,
  organizationRootRepositoryBranch,
  organizationRootRepositoryRemote,
  organizationRepositorySlotCollectionIssues,
  organizationSlotCatalogPresentation,
  organizationSlotRepositoryAliasIssues,
  organizationSlotRepositoryBranch,
  organizationSlotRepositoryId,
  organizationSlotRepositoryMountIssue,
  organizationSlotRepositoryRemote,
  organizationSlotUiExposure,
} from "./organization-slot-scope-lib.mjs";

describe("Organization root repository alias authority", () => {
  test("uses canonical fields while accepting equivalent GitHub transports and branch aliases", () => {
    const manifest = {
      company: {
        repository: "git@github.com:Example/Example_GEN3.git",
        git_url: "https://github.com/Example/Example_GEN3.git",
        root_repository: "Example/Example_GEN3",
        default_branch: "main",
      },
      default_branch: "main",
    };
    expect(organizationRootRepositoryAliasIssues(manifest)).toEqual([]);
    expect(organizationRootRepositoryRemote(manifest)).toBe(
      "git@github.com:Example/Example_GEN3.git",
    );
    expect(organizationRootRepositoryBranch(manifest)).toBe("main");
  });

  test("blocks conflicting root remote and branch aliases instead of choosing by field order", () => {
    expect(organizationRootRepositoryAliasIssues({
      company: {
        repository: "git@github.com:NewOrg/NewOrg_GEN3.git",
        git_url: "git@github.com:OldOrg/OldOrg_GEN3.git",
        default_branch: "main",
      },
      default_branch: "develop",
    })).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "organization_root_remote_conflict" }),
      expect.objectContaining({ code: "organization_root_branch_conflict" }),
    ]));
  });

  test("malformed canonical root aliases cannot fall through to valid legacy fields", () => {
    const manifest = {
      company: {
        repository: { owner: "NewOrg" },
        git_url: "git@github.com:OldOrg/OldOrg_GEN3.git",
        default_branch: " main ",
      },
      default_branch: "main",
    };
    expect(organizationRootRepositoryAliasIssues(manifest)).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "organization_root_remote_alias_invalid" }),
      expect.objectContaining({ code: "organization_root_branch_alias_invalid" }),
    ]));
    expect(organizationRootRepositoryRemote(manifest)).toBeNull();
    expect(organizationRootRepositoryBranch(manifest)).toBeNull();
  });

  test("rejects a non-main Organization root branch even when all aliases agree", () => {
    const manifest = {
      company: {
        repository: "git@github.com:Example/Example_GEN3.git",
        github_org: "Example",
        default_branch: "develop",
      },
      default_branch: "develop",
    };
    expect(organizationRootRepositoryAliasIssues(manifest)).toContainEqual(
      expect.objectContaining({ code: "organization_root_branch_invalid" }),
    );
    expect(organizationRootRepositoryBranch(manifest)).toBe("develop");
  });

  test("rejects agreeing Organization root aliases owned by another GitHub Organization", () => {
    const manifest = {
      company: {
        repository: "git@github.com:ForeignCo/Shadow_GEN3.git",
        root_repository: "ForeignCo/Shadow_GEN3",
        github_org: "GoodCo",
        default_branch: "main",
      },
    };
    expect(organizationRootRepositoryAliasIssues(manifest)).toContainEqual(
      expect.objectContaining({ code: "organization_root_remote_owner_mismatch" }),
    );
  });

  test("includes immutable forge binding and governance in the shared root authority", () => {
    const manifest = {
      company: {
        repository: "git@github.com:LegacyCo/LegacyCo_GEN3.git",
        root_repository: "LegacyCo/LegacyCo_GEN3",
        github_org: "LegacyCo",
        default_branch: "main",
      },
      forge_binding: {
        schema_version: "lazurio.forge-binding.github.v0",
        provider: "github",
        organization: { id: "123", asserted_login: "BoundCo" },
        repository: {
          id: "456",
          asserted_full_name: "BoundCo/BoundCo_GEN3",
          default_branch: "main",
        },
      },
      governance: { default_branch: "develop" },
    };
    expect(organizationRootRepositoryAliasIssues(manifest)).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "organization_root_remote_conflict" }),
      expect.objectContaining({ code: "organization_root_owner_conflict" }),
      expect.objectContaining({ code: "organization_root_branch_conflict" }),
    ]));
    expect(organizationRootRepositoryRemote(manifest)).toBeNull();
    expect(organizationRootRepositoryBranch(manifest)).toBeNull();
  });

  test("malformed active forge binding blocks legacy fallback but null remains compatible", () => {
    const legacy = {
      company: {
        repository: "git@github.com:Example/Example_GEN3.git",
        github_org: "Example",
      },
      governance: { default_branch: "main" },
      default_branch: null,
      forge_binding: null,
    };
    expect(organizationRootRepositoryAliasIssues(legacy)).toEqual([]);
    expect(organizationRootRepositoryRemote(legacy)).toBe(
      "git@github.com:Example/Example_GEN3.git",
    );
    expect(organizationRootRepositoryBranch(legacy)).toBe("main");

    const malformed = { ...legacy, forge_binding: { provider: "github" } };
    expect(organizationRootRepositoryAliasIssues(malformed)).toContainEqual(
      expect.objectContaining({ code: "organization_root_forge_binding_invalid" }),
    );
    expect(organizationRootRepositoryRemote(malformed)).toBeNull();
    expect(organizationRootRepositoryBranch(malformed)).toBeNull();
  });

  test("active governance cannot replace GitHub as the Organization access authority", () => {
    const legacy = {
      company: {
        repository: "git@github.com:Example/Example_GEN3.git",
        github_org: "Example",
      },
      governance: { default_branch: "main" },
    };
    expect(organizationRootRepositoryAliasIssues(legacy)).toEqual([]);

    for (const governance of ["github", [], { default_branch: "main", access_authority: "not-github" }]) {
      const manifest = { ...legacy, governance };
      expect(organizationRootRepositoryAliasIssues(manifest)).toContainEqual(
        expect.objectContaining({
          code: typeof governance === "object" && !Array.isArray(governance)
            ? "organization_root_access_authority_invalid"
            : "organization_root_governance_invalid",
        }),
      );
      expect(organizationRootRepositoryRemote(manifest)).toBeNull();
      expect(organizationRootRepositoryBranch(manifest)).toBeNull();
    }

    const github = {
      ...legacy,
      governance: { default_branch: "main", access_authority: "github" },
    };
    expect(organizationRootRepositoryAliasIssues(github)).toEqual([]);
    expect(organizationRootRepositoryRemote(github)).toBe(
      "git@github.com:Example/Example_GEN3.git",
    );
    expect(organizationRootRepositoryBranch(github)).toBe("main");
  });
});

describe("Organization repository alias authority", () => {
  test("uses one canonical selector while accepting transport-equivalent aliases", () => {
    const slot = {
      slug: "demo",
      path: "workspace/demo",
      repo: "https://github.com/Example/demo.git",
      branch: "main",
      git: { url: "git@github.com:Example/demo.git", branch: "main" },
    };
    expect(organizationSlotRepositoryAliasIssues(slot)).toEqual([]);
    expect(organizationSlotRepositoryRemote(slot)).toBe("git@github.com:Example/demo.git");
    expect(organizationSlotRepositoryBranch(slot)).toBe("main");
  });

  test("quarantines conflicting remote and branch aliases instead of choosing by call site", () => {
    const issues = organizationSlotRepositoryAliasIssues({
      slug: "demo",
      path: "workspace/demo",
      repo: "git@github.com:OldOrg/demo.git",
      branch: "feature",
      git: { url: "git@github.com:NewOrg/demo.git", branch: "main" },
    });
    expect(issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "slot_remote_conflict" }),
      expect.objectContaining({ code: "slot_branch_conflict" }),
    ]));
  });

  test("malformed canonical slot aliases cannot fall through to valid legacy fields", () => {
    const slot = {
      slug: "studio",
      path: "workspace/studio",
      repo: "git@github.com:OldOrg/studio.git",
      branch: "main",
      git: { url: { owner: "NewOrg" }, branch: " main " },
    };
    expect(organizationSlotRepositoryAliasIssues(slot)).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "slot_remote_alias_invalid" }),
      expect.objectContaining({ code: "slot_branch_alias_invalid" }),
    ]));
    expect(organizationSlotRepositoryRemote(slot)).toBeNull();
    expect(organizationSlotRepositoryBranch(slot)).toBeNull();
  });
});

const warehouseDbSlot = {
  slug: "warehouse-data",
  path: "workspace/warehouse/db",
  materialization: "repository_db_mount",
  source_of_truth: "repository-db:v3",
  git: {
    url: "git@github.com:Example/warehouse-data.git",
    branch: "v3",
  },
};

describe("nested Organization repository-db slots", () => {
  test("accepts the single canonical db child without turning its basename into identity", () => {
    expect(isCanonicalOrganizationRepositorySlotPath(warehouseDbSlot.path)).toBe(true);
    expect(isOrganizationRepositoryDbSlot(warehouseDbSlot)).toBe(true);
    expect(organizationSlotRepositoryId(warehouseDbSlot)).toBe("warehouse-data");
    expect(organizationSlotRepositoryId({ ...warehouseDbSlot, slug: undefined })).toBeNull();
    expect(organizationSlotRepositoryMountIssue(warehouseDbSlot)).toBeNull();
  });

  test("rejects a nested path without the exact technical repository-db contract", () => {
    for (const sourceOfTruth of [
      "db-backed",
      undefined,
      "repository-db",
      "repository-db:",
      "repository-db:v3:shadow",
      "repository-db:v3?",
    ]) {
      expect(organizationSlotRepositoryMountIssue({
        ...warehouseDbSlot,
        source_of_truth: sourceOfTruth,
      })).toContain("source_of_truth");
    }
    expect(organizationSlotRepositoryMountIssue({
      ...warehouseDbSlot,
      slug: "other-data",
    })).toContain("neodpovídá přesnému názvu GitHub repozitáře");
    expect(organizationSlotRepositoryMountIssue({
      ...warehouseDbSlot,
      git: undefined,
    })).toContain("platný GitHub remote");
    expect(organizationSlotRepositoryMountIssue({
      ...warehouseDbSlot,
      git: { url: "https://git.example.test/Example/warehouse-data.git", branch: "v3" },
    })).toContain("platný GitHub remote");
    expect(isCanonicalOrganizationRepositorySlotPath("workspace/warehouse/cache")).toBe(false);
  });

  test("requires the parent Workspace Module in the same declaration surface", () => {
    expect(organizationRepositorySlotCollectionIssues([warehouseDbSlot])).toContain(
      'repository-db slot "workspace/warehouse/db" nemá deklarovaný parent Workspace Modul "workspace/warehouse"',
    );
    expect(organizationRepositorySlotCollectionIssues([
      { slug: "warehouse", path: "workspace/warehouse" },
      warehouseDbSlot,
    ])).toEqual([]);
    expect(organizationRepositorySlotCollectionIssues([
      { slug: "warehouse", path: "workspace/Warehouse" },
      warehouseDbSlot,
    ])).toContain(
      'repository-db slot "workspace/warehouse/db" nemá deklarovaný parent Workspace Modul "workspace/warehouse"',
    );
  });
});

describe("organizationSlotUiExposure", () => {
  test("keeps a nested repository-db diagnostics-only even with a module override", () => {
    expect(organizationSlotUiExposure({
      ...warehouseDbSlot,
      ui_exposure: "module",
    })).toBe("diagnostics-only");
  });
  test("respects an explicit diagnostics-only workspace declaration", () => {
    expect(organizationSlotUiExposure({
      path: "workspace/tender-intake",
      ui_exposure: "diagnostics-only",
    })).toBe("diagnostics-only");
  });

  test("allows a diagnostics-only default to be explicitly presented as a module", () => {
    expect(organizationSlotUiExposure({
      path: "mission-control/db",
      ui_exposure: "module",
    })).toBe("module");
  });

  test("ignores unknown presentation values and keeps the safe default", () => {
    expect(organizationSlotUiExposure({
      path: "workspace/example",
      ui_exposure: "hidden",
    })).toBe("module");
  });

  test("keeps an unknown override on an existing diagnostics-only default", () => {
    expect(organizationSlotUiExposure({
      path: "mission-control/db",
      ui_exposure: "hidden",
    })).toBe("diagnostics-only");
  });
});

describe("organizationSlotCatalogPresentation", () => {
  test("normalizes the human description and exposure in one Core result", () => {
    expect(organizationSlotCatalogPresentation({
      path: "workspace/current",
      description: "  Srozumitelný popis modulu.  ",
      ui_exposure: " DIAGNOSTICS-ONLY ",
    })).toEqual({
      description: "Srozumitelný popis modulu.",
      ui_exposure: "diagnostics-only",
    });
  });

  test("uses null for an absent description and preserves Core classification", () => {
    expect(organizationSlotCatalogPresentation({
      path: "mission-control/db",
      description: "   ",
    })).toEqual({
      description: null,
      ui_exposure: "diagnostics-only",
    });
  });

  test("rejects non-string manifest descriptions without changing exposure", () => {
    expect(organizationSlotCatalogPresentation({
      path: "workspace/current",
      description: 42,
    })).toEqual({
      description: null,
      ui_exposure: "module",
    });
  });
});
