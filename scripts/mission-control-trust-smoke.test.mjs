import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";

import {
  bindLiveOrganizationIdentity,
  classifyDataState,
  classifyRepositoryProbe,
  checkoutRepositoryCoordinate,
  evaluateEffectiveRules,
  evaluateProtection,
  evaluateTrustedProcessCircle,
  missionControlDataPrivacyProblem,
  organizationOwnerAbsenceProof,
  resolveDataPublishBranch,
  resolveDataRepositoryLocator,
  runSmoke,
} from "./mission-control-trust-smoke.mjs";

test("classifies active, planned and deliberately staged repositories separately", () => {
  expect(classifyDataState({ status: "active" }, true)).toBe("active");
  expect(classifyDataState({ status: "planned_slot" }, false)).toBe("planned");
  expect(classifyDataState({ status: "planned_slot" }, true)).toBe("staged");
  expect(classifyDataState({ materialization: "unplanned" }, false)).toBe("incomplete");
  expect(classifyDataState(undefined, true)).toBe("incomplete");
});

test("planned slots use the standard repo name only as a locator", () => {
  expect(
    resolveDataRepositoryLocator(
      { path: "mission-control/db", status: "planned_slot" },
      "Renamed-Org",
    ),
  ).toEqual({
    coordinate: "Renamed-Org/mission-control-data",
    error: null,
  });
  expect(
    resolveDataRepositoryLocator(
      {
        git: { url: "git@github.com:Other-Org/mission-control-data.git" },
      },
      "Renamed-Org",
    ).coordinate,
  ).toBe("Other-Org/mission-control-data");
  expect(
    resolveDataRepositoryLocator(
      { git: { url: "not a repository" } },
      "Renamed-Org",
    ).error,
  ).toContain("neplatný");
  for (const url of [
    "git@corp-github.com:Old-Org/mission-control-data.git",
    "https://mirror-notgithub.com/Old-Org/mission-control-data",
    "https://gitlab.example/x/github.com/Old-Org/mission-control-data",
    "Old-Org/.",
    "Old-Org/..",
  ]) {
    expect(
      resolveDataRepositoryLocator(
        { git: { url } },
        "Renamed-Org",
      ).error,
    ).toContain("neplatný");
  }
});

test("active Mission Control data binds the declared canonical v3 publish branch", () => {
  const slot = { git: { branch: "v3" } };
  expect(resolveDataPublishBranch(slot, { default_branch: "v3" })).toEqual({
    branch: "v3",
    error: null,
  });
  expect(
    resolveDataPublishBranch({}, { default_branch: "v3" }).error,
  ).toContain("git.branch");
  expect(
    resolveDataPublishBranch(
      { git: { branch: "main" } },
      { default_branch: "main" },
    ).error,
  ).toContain("musí být v3");
  expect(resolveDataPublishBranch(slot, { default_branch: "main" }).error).toContain(
    "default branch main",
  );
});

