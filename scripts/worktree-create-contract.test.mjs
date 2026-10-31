import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { existsSync, writeFileSync } from "node:fs";
import {
  isPlanEnvironmentId,
  parseWorktreeCreateArgs,
  PLAN_CODE_PATTERN,
  planEnvironmentId,
} from "./worktree-create-contract.mjs";
import { auditRepository } from "../.agents/skills/worktree-development-discipline/scripts/worktree-inventory.mjs";

import { platformTestTimeout } from "../launchpad/src/test-platform-setup.mjs";

// These fixtures initialize and commit several real Git repositories.
// Use the same bounded platform allowance as the sibling inventory suite.
setDefaultTimeout(platformTestTimeout(20_000));

const cleanupPaths = [];
const createScript = join(import.meta.dir, "worktree-create.mjs");
const validPlan = `schema_version: companiesascode.mission_control.plan.v2
id: mcplan-cac-0007
dev_code: CAC-0007
title: "Create lane fixture"
`;

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map((path) => rm(path, {
    recursive: true,
    force: true,
  })));
});

test.each([
  "AB-0001",
  "CAC-0085",
  "ABCDEF-9999",
])("accepts canonical Mission Control code %s", (code) => {
  expect(PLAN_CODE_PATTERN.test(code)).toBe(true);
});

test.each([
  "A-0001",
  "ABCDEFG-0001",
  "cac-0085",
  "CAC-85",
])("rejects non-canonical Mission Control code %s", (code) => {
  expect(PLAN_CODE_PATTERN.test(code)).toBe(false);
});

test("parses the supported create-lane arguments", () => {
  expect(parseWorktreeCreateArgs([
    "--plan", "ABCDEF-0001",
    "--branch", "codex/ABCDEF-0001-fixture",
    "--surface", "codex-desktop",
    "--task-agent-id", "task-agent-123",
    "--repository", "organizations/ExampleOrganization_GEN3",
    "--dry-run",
  ])).toEqual({
    plan: "ABCDEF-0001",
    branch: "codex/ABCDEF-0001-fixture",
    surface: "codex-desktop",
    "task-agent-id": "task-agent-123",
    repository: "organizations/ExampleOrganization_GEN3",
    dryRun: true,
  });
});

test.each([
  [["--unknown", "value"], "neznámý argument"],
  [["--plan"], "neúplný argument"],
  [["--surface", "Codex Desktop"], "neplatný formát"],
  [["--task-agent-id", "one", "--thread-id", "two"], "si odporují"],
])("rejects invalid arguments %#", (argv, message) => {
  expect(() => parseWorktreeCreateArgs(argv)).toThrow(message);
});

test("parses --name for an additional pull-request environment of a plan", () => {
  expect(parseWorktreeCreateArgs(["--plan", "CAC-0007", "--name", "second-pr-2"])).toEqual({
    plan: "CAC-0007",
    name: "second-pr-2",
    dryRun: false,
  });
});

test.each([
  "",
  "Second-PR",
  "second_pr",
  "second pr",
  "-second",
  "second-",
  "second--pr",
  "nested/name",
  "x".repeat(65),
])("rejects non-kebab-case --name %p", (name) => {
  expect(() => parseWorktreeCreateArgs(["--plan", "CAC-0007", "--name", name])).toThrow("--name musí být kebab-case");
});

test("environment ID is the plan basename by default and <code>-<name> per extra pull request", () => {
  const plan = { planBasename: "CAC-0007-create-lane", planCode: "CAC-0007" };
  expect(planEnvironmentId(plan)).toBe("CAC-0007-create-lane");
  expect(planEnvironmentId({ ...plan, name: "second-pr" })).toBe("CAC-0007-second-pr");
  for (const environmentId of ["CAC-0007-create-lane", "CAC-0007-second-pr", "CAC-0007-x"]) {
    expect(isPlanEnvironmentId(environmentId, plan)).toBe(true);
  }
  for (const environmentId of [
    "CAC-0007",
    "CAC-0008-second-pr",
    "CAC-0007-Second-PR",
    "CAC-0007_second-pr",
    "CAC-0007--second",
    "cac-0007-second-pr",
    "second-pr",
    "",
  ]) {
    expect(isPlanEnvironmentId(environmentId, plan)).toBe(false);
  }
});

