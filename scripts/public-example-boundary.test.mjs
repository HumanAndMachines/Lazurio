import { describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";

const root = resolve(import.meta.dir, "..");
const clientIdentityPattern = ["spec", "toda"].join("");
const historicalEvidencePaths = new Set([
  "ISSUES.open.json",
  "ISSUES.resolved.json",
]);
const execFileAsync = promisify(execFile);

describe("public Organization example boundary", () => {
  test("keeps a real client identity only in explicit historical evidence", async () => {
    const { stdout, stderr } = await execFileAsync(
      "git",
      [
        "grep",
        "-nIi",
        "-E",
        clientIdentityPattern,
        "--",
        ".",
        ":!scripts/public-example-boundary.test.mjs",
      ],
      { cwd: root, encoding: "utf8" },
    );

    expect(stderr).toBe("");

    const matches = stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => line.replace(/\r$/, ""))
      .map((line) => {
        const fields = line.match(/^(.+?):(\d+):(.*)$/);
        expect(fields).not.toBeNull();
        return { path: fields[1], text: fields[3] };
      });

    expect(matches.length).toBeGreaterThan(0);
    for (const match of matches) {
      expect(historicalEvidencePaths.has(match.path)).toBe(true);
    }
  });
});
