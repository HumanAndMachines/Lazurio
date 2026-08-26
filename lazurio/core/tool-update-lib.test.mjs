import { expect, test } from "bun:test";

import {
  DEVELOPER_TOOL_UPDATE_POLICY,
  compareStableVersions,
  inspectDeveloperToolUpdates,
  latestStableTag,
} from "./tool-update-lib.mjs";

const definitions = [
  {
    id: "example",
    title: "Example CLI",
    executable: "example",
    required: true,
    version_args: ["--version"],
    version_pattern: /example (\d+\.\d+\.\d+)/u,
    release_source: { kind: "github_latest_release", api_url: "https://example.invalid", project_url: "https://example.invalid/releases" },
  },
];

test("developer tool update observation is read-only and requires Principal consent", async () => {
  const calls = [];
  const [observation] = await inspectDeveloperToolUpdates({
    definitions,
    resolveExecutable: (name) => `/trusted/${name}`,
    runCommand: (executable, args) => {
      calls.push(["run", executable, args]);
      return { status: 0, stdout: "example 1.2.3\n" };
    },
    fetchRelease: async (source) => {
      calls.push(["fetch", source.api_url]);
      return { version: "1.3.0", url: "https://example.invalid/releases/1.3.0" };
    },
  });

  expect(observation).toMatchObject({
    status: "update_available",
    reason: "newer_official_release",
    current_version: "1.2.3",
    latest_version: "1.3.0",
    update_policy: DEVELOPER_TOOL_UPDATE_POLICY,
  });
  expect(calls).toEqual([
    ["run", "/trusted/example", ["--version"]],
    ["fetch", "https://example.invalid"],
  ]);
  expect(JSON.stringify(calls)).not.toMatch(/update|upgrade|install/u);
});

test("offline release lookup stays explicit instead of guessing currency", async () => {
  const [observation] = await inspectDeveloperToolUpdates({
    definitions,
    resolveExecutable: () => "/trusted/example",
    runCommand: () => ({ status: 0, stdout: "example 1.2.3" }),
    fetchRelease: async () => {
      const error = new Error("offline");
      error.code = "release_lookup_unavailable";
      throw error;
    },
  });

  expect(observation).toMatchObject({
    status: "currency_unknown",
    reason: "release_lookup_unavailable",
    current_version: "1.2.3",
    latest_version: null,
  });
});

test("optional missing tools do not trigger release requests", async () => {
  let fetched = false;
  const [observation] = await inspectDeveloperToolUpdates({
    definitions: [{ ...definitions[0], required: false }],
    resolveExecutable: () => null,
    fetchRelease: async () => {
      fetched = true;
      return { version: "1.0.0", url: "https://example.invalid" };
    },
  });

  expect(observation.status).toBe("not_installed");
  expect(fetched).toBe(false);
});

test("stable version comparison and Git tags ignore release candidates", () => {
  expect(compareStableVersions("2.55.0", "2.54.3")).toBeGreaterThan(0);
  expect(compareStableVersions("0.150.0", "0.150.0")).toBe(0);
  expect(latestStableTag([
    { name: "v2.56.0-rc1" },
    { name: "v2.55.0" },
    { name: "v2.54.3" },
  ])).toBe("2.55.0");
});
