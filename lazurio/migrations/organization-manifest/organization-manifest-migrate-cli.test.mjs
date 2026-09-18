import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

import { validateAgainstSchema } from "../../runtime/json-schema-mini.mjs";
import reportSchema from "./organization-manifest-migration-report.v0.schema.json";

const cli = join(import.meta.dirname, "..", "..", "cli.mjs");
const fixtureRoot = join(import.meta.dirname, "fixtures", "gen3-organization");

test("CLI advertises the explicit migration surface and dispatches into the migrations folder", () => {
  const help = run(["--help"]);
  expect(help.status).toBe(0);
  expect(help.stdout).toContain("lazurio migrate organization-manifest <organization-root> [--write] [--finalize] [--json]");

  const plan = run(["migrate", "organization-manifest", fixtureRoot, "--json"]);
  expect(plan.status).toBe(0);
  const report = JSON.parse(plan.stdout);
  expect(validateAgainstSchema(report, reportSchema, "report")).toEqual([]);
  expect(report).toMatchObject({
    schema_version: "lazurio.organization.manifest-migration.v0",
    mode: "plan",
    operation: "migrate",
    outcome: "planned",
    before: { state: "legacy" },
    after: { state: "transition" },
  });

  const human = run(["migrate", "organization-manifest", fixtureRoot]);
  expect(human.status).toBe(0);
  expect(human.stdout).toContain("Lazurio Organization manifest migration: planned (plan, migrate)");
  expect(human.stdout).toContain("Další krok: lazurio migrate organization-manifest <root> --write");
});

test("write against a plain fixture directory is refused by the Git gate and changes nothing", () => {
  const result = run(["migrate", "organization-manifest", fixtureRoot, "--write", "--json"]);
  expect(result.status).toBe(1);
  const report = JSON.parse(result.stdout);
  expect(report.outcome).toBe("blocked");
  // The fixture is a plain directory: either outside any repository or a
  // subdirectory of the Lazurio checkout, never an Organization checkout root.
  expect(report.blockers.map((blocker) => blocker.code)).toEqual([
    expect.stringMatching(/^git_(?:not_a_repository|not_checkout_root)$/),
  ]);
});

test("usage errors stay usage errors", () => {
  expect(run(["migrate"]).stderr).toContain("migrate vyžaduje jedinou akci `organization-manifest`");
  expect(run(["migrate", "organization-manifest"]).stderr).toContain("vyžaduje <organization-root>");
  expect(run(["migrate", "organization-manifest", fixtureRoot, "--root", fixtureRoot]).stderr).toContain("ne --root");
  expect(run(["doctor", "--write"]).stderr).toContain("--write a --finalize lze použít pouze s `lazurio migrate organization-manifest`");
  for (const args of [["migrate"], ["migrate", "organization-manifest"], ["doctor", "--write"]]) {
    expect(run(args).status).toBe(2);
  }
});

function run(args) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
  });
  return {
    status: result.status,
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? ""),
  };
}
