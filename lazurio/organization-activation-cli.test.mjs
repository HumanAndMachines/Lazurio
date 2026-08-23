import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const cli = join(import.meta.dirname, "cli.mjs");

test("CLI advertises one explicit read-only Organization activation surface", () => {
  const result = run(["--help"]);
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("lazurio organization activate --check --github-id <id> [--json]");
});

test("remote activation writer is not exposed before its reviewed slice", () => {
  const result = run(["organization", "activate", "--github-id", "314957563"]);
  expect(result.status).toBe(2);
  expect(result.stderr).toContain("Remote writer zatím není veřejný");
});

test("check requires a positive immutable Organization ID before any provider probe", () => {
  const missing = run(["organization", "activate", "--check", "--json"]);
  expect(missing.status).toBe(2);
  expect(missing.stderr).toContain("vyžaduje --github-id");

  const invalid = run(["organization", "activate", "--check", "--github-id", "not-an-id", "--json"]);
  expect(invalid.status).toBe(2);
  expect(invalid.stderr).toContain("positive immutable GitHub Organization ID");
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