test("dry-run with --name derives environment, branch and sidecar from <code>-<name>", async () => {
  const fixture = await createLaneFixture({
    plans: [["2026/07/CAC-0007-create-lane.yaml", validPlan]],
  });
  const result = runCreateLane({ ...fixture, name: "second-pr" });
  expect({ status: result.status, stderr: result.stderr }).toMatchObject({ status: 0 });
  const stdout = result.stdout.replaceAll("\\", "/");
  expect(stdout).toContain("ok - dry-run: plán data/mission-control/plans/2026/07/CAC-0007-create-lane.yaml");
  expect(stdout).toContain("/.worktrees/root/CAC-0007-second-pr\n");
  expect(stdout).toContain("ok - dry-run: branch agent/CAC-0007-second-pr z origin/main");
  expect(stdout).toContain("/.worktrees/root/CAC-0007-second-pr.worktree.json");

  const explicitBranch = runCreateLane({ ...fixture, name: "second-pr", branch: "codex/CAC-0007-review-fixes" });
  expect({ status: explicitBranch.status, stderr: explicitBranch.stderr }).toMatchObject({ status: 0 });
  expect(explicitBranch.stdout).toContain("ok - dry-run: branch codex/CAC-0007-review-fixes z origin/main");
});

test("rejects an invalid --name before resolving the plan or mutating anything", async () => {
  const fixture = await createLaneFixture({ plans: [["CAC-0007.yaml", validPlan]] });
  const result = runCreateLane({
    ...fixture,
    repository: "organizations/TestOrganization_GEN3",
    name: "Second_PR",
    dryRun: false,
  });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("--name musí být kebab-case");
  expect(existsSync(join(fixture.root, ".worktrees"))).toBe(false);
  expect(existsSync(join(fixture.organizationRoot, ".worktrees"))).toBe(false);
  expect(git(fixture.organizationRoot, ["branch", "--list", "agent/*"])).toBe("");
});

test("one plan owns several pull-request environments; conflicts are per environment ID", async () => {
  const fixture = await createLaneFixture({ plans: [["CAC-0007.yaml", validPlan]] });
  const repository = "organizations/TestOrganization_GEN3";
  const canonical = runCreateLane({ ...fixture, repository, dryRun: false });
  expect({ status: canonical.status, stderr: canonical.stderr }).toMatchObject({ status: 0 });
  const second = runCreateLane({ ...fixture, repository, name: "second-pr", dryRun: false });
  expect({ status: second.status, stderr: second.stderr }).toMatchObject({ status: 0 });

  const canonicalSidecarPath = join(fixture.organizationRoot, ".worktrees/root/CAC-0007.worktree.json");
  const secondSidecarPath = join(fixture.organizationRoot, ".worktrees/root/CAC-0007-second-pr.worktree.json");
  const canonicalSidecar = JSON.parse(await Bun.file(canonicalSidecarPath).text());
  const secondSidecarSource = await Bun.file(secondSidecarPath).text();
  const secondSidecar = JSON.parse(secondSidecarSource);
  expect(canonicalSidecar).toMatchObject({
    branch: "agent/CAC-0007",
    worktree_path: "organizations/TestOrganization_GEN3/.worktrees/root/CAC-0007",
  });
  expect(secondSidecar).toMatchObject({
    branch: "agent/CAC-0007-second-pr",
    worktree_path: "organizations/TestOrganization_GEN3/.worktrees/root/CAC-0007-second-pr",
    mission_control_plan_code: canonicalSidecar.mission_control_plan_code,
    mission_control_plan_path: canonicalSidecar.mission_control_plan_path,
    mission_control_authority_path: canonicalSidecar.mission_control_authority_path,
  });
  expect(git(join(fixture.organizationRoot, ".worktrees/root/CAC-0007-second-pr"), ["branch", "--show-current"]))
    .toBe("agent/CAC-0007-second-pr");

  // The same environment ID is a conflict even though its plan already has
  // another environment; nothing of the existing one is rewritten.
  const repeated = runCreateLane({ ...fixture, repository, name: "second-pr", dryRun: false });
  expect(repeated.status).toBe(1);
  expect(repeated.stderr).toContain("worktree už existuje");
  expect(repeated.stderr).toContain("--name");
  expect(await Bun.file(secondSidecarPath).text()).toBe(secondSidecarSource);

  git(fixture.organizationRoot, ["remote", "set-url", "origin", fixture.organizationRemote]);
  const audit = await auditRepository(fixture.organizationRoot);
  const environments = audit.worktrees
    .filter((entry) => entry.path_class === "canonical")
    .map((entry) => ({
      environment: entry.path.replaceAll("\\", "/").split("/").at(-1),
      branch: entry.branch,
      sidecar_valid: entry.sidecar_valid,
      lifecycle: entry.lifecycle,
    }))
    .sort((left, right) => left.environment.localeCompare(right.environment));
  expect(environments).toEqual([
    { environment: "CAC-0007", branch: "agent/CAC-0007", sidecar_valid: true, lifecycle: "active" },
    { environment: "CAC-0007-second-pr", branch: "agent/CAC-0007-second-pr", sidecar_valid: true, lifecycle: "active" },
  ]);
  expect(audit.violations).toEqual([]);
});

