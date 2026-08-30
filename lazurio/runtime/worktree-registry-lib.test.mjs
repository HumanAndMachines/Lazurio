import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildRegisteredWorktreeIndex,
  classifyWorktreeCleanup,
  parseGitWorktreePorcelain,
} from "./worktree-registry-lib.mjs";

const tempRoots = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((path) =>
    rm(path, { recursive: true, force: true })
  ));
});

test("parses NUL-delimited Git worktree records without losing spaces", () => {
  const records = parseGitWorktreePorcelain(
    "worktree /tmp/primary checkout\0HEAD aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\0branch refs/heads/main\0\0"
    + "worktree /tmp/feature checkout\0HEAD bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\0branch refs/heads/DEV-0001-feature\0locked maintenance\0\0",
  );

  expect(records).toEqual([
    {
      path: "/tmp/primary checkout",
      head: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      branch: "main",
      detached: false,
      locked: false,
      prunable: false,
    },
    {
      path: "/tmp/feature checkout",
      head: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      branch: "DEV-0001-feature",
      detached: false,
      locked: "maintenance",
      prunable: false,
    },
  ]);
});

test("cleanup classifier needs explicit PR refresh and fails closed on unsafe evidence", () => {
  const base = cleanupReadyWorktree();

  expect(classifyWorktreeCleanup(base)).toMatchObject({
    classification: "not_refreshed",
    blockers: ["github_pr_evidence_not_refreshed"],
  });
  expect(classifyWorktreeCleanup({
    ...base,
    dirty: true,
    github_evidence: mergedPullRequestEvidence(base.head),
  }, { refreshRequested: true })).toMatchObject({
    classification: "needs_attention",
    blockers: ["dirty_worktree"],
  });
  expect(classifyWorktreeCleanup({
    ...base,
    github_evidence: {
      ...freshGitHubEvidence(),
      head_preserved: true,
      pull_request: { state: "OPEN", head: base.head },
    },
  }, { refreshRequested: true })).toMatchObject({
    classification: "active",
    blockers: ["exact_head_pr_open"],
  });
  expect(classifyWorktreeCleanup({
    ...base,
    github_evidence: {
      ...freshGitHubEvidence(),
      remote_branch_exists: false,
    },
  }, { refreshRequested: true })).toMatchObject({
    classification: "needs_attention",
    blockers: ["remote_branch_deleted_without_exact_merged_pr"],
  });
  expect(classifyWorktreeCleanup({
    ...base,
    base_head: base.head,
    github_evidence: {
      ...freshGitHubEvidence(),
      remote_branch_exists: false,
    },
  }, { refreshRequested: true })).toMatchObject({
    classification: "candidate",
    reason: "deleted_branch_without_changes",
  });
  expect(classifyWorktreeCleanup({
    ...base,
    github_evidence: { status: "unavailable", reason: "github_auth_required" },
  }, { refreshRequested: true })).toMatchObject({
    classification: "needs_attention",
    blockers: ["github_auth_required"],
  });
});

