import { expect, test } from "bun:test";
import { dirname } from "node:path";

import {
  bunVersionFromPackageManager,
  classifyBunRuntime,
  classifyNodeRuntime,
  executablePathsMatch,
  nodeVersionFromOutput,
  nodeVersionRangeFromEngines,
  readRequiredBunVersion,
  readRequiredNodeVersionRange,
  resolveExecutableOnPath,
} from "./toolchain-lib.mjs";

test("packageManager is the exact Bun version authority", () => {
  expect(bunVersionFromPackageManager("bun@1.4.1")).toBe("1.4.1");
  expect(() => bunVersionFromPackageManager("bun@1.4.x")).toThrow("exact stable Bun version");
  expect(() => bunVersionFromPackageManager("npm@11.0.0")).toThrow("exact stable Bun version");
  expect(() => bunVersionFromPackageManager(null)).toThrow("exact stable Bun version");
});

test("tracked workstation package exposes the single consumable Bun authority", () => {
  expect(readRequiredBunVersion({
    root: "/fixture",
    readText: () => JSON.stringify({ packageManager: "bun@1.4.1" }),
  })).toBe("1.4.1");
  expect(() => readRequiredBunVersion({
    root: "/fixture",
    readText: () => "not json",
  })).toThrow("cannot be read");
});

test("runtime classifier is exact and keeps future patches fail-closed", () => {
  expect(classifyBunRuntime({ currentVersion: "1.4.1", requiredVersion: "1.4.1" }).status)
    .toBe("current");
  expect(classifyBunRuntime({ currentVersion: "1.4.2", requiredVersion: "1.4.1" }).status)
    .toBe("mismatch");
  expect(classifyBunRuntime({ currentVersion: null, requiredVersion: "1.4.1" }).status)
    .toBe("unavailable");
  expect(() => classifyBunRuntime({ currentVersion: "1.4.1", requiredVersion: "latest" }))
    .toThrow("exact stable version");
});

test("package engines are the single Node.js compatibility authority", () => {
  expect(nodeVersionRangeFromEngines({ node: ">=22.12.0" })).toBe(">=22.12.0");
  expect(() => nodeVersionRangeFromEngines({ node: "latest" }))
    .toThrow("minimum stable Node.js version");
  expect(readRequiredNodeVersionRange({
    root: "/fixture",
    readText: () => JSON.stringify({ engines: { node: ">=22.12.0" } }),
  })).toBe(">=22.12.0");
  expect(() => readRequiredNodeVersionRange({
    root: "/fixture",
    readText: () => "not json",
  })).toThrow("cannot be read");
});

test("Node.js classifier accepts the supported LTS and current consumer proofs", () => {
  expect(classifyNodeRuntime({
    currentVersion: "22.12.0",
    requiredRange: ">=22.12.0",
  }).status).toBe("compatible");
  expect(classifyNodeRuntime({
    currentVersion: "24.19.0",
    requiredRange: ">=22.12.0",
  }).status).toBe("compatible");
  expect(classifyNodeRuntime({
    currentVersion: "26.5.0",
    requiredRange: ">=22.12.0",
  }).status).toBe("compatible");
  expect(classifyNodeRuntime({
    currentVersion: "22.11.0",
    requiredRange: ">=22.12.0",
  }).status).toBe("incompatible");
  expect(classifyNodeRuntime({
    currentVersion: null,
    requiredRange: ">=22.12.0",
  }).status).toBe("unavailable");
  expect(() => classifyNodeRuntime({
    currentVersion: "26.5.0",
    requiredRange: "latest",
  })).toThrow("minimum stable version");
  expect(nodeVersionFromOutput("v24.19.0\n")).toBe("24.19.0");
  expect(nodeVersionFromOutput("CANARY")).toBeNull();
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

test("tool compatibility floors are independent of newest release", async () => {
  const { classifyToolVersion } = await import("./toolchain-lib.mjs");
  expect(classifyToolVersion("git", "git version 2.31.0.windows.1").status).toBe("compatible");
  expect(classifyToolVersion("git", "git version 2.30.9").status).toBe("incompatible");
  expect(classifyToolVersion("github_cli", "gh version 2.57.0 (2024-09-16)").status).toBe("compatible");
  expect(classifyToolVersion("github_cli", "gh version 2.56.9").status).toBe("incompatible");
  expect(classifyToolVersion("codex", "codex-cli 0.147.0").status).toBe("compatible");
  expect(classifyToolVersion("codex", "unrelated CLI 9.9.9").status).toBe("unusable");
  expect(classifyToolVersion("codex", "codex-cli 0.153.0-alpha.1").status).toBe("unusable");
});

test("PATH selection accepts custom locations and preserves the first shim", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join, delimiter } = await import("node:path");
  const root = mkdtempSync(join(tmpdir(), "lazurio-tool-path-"));
  try {
    const first = join(root, "version manager"), second = join(root, "other");
    mkdirSync(first); mkdirSync(second);
    const name = process.platform === "win32" ? "codex.cmd" : "codex";
    const selected = join(first, name);
    writeFileSync(selected, "broken", { mode: 0o755 });
    writeFileSync(join(second, name), "working", { mode: 0o755 });
    const environment = { PATH: [first, second].join(delimiter), PATHEXT: ".EXE;.CMD" };
    expect(resolveExecutableOnPath("codex", { environment })).toBe(selected);
    expect(resolveExecutableOnPath("codex", { environment: { PATH: second, PATHEXT: ".EXE;.CMD" } })).toBe(join(second, name));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
