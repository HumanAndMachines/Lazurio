import { expect, test } from "bun:test";
import { dirname } from "node:path";

import {
  bunVersionFromPackageManager,
  classifyBunRuntime,
  classifyNodeRuntime,
  nodeMinimumVersionFromEngines,
  readRequiredBunVersion,
  readRequiredNodeMinimum,
  executablePathsMatch,
  resolveExecutableOnPath,
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

test("engines.node is the minimum Node.js workstation authority", () => {
  expect(nodeMinimumVersionFromEngines(">=22.0.0")).toBe("22.0.0");
  expect(() => nodeMinimumVersionFromEngines(">=22")).toThrow("exact minimum stable");
  expect(() => nodeMinimumVersionFromEngines("latest")).toThrow("exact minimum stable");
  expect(readRequiredNodeMinimum({
    root: "/fixture",
    readText: () => JSON.stringify({ engines: { node: ">=22.0.0" } }),
  })).toBe("22.0.0");
});

test("Node.js classifier accepts the declared minimum or newer", () => {
  expect(classifyNodeRuntime({ currentVersion: "v22.0.0", minimumVersion: "22.0.0" }))
    .toEqual({ status: "current", current_version: "22.0.0", minimum_version: "22.0.0" });
  expect(classifyNodeRuntime({ currentVersion: "v22.0.0-rc.1", minimumVersion: "22.0.0" }))
    .toEqual({ status: "unavailable", current_version: null, minimum_version: "22.0.0" });
  expect(classifyNodeRuntime({ currentVersion: "24.1.0", minimumVersion: "22.0.0" }).status)
    .toBe("current");
  expect(classifyNodeRuntime({ currentVersion: "v20.19.0", minimumVersion: "22.0.0" }).status)
    .toBe("outdated");
  expect(classifyNodeRuntime({ currentVersion: null, minimumVersion: "22.0.0" }).status)
    .toBe("unavailable");
});

test("PATH resolver proves the executable visible to a fresh command process", () => {
  const environment = process.platform === "win32"
    ? { Path: dirname(process.execPath), PATHEXT: ".EXE;.CMD" }
    : { PATH: dirname(process.execPath) };
  expect(resolveExecutableOnPath("bun", {
    environment,
    platform: process.platform,
    cwd: dirname(process.execPath),
  })).not.toBeNull();
  expect(resolveExecutableOnPath("bun", {
    environment: process.platform === "win32" ? { Path: "" } : { PATH: "" },
    platform: process.platform,
    cwd: dirname(process.execPath),
  })).toBeNull();
  expect(resolveExecutableOnPath("../bun", { environment, platform: process.platform })).toBeNull();
});

test("executable identity follows canonical files but rejects an earlier PATH shadow", () => {
  expect(executablePathsMatch("/trusted/bin/git", "/trusted/bin/git", {
    platform: "linux",
    canonicalize: (path) => path,
  })).toBe(true);
  expect(executablePathsMatch("/tmp/shadow/git", "/usr/bin/git", {
    platform: "linux",
    canonicalize: (path) => path,
  })).toBe(false);
  expect(executablePathsMatch("C:\\TOOLS\\GH.EXE", "c:\\tools\\gh.exe", {
    platform: "win32",
    canonicalize: (path) => path,
  })).toBe(true);
});