test("dry-run accepts a unique exact-code plan only after canonical validation", async () => {
  const fixture = await createLaneFixture({
    plans: [["CAC-0007.yaml", validPlan]],
  });
  const result = runCreateLane(fixture);
  expect({ status: result.status, stderr: result.stderr }).toMatchObject({ status: 0 });
  expect(result.stdout).toContain("ok - dry-run: plán data/mission-control/plans/CAC-0007.yaml");
});

test("dry-run accepts an exact clean Git-backed Organization root target", async () => {
  const fixture = await createLaneFixture({
    plans: [["CAC-0007.yaml", validPlan]],
  });
  const result = runCreateLane({
    ...fixture,
    repository: "organizations/TestOrganization_GEN3",
  });
  expect({ status: result.status, stderr: result.stderr }).toMatchObject({ status: 0 });
  expect(result.stdout.replaceAll("\\", "/")).toContain(
    "/organizations/TestOrganization_GEN3/.worktrees/root/CAC-0007",
  );
});

test("creates and inventories a governed Organization-root worktree", async () => {
  const fixture = await createLaneFixture({
    plans: [["CAC-0007.yaml", validPlan]],
  });
  const result = runCreateLane({
    ...fixture,
    repository: "organizations/TestOrganization_GEN3",
    dryRun: false,
  });
  expect({ status: result.status, stderr: result.stderr }).toMatchObject({ status: 0 });
  const sidecar = JSON.parse(await Bun.file(join(
    fixture.organizationRoot,
    ".worktrees/root/CAC-0007.worktree.json",
  )).text());
  expect(sidecar).toMatchObject({
    organization: "TestOrganization",
    organization_path: "organizations/TestOrganization_GEN3",
    module: "root",
    module_path: "organizations/TestOrganization_GEN3",
    repo_kind: "organization_root",
    worktree_path: "organizations/TestOrganization_GEN3/.worktrees/root/CAC-0007",
    mission_control_authority_path: "organizations/TestOrganization_GEN3/mission-control/db",
  });
  // Inventory has its own real-Git fixture transport; creation above used the
  // declared GitHub endpoint and only the explicit remoteGit dependency.
  git(fixture.organizationRoot, ["remote", "set-url", "origin", fixture.organizationRemote]);
  const audit = await auditRepository(fixture.organizationRoot);
  const worktree = audit.worktrees.find((entry) => entry.path_class === "canonical");
  expect(worktree).toMatchObject({
    sidecar_valid: true,
    branch: "agent/CAC-0007",
  });
  expect(audit.violations).toEqual([]);
});

test("overlapping invocations retain their own create-lock ownership", async () => {
  const fixture = await createLaneFixture({ plans: [["CAC-0007.yaml", validPlan]] });
  const result = runCreateLane({ ...fixture, repository: "organizations/TestOrganization_GEN3", overlap: true });
  expect({ status: result.status, stderr: result.stderr }).toMatchObject({ status: 0 });
  expect(existsSync(join(fixture.root, ".worktrees/.worktree-create.lock"))).toBe(false);
});

test("a concurrent create of another environment of the same plan fails fast on the shared lock, then succeeds", async () => {
  const fixture = await createLaneFixture({ plans: [["CAC-0007.yaml", validPlan]] });
  const result = runCreateLane({
    ...fixture,
    repository: "organizations/TestOrganization_GEN3",
    overlap: true,
    overlapArgs: ["--name", "second-pr"],
    dryRun: false,
  });
  expect({ status: result.status, stderr: result.stderr }).toMatchObject({ status: 0 });
  expect(existsSync(join(fixture.root, ".worktrees/.worktree-create.lock"))).toBe(false);
  for (const environmentId of ["CAC-0007", "CAC-0007-second-pr"]) {
    expect(existsSync(join(fixture.organizationRoot, ".worktrees/root", `${environmentId}.worktree.json`))).toBe(true);
    expect(git(join(fixture.organizationRoot, ".worktrees/root", environmentId), ["branch", "--show-current"]))
      .toBe(`agent/${environmentId}`);
  }
});

test.each([
  "https://github.com/TestOrganization/TestOrganization_GEN3.git",
  "ssh://git@github.com/TestOrganization/TestOrganization_GEN3.git",
  "ssh://github.com/TestOrganization/TestOrganization_GEN3",
])("accepts the supported GitHub endpoint %s", async (origin) => {
  const fixture = await createLaneFixture({ plans: [["CAC-0007.yaml", validPlan]] });
  git(fixture.organizationRoot, ["remote", "set-url", "origin", origin]);
  const result = runCreateLane({ ...fixture, repository: "organizations/TestOrganization_GEN3" });
  expect({ status: result.status, stderr: result.stderr }).toMatchObject({ status: 0 });
});

