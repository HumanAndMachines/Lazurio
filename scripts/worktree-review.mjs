#!/usr/bin/env bun
// Review checkout cizího pull requestu (decisions 0049, 0163): odpojený checkout
// přesného headu v <repo>/.worktrees/review/<repo>-pr-<číslo>/ se sidecarem,
// který jmenuje plán pull requestu (z jeho branche nebo titulku), URL a head.
// Worktree tak patří plánu jako každý jiný, ale Mission Control Organizace,
// které plán patří, připojený být nemusí: review nic nemění.
//
// Použití:
//   bun run worktrees:review -- <PR URL>
//   bun run worktrees:review -- --remove <PR URL | cesta k checkoutu>

import { existsSync, readFileSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { trustedGitExecutable } from "./agent-skills-entrypoint.mjs";
import { PLAN_CODE_PATTERN } from "./worktree-create-contract.mjs";
import { writeSidecarAtomically } from "./worktree-create-lib.mjs";
import {
  REVIEW_SIDECAR_SCHEMA,
  validateReviewSidecar,
} from "../.agents/skills/worktree-development-discipline/scripts/worktree-inventory.mjs";

const PULL_REQUEST_URL = /^https:\/\/github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)\/pull\/([1-9][0-9]*)$/;
const PLAN_IN_BRANCH = /^[a-z0-9-]+\/([A-Z]{2,6}-[0-9]{4})(?:-|$)/;
const PLAN_IN_TITLE = /\(([A-Z]{2,6}-[0-9]{4})[,)]/;

export function parsePullRequestUrl(url) {
  const match = PULL_REQUEST_URL.exec(url ?? "");
  if (!match) return null;
  return { owner: match[1], repo: match[2], number: Number(match[3]), url };
}

