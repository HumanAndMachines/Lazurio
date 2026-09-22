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
  const status = (login, extra = {}) => ({ hosts: { "github.com": [{ state: "success", active: true, login, ...extra }] } });
  expect(brokeredAuthStatusSatisfied(status(BROKERED_GITHUB_ACTOR))).toBe(true);
  expect(brokeredAuthStatusSatisfied(status("somebody"))).toBe(false);
  expect(brokeredAuthStatusSatisfied(status(BROKERED_GITHUB_ACTOR, { state: "error" }))).toBe(false);
  expect(brokeredAuthStatusSatisfied(null)).toBe(false);
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
  const { mkdtemp, writeFile, chmod, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { githubAuthenticationCheck } = await import("../runtime/diagnostics-lib.mjs");
  const directory = await mkdtemp(join(tmpdir(), "brokered-doctor-"));
  const fakeGh = async (login) => {
    const path = join(directory, `gh-${login.replace(/\W/gu, "")}`);
    const payload = JSON.stringify({ hosts: { "github.com": [{ state: "success", active: true, login }] } });
    await writeFile(path, `#!/bin/sh\n[ "$*" = "auth status --json hosts" ] || exit 9\nprintf '%s' '${payload}'\n`);
    await chmod(path, 0o755);
    return path;
  };
  try {
    const identity = parseBrokeredGitHubEnvironment(environmentFile);
    const bot = githubAuthenticationCheck({ companiesRoot: directory, executable: await fakeGh(BROKERED_GITHUB_ACTOR), brokered: identity });
    expect(bot).toMatchObject({ id: "platform.github_auth", status: "ok", severity: "required" });
    const human = githubAuthenticationCheck({ companiesRoot: directory, executable: await fakeGh("somebody"), brokered: identity });
    expect(human.status).toBe("fail");
    const broken = githubAuthenticationCheck({ companiesRoot: directory, executable: await fakeGh(BROKERED_GITHUB_ACTOR), brokered: { valid: false } });
    expect(broken.status).toBe("fail");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