test.each(["path", "file-url", "embedded-host", "suffix-host"])("rejects undeclared %s origin before transport or mutation", async (kind) => {
  const fixture = await createLaneFixture({ plans: [["CAC-0007.yaml", validPlan]] });
  const remote = kind === "path" ? fixture.organizationRemote
    : kind === "file-url" ? pathToFileURL(fixture.organizationRemote).href
    : kind === "embedded-host" ? "https://example.invalid/github.com/TestOrganization/TestOrganization_GEN3.git"
    : "https://evilgithub.com/TestOrganization/TestOrganization_GEN3.git";
  git(fixture.organizationRoot, ["remote", "set-url", "origin", remote]);
  const result = runCreateLane({ ...fixture, repository: "organizations/TestOrganization_GEN3", dryRun: false, productionTransport: true });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("podporovaný GitHub origin");
  expect(git(fixture.organizationRoot, ["branch", "--list", "agent/CAC-0007"])).toBe("");
  expect(existsSync(join(fixture.organizationRoot, ".worktrees/root/CAC-0007"))).toBe(false);
});

test.each(["branch", "upstream", "dirty", "tracked", "origin"])("rejects %s changed during fetch without allocating a branch", async (kind) => {
  const fixture = await createLaneFixture({ plans: [["CAC-0007.yaml", validPlan]] });
  const result = runCreateLane({ ...fixture, repository: "organizations/TestOrganization_GEN3", dryRun: false, mutation: { after: "fetch", kind } });
  expect(result.status).toBe(1);
  expect(result.stderr).toMatch(/primary checkout|origin.*změnil/);
  expect(git(fixture.organizationRoot, ["branch", "--list", "agent/CAC-0007"])).toBe("");
  expect(existsSync(join(fixture.organizationRoot, ".worktrees/root/CAC-0007.worktree.json"))).toBe(false);
  expect(existsSync(join(fixture.organizationRoot, ".worktrees/root/CAC-0007"))).toBe(false);
  if (kind === "dirty") expect(await Bun.file(join(fixture.organizationRoot, "other-writer.txt")).text()).toContain("preserve me");
  if (kind === "branch") expect(git(fixture.organizationRoot, ["branch", "--show-current"])).toBe("other-writer");
});

test("dry-run rechecks checkout state after the remote query", async () => {
  const fixture = await createLaneFixture({ plans: [["CAC-0007.yaml", validPlan]] });
  const result = runCreateLane({ ...fixture, repository: "organizations/TestOrganization_GEN3", mutation: { after: "ls-remote", kind: "branch" } });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("primary checkout musí být na main");
  expect(git(fixture.organizationRoot, ["branch", "--list", "agent/CAC-0007"])).toBe("");
});

test.each([
  "../TestOrganization_GEN3",
  "personalspace/TestOrganization_GEN3",
  "organizations/TestOrganization_GEN3/productionspace",
  "organizations/TestOrganization_GEN3/mission-control/db",
])("dry-run rejects non-Organization-root repository target %s", async (repository) => {
  const fixture = await createLaneFixture({
    plans: [["CAC-0007.yaml", validPlan]],
  });
  const result = runCreateLane({ ...fixture, repository });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("--repository musí být portable cesta organizations/<organization>");
});

test("dry-run rejects a dirty Organization primary checkout", async () => {
  const fixture = await createLaneFixture({
    plans: [["CAC-0007.yaml", validPlan]],
  });
  await writeFile(join(fixture.organizationRoot, "dirty.txt"), "dirty\n");
  const result = runCreateLane({
    ...fixture,
    repository: "organizations/TestOrganization_GEN3",
  });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("primary checkout musí být clean");
});

test("dry-run rejects an Organization primary checkout that is not exact remote main", async () => {
  const fixture = await createLaneFixture({
    plans: [["CAC-0007.yaml", validPlan]],
  });
  await writeFile(join(fixture.organizationRoot, "ahead.txt"), "ahead\n");
  git(fixture.organizationRoot, ["add", "ahead.txt"]);
  git(fixture.organizationRoot, ["commit", "-m", "local ahead fixture"]);
  const result = runCreateLane({
    ...fixture,
    repository: "organizations/TestOrganization_GEN3",
  });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("přesně aktuální vůči remote main");
});

test("dry-run rejects a foreign Organization origin", async () => {
  const fixture = await createLaneFixture({
    plans: [["CAC-0007.yaml", validPlan]],
  });
  git(fixture.organizationRoot, ["remote", "set-url", "origin", "git@github.com:OtherOrg/TestOrganization_GEN3.git"]);
  const result = runCreateLane({
    ...fixture,
    repository: "organizations/TestOrganization_GEN3",
  });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("neodpovídá Organization manifestu");
});

