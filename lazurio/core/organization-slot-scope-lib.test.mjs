import { describe, expect, test } from "bun:test";

import {
  isCanonicalOrganizationRepositorySlotPath,
  isOrganizationRepositoryDbSlot,
  organizationRepositorySlotCollectionIssues,
  organizationSlotCatalogPresentation,
  organizationSlotRepositoryId,
  organizationSlotRepositoryMountIssue,
  organizationSlotUiExposure,
} from "./organization-slot-scope-lib.mjs";

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
