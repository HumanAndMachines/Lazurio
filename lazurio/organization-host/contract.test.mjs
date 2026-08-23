import { expect, test } from "bun:test";
import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";

import { validateAgainstSchema } from "../../launchpad/src/json-schema-mini.mjs";
import {
  buildOrganizationHostAdapterInvocation,
  validateOrganizationHostAdapter,
  validateOrganizationHostReadback,
} from "./contract-lib.mjs";

const contractRoot = import.meta.dirname;
const adapterSchema = JSON.parse(await readFile(join(contractRoot, "adapter.v1.schema.json"), "utf8"));
const readbackSchema = JSON.parse(await readFile(join(contractRoot, "readback.v1.schema.json"), "utf8"));

test("provider-neutral fixtures satisfy schema and semantic validation", async () => {
  const fixtureNames = (await readdir(join(contractRoot, "fixtures")))
    .filter((name) => name.endsWith(".json"))
    .sort();
  expect(fixtureNames).toEqual([
    "declared-linux.json",
    "legacy-workstation.json",
    "target-cloud.json",
  ]);
  for (const name of fixtureNames) {
    const fixture = JSON.parse(await readFile(join(contractRoot, "fixtures", name), "utf8"));
    expect(validateAgainstSchema(fixture, adapterSchema, name)).toEqual([]);
    expect(validateOrganizationHostAdapter(fixture)).toEqual([]);
  }
});

test("schema and SDK reject moving aliases for every runtime pin kind", async () => {
  for (const [kind, value] of [
    ["git-commit", "main"],
    ["oci-digest", "latest"],
    ["package-version", "stable"],
  ]) {
    const fixture = await fixtureNamed("declared-linux.json");
    fixture.runtime_pins[0] = { component: "runtime", kind, value };
    expect(validateAgainstSchema(fixture, adapterSchema, "adapter").length).toBeGreaterThan(0);
    expect(validateOrganizationHostAdapter(fixture).some((failure) => failure.includes("is not an exact"))).toBe(true);
  }
});

test("adapter declaration rejects environment and custody leakage fields", async () => {
  const fixture = await fixtureNamed("declared-linux.json");
  fixture.hostname = "private.example";
  fixture.adapter.provider_id = "provider-resource";
  fixture.custody.credentials = "secret-value";
  expect(validateAgainstSchema(fixture, adapterSchema, "adapter").length).toBeGreaterThan(0);
  expect(validateOrganizationHostAdapter(fixture)).toEqual(expect.arrayContaining([
    "declaration.hostname is not allowed",
    "adapter.provider_id is not allowed",
    "custody.credentials is not allowed",
  ]));
});

test("entrypoint and operation shape cannot inject a second command path", async () => {
  for (const entrypoint of ["../outside", "bin/./adapter", "bin//adapter", "bin/"]) {
    const fixture = await fixtureNamed("declared-linux.json");
    fixture.adapter.entrypoint = entrypoint;
    expect(validateAgainstSchema(fixture, adapterSchema, "adapter").length).toBeGreaterThan(0);
    expect(validateOrganizationHostAdapter(fixture)).toContain(
      "adapter.entrypoint must be a canonical relative path",
    );
  }
  const fixture = await fixtureNamed("declared-linux.json");
  fixture.adapter.operations.apply.mode = "read-only";
  expect(validateOrganizationHostAdapter(fixture)).toContain(
    "adapter.operations.apply.mode is invalid",
  );
});

test("read-only invocation is fixed to one selected infra checkout", async () => {
  const declaration = await fixtureNamed("target-cloud.json");
  const infraRoot = resolve(contractRoot, "test-infra");
  const invocation = buildOrganizationHostAdapterInvocation({
    declaration,
    infraRoot,
    operation: "readback",
  });
  expect(invocation).toEqual({
    executable: join(infraRoot, "tools", "organization-host-adapter"),
    args: ["readback", "--json"],
    cwd: infraRoot,
    mode: "read-only",
  });
});

test("mutation invocation fails until every independent gate is present", async () => {
  const declaration = await fixtureNamed("declared-linux.json");
  const baseline = {
    declaration,
    infraRoot: resolve(contractRoot, "test-infra"),
    operation: "apply",
  };
  expect(() => buildOrganizationHostAdapterInvocation(baseline)).toThrow("explicit Organization selector");
  expect(() => buildOrganizationHostAdapterInvocation({
    ...baseline,
    authorization: { organizationSelector: "selected-org" },
  })).toThrow("plan-owned worktree");
  expect(() => buildOrganizationHostAdapterInvocation({
    ...baseline,
    authorization: {
      organizationSelector: "selected-org",
      planOwnedWorktree: true,
    },
  })).toThrow("reviewed diff");
  expect(() => buildOrganizationHostAdapterInvocation({
    ...baseline,
    authorization: {
      organizationSelector: "selected-org",
      planOwnedWorktree: true,
      reviewedDiff: true,
    },
  })).toThrow("explicit deploy gate");
  expect(buildOrganizationHostAdapterInvocation({
    ...baseline,
    authorization: {
      organizationSelector: "selected-org",
      planOwnedWorktree: true,
      reviewedDiff: true,
      deployGate: "explicit",
    },
  })).toMatchObject({ mode: "mutation", args: ["apply", "--json"] });
});

test("metadata-only readback has exact health coverage and no free-text fields", () => {
  const readback = validReadback();
  expect(validateAgainstSchema(readback, readbackSchema, "readback")).toEqual([]);
  expect(validateOrganizationHostReadback(readback)).toEqual([]);

  readback.health.message = "sensitive runtime detail";
  readback.health.checks.workspace = "fail";
  readback.next_action.reason_code = "contains spaces";
  expect(validateAgainstSchema(readback, readbackSchema, "readback").length).toBeGreaterThan(0);
  expect(validateOrganizationHostReadback(readback)).toEqual(expect.arrayContaining([
    "health.message is not allowed",
    "health.overall does not match the individual checks",
    "next_action.reason_code is invalid",
  ]));
});

test("adapter cannot self-assert compliance or contradict its observation state", () => {
  const readback = validReadback();
  readback.profile_state = "compliant";
  readback.runtime_pins[0].observation = "missing";
  expect(validateAgainstSchema(readback, readbackSchema, "readback").length).toBeGreaterThan(0);
  expect(validateOrganizationHostReadback(readback)).toEqual(expect.arrayContaining([
    "invalid profile_state",
    "runtime_pins[0].observation missing requires a null observed value",
  ]));
});

function validReadback() {
  return {
    schema_version: "lazurio.organization_host.readback.v1",
    contract_version: 1,
    observed_at: "2026-08-23T16:30:00.000Z",
    profile_state: "declared",
    runtime_pins: [
      {
        component: "lazurio-resident",
        kind: "package-version",
        observation: "observed",
        declared: "0.1.0-candidate.1",
        observed: "0.1.0-candidate.1",
      },
    ],
    health: {
      overall: "pass",
      checks: {
        host: "pass",
        workspace: "pass",
        access: "pass",
        runtime: "pass",
        ingress: "pass",
        storage: "pass",
      },
    },
    recovery: {
      checkpoint: "verified",
      restore: "verified",
      clean_rebuild: "verified",
      rollback: "verified",
    },
    next_action: {
      owner: "organization-infra-repository",
      operation: null,
      reason_code: "no-action",
    },
  };
}

async function fixtureNamed(name) {
  return JSON.parse(await readFile(join(contractRoot, "fixtures", name), "utf8"));
}
