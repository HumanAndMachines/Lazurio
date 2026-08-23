import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const legacyPattern = ["worker", "[ _-]?", "agent"].join("");
const historicalDecisionIds = new Set(["0063", "0090", "0112"]);

describe("Task Agent terminology", () => {
  test("keeps the legacy name only in explicitly allowlisted historical decisions", () => {
    const result = spawnSync(
      "git",
      [
        "grep",
        "-nIi",
        "-E",
        legacyPattern,
        "--",
        ".",
        ":!scripts/task-agent-terminology.test.mjs",
      ],
      { cwd: root, encoding: "utf8", shell: false },
    );

    expect([0, 1]).toContain(result.status);
    expect(result.stderr).toBe("");

    const matches = result.stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => line.replace(/\r$/, ""))
      .map((line) => {
        const fields = line.match(/^(.+?):(\d+):(.*)$/);
        expect(fields).not.toBeNull();
        return { path: fields[1], text: fields[3] };
      });

    expect(matches).toHaveLength(historicalDecisionIds.size);
    for (const match of matches) {
      expect(match.path).toBe("manual/decision-register.md");
      const decisionId = match.text.match(/^\| (\d{4}) \|/)?.[1];
      expect(historicalDecisionIds.has(decisionId)).toBe(true);
    }
  });
});
