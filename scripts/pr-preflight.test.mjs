import { expect, test } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPrPreflight } from "./pr-preflight.mjs";

test("PR preflight keeps the operator's Git credential helper for fetch and remote-head reads", async () => {
  const folder = await mkdtemp(join(tmpdir(), "lazurio-preflight-credentials-"));
  try {
    const config = join(folder, "gitconfig");
    await writeFile(config, '[credential "https://github.com"]\n\thelper = lazurio-pilot-fixture\n');
    const fixture = fixtureGit();
    let remoteReads = 0;
    const result = await runPrPreflight({
      repoRoot: folder,
      gitRunner: async (args, options) => {
        if (args[0] === "fetch" || args[0] === "ls-remote") {
          remoteReads += 1;
          const read = Bun.spawnSync(["git", "config", "--global", "--get", "credential.https://github.com.helper"], {
            cwd: folder,
            env: { ...process.env, GIT_CONFIG_GLOBAL: config, ...options.env },
            stdout: "pipe", stderr: "pipe",
          });
          if (read.exitCode !== 0 || new TextDecoder().decode(read.stdout).trim() !== "lazurio-pilot-fixture") {
            return { ok: false, stdout: "", stderr: "The configured credential helper is unavailable.", error: null };
          }
          expect(options.env.GIT_TERMINAL_PROMPT).toBe("0");
          expect(options.env.GIT_DIR).toBeUndefined();
          expect(options.env.GIT_WORK_TREE).toBeUndefined();
        }
        return fixture(args);
      },
    });
    expect(result.ok).toBe(true);
    expect(remoteReads).toBe(2);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test("PR preflight blokuje branch bez nejnovějšího mainu", async () => {
  const result = await runPrPreflight({
    repoRoot: "/repo",
    gitRunner: fixtureGit({ relation: "4 2" }),
  });

  expect(result.ok).toBe(false);
  expect(result.code).toBe("base_not_ancestor");
  expect(result.recommended_action).toContain("git rebase origin/main");
});

test("PR preflight vrátí exact remote head pro force-with-lease", async () => {
  const remoteHead = "c".repeat(40);
  const result = await runPrPreflight({
    repoRoot: "/repo",
    gitRunner: fixtureGit({ remoteHead }),
  });

  expect(result.ok).toBe(true);
  expect(result.remote_branch_head).toBe(remoteHead);
  expect(result.push_command).toContain(`--force-with-lease=refs/heads/feature:${remoteHead}`);
});

test("PR preflight vyžaduje clean feature branch", async () => {
  const result = await runPrPreflight({
    repoRoot: "/repo",
    gitRunner: fixtureGit({ status: "?? draft.txt" }),
  });

  expect(result.ok).toBe(false);
  expect(result.code).toBe("dirty_worktree");
});

test("PR preflight odmítne shell metaznaky v branchi před vytvořením příkazu", async () => {
  const result = await runPrPreflight({
    repoRoot: "/repo",
    gitRunner: fixtureGit({ branch: "feature;touch-pwned" }),
  });

  expect(result.ok).toBe(false);
  expect(result.code).toBe("unsafe_branch_name");
  expect(result.push_command).toBeUndefined();
});

function fixtureGit({
  branch = "feature",
  relation = "3 0",
  status = "",
  remoteHead = "c".repeat(40),
} = {}) {
  return async (args) => {
    const command = args.join(" ");
    if (command === "fetch origin main --prune") return ok("");
    if (command === "branch --show-current") return ok(branch);
    if (command === "status --porcelain=v1 --untracked-files=normal") return ok(status);
    if (command === "rev-parse --verify HEAD^{commit}") return ok("a".repeat(40));
    if (command === "rev-parse --verify origin/main^{commit}") return ok("b".repeat(40));
    if (command === "rev-list --left-right --count HEAD...origin/main") return ok(relation);
    if (command === `ls-remote --heads origin refs/heads/${branch}`) {
      return ok(remoteHead ? `${remoteHead}\trefs/heads/${branch}` : "");
    }
    throw new Error(`Unexpected git command: ${command}`);
  };
}

function ok(stdout) {
  return { ok: true, stdout, stderr: "", error: null };
}
