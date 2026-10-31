import { describe, expect, test } from "bun:test";

import {
  isCanonicalOrganizationRepositorySlot,
  isCanonicalOrganizationRepositorySlotPath,
  isOrganizationGuestSlot,
  isOrganizationRepositoryDbSlot,
  organizationGuestSlotDeclarationIssues,
  organizationGuestSlotPathParts,
  organizationRepositorySlotCollectionConflicts,
  organizationSlotHomeOrganization,
  organizationSlotRepositoryId,
  organizationSlotRepositoryMountIssue,
  organizationSlotRepositorySlug,
  organizationSlotUiExposure,
} from "./organization-slot-scope-lib.mjs";

// Kontrakt DEV-6694 (hostující Modul) se syntetickými Organizacemi HostOrg
// (hostitel) a HomeOrg (domovská Organizace hostujícího Modulu).
function hostSlots() {
  return [
    {
      path: "workspace/knowledgebase",
      category: "knowledge",
      default_access: "expected",
      required_roles: ["*"],
      git: { url: "git@github.com:HostOrg/knowledgebase.git", branch: "main" },
    },
    {
      path: "mission-control",
      space: "root",
      category: "planning",
      default_access: "expected",
      required_roles: ["*"],
      materialization: "doctor_managed_nested_repo",
      git: { url: "git@github.com:HostOrg/mission-control.git", branch: "main" },
    },
    {
      path: "mission-control/db",
      slug: "mission-control-data",
      space: "root",
      category: "planning-data",
      default_access: "expected",
      required_roles: ["*"],
      source_of_truth: "repository-db:v3",
      materialization: "repository_db_mount",
      git: { url: "git@github.com:HostOrg/mission-control-data.git", branch: "v3" },
    },
  ];
}

function guestSlots(home = "HomeOrg") {
  return [
    {
      path: `workspace/${home}_GEN3/knowledgebase`,
      slug: "knowledgebase",
      home_organization: home,
      category: "knowledge",
      default_access: "expected",
      required_roles: ["*"],
      teams: ["workspace"],
      status: "active",
      git: { url: `git@github.com:${home}/knowledgebase.git`, branch: "main" },
    },
    {
      path: `workspace/${home}_GEN3/mission-control`,
      slug: "mission-control",
      home_organization: home,
      category: "planning",
      default_access: "expected",
      required_roles: ["*"],
      status: "active",
      git: { url: `git@github.com:${home}/mission-control.git`, branch: "main" },
    },
    {
      path: `workspace/${home}_GEN3/mission-control/db`,
      slug: "mission-control-data",
      home_organization: home,
      category: "planning-data",
      default_access: "expected",
      required_roles: ["*"],
      source_of_truth: "repository-db:v3",
      status: "active",
      materialization: "repository_db_mount",
      repository_db: {
        repo: `${home}/mission-control-data`,
        url: `git@github.com:${home}/mission-control-data.git`,
        branch: "v3",
      },
      git: { url: `git@github.com:${home}/mission-control-data.git`, branch: "v3" },
    },
  ];
}

describe("guest slot path grammar", () => {
  test("accepts module and repository-db child below the home Organization mount", () => {
    expect(organizationGuestSlotPathParts("workspace/HomeOrg_GEN3/knowledgebase")).toEqual({
      home_organization: "HomeOrg",
      container_path: "workspace/HomeOrg_GEN3",
      mount: "knowledgebase",
      repository_db: false,
      parent_path: null,
    });
    expect(organizationGuestSlotPathParts("workspace/Home-Org_GEN3/mission-control/db")).toMatchObject({
      home_organization: "Home-Org",
      mount: "mission-control",
      repository_db: true,
      parent_path: "workspace/Home-Org_GEN3/mission-control",
    });
  });

  test("refuses other scopes, missing suffix, extra depth and non-normalized spellings", () => {
    for (const path of [
      "modules/HomeOrg_GEN3/knowledgebase",
      "productionspace/HomeOrg_GEN3/knowledgebase",
      "HomeOrg_GEN3/knowledgebase",
      "workspace/HomeOrg/knowledgebase",
      "workspace/HomeOrg_GEN3",
      "workspace/HomeOrg_GEN3/mission-control/db/extra",
      "workspace/HomeOrg_GEN3/knowledgebase/",
      "workspace/HomeOrg_GEN3//knowledgebase",
      "workspace\\HomeOrg_GEN3\\knowledgebase",
    ]) {
      expect(organizationGuestSlotPathParts(path)).toBeNull();
    }
  });

  test("a guest path stays non-canonical for path-only host consumers", () => {
    expect(isCanonicalOrganizationRepositorySlotPath("workspace/HomeOrg_GEN3/knowledgebase")).toBe(false);
    expect(isCanonicalOrganizationRepositorySlotPath("workspace/HomeOrg_GEN3/mission-control/db")).toBe(false);
  });
});

