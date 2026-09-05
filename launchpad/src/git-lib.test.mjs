import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import {
  GIT_COMMAND_CONCURRENCY,
  GIT_LOCAL_TIMEOUT_MS,
  gitExecutableCandidates,
  gitTimeoutKillCommand,
  mapWithConcurrency,
  minimalRemoteGitEnvironment,
  resolveGitExecutable,
  resolveGitExecutableSync,
  runGit,
  runGitInPinnedTemporaryChild,
  safeGitCommandEnv,
  safeGitRemoteEnv,
} from "../../lazurio/runtime/git-lib.mjs";
import { initGitRepo } from "./git-fixture-helpers.test.mjs";

test("mapWithConcurrency never runs more than the requested number of workers", async () => {
  let active = 0;
  let maxActive = 0;
  const output = await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (item) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    return item * 10;
  });

  expect(output).toEqual([10, 20, 30, 40, 50]);
  expect(maxActive).toBeLessThanOrEqual(2);
});

test("runGit returns stdout and protects remote probes from interactive credential prompts", async () => {
  const root = await mkdtemp(join(tmpdir(), "launchpad-git-runner-"));
  await initGitRepo(root);

  const result = await runGit(["rev-parse", "--abbrev-ref", "HEAD"], {
    cwd: root,
    env: {
      Git_Dir: join(root, "missing-ambient.git"),
      git_work_tree: join(root, "missing-ambient-worktree"),
    },
  });

  expect(result.ok).toBe(true);
  expect(result.stdout).toBe("main");
  expect(safeGitRemoteEnv("linux")).toMatchObject({
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "never",
    GIT_ASKPASS: "/bin/false",
    SSH_ASKPASS: "/bin/false",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_COUNT: "0",
  });
});

test.skipIf(process.platform === "win32")("POSIX Git timeout kills descendants that keep command pipes open", async () => {
  const root = await mkdtemp(join(tmpdir(), "launchpad-git-timeout-"));
  const childPidPath = join(root, "child.pid");
  let childPid = null;
  try {
    await initGitRepo(root);
    const startedAt = Date.now();
    const result = await runGit([
      "-c",
      "alias.hold=!sh -c 'sleep 60 & echo $! > \"$1\"; wait' _",
      "hold",
      childPidPath,
    ], {
      cwd: root,
      timeoutMs: 250,
    });
    childPid = Number.parseInt(await readFile(childPidPath, "utf8"), 10);

    expect(result.ok).toBe(false);
    expect(result.timedOut).toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(3_000);
    expect(await processIsGone(childPid)).toBe(true);
  } finally {
    if (Number.isInteger(childPid) && !(await processIsGone(childPid))) {
      try {
        process.kill(childPid, "SIGKILL");
      } catch {}
    }
    await rm(root, { recursive: true, force: true });
  }
});

test.skipIf(process.platform === "win32" || !Bun.which("perl"))("Git timeout bounds pipe drain even when a descendant escapes the process group", async () => {
  const root = await mkdtemp(join(tmpdir(), "launchpad-git-drain-timeout-"));
  const childPidPath = join(root, "escaped-child.pid");
  let childPid = null;
  try {
    await initGitRepo(root);
    const startedAt = Date.now();
    const result = await runGit([
      "-c",
      "alias.escape=!perl -MPOSIX=setsid -e 'setsid(); open(my $fh, q(>), $ARGV[0]) or die $!; print {$fh} qq($$\\n); close $fh; sleep 60'",
      "escape",
      childPidPath,
    ], {
      cwd: root,
      timeoutMs: 250,
    });
    childPid = Number.parseInt(await readFile(childPidPath, "utf8"), 10);

    expect(result.ok).toBe(false);
    expect(result.timedOut).toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(3_000);
    expect(await processIsGone(childPid)).toBe(false);
  } finally {
    if (Number.isInteger(childPid) && !(await processIsGone(childPid))) {
      try {
        process.kill(childPid, "SIGKILL");
      } catch {}
    }
    await rm(root, { recursive: true, force: true });
  }
});

async function processIsGone(pid) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error?.code === "ESRCH") return true;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

