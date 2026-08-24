import { expect, test } from "bun:test";

import {
  createTrustedGitHubProvider,
  sanitizedGitHubEnvironment,
} from "./github-provider-lib.mjs";

test("trusted GitHub provider uses one exact executable and sanitized environment", () => {
  const calls = [];
  const provider = createTrustedGitHubProvider({
    platform: "linux",
    environment: {
      PATH: "/shadow/bin:/usr/bin",
      HOME: "/home/example",
      GH_DEBUG: "api",
      NODE_OPTIONS: "--require=/tmp/shadow.cjs",
    },
    resolveExecutable: () => "/usr/bin/gh",
    runCommand: (call) => {
      calls.push(call);
      return {
        status: 0,
        stdout: JSON.stringify({ id: 42, login: "Example" }),
        stderr: "",
      };
    },
  });

  expect(provider.json(["api", "organizations/42"])).toMatchObject({
    ok: true,
    value: { id: 42, login: "Example" },
  });
  expect(calls).toHaveLength(1);
  expect(calls[0].executable).toBe("/usr/bin/gh");
  expect(calls[0].environment.GH_DEBUG).toBeUndefined();
  expect(calls[0].environment.NODE_OPTIONS).toBeUndefined();
  expect(calls[0].environment.GH_HOST).toBe("github.com");
  expect(calls[0].environment.GH_PROMPT_DISABLED).toBe("1");
});

test("trusted GitHub provider returns structured HTTP and response failures", () => {
  const missing = createTrustedGitHubProvider({
    resolveExecutable: () => "/usr/bin/gh",
    runCommand: () => ({
      status: 1,
      stdout: JSON.stringify({ status: "404", message: "Not Found" }),
      stderr: "gh: Not Found (HTTP 404)",
    }),
  }).json(["api", "repos/Example/missing"]);
  expect(missing).toMatchObject({
    ok: false,
    httpStatus: 404,
    error: { kind: "http", message: "Not Found" },
  });

  const malformed = createTrustedGitHubProvider({
    resolveExecutable: () => "/usr/bin/gh",
    runCommand: () => ({ status: 0, stdout: "not-json", stderr: "" }),
  }).json(["api", "user"]);
  expect(malformed).toMatchObject({
    ok: false,
    error: { kind: "invalid_response" },
  });

  const transport = createTrustedGitHubProvider({
    resolveExecutable: () => "/usr/bin/gh",
    runCommand: () => ({
      status: null,
      stdout: "",
      stderr: "spawnSync /usr/bin/gh ETIMEDOUT",
      error: { message: "spawnSync /usr/bin/gh ETIMEDOUT" },
    }),
  }).json(["api", "user"]);
  expect(transport).toMatchObject({
    ok: false,
    status: null,
    error: { kind: "transport", message: "spawnSync /usr/bin/gh ETIMEDOUT" },
  });
});

test("GitHub environment keeps credential custody inputs but drops ambient loaders", () => {
  expect(sanitizedGitHubEnvironment({
    HOME: "/home/example",
    GH_TOKEN: "token-from-approved-custody",
    DYLD_INSERT_LIBRARIES: "/tmp/inject.dylib",
  })).toMatchObject({
    HOME: "/home/example",
    GH_TOKEN: "token-from-approved-custody",
    GH_HOST: "github.com",
  });
  expect(
    sanitizedGitHubEnvironment({ DYLD_INSERT_LIBRARIES: "/tmp/inject.dylib" })
      .DYLD_INSERT_LIBRARIES,
  ).toBeUndefined();
});
