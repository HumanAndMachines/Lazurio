import { expect, test } from "bun:test";
import {
  buildModuleLocationRepairAction,
  buildModuleSlotAgentReviewAction,
  buildRepositoryLocationIssue,
  moduleLocationRepairCommand,
} from "./module-location-repair-contract-lib.mjs";

test("module location repair action has one exact check-only CLI entrypoint", () => {
  const action = buildModuleLocationRepairAction({
    organization: "HumanAndMachine-ai",
    module: "website",
    detail: "workspace/website neodpovídá repozitáři website-rozjedemeai",
  });

  expect(action).toMatchObject({
    kind: "repair_module_location",
    label: "Vyřešit s Codexem",
    command: "lazurio repair module-location --org HumanAndMachine-ai --module website",
  });
  expect(action.prompt).toContain(action.command);
  expect(action.prompt).toContain("--apply --expect <fingerprint>");
  expect(action.prompt).toContain("zachovej veškerá lokální Git data");
});

test("non-location slot issue gives Codex a source-contract review without authorizing mutation", () => {
  const action = buildModuleSlotAgentReviewAction({
    organization: "Demo",
    module: "website",
    reason: "slot_team_invalid",
    path: "workspace/website",
    detail: "Team missing does not exist.",
  });
  expect(action).toMatchObject({ kind: "agent_review", label: "Vyřešit s Codexem" });
  expect(action.prompt).toContain("ostatní zdravé moduly zůstávají použitelné");
  expect(action.prompt).toContain("Nevytvářej duplicitní clone");
  expect(action).not.toHaveProperty("command");
});

test("structured location issue shares the same repair action authority", () => {
  const issue = buildRepositoryLocationIssue({
    organization: "Demo",
    organizationPath: "organizations/Demo_GEN3",
    module: "website",
    path: "workspace/website",
    expectedPath: "workspace/website-v2",
    message: "Repo bylo přejmenováno.",
    sources: ["modules.manifest.json", "company.gen3.json"],
  });
  expect(issue).toMatchObject({
    schema_version: "lazurio.organization_issue.v1",
    code: "repository_location_mismatch",
    next_action: {
      command: "lazurio repair module-location --org Demo --module website",
    },
  });
  expect(issue.next_action.prompt).toContain("Nalezená cesta: workspace/website");
  expect(issue.next_action.prompt).toContain("Kanonická cesta: workspace/website-v2");
});

test("repair command refuses selectors that could become shell syntax", () => {
  expect(moduleLocationRepairCommand({ organization: "Demo; rm", module: "website" })).toBeNull();
  expect(moduleLocationRepairCommand({ organization: "Demo", module: "Website" })).toBeNull();
});