test("repository origin is anchored to the exact Organization checkout", () => {
  const calls = [];
  const root = mkdtempSync(join(tmpdir(), "mc-root-anchor-"));
  try {
    const gitReader = {
      text(cwd, args) {
        calls.push({ cwd, args });
        if (args[0] === "rev-parse") {
          return { ok: true, value: join(root, "nested") };
        }
        return { ok: true, value: "git@github.com:Wrong/Root.git" };
      },
    };
    expect(checkoutRepositoryCoordinate(root, gitReader)).toBeNull();
    expect(calls).toEqual([
      { cwd: root, args: ["rev-parse", "--show-toplevel"] },
    ]);

    gitReader.text = (_cwd, args) => args[0] === "rev-parse"
      ? { ok: true, value: root }
      : { ok: true, value: "git@github.com:Example/Root.git" };
    expect(checkoutRepositoryCoordinate(root, gitReader)).toBe("Example/Root");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("accepts provider enforcement that preserves direct fast-forward pushes", () => {
  const result = evaluateProtection({
    kind: "configured",
    value: {
      allow_force_pushes: { enabled: false },
      allow_deletions: { enabled: false },
      enforce_admins: { enabled: true },
      required_pull_request_reviews: null,
      required_status_checks: null,
      restrictions: null,
      lock_branch: { enabled: false },
      required_signatures: { enabled: false },
    },
  });
  expect(result).toMatchObject({
    mode: "provider-enforced",
    policy: "direct-fast-forward",
    ok: true,
    problems: [],
  });
});

test("accepts stronger native GitHub policy and classifies it without prescribing friction", () => {
  for (const [field, value, note] of [
    ["required_pull_request_reviews", {}, "pull-request"],
    ["required_status_checks", {}, "status-checks"],
    ["restrictions", { users: [] }, "push-restrictions"],
    ["lock_branch", { enabled: true }, "locked-branch"],
    ["required_signatures", { enabled: true }, "signed-commits"],
  ]) {
    const result = evaluateProtection({
      kind: "configured",
      value: {
        allow_force_pushes: { enabled: false },
        allow_deletions: { enabled: false },
        enforce_admins: { enabled: true },
        required_pull_request_reviews: null,
        required_status_checks: null,
        restrictions: null,
        lock_branch: { enabled: false },
        required_signatures: { enabled: false },
        [field]: value,
      },
    });
    expect(result.ok).toBe(true);
    expect(result.policy).toBe("native-gated");
    expect(result.notes).toContain(note);
  }

  const rules = evaluateEffectiveRules({
    kind: "configured",
    value: [
      { type: "non_fast_forward", ruleset_id: 7 },
      { type: "deletion", ruleset_id: 7 },
      { type: "pull_request", ruleset_id: 7 },
      { type: "required_status_checks", ruleset_id: 7 },
    ],
    details: { 7: { enforcement: "active", bypass_actors: [] } },
  });
  expect(rules).toMatchObject({
    historyProtected: true,
    policy: "native-gated",
    problems: [],
  });
  expect(rules.notes).toEqual(["pull_request", "required_status_checks"]);
});

test("accepts native rulesets only when both history rules have no bypass", () => {
  const classic = { kind: "unconfigured" };
  const rules = {
    kind: "configured",
    value: [
      { type: "non_fast_forward", ruleset_id: 9 },
      { type: "deletion", ruleset_id: 9 },
    ],
    details: { 9: { enforcement: "active", bypass_actors: [] } },
  };
  expect(evaluateProtection(classic, rules)).toMatchObject({
    mode: "provider-enforced",
    ok: true,
  });
  rules.details[9].bypass_actors = [{ actor_type: "RepositoryRole" }];
  expect(evaluateProtection(classic, rules)).toMatchObject({
    mode: "capable-unprotected",
    ok: false,
  });

  rules.details[9] = { enforcement: "active" };
  expect(evaluateEffectiveRules(rules)).toMatchObject({
    kind: "blocked",
    policy: "unobservable",
    problems: [expect.stringContaining("skrývá bypass actors")],
  });
});

test("one proven history-protection source is sufficient when the other is unreadable", () => {
  const protectedClassic = {
    kind: "configured",
    value: {
      allow_force_pushes: { enabled: false },
      allow_deletions: { enabled: false },
      enforce_admins: { enabled: true },
    },
  };
  expect(
    evaluateProtection(protectedClassic, {
      kind: "blocked",
      message: "Organization ruleset detail is forbidden",
    }),
  ).toMatchObject({
    mode: "provider-enforced",
    ok: true,
    problems: [],
    notes: [expect.stringContaining("sekundární zdroj nepozorovatelný")],
  });
  expect(
    evaluateProtection(
      { kind: "unconfigured" },
      { kind: "blocked", message: "Ruleset detail is forbidden" },
    ),
  ).toMatchObject({
    mode: "blocked",
    ok: false,
    problems: ["Ruleset detail is forbidden"],
  });
});

test("treats an unavailable private-branch feature as trusted-process, not as an access grant", () => {
  expect(evaluateProtection({ kind: "unsupported" })).toMatchObject({
    mode: "trusted-process",
    policy: "direct-fast-forward",
    ok: true,
  });
  expect(
    evaluateProtection(
      { kind: "unsupported" },
      { kind: "configured", value: [], details: {} },
    ),
  ).toMatchObject({ mode: "trusted-process", ok: true });
  expect(evaluateProtection({ kind: "unconfigured" }).ok).toBe(false);
  expect(evaluateProtection({ kind: "blocked", message: "forbidden" }).mode).toBe("blocked");
});

test("trusted-process gates only direct non-human collaborators and unconfirmed membership", () => {
  const writers = Array.from({ length: 20 }, (_, index) => ({
    login: `builder-${index}`,
    type: "User",
  }));
  expect(evaluateTrustedProcessCircle({ enforcementMode: "trusted-process", writers })).toEqual([]);
  expect(
    evaluateTrustedProcessCircle({
      enforcementMode: "trusted-process",
      writers: [{ login: "writer-bot", type: "Bot" }],
    }).join(" "),
  ).toContain("write collaborator musí být lidský Organization member");
  expect(
    evaluateTrustedProcessCircle({
      enforcementMode: "trusted-process",
      writers,
      unconfirmedMemberships: [
        { login: "unconfirmed-builder", message: "GitHub vrátil 404" },
      ],
    }).join(" "),
  ).toContain("membership writera unconfirmed-builder není potvrzené");
  expect(
    evaluateTrustedProcessCircle({
      enforcementMode: "provider-enforced",
      writers,
      unconfirmedMemberships: [
        { login: "unconfirmed-builder", message: "GitHub vrátil 404" },
      ],
    }),
  ).toEqual([]);
});

test("repository probe requires immutable Owner proof before 404 means absent", () => {
  expect(classifyRepositoryProbe({ ok: true, value: {} })).toEqual({
    exists: true,
    error: null,
  });
  expect(
    classifyRepositoryProbe({
      ok: false,
      status: 0,
      value: null,
      error: { message: "GitHub provider nevrátil validní JSON." },
    }),
  ).toEqual({
    exists: null,
    error: "GitHub provider nevrátil validní JSON.",
  });
  expect(
    classifyRepositoryProbe({
      ok: false,
      httpStatus: 404,
      value: { message: "Not Found" },
    }),
  ).toMatchObject({ exists: null });
  expect(
    classifyRepositoryProbe(
      { ok: false, httpStatus: 404, value: { message: "Not Found" } },
      { confirmed: true, message: null },
    ),
  ).toEqual({ exists: false, error: null });
  expect(
    classifyRepositoryProbe({
      ok: false,
      httpStatus: 403,
      value: { message: "Forbidden" },
    }),
  ).toEqual({ exists: null, error: "Forbidden" });
});

function ownerAbsenceProvider(repositories, { role = "admin" } = {}) {
  const provider = {
    calls: [],
    json(args) {
      this.calls.push(args);
      if (String(args.at(-1)).startsWith("user/memberships/orgs/")) {
        return {
          ok: true,
          value: {
            state: "active",
            role,
            organization: { id: 42 },
          },
        };
      }
      return {
        ok: true,
        value: [repositories],
      };
    },
  };
  return provider;
}

test("404 absence proof requires a complete repository view from the verified Owner", () => {
  const repositories = [
    {
      id: 100,
      full_name: "Verified-Org/root",
      owner: { id: 42, type: "Organization" },
      visibility: "public",
    },
    {
      id: 101,
      full_name: "Verified-Org/another-private-repo",
      owner: { id: 42, type: "Organization" },
      visibility: "private",
    },
  ];
  const provider = ownerAbsenceProvider(repositories);
  const organization = {
    id: 42,
    login: "Verified-Org",
    public_repos: 1,
    total_private_repos: 1,
  };
  expect(
    organizationOwnerAbsenceProof(
      provider,
      organization,
      "Other-Org/mission-control-data",
    ),
  ).toMatchObject({ confirmed: false });
  expect(provider.calls).toHaveLength(0);
  expect(
    organizationOwnerAbsenceProof(
      provider,
      organization,
      "verified-org/mission-control-data",
    ),
  ).toEqual({ confirmed: true, message: null });
  expect(provider.calls).toHaveLength(2);
});

test("404 absence proof fails closed for scoped, incomplete or contradictory views", () => {
  const organization = {
    id: 42,
    login: "Verified-Org",
    public_repos: 0,
    total_private_repos: 2,
  };
  const visiblePrivate = {
    id: 101,
    full_name: "Verified-Org/visible-private",
    owner: { id: 42, type: "Organization" },
    visibility: "private",
  };
  const memberProvider = ownerAbsenceProvider([visiblePrivate], { role: "member" });
  expect(
    organizationOwnerAbsenceProof(
      memberProvider,
      organization,
      "Verified-Org/mission-control-data",
    ),
  ).toEqual({
    confirmed: false,
    message: "přihlášený gh účet nemá aktivní Organization Owner roli",
  });

  const scopedProvider = ownerAbsenceProvider([visiblePrivate]);
  expect(
    organizationOwnerAbsenceProof(
      scopedProvider,
      organization,
      "Verified-Org/mission-control-data",
    ),
  ).toMatchObject({
    confirmed: false,
    message: expect.stringContaining("neprokázal úplnou viditelnost"),
  });

  const targetProvider = ownerAbsenceProvider([
    {
      ...visiblePrivate,
      full_name: "Verified-Org/mission-control-data",
    },
  ]);
  expect(
    organizationOwnerAbsenceProof(
      targetProvider,
      { ...organization, total_private_repos: 1 },
      "Verified-Org/mission-control-data",
    ),
  ).toMatchObject({
    confirmed: false,
    message: expect.stringContaining("obsahuje navzdory přímému 404"),
  });

  const missingCountsProvider = ownerAbsenceProvider([]);
  expect(
    organizationOwnerAbsenceProof(
      missingCountsProvider,
      { id: 42, login: "Verified-Org" },
      "Verified-Org/mission-control-data",
    ),
  ).toMatchObject({
    confirmed: false,
    message: expect.stringContaining("neobsahují úplné"),
  });
});

test("Mission Control data repository visibility fails closed", () => {
  expect(missionControlDataPrivacyProblem({ private: true })).toBeNull();
  expect(missionControlDataPrivacyProblem({ private: false })).toContain("privátní");
  expect(missionControlDataPrivacyProblem({})).toContain("privátní");
});

test("live identity binding joins root and data repositories through immutable IDs", () => {
  const organization = { id: 42, login: "Renamed-Org" };
  const rootRepository = {
    id: 100,
    full_name: "Renamed-Org/Root",
    owner: { id: 42, type: "Organization" },
  };
  const dataRepository = {
    id: 200,
    full_name: "Renamed-Org/mission-control-data",
    owner: { id: 42, type: "Organization" },
  };
  expect(
    bindLiveOrganizationIdentity({ organization, rootRepository, dataRepository }),
  ).toEqual({
    ok: true,
    organizationId: "42",
    rootRepositoryId: "100",
    dataRepositoryId: "200",
    problems: [],
  });
  expect(
    bindLiveOrganizationIdentity({
      organization,
      rootRepository,
      dataRepository: {
        ...dataRepository,
        owner: { id: 84, type: "Organization" },
      },
    }).problems.join(" "),
  ).toContain("nepatří ověřenému GitHub Organization ID");
});

test("live smoke fails closed instead of passing an empty checkout", () => {
  const root = mkdtempSync(join(tmpdir(), "mc-empty-smoke-"));
  try {
    mkdirSync(join(root, "organizations"));
    expect(() => runSmoke(root)).toThrow("odmítá false-green běh bez Organizací");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function smokeFixture(
  root,
  {
    dataResponse,
    totalPrivateRepos,
    slot = { path: "mission-control/db", status: "planned_slot" },
    extraResponses = {},
  },
) {
  const organizationRoot = join(root, "organizations", "Verified_GEN3");
  mkdirSync(organizationRoot, { recursive: true });
  writeFileSync(
    join(organizationRoot, "company.gen3.json"),
    `${JSON.stringify({ company: { github_org: "Verified-Org" } }, null, 2)}\n`,
  );
  writeFileSync(
    join(organizationRoot, "modules.manifest.json"),
    `${JSON.stringify({ modules: [slot] }, null, 2)}\n`,
  );
  const rootRepository = {
    id: 100,
    full_name: "Verified-Org/Root",
    private: true,
    visibility: "private",
    owner: { id: 42, type: "Organization" },
  };
  const calls = [];
  const provider = {
    available: true,
    json(args) {
      const endpoint = String(args.at(-1));
      calls.push(endpoint);
      if (Object.prototype.hasOwnProperty.call(extraResponses, endpoint)) {
        return extraResponses[endpoint];
      }
      if (endpoint === "repos/Verified-Org/Root") {
        return { ok: true, value: rootRepository };
      }
      if (endpoint === "organizations/42") {
        return {
          ok: true,
          value: {
            id: 42,
            login: "Verified-Org",
            public_repos: 0,
            total_private_repos: totalPrivateRepos,
          },
        };
      }
      if (endpoint === "repos/Verified-Org/mission-control-data") {
        return dataResponse;
      }
      if (endpoint === "user/memberships/orgs/Verified-Org") {
        return {
          ok: true,
          value: {
            state: "active",
            role: "admin",
            organization: { id: 42 },
          },
        };
      }
      if (endpoint === "orgs/Verified-Org/repos?type=all&per_page=100") {
        return { ok: true, value: [[rootRepository]] };
      }
      throw new Error(`Unexpected GitHub endpoint: ${endpoint}`);
    },
  };
  const gitReader = {
    available: true,
    text(cwd, args) {
      if (args[0] === "rev-parse") return { ok: true, value: cwd };
      return { ok: true, value: "git@github.com:Verified-Org/Root.git" };
    },
  };
  return { calls, gitReader, provider };
}

test("runSmoke accepts a private-repo 404 only through complete Owner visibility proof", () => {
  for (const scenario of [
    { totalPrivateRepos: 1, expectedErrors: 0 },
    { totalPrivateRepos: 2, expectedErrors: 1 },
  ]) {
    const root = mkdtempSync(join(tmpdir(), "mc-planned-smoke-"));
    try {
      const fixture = smokeFixture(root, {
        dataResponse: {
          ok: false,
          httpStatus: 404,
          value: { message: "Not Found" },
        },
        totalPrivateRepos: scenario.totalPrivateRepos,
      });
      const [result] = runSmoke(root, fixture);
      expect(result.data_state).toBe("planned");
      expect(result.errors).toHaveLength(scenario.expectedErrors);
      expect(fixture.calls).toContain("user/memberships/orgs/Verified-Org");
      expect(fixture.calls).toContain(
        "orgs/Verified-Org/repos?type=all&per_page=100",
      );
      if (scenario.expectedErrors > 0) {
        expect(result.errors.join(" ")).toContain("neprokázal úplnou viditelnost");
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  const forbiddenRoot = mkdtempSync(join(tmpdir(), "mc-forbidden-smoke-"));
  try {
    const fixture = smokeFixture(forbiddenRoot, {
      dataResponse: {
        ok: false,
        httpStatus: 403,
        value: { message: "Forbidden" },
      },
      totalPrivateRepos: 1,
    });
    const [result] = runSmoke(forbiddenRoot, fixture);
    expect(result.errors.join(" ")).toContain("Forbidden");
    expect(fixture.calls).not.toContain("user/memberships/orgs/Verified-Org");
  } finally {
    rmSync(forbiddenRoot, { recursive: true, force: true });
  }

  const stagedRoot = mkdtempSync(join(tmpdir(), "mc-staged-smoke-"));
  try {
    const fixture = smokeFixture(stagedRoot, {
      dataResponse: {
        ok: true,
        value: {
          id: 200,
          full_name: "Verified-Org/mission-control-data",
          private: true,
          owner: { id: 42, type: "Organization" },
        },
      },
      totalPrivateRepos: 2,
    });
    const [result] = runSmoke(stagedRoot, fixture);
    expect(result.data_state).toBe("staged");
    expect(result.errors).toHaveLength(0);
    expect(fixture.calls.some((endpoint) => endpoint.includes("/branches/"))).toBeFalse();
    expect(fixture.calls.some((endpoint) => endpoint.includes("/rules/branches/"))).toBeFalse();
  } finally {
    rmSync(stagedRoot, { recursive: true, force: true });
  }
});

test("runSmoke drives the active v3 trusted-process enforcement path end to end", () => {
  const root = mkdtempSync(join(tmpdir(), "mc-active-smoke-"));
  const dataRepository = {
    id: 200,
    full_name: "Verified-Org/mission-control-data",
    default_branch: "v3",
    private: true,
    owner: { id: 42, type: "Organization" },
  };
  try {
    const fixture = smokeFixture(root, {
      dataResponse: { ok: true, value: dataRepository },
      totalPrivateRepos: 2,
      slot: {
        path: "mission-control/db",
        space: "root",
        status: "active",
        git: {
          url: "git@github.com:Verified-Org/mission-control-data.git",
          branch: "v3",
        },
      },
      extraResponses: {
        "repos/Verified-Org/mission-control-data/branches/v3/protection": {
          ok: false,
          httpStatus: 403,
          value: { message: "Upgrade to GitHub Pro to use branch protection" },
        },
        "repos/Verified-Org/mission-control-data/rules/branches/v3": {
          ok: true,
          value: [],
        },
        "repos/Verified-Org/mission-control-data/collaborators?affiliation=all&per_page=100": {
          ok: true,
          value: [[
            {
              login: "trusted-builder",
              type: "User",
              permissions: { push: true },
            },
            {
              login: "read-only-user",
              type: "User",
              permissions: { pull: true },
            },
          ]],
        },
        "orgs/Verified-Org/members/trusted-builder": {
          ok: true,
          value: {},
        },
      },
    });
    const [result] = runSmoke(root, fixture);
    expect(result).toMatchObject({
      data_state: "active",
      enforcement_mode: "trusted-process",
      publication_policy: "direct-fast-forward",
      writers: 1,
      errors: [],
    });
    expect(fixture.calls).toContain(
      "repos/Verified-Org/mission-control-data/branches/v3/protection",
    );
    expect(fixture.calls).toContain(
      "repos/Verified-Org/mission-control-data/rules/branches/v3",
    );
    expect(fixture.calls).toContain(
      "repos/Verified-Org/mission-control-data/collaborators?affiliation=all&per_page=100",
    );
    expect(fixture.calls).toContain("orgs/Verified-Org/members/trusted-builder");
    expect(fixture.calls).not.toContain("orgs/Verified-Org/members/read-only-user");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("one malformed Organization is reported with its path instead of aborting the audit", () => {
  const root = mkdtempSync(join(tmpdir(), "mc-invalid-smoke-"));
  const organizationRoot = join(root, "organizations", "Broken_GEN3");
  try {
    mkdirSync(organizationRoot, { recursive: true });
    writeFileSync(join(organizationRoot, "company.gen3.json"), "{broken\n");
    const results = runSmoke(root);
    expect(results).toHaveLength(1);
    expect(results[0].data_state).toBe("invalid");
    expect(results[0].errors.join(" ")).toContain("company.gen3.json");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
