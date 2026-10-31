#!/usr/bin/env bun
// PreToolUse guard for Claude Code (and Codex, which speaks the same hook
// protocol): denies a shell command that would change the Environment's own
// tailnet. Every thread of an Environment shares its one system tailscaled,
// so `tailscale up`, `switch` or `logout` there, or a restart of the
// service, cuts all of them off at once. Foreign tailnets run a tailscaled
// each (`bun run tailnet`, manual/station-tailnets.md); commands aimed at
// their sockets pass.
//
// Contract as in scripts/custody/custody-guard.mjs: reads the hook JSON on
// stdin. On a match it prints a `deny` decision; otherwise it prints nothing
// and the call proceeds. Any internal error exits 0 without a decision (fail
// open), so a broken guard never blocks the agents of the Environment. There
// is no bypass flag or variable.
//
// Denied: `tailscale up|down|login|logout|switch|set|set-operator|serve|
// funnel|update` without --socket or with the system socket; `systemctl
// stop|restart|try-restart|reload-or-restart|force-reload|kill|disable|mask`
// of tailscaled (not --user); `service tailscaled stop|restart`; `pkill` and
// `killall` patterns that match the system tailscaled. Read-only forms pass:
// status, ping, netcheck, ip, whois, version, dns status, debug prefs,
// `switch --list`, `serve status`, `funnel status`, `update --dry-run`, help.
//
// Commands are read with the parser of scripts/custody/shell-taint.mjs,
// through sudo/env/timeout-like wrappers, `sh -c`, `su -c`, `eval`, command
// substitutions and code fed to a shell on stdin. Not seen: commands put
// together at run time, scripts run by path, and commands that run elsewhere
// (ssh, docker exec), which do not reach this Environment's tailscaled.
import { basename, posix } from "node:path";
import { parseShell, ShellParseError } from "../custody/shell-taint.mjs";
import { SYSTEM_SOCKETS, TAILNETS_ROOT } from "../tailnet/lib.mjs";

const MANUAL = "manual/station-tailnets.md";
const MUTATING = new Set(["up", "down", "login", "logout", "switch", "set", "set-operator", "serve", "funnel", "update"]);
const SYSTEMCTL_VERBS = new Set([
  "stop", "restart", "try-restart", "condrestart", "reload-or-restart", "try-reload-or-restart", "force-reload", "kill", "disable", "mask",
]);
const SERVICE_ACTIONS = new Set(["stop", "restart", "try-restart", "condrestart", "force-reload", "force-stop"]);
// The command line of the Environment's tailscaled (the Linux package unit),
// for `pkill -f` patterns.
const SYSTEM_TAILSCALED = "/usr/sbin/tailscaled --state=/var/lib/tailscale/tailscaled.state --socket=/run/tailscale/tailscaled.sock --port=41641";
const MAX_DEPTH = 8;

// Options whose next word is their value, per wrapper.
const words = (list) => new Set(list.split(" "));
const WRAPPERS = {
  sudo: words("-u -g -C -p -h -D -r -t -T -U --user --group --close-from --prompt --host --chdir --role --type --command-timeout --other-user"),
  doas: words("-u -C"),
  env: words("-u -C -S --unset --chdir --split-string"),
  command: words(""),
  builtin: words(""),
  exec: words("-a"),
  nohup: words(""),
  time: words("-f -o --format --output"),
  nice: words("-n --adjustment"),
  ionice: words("-c -n -p -P -u --class --classdata"),
  timeout: words("-s -k --signal --kill-after"),
  stdbuf: words("-i -o -e --input --output --error"),
  setsid: words(""),
  nsenter: words("-t --target -S --setuid -G --setgid"),
  unshare: words("-S --setuid -G --setgid -R --root -w --wd --map-user --map-group --map-users --map-groups --propagation --setgroups"),
  setpriv: words("--ruid --euid --rgid --egid --reuid --regid --groups --inh-caps --ambient-caps --bounding-set --securebits --pdeathsig --selinux-label --apparmor-profile --landlock-access --landlock-rule"),
  runuser: words("-u -g -G --user --group --supp-group -s --shell -w --whitelist-environment"),
};
const SHELLS = words("sh bash zsh dash ksh mksh");
const SYSTEMCTL_VALUE = words(
  "-t --type -p --property -s --signal --kill-whom --kill-value --root -n --lines -o --output --state --job-mode --what --timestamp --image --drop-in --message --when",
);
const PKILL_VALUE = words("--signal -g --pgroup -G --group -P --parent -s --session -t --terminal -u --euid -U --uid -F --pidfile --ns --nslist -q --queue");
const KILLALL_VALUE = words("-s --signal -u --user -o --older-than -y --younger-than -n --ns -Z --context");

