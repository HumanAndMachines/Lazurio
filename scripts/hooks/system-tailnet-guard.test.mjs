import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { denyMessage, hookResponse, tailnetReason } from "./system-tailnet-guard.mjs";

const bash = (command) => tailnetReason({ tool_name: "Bash", tool_input: { command }, cwd: "/home/station-user" });
const FOREIGN = "/var/lib/lazurio-tailnets/example-org/run/tailscaled.sock";

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
    ["a socket chosen at run time", 'tailscale --socket="$SOCK" up'],
    ["the tailnet tool", "bun run tailnet -- up example-org --login-server https://headscale.example.lazurio.io --hostname login-device-cli"],
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
