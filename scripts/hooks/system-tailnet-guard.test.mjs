import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { denyMessage, hookResponse, tailnetReason } from "./system-tailnet-guard.mjs";

const bash = (command) => tailnetReason({ tool_name: "Bash", tool_input: { command }, cwd: "/home/station-user" });
const FOREIGN = "/var/lib/lazurio-tailnets/example-org/run/tailscaled.sock";
const SYSTEM = "/run/tailscale/tailscaled.sock";

// Links and files the guard follows; nothing here is a live socket, and no
// command is ever run: the guard only reads the file system.
const sandbox = mkdtempSync(join(tmpdir(), "tailnet-guard-"));
afterAll(() => {
  chmodSync(join(sandbox, "closed"), 0o700);
  rmSync(sandbox, { recursive: true, force: true });
});
const home = join(sandbox, "home");
const links = join(sandbox, "links");
const foreign = join(sandbox, "foreign");
for (const dir of [home, links, foreign, join(sandbox, "system"), join(sandbox, "closed")]) mkdirSync(dir);
symlinkSync(SYSTEM, join(home, "system-link.sock"));
writeFileSync(join(home, "foreign.sock"), "");
symlinkSync(SYSTEM, join(links, "socket"));
symlinkSync("/run/tailscale", join(links, "directory"));
symlinkSync("/run/tailscale/below", join(links, "below"));
symlinkSync("loop-b", join(links, "loop-a"));
symlinkSync("loop-a", join(links, "loop-b"));
writeFileSync(join(foreign, "tailscaled.sock"), "");
// A stand-in for the system socket and a hard link to it elsewhere.
writeFileSync(join(sandbox, "system", "tailscaled.sock"), "");
linkSync(join(sandbox, "system", "tailscaled.sock"), join(foreign, "hard.sock"));
writeFileSync(join(sandbox, "closed", "tailscaled.sock"), "");
chmodSync(join(sandbox, "closed"), 0o000);

const at = (cwd, command, options = {}) => tailnetReason({ tool_name: "Bash", tool_input: { command }, ...(cwd === undefined ? {} : { cwd }) }, { home, ...options });

describe("denies changes to the Environment's own tailnet", () => {
  test.each([
    ["up", "tailscale up"],
    ["up with a login server", "sudo tailscale up --login-server=https://headscale.example.lazurio.io"],
    ["switch", "sudo -n tailscale switch other-profile"],
    ["logout by path", "/usr/bin/tailscale logout"],
    ["login", "tailscale login --login-server https://headscale.example.lazurio.io"],
    ["down", "tailscale down"],
    ["set", "tailscale set --exit-node=example-exit"],
    ["set-operator", "tailscale set-operator station-user"],
    ["serve", "tailscale serve --bg 3000"],
    ["funnel", "tailscale funnel 443"],
    ["update", "sudo tailscale update --yes"],
    ["the system socket", "tailscale --socket=/run/tailscale/tailscaled.sock up"],
    ["the system socket through /var/run", "tailscale --socket /var/run/tailscale/tailscaled.sock switch other-profile"],
    ["a single-dash socket flag", "tailscale -socket=/run/tailscale/tailscaled.sock logout"],
    ["after cd", "cd /tmp && sudo tailscale up --reset"],
    ["in a pipeline", "yes | tailscale logout"],
    ["bash -c", 'bash -c "sudo tailscale switch work"'],
    ["sh -lc", "sh -lc 'tailscale logout'"],
    ["sudo bash -c", "sudo bash -c 'tailscale up'"],
    ["su -c", "sudo su -c 'tailscale down'"],
    ["eval", 'eval "tailscale down"'],
    ["a command substitution", "echo $(tailscale logout)"],
    ["backticks", "echo `tailscale down`"],
    ["env with assignments", "sudo env TS_DEBUG=1 tailscale up"],
    ["timeout", "timeout 10 tailscale up"],
    ["nohup in the background", "nohup tailscale up >/dev/null 2>&1 &"],
    ["nsenter keeps the host filesystem", "sudo nsenter -t 1 -n tailscale up"],
    ["a here-document fed to bash", "bash <<'EOF'\ntailscale up\nEOF"],
    ["a here-string fed to sh", 'sh <<< "tailscale logout"'],
    ["inside if", "if true; then tailscale down; fi"],
    ["watch", "watch -n 5 tailscale up"],
    ["systemctl restart", "sudo systemctl restart tailscaled"],
    ["systemctl stop of the unit", "systemctl stop tailscaled.service"],
    ["systemctl disable --now", "sudo systemctl disable --now tailscaled"],
    ["systemctl mask", "sudo systemctl mask tailscaled"],
    ["systemctl kill with a signal", "sudo systemctl kill -s HUP tailscaled"],
    ["systemctl with a glob", "sudo systemctl try-restart 'tailscale*'"],
    ["service restart", "sudo service tailscaled restart"],
    ["pkill", "sudo pkill tailscaled"],
    ["pkill -f", "sudo pkill -f tailscaled"],
    ["pkill with a signal", "sudo pkill -9 -x tailscaled"],
    ["pkill of a prefix", "sudo pkill tailscale"],
    ["pkill -f of the system socket", "sudo pkill -f 'socket=/run/tailscale'"],
    ["killall", "sudo killall tailscaled"],
    ["killall -r", "sudo killall -r 'tail.*'"],
    ["unparseable", 'tailscale up "unterminated'],
  ])("%s", (_name, command) => {
    expect(bash(command)).toEqual(expect.any(String));
  });

  test("Monitor runs commands like Bash", () => {
    expect(tailnetReason({ tool_name: "Monitor", tool_input: { command: "tailscale up" } })).toEqual(expect.any(String));
  });

  test("the reason names the command and the socket", () => {
    expect(bash("sudo tailscale switch other-profile")).toBe("`tailscale switch` without --socket");
    expect(bash("tailscale --socket=/run/tailscale/tailscaled.sock up")).toBe("`tailscale up` on /run/tailscale/tailscaled.sock");
    expect(bash("sudo systemctl restart tailscaled")).toBe("`systemctl restart tailscaled`");
  });
});

