import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { laneInvocations, testLanes } from "./test-lanes.mjs";

test("every versioned lane lists only existing test files", () => {
  for (const lane of Object.keys(testLanes)) {
    expect(laneInvocations(lane).length).toBe(testLanes[lane].length);
  }
});

test("a lane fails closed on a missing file or an unknown name", async () => {
  const root = await mkdtemp(join(tmpdir(), "lazurio-test-lanes-"));
  try {
    await mkdir(join(root, "scripts"), { recursive: true });
    await writeFile(join(root, "scripts", "kept.test.mjs"), "");
    const lanes = {
      demo: [{ file: "scripts/kept.test.mjs" }, { file: "scripts/removed.test.mjs" }],
    };
    expect(() => laneInvocations("demo", { root, lanes })).toThrow("scripts/removed.test.mjs");
    expect(() => laneInvocations("other", { root, lanes })).toThrow('Unknown test lane "other"');
    expect(() => laneInvocations("constructor", { root, lanes })).toThrow("Unknown test lane");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("each lane file runs in its own Bun process from its package root", async () => {
  const root = await mkdtemp(join(tmpdir(), "lazurio-test-lanes-"));
  try {
    for (const file of ["lazurio/core/a.test.mjs", "launchpad/src/b.test.mjs", "scripts/c.test.mjs"]) {
      await mkdir(join(root, file, ".."), { recursive: true });
      await writeFile(join(root, file), "");
    }
    const lanes = {
      demo: [
        { file: "lazurio/core/a.test.mjs" },
        { file: "launchpad/src/b.test.mjs", namePattern: "Windows" },
        { file: "scripts/c.test.mjs" },
      ],
    };
    const invocations = laneInvocations("demo", { root, lanes });
    expect(invocations.map(({ cwd }) => cwd)).toEqual([
      join(root, "lazurio"),
      join(root, "launchpad"),
      root,
    ]);
    expect(invocations[0].args).toEqual(["test", "--timeout", "60000", join(root, "lazurio/core/a.test.mjs")]);
    expect(invocations[1].args).toEqual([
      "test",
      "--timeout",
      "60000",
      "--test-name-pattern",
      "Windows",
      join(root, "launchpad/src/b.test.mjs"),
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
