import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  classifyChangeScope,
  isDocumentationPath,
  readPullRequestChangedPaths,
} from "./ci-change-scope.mjs";

test("a pull request touching only documentation Markdown takes the docs lane", () => {
  expect(classifyChangeScope({
    eventName: "pull_request",
    changedPaths: [
      "AGENTS.md",
      "manual/decision-register.md",
      "manual/integrations/slack.md",
      ".agents/skills/worktree-development-discipline/SKILL.md",
      ".claude/skills/worktree-development-discipline/SKILL.md",
      "guide/content/cs/index.md",
      "launchpad/docs/launchpad-gen3-redesign-spec.md",
      "distribution/locales/en/manual/organization-install.md",
    ],
  })).toMatchObject({ scope: "docs" });
});

test("any code, config, lockfile or CI change runs the full suite", () => {
  for (const path of [
    "package.json",
    "bun.lock",
    ".github/workflows/checks.yml",
    "scripts/ci-change-scope.mjs",
    "scripts/test-lanes.mjs",
    "launchpad/src/run-tests.mjs",
    "manual/app/diagram.png",
    ".agents/skills/manifest.json",
    "AGENTS.md.orig",
  ]) {
    expect(classifyChangeScope({ eventName: "pull_request", changedPaths: ["AGENTS.md", path] }))
      .toMatchObject({ scope: "full" });
  }
});

test("Markdown that code consumes as data is not documentation", () => {
  for (const path of [
    "lazurio/templates/module/README.md",
    "lazurio/README.md",
    "lazurio/migrations/organization-manifest/README.md",
    "templates/README.md",
    "provisioning/README.md",
    "launchpad/public/notes.md",
    "launchpad/src/fixtures/example.md",
    "tests/bridge/fixture.md",
    "bridge/CONSTITUTION.md",
    "organizations/README.md",
    "personalspace/README.md",
    ".github/ISSUE_TEMPLATE/report.md",
    "LICENSE.md",
    "MANUAL.MD",
  ]) {
    expect(isDocumentationPath(path)).toBe(false);
  }
});

test("pushes and unproven change sets fail closed to the full suite", () => {
  expect(classifyChangeScope({ eventName: "push", changedPaths: ["AGENTS.md"] }))
    .toMatchObject({ scope: "full" });
  expect(classifyChangeScope({ eventName: "", changedPaths: ["AGENTS.md"] }))
    .toMatchObject({ scope: "full" });
  for (const changedPaths of [null, undefined, []]) {
    expect(classifyChangeScope({ eventName: "pull_request", changedPaths }))
      .toMatchObject({ scope: "full" });
  }
});

test("the change set is read from the pull request merge commit only", async () => {
  const root = await mkdtemp(join(tmpdir(), "lazurio-ci-scope-"));
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  const commit = async (files, message) => {
    for (const [path, content] of Object.entries(files)) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), content);
    }
    git("add", "-A");
    git("-c", "user.name=CI", "-c", "user.email=ci@example.invalid", "commit", "-qm", message);
  };
  try {
    git("init", "-q", "-b", "main");
    await commit({ "AGENTS.md": "base\n", "lazurio/cli.mjs": "base\n" }, "base");
    git("checkout", "-qb", "feature");
    await commit({ "manual/new.md": "doc\n" }, "docs change");
    git("checkout", "-q", "main");
    // The base moves on after the branch point; its change is not the PR's.
    await commit({ "lazurio/cli.mjs": "moved base\n" }, "base moves");

    // Without a merge commit there is no proven PR diff.
    expect(readPullRequestChangedPaths({ cwd: root })).toBeNull();

    git("-c", "user.name=CI", "-c", "user.email=ci@example.invalid", "merge", "-q", "--no-ff", "feature", "-m", "merge");
    expect(readPullRequestChangedPaths({ cwd: root })).toEqual(["manual/new.md"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a Git failure while reading the change set is unproven, not empty", () => {
  expect(readPullRequestChangedPaths({
    git: () => {
      throw new Error("fatal: bad revision 'HEAD^1'");
    },
  })).toBeNull();
});
