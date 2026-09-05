import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { spawnSync } from "node:child_process";

import {
  checkModuleLocationRepair,
  moduleLocationRepairExitCode,
  renderHumanModuleLocationRepair,
  runModuleLocationRepair,
} from "../../lazurio/runtime/module-location-repair-lib.mjs";
import { runGit } from "../../lazurio/runtime/git-lib.mjs";
import { githubRepositoryCoordinate } from "../../lazurio/core/organization-slot-scope-lib.mjs";
import { supportsFileSymlinks } from "../../scripts/test-platform-capabilities.mjs";

// This file exercises real Git repositories and subprocesses. Cold Windows
// runners can spend more than the shared 15 s Launchpad limit in one complete
// check/apply/recheck transaction even though each bounded Git operation is
// healthy. Keep the extra headroom local to this integration suite.
if (process.platform === "win32") setDefaultTimeout(30_000);

const cleanup = [];
const fileSymlinkTest = (await supportsFileSymlinks()) ? test : test.skip;

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

test("check proves one clean transferred repository and apply atomically aligns origin and path", async () => {
  const fixture = await repairFixture("happy");
  const beforeHead = git(fixture.sourcePath, ["rev-parse", "HEAD"]);

  const checked = await checkFixture(fixture);
  const fingerprint = checked.fingerprint;
  expect(checked).toMatchObject({
    state: "ready",
    ok: true,
    organization: "TestCo",
    module: "studio",
    fingerprint: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
    plan: {
      found_path: fixture.sourcePath,
      expected_path: fixture.targetPath,
      current_origin: fixture.oldRemote,
      expected_origin: fixture.newRemote,
      path_change_required: true,
      origin_change_required: true,
    },
  });
  expect(checked.plan.apply_command).toContain(`--apply --expect ${fingerprint}`);
  expect(checked.plan.apply_argv).toContain(fixture.rootPath);
  expect(checked.plan.apply_command).toContain("--root");
  expect(checked.plan.apply_command).toContain(fixture.rootPath);
  expect(moduleLocationRepairExitCode(checked)).toBe(1);
  expect(existsSync(fixture.targetPath)).toBe(false);
  expect(git(fixture.sourcePath, ["remote", "get-url", "origin"])).toBe(fixture.oldRemote);

  const applied = await runModuleLocationRepair({
    ...fixture.options,
    apply: true,
    expectedFingerprint: fingerprint,
    deps: fixture.deps,
  });

  expect(applied).toMatchObject({
    state: "repaired",
    ok: true,
    next_action: {
      kind: "update",
      argv: ["lazurio", "update", "--root", fixture.rootPath],
    },
  });
  expect(applied.next_action.command).toContain("lazurio update --root");
  expect(applied.next_action.command).toContain(fixture.rootPath);
  expect(moduleLocationRepairExitCode(applied)).toBe(0);
  expect(existsSync(fixture.sourcePath)).toBe(false);
  expect(existsSync(fixture.targetPath)).toBe(true);
  expect(git(fixture.targetPath, ["remote", "get-url", "origin"])).toBe(fixture.newRemote);
  expect(git(fixture.targetPath, ["rev-parse", "HEAD"])).toBe(beforeHead);
  expect(git(fixture.targetPath, ["status", "--porcelain=v1", "--untracked-files=all"])).toBe("");

  const rerun = await checkFixture(fixture);
  expect(rerun).toMatchObject({ state: "current", ok: true });
});

test("repair accepts the deployed organization_generation GEN3 contract used by Organization roots", async () => {
  const fixture = await repairFixture("deployed-gen3-contract");
  for (const relativePath of ["company.gen3.json", "modules.manifest.json"]) {
    const path = join(fixture.organizationRoot, relativePath);
    const document = JSON.parse(await readFile(path, "utf8"));
    delete document.schema_version;
    document.organization_generation = "gen3";
    await writeFile(path, `${JSON.stringify(document, null, 2)}\n`);
  }
  publishOrganizationContract(fixture, "use deployed GEN3 declaration contract");

  expect(await checkFixture(fixture)).toMatchObject({ state: "ready", ok: true });
});

test("repair never treats an explicit unknown schema as deployed GEN3", async () => {
  const fixture = await repairFixture("unknown-gen3-schema");
  const companyPath = join(fixture.organizationRoot, "company.gen3.json");
  const company = JSON.parse(await readFile(companyPath, "utf8"));
  company.schema_version = "company.gen3.v999";
  company.organization_generation = "gen3";
  await writeFile(companyPath, `${JSON.stringify(company, null, 2)}\n`);
  publishOrganizationContract(fixture, "publish unsupported explicit schema");

  expect(await checkFixture(fixture)).toMatchObject({
    state: "blocked",
    blockers: [{ code: "organization_manifest_not_mutation_safe" }],
  });
});

test("repair stays ready beside a markerless checkout owned by a declared sibling", async () => {
  const fixture = await repairFixture("declared-sibling");
  const siblingPath = join(fixture.workspaceRoot, "knowledgebase");
  await mkdir(join(siblingPath, ".git"), { recursive: true });
  const siblingRemote = join(fixture.sandbox, "knowledgebase.git");
  const companyPath = join(fixture.organizationRoot, "company.gen3.json");
  const manifestPath = join(fixture.organizationRoot, "modules.manifest.json");
  const company = JSON.parse(await readFile(companyPath, "utf8"));
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  company.modules.push({
    slug: "knowledgebase",
    path: "workspace/knowledgebase",
    repo: siblingRemote,
  });
  manifest.module_slots.push({
    slug: "knowledgebase",
    path: "workspace/knowledgebase",
    git: { url: siblingRemote, branch: "main" },
  });
  await writeFile(companyPath, `${JSON.stringify(company, null, 2)}\n`);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  publishOrganizationContract(fixture, "declare markerless sibling checkout");

  const report = await checkFixture(fixture);

  expect(report).toMatchObject({ state: "ready", ok: true });
  expect(report.plan.found_path).toBe(fixture.sourcePath);
  expect(existsSync(siblingPath)).toBe(true);
});

test("repair never relocates a selected marker from a path claimed by a sibling", async () => {
  const fixture = await repairFixture("selected-marker-sibling-path");
  await addSiblingDeclaration(fixture, {
    slug: "knowledgebase",
    path: "workspace/legacy",
    remote: "git@github.com:fixture/legacy.git",
  });
  const activity = { targetFetches: 0, originMutations: 0, renames: 0 };

  const report = await runInstrumentedApply(fixture, activity);

  expect(report).toMatchObject({
    state: "blocked",
    blockers: [{ code: "checkout_ambiguous" }],
    plan: { reason: "sibling_declaration_collision" },
  });
  expect(activity).toEqual({ targetFetches: 0, originMutations: 0, renames: 0 });
  expect(existsSync(fixture.sourcePath)).toBe(true);
  expect(existsSync(fixture.targetPath)).toBe(false);
});

