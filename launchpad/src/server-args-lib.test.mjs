import { expect, test } from "bun:test";

import {
  assertAvailableAgentEntryOrganization,
  launchpadRefreshIntervals,
  parseLaunchpadServerArgs,
} from "./server-args-lib.mjs";

test("server parser přijme interní agentní root, Organization a Personalspace entry", () => {
  expect(parseLaunchpadServerArgs(["--reuse", "--agent-entry", "--root", "/srv/lazurio"]))
    .toMatchObject({ reuse: true, agentEntry: true, root: "/srv/lazurio" });
  expect(parseLaunchpadServerArgs(["--agent-entry", "--organization=AcmeCorp"]))
    .toMatchObject({ agentEntry: true, organization: "AcmeCorp" });
  expect(parseLaunchpadServerArgs(["--agent-entry", "--personalspace"]))
    .toMatchObject({ agentEntry: true, personalspace: true });
});

test("server parser failuje zavřeně pro neúplný nebo konfliktní agentní scope", () => {
  expect(() => parseLaunchpadServerArgs(["--agent-entry", "--organization"]))
    .toThrow("Chybí hodnota pro --organization");
  expect(() => parseLaunchpadServerArgs(["--agent-entry", "--organization", "AcmeCorp", "--personalspace"]))
    .toThrow("se vzájemně vylučují");
  expect(() => parseLaunchpadServerArgs(["--organization", "AcmeCorp"]))
    .toThrow("vyžadují interní --agent-entry");
});

test("agentní Organization entry vyžaduje dostupný slug s přesným casingem", () => {
  const organizations = [{ slug: "AcmeCorp" }, { slug: "PlannedCo" }];

  expect(assertAvailableAgentEntryOrganization(
    { agentEntry: true, organization: "AcmeCorp" },
    organizations,
  )).toBeUndefined();
  expect(() => assertAvailableAgentEntryOrganization(
    { agentEntry: true, organization: "acmecorp" },
    organizations,
  )).toThrow('nemá přesný casing; použijte "AcmeCorp"');
  expect(() => assertAvailableAgentEntryOrganization(
    { agentEntry: true, organization: "MissingCo" },
    organizations,
  )).toThrow('Organization "MissingCo" není v tomto Lazurio rootu dostupná');
  expect(assertAvailableAgentEntryOrganization(
    { agentEntry: true, personalspace: true },
    organizations,
  )).toBeUndefined();
});

test("server refresh cadences keep production defaults and accept only positive overrides", () => {
  expect(launchpadRefreshIntervals({})).toEqual({ appsCacheTtlMs: 10_000, hostedRefreshIntervalMs: 15_000 });
  expect(launchpadRefreshIntervals({
    LAZURIO_LAUNCHPAD_APPS_CACHE_TTL_MS: "200",
    LAZURIO_LAUNCHPAD_HOSTED_REFRESH_MS: "250",
  })).toEqual({ appsCacheTtlMs: 200, hostedRefreshIntervalMs: 250 });
  for (const invalid of ["0", "-5", "1.5", "soon"]) {
    expect(() => launchpadRefreshIntervals({ LAZURIO_LAUNCHPAD_HOSTED_REFRESH_MS: invalid }))
      .toThrow("LAZURIO_LAUNCHPAD_HOSTED_REFRESH_MS");
  }
});