// A word as far as it is known before the command runs: its full text, or
// null with the literal head (`--socket=` of `--socket=$SOCK`).
function wordOf(token) {
  let head = "";
  for (const part of token?.parts ?? []) {
    if (part.k !== "lit") return { text: null, head };
    head += part.v;
  }
  return { text: head, head };
}

const isSystemSocket = (path) => SYSTEM_SOCKETS.includes(posix.normalize(path));

function globMatches(pattern, subject) {
  const source = pattern.replace(/[.+^${}()|\\]/gu, "\\$&").replaceAll("*", ".*").replaceAll("?", ".");
  try {
    return new RegExp(`^${source}$`, "u").test(subject);
  } catch {
    return false;
  }
}

function unitIsTailscaled(unit) {
  const name = unit.includes(".") ? unit : `${unit}.service`;
  return /[*?[]/u.test(name) ? globMatches(name, "tailscaled.service") : name === "tailscaled.service";
}

function judgeTailscale(args) {
  // undefined: the default socket, which is the system one; null: chosen at run time.
  let socket;
  let sub = null;
  const rest = [];
  for (let k = 0; k < args.length; k += 1) {
    const { text, head } = args[k];
    if (/^--?socket(?:=|$)/u.test(text ?? head)) {
      if (text === null) socket = null;
      else if (text.includes("=")) socket = text.slice(text.indexOf("=") + 1);
      else {
        socket = args[k + 1]?.text ?? null;
        k += 1;
      }
    } else if (sub !== null) rest.push(text);
    else if (text === null) return null;
    else if (!text.startsWith("-")) sub = text;
  }
  if (!MUTATING.has(sub)) return null;
  if (rest.some((w) => w !== null && /^--?(?:h|help)$/u.test(w))) return null;
  if (sub === "switch" && rest.some((w) => w === "--list" || w === "-list")) return null;
  if ((sub === "serve" || sub === "funnel") && ["status", "get-config"].includes(rest.find((w) => w === null || !w.startsWith("-")))) return null;
  if (sub === "update" && rest.some((w) => w === "--dry-run" || w === "-dry-run")) return null;
  if (socket === null || (socket !== undefined && !isSystemSocket(socket))) return null;
  return `\`tailscale ${sub}\` ${socket === undefined ? "without --socket" : `on ${socket}`}`;
}

function judgeSystemctl(args) {
  let verb = null;
  const units = [];
  for (let k = 0; k < args.length; k += 1) {
    const v = args[k].text;
    if (v === null) continue;
    // Another manager: the user's, or a container's or host's over the wire.
    if (/^(?:--user|--global|-M|-H|--machine(?:=.*)?|--host(?:=.*)?)$/u.test(v)) return null;
    if (SYSTEMCTL_VALUE.has(v)) k += 1;
    else if (!v.startsWith("-")) (verb === null ? (verb = v) : units.push(v));
  }
  if (!SYSTEMCTL_VERBS.has(verb)) return null;
  const unit = units.find(unitIsTailscaled);
  return unit ? `\`systemctl ${verb} ${unit}\`` : null;
}

function judgeService(args) {
  const [unit, action] = args.map((w) => w.text);
  return unit && action && /^tailscaled(?:\.service)?$/u.test(unit) && SERVICE_ACTIONS.has(action) ? `\`service ${unit} ${action}\`` : null;
}

function judgeKill(name, args) {
  const flags = new Set();
  const operands = [];
  const valueFlags = name === "killall" ? KILLALL_VALUE : PKILL_VALUE;
  for (let k = 0; k < args.length; k += 1) {
    const v = args[k].text;
    if (v === null) operands.push(null);
    else if (valueFlags.has(v)) k += 1;
    else if (name === "killall" && v === "-I") flags.add("I");
    else if (/^-(?:\d+|(?:SIG)?[A-Z][A-Z0-9+-]*)$/u.test(v)) continue;
    else if (/^-[a-z]+$/u.test(v)) for (const c of v.slice(1)) flags.add(c);
    else if (v.startsWith("--")) flags.add(v);
    else operands.push(v);
  }
  const test = (pattern, subject, { regex, exact, ignoreCase }) => {
    if (!regex) return ignoreCase ? pattern.toLowerCase() === subject.toLowerCase() : pattern === subject;
    try {
      return new RegExp(exact ? `^(?:${pattern})$` : pattern, ignoreCase ? "iu" : "u").test(subject);
    } catch {
      return subject.includes(pattern);
    }
  };
  if (name === "killall") {
    // A plain killall name must equal the process name; -r searches a regex in it.
    const options = { regex: flags.has("r") || flags.has("--regexp"), exact: false, ignoreCase: flags.has("I") || flags.has("--ignore-case") };
    const hit = operands.find((p) => p !== null && test(p, "tailscaled", options));
    return hit ? `\`killall ${hit}\`` : null;
  }
  const pattern = operands[0];
  if (typeof pattern !== "string") return null;
  const full = flags.has("f") || flags.has("--full");
  const options = { regex: true, exact: flags.has("x") || flags.has("--exact"), ignoreCase: flags.has("i") || flags.has("--ignore-case") };
  return test(pattern, full ? SYSTEM_TAILSCALED : "tailscaled", options) ? `\`${name} ${full ? "-f " : ""}${pattern}\` matches tailscaled` : null;
}

// Index of the command a run of wrappers runs (`sudo -n env X=1 nice …`).
function unwrap(words) {
  let i = 0;
  for (let guard = 0; guard < 16 && i < words.length; guard += 1) {
    const name = words[i].text === null ? null : basename(words[i].text);
    const valueFlags = name !== null && Object.hasOwn(WRAPPERS, name) ? WRAPPERS[name] : null;
    if (!valueFlags) break;
    i += 1;
    while (i < words.length) {
      const v = words[i].text;
      if (v === null) return i;
      if (v === "--") {
        i += 1;
        break;
      }
      if (!v.startsWith("-") || v === "-") break;
      i += valueFlags.has(v) ? 2 : 1;
    }
    if (name === "sudo" || name === "env" || name === "doas") while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/u.test(words[i].text ?? "")) i += 1;
    if (name === "timeout") i += 1;
  }
  return i;
}

