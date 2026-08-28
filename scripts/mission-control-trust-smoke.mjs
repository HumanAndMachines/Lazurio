#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  normalizeComparableCliPath,
  normalizeGitHubRepository,
  resolveTrustedGitExecutable,
  runTrustedGitCommandSync,
} from "../lazurio/core/cli-provenance-lib.mjs";
import { createTrustedGitHubProvider } from "../lazurio/core/github-provider-lib.mjs";
import { readOrganizationRoot } from "../lazurio/core/organization-root-reader-lib.mjs";

const GITHUB_REPOSITORY_PATTERN =
  /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/(?!(?:\.{1,2})$)[A-Za-z0-9._-]{1,100}$/u;
const GITHUB_LOGIN_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/u;
const POSITIVE_ID_PATTERN = /^[1-9][0-9]{0,19}$/u;
const HISTORY_RULE_TYPES = new Set(["deletion", "non_fast_forward"]);

function json(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(
      `${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function slotsOf(manifest) {
  if (Array.isArray(manifest)) return manifest;
  if (Array.isArray(manifest?.modules)) return manifest.modules;
  if (Array.isArray(manifest?.module_slots)) return manifest.module_slots;
  return [];
}

function normalizedSlotStatus(slot) {
  const explicit = String(slot?.status ?? "").toLowerCase();
  if (["planned", "planned_slot"].includes(explicit)) return "planned";
  if (explicit === "active") return "active";
  const materialization = String(slot?.materialization ?? "").toLowerCase();
  return ["planned", "planned_slot"].includes(materialization)
    ? "planned"
    : "active";
}

export function classifyDataState(slot, repositoryExists) {
  if (!slot) return repositoryExists ? "incomplete" : "missing-slot";
  const declared = normalizedSlotStatus(slot);
  if (declared === "active") return repositoryExists ? "active" : "incomplete";
  return repositoryExists ? "staged" : "planned";
}

export function resolveDataRepositoryLocator(slot, liveOrganizationLogin) {
  if (!slot) return { coordinate: null, error: null };
  const declared = slot?.git?.url;
  if (typeof declared === "string" && declared.trim() !== "") {
    const coordinate = parseRepoLocator(declared);
    if (coordinate) return { coordinate, error: null };
    return {
      coordinate: null,
      error: "Mission Control data slot obsahuje neplatný GitHub repo locator",
    };
  }
  if (!GITHUB_LOGIN_PATTERN.test(String(liveOrganizationLogin ?? ""))) {
    return {
      coordinate: null,
      error: "Živá GitHub Organization identita nemůže určit standardní data repo locator",
    };
  }
  return {
    coordinate: `${liveOrganizationLogin}/mission-control-data`,
    error: null,
  };
}

export function resolveDataPublishBranch(slot, repository) {
  const branch = typeof slot?.git?.branch === "string"
    ? slot.git.branch.trim()
    : "";
  if (branch === "") {
    return {
      branch: null,
      error: "Aktivní Mission Control data slot musí deklarovat git.branch",
    };
  }
  if (branch !== "v3") {
    return {
      branch: null,
      error: `Mission Control data publish branch musí být v3, nalezeno ${branch}`,
    };
  }
  if (repository?.default_branch !== branch) {
    return {
      branch: null,
      error:
        `Mission Control data repo má default branch ${repository?.default_branch ?? "neznámou"}, `
        + `slot deklaruje ${branch}`,
    };
  }
  return { branch, error: null };
}

function evaluateClassicProtection(response) {
  if (response.kind === "unsupported") {
    return {
      kind: "unsupported",
      historyProtected: false,
      policy: "provider-feature-unavailable",
      notes: [],
      problems: [],
    };
  }
  if (response.kind === "blocked") {
    return {
      kind: "blocked",
      historyProtected: false,
      policy: "unobservable",
      notes: [],
      problems: [response.message || "GitHub branch protection nelze ověřit"],
    };
  }
  if (response.kind === "unconfigured") {
    return {
      kind: "unconfigured",
      historyProtected: false,
      policy: "direct-fast-forward",
      notes: [],
      problems: [],
    };
  }
  const protection = response.value ?? {};
  const stronger = [];
  if (protection.required_pull_request_reviews != null) stronger.push("pull-request");
  if (protection.required_status_checks != null) stronger.push("status-checks");
  if (protection.restrictions != null) stronger.push("push-restrictions");
  if (protection.lock_branch?.enabled === true) stronger.push("locked-branch");
  if (protection.required_signatures?.enabled === true) stronger.push("signed-commits");
  return {
    kind: "configured",
    historyProtected:
      protection.allow_force_pushes?.enabled === false
      && protection.allow_deletions?.enabled === false
      && protection.enforce_admins?.enabled === true,
    policy: stronger.length > 0 ? "native-gated" : "direct-fast-forward",
    notes: stronger,
    problems: [],
  };
}

export function evaluateEffectiveRules(response) {
  if (response.kind === "unsupported") {
    return {
      kind: "unsupported",
      historyProtected: false,
      policy: "provider-feature-unavailable",
      notes: [],
      problems: [],
    };
  }
  if (response.kind === "blocked") {
    return {
      kind: "blocked",
      historyProtected: false,
      policy: "unobservable",
      notes: [],
      problems: [response.message || "Efektivní GitHub rulesety nelze ověřit"],
    };
  }
  const rules = Array.isArray(response.value) ? response.value : [];
  const details = response.details ?? {};
  const protectedTypes = new Set();
  for (const rule of rules) {
    if (!HISTORY_RULE_TYPES.has(rule?.type)) continue;
    const detail = details[String(rule.ruleset_id)];
    if (detail?.enforcement === "active" && !Array.isArray(detail.bypass_actors)) {
      return {
        kind: "blocked",
        historyProtected: false,
        policy: "unobservable",
        notes: [],
        problems: [
          `GitHub ruleset ${rule.ruleset_id} skrývá bypass actors; ochranu nelze ověřit`,
        ],
      };
    }
    if (detail?.enforcement === "active" && detail.bypass_actors.length === 0) {
      protectedTypes.add(rule.type);
    }
  }
  const stronger = [
    ...new Set(
      rules
        .map((rule) => rule?.type)
        .filter((type) => typeof type === "string" && !HISTORY_RULE_TYPES.has(type)),
    ),
  ].sort();
  return {
    kind: "configured",
    historyProtected:
      protectedTypes.has("deletion") && protectedTypes.has("non_fast_forward"),
    policy: stronger.length > 0 ? "native-gated" : "direct-fast-forward",
    notes: stronger,
    problems: [],
  };
}

export function evaluateProtection(
  classicResponse,
  effectiveRulesResponse = { kind: "unsupported" },
) {
  const classic = evaluateClassicProtection(classicResponse);
  const rules = evaluateEffectiveRules(effectiveRulesResponse);
  const observationProblems = [...classic.problems, ...rules.problems];
  const historyProtected = classic.historyProtected || rules.historyProtected;
  const policyNotes = [...new Set([...classic.notes, ...rules.notes])];
  const protectionSourceBlocked = classic.kind === "blocked" || rules.kind === "blocked";
  if (protectionSourceBlocked && !historyProtected) {
    return {
      mode: "blocked",
      policy: "unobservable",
      ok: false,
      notes: [],
      problems: observationProblems,
    };
  }
  if (historyProtected) {
    const observationNotes = protectionSourceBlocked
      ? observationProblems.map((problem) => `sekundární zdroj nepozorovatelný: ${problem}`)
      : [];
    return {
      mode: "provider-enforced",
      policy: policyNotes.length > 0 ? "native-gated" : "direct-fast-forward",
      ok: true,
      notes: [...policyNotes, ...observationNotes],
      problems: [],
    };
  }
  const noEffectiveRules =
    effectiveRulesResponse.kind === "configured"
    && Array.isArray(effectiveRulesResponse.value)
    && effectiveRulesResponse.value.length === 0;
  if (
    classic.kind === "unsupported"
    && (rules.kind === "unsupported" || noEffectiveRules)
  ) {
    return {
      mode: "trusted-process",
      policy: "direct-fast-forward",
      ok: true,
      notes: [],
      problems: [],
    };
  }
  const problems = [...observationProblems];
  problems.push(
    "v3 nemá provider ochranu bez bypassu proti force pushi a smazání větve",
  );
  return {
    mode: "capable-unprotected",
    policy: policyNotes.length > 0 ? "native-gated" : "direct-fast-forward",
    ok: false,
    notes: policyNotes,
    problems,
  };
}

export function evaluateTrustedProcessCircle({
  enforcementMode,
  writers,
  unconfirmedMemberships = [],
}) {
  if (enforcementMode !== "trusted-process") return [];
  const problems = [];
  const nonHumanCollaboratorLogins = writers
    .filter((entry) => entry?.type !== "User")
    .map((entry) => entry?.login)
    .filter(Boolean);
  if (nonHumanCollaboratorLogins.length > 0) {
    problems.push(
      `Trusted-process write collaborator musí být lidský Organization member: ${nonHumanCollaboratorLogins.join(", ")}`,
    );
  }
  for (const failure of unconfirmedMemberships) {
    problems.push(
      `Organization membership writera ${failure.login} není potvrzené: ${failure.message}`,
    );
  }
  return problems;
}

export function classifyRepositoryProbe(
  response,
  absenceProof = {
    confirmed: false,
    message: "chybí aktivní Organization Owner proof přihlášeného gh účtu",
  },
) {
  if (response?.ok === true) {
    return { exists: true, error: null };
  }
  const message = providerMessage(response);
  const httpStatus = Number(
    response?.httpStatus ?? response?.value?.status ?? 0,
  ) || null;
  if (httpStatus === 404) {
    if (absenceProof.confirmed) return { exists: false, error: null };
    return {
      exists: null,
      error: `${message}; 404 nepotvrzuje neexistenci privátního repa: ${absenceProof.message}`,
    };
  }
  return { exists: null, error: message };
}

export function bindLiveOrganizationIdentity({
  organization,
  rootRepository,
  dataRepository = null,
}) {
  const problems = [];
  const organizationId = positiveId(organization?.id);
  const rootRepositoryId = positiveId(rootRepository?.id);
  const rootOwnerId = positiveId(rootRepository?.owner?.id);
  const dataRepositoryId = dataRepository ? positiveId(dataRepository?.id) : null;
  const dataOwnerId = dataRepository ? positiveId(dataRepository?.owner?.id) : null;

  if (!organizationId) problems.push("GitHub Organization nemá platné immutable ID");
  if (!rootRepositoryId) problems.push("Organization root repo nemá platné immutable ID");
  if (rootRepository?.owner?.type !== "Organization") {
    problems.push("Organization root repo nevlastní GitHub Organization");
  }
  if (!rootOwnerId || rootOwnerId !== organizationId) {
    problems.push("Organization root repo není svázané s ověřeným GitHub Organization ID");
  }
  if (dataRepository) {
    if (!dataRepositoryId) problems.push("Mission Control data repo nemá platné immutable ID");
    if (dataRepository?.owner?.type !== "Organization") {
      problems.push("Mission Control data repo nevlastní GitHub Organization");
    }
    if (!dataOwnerId || dataOwnerId !== organizationId) {
      problems.push("Mission Control data repo nepatří ověřenému GitHub Organization ID");
    }
  }
  return {
    ok: problems.length === 0,
    organizationId,
    rootRepositoryId,
    dataRepositoryId,
    problems,
  };
}

function parseRepoLocator(value) {
  const text = String(value ?? "").trim().replace(/\.git$/u, "");
  if (GITHUB_REPOSITORY_PATTERN.test(text)) return text;
  return normalizeGitHubRepository(String(value ?? ""));
}

function positiveId(value) {
  const id = String(value ?? "");
  return POSITIVE_ID_PATTERN.test(id) ? id : null;
}

function nonNegativeCount(value) {
  const count = Number(value);
  return Number.isSafeInteger(count) && count >= 0 ? count : null;
}

function providerMessage(response) {
  return response?.value?.message
    ?? response?.error?.message
    ?? response?.stderr
    ?? "GitHub provider selhal";
}

function githubApi(provider, endpoint) {
  return provider.json(["api", endpoint]);
}

function githubPaginatedArray(provider, endpoint) {
  const response = provider.json([
    "api",
    "--paginate",
    "--slurp",
    endpoint,
  ]);
  if (!response.ok) return response;
  const pages = response.value;
  if (!Array.isArray(pages) || !pages.every((page) => Array.isArray(page))) {
    return {
      ok: false,
      status: 1,
      httpStatus: null,
      value: null,
      error: { kind: "invalid_response", message: "GitHub pagination nevrátila pole stránek" },
    };
  }
  return { ...response, value: pages.flat() };
}

function organizationMembership(provider, githubOrg, login) {
  if (
    !GITHUB_LOGIN_PATTERN.test(String(githubOrg ?? ""))
    || !GITHUB_LOGIN_PATTERN.test(String(login ?? ""))
  ) {
    return { kind: "unconfirmed", message: "neplatná GitHub identita" };
  }
  const response = githubApi(provider, `orgs/${githubOrg}/members/${login}`);
  if (response.ok) return { kind: "member" };
  const message = providerMessage(response);
  if (response.httpStatus === 404) {
    return {
      kind: "unconfirmed",
      message:
        "GitHub vrátil 404: writer není Organization member nebo token nemá read:org scope",
    };
  }
  return { kind: "unconfirmed", message };
}

function organizationOwnerProof(provider, organization) {
  const login = String(organization?.login ?? "");
  const id = positiveId(organization?.id);
  if (!id || !GITHUB_LOGIN_PATTERN.test(login)) {
    return { confirmed: false, message: "neplatná živá GitHub Organization identita" };
  }
  const response = githubApi(provider, `user/memberships/orgs/${login}`);
  if (
    response.ok
    && response.value?.state === "active"
    && response.value?.role === "admin"
    && String(response.value?.organization?.id ?? "") === id
  ) {
    return { confirmed: true, message: null };
  }
  if (response.ok) {
    return {
      confirmed: false,
      message: "přihlášený gh účet nemá aktivní Organization Owner roli",
    };
  }
  return {
    confirmed: false,
    message: providerMessage(response),
  };
}

export function organizationOwnerAbsenceProof(provider, organization, coordinate) {
  const liveLogin = String(organization?.login ?? "");
  const organizationId = positiveId(organization?.id);
  const coordinateOwner = String(coordinate ?? "").split("/", 1)[0];
  if (
    !organizationId
    || !GITHUB_LOGIN_PATTERN.test(liveLogin)
    || coordinateOwner.toLowerCase() !== liveLogin.toLowerCase()
  ) {
    return {
      confirmed: false,
      message:
        `repo locator ${coordinate} neleží v ověřené GitHub Organization ${liveLogin}`,
    };
  }
  const ownerProof = organizationOwnerProof(provider, organization);
  if (!ownerProof.confirmed) return ownerProof;

  const publicRepositoryCount = nonNegativeCount(organization?.public_repos);
  const privateRepositoryCount = nonNegativeCount(organization?.total_private_repos);
  if (publicRepositoryCount === null || privateRepositoryCount === null) {
    return {
      confirmed: false,
      message:
        "GitHub Organization metadata neobsahují úplné public/private repo počty",
    };
  }

  const repositories = githubPaginatedArray(
    provider,
    `orgs/${liveLogin}/repos?type=all&per_page=100`,
  );
  if (!repositories.ok) {
    return {
      confirmed: false,
      message: `nelze vyjmenovat Organization repozitáře: ${providerMessage(repositories)}`,
    };
  }

  const seenIds = new Set();
  let targetListed = false;
  for (const repository of repositories.value) {
    const repositoryId = positiveId(repository?.id);
    const ownerId = positiveId(repository?.owner?.id);
    const repositoryCoordinate = String(repository?.full_name ?? "");
    if (
      !repositoryId
      || seenIds.has(repositoryId)
      || repository?.owner?.type !== "Organization"
      || ownerId !== organizationId
      || !GITHUB_REPOSITORY_PATTERN.test(repositoryCoordinate)
    ) {
      return {
        confirmed: false,
        message: "GitHub Organization repo enumeration nemá konzistentní immutable identity",
      };
    }
    seenIds.add(repositoryId);
    if (repositoryCoordinate.toLowerCase() === String(coordinate).toLowerCase()) {
      targetListed = true;
    }
  }

  const expectedRepositoryCount = publicRepositoryCount + privateRepositoryCount;
  if (repositories.value.length !== expectedRepositoryCount) {
    return {
      confirmed: false,
      message:
        `GitHub token neprokázal úplnou viditelnost Organization repozitářů `
        + `(vidí ${repositories.value.length}, Organization hlásí ${expectedRepositoryCount})`,
    };
  }
  if (targetListed) {
    return {
      confirmed: false,
      message: `Organization repo enumeration ${coordinate} obsahuje navzdory přímému 404`,
    };
  }
  return { confirmed: true, message: null };
}

export function missionControlDataPrivacyProblem(repository) {
  return repository?.private === true
    ? null
    : "Mission Control data repo musí být privátní";
}

function branchProtection(provider, repo, branch) {
  const response = githubApi(
    provider,
    `repos/${repo}/branches/${encodeURIComponent(branch)}/protection`,
  );
  if (response.ok) return { kind: "configured", value: response.value };
  const message = providerMessage(response);
  if (response.httpStatus === 404) return { kind: "unconfigured", message };
  if (
    /upgrade to github (?:pro|team)|enable this feature|only available for .*repositor/iu.test(
      message,
    )
  ) {
    return { kind: "unsupported", message };
  }
  return { kind: "blocked", message };
}

function effectiveBranchRules(provider, repo, branch) {
  const response = githubApi(
    provider,
    `repos/${repo}/rules/branches/${encodeURIComponent(branch)}`,
  );
  if (response.ok && Array.isArray(response.value)) {
    const details = {};
    const historyRules = response.value.filter((rule) =>
      HISTORY_RULE_TYPES.has(rule?.type)
    );
    for (const rule of historyRules) {
      const id = Number(rule?.ruleset_id);
      if (!Number.isSafeInteger(id) || details[String(id)]) continue;
      let endpoint = null;
      if (
        rule?.ruleset_source_type === "Repository"
        && GITHUB_REPOSITORY_PATTERN.test(String(rule?.ruleset_source ?? ""))
      ) {
        endpoint = `repos/${rule.ruleset_source}/rulesets/${id}`;
      } else if (
        rule?.ruleset_source_type === "Organization"
        && GITHUB_LOGIN_PATTERN.test(String(rule?.ruleset_source ?? ""))
      ) {
        endpoint = `orgs/${rule.ruleset_source}/rulesets/${id}`;
      }
      if (!endpoint) {
        return {
          kind: "blocked",
          message: `Nelze určit authority efektivního GitHub rulesetu ${id}`,
        };
      }
      const detail = githubApi(provider, endpoint);
      if (!detail.ok) {
        return {
          kind: "blocked",
          message: providerMessage(detail)
            || `Nelze přečíst efektivní GitHub ruleset ${id}`,
        };
      }
      details[String(id)] = detail.value;
    }
    return { kind: "configured", value: response.value, details };
  }
  const message = providerMessage(response);
  if (
    /upgrade to github (?:pro|team)|enable this feature|only available for .*repositor/iu.test(
      message,
    )
  ) {
    return { kind: "unsupported", message };
  }
  return { kind: "blocked", message };
}

function createTrustedGitReader({
  platform = process.platform,
  environment = process.env,
  resolveExecutable = resolveTrustedGitExecutable,
  runCommand = runTrustedGitCommandSync,
} = {}) {
  const executable = resolveExecutable({ platform, environment });
  return {
    available: Boolean(executable),
    text(cwd, args) {
      if (!executable) return { ok: false, value: "", message: "Git nebyl nalezen" };
      const result = runCommand({ executable, cwd, args, environment });
      return {
        ok: result?.status === 0,
        value: String(result?.stdout ?? "").trim(),
        message: String(result?.stderr ?? "").trim(),
      };
    },
  };
}

export function checkoutRepositoryCoordinate(root, gitReader) {
  let canonicalRoot;
  try {
    canonicalRoot = realpathSync.native(resolve(root));
  } catch {
    return null;
  }
  const topLevel = gitReader.text(root, ["rev-parse", "--show-toplevel"]);
  let canonicalTopLevel;
  try {
    canonicalTopLevel = topLevel.ok
      ? realpathSync.native(resolve(topLevel.value))
      : null;
  } catch {
    return null;
  }
  if (
    canonicalTopLevel === null
    || normalizeComparableCliPath(canonicalTopLevel)
      !== normalizeComparableCliPath(canonicalRoot)
  ) {
    return null;
  }
  const result = gitReader.text(root, ["config", "--get", "remote.origin.url"]);
  return result.ok ? normalizeGitHubRepository(result.value) : null;
}

function liveRootBinding(organizationRoot, provider, gitReader) {
  const coordinate = checkoutRepositoryCoordinate(organizationRoot, gitReader);
  if (!coordinate) {
    return { errors: ["Organization root nemá ověřitelný GitHub origin"], coordinate: null };
  }
  const repository = githubApi(provider, `repos/${coordinate}`);
  if (!repository.ok) {
    return {
      errors: [`Organization root repo ${coordinate} nelze živě ověřit: ${providerMessage(repository)}`],
      coordinate,
    };
  }
  const organizationId = positiveId(repository.value?.owner?.id);
  if (!organizationId) {
    return { errors: ["Organization root repo nemá platné owner ID"], coordinate };
  }
  const organization = githubApi(provider, `organizations/${organizationId}`);
  if (!organization.ok) {
    return {
      errors: [`GitHub Organization ID ${organizationId} nelze živě ověřit: ${providerMessage(organization)}`],
      coordinate,
    };
  }
  const identity = bindLiveOrganizationIdentity({
    organization: organization.value,
    rootRepository: repository.value,
  });
  return {
    errors: identity.problems,
    coordinate,
    repository: repository.value,
    organization: organization.value,
    identity,
  };
}

function inspectOrganization(organizationRoot, { provider, gitReader, resolution }) {
  const resource = resolution.resource;
  const dataSlot = slotsOf(resource.repository_inventory).find((slot) => slot?.path === "mission-control/db");
  const declaredGithubOrg = resource.organization?.forge_binding?.locator;
  const result = {
    organization: basename(organizationRoot),
    github_org: declaredGithubOrg ?? null,
    github_organization_id: null,
    root_repository_id: null,
    data_repo: null,
    data_repository_id: null,
    data_state: "invalid",
    enforcement_mode: null,
    publication_policy: null,
    writers: null,
    errors: [],
    notes: [],
  };

  if (!provider.available) result.errors.push("Trusted GitHub provider není dostupný");
  if (!gitReader.available) result.errors.push("Trusted Git reader není dostupný");
  if (result.errors.length > 0) return result;

  const rootBinding = liveRootBinding(organizationRoot, provider, gitReader);
  result.errors.push(...rootBinding.errors);
  if (!rootBinding.identity?.ok) return result;
  result.github_org = rootBinding.organization.login;
  result.github_organization_id = rootBinding.identity.organizationId;
  result.root_repository_id = rootBinding.identity.rootRepositoryId;
  if (
    typeof declaredGithubOrg === "string"
    && declaredGithubOrg.toLowerCase() !== String(rootBinding.organization.login).toLowerCase()
  ) {
    result.notes.push(
      `Deklarovaný GitHub locator ${declaredGithubOrg} se přes immutable root binding přeložil na ${rootBinding.organization.login}`,
    );
  }

  const dataLocator = resolveDataRepositoryLocator(
    dataSlot,
    rootBinding.organization.login,
  );
  if (dataLocator.error) {
    result.data_state = classifyDataState(dataSlot, false);
    result.errors.push(dataLocator.error);
    return result;
  }
  const dataRepo = dataLocator.coordinate;
  result.data_repo = dataRepo;
  if (!dataRepo) {
    result.data_state = classifyDataState(dataSlot, false);
    result.errors.push("Mission Control data slot chybí");
    return result;
  }

  const repositoryResponse = githubApi(provider, `repos/${dataRepo}`);
  const absenceProof = repositoryResponse.httpStatus === 404
    ? organizationOwnerAbsenceProof(
        provider,
        rootBinding.organization,
        dataRepo,
      )
    : undefined;
  const repositoryProbe = classifyRepositoryProbe(repositoryResponse, absenceProof);
  const repositoryExists = repositoryProbe.exists === true;
  result.data_state = classifyDataState(dataSlot, repositoryExists);
  if (repositoryProbe.error) {
    result.errors.push(
      `Nelze ověřit existenci Mission Control data repa ${dataRepo}: ${repositoryProbe.error}`,
    );
  }
  if (["missing-slot", "incomplete"].includes(result.data_state)) {
    result.errors.push(`Mission Control data stav je ${result.data_state}`);
  }
  if (result.data_state === "staged") {
    result.notes.push(
      "Data repo existuje, ale slot zůstává vědomě staged/planned; writer nesmí publikovat",
    );
  }
  if (!repositoryExists) return result;

  const identity = bindLiveOrganizationIdentity({
    organization: rootBinding.organization,
    rootRepository: rootBinding.repository,
    dataRepository: repositoryResponse.value,
  });
  result.errors.push(...identity.problems);
  result.data_repository_id = identity.dataRepositoryId;
  if (!identity.ok) return result;
  const privacyProblem = missionControlDataPrivacyProblem(repositoryResponse.value);
  if (privacyProblem) {
    result.errors.push(privacyProblem);
    return result;
  }
  const liveDataRepo = String(repositoryResponse.value?.full_name ?? dataRepo);
  result.data_repo = liveDataRepo;

  const dataCheckout = join(organizationRoot, "mission-control", "db");
  if (existsSync(dataCheckout)) {
    const mountedCoordinate = checkoutRepositoryCoordinate(dataCheckout, gitReader);
    if (!mountedCoordinate) {
      result.errors.push("Lokální Mission Control data mount nemá ověřitelný GitHub origin");
    } else {
      const mountedRepository = githubApi(provider, `repos/${mountedCoordinate}`);
      if (
        !mountedRepository.ok
        || String(mountedRepository.value?.id ?? "") !== identity.dataRepositoryId
      ) {
        result.errors.push(
          "Lokální Mission Control data mount není svázaný se stejným immutable repository ID",
        );
      }
    }
  }
  if (result.data_state !== "active") return result;

  const publishBranch = resolveDataPublishBranch(dataSlot, repositoryResponse.value);
  if (publishBranch.error) {
    result.errors.push(publishBranch.error);
    return result;
  }

  const protection = evaluateProtection(
    branchProtection(provider, liveDataRepo, publishBranch.branch),
    effectiveBranchRules(provider, liveDataRepo, publishBranch.branch),
  );
  result.enforcement_mode = protection.mode;
  result.publication_policy = protection.policy;
  result.errors.push(...protection.problems);
  if (protection.notes.length > 0) {
    result.notes.push(
      `GitHub branch policy poznámky: ${protection.notes.join(", ")}`,
    );
  }

  const collaborators = githubPaginatedArray(
    provider,
    `repos/${liveDataRepo}/collaborators?affiliation=all&per_page=100`,
  );
  if (!collaborators.ok || !Array.isArray(collaborators.value)) {
    result.errors.push(
      `Nelze ověřit živý GitHub write okruh data repa: ${providerMessage(collaborators)}`,
    );
    return result;
  }
  const writers = collaborators.value.filter(
    (entry) =>
      entry?.permissions?.push
      || entry?.permissions?.maintain
      || entry?.permissions?.admin,
  );
  result.writers = writers.length;
  if (protection.mode === "trusted-process") {
    const unconfirmedMemberships = [];
    for (const writer of writers.filter((entry) => entry?.type === "User")) {
      const membership = organizationMembership(
        provider,
        rootBinding.organization.login,
        writer.login,
      );
      if (membership.kind === "unconfirmed") {
        unconfirmedMemberships.push({ login: writer.login, message: membership.message });
      }
    }
    result.errors.push(
      ...evaluateTrustedProcessCircle({
        enforcementMode: protection.mode,
        writers,
        unconfirmedMemberships,
      }),
    );
    result.notes.push(
      "Writer count vychází z GitHub collaborators API; deploy keys, GitHub Apps a workflow tokeny zůstávají v Organization Admin credential inventáři mimo root audit",
    );
  }
  return result;
}

function failedOrganizationResult(organizationRoot, error) {
  return {
    organization: basename(organizationRoot),
    github_org: null,
    github_organization_id: null,
    root_repository_id: null,
    data_repo: null,
    data_repository_id: null,
    data_state: "invalid",
    enforcement_mode: null,
    publication_policy: null,
    writers: null,
    errors: [error instanceof Error ? error.message : String(error)],
    notes: [],
  };
}

export function defaultWorkspaceRoot({
  gitReader = createTrustedGitReader(),
} = {}) {
  const scriptRoot = fileURLToPath(new URL("../", import.meta.url));
  const result = gitReader.text(scriptRoot, ["worktree", "list", "--porcelain", "-z"]);
  const primary = result.value
    ?.split("\0")
    .find((entry) => entry.startsWith("worktree "))
    ?.slice("worktree ".length);
  return result.ok && primary ? resolve(primary) : resolve(scriptRoot);
}

function parseArgs(argv) {
  const args = { json: false, workspaceRoot: defaultWorkspaceRoot() };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--json") args.json = true;
    else if (argv[index] === "--workspace-root") {
      const value = argv[++index];
      if (!value) throw new Error("--workspace-root vyžaduje přesnou cestu");
      args.workspaceRoot = resolve(value);
    } else throw new Error(`Neznámý argument: ${argv[index]}`);
  }
  return args;
}

export function runSmoke(
  workspaceRoot,
  {
    provider = createTrustedGitHubProvider({ cwd: workspaceRoot }),
    gitReader = createTrustedGitReader(),
  } = {},
) {
  const organizationsRoot = join(workspaceRoot, "organizations");
  if (!existsSync(organizationsRoot)) {
    throw new Error(`Chybí Lazurio organizations mountpoint: ${organizationsRoot}`);
  }
  const candidates = readdirSync(organizationsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(organizationsRoot, entry.name))
    .sort();
  const results = [];
  for (const root of candidates) {
    let resolution;
    try {
      resolution = readOrganizationRoot({ organizationRoot: root });
    } catch (error) {
      results.push(failedOrganizationResult(root, error));
      continue;
    }
    if (resolution.state === "missing") continue;
    if (
      resolution.state === "conflict"
      || resolution.resource_count !== 1
    ) {
      results.push(failedOrganizationResult(
        root,
        new Error(`Organization manifest nejde bezpečně normalizovat (${resolution.state}; ${resolution.issues.join(", ")})`),
      ));
      continue;
    }
    if (resolution.resource.kind === "template") continue;
    try {
      results.push(inspectOrganization(root, { provider, gitReader, resolution }));
    } catch (error) {
      results.push(failedOrganizationResult(root, error));
    }
  }
  if (results.length === 0) {
    throw new Error(
      `Mission Control trust smoke odmítá false-green běh bez Organizací: ${organizationsRoot}`,
    );
  }
  return results;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const results = runSmoke(args.workspaceRoot);
  const failed = results.filter((result) => result.errors.length > 0);
  if (args.json) {
    console.log(JSON.stringify({ ok: failed.length === 0, organizations: results }, null, 2));
  } else {
    for (const result of results) {
      const status = result.errors.length > 0
        ? "FAIL"
        : result.data_state === "staged" ? "STAGED" : "PASS";
      console.log(
        `${status} ${result.organization}: data=${result.data_state}, enforcement=${result.enforcement_mode ?? "n/a"}, policy=${result.publication_policy ?? "n/a"}, writers=${result.writers ?? "n/a"}`,
      );
      for (const note of result.notes) console.log(`  note: ${note}`);
      for (const problem of result.errors) console.log(`  error: ${problem}`);
    }
    console.log(
      `Mission Control trust smoke: ${failed.length === 0 ? "PASS" : "FAIL"} (${results.length} Organizations)`,
    );
  }
  if (failed.length > 0) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(
      `Mission Control trust smoke: FAIL (${error instanceof Error ? error.message : String(error)})`,
    );
    process.exitCode = 1;
  }
}