test("registry inventory excludes primary checkout, stays offline by default and only dry-runs an exact merged PR", async () => {
  const root = await mkdtemp(join(tmpdir(), "lazurio worktree registry "));
  tempRoots.push(root);
  git(root, ["init", "-b", "main"]);
  git(root, ["config", "user.name", "Fixture"]);
  git(root, ["config", "user.email", "fixture@example.com"]);
  await writeFile(join(root, "README.md"), "# Fixture\n");
  git(root, ["add", "README.md"]);
  git(root, ["commit", "-m", "initial"]);
  git(root, ["remote", "add", "origin", "https://github.com/Example/repository.git"]);

  const slug = "DEV-0001-registry-contract";
  const worktreePath = join(root, ".worktrees", "root", slug);
  await mkdir(join(root, ".worktrees", "root"), { recursive: true });
  git(root, ["worktree", "add", "-b", slug, worktreePath]);
  await writeFile(
    `${worktreePath}.worktree.json`,
    `${JSON.stringify({
      schema_version: "companiesascode.worktree.v1",
      branch: slug,
      mission_control_plan_code: "DEV-0001",
      mission_control_plan_path: "data/mission-control/plans/2026/08/DEV-0001-registry-contract.yaml",
      worktree_path: `.worktrees/root/${slug}`,
      base_branch: "main",
    }, null, 2)}\n`,
  );
  const head = gitOutput(worktreePath, ["rev-parse", "HEAD"]);
  let providerCalls = 0;
  const provider = {
    available: true,
    json: () => {
      providerCalls += 1;
      return {
        ok: true,
        value: {
          data: {
            q0: {
              object: {
                oid: head,
                associatedPullRequests: {
                  nodes: [{
                    number: 7,
                    url: "https://github.com/Example/repository/pull/7",
                    state: "MERGED",
                    mergedAt: "2026-08-30T10:00:00Z",
                    closedAt: "2026-08-30T10:00:00Z",
                    isDraft: false,
                    baseRefName: "main",
                    headRefName: slug,
                    headRefOid: head,
                  }],
                },
              },
              ref: null,
            },
          },
        },
      };
    },
  };

  const local = await buildRegisteredWorktreeIndex({
    companiesRoot: root,
    githubProvider: provider,
  });
  expect(providerCalls).toBe(0);
  expect(local).toMatchObject({
    owner_registries: 1,
    primary_checkouts: 1,
    summary: { registered_worktrees: 1, cleanup_not_refreshed: 1 },
  });
  expect(local.worktrees[0]).toMatchObject({
    absolute_path: realpathSync(worktreePath),
    path_class: "canonical_root",
    sidecar_hint_valid: true,
    cleanup_dry_run: { classification: "not_refreshed" },
  });

  const refreshed = await buildRegisteredWorktreeIndex({
    companiesRoot: root,
    refreshPullRequests: true,
    githubProvider: provider,
    now: () => new Date("2026-08-30T11:00:00Z"),
  });
  expect(providerCalls).toBe(1);
  expect(refreshed.summary).toMatchObject({
    registered_worktrees: 1,
    cleanup_candidates: 1,
  });
  expect(refreshed.worktrees[0]).toMatchObject({
    head,
    github_evidence: {
      status: "fresh",
      head_preserved: true,
      pull_request: { number: 7, state: "MERGED", head },
    },
    cleanup_dry_run: {
      classification: "candidate",
      apply_guards_required: ["runtime_not_using_path", "no_active_writer"],
    },
  });
  expect(existsSync(worktreePath)).toBe(true);
  expect(gitOutput(root, ["worktree", "list", "--porcelain"])).toContain(worktreePath);
});

function cleanupReadyWorktree(overrides = {}) {
  return {
    exists: true,
    prunable: false,
    locked: false,
    detached: false,
    branch: "DEV-0001-feature",
    local_status_known: true,
    dirty: false,
    outgoing: 0,
    operation: null,
    sidecar_exists: true,
    sidecar_hint_valid: true,
    head: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    base_head: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    github_evidence: null,
    ...overrides,
  };
}

function freshGitHubEvidence() {
  return {
    status: "fresh",
    reason: null,
    remote_branch_exists: null,
    remote_branch_head: null,
    head_preserved: false,
    pull_request: null,
  };
}

function mergedPullRequestEvidence(head) {
  return {
    ...freshGitHubEvidence(),
    head_preserved: true,
    pull_request: {
      state: "MERGED",
      head,
    },
  };
}

function git(cwd, args) {
  const result = Bun.spawnSync(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GCM_INTERACTIVE: "never",
    },
  });
  if (result.exitCode !== 0) {
    throw new Error(new TextDecoder().decode(result.stderr));
  }
}

function gitOutput(cwd, args) {
  const result = Bun.spawnSync(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(new TextDecoder().decode(result.stderr));
  }
  return new TextDecoder().decode(result.stdout).trim();
}