test("dry-run rejects a symlinked Organization repository component", async () => {
  const fixture = await createLaneFixture({
    plans: [["CAC-0007.yaml", validPlan]],
  });
  const realOrganization = join(fixture.root, "real-organization");
  await cp(fixture.organizationRoot, realOrganization, { recursive: true });
  await rm(fixture.organizationRoot, { recursive: true, force: true });
  await symlink(
    realOrganization,
    fixture.organizationRoot,
    process.platform === "win32" ? "junction" : "dir",
  );
  const result = runCreateLane({
    ...fixture,
    repository: "organizations/TestOrganization_GEN3",
  });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("obsahuje symlink nebo neadresářovou komponentu");
});

test("dry-run accepts the canonical repository-db.yaml authority", async () => {
  const fixture = await createLaneFixture({
    plans: [["CAC-0007.yaml", validPlan]],
    authorityFormat: "config",
  });
  const result = runCreateLane(fixture);
  expect({ status: result.status, stderr: result.stderr }).toMatchObject({ status: 0 });
});

test("dry-run fails closed when a Task Agent task/thread/session ID cannot be captured", async () => {
  const fixture = await createLaneFixture({
    plans: [["CAC-0007.yaml", validPlan]],
  });
  const result = runCreateLane({ ...fixture, includeTaskAgentIdentity: false });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("Task Agent task/thread/session ID není dostupné");
});

test("dry-run normalizes an explicit Organization root to repository-db", async () => {
  const fixture = await createLaneFixture({
    plans: [["2026/07/CAC-0007-create-lane.yaml", validPlan]],
  });
  const result = runCreateLane({
    ...fixture,
    authorityOverride: fixture.organizationRoot,
  });
  expect({ status: result.status, stderr: result.stderr }).toMatchObject({ status: 0 });
  expect(result.stdout).toContain(
    "ok - dry-run: plán data/mission-control/plans/2026/07/CAC-0007-create-lane.yaml",
  );
});

test("dry-run rejects an explicit external repository-db authority", async () => {
  const fixture = await createLaneFixture({
    plans: [["CAC-0007.yaml", validPlan]],
  });
  const externalAuthorityRoot = join(
    dirname(fixture.root),
    "external-repository-db-authority",
  );
  await cp(fixture.authorityRoot, externalAuthorityRoot, { recursive: true });
  const result = runCreateLane({
    ...fixture,
    authorityOverride: externalAuthorityRoot,
  });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain(
    "nový worktree vyžaduje Mission Control authority",
  );
});

test(
  "dry-run rejects a symlinked Organization authority component",
  async () => {
    const fixture = await createLaneFixture({
      plans: [["CAC-0007.yaml", validPlan]],
    });
    const externalAuthorityRoot = join(dirname(fixture.root), "symlink-target-db");
    await cp(fixture.authorityRoot, externalAuthorityRoot, { recursive: true });
    await rm(fixture.authorityRoot, { recursive: true, force: true });
    await symlink(
      externalAuthorityRoot,
      fixture.authorityRoot,
      process.platform === "win32" ? "junction" : "dir",
    );
    const result = runCreateLane(fixture);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("obsahuje symlink nebo neadresářovou komponentu");
  },
);

test("dry-run fails closed when multiple Organizations claim the same plan code", async () => {
  const fixture = await createLaneFixture({
    plans: [["CAC-0007.yaml", validPlan]],
  });
  await cp(
    fixture.organizationRoot,
    join(fixture.root, "organizations", "SecondOrganization_GEN3"),
    { recursive: true },
  );
  const result = runCreateLane(fixture);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("nalezen ve více Organization Mission Control autoritách");
});

test("dry-run ignores an unrelated partial Organization authority", async () => {
  const fixture = await createLaneFixture({
    plans: [["CAC-0007.yaml", validPlan]],
  });
  const partialAuthorityRoot = join(
    fixture.root,
    "organizations",
    "AA-PartialOrganization_GEN3",
    "mission-control",
    "db",
  );
  await mkdir(partialAuthorityRoot, { recursive: true });
  await writeFile(
    join(partialAuthorityRoot, "repository-db.manifest.json"),
    '{"schema_version":"companiesascode.repository_db.manifest.v1","data_mode":"repository-db","data_root":"data/mission-control"}\n',
    "utf8",
  );
  const result = runCreateLane(fixture);
  expect({ status: result.status, stderr: result.stderr }).toMatchObject({ status: 0 });
});