describe("guest slot declaration", () => {
  test("a valid guest pair is canonical, namespaced and a repository-db child", () => {
    const [knowledgebase, missionControl, data] = guestSlots();
    for (const slot of [knowledgebase, missionControl, data]) {
      expect(isOrganizationGuestSlot(slot)).toBe(true);
      expect(isCanonicalOrganizationRepositorySlot(slot)).toBe(true);
      expect(organizationSlotHomeOrganization(slot)).toBe("HomeOrg");
      expect(organizationGuestSlotDeclarationIssues(slot, { githubOrg: "HostOrg" })).toEqual([]);
      expect(organizationSlotRepositoryMountIssue(slot)).toBeNull();
    }
    expect(organizationSlotRepositoryId(knowledgebase)).toBe("HomeOrg/knowledgebase");
    expect(organizationSlotRepositorySlug(knowledgebase)).toBe("knowledgebase");
    expect(organizationSlotRepositoryId(data)).toBe("HomeOrg/mission-control-data");
    expect(isOrganizationRepositoryDbSlot(data)).toBe(true);
    expect(isOrganizationRepositoryDbSlot(missionControl)).toBe(false);
    expect(organizationSlotUiExposure(data)).toBe("diagnostics-only");
  });

  test("a foreign two-segment workspace path without home_organization stays unsupported", () => {
    const [{ home_organization: _home, ...slot }] = guestSlots();
    expect(isCanonicalOrganizationRepositorySlot(slot)).toBe(false);
    expect(organizationSlotRepositoryId(slot)).toBeNull();
    expect(organizationGuestSlotDeclarationIssues(slot, { githubOrg: "HostOrg" })).toEqual([]);
  });

  test("home_organization on a host path is an invalid guest declaration, never a host slot", () => {
    const slot = { ...hostSlots()[0], home_organization: "HomeOrg" };
    expect(isCanonicalOrganizationRepositorySlot(slot)).toBe(false);
    expect(organizationSlotRepositoryId(slot)).toBeNull();
    expect(organizationGuestSlotDeclarationIssues(slot, { githubOrg: "HostOrg" })).toEqual([
      expect.objectContaining({ code: "slot_guest_path_invalid" }),
    ]);
  });

  test("a wrong middle segment is a guest path issue", () => {
    const slot = { ...guestSlots()[0], path: "workspace/OtherOrg_GEN3/knowledgebase" };
    expect(isOrganizationGuestSlot(slot)).toBe(false);
    expect(organizationGuestSlotDeclarationIssues(slot, { githubOrg: "HostOrg" })).toEqual([
      expect.objectContaining({ code: "slot_guest_path_invalid" }),
    ]);
    const caseDrift = { ...guestSlots()[0], path: "workspace/homeorg_GEN3/knowledgebase" };
    expect(organizationGuestSlotDeclarationIssues(caseDrift, { githubOrg: "HostOrg" })).toEqual([
      expect.objectContaining({ code: "slot_guest_path_invalid" }),
    ]);
  });

  test("home_organization equal to the host (case-insensitive) or malformed is invalid", () => {
    const self = guestSlots("HostOrg")[0];
    expect(organizationGuestSlotDeclarationIssues(self, { githubOrg: "hostorg" })).toEqual([
      expect.objectContaining({ code: "slot_home_organization_is_host" }),
    ]);
    for (const value of ["", " HomeOrg", null, 42, "Home/Org"]) {
      const slot = { ...guestSlots()[0], home_organization: value };
      expect(isOrganizationGuestSlot(slot)).toBe(false);
      expect(organizationGuestSlotDeclarationIssues(slot, { githubOrg: "HostOrg" })).toEqual([
        expect.objectContaining({ code: "slot_home_organization_invalid" }),
      ]);
    }
  });

  test("every remote alias, including repository_db, must belong to home_organization", () => {
    const [knowledgebase, , data] = guestSlots();
    const foreignGit = {
      ...knowledgebase,
      git: { url: "git@github.com:ThirdOrg/knowledgebase.git", branch: "main" },
    };
    expect(organizationGuestSlotDeclarationIssues(foreignGit, { githubOrg: "HostOrg" })).toEqual([
      expect.objectContaining({ code: "slot_remote_owner_mismatch" }),
    ]);
    const hostOwned = {
      ...knowledgebase,
      git: { url: "git@github.com:HostOrg/knowledgebase.git", branch: "main" },
    };
    expect(organizationGuestSlotDeclarationIssues(hostOwned, { githubOrg: "HostOrg" })).toEqual([
      expect.objectContaining({ code: "slot_remote_owner_mismatch" }),
    ]);
    const foreignData = {
      ...data,
      repository_db: { ...data.repository_db, repo: "ThirdOrg/mission-control-data" },
    };
    expect(organizationGuestSlotDeclarationIssues(foreignData, { githubOrg: "HostOrg" })).toEqual([
      expect.objectContaining({ code: "slot_remote_owner_mismatch" }),
    ]);
    const caseOnly = {
      ...knowledgebase,
      git: { url: "git@github.com:homeorg/knowledgebase.git", branch: "main" },
    };
    expect(organizationGuestSlotDeclarationIssues(caseOnly, { githubOrg: "HostOrg" })).toEqual([]);
  });

  test("mount basename and db slug still equal the GitHub repository name", () => {
    const [knowledgebase, , data] = guestSlots();
    expect(organizationSlotRepositoryMountIssue({
      ...knowledgebase,
      git: { url: "git@github.com:HomeOrg/kb.git", branch: "main" },
    })).toContain("repository mount basename");
    expect(organizationSlotRepositoryMountIssue({ ...data, slug: "mission-control-db" }))
      .toContain("repository-db slug");
    const { slug: _slug, ...withoutSlug } = data;
    expect(organizationSlotRepositoryId(withoutSlug)).toBeNull();
  });
});

