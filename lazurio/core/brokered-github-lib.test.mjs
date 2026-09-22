import { expect, test } from "bun:test";

import {
  BROKERED_GITHUB_ACTOR,
  brokeredAuthStatusSatisfied,
  brokeredGitConfigEnvironment,
  brokeredGitHubIdentity,
  brokeredGitHubProviderContext,
  brokeredRepositoryAllowed,
  parseBrokeredGitHubEnvironment,
} from "./brokered-github-lib.mjs";
import { safeGitCommandEnv, safeGitRemoteEnv } from "../runtime/git-lib.mjs";

// Byte-identical to what Machines `workspace_github_broker` renders.
// Exactly what the released brokered-gh v0.8.0 prints for the live proof.
function botStatus(overrides = {}) {
  return {
    hosts: {
      "github.com": [{
        state: "success",
        active: true,
        host: "github.com",
        login: BROKERED_GITHUB_ACTOR,
        tokenSource: "lazurio-broker-live-proof",
        scopes: "",
        gitProtocol: "https",
        ...overrides,
      }],
    },
  };
}

const environmentFile = [
  "GITHUB_TOKEN_BROKER_URL=https://example.github-broker.lazurio.ai",
  "GITHUB_BROKER_WORKSPACE_ID=example-team",
  "GITHUB_BROKER_CLIENT_CREDENTIAL_FILE=/run/secrets/github_broker_client_token",
  `GITHUB_REPOSITORY_POLICY_JSON='{"Example/Example_GEN3":1,"Example/mission-control-data":2}'`,
  "",
].join("\n");

test("the Machines-managed environment file selects brokered mode only on Linux", () => {
  const identity = brokeredGitHubIdentity({
    platform: "linux",
    path: "/fixture/environment",
    exists: () => true,
    readFile: () => environmentFile,
  });
  expect(identity).toMatchObject({
    valid: true,
    origin: "https://example.github-broker.lazurio.ai",
    workspaceId: "example-team",
  });
  expect(identity.repositories.map((repository) => repository.fullName)).toEqual([
    "Example/Example_GEN3",
    "Example/mission-control-data",
  ]);
  expect(brokeredGitHubIdentity({ platform: "darwin", path: "/fixture/environment", exists: () => true, readFile: () => environmentFile })).toBeNull();
  expect(brokeredGitHubIdentity({ platform: "linux", path: "/fixture/environment", exists: () => false })).toBeNull();
  expect(brokeredGitHubIdentity({ platform: "linux", path: "/fixture/environment", exists: () => true, readFile: () => "garbage" }))
    .toEqual({ valid: false });
});

test("malformed or empty broker policies are refused", () => {
  for (const raw of [
    environmentFile.replace("https://example", "http://example"),
    environmentFile.replace("example-team", "Example Team"),
    environmentFile.replace(/'\{.*\}'/u, "'{}'"),
    environmentFile.replace(/'\{.*\}'/u, `'{"not a repo":1}'`),
    environmentFile.replace(/'\{.*\}'/u, `'{"Example/a":0}'`),
  ]) {
    expect(() => parseBrokeredGitHubEnvironment(raw)).toThrow();
  }
});

test("policy scope, provider context and bot proof are exact", () => {
  const identity = parseBrokeredGitHubEnvironment(environmentFile);
  expect(brokeredRepositoryAllowed(identity, "git@github.com:Example/mission-control-data.git")).toBe(true);
  expect(brokeredRepositoryAllowed(identity, "https://github.com/example/example_gen3.git")).toBe(true);
  expect(brokeredRepositoryAllowed(identity, "git@github.com:Example/infra.git")).toBe(false);
  expect(brokeredRepositoryAllowed({ valid: false }, "git@github.com:Example/Example_GEN3.git")).toBe(false);
  expect(brokeredGitHubProviderContext(identity, "Example")).toEqual({ cwd: "/", repository: "Example/Example_GEN3" });
  expect(brokeredGitHubProviderContext(identity, "Other")).toBeNull();
  expect(brokeredAuthStatusSatisfied(botStatus())).toBe(true);
  expect(brokeredAuthStatusSatisfied(botStatus({ login: "somebody" }))).toBe(false);
  expect(brokeredAuthStatusSatisfied(botStatus({ state: "error" }))).toBe(false);
  expect(brokeredAuthStatusSatisfied(botStatus({ tokenSource: "keyring" }))).toBe(false);
  expect(brokeredAuthStatusSatisfied(botStatus({ token: "gho_x" }))).toBe(false);
  expect(brokeredAuthStatusSatisfied(null)).toBe(false);
  const bot = botStatus().hosts["github.com"][0];
  const personal = { ...bot, login: "personal-user", tokenSource: "keyring" };
  // A personal identity next to the bot, a second bot entry, another host or
  // extra envelope fields are never the brokered identity.
  for (const value of [
    { hosts: { "github.com": [bot, personal] } },
    { hosts: { "github.com": [personal, bot] } },
    { hosts: { "github.com": [bot, { ...bot, active: false }] } },
    { hosts: { "github.com": [bot], "ghe.example.com": [personal] } },
    { hosts: { "github.com": [] } },
    { hosts: {} },
    { hosts: { "github.com": [bot] }, extra: true },
  ]) {
    expect(brokeredAuthStatusSatisfied(value)).toBe(false);
  }
});

test("the sterile Git lane re-enables exactly the broker helper and SSH rewrite", () => {
  const identity = parseBrokeredGitHubEnvironment(environmentFile);
  const env = safeGitRemoteEnv("linux", identity);
  expect(env).toMatchObject({
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    ...brokeredGitConfigEnvironment(identity),
  });
  expect(env.GIT_CONFIG_COUNT).toBe("3");
  expect(safeGitRemoteEnv("linux", null).GIT_CONFIG_COUNT).toBe("0");
  expect(safeGitRemoteEnv("linux", { valid: false }).GIT_CONFIG_COUNT).toBe("0");
  expect(safeGitRemoteEnv("linux", null).GIT_CONFIG_KEY_0).toBeUndefined();
  expect(Object.keys(safeGitCommandEnv("linux", {})).some((key) => key.startsWith("GIT_CONFIG_KEY_"))).toBe(false);
});

test("Doctor accepts only the brokered bot as the GitHub identity of a Team VM", async () => {
  const { githubAuthenticationCheck } = await import("../runtime/diagnostics-lib.mjs");
  const identity = parseBrokeredGitHubEnvironment(environmentFile);
  const calls = [];
  // Injected runner: the check must ask exactly the brokered status envelope.
  const runner = (value) => (executable, args, options) => {
    calls.push({ executable, args, cwd: options?.cwd });
    return { ok: true, stdout: JSON.stringify(value), stderr: "" };
  };
  const check = (value, brokered = identity) => githubAuthenticationCheck({
    companiesRoot: "/root-fixture",
    executable: "/usr/local/bin/gh",
    brokered,
    run: runner(value),
  });
  expect(check(botStatus())).toMatchObject({ id: "platform.github_auth", status: "ok", severity: "required" });
  expect(calls.at(-1)).toEqual({ executable: "/usr/local/bin/gh", args: ["auth", "status", "--json", "hosts"], cwd: "/" });
  expect(check(botStatus({ login: "somebody" })).status).toBe("fail");
  const bot = botStatus().hosts["github.com"][0];
  expect(check({ hosts: { "github.com": [bot, { ...bot, login: "personal-user", tokenSource: "keyring" }] } }).status).toBe("fail");
  const callsBefore = calls.length;
  expect(check(botStatus(), { valid: false }).status).toBe("fail");
  expect(calls.length).toBe(callsBefore);
});