test("dry-run rejects a plan whose declared dev_code does not match the request", async () => {
  const fixture = await createLaneFixture({
    plans: [["CAC-0007.yaml", validPlan.replaceAll("0007", "0008")]],
  });
  const result = runCreateLane(fixture);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("deklaruje dev_code CAC-0008, očekáváno CAC-0007");
});

test("dry-run fails closed when multiple files claim the same plan code", async () => {
  const fixture = await createLaneFixture({
    plans: [
      ["CAC-0007.yaml", validPlan],
      ["archive/CAC-0007-duplicate.yaml", validPlan],
    ],
  });
  const result = runCreateLane(fixture);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("má více kanonických kandidátů");
});

test("dry-run ignores retired legacy plan copies when repository-db owns the plan", async () => {
  const fixture = await createLaneFixture({
    plans: [["CAC-0007.yaml", validPlan]],
    legacyPlans: [["CAC-0007-stale.yaml", validPlan.replace('title: "Create lane fixture"', 'title: "Stale legacy copy"')]],
  });
  const result = runCreateLane(fixture);
  expect(result.status).toBe(0);
  expect(result.stdout).toContain(
    "data/mission-control/plans/CAC-0007.yaml",
  );
});

test("dry-run rejects a legacy-only plan", async () => {
  const fixture = await createLaneFixture({
    plans: [],
    legacyPlans: [["CAC-0007.yaml", validPlan]],
  });
  const result = runCreateLane(fixture);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("nebyl nalezen v žádné připojené Organization Mission Control autoritě");
});

test("dry-run rejects a repository-db plans root redirected to retired legacy plans", async () => {
  const fixture = await createLaneFixture({
    plans: [],
    legacyPlans: [["CAC-0007.yaml", validPlan]],
  });
  const canonicalPlansRoot = join(
    fixture.authorityRoot,
    "data",
    "mission-control",
    "plans",
  );
  const legacyPlansRoot = join(fixture.organizationRoot, "mission-control", "plans");
  await rm(canonicalPlansRoot, { recursive: true });
  await symlink(
    legacyPlansRoot,
    canonicalPlansRoot,
    process.platform === "win32" ? "junction" : "dir",
  );

  const result = runCreateLane(fixture);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain(
    "canonical repository-db plan root resolves through a redirected path",
  );
});

test("dry-run fails closed when the canonical schema rejects the plan", async () => {
  const fixture = await createLaneFixture({
    plans: [[
      "CAC-0007-create-lane.yaml",
      validPlan.replace("companiesascode.mission_control.plan.v2", "invalid.plan"),
    ]],
  });
  const result = runCreateLane(fixture);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("Mission Control plan schema validation failed");
});

test("dry-run fails closed when repository-db semantic validation rejects the plan", async () => {
  const fixture = await createLaneFixture({
    plans: [[
      "CAC-0007-create-lane.yaml",
      validPlan.replace('title: "Create lane fixture"', 'title: "Semantically invalid"'),
    ]],
  });
  const result = runCreateLane(fixture);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("Mission Control repository-db semantic validation failed");
});

test("dry-run rejects a selected plan whose id does not match dev_code", async () => {
  const fixture = await createLaneFixture({
    plans: [[
      "CAC-0007-create-lane.yaml",
      validPlan.replace("id: mcplan-cac-0007", "id: mcplan-cac-9999"),
    ]],
  });
  const result = runCreateLane(fixture);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("Mission Control plan id must match dev_code");
});

