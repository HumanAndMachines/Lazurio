import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import {
  REQUIRED_TOOL_VERSIONS,
  bunVersionFromPackageManager,
  classifyBunRuntime,
  classifyNodeRuntime,
  classifyToolVersion,
  executablePathsMatch,
  nodeVersionFromOutput,
  nodeVersionRangeFromEngines,
  readRequiredBunVersion,
  readRequiredNodeVersionRange,
  readToolchainManifest,
  requiredNodeVersionRange,
  requiredToolVersions,
  resolveExecutableOnPath,
} from "./toolchain-lib.mjs";

// A synthetic lazurio/toolchain.json; `tools` replaces whole tool entries.
function toolchainText({ tools = {}, ...rest } = {}) {
  return JSON.stringify({
    schema_version: "lazurio.toolchain.v1",
    tools: {
      bun: { default: "1.4.2", minimum: "1.4.2" },
      node: { minimum: "22.12.0" },
      uv: { default: "0.11.6" },
      gh: { minimum: "2.57.0" },
      git: { minimum: "2.31.0" },
      ...tools,
    },
    ...rest,
  });
}

function toolchainFrom(text) {
  return readToolchainManifest({ root: "/fixture", readText: () => text });
}

test("the toolchain manifest is read from the given root and returned deeply frozen", () => {
  const read = [];
  const toolchain = readToolchainManifest({
    root: "/fixture",
    readText: (path) => {
      read.push(path);
      return toolchainText({ tools: { bun: { default: "1.4.4", minimum: "1.4.2" } } });
    },
  });
  expect(read).toEqual([resolve("/fixture", "toolchain.json")]);
  expect(toolchain).toEqual({
    schema_version: "lazurio.toolchain.v1",
    tools: {
      bun: { default: "1.4.4", minimum: "1.4.2" },
      node: { minimum: "22.12.0" },
      uv: { default: "0.11.6" },
      gh: { minimum: "2.57.0" },
      git: { minimum: "2.31.0" },
    },
  });
  expect(Object.isFrozen(toolchain)).toBe(true);
  expect(Object.isFrozen(toolchain.tools)).toBe(true);
  for (const tool of Object.values(toolchain.tools)) expect(Object.isFrozen(tool)).toBe(true);
});

test("the toolchain manifest fails clearly on anything but its exact shape", () => {
  expect(() => toolchainFrom("not json")).toThrow("Lazurio toolchain manifest cannot be read");
  expect(() => toolchainFrom("[]")).toThrow("Lazurio toolchain manifest is invalid");
  expect(() => toolchainFrom(toolchainText({ schema_version: "lazurio.toolchain.v2" })))
    .toThrow('unknown schema_version "lazurio.toolchain.v2"');
  expect(() => toolchainFrom(toolchainText({ owner: "someone" }))).toThrow("unknown field owner");
  for (const version of ["1.4", "^1.4.2", "1.4.3+sha512.abc", "v1.4.2", "01.4.2", "latest", 142, null]) {
    expect(() => toolchainFrom(toolchainText({ tools: { bun: { default: version, minimum: "1.4.2" } } })))
      .toThrow("tools.bun.default must be an exact x.y.z version");
  }
  expect(() => toolchainFrom(toolchainText({ tools: { node: { minimum: ">=22.12.0" } } })))
    .toThrow("tools.node.minimum must be an exact x.y.z version");
  expect(() => toolchainFrom(toolchainText({ tools: { bun: { default: "1.4.2", minimum: "1.4.3" } } })))
    .toThrow("tools.bun.minimum 1.4.3 is above its default 1.4.2");
  // Strict until Organizations may declare tools of their own.
  expect(() => toolchainFrom(toolchainText({ tools: { deno: { minimum: "2.0.0" } } }))).toThrow("unknown tool deno");
  expect(() => toolchainFrom(toolchainText({ tools: { node: { minimum: "22.12.0", default: "24.11.0" } } })))
    .toThrow("tools.node.default is not a field of node");
  expect(() => toolchainFrom(toolchainText({ tools: { bun: { default: "1.4.2" } } })))
    .toThrow("tools.bun.minimum must be an exact x.y.z version");
  const withoutUv = JSON.parse(toolchainText());
  delete withoutUv.tools.uv;
  expect(() => toolchainFrom(JSON.stringify(withoutUv))).toThrow("tools.uv is missing");
});

test("the CLI's own Bun and Node pins stay equal to the toolchain manifest", () => {
  const toolchain = readToolchainManifest();
  const cliPackage = JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8"));
  // 0134: packageManager stays the exact pin Lazurio itself runs on.
  expect(cliPackage.packageManager).toBe(`bun@${toolchain.tools.bun.default}`);
  expect(cliPackage.engines.bun).toBe(toolchain.tools.bun.default);
  expect(cliPackage.engines.node).toBe(`>=${toolchain.tools.node.minimum}`);
  expect(readRequiredBunVersion()).toBe(toolchain.tools.bun.default);
});