test("repair folds sibling path ownership before a case-insensitive filesystem can alias it", async () => {
  const fixture = await repairFixture("selected-marker-case-folded-sibling");
  await addSiblingDeclaration(fixture, {
    slug: "knowledgebase",
    path: "workspace/Legacy",
    remote: "git@github.com:fixture/Legacy.git",
  });
  const activity = { targetFetches: 0, originMutations: 0, renames: 0 };

  const report = await runInstrumentedApply(fixture, activity);

  expect(report).toMatchObject({
    state: "blocked",
    blockers: [{ code: "checkout_ambiguous" }],
    plan: { reason: "sibling_declaration_collision" },
  });
  expect(activity).toEqual({ targetFetches: 0, originMutations: 0, renames: 0 });
  expect(existsSync(fixture.sourcePath)).toBe(true);
  expect(existsSync(fixture.targetPath)).toBe(false);
});

test("repair reserves a sibling path with case-only mount container drift", async () => {
  const fixture = await repairFixture("selected-marker-case-folded-container");
  await addSiblingDeclaration(fixture, {
    slug: "knowledgebase",
    path: "Workspace/legacy",
    remote: "git@github.com:fixture/legacy.git",
  });
  const activity = { targetFetches: 0, originMutations: 0, renames: 0 };

  const report = await runInstrumentedApply(fixture, activity);

  expect(report).toMatchObject({
    state: "blocked",
    blockers: [{ code: "organization_manifest_not_mutation_safe" }],
  });
  expect(activity).toEqual({ targetFetches: 0, originMutations: 0, renames: 0 });
  expect(existsSync(fixture.sourcePath)).toBe(true);
  expect(existsSync(fixture.targetPath)).toBe(false);
});

test("repair reserves a sibling path whose invalid slug cannot authorize ownership", async () => {
  const fixture = await repairFixture("selected-marker-invalid-sibling-slug");
  await addSiblingDeclaration(fixture, {
    slug: "INVALID",
    path: "workspace/legacy",
    remote: "git@github.com:fixture/legacy.git",
  });
  const activity = { targetFetches: 0, originMutations: 0, renames: 0 };

  const report = await runInstrumentedApply(fixture, activity);

  expect(report).toMatchObject({
    state: "blocked",
    blockers: [{ code: "checkout_ambiguous" }],
    plan: { reason: "sibling_declaration_collision" },
  });
  expect(activity).toEqual({ targetFetches: 0, originMutations: 0, renames: 0 });
  expect(existsSync(fixture.sourcePath)).toBe(true);
  expect(existsSync(fixture.targetPath)).toBe(false);
});

test("repair rejects a target path claimed by another Module before Git mutation", async () => {
  const fixture = await repairFixture("sibling-target-claim");
  await addSiblingDeclaration(fixture, {
    slug: "knowledgebase",
    path: "workspace/canonical",
    remote: "git@github.com:fixture/canonical.git",
  });
  const activity = { targetFetches: 0, originMutations: 0, renames: 0 };

  const report = await runInstrumentedApply(fixture, activity);

  expect(report).toMatchObject({
    state: "blocked",
    blockers: [{ code: "module_declaration_ambiguous" }],
  });
  expect(activity).toEqual({ targetFetches: 0, originMutations: 0, renames: 0 });
  expect(existsSync(fixture.sourcePath)).toBe(true);
  expect(existsSync(fixture.targetPath)).toBe(false);
});

test("dirty checkout blocks without changing origin, path or local work", async () => {
  const fixture = await repairFixture("dirty");
  const draftPath = join(fixture.sourcePath, "draft.txt");
  await writeFile(draftPath, "local draft\n");

  const report = await checkFixture(fixture);

  expect(report).toMatchObject({
    state: "blocked",
    blockers: [{ code: "checkout_dirty" }],
  });
  expect(await readFile(draftPath, "utf8")).toBe("local draft\n");
  expect(existsSync(fixture.targetPath)).toBe(false);
  expect(git(fixture.sourcePath, ["remote", "get-url", "origin"])).toBe(fixture.oldRemote);
});

test("dirty Organization manifests cannot authorize a Module mutation", async () => {
  const fixture = await repairFixture("dirty-organization-source");
  const companyPath = join(fixture.organizationRoot, "company.gen3.json");
  const company = JSON.parse(await readFile(companyPath, "utf8"));
  company.notes = "unreviewed local contract";
  await writeFile(companyPath, `${JSON.stringify(company, null, 2)}\n`);
  const baseRunGit = fixture.deps.runGit ?? runGit;
  let targetFetches = 0;
  let originMutations = 0;
  let renames = 0;

  const report = await runModuleLocationRepair({
    ...fixture.options,
    apply: true,
    expectedFingerprint: `sha256:${"0".repeat(64)}`,
    deps: {
      ...fixture.deps,
      runGit: async (args, options) => {
        if (options?.cwd === fixture.sourcePath && args[0] === "fetch") targetFetches += 1;
        if (options?.cwd === fixture.sourcePath && args[0] === "remote" && args[1] === "set-url") {
          originMutations += 1;
        }
        return baseRunGit(args, options);
      },
      renamePath: async () => {
        renames += 1;
        throw new Error("rename must not run");
      },
    },
  });

  expect(report).toMatchObject({
    state: "blocked",
    blockers: [{ code: "organization_source_dirty" }],
  });
  expect(targetFetches).toBe(0);
  expect(originMutations).toBe(0);
  expect(renames).toBe(0);
  expect(existsSync(fixture.sourcePath)).toBe(true);
  expect(existsSync(fixture.targetPath)).toBe(false);
  expect(git(fixture.sourcePath, ["remote", "get-url", "origin"])).toBe(fixture.oldRemote);
});

