import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cleanup = [];
const cliPath = join(import.meta.dirname, "cli.mjs");

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

test("repair module-location exposes a structured check-only result", async () => {
  const root = await mkdtemp(join(tmpdir(), "lazurio-repair-cli-"));
  cleanup.push(root);
  await mkdir(join(root, "organizations"));

  const result = runCli([
    "repair",
    "module-location",
    "--org",
    "TestCo",
    "--module",
    "studio",
    "--json",
    "--root",
    root,
  ]);

  expect(result.exitCode).toBe(3);
  expect(JSON.parse(result.stdout)).toMatchObject({
    schema_version: "lazurio.module_location_repair.v1",
    state: "blocked",
    blockers: [{ code: "organization_not_found" }],
  });
});

test("repair apply requires the exact fingerprint returned by check", () => {
  const missingFingerprint = runCli([
    "repair",
    "module-location",
    "--org",
    "TestCo",
    "--module",
    "studio",
    "--apply",
    "--root",
    "/tmp/lazurio-fixture",
  ]);
  const expectWithoutApply = runCli([
    "repair",
    "module-location",
    "--org",
    "TestCo",
    "--module",
    "studio",
    "--expect",
    "sha256:deadbeef",
    "--root",
    "/tmp/lazurio-fixture",
  ]);

  expect(missingFingerprint.exitCode).toBe(2);
  expect(missingFingerprint.stderr).toContain("--apply vyžaduje fingerprint");
  expect(expectWithoutApply.exitCode).toBe(2);
  expect(expectWithoutApply.stderr).toContain("--expect lze použít pouze společně s --apply");
});

test("CLI usage documents both check and guarded apply phases", () => {
  const result = runCli(["--help"]);
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("lazurio repair module-location --org <slug> --module <slug>");
  expect(result.stdout).toContain("--apply --expect <fingerprint>");
});

function runCli(args) {
  const result = Bun.spawnSync([process.execPath, cliPath, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}
