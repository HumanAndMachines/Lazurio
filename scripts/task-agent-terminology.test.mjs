import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const legacyPattern = ["worker", "[ _-]?", "agent"].join("");
const historicalDecisionIds = new Set(["0063", "0090", "0112"]);

describe("Task Agent terminology", () => {
  test("keeps the legacy name only in explicitly allowlisted historical decisions", () => {
    const result = Bun.spawnSync(
      [
        "git",
        "grep",
        "-nIi",
        "-z",
        "-E",
        legacyPattern,
        "--",
        ".",
        ":!scripts/task-agent-terminology.test.mjs",
      ],
      { cwd: root, stdout: "pipe", stderr: "pipe" },
    );

    expect([0, 1]).toContain(result.exitCode);
    expect(result.stderr.toString()).toBe("");

    const matches = result.stdout
      .toString()
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => line.replace(/\r$/, "").split("\0"))
      .map((fields) => {
        expect(fields).toHaveLength(3);
        expect(fields[1]).toMatch(/^\d+$/);
        return { path: fields[0], text: fields[2] };
      });

    expect(matches).toHaveLength(historicalDecisionIds.size);
    for (const match of matches) {
      expect(match.path).toBe("manual/decision-register.md");
      const decisionId = match.text.match(/^\| (\d{4}) \|/)?.[1];
      expect(historicalDecisionIds.has(decisionId)).toBe(true);
    }
  });
});
