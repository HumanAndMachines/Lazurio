import { expect, test } from "bun:test";
import {
  launchpadEntryHash,
  launchpadEntryUrl,
  guideHash,
  organizationHash,
  parseLaunchpadHash,
  personalspaceHash,
  resolveLaunchpadHash,
} from "../../lazurio/runtime/deep-link-lib.mjs";

const companies = [
  { slug: "Acme-Tech", display_name: "Acme-Tech" },
  { slug: "ExampleOrg", display_name: "ExampleOrg" },
];

test("Organization deep-link zachová a znovu přečte přesný company slug", () => {
  const hash = organizationHash("Acme-Tech");
  expect(hash).toBe("#/org/Acme-Tech");
  expect(parseLaunchpadHash(hash)).toEqual({
    kind: "organization",
    organization: "Acme-Tech",
  });
  expect(resolveLaunchpadHash(hash, { companies })).toMatchObject({
    status: "matched",
    scope: "org",
    company: "Acme-Tech",
  });
});

test("Personalspace má stabilní local-only route bez username nebo osobních dat", () => {
  expect(personalspaceHash()).toBe("#/personalspace");
  expect(resolveLaunchpadHash(personalspaceHash(), { personalspaceAvailable: true })).toMatchObject({
    status: "matched",
    scope: "personal",
    company: "all",
  });
  expect(resolveLaunchpadHash(personalspaceHash(), { personalspaceAvailable: false }).status).toBe("unavailable");
});

test("Guide má stabilní globální route nezávislou na Organization scope", () => {
  expect(guideHash()).toBe("#/guide");
  expect(parseLaunchpadHash(guideHash())).toEqual({ kind: "guide" });
  expect(resolveLaunchpadHash(guideHash(), { companies })).toEqual({
    status: "matched",
    route: { kind: "guide" },
    surface: "guide",
  });
});

test("Root bez scope zachová současný default a neplatné route failují bezpečně", () => {
  expect(resolveLaunchpadHash("", { companies }).status).toBe("none");
  expect(resolveLaunchpadHash("#/", { companies }).status).toBe("none");
  expect(resolveLaunchpadHash("#/org/Unknown", { companies }).status).toBe("not_found");
  expect(resolveLaunchpadHash("#/org/%E0%A4%A", { companies }).status).toBe("invalid");
  expect(resolveLaunchpadHash("#/org/..", { companies }).status).toBe("invalid");
  expect(resolveLaunchpadHash("#/org/Org/module/secrets", { companies }).status).toBe("invalid");
});

test("Deep-link builder odmítne prázdné a path-like Organization slugy", () => {
  expect(() => organizationHash("")).toThrow(TypeError);
  expect(() => organizationHash("../OtherOrg")).toThrow(TypeError);
  expect(() => organizationHash("Org\\Other")).toThrow(TypeError);
});

test("Agentní entry URL skládá až skutečný origin se stabilním root, Organization a Personalspace hashem", () => {
  expect(launchpadEntryUrl("http://127.0.0.1:4199", {})).toBe("http://127.0.0.1:4199/#/");
  expect(launchpadEntryUrl("http://127.0.0.1:4199", { organization: "Acme Corp" }))
    .toBe("http://127.0.0.1:4199/#/org/Acme%20Corp");
  expect(launchpadEntryUrl("http://127.0.0.1:4199", { personalspace: true }))
    .toBe("http://127.0.0.1:4199/#/personalspace");
  expect(() => launchpadEntryHash({ organization: "AcmeCorp", personalspace: true })).toThrow(TypeError);
  expect(() => launchpadEntryUrl("file:///tmp/launchpad", {})).toThrow(TypeError);
});