// What a shell runs: { code } for -c, { stdin: true } when it reads its
// script from stdin, null for a script run by path.
function shellInput(args) {
  let command = false;
  let stdin = false;
  for (let k = 0; k < args.length; k += 1) {
    const v = args[k].text;
    if (v === null) return null;
    if (v === "--") return command ? { code: args[k + 1]?.text ?? null } : args[k + 1] ? null : { stdin: true };
    if (/^[-+][oO]$/u.test(v)) k += 1;
    else if (/^-[A-Za-z]+$/u.test(v)) {
      command ||= v.includes("c");
      stdin ||= v.includes("s");
    } else if (!/^\+[A-Za-z]+$/u.test(v) && !v.startsWith("--")) return command ? { code: v } : stdin ? { stdin: true } : null;
  }
  return command ? null : { stdin: true };
}

function judge(command, depth) {
  const at = unwrap(command.words);
  const program = command.words[at]?.text;
  if (!program) return null;
  const name = basename(program.replace(/^=/u, ""));
  const args = command.words.slice(at + 1);
  const nested = (code) => (typeof code === "string" ? reasonIn(code, depth + 1) : null);
  if (SHELLS.has(name)) {
    const input = shellInput(args);
    return input?.code !== undefined ? nested(input.code) : input?.stdin ? nested(command.stdinCode) : null;
  }
  switch (name) {
    case "tailscale":
      return judgeTailscale(args);
    case "systemctl":
      return judgeSystemctl(args);
    case "service":
      return judgeService(args);
    case "pkill":
    case "killall":
      return judgeKill(name, args);
    case "su":
    case "runuser": {
      const flag = args.findIndex((w) => w.text === "-c" || w.text === "--command");
      return flag >= 0 ? nested(args[flag + 1]?.text) : null;
    }
    case "eval":
      return args.every((w) => w.text !== null) ? nested(args.map((w) => w.text).join(" ")) : null;
    case "watch": {
      let k = 0;
      while (k < args.length && args[k].text?.startsWith("-")) k += ["-n", "--interval"].includes(args[k].text) ? 2 : 1;
      const rest = args.slice(k);
      return rest.every((w) => w.text !== null) ? nested(rest.map((w) => w.text).join(" ")) : null;
    }
    default:
      return null;
  }
}

