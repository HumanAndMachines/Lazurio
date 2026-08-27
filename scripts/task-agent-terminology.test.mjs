import { describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

const root = resolve(import.meta.dir, "..");
const packageJsonPath = resolve(root, "package.json");
const legacyPattern = ["worker", "[ _-]?", "agent"].join("");
const historicalDecisionIds = new Set(["0063", "0090", "0112"]);
const shellOperators = new Set(["&&", "||", ";", "|"]);
const optionsWithSeparateValues = new Set(["--cwd", "--timeout"]);
const execFileAsync = promisify(execFile);

function bunTestOperands(command) {
  const tokens = command.trim().split(/\s+/);
  const operands = [];

  for (let index = 0; index < tokens.length - 1; index += 1) {
    if (tokens[index] !== "bun" || tokens[index + 1] !== "test") continue;

    for (index += 2; index < tokens.length; index += 1) {
      const token = tokens[index];
      if (shellOperators.has(token)) break;
      if (optionsWithSeparateValues.has(token)) {
        index += 1;
        continue;
      }
      if (token.startsWith("-")) continue;
      operands.push(token);
    }
  }

  return operands;
}

describe("Task Agent terminology", () => {
  test("keeps the legacy name only in explicitly allowlisted historical decisions", async () => {
    const { stdout, stderr } = await execFileAsync(
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

    expect(matches).toHaveLength(historicalDecisionIds.size);
    for (const match of matches) {
      expect(match.path).toBe("manual/decision-register.md");
      const decisionId = match.text.match(/^\| (\d{4}) \|/)?.[1];
      expect(historicalDecisionIds.has(decisionId)).toBe(true);
    }
  });

  test("roots every explicit bun test operand to avoid filter-mode directory scans", async () => {
    const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
    const unrooted = [];

    for (const [name, command] of Object.entries(packageJson.scripts ?? {})) {
      for (const operand of bunTestOperands(command)) {
        if (!operand.startsWith("./")) unrooted.push(`${name}: ${operand}`);
      }
    }

    expect(unrooted).toEqual([]);
  });
});
