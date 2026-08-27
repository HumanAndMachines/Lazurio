import { expect, test } from "bun:test";

import {
  bunVersionFromPackageManager,
  classifyBunRuntime,
  readRequiredBunVersion,
} from "./toolchain-lib.mjs";

test("packageManager is the exact Bun version authority", () => {
  expect(bunVersionFromPackageManager("bun@1.4.0")).toBe("1.4.0");
  expect(() => bunVersionFromPackageManager("bun@1.4.x")).toThrow("exact stable Bun version");
  expect(() => bunVersionFromPackageManager("npm@11.0.0")).toThrow("exact stable Bun version");
  expect(() => bunVersionFromPackageManager(null)).toThrow("exact stable Bun version");
});

test("tracked workstation package exposes the single consumable Bun authority", () => {
  expect(readRequiredBunVersion({
    root: "/fixture",
    readText: () => JSON.stringify({ packageManager: "bun@1.4.0" }),
  })).toBe("1.4.0");
  expect(() => readRequiredBunVersion({
    root: "/fixture",
    readText: () => "not json",
  })).toThrow("cannot be read");
});

test("runtime classifier is exact and keeps future patches fail-closed", () => {
  expect(classifyBunRuntime({ currentVersion: "1.4.0", requiredVersion: "1.4.0" }).status)
    .toBe("current");
  expect(classifyBunRuntime({ currentVersion: "1.4.1", requiredVersion: "1.4.0" }).status)
    .toBe("mismatch");
  expect(classifyBunRuntime({ currentVersion: null, requiredVersion: "1.4.0" }).status)
    .toBe("unavailable");
  expect(() => classifyBunRuntime({ currentVersion: "1.4.0", requiredVersion: "latest" }))
    .toThrow("exact stable version");
});
