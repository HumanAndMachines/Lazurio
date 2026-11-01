import { afterEach, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createReviewCheckout,
  parseGitHubRemote,
  parsePullRequestUrl,
  planCodeOfPullRequest,
  removeReviewCheckout,
} from "./worktree-review.mjs";

const cleanupPaths = [];
afterEach(async () => {
  for (const path of cleanupPaths.splice(0)) await rm(path, { recursive: true, force: true });
});

const repository = { owner: "TestProvider", repo: "Dashboard" };

function git(cwd, args) {
  const result = Bun.spawnSync(["git", "-C", cwd, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: {
      PATH: process.env.PATH,
      HOME: cwd,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "Review Test",
      GIT_AUTHOR_EMAIL: "review@example.invalid",
      GIT_COMMITTER_NAME: "Review Test",
      GIT_COMMITTER_EMAIL: "review@example.invalid",
    },
  });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}

async function fixture() {
  const sandbox = await mkdtemp(join(tmpdir(), "worktree review "));
  cleanupPaths.push(sandbox);
  const root = join(sandbox, "Dashboard");
  git(sandbox, ["init", "-q", "-b", "main", root]);
  await writeFile(join(root, "README.md"), "fixture\n");
  await writeFile(join(root, ".gitignore"), "node_modules/\n");
  git(root, ["add", "README.md", ".gitignore"]);
  git(root, ["commit", "-q", "-m", "fixture"]);
  return { root, head: git(root, ["rev-parse", "HEAD"]) };
}

function pullRequest(head, overrides = {}) {
  return {
    url: "https://github.com/TestProvider/Dashboard/pull/7",
    headSha: head,
    headRefName: "agent/DEV-6632-review-checkout",
    title: "Worktrees: review checkouts (DEV-6632)",
    ...overrides,
  };
}

test("reads the plan code from the branch first, then from the title", () => {
  expect(planCodeOfPullRequest({ headRefName: "agent/DEV-6632-review-checkout", title: "x (CAC-0001)" })).toBe("DEV-6632");
  expect(planCodeOfPullRequest({ headRefName: "codex/DEV-6628-browser-previews" })).toBe("DEV-6628");
  expect(planCodeOfPullRequest({ headRefName: "fix-typo", title: "infra: a row (DEV-6671, Draft)" })).toBe("DEV-6671");
  expect(planCodeOfPullRequest({ headRefName: "fix-typo", title: "no plan here" })).toBeNull();
});

test("parses pull request URLs and GitHub remotes", () => {
  expect(parsePullRequestUrl("https://github.com/HumanAndMachines/Lazurio/pull/696")).toMatchObject({
    owner: "HumanAndMachines",
    repo: "Lazurio",
    number: 696,
  });
  expect(parsePullRequestUrl("https://github.com/HumanAndMachines/Lazurio/issues/696")).toBeNull();
  expect(parseGitHubRemote("git@github.com:HumanAndMachines/Lazurio.git")).toEqual({ owner: "HumanAndMachines", repo: "Lazurio" });
  expect(parseGitHubRemote("https://github.com/HumanAndMachines/Lazurio")).toEqual({ owner: "HumanAndMachines", repo: "Lazurio" });
  expect(parseGitHubRemote("/tmp/remote.git")).toBeNull();
});

test("creates a detached checkout of the exact head with a sidecar that names the plan", async () => {
  const { root, head } = await fixture();
  const created = await createReviewCheckout({
    root,
    pullRequest: pullRequest(head),
    repository,
    createdBy: "review-test",
    now: new Date("2026-11-01T09:00:00Z"),
  });
  expect(created.path).toBe(join(root, ".worktrees", "review", "Dashboard-pr-7"));
  expect(git(created.path, ["rev-parse", "HEAD"])).toBe(head);
  expect(git(created.path, ["branch", "--show-current"])).toBe("");
  expect(JSON.parse(readFileSync(created.sidecarPath, "utf8"))).toMatchObject({
    schema_version: "companiesascode.review-checkout.v1",
    mission_control_plan_code: "DEV-6632",
    pull_request: "https://github.com/TestProvider/Dashboard/pull/7",
    head_sha: head,
    worktree_path: ".worktrees/review/Dashboard-pr-7",
    created_at: "2026-11-01T09:00:00.000Z",
  });
});

