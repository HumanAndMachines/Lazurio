import { expect, test } from "bun:test";
import { discoveryContractFailures } from "./check-launchpad-discovery-lib.mjs";

test("check lane fails hard on declared port conflicts and listener drift", () => {
  expect(discoveryContractFailures({
    portOverlaps: [
      { port: 24_001, conflict: true, classification: "cross-module-conflict" },
      { port: 24_002, conflict: false, classification: "module-version-lease" },
    ],
    moduleListenerDrifts: [
      { module_lease: "Acme/presentation/main" },
    ],
    organizationIssues: [{
      severity: "blocking",
      organization: "Acme",
      module: "website",
      code: "repository_location_mismatch",
      message: "workspace/website neodpovídá repozitáři website-v2",
    }],
  })).toEqual([
    "Acme/website: repository_location_mismatch — workspace/website neodpovídá repozitáři website-v2",
    "port 24001: cross-module-conflict",
    "Acme/presentation/main: module listener drift",
  ]);
});
