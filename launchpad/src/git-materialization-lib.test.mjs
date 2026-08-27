import { afterAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runGit, runGitInPinnedTemporaryChild } from "../../lazurio/runtime/git-lib.mjs";
import { materializeRepoCheckout } from "../../lazurio/runtime/git-materialization-lib.mjs";
import { buildGitInventory } from "../../lazurio/runtime/git-inventory-lib.mjs";
import {
  createLaunchpadGitFixture,
  initGitRepo,
  writeJson,
} from "./git-fixture-helpers.test.mjs";

const tempRoots = [];

afterAll(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
});

test("materializes an active manifest slot on its exact repository and branch", async () => {
  const root = await createLaunchpadGitFixture();
  tempRoots.push(root);
  const organizationRoot = join(root, "organizations", "BetaCo_GEN3");
  await prepareOrganizationRoot(organizationRoot);
  const remote = join(root, "remotes", "lazurio.git");
  const declaredRemote = "git@github.com:BetaCo/lazurio.git";
  await mkdir(join(root, "sources"), { recursive: true });
  await initGitRepo(join(root, "sources", "lazurio"), { remotePath: remote });
  await writeJson(join(organizationRoot, "modules.manifest.json"), {
    organization_generation: "gen3",
    company: "BetaCo",
    github_org: "BetaCo",
    module_slots: [
      {
        path: "workspace/lazurio",
        teams: ["lazurio"],
        git: { url: declaredRemote, branch: "main" },
      },
    ],
  });
  const inventory = await buildGitInventory({ companiesRoot: root });
  const repo = inventory.repos.find((entry) => entry.key === "BetaCo::lazurio");

  const result = await materializeRepoCheckout({
    companiesRoot: root,
    repo,
    deps: {
      run: fixtureRemoteRunner({ declaredRemote, actualRemote: remote }),
      runPinnedChild: fixturePinnedRemoteRunner({ declaredRemote, actualRemote: remote }),
    },
  });

  expect(result).toMatchObject({
    ok: true,
    outcome: "materialized",
    branch: "main",
    remote: declaredRemote,
  });
  expect(result.head).toMatch(/^[0-9a-f]{40}$/);
  expect(await readFile(join(organizationRoot, "workspace", "lazurio", "README.md"), "utf8"))
    .toContain("# main");
});

test("treats an inaccessible manifest repository as missing_access and leaves no partial checkout", async () => {
  const root = await createLaunchpadGitFixture();
  tempRoots.push(root);
  const organizationRoot = join(root, "organizations", "BetaCo_GEN3");
  await prepareOrganizationRoot(organizationRoot);
  const target = join(organizationRoot, "workspace", "private-module");
  const declaredRemote = "git@github.com:BetaCo/private-module.git";
  const actualRemote = join(root, "remotes", "not-accessible.git");
  await writeJson(join(organizationRoot, "modules.manifest.json"), {
    organization_generation: "gen3",
    company: "BetaCo",
    github_org: "BetaCo",
    module_slots: [
      {
        path: "workspace/private-module",
        git: { url: declaredRemote, branch: "main" },
      },
    ],
  });
  const inventory = await buildGitInventory({ companiesRoot: root });
  const repo = inventory.repos.find((entry) => entry.key === "BetaCo::private-module");

  const result = await materializeRepoCheckout({
    companiesRoot: root,
    repo,
    deps: { run: fixtureRemoteRunner({ declaredRemote, actualRemote }) },
  });

  expect(result).toMatchObject({
    ok: false,
    outcome: "missing_access",
    code: "materialization_source_unavailable",
  });
  expect(existsSync(target)).toBe(false);
  const workspaceEntries = existsSync(join(organizationRoot, "workspace"))
    ? await readdir(join(organizationRoot, "workspace"))
    : [];
  expect(workspaceEntries.some((entry) => entry.includes(".materialize-"))).toBe(false);
});

test("refuses a target that does not exactly match the manifest inventory boundary", async () => {
  const root = await createLaunchpadGitFixture();
  tempRoots.push(root);
  const outside = join(root, "outside");
  const result = await materializeRepoCheckout({
    companiesRoot: root,
    repo: {
      organization: "BetaCo",
      organization_path: "organizations/BetaCo_GEN3",
      repo_kind: "module",
      slot_path: "workspace/lazurio",
      absolute_path: outside,
      expected_branch: "main",
      repo: "git@github.com:BetaCo/lazurio.git",
    },
  });

  expect(result).toMatchObject({
    ok: false,
    outcome: "failed",
    code: "materialization_path_forbidden",
  });
  expect(existsSync(outside)).toBe(false);
});