test("published conflicting Organization root aliases cannot authorize a Module mutation", async () => {
  const fixture = await repairFixture("organization-source-aliases");
  const companyPath = join(fixture.organizationRoot, "company.gen3.json");
  const company = JSON.parse(await readFile(companyPath, "utf8"));
  company.company.git_url = "git@github.com:ForeignCo/Shadow_GEN3.git";
  company.default_branch = "develop";
  await writeFile(companyPath, `${JSON.stringify(company, null, 2)}\n`);
  publishOrganizationContract(fixture, "publish conflicting root aliases");
  const baseRunGit = fixture.deps.runGit ?? runGit;
  let targetFetches = 0;
  let originMutations = 0;
  let renames = 0;

  const report = await runModuleLocationRepair({
    ...fixture.options,
    apply: true,
    expectedFingerprint: `sha256:${"0".repeat(64)}`,
    deps: {
      ...fixture.deps,
      runGit: async (args, options) => {
        if (options?.cwd === fixture.sourcePath && args[0] === "fetch") targetFetches += 1;
        if (options?.cwd === fixture.sourcePath && args[0] === "remote" && args[1] === "set-url") {
          originMutations += 1;
        }
        return baseRunGit(args, options);
      },
      renamePath: async () => {
        renames += 1;
        throw new Error("rename must not run");
      },
    },
  });

  expect(report).toMatchObject({
    state: "blocked",
    blockers: [{ code: "organization_manifest_not_mutation_safe" }],
  });
  expect(targetFetches).toBe(0);
  expect(originMutations).toBe(0);
  expect(renames).toBe(0);
  expect(existsSync(fixture.sourcePath)).toBe(true);
  expect(existsSync(fixture.targetPath)).toBe(false);
});

test("published scaffold forge binding conflict blocks repair before target Git actions", async () => {
  const fixture = await repairFixture("organization-source-forge-binding");
  const companyPath = join(fixture.organizationRoot, "company.gen3.json");
  const company = JSON.parse(await readFile(companyPath, "utf8"));
  company.forge_binding = {
    schema_version: "lazurio.forge-binding.github.v0",
    provider: "github",
    organization: { id: "123", asserted_login: "BoundCo" },
    repository: {
      id: "456",
      asserted_full_name: "BoundCo/BoundCo_GEN3",
      default_branch: "main",
    },
  };
  company.governance = { default_branch: "develop" };
  await writeFile(companyPath, `${JSON.stringify(company, null, 2)}\n`);
  publishOrganizationContract(fixture, "publish conflicting forge binding");
  const baseRunGit = fixture.deps.runGit ?? runGit;
  let targetFetches = 0;
  let originMutations = 0;
  let renames = 0;

  const report = await runModuleLocationRepair({
    ...fixture.options,
    apply: true,
    expectedFingerprint: `sha256:${"0".repeat(64)}`,
    deps: {
      ...fixture.deps,
      runGit: async (args, options) => {
        if (options?.cwd === fixture.sourcePath && args[0] === "fetch") targetFetches += 1;
        if (options?.cwd === fixture.sourcePath && args[0] === "remote" && args[1] === "set-url") {
          originMutations += 1;
        }
        return baseRunGit(args, options);
      },
      renamePath: async () => {
        renames += 1;
        throw new Error("rename must not run");
      },
    },
  });

  expect(report).toMatchObject({
    state: "blocked",
    blockers: [{ code: "organization_manifest_not_mutation_safe" }],
  });
  expect(targetFetches).toBe(0);
  expect(originMutations).toBe(0);
  expect(renames).toBe(0);
  expect(existsSync(fixture.sourcePath)).toBe(true);
  expect(existsSync(fixture.targetPath)).toBe(false);
});

test("published foreign governance access authority blocks repair before target Git actions", async () => {
  const fixture = await repairFixture("organization-access-authority");
  const companyPath = join(fixture.organizationRoot, "company.gen3.json");
  const company = JSON.parse(await readFile(companyPath, "utf8"));
  company.governance = { default_branch: "main", access_authority: "not-github" };
  await writeFile(companyPath, `${JSON.stringify(company, null, 2)}\n`);
  publishOrganizationContract(fixture, "publish foreign access authority");
  const baseRunGit = fixture.deps.runGit ?? runGit;
  let targetFetches = 0;
  let originMutations = 0;
  let renames = 0;

  const report = await runModuleLocationRepair({
    ...fixture.options,
    apply: true,
    expectedFingerprint: `sha256:${"0".repeat(64)}`,
    deps: {
      ...fixture.deps,
      runGit: async (args, options) => {
        if (options?.cwd === fixture.sourcePath && args[0] === "fetch") targetFetches += 1;
        if (options?.cwd === fixture.sourcePath && args[0] === "remote" && args[1] === "set-url") {
          originMutations += 1;
        }
        return baseRunGit(args, options);
      },
      renamePath: async () => {
        renames += 1;
        throw new Error("rename must not run");
      },
    },
  });

  expect(report).toMatchObject({
    state: "blocked",
    blockers: [{ code: "organization_manifest_not_mutation_safe" }],
  });
  expect(targetFetches).toBe(0);
  expect(originMutations).toBe(0);
  expect(renames).toBe(0);
  expect(existsSync(fixture.sourcePath)).toBe(true);
  expect(existsSync(fixture.targetPath)).toBe(false);
});

test("published Organization manifest cannot authorize repair through a different root origin", async () => {
  const fixture = await repairFixture("organization-source-origin-mismatch");
  const companyPath = join(fixture.organizationRoot, "company.gen3.json");
  const company = JSON.parse(await readFile(companyPath, "utf8"));
  company.company.repository = fixture.newBareRemote;
  await writeFile(companyPath, `${JSON.stringify(company, null, 2)}\n`);
  publishOrganizationContract(fixture, "publish wrong Organization root source");
  const baseRunGit = fixture.deps.runGit ?? runGit;
  let targetFetches = 0;
  let originMutations = 0;
  let renames = 0;

  const report = await runModuleLocationRepair({
    ...fixture.options,
    apply: true,
    expectedFingerprint: `sha256:${"0".repeat(64)}`,
    deps: {
      ...fixture.deps,
      runGit: async (args, options) => {
        if (options?.cwd === fixture.sourcePath && args[0] === "fetch") targetFetches += 1;
        if (options?.cwd === fixture.sourcePath && args[0] === "remote" && args[1] === "set-url") {
          originMutations += 1;
        }
        return baseRunGit(args, options);
      },
      renamePath: async () => {
        renames += 1;
        throw new Error("rename must not run");
      },
    },
  });

  expect(report).toMatchObject({
    state: "blocked",
    blockers: [{ code: "organization_manifest_not_mutation_safe" }],
  });
  expect(targetFetches).toBe(0);
  expect(originMutations).toBe(0);
  expect(renames).toBe(0);
  expect(existsSync(fixture.sourcePath)).toBe(true);
  expect(existsSync(fixture.targetPath)).toBe(false);
});

