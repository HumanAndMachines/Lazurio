import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

import { inspectLazurioInstallation } from "./core/install-core-lib.mjs";
import {
  installCatalogIssues,
  renderHumanInstallReport,
  selectInstallLanguage,
} from "./install-output-lib.mjs";

test("cs/en catalogs are complete and machine output stays locale-neutral", async () => {
  const report = fixtureReport();
  const machineBefore = JSON.stringify(report, null, 2);

  expect(installCatalogIssues()).toEqual([]);
  expect(renderHumanInstallReport(report, { language: "cs" })).toContain("vyžaduje akci");
  expect(renderHumanInstallReport(report, { language: "en" })).toContain("action required");
  expect(renderHumanInstallReport(fixtureReport({ resolvePathCommand: () => null }), { language: "cs" }))
    .toContain("uživatelském PATH");
  expect(JSON.stringify(report, null, 2)).toBe(machineBefore);
});

test("explicit language wins and ambient English is the only non-Czech fallback", () => {
  expect(selectInstallLanguage({ requested: "en", environment: { LANG: "cs_CZ.UTF-8" } })).toBe("en");
  expect(selectInstallLanguage({ environment: { LANG: "en_US.UTF-8" } })).toBe("en");
  expect(selectInstallLanguage({ environment: { LANG: "de_DE.UTF-8" } })).toBe("cs");
  expect(() => selectInstallLanguage({ requested: "de" })).toThrow("--language");
});

test("human and JSON golden files derive from the same Core result", async () => {
  const report = fixtureReport();
  const expectedJson = await readFile(new URL("./testdata/golden/install-report.json", import.meta.url), "utf8");
  const expectedCs = await readFile(new URL("./testdata/golden/install-report.cs.txt", import.meta.url), "utf8");
  const expectedEn = await readFile(new URL("./testdata/golden/install-report.en.txt", import.meta.url), "utf8");

  expect(`${JSON.stringify(report, null, 2)}\n`).toBe(expectedJson);
  expect(`${renderHumanInstallReport(report, { language: "cs" })}\n`).toBe(expectedCs);
  expect(`${renderHumanInstallReport(report, { language: "en" })}\n`).toBe(expectedEn);
});

function fixtureReport({
  resolvePathCommand = (command) => {
    if (command === "bun") return process.execPath;
    if (command === "git") return "/usr/bin/git";
    if (command === "node") return "/trusted/bin/node";
    return null;
  },
} = {}) {
  return inspectLazurioInstallation({
    root: null,
    platform: "darwin",
    architecture: "arm64",
    bunVersion: "1.4.0",
    environment: { HOME: "/Users/example" },
    homeDirectory: "/Users/example",
    resolveGit: () => "/usr/bin/git",
    resolveGitHubCli: () => null,
    resolvePathCommand,
    runCommand: ({ executable }) => ({
      status: 0,
      stdout: executable === "/trusted/bin/node" ? "v24.19.0" : "",
    }),
    inspectRoot: (path) => ({
      path,
      layout: "missing",
      status: "action_required",
      reason: "root_creation_required",
    }),
  });
}