test("tool minimums are derived from the toolchain manifest", () => {
  const toolchain = readToolchainManifest();
  expect(REQUIRED_TOOL_VERSIONS).toEqual({ git: toolchain.tools.git.minimum, github_cli: toolchain.tools.gh.minimum });
  expect(Object.isFrozen(REQUIRED_TOOL_VERSIONS)).toBe(true);
  expect(readRequiredNodeVersionRange()).toBe(`>=${toolchain.tools.node.minimum}`);

  const raised = toolchainFrom(toolchainText({
    tools: { git: { minimum: "2.45.0" }, gh: { minimum: "2.80.0" }, node: { minimum: "24.0.0" } },
  }));
  expect(requiredToolVersions(raised)).toEqual({ git: "2.45.0", github_cli: "2.80.0" });
  expect(requiredNodeVersionRange(raised)).toBe(">=24.0.0");
  expect(classifyToolVersion("git", "git version 2.44.0", requiredToolVersions(raised)))
    .toMatchObject({ status: "incompatible", minimum_version: "2.45.0" });
  expect(classifyToolVersion("github_cli", "gh version 2.79.1 (2025-10-01)", requiredToolVersions(raised)))
    .toMatchObject({ status: "incompatible", minimum_version: "2.80.0" });
  expect(classifyToolVersion("git", "git version 2.44.0").status).toBe("compatible");
});

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

test("the toolchain manifest is the single Node.js compatibility authority", () => {
  expect(nodeVersionRangeFromEngines({ node: ">=22.12.0" })).toBe(">=22.12.0");
  expect(() => nodeVersionRangeFromEngines({ node: "latest" }))
    .toThrow("minimum stable Node.js version");
  expect(readRequiredNodeVersionRange({
    root: "/fixture",
    readText: () => toolchainText({ tools: { node: { minimum: "24.11.0" } } }),
  })).toBe(">=24.11.0");
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

test("Bun package execution is proven by `bun x`, not by a standalone bunx binary", async () => {
  const {
    BUN_PACKAGE_RUNNER_PROBE_ARGS,
    classifyBunPackageRunnerProbe,
  } = await import("./toolchain-lib.mjs");
  expect(BUN_PACKAGE_RUNNER_PROBE_ARGS).toEqual(["x", "--help"]);
  expect(classifyBunPackageRunnerProbe({ exitCode: 0, stdout: "Usage: bunx [flags] <package>" })).toBe("ready");
  // Bun 1.4 prints the usage contract but exits 1 when no package is supplied.
  expect(classifyBunPackageRunnerProbe({
    exitCode: 1,
    stdout: "",
    stderr: "Usage: bunx [flags] <package><@version> [flags and arguments for the package]",
  })).toBe("ready");
  expect(classifyBunPackageRunnerProbe({ exitCode: 1, stdout: "", stderr: "error: unknown subcommand" })).toBe("unusable");
  expect(classifyBunPackageRunnerProbe({ exitCode: 2, stdout: "Usage: bunx" })).toBe("unusable");
  expect(classifyBunPackageRunnerProbe({ exitCode: null })).toBe("unusable");
  expect(classifyBunPackageRunnerProbe()).toBe("unusable");
});

test("Bun remedy is the official installer pinned to the exact required version", async () => {
  const { OFFICIAL_BUN_INSTALL_DOCS_URL, officialBunInstallCommand } = await import("./toolchain-lib.mjs");
  expect(OFFICIAL_BUN_INSTALL_DOCS_URL).toBe("https://bun.com/docs/installation");
  expect(officialBunInstallCommand({ platform: "win32", version: "1.4.2" }))
    .toBe('iex "& {$(irm https://bun.com/install.ps1)} -Version 1.4.2"');
  expect(officialBunInstallCommand({ platform: "darwin", version: "1.4.2" }))
    .toBe('curl -fsSL https://bun.com/install | bash -s "bun-v1.4.2"');
  expect(officialBunInstallCommand({ platform: "linux", version: "1.4.2" }))
    .toBe('curl -fsSL https://bun.com/install | bash -s "bun-v1.4.2"');
  expect(officialBunInstallCommand({ platform: "freebsd", version: "1.4.2" })).toBeNull();
  for (const platform of ["win32", "darwin", "linux"]) {
    const command = officialBunInstallCommand({ platform, version: "1.4.2" });
    expect(command).not.toMatch(/npm|npx|winget|choco|brew|scoop|registry/iu);
  }
  expect(() => officialBunInstallCommand({ platform: "win32", version: "latest" })).toThrow();
  expect(() => officialBunInstallCommand({ platform: "win32", version: "1.4" })).toThrow();
});