test("does not overwrite a target claimed by a concurrent materialization", async () => {
  const root = await createLaunchpadGitFixture();
  tempRoots.push(root);
  const organizationRoot = join(root, "organizations", "BetaCo_GEN3");
  await prepareOrganizationRoot(organizationRoot);
  const remote = join(root, "remotes", "shared.git");
  const declaredRemote = "git@github.com:BetaCo/shared.git";
  await mkdir(join(root, "sources"), { recursive: true });
  await initGitRepo(join(root, "sources", "shared"), { remotePath: remote });
  await writeJson(join(organizationRoot, "modules.manifest.json"), {
    organization_generation: "gen3",
    company: "BetaCo",
    github_org: "BetaCo",
    module_slots: [
      {
        path: "workspace/shared",
        git: { url: declaredRemote, branch: "main" },
      },
    ],
  });
  const inventory = await buildGitInventory({ companiesRoot: root });
  const repo = inventory.repos.find((entry) => entry.key === "BetaCo::shared");
  const target = join(organizationRoot, "workspace", "shared");

  const result = await materializeRepoCheckout({
    companiesRoot: root,
    repo,
    deps: {
      run: fixtureRemoteRunner({ declaredRemote, actualRemote: remote }),
      runPinnedChild: fixturePinnedRemoteRunner({ declaredRemote, actualRemote: remote }),
      publish: async () => {
        await mkdir(target);
        await writeFile(join(target, "owned-by-other-update"), "keep\n");
        return { ok: false, code: "target_exists" };
      },
    },
  });

  expect(result).toMatchObject({
    ok: false,
    outcome: "target_exists",
    code: "materialization_target_exists",
  });
  expect(await readFile(join(target, "owned-by-other-update"), "utf8")).toBe("keep\n");
});

test("clone failure leaves no partial final target or staging directory", async () => {
  const root = await createLaunchpadGitFixture();
  tempRoots.push(root);
  const organizationRoot = join(root, "organizations", "BetaCo_GEN3");
  await prepareOrganizationRoot(organizationRoot);
  const remote = join(root, "remotes", "broken-clone.git");
  const declaredRemote = "git@github.com:BetaCo/broken-clone.git";
  await mkdir(join(root, "sources"), { recursive: true });
  await initGitRepo(join(root, "sources", "broken-clone"), { remotePath: remote });
  await writeJson(join(organizationRoot, "modules.manifest.json"), {
    organization_generation: "gen3",
    company: "BetaCo",
    github_org: "BetaCo",
    module_slots: [
      {
        path: "workspace/broken-clone",
        git: { url: declaredRemote, branch: "main" },
      },
    ],
  });
  const inventory = await buildGitInventory({ companiesRoot: root });
  const repo = inventory.repos.find((entry) => entry.key === "BetaCo::broken-clone");
  const target = join(organizationRoot, "workspace", "broken-clone");

  const result = await materializeRepoCheckout({
    companiesRoot: root,
    repo,
    deps: {
      run: fixtureRemoteRunner({ declaredRemote, actualRemote: remote }),
      runPinnedChild: async () => ({
        ok: false,
        code: "git_command_failed",
        stdout: "",
        stderr: "simulated clone failure",
      }),
    },
  });

  expect(result).toMatchObject({
    ok: false,
    outcome: "failed",
    code: "materialization_clone_failed",
  });
  expect(existsSync(target)).toBe(false);
  expect((await readdir(join(organizationRoot, "workspace"))).filter((name) => name.includes("lazurio-update"))).toEqual([]);
});

async function prepareOrganizationRoot(organizationRoot) {
  await writeFile(join(organizationRoot, ".gitignore"), "/workspace/*/\n");
  await initGitRepo(organizationRoot);
}

function fixtureRemoteRunner({ declaredRemote, actualRemote, failClone = false }) {
  return async (args, options) => {
    if (failClone && args[0] === "clone") {
      return { ok: false, exitCode: 1, timedOut: false, stdout: "", stderr: "simulated clone failure" };
    }
    const mappedArgs = args.map((value) => value === declaredRemote ? actualRemote : value);
    const result = await runGit(mappedArgs, options);
    if (result.ok && args[0] === "clone") {
      const stagingPath = args.at(-1);
      const restored = await runGit(["remote", "set-url", "origin", declaredRemote], {
        cwd: stagingPath,
      });
      if (!restored.ok) return restored;
    }
    return result;
  };
}

function fixturePinnedRemoteRunner({ declaredRemote, actualRemote }) {
  return async (args, options) => {
    const mappedArgs = args.map((value) => value === declaredRemote ? actualRemote : value);
    const result = await runGitInPinnedTemporaryChild(mappedArgs, options);
    if (result.ok && args[0] === "clone") {
      const stagingPath = join(options.cwd, result.child_name);
      const restored = await runGit(["remote", "set-url", "origin", declaredRemote], {
        cwd: stagingPath,
      });
      if (!restored.ok) return restored;
    }
    return result;
  };
}