test("ignored untracked Organization manifests cannot impersonate reviewed source", async () => {
  const fixture = await repairFixture("organization-source-untracked");
  const companyPath = join(fixture.organizationRoot, "company.gen3.json");
  const manifestPath = join(fixture.organizationRoot, "modules.manifest.json");
  const companySource = await readFile(companyPath, "utf8");
  const manifestSource = await readFile(manifestPath, "utf8");
  await writeFile(
    join(fixture.organizationRoot, ".gitignore"),
    "workspace\nmodules\nproductionspace\ncompany.gen3.json\nmodules.manifest.json\n",
  );
  git(fixture.organizationRoot, ["rm", "company.gen3.json", "modules.manifest.json"]);
  git(fixture.organizationRoot, ["add", ".gitignore"]);
  git(fixture.organizationRoot, ["commit", "-m", "remove published manifests"]);
  git(fixture.organizationRoot, ["push", "origin", "main"]);
  await writeFile(companyPath, companySource);
  await writeFile(manifestPath, manifestSource);
  expect(git(fixture.organizationRoot, ["status", "--porcelain=v1", "--untracked-files=all"]))
    .toBe("");
  const baseRunGit = fixture.deps.runGit ?? runGit;
  let targetFetches = 0;
  let originMutations = 0;
  let renames = 0;

  const report = await runModuleLocationRepair({
    ...fixture.options,
    apply: true,
    expectedFingerprint: `sha256:${"0".repeat(64)}`,
    deps: {
      ...fixture.deps,
      runGit: async (args, options) => {
        if (options?.cwd === fixture.sourcePath && args[0] === "fetch") targetFetches += 1;
        if (options?.cwd === fixture.sourcePath && args[0] === "remote" && args[1] === "set-url") {
          originMutations += 1;
        }
        return baseRunGit(args, options);
      },
      renamePath: async () => {
        renames += 1;
        throw new Error("rename must not run");
      },
    },
  });

  expect(report).toMatchObject({
    state: "blocked",
    blockers: [{ code: "organization_source_file_unpublished" }],
  });
  expect(targetFetches).toBe(0);
  expect(originMutations).toBe(0);
  expect(renames).toBe(0);
  expect(existsSync(fixture.sourcePath)).toBe(true);
  expect(existsSync(fixture.targetPath)).toBe(false);
});

test("ignored untracked Module marker cannot authorize relocation", async () => {
  const fixture = await repairFixture("module-marker-untracked");
  const markerPath = join(fixture.sourcePath, "lazurio.module.json");
  const markerSource = await readFile(markerPath, "utf8");
  git(fixture.sourcePath, ["rm", "lazurio.module.json"]);
  git(fixture.sourcePath, ["commit", "-m", "remove published marker"]);
  git(fixture.sourcePath, ["push", "origin", "main"]);
  await writeFile(
    join(fixture.sourcePath, ".git", "info", "exclude"),
    "lazurio.module.json\n",
  );
  await writeFile(markerPath, markerSource);
  expect(git(fixture.sourcePath, ["status", "--porcelain=v1", "--untracked-files=all"]))
    .toBe("");
  const baseRunGit = fixture.deps.runGit ?? runGit;
  let targetFetches = 0;
  let originMutations = 0;
  let renames = 0;

  const report = await runModuleLocationRepair({
    ...fixture.options,
    apply: true,
    expectedFingerprint: `sha256:${"0".repeat(64)}`,
    deps: {
      ...fixture.deps,
      runGit: async (args, options) => {
        if (options?.cwd === fixture.sourcePath && args[0] === "fetch") targetFetches += 1;
        if (options?.cwd === fixture.sourcePath && args[0] === "remote" && args[1] === "set-url") {
          originMutations += 1;
        }
        return baseRunGit(args, options);
      },
      renamePath: async () => {
        renames += 1;
        throw new Error("rename must not run");
      },
    },
  });

  expect(report).toMatchObject({
    state: "blocked",
    blockers: [{ code: "module_marker_unpublished" }],
  });
  expect(targetFetches).toBe(0);
  expect(originMutations).toBe(0);
  expect(renames).toBe(0);
  expect(existsSync(fixture.sourcePath)).toBe(true);
  expect(existsSync(fixture.targetPath)).toBe(false);
});

test("existing target collision blocks instead of cloning, merging or overwriting", async () => {
  const fixture = await repairFixture("collision");
  await mkdir(fixture.targetPath, { recursive: true });
  const sentinel = join(fixture.targetPath, "sentinel.txt");
  await writeFile(sentinel, "keep me\n");

  const report = await checkFixture(fixture);

  expect(report).toMatchObject({ state: "blocked", blockers: [{ code: "target_collision" }] });
  expect(await readFile(sentinel, "utf8")).toBe("keep me\n");
  expect(existsSync(fixture.sourcePath)).toBe(true);
});

test("a target symlink alias is a collision and is never replaced", async () => {
  const fixture = await repairFixture("target-symlink-alias");
  await symlink(
    fixture.sourcePath,
    fixture.targetPath,
    process.platform === "win32" ? "junction" : "dir",
  );

  const report = await checkFixture(fixture);

  expect(report).toMatchObject({ state: "blocked", blockers: [{ code: "target_collision" }] });
  expect((await lstat(fixture.targetPath)).isSymbolicLink()).toBe(true);
  expect(existsSync(fixture.sourcePath)).toBe(true);
  expect(git(fixture.sourcePath, ["remote", "get-url", "origin"])).toBe(fixture.oldRemote);
});

test("stale fingerprint is rejected under the update lock before mutation", async () => {
  const fixture = await repairFixture("stale");
  const checked = await checkFixture(fixture);
  expect(checked.state).toBe("ready");
  const companyPath = join(fixture.organizationRoot, "company.gen3.json");
  const company = JSON.parse(await readFile(companyPath, "utf8"));
  company.notes = "state changed after check";
  await writeFile(companyPath, `${JSON.stringify(company, null, 2)}\n`);
  publishOrganizationContract(fixture, "publish changed repair contract");

  const report = await runModuleLocationRepair({
    ...fixture.options,
    apply: true,
    expectedFingerprint: checked.fingerprint,
    deps: fixture.deps,
  });

  expect(report).toMatchObject({ state: "blocked", blockers: [{ code: "repair_plan_changed" }] });
  expect(existsSync(fixture.sourcePath)).toBe(true);
  expect(existsSync(fixture.targetPath)).toBe(false);
  expect(git(fixture.sourcePath, ["remote", "get-url", "origin"])).toBe(fixture.oldRemote);
});

test("reviewed target may advance when local main remains its ancestor", async () => {
  const fixture = await repairFixture("target-advanced");
  const contributor = join(fixture.sandbox, "new-contributor");
  git(fixture.sandbox, ["clone", fixture.newBareRemote, contributor]);
  configure(contributor);
  await writeFile(join(contributor, "foreign.txt"), "foreign\n");
  git(contributor, ["add", "foreign.txt"]);
  git(contributor, ["commit", "-m", "foreign remote advance"]);
  git(contributor, ["push", "origin", "main"]);

  const report = await checkFixture(fixture);

  expect(report).toMatchObject({ state: "ready", ok: true });
  expect(report.plan.target_remote_head).not.toBe(report.plan.head);
  expect(existsSync(fixture.sourcePath)).toBe(true);
  expect(existsSync(fixture.targetPath)).toBe(false);
});

