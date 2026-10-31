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
// funnel|update` without --socket, on the system socket, or on a socket whose
// target cannot be known before the command runs; `systemctl
// stop|restart|try-restart|reload-or-restart|force-reload|kill|disable|mask`
// of tailscaled (not --user); `service tailscaled stop|restart`; `pkill` and
// `killall` patterns that match the system tailscaled. Read-only forms pass:
// status, ping, netcheck, ip, whois, version, dns status, debug prefs,
// `switch --list`, `serve status`, `funnel status`, `update --dry-run`, help.
//
// A socket is followed the way the kernel follows it: a relative path from
// every directory the command may be in (the hook's `cwd`, each `cd` and
// `pushd`, a wrapper's --chdir), `~` and $HOME expanded, links and `..`
// taken physically, then compared with the system socket by path and by
// file. A variable, a substitution, a glob, an unknown directory, a link
// loop or a component the guard may not read leave the target unknown.
//
// Commands are read with the parser of scripts/custody/shell-taint.mjs,
// through sudo/env/timeout-like wrappers, `sh -c`, `su -c`, `eval`, command
// substitutions and code fed to a shell on stdin. Not seen: commands put
// together at run time, scripts run by path, links the command itself makes,
// and commands that run elsewhere (ssh, docker exec), which do not reach this
// Environment's tailscaled.
import { lstatSync, readlinkSync, statSync } from "node:fs";
import { homedir } from "node:os";
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
// Links followed in one path before it counts as a loop, as in Linux.
const MAX_LINKS = 40;