describe("guest slot identity scope", () => {
  test("a valid guest pair beside the host's own Knowledgebase and Mission Control does not collide", () => {
    expect(organizationRepositorySlotCollectionConflicts([...hostSlots(), ...guestSlots()])).toEqual([]);
  });

  test("two guests of the same home Organization and slug collide", () => {
    const [knowledgebase] = guestSlots();
    const duplicate = { ...knowledgebase, path: "workspace/HomeOrg_GEN3/knowledgebase-copy" };
    const conflicts = organizationRepositorySlotCollectionConflicts([...hostSlots(), knowledgebase, duplicate]);
    expect(conflicts).toEqual([
      expect.objectContaining({ code: "repository_id_collision", slots: [knowledgebase, duplicate] }),
    ]);
  });

  test("guests of different home Organizations with the same slug do not collide", () => {
    expect(organizationRepositorySlotCollectionConflicts([
      ...hostSlots(),
      ...guestSlots("HomeOrg"),
      ...guestSlots("ThirdOrg"),
    ])).toEqual([]);
  });

  test("a guest db child needs its guest parent with the same home Organization", () => {
    const [knowledgebase, missionControl, data] = guestSlots();
    expect(organizationRepositorySlotCollectionConflicts([knowledgebase, data])).toEqual([
      expect.objectContaining({ code: "repository_db_parent_missing", slots: [data] }),
    ]);
    const { home_organization: _home, ...hostParent } = missionControl;
    expect(organizationRepositorySlotCollectionConflicts([hostParent, data])).toEqual([
      expect.objectContaining({ code: "repository_db_parent_missing", slots: [data] }),
    ]);
    const otherHomeParent = { ...guestSlots("ThirdOrg")[1] };
    expect(organizationRepositorySlotCollectionConflicts([otherHomeParent, data])).toEqual([
      expect.objectContaining({ code: "repository_db_parent_missing", slots: [data] }),
    ]);
  });

  test("path case collisions are still checked across host and guest slots", () => {
    const [knowledgebase] = guestSlots();
    const caseTwin = {
      ...knowledgebase,
      slug: "knowledge",
      path: "workspace/HomeOrg_GEN3/KnowledgeBase",
      git: { url: "git@github.com:HomeOrg/KnowledgeBase.git", branch: "main" },
    };
    expect(organizationRepositorySlotCollectionConflicts([knowledgebase, caseTwin])).toEqual([
      expect.objectContaining({ code: "path_case_collision" }),
    ]);
  });
});