test("target without local-main ancestry remains blocked as foreign history", async () => {
  const fixture = await repairFixture("foreign-history");
  const foreign = join(fixture.sandbox, "foreign-seed");
  git(fixture.sandbox, ["init", foreign]);
  configure(foreign);
  git(foreign, ["switch", "-c", "main"]);
  await writeFile(join(foreign, "foreign.txt"), "foreign history\n");
  git(foreign, ["add", "."]);
  git(foreign, ["commit", "-m", "unrelated root"]);
  git(foreign, ["remote", "add", "target", fixture.newBareRemote]);
  git(foreign, ["push", "--force", "target", "main"]);

  const report = await checkFixture(fixture);

  expect(report).toMatchObject({
    state: "blocked",
    blockers: [{ code: "local_history_incompatible" }],
  });
});

test("failed filesystem rename rolls the already changed origin back", async () => {
  const fixture = await repairFixture("rollback");
  const checked = await checkFixture(fixture);
  expect(checked.state).toBe("ready");

  const report = await runModuleLocationRepair({
    ...fixture.options,
    apply: true,
    expectedFingerprint: checked.fingerprint,
    deps: {
      ...fixture.deps,
      renamePath: async () => { throw new Error("simulated rename failure"); },
    },
  });

  expect(report).toMatchObject({ state: "blocked", blockers: [{ code: "repair_rolled_back" }] });
  expect(existsSync(fixture.sourcePath)).toBe(true);
  expect(existsSync(fixture.targetPath)).toBe(false);
  expect(git(fixture.sourcePath, ["remote", "get-url", "origin"])).toBe(fixture.oldRemote);
});

test("rollback restores raw origin even when set-url reports failure after writing", async () => {
  const fixture = await repairFixture("origin-write-then-fail");
  const checked = await checkFixture(fixture);
  expect(checked.state).toBe("ready");
  let injected = false;

  const report = await runModuleLocationRepair({
    ...fixture.options,
    apply: true,
    expectedFingerprint: checked.fingerprint,
    deps: {
      ...fixture.deps,
      runGit: async (args, options) => {
        const result = await runGit(args, options);
        if (!injected && args[0] === "remote" && args[1] === "set-url") {
          injected = true;
          return { ...result, ok: false, exitCode: 1, stderr: "injected post-write failure" };
        }
        return result;
      },
    },
  });

  expect(report).toMatchObject({
    state: "blocked",
    blockers: [{ code: "repair_rolled_back" }],
    recovery: { status: "rolled_back" },
  });
  expect(existsSync(fixture.sourcePath)).toBe(true);
  expect(existsSync(fixture.targetPath)).toBe(false);
  expect(git(fixture.sourcePath, ["remote", "get-url", "origin"])).toBe(fixture.oldRemote);
});

test("explicit origin pushurl blocks before any fetch or mutation", async () => {
  const fixture = await repairFixture("pushurl");
  git(fixture.sourcePath, ["config", "--local", "remote.origin.pushurl", fixture.oldRemote]);

  const report = await checkFixture(fixture);

  expect(report).toMatchObject({
    state: "blocked",
    blockers: [{ code: "origin_pushurl_explicit" }],
  });
  expect(existsSync(fixture.targetPath)).toBe(false);
  expect(git(fixture.sourcePath, ["remote", "get-url", "origin"])).toBe(fixture.oldRemote);
  expect(git(fixture.sourcePath, ["remote", "get-url", "--push", "origin"])).toBe(fixture.oldRemote);
});

test("organization transfer preserves the checkout's local HTTPS transport", async () => {
  const fixture = await repairFixture("https-transport", { githubTransport: true });

  const checked = await checkFixture(fixture);

  expect(checked).toMatchObject({
    state: "ready",
    plan: {
      current_origin: "https://github.com/OldOrg/legacy.git",
      expected_origin: "https://github.com/NewOrg/canonical.git",
      manifest_origin: "git@github.com:NewOrg/canonical.git",
    },
  });
  const applied = await runModuleLocationRepair({
    ...fixture.options,
    apply: true,
    expectedFingerprint: checked.fingerprint,
    deps: fixture.deps,
  });
  expect(applied.state).toBe("repaired");
  expect(git(fixture.targetPath, ["remote", "get-url", "origin"]))
    .toBe("https://github.com/NewOrg/canonical.git");
});

