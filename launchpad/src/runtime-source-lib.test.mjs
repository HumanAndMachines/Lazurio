import { expect, test } from "bun:test";
import { normalizeRuntimeSource } from "../../lazurio/runtime/runtime-source-lib.mjs";

test("runtime source keeps only main or one canonical worktree slug", () => {
  expect(normalizeRuntimeSource(null)).toEqual({ type: "main" });
  expect(normalizeRuntimeSource({ type: "main" })).toEqual({ type: "main" });
  expect(normalizeRuntimeSource({ type: "worktree", slug: "DEV-6513-preview" }))
    .toEqual({ type: "worktree", slug: "DEV-6513-preview" });

  expect(() => normalizeRuntimeSource({ type: "main", branch: "main" })).toThrow("additional properties");
  expect(() => normalizeRuntimeSource({ type: "worktree", slug: "../preview" })).toThrow("canonical worktree");
  expect(() => normalizeRuntimeSource({ type: "worktree", slug: "preview", path: "/tmp/preview" }))
    .toThrow("canonical worktree");
});