async function createLaneFixture({
  plans,
  legacyPlans = [],
  authorityFormat = "legacy",
}) {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "worktree-create-contract-"));
  cleanupPaths.push(fixtureRoot);
  const root = join(fixtureRoot, "Conglomerate_GEN3");
  const organizationRoot = join(root, "organizations", "TestOrganization_GEN3");
  const authorityRoot = join(organizationRoot, "mission-control", "db");
  const repositoryDbRoot = authorityRoot;
  const plansRoot = join(authorityRoot, "data", "mission-control", "plans");
  const legacyPlansRoot = join(organizationRoot, "mission-control", "plans");
  const semanticValidatorPath = join(
    repositoryDbRoot,
    "scripts",
    "validate-mission-control-data.mjs",
  );
  await mkdir(root, { recursive: true });
  await mkdir(plansRoot, { recursive: true });
  await mkdir(join(repositoryDbRoot, "schemas"), { recursive: true });
  await mkdir(join(semanticValidatorPath, ".."), { recursive: true });
  await writeFile(join(root, "launchpad.gen3.json"), "{}\n", "utf8");
  await writeFile(
    join(organizationRoot, "company.gen3.json"),
    `${JSON.stringify({
      organization_generation: "gen3",
      organization_kind: "organization",
      company: {
        slug: "TestOrganization",
        display_name: "Test Organization",
        github_org: "TestOrganization",
        repository: "git@github.com:TestOrganization/TestOrganization_GEN3.git",
        root_repository: "TestOrganization/TestOrganization_GEN3",
      },
    }, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    join(organizationRoot, "modules.manifest.json"),
    `${JSON.stringify({
      organization_generation: "gen3",
      company: "TestOrganization",
      github_org: "TestOrganization",
      module_slots: [],
    }, null, 2)}\n`,
    "utf8",
  );
  await writeFile(join(organizationRoot, ".gitignore"), ".worktrees/\n", "utf8");
  if (authorityFormat === "config") {
    await writeFile(
      join(authorityRoot, "repository-db.yaml"),
      `schema_version: repository-db.config.v1
app: mission-control
data_repo:
  remote: https://github.com/TestOrganization/mission-control-data.git
  branch: v3
schema:
  name: mission-control-data
  version: 3.0.0-alpha.0
layout:
  data: data
  generated: generated
`,
      "utf8",
    );
  } else {
    await writeFile(
      join(authorityRoot, "repository-db.manifest.json"),
      `${JSON.stringify({
        schema_version: "companiesascode.repository_db.manifest.v1",
        data_mode: "repository-db",
        data_root: "data/mission-control",
      }, null, 2)}\n`,
      "utf8",
    );
  }
  for (const [relativePath, contents] of plans) {
    const planPath = join(plansRoot, relativePath);
    await mkdir(join(planPath, ".."), { recursive: true });
    await writeFile(planPath, contents, "utf8");
  }
  for (const [relativePath, contents] of legacyPlans) {
    const planPath = join(legacyPlansRoot, relativePath);
    await mkdir(join(planPath, ".."), { recursive: true });
    await writeFile(planPath, contents, "utf8");
  }
  await writeFile(
    join(repositoryDbRoot, "schemas", "mission-control-plan.schema.json"),
    `${JSON.stringify({
      type: "object",
      required: ["schema_version", "id", "dev_code", "title"],
      properties: {
        schema_version: { const: "companiesascode.mission_control.plan.v2" },
        id: { type: "string", pattern: "^mcplan-[a-z]{2,6}-[0-9]{4}$" },
        dev_code: { type: "string", pattern: "^[A-Z]{2,6}-[0-9]{4}$" },
        title: { type: "string" },
      },
    }, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    semanticValidatorPath,
    `import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
function planSources(root) {
  const files = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const target = join(directory, entry.name);
      if (entry.isDirectory()) walk(target);
      else if (entry.isFile() && /\\.ya?ml$/.test(entry.name)) files.push(readFileSync(target, "utf8"));
    }
  };
  walk(join(root, "data", "mission-control", "plans"));
  return files;
}
const failures = planSources(process.cwd()).some((source) => source.includes('title: "Semantically invalid"'))
  ? ["semantic fixture rejection"]
  : [];
if (failures.length > 0) {
  console.error(failures.join("\\n"));
  process.exitCode = 1;
}
`,
    "utf8",
  );
  const organizationRemote = join(fixtureRoot, "TestOrganization", "TestOrganization_GEN3.git");
  await mkdir(dirname(organizationRemote), { recursive: true });
  const bare = spawnSync("git", ["init", "--bare", organizationRemote], { encoding: "utf8" });
  if (bare.status !== 0) throw new Error(bare.stderr);
  for (const args of [
    ["init", "-b", "main"],
    ["remote", "add", "origin", "git@github.com:TestProvider/Lazurio.git"],
  ]) {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    if (result.status !== 0) throw new Error(result.stderr);
  }
  for (const args of [
    ["init", "-b", "main"],
    ["config", "user.email", "fixture@example.test"],
    ["config", "user.name", "Fixture"],
    ["add", "."],
    ["commit", "-m", "fixture Organization"],
    ["remote", "add", "origin", organizationRemote],
  ]) {
    const result = spawnSync("git", args, { cwd: organizationRoot, encoding: "utf8" });
    if (result.status !== 0) throw new Error(result.stderr);
  }
  git(organizationRoot, ["push", "-u", "origin", "main"]);
  git(organizationRoot, ["remote", "set-url", "origin", "git@github.com:TestOrganization/TestOrganization_GEN3.git"]);
  return { root, organizationRoot, authorityRoot, organizationRemote, fixtureRoot };
}

function runCreateLane({
  root,
  organizationRemote,
  fixtureRoot,
  mutation = null,
  productionTransport = false,
  overlap = false,
  overlapArgs = [],
  authorityOverride = null,
  includeTaskAgentIdentity = true,
  repository = null,
  name = null,
  branch = null,
  dryRun = true,
}) {
  const env = { ...process.env };
  delete env.MISSION_CONTROL_AUTHORITY_ROOT;
  delete env.LAZURIO_MISSION_CONTROL_ROOT;
  for (const key of [
    "LAZURIO_TASK_AGENT_ID",
    "LAZURIO_TASK_AGENT_SURFACE",
    "HUMANANDMACHINE_THREAD_ID",
    "CODEX_THREAD_ID",
    "CODEX_SESSION_ID",
    "CLAUDE_CODE_SESSION_ID",
    "CLAUDE_SESSION_ID",
  ]) delete env[key];
  if (includeTaskAgentIdentity) {
    env.LAZURIO_TASK_AGENT_ID = "fixture-task-agent-id";
    env.LAZURIO_TASK_AGENT_SURFACE = "test-harness";
  }
  if (authorityOverride) env.MISSION_CONTROL_AUTHORITY_ROOT = authorityOverride;
  let entrypoint = createScript;
  if (!productionTransport) {
    entrypoint = join(fixtureRoot, "create-harness.mjs");
    writeFileSync(entrypoint, `
import { runWorktreeCreate } from ${JSON.stringify(pathToFileURL(createScript).href)};
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const mutation = ${JSON.stringify(mutation)};
const run = (cwd, args) => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(r.stderr);
  return { status: r.status, stdout: r.stdout.trim(), stderr: r.stderr.trim() };
};
const overlap = ${JSON.stringify(overlap)};
const overlapArgs = ${JSON.stringify(overlapArgs)};
let reachedRemote, resumeRemote;
const reached = new Promise(resolve => { reachedRemote = resolve; });
const resume = new Promise(resolve => { resumeRemote = resolve; });
try {
  const dependencies = { async remoteGit(cwd, args) {
    if (overlap && args[0] === "ls-remote") { reachedRemote(); await resume; }
    const endpoints = ["git@github.com:TestOrganization/TestOrganization_GEN3.git", "https://github.com/TestOrganization/TestOrganization_GEN3.git", "ssh://git@github.com/TestOrganization/TestOrganization_GEN3.git", "ssh://github.com/TestOrganization/TestOrganization_GEN3"];
    if (!endpoints.includes(args[1])) throw new Error("Unexpected fixture endpoint");
    const result = run(cwd, [args[0], ${JSON.stringify(organizationRemote)}, ...args.slice(2)]);
    if (mutation && args[0] === mutation.after) {
      if (mutation.kind === "branch") run(cwd, ["switch", "-c", "other-writer"]);
      if (mutation.kind === "upstream") run(cwd, ["branch", "--unset-upstream"]);
      if (mutation.kind === "tracked") writeFileSync(join(cwd, ".gitignore"), ".worktrees/\\n# other writer\\n");
      if (mutation.kind === "dirty") writeFileSync(join(cwd, "other-writer.txt"), "preserve me\\n");
      if (mutation.kind === "origin") run(cwd, ["remote", "set-url", "origin", "https://github.com/TestOrganization/TestOrganization_GEN3.git"]);
    }
    return result;
  }};
  if (overlap) {
    const first = runWorktreeCreate(dependencies);
    await reached;
    const lockPath = join(${JSON.stringify(root)}, ".worktrees", ".worktree-create.lock");
    const ownerPath = join(lockPath, "owner.json");
    const ownedLock = readFileSync(ownerPath, "utf8");
    const firstArgv = process.argv;
    // The first invocation parsed its argv synchronously; the second may ask
    // for another environment of the same plan.
    process.argv = [...firstArgv, ...overlapArgs];
    let secondRejected = false;
    try { await runWorktreeCreate(dependencies); } catch (error) { secondRejected = error.message.includes("create lock"); }
    const preserved = existsSync(ownerPath) && readFileSync(ownerPath, "utf8") === ownedLock;
    resumeRemote();
    await first;
    if (!secondRejected || !preserved) throw new Error("Overlapping call released another invocation's lock");
    if (existsSync(lockPath)) throw new Error("Owner did not release its own lock");
    if (overlapArgs.length > 0) await runWorktreeCreate(dependencies);
    process.argv = firstArgv;
  } else {
    await runWorktreeCreate(dependencies);
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
`);
  }
  const args = [
    entrypoint,
    "--plan", "CAC-0007",
  ];
  if (dryRun) args.push("--dry-run");
  if (repository) args.push("--repository", repository);
  if (name !== null) args.push("--name", name);
  if (branch) args.push("--branch", branch);
  return spawnSync(process.execPath, args, {
    cwd: root,
    encoding: "utf8",
    env,
    timeout: overlap ? 15_000 : undefined,
  });
}

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}