test("a reviewed remote outside the Organization github_org boundary never authorizes repair", async () => {
  const fixture = await repairFixture("cross-org-boundary", { githubTransport: true });
  const companyPath = join(fixture.organizationRoot, "company.gen3.json");
  const manifestPath = join(fixture.organizationRoot, "modules.manifest.json");
  const company = await Bun.file(companyPath).json();
  const manifest = await Bun.file(manifestPath).json();
  company.company.github_org = "OtherOrg";
  manifest.github_org = "OtherOrg";
  await Promise.all([
    writeFile(companyPath, `${JSON.stringify(company, null, 2)}\n`),
    writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`),
  ]);
  publishOrganizationContract(fixture, "publish foreign owner contract");

  const report = await checkFixture(fixture);

  expect(report).toMatchObject({
    state: "blocked",
    blockers: [{ code: "organization_manifest_not_mutation_safe" }],
  });
  expect(report.blockers[0].message).toContain("organization_root_remote_owner_mismatch");
  expect(existsSync(fixture.sourcePath)).toBe(true);
  expect(existsSync(fixture.targetPath)).toBe(false);
  expect(git(fixture.sourcePath, ["remote", "get-url", "origin"])).toBe(fixture.oldRemote);
});

test("repository rename preserves the checkout's local SSH transport", async () => {
  const fixture = await repairFixture("ssh-transport", { githubTransport: "ssh" });

  const checked = await checkFixture(fixture);

  expect(checked).toMatchObject({
    state: "ready",
    plan: {
      current_origin: "git@github.com:OldOrg/legacy.git",
      expected_origin: "git@github.com:NewOrg/canonical.git",
      manifest_origin: "https://github.com/NewOrg/canonical.git",
    },
  });
  const applied = await runModuleLocationRepair({
    ...fixture.options,
    apply: true,
    expectedFingerprint: checked.fingerprint,
    deps: fixture.deps,
  });
  expect(applied.state).toBe("repaired");
  expect(git(fixture.targetPath, ["remote", "get-url", "origin"]))
    .toBe("git@github.com:NewOrg/canonical.git");
});

test("raw origin transport change invalidates a previously approved fingerprint", async () => {
  const fixture = await repairFixture("raw-origin-stale", { githubTransport: true });
  const checked = await checkFixture(fixture);
  expect(checked.state).toBe("ready");
  git(fixture.sourcePath, ["remote", "set-url", "origin", "git@github.com:OldOrg/legacy.git"]);

  const report = await runModuleLocationRepair({
    ...fixture.options,
    apply: true,
    expectedFingerprint: checked.fingerprint,
    deps: fixture.deps,
  });

  expect(report).toMatchObject({ state: "blocked", blockers: [{ code: "repair_plan_changed" }] });
  expect(existsSync(fixture.sourcePath)).toBe(true);
  expect(existsSync(fixture.targetPath)).toBe(false);
  expect(git(fixture.sourcePath, ["remote", "get-url", "origin"]))
    .toBe("git@github.com:OldOrg/legacy.git");
});

test("failed temporary-ref cleanup blocks apply and leaves the checkout untouched", async () => {
  const fixture = await repairFixture("ref-cleanup");
  const report = await checkModuleLocationRepair({
    ...fixture.options,
    deps: {
      ...fixture.deps,
      runGit: async (args, options) => args[0] === "update-ref" && args[1] === "-d"
        ? { ok: false, exitCode: 1, timedOut: false, stdout: "", stderr: "injected cleanup failure" }
        : runGit(args, options),
    },
  });

  expect(report).toMatchObject({
    state: "blocked",
    blockers: [{ code: "temporary_ref_cleanup_failed" }],
  });
  expect(report.plan.temporary_ref).toMatch(/^refs\/lazurio\/repair\//u);
  expect(existsSync(fixture.sourcePath)).toBe(true);
  expect(existsSync(fixture.targetPath)).toBe(false);
});

test("case-only rename uses an intermediate path and preserves exact target casing", async () => {
  const fixture = await repairFixture("case-only", { sourceName: "Studio", targetName: "studio" });
  const checked = await checkFixture(fixture);
  expect(checked.state).toBe("ready");

  const applied = await runModuleLocationRepair({
    ...fixture.options,
    apply: true,
    expectedFingerprint: checked.fingerprint,
    deps: fixture.deps,
  });

  expect(applied.state).toBe("repaired");
  const entries = await readdir(fixture.workspaceRoot);
  expect(entries).not.toContain("Studio");
  expect(entries).toContain("studio");
  // GitHub repository coordinates are case-insensitive, so a path-only
  // case correction does not rewrite an otherwise equivalent transport URL.
  expect(git(fixture.targetPath, ["remote", "get-url", "origin"])).toBe(fixture.oldRemote);
});

test("stranded case-only temporary checkout reports an exact recovery path and restores origin", async () => {
  const fixture = await repairFixture("case-only-stranded", { sourceName: "Studio", targetName: "studio" });
  const checked = await checkFixture(fixture);
  expect(checked.state).toBe("ready");
  let renameCalls = 0;

  const report = await runModuleLocationRepair({
    ...fixture.options,
    apply: true,
    expectedFingerprint: checked.fingerprint,
    deps: {
      ...fixture.deps,
      renamePath: async (from, to) => {
        renameCalls += 1;
        if (renameCalls === 1) return rename(from, to);
        throw new Error(`injected rename failure ${renameCalls}`);
      },
    },
  });

  expect(report).toMatchObject({
    state: "blocked",
    blockers: [{ code: "repair_recovery_required" }],
    recovery: {
      status: "recovery_required",
      expected_original_path: fixture.sourcePath,
      expected_original_origin: fixture.oldRemote,
    },
  });
  expect(report.recovery.checkout_path).toContain(".Studio.lazurio-relocate-");
  expect(existsSync(report.recovery.checkout_path)).toBe(true);
  expect(git(report.recovery.checkout_path, ["remote", "get-url", "origin"]))
    .toBe(fixture.oldRemote);
  const human = renderHumanModuleLocationRepair(report);
  expect(human).toContain(`Checkout pro recovery: ${report.recovery.checkout_path}`);
  expect(human).toContain(`Dočasná cesta: ${report.recovery.temporary_path}`);
});

test("target created after check is never overwritten and repair restores the source checkout", async () => {
  const fixture = await repairFixture("target-race");
  const checked = await checkFixture(fixture);
  expect(checked.state).toBe("ready");
  const sentinel = join(fixture.targetPath, "sentinel.txt");
  let injected = false;

  const report = await runModuleLocationRepair({
    ...fixture.options,
    apply: true,
    expectedFingerprint: checked.fingerprint,
    deps: {
      ...fixture.deps,
      runGit: async (args, options) => {
        const result = await runGit(args, options);
        if (!injected && result.ok && args[0] === "remote" && args[1] === "set-url") {
          injected = true;
          await mkdir(fixture.targetPath, { recursive: true });
          await writeFile(sentinel, "external data\n");
        }
        return result;
      },
    },
  });

  expect(report).toMatchObject({
    state: "blocked",
    blockers: [{ code: "repair_rolled_back" }],
    recovery: { status: "rolled_back" },
  });
  expect(await readFile(sentinel, "utf8")).toBe("external data\n");
  expect(existsSync(fixture.sourcePath)).toBe(true);
  expect(git(fixture.sourcePath, ["remote", "get-url", "origin"])).toBe(fixture.oldRemote);
});

fileSymlinkTest("symlinked module marker is an unverified suspect and never authorizes repair [requires file symlink capability]", async () => {
  const fixture = await repairFixture("marker-symlink", { sourceName: "studio" });
  const markerPath = join(fixture.sourcePath, "lazurio.module.json");
  const realMarkerPath = join(fixture.sourcePath, "lazurio.module.real.json");
  await rename(markerPath, realMarkerPath);
  await symlink("lazurio.module.real.json", markerPath, "file");

  const report = await checkFixture(fixture);

  expect(report).toMatchObject({
    state: "blocked",
    blockers: [{ code: "checkout_unverified" }],
    plan: {
      unverified_suspects: [{
        path: fixture.sourcePath,
        reason: "marker_symlink",
      }],
    },
  });
  expect(existsSync(fixture.targetPath)).toBe(false);
});

test("template organization cannot authorize a repair", async () => {
  const fixture = await repairFixture("template");
  const companyPath = join(fixture.organizationRoot, "company.gen3.json");
  const company = JSON.parse(await readFile(companyPath, "utf8"));
  company.organization_kind = "template";
  await writeFile(companyPath, `${JSON.stringify(company, null, 2)}\n`);

  const report = await checkFixture(fixture);

  expect(report).toMatchObject({ state: "blocked", blockers: [{ code: "organization_template" }] });
  expect(existsSync(fixture.sourcePath)).toBe(true);
});

test("symlinked alternate mount container blocks the entire repair scan", async () => {
  const fixture = await repairFixture("container-symlink", { targetContainer: "modules" });
  const outsideWorkspace = join(fixture.sandbox, "outside-workspace");
  await rename(fixture.workspaceRoot, outsideWorkspace);
  await symlink(
    outsideWorkspace,
    fixture.workspaceRoot,
    process.platform === "win32" ? "junction" : "dir",
  );

  const report = await checkFixture(fixture);

  expect(report).toMatchObject({
    state: "blocked",
    blockers: [{ code: "checkout_scan_boundary_invalid" }],
    plan: { boundary_errors: [{ container: "workspace", code: "container_boundary_invalid" }] },
  });
  expect(existsSync(fixture.targetPath)).toBe(false);
});

test("conflicting manifest aliases block before repair can choose a remote or branch", async () => {
  const fixture = await repairFixture("alias-conflict", { githubTransport: "ssh" });
  const manifestPath = join(fixture.organizationRoot, "modules.manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.module_slots[0].repo = "git@github.com:OldOrg/canonical.git";
  manifest.module_slots[0].branch = "feature";
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  publishOrganizationContract(fixture, "publish conflicting aliases");

  const report = await checkFixture(fixture);

  expect(report).toMatchObject({
    state: "blocked",
    blockers: [{ code: "module_declaration_invalid" }],
  });
  expect(existsSync(fixture.sourcePath)).toBe(true);
  expect(existsSync(fixture.targetPath)).toBe(false);
  expect(git(fixture.sourcePath, ["remote", "get-url", "origin"])).toBe(fixture.oldRemote);
});

test("an unreadable target is never treated as absent and blocks before any mutation", async () => {
  const fixture = await repairFixture("target-unreadable");
  const baseRunGit = fixture.deps.runGit ?? runGit;
  let originMutations = 0;
  let renames = 0;
  const report = await runModuleLocationRepair({
    ...fixture.options,
    apply: true,
    expectedFingerprint: `sha256:${"0".repeat(64)}`,
    deps: {
      ...fixture.deps,
      lstatPath: async (path) => {
        if (path === fixture.targetPath) {
          const error = new Error("permission denied");
          error.code = "EACCES";
          throw error;
        }
        return lstat(path);
      },
      runGit: async (args, options) => {
        if (args[0] === "remote" && args[1] === "set-url") originMutations += 1;
        return baseRunGit(args, options);
      },
      renamePath: async () => {
        renames += 1;
        throw new Error("rename must not run");
      },
    },
  });

  expect(report).toMatchObject({
    state: "blocked",
    blockers: [{ code: "target_unreadable" }],
  });
  expect(originMutations).toBe(0);
  expect(renames).toBe(0);
  expect(existsSync(fixture.sourcePath)).toBe(true);
  expect(existsSync(fixture.targetPath)).toBe(false);
});

test("cross-file Organization slug drift blocks before fetch, origin mutation or rename", async () => {
  const fixture = await repairFixture("organization-slug-drift");
  const manifestPath = join(fixture.organizationRoot, "modules.manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.company = "OtherCo";
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  publishOrganizationContract(fixture, "publish cross-file slug drift");
  const baseRunGit = fixture.deps.runGit ?? runGit;
  let targetFetches = 0;
  let originMutations = 0;
  let renames = 0;

  const report = await runModuleLocationRepair({
    ...fixture.options,
    apply: true,
    expectedFingerprint: `sha256:${"0".repeat(64)}`,
    deps: {
      ...fixture.deps,
      runGit: async (args, options) => {
        if (options?.cwd === fixture.sourcePath && args[0] === "fetch") targetFetches += 1;
        if (options?.cwd === fixture.sourcePath && args[0] === "remote" && args[1] === "set-url") {
          originMutations += 1;
        }
        return baseRunGit(args, options);
      },
      renamePath: async () => {
        renames += 1;
        throw new Error("rename must not run");
      },
    },
  });

  expect(report).toMatchObject({
    state: "blocked",
    blockers: [{ code: "organization_manifest_not_mutation_safe" }],
  });
  expect(targetFetches).toBe(0);
  expect(originMutations).toBe(0);
  expect(renames).toBe(0);
  expect(existsSync(fixture.sourcePath)).toBe(true);
  expect(existsSync(fixture.targetPath)).toBe(false);
});

async function checkFixture(fixture) {
  return checkModuleLocationRepair({ ...fixture.options, deps: fixture.deps });
}

async function addSiblingDeclaration(fixture, { slug, path, remote }) {
  const companyPath = join(fixture.organizationRoot, "company.gen3.json");
  const manifestPath = join(fixture.organizationRoot, "modules.manifest.json");
  const company = JSON.parse(await readFile(companyPath, "utf8"));
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  company.modules.push({ slug, path, repo: remote });
  manifest.module_slots.push({
    slug,
    path,
    git: { url: remote, branch: "main" },
  });
  await writeFile(companyPath, `${JSON.stringify(company, null, 2)}\n`);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  publishOrganizationContract(fixture, `declare sibling ${slug}`);
}

async function runInstrumentedApply(fixture, activity) {
  const baseRunGit = fixture.deps.runGit ?? runGit;
  return runModuleLocationRepair({
    ...fixture.options,
    apply: true,
    expectedFingerprint: `sha256:${"0".repeat(64)}`,
    deps: {
      ...fixture.deps,
      runGit: async (args, options) => {
        if (options?.cwd === fixture.sourcePath && args[0] === "fetch") {
          activity.targetFetches += 1;
        }
        if (options?.cwd === fixture.sourcePath && args[0] === "remote" && args[1] === "set-url") {
          activity.originMutations += 1;
        }
        return baseRunGit(args, options);
      },
      renamePath: async () => {
        activity.renames += 1;
        throw new Error("rename must not run");
      },
    },
  });
}

function publishOrganizationContract(fixture, message) {
  git(fixture.organizationRoot, ["add", "company.gen3.json", "modules.manifest.json"]);
  git(fixture.organizationRoot, ["commit", "-m", message]);
  git(fixture.organizationRoot, ["push", "origin", "main"]);
  git(fixture.organizationRoot, ["fetch", "origin", "main"]);
}

async function repairFixture(name, {
  sourceName = "legacy",
  targetName = "canonical",
  targetContainer = "workspace",
  githubTransport = false,
} = {}) {
  const sandbox = await mkdtemp(join(tmpdir(), `lazurio-module-location-${name}-`));
  cleanup.push(sandbox);
  const rootPath = join(sandbox, "Lazurio");
  const organizationRoot = join(rootPath, "organizations", "TestCo_GEN3");
  const workspaceRoot = join(organizationRoot, "workspace");
  const targetContainerPath = join(organizationRoot, targetContainer);
  const sourcePath = join(workspaceRoot, sourceName);
  const targetPath = join(targetContainerPath, targetName);
  const oldBareRemote = join(sandbox, `${name}-old.git`);
  const newBareRemote = join(sandbox, `${name}-new.git`);
  const organizationBareRemote = join(sandbox, `${name}-organization.git`);
  const oldRemote = githubTransport === "ssh"
    ? `git@github.com:OldOrg/${sourceName}.git`
    : githubTransport
      ? `https://github.com/OldOrg/${sourceName}.git`
      : oldBareRemote;
  const manifestRemote = githubTransport === "ssh"
    ? `https://github.com/NewOrg/${targetName}.git`
    : githubTransport
      ? `git@github.com:NewOrg/${targetName}.git`
      : newBareRemote;
  const plannedNewRemote = githubTransport === "ssh"
    ? `git@github.com:NewOrg/${targetName}.git`
    : githubTransport
      ? `https://github.com/NewOrg/${targetName}.git`
      : newBareRemote;
  const seed = join(sandbox, "seed");
  await mkdir(workspaceRoot, { recursive: true });
  await mkdir(targetContainerPath, { recursive: true });
  git(sandbox, ["init", "--bare", oldBareRemote]);
  git(sandbox, ["init", "--bare", newBareRemote]);
  git(sandbox, ["init", "--bare", organizationBareRemote]);
  git(sandbox, ["init", seed]);
  configure(seed);
  git(seed, ["switch", "-c", "main"]);
  await writeFile(join(seed, "README.md"), "# fixture\n");
  await writeFile(join(seed, "lazurio.module.json"), `${JSON.stringify({
    schema_version: "lazurio.module.v1",
    id: "studio",
    company: "TestCo",
  }, null, 2)}\n`);
  git(seed, ["add", "."]);
  git(seed, ["commit", "-m", "initial"]);
  git(seed, ["remote", "add", "old", oldBareRemote]);
  git(seed, ["remote", "add", "new", newBareRemote]);
  git(seed, ["push", "old", "main"]);
  git(seed, ["push", "new", "main"]);
  git(sandbox, ["--git-dir", oldBareRemote, "symbolic-ref", "HEAD", "refs/heads/main"]);
  git(sandbox, ["--git-dir", newBareRemote, "symbolic-ref", "HEAD", "refs/heads/main"]);
  git(workspaceRoot, ["clone", oldBareRemote, sourcePath]);
  configure(sourcePath);
  if (githubTransport) git(sourcePath, ["remote", "set-url", "origin", oldRemote]);

  const targetRelativePath = `${targetContainer}/${targetName}`;
  const targetOwner = githubTransport ? "NewOrg" : "fixture";
  const organizationRepository = `${targetOwner}/TestCo`;

  await writeFile(join(organizationRoot, "company.gen3.json"), `${JSON.stringify({
    organization_generation: "gen3",
    schema_version: "company.gen3.v3",
    company: {
      slug: "TestCo",
      github_org: targetOwner,
      repository: `git@github.com:${organizationRepository}.git`,
      root_repository: organizationRepository,
      default_branch: "main",
    },
    modules: [{ slug: "studio", path: targetRelativePath, repo: manifestRemote }],
  }, null, 2)}\n`);
  await writeFile(join(organizationRoot, "modules.manifest.json"), `${JSON.stringify({
    schema_version: "modules.manifest.v3",
    company: "TestCo",
    github_org: targetOwner,
    module_slots: [{
      slug: "studio",
      path: targetRelativePath,
      git: { url: manifestRemote, branch: "main" },
    }],
  }, null, 2)}\n`);
  await writeFile(join(organizationRoot, ".gitignore"), "workspace\nmodules\nproductionspace\n");
  git(organizationRoot, ["init"]);
  configure(organizationRoot);
  git(organizationRoot, ["switch", "-c", "main"]);
  git(organizationRoot, ["add", ".gitignore", "company.gen3.json", "modules.manifest.json"]);
  git(organizationRoot, ["commit", "-m", "reviewed Organization contract"]);
  git(organizationRoot, ["remote", "add", "origin", organizationBareRemote]);
  git(organizationRoot, ["push", "--set-upstream", "origin", "main"]);
  git(sandbox, ["--git-dir", organizationBareRemote, "symbolic-ref", "HEAD", "refs/heads/main"]);

  const repositoryCoordinate = (remote) => {
    const github = githubRepositoryCoordinate(remote);
    if (github) return github;
    if (String(remote) === organizationBareRemote) {
      return { owner: targetOwner, repository: "TestCo", ownerRepo: organizationRepository };
    }
    if (String(remote) === newBareRemote) return { owner: "fixture", repository: targetName };
    if (String(remote) === oldBareRemote) return { owner: "fixture", repository: sourceName };
    const repository = basename(String(remote)).replace(/\.git$/u, "");
    return repository ? { owner: "fixture", repository } : null;
  };
  const mappedGithubRunGit = async (args, options) => {
    const mappedArgs = [...args];
    if (mappedArgs[0] === "fetch") {
      const separator = mappedArgs.indexOf("--");
      const remoteIndex = separator + 1;
      const remote = String(mappedArgs[remoteIndex] ?? "");
      if (/github\.com[/:]NewOrg\//iu.test(remote)) mappedArgs[remoteIndex] = newBareRemote;
      if (/github\.com[/:]OldOrg\//iu.test(remote)) mappedArgs[remoteIndex] = oldBareRemote;
    }
    return runGit(mappedArgs, options);
  };
  return {
    sandbox,
    rootPath,
    organizationRoot,
    workspaceRoot,
    sourcePath,
    targetPath,
    oldRemote,
    newRemote: plannedNewRemote,
    manifestRemote,
    oldBareRemote,
    newBareRemote,
    organizationBareRemote,
    options: { rootPath, organizationSlug: "TestCo", moduleSlug: "studio" },
    deps: {
      repositoryCoordinate,
      ...(githubTransport ? { runGit: mappedGithubRunGit } : {}),
      acquireLock: async () => ({ release: async () => {} }),
    },
  };
}

function configure(cwd) {
  git(cwd, ["config", "user.name", "Lazurio Test"]);
  git(cwd, ["config", "user.email", "lazurio@example.test"]);
}

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}