test("Windows remote Git environment never contains a POSIX askpass executable", () => {
  const env = safeGitRemoteEnv("win32");

  expect(env.GIT_TERMINAL_PROMPT).toBe("0");
  expect(env.GCM_INTERACTIVE).toBe("never");
  expect(env.SSH_ASKPASS_REQUIRE).toBe("never");
  expect(env.GIT_ASKPASS).toBeUndefined();
  expect(env.SSH_ASKPASS).toBeUndefined();
  expect(JSON.stringify(env)).not.toContain("/bin/false");
  expect(safeGitCommandEnv("win32", {
    GIT_ASKPASS: "/bin/false",
    Git_AskPass: "C:\\malicious\\askpass.exe",
    git_config_count: "1",
    Git_Config_Key_0: "core.sshCommand",
    GIT_CONFIG_VALUE_0: "malicious-command",
    Git_Config_Global: "C:\\malicious\\global-config",
    git_config_nosystem: "1",
    Git_Config_Parameters: "'core.hooksPath=C:\\malicious\\hooks'",
    GIT_CONFIG_SYSTEM: "C:\\malicious\\system-config",
    Git_Dir: "C:\\stale-context\\.git",
    git_implicit_work_tree: "1",
    git_internal_super_prefix: "C:\\stale-context\\super",
    Git_Shallow_File: "C:\\stale-context\\shallow",
    git_work_tree: "C:\\stale-context",
    GIT_EXEC_PATH: "C:\\malicious\\git-exec-path",
    GIT_PROXY_COMMAND: "C:\\malicious\\proxy-wrapper.exe",
    GIT_SSH_COMMAND: "C:\\malicious\\ssh-wrapper.exe",
    git_ssh_command: "C:\\malicious\\ssh-wrapper-lower.exe",
    SSH_ASKPASS: "/bin/false",
    ssh_askpass: "C:\\malicious\\ssh-askpass.exe",
    HOME: "C:\\Users\\builder",
    PATH: "C:\\Windows\\System32",
    SystemRoot: "C:\\Windows",
  })).toEqual({
    HOME: "C:\\Users\\builder",
    SystemRoot: "C:\\Windows",
    PATH: "C:\\Windows\\System32",
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "never",
    SSH_ASKPASS_REQUIRE: "never",
  });
});

test("remote child preserves the Principal PATH while isolating Git configuration", () => {
  const environment = minimalRemoteGitEnvironment({
    HOME: "C:\\Users\\builder",
    USERPROFILE: "C:\\Users\\builder",
    SSH_AUTH_SOCK: "\\\\.\\pipe\\openssh-ssh-agent",
    PATH: "C:\\attacker\\bin",
    GIT_SSH_COMMAND: "C:\\attacker\\ssh.exe",
  }, "win32", "C:\\Users\\builder\\AppData\\Local\\Programs\\Git\\cmd\\git.exe");

  expect(environment).toMatchObject({
    HOME: "C:\\Users\\builder",
    USERPROFILE: "C:\\Users\\builder",
    SSH_AUTH_SOCK: "\\\\.\\pipe\\openssh-ssh-agent",
    PATH: "C:\\attacker\\bin",
  });
  expect(environment.GIT_EXEC_PATH).toBeUndefined();
});

