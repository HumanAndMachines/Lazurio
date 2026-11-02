import { describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";

const root = resolve(import.meta.dir, "..");
const clientIdentityPattern = ["spec", "toda"].join("");
const execFileAsync = promisify(execFile);

describe("public Organization example boundary", () => {
  test("names no real client identity anywhere in the tracked tree", async () => {
    // git grep exits 1 when nothing matches, which is the expected state.
    const result = await execFileAsync(
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
    ).then(
      (value) => ({ code: 0, ...value }),
      (error) => ({ code: error.code, stdout: error.stdout ?? "", stderr: error.stderr ?? "" }),
    );

    expect(result.stderr).toBe("");
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
  });
});