function* simpleCommands(list, depth) {
  for (const pipeline of list.items) for (const cmd of pipeline.cmds) yield* commandsIn(cmd, depth);
}

// Substitutions run in this Environment too: `$(…)`, backticks, `<(…)`.
function* substitutions(tokens, depth) {
  for (const token of tokens) {
    for (const part of token?.parts ?? []) {
      if ((part.k === "cmd" || part.k === "proc") && depth < MAX_DEPTH) yield* simpleCommands(parseShell(part.src), depth + 1);
    }
  }
}

function* commandsIn(cmd, depth) {
  const targets = cmd.redirs.map((r) => r.target).filter(Boolean);
  if (cmd.type === "compound") {
    for (const list of cmd.body) yield* simpleCommands(list, depth);
    yield* substitutions([...(cmd.loopWords ?? []), ...(cmd.subject ? [cmd.subject] : []), ...targets], depth);
    return;
  }
  yield* substitutions([...cmd.assigns.map((a) => a.value), ...cmd.words, ...targets], depth);
  const stdinCode = cmd.redirs
    .map((r) => (r.op === "<<" || r.op === "<<-" ? r.body ?? "" : r.op === "<<<" ? wordOf(r.target).text : null))
    .filter((code) => typeof code === "string")
    .join("\n");
  yield { words: cmd.words.map(wordOf), stdinCode: stdinCode || null, depth };
}

function reasonIn(src, depth) {
  if (depth > MAX_DEPTH) return null;
  for (const command of simpleCommands(parseShell(src), depth)) {
    const reason = judge(command, command.depth);
    if (reason) return reason;
  }
  return null;
}

// Last resort when the command cannot be parsed.
function coarse(command) {
  const flat = command.replace(/\\\n/gu, " ");
  const tailscale = /(?:^|[\s;&|(`'"])(?:\S*\/)?tailscale((?:\s+-{1,2}[\w-]+(?:=\S*)?)*)\s+(up|down|login|logout|switch|set|set-operator|serve|funnel|update)(?=$|[\s;&|)`'"])/u.exec(flat);
  if (tailscale && !/-{1,2}socket\b/u.test(tailscale[1]) && !/\s--?list\b/u.test(flat)) {
    return `\`tailscale ${tailscale[2]}\` in a command that could not be parsed exactly`;
  }
  const systemctl = /(?:^|[\s;&|(`'"])(?:\S*\/)?systemctl\s+(?:-{1,2}[\w-]+\s+)*(stop|restart|try-restart|reload-or-restart|kill|disable|mask)\s+(?:\S+\s+)*?tailscaled(?:\.service)?(?=$|[\s;&|)`'"])/u.exec(flat);
  if (systemctl && !/\s--user\b/u.test(flat)) return `\`systemctl ${systemctl[1]} tailscaled\` in a command that could not be parsed exactly`;
  return null;
}

// The reason a tool call would change the Environment's own tailnet, or null.
export function tailnetReason(input) {
  if (input?.tool_name !== "Bash" && input?.tool_name !== "Monitor") return null;
  const command = input?.tool_input?.command;
  if (typeof command !== "string" || !/tail|systemctl|service|kill/u.test(command)) return null;
  try {
    return reasonIn(command, 0);
  } catch (error) {
    if (error instanceof ShellParseError) return coarse(command);
    throw error;
  }
}

export function denyMessage(reason) {
  return [
    `Lazurio tailnet guard: ${reason} would change this Environment's own tailnet, the system tailscaled that every thread here shares, so the call was not run.`,
    `For a foreign tailnet use \`bun run tailnet -- up|status|doctor|run|proxy|ssh-proxy|down …\`: each has its own tailscaled and socket under ${TAILNETS_ROOT}/<name>/run/.`,
    "The Environment's own network is managed by Machines.",
    `Rules: ${MANUAL}.`,
  ].join(" ");
}

export function hookResponse(input) {
  const reason = tailnetReason(input);
  if (!reason) return null;
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: denyMessage(reason),
    },
  };
}

if (import.meta.main) {
  try {
    const response = hookResponse(JSON.parse(await Bun.stdin.text()));
    if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
  } catch (error) {
    process.stderr.write(`tailnet guard: internal ${error?.name ?? "error"}; allowing the call\n`);
  }
  process.exit(0);
}