describe("allows reading the system tailnet and working in foreign ones", () => {
  test.each([
    ["status", "tailscale status"],
    ["status piped", "tailscale status --json | jq -r .BackendState"],
    ["ping", "tailscale ping example-peer"],
    ["netcheck", "tailscale netcheck"],
    ["debug prefs", "tailscale debug prefs"],
    ["dns status", "tailscale dns status"],
    ["version", "tailscale version"],
    ["ip", "tailscale ip -4"],
    ["whois", "tailscale whois example-peer"],
    ["switch --list", "sudo tailscale switch --list"],
    ["serve status", "tailscale serve status"],
    ["funnel status", "tailscale funnel status --json"],
    ["update --dry-run", "tailscale update --dry-run"],
    ["help", "tailscale up --help"],
    ["a foreign tailnet socket", `tailscale --socket=${FOREIGN} up --accept-dns=true`],
    ["a foreign tailnet socket as two words", `tailscale --socket ${FOREIGN} logout`],
    ["a headless client socket", "tailscale --socket=/home/station-user/.local/state/ts-example/ts.sock switch other"],
    ["a socket chosen at run time, for a read", 'tailscale --socket="$SOCK" status'],
    ["the tailnet tool","bun run tailnet -- up example-org --login-server https://headscale.example.lazurio.io --hostname login-device-cli"],
    ["a command run inside a foreign tailnet", "bun scripts/tailnet/cli.mjs run example-org -- tailscale up"],
    ["a foreign tailnet container", "docker exec lazurio-tailnet-example-org tailscale up --reset"],
    ["a remote host", "ssh example-host sudo tailscale up"],
    ["systemctl status", "systemctl status tailscaled"],
    ["a user unit", "systemctl --user restart example-headless-client.service"],
    ["a user unit named tailscaled", "systemctl --user stop tailscaled"],
    ["another system unit", "sudo systemctl restart docker"],
    ["journalctl", "journalctl -u tailscaled -n 50"],
    ["pgrep", "pgrep -a tailscaled"],
    ["pkill of a headless client", "pkill -f 'tailscaled --tun=userspace-networking --socket=/home/station-user/.local/state/ts-example/ts.sock'"],
    ["killall of something else", "killall tail"],
    ["grep", "grep -n 'tailscale up' notes.md"],
    ["echo", 'echo "tailscale up"'],
    ["git commit", 'git commit -m "tailscale up docs"'],
    ["man", "man tailscale"],
    ["a script by path", "bash ./scripts/example.sh up"],
    ["unrelated", "git status --short && ls -la"],
  ])("%s", (_name, command) => {
    expect(bash(command)).toBeNull();
  });

  test("other tools and malformed input are not judged", () => {
    expect(tailnetReason({ tool_name: "Read", tool_input: { file_path: "/run/tailscale/tailscaled.sock" } })).toBeNull();
    expect(tailnetReason({ tool_name: "Bash", tool_input: {} })).toBeNull();
    expect(tailnetReason(null)).toBeNull();
  });
});