export function parseGitHubRemote(remoteUrl) {
  const match = /github\.com[:/]([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/.exec(remoteUrl ?? "");
  return match ? { owner: match[1], repo: match[2] } : null;
}

export function planCodeOfPullRequest({ headRefName, title }) {
  const fromBranch = PLAN_IN_BRANCH.exec(headRefName ?? "");
  if (fromBranch) return fromBranch[1];
  const fromTitle = PLAN_IN_TITLE.exec(title ?? "");
  return fromTitle ? fromTitle[1] : null;
}

export function reviewEnvironmentId(repo, number) {
  return `${repo}-pr-${number}`;
}

function git(cwd, args) {
  const executable = trustedGitExecutable();
  if (!executable) throw new Error("git is not available on PATH");
  const result = spawnSync(executable, args, { cwd, encoding: "utf8" });
  return { ok: result.status === 0, stdout: (result.stdout ?? "").trim(), stderr: (result.stderr ?? "").trim() };
}

function primaryRootOf(start) {
  const common = git(start, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (!common.ok) throw new Error(`not inside a Git repository: ${start}`);
  return dirname(common.stdout);
}

// pullRequest: { url, headSha, headRefName, title }; repository: { owner, repo } of the checkout's origin.
export async function createReviewCheckout({ root, pullRequest, repository, createdBy, now = new Date() }) {
  const parsed = parsePullRequestUrl(pullRequest.url);
  if (!parsed) throw new Error(`not a GitHub pull request URL: ${pullRequest.url}`);
  if (
    !repository
    || repository.owner.toLowerCase() !== parsed.owner.toLowerCase()
    || repository.repo.toLowerCase() !== parsed.repo.toLowerCase()
  ) {
    throw new Error(`the pull request belongs to ${parsed.owner}/${parsed.repo}, not to this repository's origin`);
  }
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(pullRequest.headSha ?? "")) {
    throw new Error("the pull request head is not a full commit SHA");
  }
  const planCode = planCodeOfPullRequest(pullRequest);
  if (!planCode || !PLAN_CODE_PATTERN.test(planCode)) {
    throw new Error("the pull request names no plan in its branch or title; ask its author which plan it belongs to");
  }
  const environmentId = reviewEnvironmentId(parsed.repo, parsed.number);
  const reviewRoot = join(root, ".worktrees", "review");
  const path = join(reviewRoot, environmentId);
  const sidecarPath = `${path}.worktree.json`;
  if (existsSync(path) || existsSync(sidecarPath)) {
    throw new Error(`a review checkout already exists: ${path}; remove it first with --remove`);
  }
  if (!git(root, ["cat-file", "-e", `${pullRequest.headSha}^{commit}`]).ok) {
    git(root, ["fetch", "--no-tags", "origin", `pull/${parsed.number}/head`]);
    if (!git(root, ["cat-file", "-e", `${pullRequest.headSha}^{commit}`]).ok) {
      throw new Error(`the head ${pullRequest.headSha} is not reachable from origin's pull/${parsed.number}/head`);
    }
  }
  await mkdir(reviewRoot, { recursive: true });
  const added = git(root, ["worktree", "add", "--detach", path, pullRequest.headSha]);
  if (!added.ok) throw new Error(`git worktree add failed: ${added.stderr}`);
  const sidecar = {
    schema_version: REVIEW_SIDECAR_SCHEMA,
    mission_control_plan_code: planCode,
    pull_request: parsed.url,
    head_sha: pullRequest.headSha,
    worktree_path: relative(root, path).split(sep).join("/"),
    created_at: now.toISOString(),
    created_by: createdBy ?? "unknown",
    cleanup_rule: "Remove right after the verdict is on GitHub: bun run worktrees:review -- --remove <PR URL>.",
  };
  const error = validateReviewSidecar(sidecar, { worktreeRelativePath: sidecar.worktree_path });
  if (error) {
    git(root, ["worktree", "remove", "--force", path]);
    throw new Error(`refusing an invalid review sidecar: ${error}`);
  }
  await writeSidecarAtomically({ sidecarPath, contents: `${JSON.stringify(sidecar, null, 2)}\n` });
  return { path, sidecarPath, planCode, environmentId };
}

export async function removeReviewCheckout({ root, target }) {
  const parsed = parsePullRequestUrl(target);
  const path = parsed
    ? join(root, ".worktrees", "review", reviewEnvironmentId(parsed.repo, parsed.number))
    : resolve(target);
  const reviewRoot = resolve(root, ".worktrees", "review");
  if (dirname(resolve(path)) !== reviewRoot) {
    throw new Error(`not a review checkout under ${reviewRoot}: ${path}`);
  }
  const sidecarPath = `${path}.worktree.json`;
  if (existsSync(path)) {
    let sidecar = null;
    try {
      sidecar = JSON.parse(readFileSync(sidecarPath, "utf8"));
    } catch {
      sidecar = null;
    }
    const error = sidecar
      ? validateReviewSidecar(sidecar, { worktreeRelativePath: relative(root, path).split(sep).join("/") })
      : "the sidecar is missing or not JSON";
    if (error) {
      throw new Error(`cannot prove the checkout holds no work (${error}); inspect ${path} and remove it by hand`);
    }
    const head = git(path, ["rev-parse", "HEAD"]).stdout;
    if (head !== sidecar.head_sha) {
      throw new Error(`the checkout moved from the reviewed head to ${head.slice(0, 12)}; keep it and save that work first`);
    }
    const status = git(path, ["status", "--porcelain=v1", "--untracked-files=all"]);
    if (!status.ok || status.stdout !== "") {
      throw new Error(`the checkout has changes or untracked files; keep it and save that work first: ${path}`);
    }
    const removed = git(root, ["worktree", "remove", path]);
    if (!removed.ok) throw new Error(`git worktree remove failed: ${removed.stderr}`);
  }
  git(root, ["worktree", "prune"]);
  await rm(sidecarPath, { force: true });
  return { path, sidecarPath };
}

function readPullRequest(url) {
  const result = spawnSync(
    "gh",
    ["pr", "view", url, "--json", "url,headRefOid,headRefName,title,isCrossRepository"],
    { encoding: "utf8" },
  );
  if (result.status !== 0) throw new Error(`gh pr view failed: ${(result.stderr ?? "").trim()}`);
  const data = JSON.parse(result.stdout);
  return { url, headSha: data.headRefOid, headRefName: data.headRefName, title: data.title };
}

async function main(argv) {
  const root = primaryRootOf(process.cwd());
  if (argv[0] === "--remove") {
    if (!argv[1]) throw new Error("usage: worktrees:review -- --remove <PR URL | path>");
    const removed = await removeReviewCheckout({ root, target: argv[1] });
    console.log(`ok - removed review checkout ${removed.path} and its sidecar`);
    return;
  }
  const url = argv[0];
  if (!parsePullRequestUrl(url)) throw new Error("usage: worktrees:review -- <https://github.com/OWNER/REPO/pull/N>");
  const repository = parseGitHubRemote(git(root, ["remote", "get-url", "origin"]).stdout);
  const created = await createReviewCheckout({
    root,
    pullRequest: readPullRequest(url),
    repository,
    createdBy: process.env.LAZURIO_TASK_AGENT_ID ?? process.env.USER ?? "unknown",
  });
  console.log(`ok - review checkout: ${created.path} (plan ${created.planCode}, detached at the PR head)`);
  console.log(`ok - sidecar: ${created.sidecarPath}`);
  console.log("next - review there, then remove it: bun run worktrees:review -- --remove <PR URL>");
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`fail - ${error.message}`);
    process.exit(1);
  });
}