test("pinned child executes clone through the parent-verified absolute Git executable", async () => {
  const root = await mkdtemp(join(tmpdir(), "launchpad-pinned-git-executable-"));
  const source = join(root, "source");
  const remote = join(root, "remote.git");
  try {
    await initGitRepo(source, { remotePath: remote });
    const result = await runGitInPinnedTemporaryChild([
      "clone",
      "--branch",
      "main",
      "--single-branch",
      "--",
      remote,
    ], {
      cwd: root,
      expectedCwdRealPath: await realpath(root),
      childPrefix: ".pinned-executable-",
      env: safeGitRemoteEnv(),
    });

    expect(result.ok).toBe(true);
    expect(result.child_name).toStartWith(".pinned-executable-");
    expect(await readFile(join(root, result.child_name, "README.md"), "utf8"))
      .toContain("# main");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Git resolver probes only the selected PATH executable and never falls back", async () => {
  for (const selected of ["/custom/mise/shims/git", null]) {
    const calls = [];
    const options = { resolvePathCommand: () => selected, probe: (path) => { calls.push(path); return false; } };
    expect(await resolveGitExecutable(options)).toBeNull();
    expect(resolveGitExecutableSync(options)).toBeNull();
    expect(calls).toEqual(selected ? [selected, selected] : []);
    expect(gitExecutableCandidates(options)).toEqual(selected ? [selected] : []);
  }
  expect(await resolveGitExecutable({ resolvePathCommand: () => "/custom/git", probe: () => true })).toBe("/custom/git");
});

test("sterile materialization environment disables ambient Git config", () => {
  const environment = safeGitRemoteEnv("linux");

  expect(environment.GIT_CONFIG_GLOBAL).toBe("/dev/null");
  expect(environment.GIT_CONFIG_NOSYSTEM).toBe("1");
  expect(environment.GIT_CONFIG_COUNT).toBe("0");
  expect(environment.GIT_TERMINAL_PROMPT).toBe("0");
});

test("remote Git ignores global insteadOf and external-protocol configuration", async () => {
  const root = await mkdtemp(join(tmpdir(), "launchpad-git-sterile-config-"));
  const source = join(root, "source");
  const remote = join(root, "remote.git");
  const fakeHome = join(root, "home");
  try {
    await initGitRepo(source, { remotePath: remote });
    await mkdir(fakeHome);
    await Bun.write(join(root, "home", ".gitconfig"), [
      `[url "file://${join(root, "must-not-be-used.git")}"]`,
      `\tinsteadOf = ${remote}`,
      "[protocol \"ext\"]",
      "\tallow = always",
      "",
    ].join("\n"));

    const result = await runGit(["ls-remote", remote, "refs/heads/main"], {
      cwd: root,
      env: {
        ...safeGitRemoteEnv(),
        HOME: fakeHome,
        USERPROFILE: fakeHome,
        LAZURIO_CREDENTIAL_CANARY: "must-not-reach-git",
      },
    });

    expect(result.ok).toBe(true);
    expect(result.stdout).toContain("refs/heads/main");
    expect(result.stderr).not.toContain("must-not-be-used");
    expect(result.stderr).not.toContain("must-not-reach-git");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("local Git probes use the Windows-proven timeout and bounded concurrency", () => {
  expect(GIT_LOCAL_TIMEOUT_MS).toBe(10_000);
  expect(GIT_COMMAND_CONCURRENCY).toBe(4);
  expect(gitTimeoutKillCommand(123, { SystemRoot: "C:\\Windows" })).toEqual([
    "C:\\Windows\\System32\\taskkill.exe",
    "/PID",
    "123",
    "/T",
    "/F",
  ]);
});

test.skipIf(process.platform === "win32")("a PATH shim works in the actual isolated remote Git consumer", async () => {
  const { writeFile, chmod } = await import("node:fs/promises");
  const { pathToFileURL } = await import("node:url");
  const root = await mkdtemp(join(tmpdir(), "lazurio-git-shim-"));
  const git = resolveGitExecutableSync();
  try {
    const shim = join(root, "shims"), helpers = join(root, "helpers");
    await mkdir(shim); await mkdir(helpers);
    // The shim delegates through PATH, as common version managers do.
    await writeFile(join(shim, "git"), '#!/bin/sh\nexec selected-git "$@"\n');
    await writeFile(join(helpers, "selected-git"), `#!/bin/sh\nexec '${git.replaceAll("'", "'\\''")}' "$@"\n`);
    await chmod(join(shim, "git"), 0o755); await chmod(join(helpers, "selected-git"), 0o755);
    const moduleUrl = pathToFileURL(join(import.meta.dirname, "../../lazurio/runtime/git-lib.mjs")).href;
    const child = Bun.spawnSync([process.execPath, "--eval", `const {runGit,safeGitRemoteEnv}=await import(${JSON.stringify(moduleUrl)});const r=await runGit(["--version"],{cwd:${JSON.stringify(root)},env:safeGitRemoteEnv()});console.log(r.stdout);process.exit(r.ok?0:1);`], {
      env: { ...process.env, PATH: `${shim}:${helpers}:${process.env.PATH}` }, stdout: "pipe", stderr: "pipe",
    });
    expect(child.exitCode, new TextDecoder().decode(child.stderr)).toBe(0);
    expect(new TextDecoder().decode(child.stdout)).toContain("git version");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test.skipIf(process.platform === "win32")("runtime rejects Git 2.30 from PATH before invoking a module consumer", async () => {
  const { writeFile, chmod } = await import("node:fs/promises");
  const { pathToFileURL } = await import("node:url");
  const root = await mkdtemp(join(tmpdir(), "lazurio-old-git-"));
  try {
    const marker = join(root, "consumer-invoked");
    await writeFile(join(root, "git"), `#!/bin/sh\nif [ "$1" = "--version" ]; then echo 'git version 2.30.9'; exit 0; fi\n: > '${marker}'\nexit 129\n`);
    await chmod(join(root, "git"), 0o755);
    const moduleUrl = pathToFileURL(join(import.meta.dirname, "../../lazurio/runtime/git-lib.mjs")).href;
    const child = Bun.spawnSync([process.execPath, "--eval", `const g=await import(${JSON.stringify(moduleUrl)});const a=await g.resolveGitExecutable();const s=g.resolveGitExecutableSync();const r=await g.runGit(["rev-parse","--path-format=absolute","--show-toplevel"],{cwd:${JSON.stringify(root)}});console.log(JSON.stringify({a,s,ok:r.ok}));`], {
      env: { ...process.env, PATH: `${root}:${process.env.PATH}` }, stdout: "pipe", stderr: "pipe",
    });
    expect(child.exitCode, new TextDecoder().decode(child.stderr)).toBe(0);
    expect(JSON.parse(new TextDecoder().decode(child.stdout))).toEqual({ a: null, s: null, ok: false });
    expect(await Bun.file(marker).exists()).toBe(false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