test("refuses a pull request of another repository, one without a plan, or a short head", async () => {
  const { root, head } = await fixture();
  await expect(createReviewCheckout({
    root,
    pullRequest: pullRequest(head, { url: "https://github.com/Other/Repo/pull/7" }),
    repository,
  })).rejects.toThrow("belongs to Other/Repo");
  await expect(createReviewCheckout({
    root,
    pullRequest: pullRequest(head, { headRefName: "fix-typo", title: "no plan" }),
    repository,
  })).rejects.toThrow("names no plan");
  await expect(createReviewCheckout({
    root,
    pullRequest: pullRequest(head.slice(0, 12)),
    repository,
  })).rejects.toThrow("full commit SHA");
  expect(existsSync(join(root, ".worktrees", "review", "Dashboard-pr-7"))).toBe(false);
});

test("removes the checkout and its sidecar after the verdict, by URL or by path", async () => {
  const { root, head } = await fixture();
  const created = await createReviewCheckout({ root, pullRequest: pullRequest(head), repository });
  await removeReviewCheckout({ root, target: "https://github.com/TestProvider/Dashboard/pull/7" });
  expect(existsSync(created.path)).toBe(false);
  expect(existsSync(created.sidecarPath)).toBe(false);
  expect(git(root, ["worktree", "list", "--porcelain"])).not.toContain("Dashboard-pr-7");

  const again = await createReviewCheckout({ root, pullRequest: pullRequest(head), repository });
  await removeReviewCheckout({ root, target: again.path });
  expect(existsSync(again.path)).toBe(false);
});

test("keeps a checkout that moved off the reviewed head and refuses paths outside .worktrees/review", async () => {
  const { root, head } = await fixture();
  const created = await createReviewCheckout({ root, pullRequest: pullRequest(head), repository });
  git(created.path, ["commit", "-q", "--allow-empty", "-m", "an edit in a review checkout"]);
  await expect(removeReviewCheckout({ root, target: created.path })).rejects.toThrow("moved from the reviewed head");
  expect(existsSync(created.path)).toBe(true);
  await expect(removeReviewCheckout({ root, target: join(root, ".worktrees", "root", "x") })).rejects.toThrow(
    "not a review checkout",
  );
});

test("removes a checkout whose only extra files are ignored ones, such as installed dependencies", async () => {
  const { root, head } = await fixture();
  const created = await createReviewCheckout({ root, pullRequest: pullRequest(head), repository });
  await mkdir(join(created.path, "node_modules", "pkg"), { recursive: true });
  await writeFile(join(created.path, "node_modules", "pkg", "index.js"), "module.exports = 1;\n");
  await removeReviewCheckout({ root, target: created.path });
  expect(existsSync(created.path)).toBe(false);
  expect(existsSync(created.sidecarPath)).toBe(false);
});

test("keeps a checkout with modified, staged or untracked files", async () => {
  const { root, head } = await fixture();
  const created = await createReviewCheckout({ root, pullRequest: pullRequest(head), repository });
  await writeFile(join(created.path, "README.md"), "changed\n");
  await expect(removeReviewCheckout({ root, target: created.path })).rejects.toThrow("changes or untracked files");
  git(created.path, ["add", "README.md"]);
  await expect(removeReviewCheckout({ root, target: created.path })).rejects.toThrow("changes or untracked files");
  git(created.path, ["checkout", "HEAD", "--", "README.md"]);
  await writeFile(join(created.path, "notes.txt"), "unsaved\n");
  await expect(removeReviewCheckout({ root, target: created.path })).rejects.toThrow("changes or untracked files");
  expect(existsSync(join(created.path, "notes.txt"))).toBe(true);
  expect(existsSync(created.sidecarPath)).toBe(true);
});

test("keeps a checkout whose sidecar is missing or unreadable, because its head cannot be proven", async () => {
  const { root, head } = await fixture();
  const created = await createReviewCheckout({ root, pullRequest: pullRequest(head), repository });
  await rm(created.sidecarPath);
  await expect(removeReviewCheckout({ root, target: created.path })).rejects.toThrow("cannot prove the checkout holds no work");
  await writeFile(created.sidecarPath, "{not json");
  await expect(removeReviewCheckout({ root, target: created.path })).rejects.toThrow("cannot prove the checkout holds no work");
  expect(existsSync(created.path)).toBe(true);
});
