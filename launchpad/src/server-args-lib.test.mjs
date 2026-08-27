import { expect, test } from "bun:test";

import {
  assertAvailableAgentEntryOrganization,
  parseLaunchpadServerArgs,
} from "./server-args-lib.mjs";

test("server parser přijme interní agentní root, Organization a Personalspace entry", () => {
  expect(parseLaunchpadServerArgs(["--reuse", "--agent-entry", "--root", "/srv/lazurio"]))
    .toMatchObject({ reuse: true, agentEntry: true, root: "/srv/lazurio" });
  expect(parseLaunchpadServerArgs(["--agent-entry", "--organization=AgentMint"]))
    .toMatchObject({ agentEntry: true, organization: "AgentMint" });
  expect(parseLaunchpadServerArgs(["--agent-entry", "--personalspace"]))
    .toMatchObject({ agentEntry: true, personalspace: true });
});

test("server parser failuje zavřeně pro neúplný nebo konfliktní agentní scope", () => {
  expect(() => parseLaunchpadServerArgs(["--agent-entry", "--organization"]))
    .toThrow("Chybí hodnota pro --organization");
  expect(() => parseLaunchpadServerArgs(["--agent-entry", "--organization", "AgentMint", "--personalspace"]))
    .toThrow("se vzájemně vylučují");
  expect(() => parseLaunchpadServerArgs(["--organization", "AgentMint"]))
    .toThrow("vyžadují interní --agent-entry");
});

test("agentní Organization entry vyžaduje dostupný slug s přesným casingem", () => {
  const organizations = [{ slug: "AgentMint" }, { slug: "PlannedCo" }];

  expect(assertAvailableAgentEntryOrganization(
    { agentEntry: true, organization: "AgentMint" },
    organizations,
  )).toBeUndefined();
  expect(() => assertAvailableAgentEntryOrganization(
    { agentEntry: true, organization: "agentmint" },
    organizations,
  )).toThrow('nemá přesný casing; použij "AgentMint"');
  expect(() => assertAvailableAgentEntryOrganization(
    { agentEntry: true, organization: "MissingCo" },
    organizations,
  )).toThrow('Organization "MissingCo" není v tomto Lazurio rootu dostupná');
  expect(assertAvailableAgentEntryOrganization(
    { agentEntry: true, personalspace: true },
    organizations,
  )).toBeUndefined();
});