describe("follows a socket path the way the kernel does", () => {
  const user = "/home/station-user";
  test.each([
    ["a relative path after cd", user, "cd /run/tailscale && tailscale --socket=tailscaled.sock down"],
    ["a relative path from the hook's working directory", "/run/tailscale", "tailscale --socket=tailscaled.sock down"],
    ["a relative path with ..", "/run/tailscale/below", "tailscale --socket=../tailscaled.sock logout"],
    ["a relative directory after cd", user, "cd /run && sudo tailscale --socket tailscale/tailscaled.sock up"],
    ["pushd", user, "pushd /run/tailscale >/dev/null; tailscale --socket=./tailscaled.sock switch other"],
    ["cd in a subshell", user, "(cd /run/tailscale; sudo tailscale --socket=tailscaled.sock down)"],
    ["cd later in a loop", user, "for i in 1 2; do tailscale --socket=tailscaled.sock down; cd /run/tailscale; done"],
    ["cd inside bash -c", user, "bash -c 'cd /run/tailscale && tailscale --socket=tailscaled.sock down'"],
    ["cd -P through a link", user, `cd -P ${links}/directory && tailscale --socket=tailscaled.sock down`],
    ["cd into a link", user, `cd ${links}/directory && tailscale --socket=tailscaled.sock down`],
    ["cd ~", user, "cd ~ && tailscale --socket=system-link.sock down"],
    ["sudo --chdir", user, "sudo -n --chdir=/run/tailscale tailscale --socket=tailscaled.sock down"],
    ["sudo -D in a cluster of options", user, "sudo -nD /run/tailscale tailscale --socket=tailscaled.sock down"],
    ["env -C", user, "env -C /run/tailscale tailscale --socket=tailscaled.sock logout"],
    ["a link to the socket", user, `tailscale --socket=${links}/socket down`],
    ["a link to its directory", user, `tailscale --socket=${links}/directory/tailscaled.sock up`],
    [".. after a link, taken physically", user, `tailscale --socket=${links}/below/../tailscaled.sock down`],
    ["~ at the start of the word", user, "tailscale --socket ~/system-link.sock down"],
    ["~ after --socket=, as zsh expands it", user, "tailscale --socket=~/system-link.sock down"],
    ["$HOME", user, "tailscale --socket=$HOME/system-link.sock down"],
    ["an empty --socket, which is the default", user, "tailscale --socket= up"],
  ])("denies %s", (_name, cwd, command) => {
    expect(at(cwd, command)).toEqual(expect.any(String));
  });

  test.each([
    ["a variable", 'tailscale --socket="$SOCK" up'],
    ["a command substitution", "tailscale --socket=$(cat socket-path) down"],
    ["an operator on $HOME", "tailscale --socket=${HOME%/*}/station-user/x.sock down"],
    ["another user's home", "tailscale --socket ~root/x.sock down"],
    ["a glob", "tailscale --socket /run/tail*/tailscaled.sock down"],
    ["a brace expansion", "tailscale --socket /run/tailscale/{tailscaled.sock,x} down"],
    ["a relative path after cd to a variable", 'cd "$DIR" && tailscale --socket=x.sock up'],
    ["a relative path after cd -", "cd - && tailscale --socket=x.sock up"],
    ["a relative path after a relative cd, which CDPATH may send anywhere", "cd tailscale && tailscale --socket=x.sock up"],
    ["a relative path after popd", "popd; tailscale --socket=x.sock up"],
    ["a relative path after sudo -i, in root's home", "sudo -i tailscale --socket=x.sock up"],
    ["a link loop", `tailscale --socket=${links}/loop-a down`],
    ["a path in /proc, which depends on the process", "tailscale --socket=/proc/self/cwd/tailscaled.sock down"],
    ["$HOME after export HOME", "export HOME=/run/tailscale; tailscale --socket=$HOME/tailscaled.sock down"],
    ["~ after HOME=", "HOME=/run/tailscale; tailscale --socket=~/tailscaled.sock down"],
    ["$HOME after a prefix assignment", "HOME=/run/tailscale tailscale --socket=$HOME/tailscaled.sock down"],
    ["$HOME in code env starts with another HOME", "env HOME=/run/tailscale bash -c 'tailscale --socket=$HOME/tailscaled.sock down'"],
    ["$HOME in code sudo starts", "sudo -H bash -c 'tailscale --socket=$HOME/tailscaled.sock logout'"],
    ["~ in code su starts", "su - root -c 'tailscale --socket ~/tailscaled.sock down'"],
    ["$HOME after read", "read HOME < home.txt; tailscale --socket=$HOME/tailscaled.sock down"],
    ["$HOME after printf -v", "printf -v HOME %s /run/tailscale; tailscale --socket=$HOME/tailscaled.sock down"],
    ["$HOME after unset", "unset HOME; tailscale --socket=$HOME/tailscaled.sock down"],
    ["cd ~ after HOME=", "HOME=/run/tailscale; cd ~ && tailscale --socket=tailscaled.sock down"],
    ["a bare cd after HOME=", "HOME=/run/tailscale; cd; tailscale --socket=tailscaled.sock down"],
    ["$HOME after printf -v with a quoted name", "printf -v 'HOME' %s /run/tailscale; tailscale --socket=$HOME/tailscaled.sock down"],
    ["$HOME after read with a double-quoted name", 'read "HOME" < home.txt; tailscale --socket=$HOME/tailscaled.sock down'],
    ["$HOME after declare -g", "declare -g HOME=/run/tailscale; tailscale --socket=${HOME}/tailscaled.sock down"],
  ])("denies a target that cannot be known before the command runs: %s", (_name, command) => {
    expect(at("/home/station-user", command)).toEqual(expect.any(String));
  });

  test.each([
    ["no socket", 'tailscale up "unterminated'],
    ["a relative socket", 'tailscale --socket=tailscaled.sock down "unterminated'],
    ["the system socket as two words", 'tailscale --socket /run/tailscale/tailscaled.sock down "unterminated'],
    ["a quoted socket", `tailscale --socket="${FOREIGN}" up "unterminated`],
  ])("a command that cannot be parsed is judged coarsely, and still fails safe: %s", (_name, command) => {
    expect(at("/home/station-user", command)).toEqual(expect.stringContaining("could not be parsed exactly"));
  });

  test("a command that cannot be parsed passes on an absolute foreign socket", () => {
    expect(at("/home/station-user", `tailscale --socket=${FOREIGN} up "unterminated`)).toBeNull();
  });

  test("nested code that cannot be parsed keeps the exact reading around it", () => {
    // The coarse fallback alone would miss `systemctl kill -s HUP`.
    expect(at("/home/station-user", "sudo systemctl kill -s HUP tailscaled; bash -c 'echo \"unterminated'")).toBe("`systemctl kill tailscaled`");
    expect(at("/home/station-user", "echo ok; bash -c 'tailscale up \"unterminated'")).toEqual(expect.stringContaining("could not be parsed exactly"));
  });

  test("a cluster of wrapper options is read option by option", () => {
    expect(bash("sudo -nu root tailscale up")).toBe("`tailscale up` without --socket");
    expect(bash("sudo -nuroot tailscale logout")).toBe("`tailscale logout` without --socket");
    expect(bash("timeout -k5 10 tailscale down")).toBe("`tailscale down` without --socket");
  });

  test("denies a relative path when the hook does not tell the working directory", () => {
    expect(at(undefined, "tailscale --socket=tailscaled.sock up")).toEqual(expect.any(String));
    expect(at("relative/dir", "tailscale --socket=tailscaled.sock up")).toEqual(expect.any(String));
  });

  test.skipIf(process.getuid?.() === 0)("denies a path through a directory it cannot read", () => {
    expect(at("/home/station-user", `tailscale --socket=${sandbox}/closed/tailscaled.sock up`)).toEqual(expect.any(String));
  });

  test("denies a hard link to the system socket", () => {
    const options = { systemSockets: [join(sandbox, "system", "tailscaled.sock")] };
    expect(at("/home/station-user", `tailscale --socket=${foreign}/hard.sock down`, options)).toEqual(expect.any(String));
    expect(at("/home/station-user", `tailscale --socket=${foreign}/tailscaled.sock down`, options)).toBeNull();
  });

  test("the reason names what the socket resolved to", () => {
    expect(at("/home/station-user", "cd /run/tailscale && tailscale --socket=tailscaled.sock down")).toBe(`\`tailscale down\` on tailscaled.sock, which is ${SYSTEM}`);
    expect(at("/home/station-user", 'tailscale --socket="$SOCK" up')).toBe("`tailscale up` on a socket that is not known before the command runs");
  });

  test.each([
    ["a foreign socket by a relative path", foreign, "tailscale --socket=tailscaled.sock up"],
    ["cd into a foreign directory", "/home/station-user", `cd ${foreign} && tailscale --socket=tailscaled.sock up`],
    ["$HOME to a foreign socket", "/home/station-user", "tailscale --socket=$HOME/foreign.sock up"],
    ["a relative path after an unknown cd, for a read", "/home/station-user", 'cd "$DIR" && tailscale --socket=x.sock status'],
    ["an absolute foreign path after an unknown cd", "/home/station-user", `cd "$DIR" && tailscale --socket=${foreign}/tailscaled.sock up`],
    ["a read on $HOME after HOME changes", "/home/station-user", "export HOME=/run/tailscale; tailscale --socket=$HOME/tailscaled.sock status"],
    ["an absolute foreign path when HOME changes", "/home/station-user", `HOME=/run/tailscale; tailscale --socket=${foreign}/tailscaled.sock up`],
  ])("allows %s", (_name, cwd, command) => {
    expect(at(cwd, command)).toBeNull();
  });
});

