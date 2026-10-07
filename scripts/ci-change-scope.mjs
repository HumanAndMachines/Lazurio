// Decides how much of `bun run check` a CI run needs.
//
// A pull request that changes only documentation Markdown gets the short
// docs lane (`bun run check:docs`): every check whose input is that Markdown
// still runs, the behaviour suites that cannot be affected do not. Everything
// else is `full`: pushes to main, any non-Markdown path, Markdown that code
// consumes as data (templates, packages, fixtures) and every case where the
// change set cannot be proven. The script runs under plain Node before Bun is
// set up, so it uses only node: built-ins.
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Markdown at these locations is documentation. Its content checks are the
// docs lane in scripts/test-lanes.mjs; a test that starts reading Markdown
// from a new location must join that lane before the location is added here.
const documentationMarkdown = [
  // Root documents; LICENSE.md is packaged and byte-compared by the npm gate.
  /^(?!LICENSE\.md$)[^/]+\.md$/u,
  /^manual\/.+\.md$/u,
  /^\.agents\/skills\/.+\.md$/u,
  /^\.claude\/skills\/.+\.md$/u,
  /^guide\/.+\.md$/u,
  /^launchpad\/README\.md$/u,
  /^launchpad\/docs\/.+\.md$/u,
  /^distribution\/.+\.md$/u,
];

export function isDocumentationPath(path) {
  return typeof path === "string" && documentationMarkdown.some((pattern) => pattern.test(path));
}

export function classifyChangeScope({ eventName, changedPaths }) {
  if (eventName !== "pull_request") {
    return { scope: "full", reason: `event ${eventName || "unknown"} always runs the full suite` };
  }
  if (!Array.isArray(changedPaths) || changedPaths.length === 0) {
    return { scope: "full", reason: "the pull request change set could not be proven" };
  }
  const other = changedPaths.find((path) => !isDocumentationPath(path));
  if (other !== undefined) {
    return { scope: "full", reason: `${other} is not documentation Markdown` };
  }
  return { scope: "docs", reason: `${changedPaths.length} documentation Markdown file(s) only` };
}

// actions/checkout puts a pull_request run on GitHub's merge commit; with
// fetch-depth 2 its first parent is the current base and the second the PR
// head, so HEAD^1..HEAD is exactly what the PR changes on top of its base.
// Anything else (a plain commit, a missing parent, a Git failure) is unproven.
export function readPullRequestChangedPaths({ cwd = process.cwd(), git = runGit } = {}) {
  try {
    git(["rev-parse", "--verify", "--quiet", "HEAD^2^{commit}"], cwd);
    const output = git(["diff", "--name-only", "--no-renames", "-z", "HEAD^1", "HEAD", "--"], cwd);
    return output.split("\0").filter(Boolean);
  } catch {
    return null;
  }
}

function runGit(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function main() {
  const eventName = process.env.GITHUB_EVENT_NAME ?? "";
  const changedPaths = eventName === "pull_request" ? readPullRequestChangedPaths() : null;
  const { scope, reason } = classifyChangeScope({ eventName, changedPaths });
  console.log(`CI scope: ${scope} (${reason})`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `scope=${scope}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
