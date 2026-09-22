import { existsSync, readFileSync } from "node:fs";

import { githubRepositoryCoordinate } from "./organization-slot-scope-lib.mjs";

// Shared Organization Team VM (root decisions 0147–0149). Its only GitHub
// identity is the Organization bot reached through the Lazurio for GitHub
// broker; nobody signs a personal account in. Machines (`workspace-vm`,
// `workspace_guest.github_broker`) installs the brokered `gh`, the Git
// credential helper and this root-owned environment file. The file is the one
// signal Lazurio reads: its presence selects brokered mode, its repository
// policy is the client-side scope of what this Machine may clone. The broker
// still decides every token against the live GitHub Team grants.
export const BROKERED_GITHUB_ENVIRONMENT_FILE = "/etc/lazurio/github-broker/environment";
export const BROKERED_GITHUB_ACTOR = "lazurio-for-github[bot]";
export const BROKERED_GIT_CREDENTIAL_HELPER = "/usr/local/bin/github-app-credential-helper";

let cached;

/**
 * Returns the brokered identity of this Machine, or null on every Machine
 * without the Machines-managed environment file (all workstations and
 * personal VMs). A present but malformed file is not silently ignored:
 * it yields `{ valid: false }` so callers fail closed instead of falling back
 * to a personal login.
 */
export function brokeredGitHubIdentity({
  platform = process.platform,
  path = BROKERED_GITHUB_ENVIRONMENT_FILE,
  exists = existsSync,
  readFile = readFileSync,
  fresh = false,
} = {}) {
  const useCache = !fresh && path === BROKERED_GITHUB_ENVIRONMENT_FILE && exists === existsSync;
  if (useCache && cached !== undefined) return cached;
  let result = null;
  if (platform === "linux" && exists(path)) {
    try {
      result = parseBrokeredGitHubEnvironment(readFile(path, "utf8"));
    } catch {
      result = Object.freeze({ valid: false });
    }
  }
  if (useCache) cached = result;
  return result;
}

export function resetBrokeredGitHubIdentityCacheForTests() {
  cached = undefined;
}

export function parseBrokeredGitHubEnvironment(raw) {
  const values = {};
  for (const line of String(raw).split("\n")) {
    if (line === "" || line.startsWith("#")) continue;
    const match = line.match(/^([A-Z_]+)=(.*)$/u);
    if (!match) throw new Error("brokered GitHub environment is malformed");
    const value = match[2].startsWith("'") && match[2].endsWith("'") ? match[2].slice(1, -1) : match[2];
    values[match[1]] = value;
  }
  const origin = values.GITHUB_TOKEN_BROKER_URL;
  const workspaceId = values.GITHUB_BROKER_WORKSPACE_ID;
  if (!/^https:\/\/[a-z0-9.-]+$/u.test(origin ?? "") || !/^[a-z0-9][a-z0-9-]{1,62}$/u.test(workspaceId ?? "")) {
    throw new Error("brokered GitHub environment is malformed");
  }
  const policy = JSON.parse(values.GITHUB_REPOSITORY_POLICY_JSON ?? "null");
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) {
    throw new Error("brokered GitHub repository policy is malformed");
  }
  const repositories = Object.entries(policy).map(([fullName, id]) => {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(fullName) || !Number.isSafeInteger(id) || id <= 0) {
      throw new Error("brokered GitHub repository policy is malformed");
    }
    return Object.freeze({ fullName, id });
  });
  if (repositories.length === 0) throw new Error("brokered GitHub repository policy is empty");
  return Object.freeze({ valid: true, origin, workspaceId, repositories: Object.freeze(repositories) });
}

/** True when the remote names a repository inside this Machine's broker policy. */
export function brokeredRepositoryAllowed(identity, remote) {
  const coordinate = githubRepositoryCoordinate(remote);
  if (!identity?.valid || !coordinate) return false;
  const key = coordinate.ownerRepo.toLowerCase();
  return identity.repositories.some((repository) => repository.fullName.toLowerCase() === key);
}

/**
 * The sterile materialization lane disables system Git configuration. On a
 * brokered Team VM it re-enables exactly the Machines-managed broker helper
 * and the SSH-to-HTTPS rewrite, and nothing else from system config.
 */
export function brokeredGitConfigEnvironment(identity) {
  if (!identity?.valid) return null;
  return {
    GIT_CONFIG_COUNT: "3",
    GIT_CONFIG_KEY_0: "credential.helper",
    GIT_CONFIG_VALUE_0: BROKERED_GIT_CREDENTIAL_HELPER,
    GIT_CONFIG_KEY_1: "credential.useHttpPath",
    GIT_CONFIG_VALUE_1: "true",
    GIT_CONFIG_KEY_2: "url.https://github.com/.insteadOf",
    GIT_CONFIG_VALUE_2: "git@github.com:",
  };
}

/**
 * Brokered `gh` resolves one repository per call from `GH_REPO` or the
 * working directory's origin. Organization-level reads (orgs/<login>,
 * repository metadata) therefore run from a neutral directory with the
 * Organization root repository as the selected repository.
 */
export function brokeredGitHubProviderContext(identity, organizationLogin) {
  if (!identity?.valid || typeof organizationLogin !== "string" || organizationLogin === "") return null;
  const root = `${organizationLogin}/${organizationLogin}_GEN3`;
  const selected = identity.repositories.find((repository) => repository.fullName.toLowerCase() === root.toLowerCase());
  return selected ? { cwd: "/", repository: selected.fullName } : null;
}

/** Exact brokered viewer proof: `gh auth status --json hosts` names the bot. */
export function brokeredAuthStatusSatisfied(value) {
  const hosts = value?.hosts?.["github.com"];
  return Array.isArray(hosts)
    && hosts.some((entry) => entry?.state === "success" && entry?.active === true && entry?.login === BROKERED_GITHUB_ACTOR);
}