describe("hook protocol", () => {
  const guard = join(import.meta.dir, "system-tailnet-guard.mjs");
  const run = (stdin) => {
    const result = Bun.spawnSync([process.execPath, guard], { stdin: Buffer.from(stdin) });
    return { code: result.exitCode, out: result.stdout.toString() };
  };

  test("a match prints a PreToolUse deny that points to the tailnet tool", () => {
    const { code, out } = run(JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "sudo tailscale switch other" } }));
    expect(code).toBe(0);
    const response = JSON.parse(out);
    expect(response.hookSpecificOutput.hookEventName).toBe("PreToolUse");
    expect(response.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(response.hookSpecificOutput.permissionDecisionReason).toContain("bun run tailnet --");
  });

  test("a relative socket is read from the hook's cwd", () => {
    const input = { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "tailscale --socket=tailscaled.sock down" }, cwd: "/run/tailscale" };
    expect(JSON.parse(run(JSON.stringify(input)).out).hookSpecificOutput.permissionDecision).toBe("deny");
  });

  test("a bare cd after HOME changes is denied by the hook itself, not dropped as an internal error", () => {
    const input = { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "HOME=/run/tailscale; cd; tailscale --socket=tailscaled.sock down" }, cwd: "/home/station-user" };
    const { code, out } = run(JSON.stringify(input));
    expect(code).toBe(0);
    expect(JSON.parse(out).hookSpecificOutput.permissionDecision).toBe("deny");
  });

  test("printf -v with a quoted HOME is denied by the hook", () => {
    const input = { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "printf -v 'HOME' %s /run/tailscale; tailscale --socket=$HOME/tailscaled.sock down" }, cwd: "/home/station-user" };
    expect(JSON.parse(run(JSON.stringify(input)).out).hookSpecificOutput.permissionDecision).toBe("deny");
  });

  test("an allowed call prints nothing", () => {
    const { code, out } = run(JSON.stringify({ tool_name: "Bash", tool_input: { command: "tailscale status" } }));
    expect(code).toBe(0);
    expect(out).toBe("");
  });

  test("broken input fails open: exit 0 and no decision", () => {
    const { code, out } = run("{ not json");
    expect(code).toBe(0);
    expect(out).toBe("");
  });

  test("the deny message offers the tool and no way around the guard", () => {
    const message = denyMessage("`tailscale up` without --socket");
    expect(message).toContain("manual/station-tailnets.md");
    expect(message).not.toMatch(/LAZURIO_[A-Z_]*=|--no-guard|bypass/iu);
    expect(hookResponse({ tool_name: "Bash", tool_input: { command: "tailscale status" } })).toBeNull();
  });
});