// Wrappers that run the rest of their words as a command: the options whose
// value is the next word (or the rest of a cluster such as `-nu root`), and
// those that move the command elsewhere, `chdir` to their value and `login`
// to a home the guard does not know.
const words = (list) => new Set(list.split(" "));
const wrapper = (values, { chdir = "", login = "" } = {}) => ({ values: words(values), chdir: words(chdir), login: words(login) });
const WRAPPERS = {
  sudo: wrapper("-u -g -C -p -h -D -r -t -T -U --user --group --close-from --prompt --host --chdir --role --type --command-timeout --other-user", {
    chdir: "-D --chdir",
    login: "-i --login",
  }),
  doas: wrapper("-u -C"),
  env: wrapper("-u -C -S --unset --chdir --split-string", { chdir: "-C --chdir" }),
  command: wrapper(""),
  builtin: wrapper(""),
  exec: wrapper("-a"),
  nohup: wrapper(""),
  time: wrapper("-f -o --format --output"),
  nice: wrapper("-n --adjustment"),
  ionice: wrapper("-c -n -p -P -u --class --classdata"),
  timeout: wrapper("-s -k --signal --kill-after"),
  stdbuf: wrapper("-i -o -e --input --output --error"),
  setsid: wrapper(""),
  // nsenter's -w/--wd takes its value attached, or else the target's directory.
  nsenter: wrapper("-t --target -S --setuid -G --setgid", { chdir: "-w --wd" }),
  unshare: wrapper("-S --setuid -G --setgid -R --root -w --wd --map-user --map-group --map-users --map-groups --propagation --setgroups", { chdir: "-w --wd" }),
  setpriv: wrapper(
    "--ruid --euid --rgid --egid --reuid --regid --groups --inh-caps --ambient-caps --bounding-set --securebits --pdeathsig --selinux-label --apparmor-profile --landlock-access --landlock-rule",
  ),
  runuser: wrapper("-u -g -G --user --group --supp-group -s --shell -w --whitelist-environment"),
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

// The parts of a word after its first n characters, which are literal
// (the value of `--socket=…`).
function partsAfter(parts, n) {
  const rest = [];
  let skip = n;
  for (const part of parts) {
    if (skip > 0 && part.k === "lit" && part.v.length <= skip) skip -= part.v.length;
    else if (skip > 0 && part.k === "lit") {
      rest.push({ ...part, v: part.v.slice(skip) });
      skip = 0;
    } else rest.push(part);
  }
  return rest;
}

// The texts a path word expands to, as far as that is known before the
// command runs: its literal parts and a plain $HOME. null for any other
// expansion, and for an unquoted glob or brace, which could expand to another
// path. A `~` at the start of a word is the home; inside one (`--socket=~/…`)
// only zsh expands it (MAGIC_EQUAL_SUBST), so both readings count there.
// Another user's home (`~name`, `~+`, `~-`) is not known.
function pathTexts(parts, home, { inside = false } = {}) {
  let text = "";
  for (const part of parts) {
    if (part.k === "lit" && (part.q || !/[*?[{]/u.test(part.v))) text += part.v;
    else if (part.k === "var" && part.name === "HOME" && part.plain && home !== null) text += home;
    else return null;
  }
  const first = parts[0];
  if (first?.k !== "lit" || first.q || !first.v.startsWith("~")) return [text];
  if (home === null || !/^~(?:\/|$)/u.test(first.v)) return null;
  const expanded = home + text.slice(1);
  return inside ? [text, expanded] : [expanded];
}

// The path the kernel reaches for an absolute path: links followed and `..`
// taken after them, as far as the path exists; a missing rest stays as
// written. null when that is not known before the command runs: a component
// the guard may not read, a link loop, or /proc, whose links depend on the
// process that follows them.
function physicalPath(path) {
  const done = [];
  const todo = path.split("/").filter(Boolean);
  let missingAt = Infinity;
  let links = 0;
  while (todo.length > 0) {
    const part = todo.shift();
    if (part === ".") continue;
    if (part === "..") {
      done.pop();
      if (done.length < missingAt) missingAt = Infinity;
      continue;
    }
    done.push(part);
    if (done[0] === "proc" && done.length > 1) return null;
    if (done.length > missingAt) continue;
    const at = `/${done.join("/")}`;
    let link;
    try {
      link = lstatSync(at).isSymbolicLink() ? readlinkSync(at) : null;
    } catch (error) {
      if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") return null;
      missingAt = done.length;
      continue;
    }
    if (link === null) continue;
    if ((links += 1) > MAX_LINKS) return null;
    done.pop();
    if (link.startsWith("/")) done.length = 0;
    todo.unshift(...link.split("/").filter(Boolean));
  }
  return `/${done.join("/")}`;
}

const fileOf = (path) => {
  try {
    const { dev, ino } = statSync(path, { bigint: true });
    return { dev, ino };
  } catch {
    return null;
  }
};

// The system socket as written, as the kernel reaches it, and its file, so
// that a symbolic or a hard link to it is recognized too.
function systemTargets(sockets) {
  const paths = new Set(sockets);
  for (const socket of sockets) paths.add(physicalPath(socket));
  paths.delete(null);
  return { paths, files: sockets.map(fileOf).filter(Boolean) };
}

function isSystem(target, system) {
  if (system.paths.has(target)) return true;
  const file = system.files.length > 0 ? fileOf(target) : null;
  return file !== null && system.files.some((f) => f.dev === file.dev && f.ino === file.ino);
}

// Every directory the command may run a program in: the hook's `cwd`, and
// each one a `cd`, `pushd` or a wrapper moves to, wherever it stands (a loop
// or a function can run it before a line written earlier). Only an absolute
// target is followed, as written (`cd -L`) and physically (`cd -P`); null
// stands for a directory that is not known before the command runs.
function workingDirectories(runs, cwd, home) {
  const dirs = new Set([cwd]);
  const add = (texts) => {
    if (texts === null || texts.some((text) => typeof text !== "string" || !text.startsWith("/"))) dirs.add(null);
    else for (const text of texts) dirs.add(posix.normalize(text)).add(physicalPath(text));
  };
  for (const run of runs) {
    if (run.unparsed !== undefined) dirs.add(null);
    for (const move of run.moves) add(move === null ? null : pathTexts(move, home, { inside: true }));
    if (run.program === "cd" || run.program === "pushd") add(cdTarget(run.program, run.args, home));
    else if (run.program === "popd") dirs.add(null);
    else if (run.program === "su" && run.args.some((w) => ["-", "-l", "--login"].includes(w.text))) dirs.add(null);
  }
  return dirs;
}

// Where `cd` or `pushd` goes: its operand, or the home for a bare `cd`. null
// for a bare `pushd` (a swap) or a second operand (zsh's `cd old new`); `-`
// and a relative path, which the directory at that point or CDPATH decides,
// come back relative and count as unknown too.
function cdTarget(program, args, home) {
  const operands = [];
  let options = true;
  for (const word of args) {
    if (options && word.text === "--") options = false;
    else if (!(options && /^-[LPe@qs]+$/u.test(word.text ?? ""))) operands.push(word);
  }
  if (operands.length === 0) return program === "cd" && home !== null ? [home] : null;
  return operands.length === 1 ? pathTexts(operands[0].token.parts, home) : null;
}

// Why a changing `tailscale` call on this socket can reach the system
// tailscaled, or null: each text the socket word may expand to, from each
// directory the command may be in, has to lead elsewhere.
function judgeSocket(verb, texts, scene) {
  if (texts === null) return `${verb} on a socket that is not known before the command runs`;
  for (const text of texts) {
    if (text === "") return `${verb} with an empty --socket, which is the system socket`;
    const candidates = text.startsWith("/") ? [text] : [...scene.directories()].map((dir) => (dir === null ? null : `${dir}/${text}`));
    for (const candidate of candidates) {
      if (candidate === null) return `${verb} on ${text} from a directory that is not known before the command runs`;
      const target = physicalPath(candidate);
      if (target === null) return `${verb} on ${text}, which cannot be followed before the command runs`;
      if (isSystem(target, scene.system())) return target === text ? `${verb} on ${text}` : `${verb} on ${text}, which is ${target}`;
    }
  }
  return null;
}

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

function judgeTailscale(args, scene) {
  // undefined: no --socket, so the default, which is the system socket;
  // otherwise the texts the socket word expands to, null if not known.
  let socket;
  let sub = null;
  const rest = [];
  for (let k = 0; k < args.length; k += 1) {
    const { text, head, token } = args[k];
    const flag = text ?? head;
    if (/^--?socket(?:=|$)/u.test(flag)) {
      if (flag.includes("=")) socket = pathTexts(partsAfter(token.parts, flag.indexOf("=") + 1), scene.home, { inside: true });
      else if (text === null) socket = null;
      else {
        socket = args[k + 1] ? pathTexts(args[k + 1].token.parts, scene.home) : null;
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
  const verb = `\`tailscale ${sub}\``;
  return socket === undefined ? `${verb} without --socket` : judgeSocket(verb, socket, scene);
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

// The option at words[i] of a wrapper: notes a move to another directory
// (the parts of its value, read as if inside a word, or null when the guard
// cannot know it) and returns how many words it takes.
function wrapperOption(words, i, options, moves) {
  const v = words[i].text;
  if (v.startsWith("--")) {
    const eq = v.indexOf("=");
    const flag = eq > 0 ? v.slice(0, eq) : v;
    const next = eq < 0 && options.values.has(flag);
    if (options.chdir.has(flag)) moves.push(eq > 0 ? partsAfter(words[i].token.parts, eq + 1) : next ? (words[i + 1]?.token.parts ?? null) : null);
    if (options.login.has(flag)) moves.push(null);
    return next ? 2 : 1;
  }
  for (let c = 1; c < v.length; c += 1) {
    const flag = `-${v[c]}`;
    if (options.login.has(flag)) moves.push(null);
    const value = options.values.has(flag);
    if (!value && !options.chdir.has(flag)) continue;
    // The rest of the cluster is the value, or else the next word.
    const attached = c + 1 < v.length;
    if (options.chdir.has(flag)) moves.push(attached ? partsAfter(words[i].token.parts, c + 1) : value ? (words[i + 1]?.token.parts ?? null) : null);
    return attached || !value ? 1 : 2;
  }
  return 1;
}

// Index of the command a run of wrappers runs (`sudo -n env X=1 nice …`),
// and the directories the wrappers move it to.
function unwrap(words) {
  let i = 0;
  const moves = [];
  for (let guard = 0; guard < 16 && i < words.length; guard += 1) {
    const name = words[i].text === null ? null : basename(words[i].text);
    const options = name !== null && Object.hasOwn(WRAPPERS, name) ? WRAPPERS[name] : null;
    if (!options) break;
    i += 1;
    while (i < words.length) {
      const v = words[i].text;
      if (v === null) return { at: i, moves };
      if (v === "--") {
        i += 1;
        break;
      }
      if (!v.startsWith("-") || v === "-") break;
      i += wrapperOption(words, i, options, moves);
    }
    if (name === "sudo" || name === "env" || name === "doas") while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/u.test(words[i].text ?? "")) i += 1;
    if (name === "timeout") i += 1;
  }
  return { at: i, moves };
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

// The code a program hands to a shell in this Environment: `sh -c`, a script
// on stdin, `su -c`, `eval`, `watch`. null for none, or a script run by path.
function nestedCode(program, args, stdinCode) {
  if (SHELLS.has(program)) {
    const input = shellInput(args);
    return input?.code !== undefined ? input.code : input?.stdin ? stdinCode : null;
  }
  switch (program) {
    case "su":
    case "runuser": {
      const flag = args.findIndex((w) => w.text === "-c" || w.text === "--command");
      return flag >= 0 ? (args[flag + 1]?.text ?? null) : null;
    }
    case "eval":
      return args.every((w) => w.text !== null) ? args.map((w) => w.text).join(" ") : null;
    case "watch": {
      let k = 0;
      while (k < args.length && args[k].text?.startsWith("-")) k += ["-n", "--interval"].includes(args[k].text) ? 2 : 1;
      const rest = args.slice(k);
      return rest.every((w) => w.text !== null) ? rest.map((w) => w.text).join(" ") : null;
    }
    default:
      return null;
  }
}

function judge(run, scene) {
  if (run.unparsed !== undefined) return coarse(run.unparsed, scene.system);
  switch (run.program) {
    case "tailscale":
      return judgeTailscale(run.args, scene);
    case "systemctl":
      return judgeSystemctl(run.args);
    case "service":
      return judgeService(run.args);
    case "pkill":
    case "killall":
      return judgeKill(run.program, run.args);
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
  yield { words: cmd.words.map((token) => ({ ...wordOf(token), token })), stdinCode: stdinCode || null, depth };
}

// Every program the command runs, after its wrappers, with the code of nested
// shells read in place. Nested code that cannot be parsed stays one run that
// is judged coarsely, so the commands around it keep their exact reading.
function* runsIn(src, depth) {
  if (depth > MAX_DEPTH) return;
  for (const command of simpleCommands(parseShell(src), depth)) {
    const { at, moves } = unwrap(command.words);
    const word = command.words[at]?.text;
    const program = word ? basename(word.replace(/^=/u, "")) : null;
    const args = command.words.slice(at + 1);
    yield { program, args, moves };
    const code = program ? nestedCode(program, args, command.stdinCode) : null;
    if (typeof code !== "string") continue;
    let nested;
    try {
      nested = [...runsIn(code, command.depth + 1)];
    } catch (error) {
      if (!(error instanceof ShellParseError)) throw error;
      nested = [{ program: null, args: [], moves: [], unparsed: code }];
    }
    yield* nested;
  }
}

const lazy = (make) => {
  let made = false;
  let value;
  return () => {
    if (!made) [made, value] = [true, make()];
    return value;
  };
};

function reasonIn(src, { cwd, home, system }) {
  const runs = [...runsIn(src, 0)];
  const scene = { home, system, directories: lazy(() => workingDirectories(runs, cwd, home)) };
  for (const run of runs) {
    const reason = judge(run, scene);
    if (reason) return reason;
  }
  return null;
}

// Last resort when the command cannot be parsed: a changing `tailscale`
// subcommand passes only on an absolute, plainly written socket that leads
// elsewhere.
function coarse(command, system) {
  const flat = command.replace(/\\\n/gu, " ");
  const tailscale = /(?:^|[\s;&|(`'"])(?:\S*\/)?tailscale((?:\s+-{1,2}[\w-]+(?:=\S*|\s+(?!-)\S+)?)*)\s+(up|down|login|logout|switch|set|set-operator|serve|funnel|update)(?=$|[\s;&|)`'"])/u.exec(flat);
  if (tailscale && !/\s--?list\b/u.test(flat)) {
    const socket = /-{1,2}socket(?:=|\s+)(\S*)/u.exec(tailscale[1])?.[1];
    const target = socket !== undefined && /^\/[\w./@%+,:-]*$/u.test(socket) ? physicalPath(socket) : null;
    if (target === null || isSystem(target, system())) return `\`tailscale ${tailscale[2]}\` in a command that could not be parsed exactly`;
  }
  const systemctl = /(?:^|[\s;&|(`'"])(?:\S*\/)?systemctl\s+(?:-{1,2}[\w-]+\s+)*(stop|restart|try-restart|reload-or-restart|kill|disable|mask)\s+(?:\S+\s+)*?tailscaled(?:\.service)?(?=$|[\s;&|)`'"])/u.exec(flat);
  if (systemctl && !/\s--user\b/u.test(flat)) return `\`systemctl ${systemctl[1]} tailscaled\` in a command that could not be parsed exactly`;
  return null;
}

// Whether $HOME and `~` may mean another directory than the hook's home when
// the command runs: the command changes HOME (an assignment, also as a
// prefix or through env, export, declare, unset, read or printf -v), or
// hands code to a program that may start it with another HOME (sudo, su,
// runuser, doas, env, setpriv, nsenter, chroot, machinectl, ssh). Then
// their value is not known before the command runs.
function homeMayChange(command) {
  // Every mention of HOME other than a plain read of it ($HOME, ${HOME…}) may
  // change it: an assignment, export, declare, unset, read, printf -v or any
  // quoting of the name. What stays after removing the reads decides.
  const withoutReads = command.replace(/\$\{HOME\b[^}]*\}|\$HOME\b/gu, "");
  return (
    /\bHOME\b/u.test(withoutReads) ||
    /(?:^|[\s;&|(`'"])(?:\S*\/)?(?:sudo|su|runuser|doas|env|setpriv|nsenter|chroot|machinectl|ssh)(?=$|[\s;&|)`'"])/u.test(command)
  );
}

// The reason a tool call can change the Environment's own tailnet, or null.
// The hook's `cwd` is where a relative path starts. `home` and
// `systemSockets` stand in for this Environment's in tests.
export function tailnetReason(input, { home = homedir(), systemSockets = SYSTEM_SOCKETS } = {}) {
  if (input?.tool_name !== "Bash" && input?.tool_name !== "Monitor") return null;
  const command = input?.tool_input?.command;
  if (typeof command !== "string" || !/tail|systemctl|service|kill/u.test(command)) return null;
  const cwd = typeof input?.cwd === "string" && posix.isAbsolute(input.cwd) ? input.cwd : null;
  const system = lazy(() => systemTargets(systemSockets));
  try {
    return reasonIn(command, { cwd, home: homeMayChange(command) ? null : home, system });
  } catch (error) {
    if (error instanceof ShellParseError) return coarse(command, system);
    throw error;
  }
}

export function denyMessage(reason) {
  return [
    `Lazurio tailnet guard: ${reason}.`,
    "The call was not run: it can change this Environment's own tailnet, the system tailscaled that every thread here shares, and a socket the guard cannot follow before the command runs counts as that one.",
    `For a foreign tailnet use \`bun run tailnet -- up|status|doctor|run|proxy|ssh-proxy|down …\`, or name its socket by its absolute path: each has its own tailscaled and socket under ${TAILNETS_ROOT}/<name>/run/.`,
    "The Environment's own network is managed by Machines.",
    `Rules: ${MANUAL}.`,
  ].join(" ");
}

export function hookResponse(input, options) {
  const reason = tailnetReason(input, options);
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
