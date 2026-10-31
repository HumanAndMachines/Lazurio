// A small shell reader for the custody print guard. It answers one question:
// can this command put the content of a custody file on stdout or stderr,
// that is, into the agent transcript?
//
// The model is taint tracking over a parsed command. A stream or value is
// CLEAN, holds custody PATHS (names are fine to print), or custody CONTENT.
// Readers (cat, jq, grep, sed, inline interpreters, ...) turn a custody path
// into CONTENT; every other program is a tool that takes paths and prints
// nothing of what it read, so its output is CLEAN. CONTENT may flow into a
// file, a hasher or a tool; it must not reach the transcript.
//
// The agent's shell is bash or zsh (Claude Code runs the user's shell, zsh on
// macOS), and the two route output differently: zsh writes a descriptor
// redirected twice to both targets (MULTIOS) and runs `cat` for redirections
// without a command (NULLCMD). A command counts as printing when either
// shell would print.
//
// This is an accident guard, not a sandbox: scripts run by path, unknown
// programs and files written in an earlier command are trusted. The known
// limits are listed in manual/security/local-secret-custody.md.
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { textNamesCustody } from "./custody-model.mjs";

export const CLEAN = 0;
export const PATHS = 1;
export const CONTENT = 2;
const T = (level, why = "", origin = null) => ({ level, why, origin });
const CLEAN_T = T(CLEAN);
const max = (a, b) => (b.level > a.level ? b : a);
const own = (table, key) => (Object.hasOwn(table, key) ? table[key] : null);
const synthetic = (level, why, value = null, origin = null) => ({ value, pattern: value ?? "", level, why, origin, proc: null });

export class ShellParseError extends Error {}

// ---------------------------------------------------------------- tokens ---

const CONTROL = ["&&", "||", ";;&", ";;", ";&", "|&", "|", "&", ";", "(", ")"];
const REDIRECT = ["&>>", "<<<", "<<-", "&>", ">>", "<<", "<&", ">&", ">|", "<>", "<", ">"];
const WORD_END = new Set([" ", "\t", "\r", "\n", ";", "&", "|", "(", ")", "<", ">"]);

function matchParen(src, open) {
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    const c = src[i];
    if (c === "\\") i += 1;
    else if (c === "'") {
      const end = src.indexOf("'", i + 1);
      if (end < 0) break;
      i = end;
    } else if (c === '"') i = skipDouble(src, i + 1);
    else if (c === "`") i = skipBacktick(src, i + 1);
    else if (c === "(") depth += 1;
    else if (c === ")" && --depth === 0) return i;
  }
  throw new ShellParseError("unbalanced parenthesis");
}

function skipDouble(src, i) {
  for (; i < src.length; i += 1) {
    const c = src[i];
    if (c === "\\") i += 1;
    else if (c === '"') return i;
    else if (c === "$" && src[i + 1] === "(") i = matchParen(src, i + 1);
    else if (c === "`") i = skipBacktick(src, i + 1);
  }
  throw new ShellParseError("unterminated double quote");
}

function skipBacktick(src, i) {
  for (; i < src.length; i += 1) {
    if (src[i] === "\\") i += 1;
    else if (src[i] === "`") return i;
  }
  throw new ShellParseError("unterminated backtick");
}

// Parses `$...` at src[i]; pushes a part and returns the next index. A
// variable part is `plain` when it is `$NAME` or `${NAME}` without an
// operator, so its value is the variable's own.
function lexDollar(src, i, parts) {
  const next = src[i + 1];
  if (next === "(") {
    const end = matchParen(src, i + 1);
    parts.push(src[i + 2] === "(" ? { k: "arith" } : { k: "cmd", src: src.slice(i + 2, end) });
    return end + 1;
  }
  if (next === "{") {
    let depth = 0;
    for (let j = i + 1; j < src.length; j += 1) {
      if (src[j] === "\\") j += 1;
      else if (src[j] === "{") depth += 1;
      else if (src[j] === "}" && --depth === 0) {
        const inner = src.slice(i + 2, j);
        const m = /^[#!]?([A-Za-z_][A-Za-z0-9_]*|[0-9]+|[@*#?$!-])(?:(:?[-=])(.*))?/su.exec(inner);
        parts.push({ k: "var", name: m ? m[1] : "", fallback: m && m[2] ? m[3] : null, plain: Boolean(m) && inner === m[1] });
        return j + 1;
      }
    }
    throw new ShellParseError("unterminated ${");
  }
  const m = /^([A-Za-z_][A-Za-z0-9_]*|[0-9@*#?$!-])/u.exec(src.slice(i + 1, i + 200));
  if (m) {
    parts.push({ k: "var", name: m[1], fallback: null, plain: true });
    return i + 1 + m[1].length;
  }
  parts.push({ k: "lit", v: "$", q: false });
  return i + 1;
}

// Double-quoted text up to `"`, or to the end for here-document bodies.
function lexQuoted(src, i, parts, untilEnd = false) {
  let lit = "";
  const flush = () => {
    if (lit) parts.push({ k: "lit", v: lit, q: true });
    lit = "";
  };
  while (i < src.length) {
    const c = src[i];
    if (c === '"' && !untilEnd) {
      flush();
      return i + 1;
    }
    if (c === "\\" && "$`\"\\\n".includes(src[i + 1] ?? "")) {
      if (src[i + 1] !== "\n") lit += src[i + 1];
      i += 2;
    } else if (c === "$") {
      flush();
      i = lexDollar(src, i, parts);
    } else if (c === "`") {
      flush();
      const end = skipBacktick(src, i + 1);
      parts.push({ k: "cmd", src: src.slice(i + 1, end) });
      i = end + 1;
    } else {
      lit += c;
      i += 1;
    }
  }
  if (!untilEnd) throw new ShellParseError("unterminated double quote");
  flush();
  return i;
}

// Bash's `$'…'` with its escapes decoded as bash decodes them; an unknown
// escape keeps its backslash and a NUL ends the string. A byte above 0x7f
// (`\\351`, `\\xe9`) or an invalid code point has no exact text here, so the
// string is then an unknown part, like an expansion.
const ANSI_C = { a: "\x07", b: "\b", e: "\x1b", E: "\x1b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v", "\\": "\\", "'": "'", '"': '"', "?": "?" };
function lexAnsiC(src, i, parts) {
  let v = "";
  let known = true;
  let ended = false;
  const byte = (n) => {
    if (n === 0) ended = true;
    else if (n > 0x7f) known = false;
    else if (!ended) v += String.fromCharCode(n);
  };
  for (; i < src.length && src[i] !== "'"; i += 1) {
    const c = src[i + 1];
    let m;
    if (src[i] !== "\\") {
      if (!ended) v += src[i];
    } else if (c === undefined) break;
    else if (Object.hasOwn(ANSI_C, c)) {
      if (!ended) v += ANSI_C[c];
      i += 1;
    } else if ((m = /^[0-7]{1,3}/u.exec(src.slice(i + 1, i + 4)))) {
      byte(Number.parseInt(m[0], 8) & 0xff);
      i += m[0].length;
    } else if (c === "x" && (m = /^[0-9A-Fa-f]{1,2}/u.exec(src.slice(i + 2, i + 4)))) {
      byte(Number.parseInt(m[0], 16));
      i += 1 + m[0].length;
    } else if ((c === "u" || c === "U") && (m = (c === "u" ? /^[0-9A-Fa-f]{1,4}/u : /^[0-9A-Fa-f]{1,8}/u).exec(src.slice(i + 2, i + 10)))) {
      const point = Number.parseInt(m[0], 16);
      if (point === 0) ended = true;
      else if (point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff)) known = false;
      else if (!ended) v += String.fromCodePoint(point);
      i += 1 + m[0].length;
    } else if (c === "c" && i + 2 < src.length && src[i + 2] !== "'") {
      const x = src[i + 2];
      byte(x === "?" ? 0x7f : x.toUpperCase().charCodeAt(0) & 0x1f);
      i += x === "\\" && src[i + 3] === "\\" ? 3 : 2;
    } else {
      if (!ended) v += `\\${c}`;
      i += 1;
    }
  }
  if (i >= src.length) throw new ShellParseError("unterminated $'");
  parts.push(known ? { k: "lit", v, q: true } : { k: "unknown" });
  return i + 1;
}

function lexWord(src, start) {
  const parts = [];
  let lit = "";
  const flush = () => {
    if (lit) parts.push({ k: "lit", v: lit, q: false });
    lit = "";
  };
  let i = start;
  while (i < src.length) {
    const c = src[i];
    if ((c === "<" || c === ">") && src[i + 1] === "(" && i === start) {
      const end = matchParen(src, i + 1);
      parts.push({ k: "proc", src: src.slice(i + 2, end) });
      i = end + 1;
    } else if (WORD_END.has(c)) break;
    else if (c === "\\") {
      if (src[i + 1] !== "\n") lit += src[i + 1] ?? "";
      i += 2;
    } else if (c === "'") {
      flush();
      const end = src.indexOf("'", i + 1);
      if (end < 0) throw new ShellParseError("unterminated single quote");
      parts.push({ k: "lit", v: src.slice(i + 1, end), q: true });
      i = end + 1;
    } else if (c === "$" && src[i + 1] === "'") {
      flush();
      i = lexAnsiC(src, i + 2, parts);
    } else if (c === '"') {
      flush();
      i = lexQuoted(src, i + 1, parts);
    } else if (c === "`") {
      flush();
      const end = skipBacktick(src, i + 1);
      parts.push({ k: "cmd", src: src.slice(i + 1, end) });
      i = end + 1;
    } else if (c === "$") {
      flush();
      i = lexDollar(src, i, parts);
    } else {
      lit += c;
      i += 1;
    }
  }
  flush();
  return { tok: { t: "word", parts }, end: i };
}

export function tokenize(src) {
  const tokens = [];
  const pending = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === " " || c === "\t" || c === "\r") i += 1;
    else if (c === "\\" && src[i + 1] === "\n") i += 2;
    else if (c === "#") {
      while (i < src.length && src[i] !== "\n") i += 1;
    } else if (c === "\n") {
      tokens.push({ t: "op", v: "\n" });
      i += 1;
      for (const heredoc of pending.splice(0)) {
        const lines = [];
        while (i < src.length) {
          const eol = src.indexOf("\n", i);
          const line = src.slice(i, eol < 0 ? src.length : eol);
          i = eol < 0 ? src.length : eol + 1;
          if ((heredoc.op === "<<-" ? line.replace(/^\t+/u, "") : line) === heredoc.delimiter) break;
          lines.push(line);
        }
        heredoc.body = lines.join("\n");
      }
    } else {
      const fd = /^\d+(?=[<>])/u.exec(src.slice(i, i + 8));
      const at = fd ? i + fd[0].length : i;
      const procSub = (src[at] === "<" || src[at] === ">") && src[at + 1] === "(";
      const redirect = procSub ? null : REDIRECT.find((op) => src.startsWith(op, at));
      const control = fd || procSub ? null : CONTROL.find((op) => src.startsWith(op, i));
      if (redirect) {
        const token = { t: "redir", op: redirect, fd: fd ? Number(fd[0]) : null };
        i = at + redirect.length;
        if (redirect === "<<" || redirect === "<<-") {
          while (src[i] === " " || src[i] === "\t") i += 1;
          const { tok, end } = lexWord(src, i);
          if (end === i) throw new ShellParseError("here-document without delimiter");
          token.delimiter = tok.parts.map((part) => (part.k === "lit" ? part.v : "$")).join("");
          token.quoted = tok.parts.some((part) => part.q);
          token.body = "";
          pending.push(token);
          i = end;
        }
        tokens.push(token);
      } else if (control) {
        tokens.push({ t: "op", v: control });
        i += control.length;
      } else {
        const { tok, end } = lexWord(src, i);
        if (end === i) throw new ShellParseError("unexpected character");
        tokens.push(tok);
        i = end;
      }
    }
  }
  return tokens;
}

// ---------------------------------------------------------------- parser ---

const literalOf = (tok) =>
  tok && tok.t === "word" && tok.parts.length === 1 && tok.parts[0].k === "lit" && !tok.parts[0].q ? tok.parts[0].v : null;
const listOf = (cmd) => ({ type: "list", items: [{ type: "pipeline", cmds: [cmd] }] });
// `a |& b` is `a 2>&1 | b`, applied after a's own redirections in both shells.
const STDERR_TO_PIPE = Object.freeze({ t: "redir", op: ">&", fd: 2, target: { t: "word", parts: [{ k: "lit", v: "1", q: false }] } });

class Parser {
  constructor(tokens) {
    this.tokens = tokens;
    this.i = 0;
  }
  peek(offset = 0) {
    return this.tokens[this.i + offset];
  }
  isOp(v, offset = 0) {
    const t = this.peek(offset);
    return Boolean(t && t.t === "op" && t.v === v);
  }
  word() {
    return literalOf(this.peek());
  }
  expectWord(v) {
    if (this.word() !== v) throw new ShellParseError(`expected ${v}`);
    this.i += 1;
  }
  expectOp(v) {
    if (!this.isOp(v)) throw new ShellParseError(`expected ${v}`);
    this.i += 1;
  }
  skip(...ops) {
    while (ops.some((op) => this.isOp(op))) this.i += 1;
  }

  list(stops) {
    const items = [];
    for (;;) {
      this.skip("\n", ";", "&");
      const t = this.peek();
      if (!t || (t.t === "op" && [")", ";;", ";&", ";;&"].includes(t.v)) || stops.has(this.word())) break;
      items.push(this.pipeline());
      while (this.isOp("&&") || this.isOp("||")) {
        this.i += 1;
        this.skip("\n");
        items.push(this.pipeline());
      }
    }
    return { type: "list", items };
  }

  pipeline() {
    if (this.word() === "!") this.i += 1;
    const cmds = [this.command()];
    while (this.isOp("|") || this.isOp("|&")) {
      if (this.isOp("|&")) cmds.at(-1).redirs.push(STDERR_TO_PIPE);
      this.i += 1;
      this.skip("\n");
      cmds.push(this.command());
    }
    return { type: "pipeline", cmds };
  }

  compound(body, extra = {}) {
    const redirs = [];
    while (this.peek()?.t === "redir") redirs.push(this.redirect());
    return { type: "compound", body, redirs, ...extra };
  }

  skipBalanced() {
    let depth = 0;
    do {
      const t = this.peek();
      if (!t) throw new ShellParseError("unbalanced (( ))");
      if (t.t === "op" && t.v === "(") depth += 1;
      if (t.t === "op" && t.v === ")") depth -= 1;
      this.i += 1;
    } while (depth > 0);
  }

  command() {
    const t = this.peek();
    if (!t) throw new ShellParseError("missing command");
    if (t.t === "op" && t.v === "(") {
      if (this.isOp("(", 1)) {
        this.skipBalanced();
        return this.compound([]);
      }
      this.i += 1;
      const body = this.list(new Set());
      this.expectOp(")");
      return this.compound([body], { subshell: true });
    }
    switch (this.word()) {
      case "{": {
        this.i += 1;
        const body = this.list(new Set(["}"]));
        this.expectWord("}");
        return this.compound([body]);
      }
      case "if": {
        this.i += 1;
        const lists = [this.list(new Set(["then"]))];
        this.expectWord("then");
        lists.push(this.list(new Set(["elif", "else", "fi"])));
        while (this.word() === "elif") {
          this.i += 1;
          lists.push(this.list(new Set(["then"])));
          this.expectWord("then");
          lists.push(this.list(new Set(["elif", "else", "fi"])));
        }
        if (this.word() === "else") {
          this.i += 1;
          lists.push(this.list(new Set(["fi"])));
        }
        this.expectWord("fi");
        return this.compound(lists);
      }
      case "while":
      case "until": {
        this.i += 1;
        const cond = this.list(new Set(["do"]));
        this.expectWord("do");
        const body = this.list(new Set(["done"]));
        this.expectWord("done");
        return this.compound([cond, body]);
      }
      case "for":
      case "select": {
        this.i += 1;
        let loopVar = null;
        const loopWords = [];
        if (this.isOp("(")) this.skipBalanced();
        else {
          loopVar = this.word();
          this.i += 1;
          this.skip("\n");
          if (this.word() === "in") {
            this.i += 1;
            while (this.peek()?.t === "word" && this.word() !== "do") loopWords.push(this.tokens[this.i++]);
          }
        }
        this.skip("\n", ";");
        this.expectWord("do");
        const body = this.list(new Set(["done"]));
        this.expectWord("done");
        return this.compound([body], { loopVar, loopWords });
      }
      case "case": {
        this.i += 1;
        const subject = this.peek();
        this.i += 1;
        this.skip("\n");
        this.expectWord("in");
        const bodies = [];
        for (;;) {
          this.skip("\n", ";");
          if (this.word() === "esac") {
            this.i += 1;
            break;
          }
          while (!this.isOp(")")) {
            if (!this.peek()) throw new ShellParseError("unterminated case");
            this.i += 1;
          }
          this.i += 1;
          bodies.push(this.list(new Set(["esac"])));
          this.skip(";;", ";&", ";;&");
        }
        return this.compound(bodies, { subject });
      }
      case "function": {
        this.i += 2;
        if (this.isOp("(")) {
          this.i += 1;
          this.expectOp(")");
        }
        this.skip("\n");
        return this.compound([listOf(this.command())]);
      }
      case "[[": {
        const words = [];
        while (this.peek() && this.word() !== "]]") {
          if (this.peek().t === "word") words.push(this.peek());
          this.i += 1;
        }
        this.expectWord("]]");
        return { type: "simple", assigns: [], words, redirs: [] };
      }
      default:
        return this.simple();
    }
  }

  redirect() {
    const token = this.tokens[this.i++];
    if (token.op === "<<" || token.op === "<<-") return token;
    const target = this.peek();
    if (!target || target.t !== "word") throw new ShellParseError("redirection without target");
    this.i += 1;
    return { ...token, target };
  }

  simple() {
    const cmd = { type: "simple", assigns: [], words: [], redirs: [] };
    for (let t = this.peek(); t; t = this.peek()) {
      if (t.t === "redir") cmd.redirs.push(this.redirect());
      else if (t.t !== "word") break;
      else if (cmd.words.length === 0 && splitAssignment(t)) {
        cmd.assigns.push(splitAssignment(t));
        this.i += 1;
      } else if (cmd.words.length === 0 && this.isOp("(", 1) && this.isOp(")", 2)) {
        this.i += 3;
        this.skip("\n");
        return this.compound([listOf(this.command())]);
      } else {
        cmd.words.push(t);
        this.i += 1;
      }
    }
    if (!cmd.words.length && !cmd.assigns.length && !cmd.redirs.length) throw new ShellParseError("unexpected token");
    return cmd;
  }
}

function splitAssignment(tok) {
  const first = tok.parts[0];
  if (!first || first.k !== "lit" || first.q) return null;
  const m = /^([A-Za-z_][A-Za-z0-9_]*)(?:\[[^\]]*\])?\+?=/u.exec(first.v);
  if (!m) return null;
  const rest = first.v.slice(m[0].length);
  return { name: m[1], value: { t: "word", parts: [...(rest ? [{ k: "lit", v: rest, q: false }] : []), ...tok.parts.slice(1)] } };
}

export function parseShell(src) {
  const parser = new Parser(tokenize(src));
  const list = parser.list(new Set());
  if (parser.peek()) throw new ShellParseError("unexpected token");
  return list;
}

// ------------------------------------------------------------- programs ---

const words = (list) => new Set(list.split(" "));
const READERS = words(
  "cat tac nl head tail less more most bat batcat strings od xxd hexdump hd base64 base32 basenc uuencode " +
    "rev fold fmt pr expand unexpand column cut paste sort uniq tr iconv colrm look comm join awk gawk mawk nawk " +
    "sed gsed grep egrep fgrep ggrep zgrep rg ag ack ugrep jq gojq jaq yq xq tomlq dasel gron fx jless mlr " +
    "xmllint csvlook prettier json zcat gzcat bzcat xzcat zstdcat lz4cat sqlite3 ed ex diff colordiff sdiff " +
    "delta difft icdiff",
);
const GREP_LIKE = words("grep egrep fgrep ggrep zgrep rg ag ack ugrep");
// Readers whose first operand is a program or pattern, not a file.
const PROGRAM_FIRST = words("grep egrep fgrep ggrep zgrep rg ag ack ugrep jq gojq jaq yq sed gsed awk gawk mawk nawk");
const grepProgramFlag = (v) => v === "--regexp" || v === "--file" || /^-[A-Za-z]*[ef]$/u.test(v);
const PROGRAM_FLAGS = {
  ...Object.fromEntries([..."grep egrep fgrep ggrep zgrep rg ag ack ugrep".split(" ")].map((n) => [n, grepProgramFlag])),
  ...Object.fromEntries(["jq", "gojq", "jaq"].map((n) => [n, (v) => v === "-f" || v === "--from-file"])),
  ...Object.fromEntries(["sed", "gsed"].map((n) => [n, (v) => ["-e", "-f", "--expression", "--file"].includes(v)])),
  ...Object.fromEntries(["awk", "gawk", "mawk", "nawk"].map((n) => [n, (v) => ["-f", "--file", "-e", "--source"].includes(v)])),
};
// Flags of grep-like readers whose next word is a value, not a file.
const GREP_VALUE_FLAGS = words("-A -B -C -m -g -t -T -M -j -d -D --max-count --context --type --type-not --glob --iglob");
// Flags of common readers whose next word is a value, not a file.
const READER_VALUE_FLAGS = {
  head: words("-n -c"),
  tail: words("-n -c"),
  cut: words("-d -f -c -b"),
  sort: words("-k -t -o -S -T"),
  uniq: words("-f -s"),
  xxd: words("-c -l -s -g"),
  od: words("-t -N -j -A"),
  hexdump: words("-n -s -e -f"),
  jq: words("--indent"),
  fold: words("-w"),
  fmt: words("-w"),
  column: words("-s -c"),
};
// Readers that only read stdin: their operands are never files.
const STDIN_ONLY = words("tr");
const LISTERS = words("ls tree realpath readlink dirname basename du stat file");
const DIFFS = words("diff colordiff sdiff delta difft icdiff");
const WELL_KNOWN_VARS = words("HOME PWD OLDPWD PATH USER LOGNAME SHELL TMPDIR TERM LANG LC_ALL PS1");
// The only environment values used to resolve paths. Other variables may hold
// secrets (tokens in the agent's environment), and a resolved value can end up
// in a deny reason, so they stay unknown.
const PATH_VARS = words("TMPDIR XDG_CONFIG_HOME XDG_DATA_HOME XDG_STATE_HOME XDG_CACHE_HOME USER LOGNAME");
const ENV_ACCESS = /environ|getenv|process\.env|Bun\.env|Deno\.env|ENV\[|\$ENV\{/u;
const PYTHON_READER_MODULES = words("json.tool base64 pickletools pickle quopri uu pprint");
// Program text that can write what it reads somewhere other than stdout:
// stderr (awk/sed device names, jq builtins), any open descriptor, the tty.
const STDERR_CAPABLE = /\/dev\/(stderr|fd\/2)|>&\s*2|\bsystem\s*\(|\|\s*"/u;
const JQ_LIKE = words("jq gojq jaq yq");
const JQ_STDERR = /\b(?:halt_error|error|debug|stderr)\b/u;
const ANY_FD = /\/dev\/fd\/\d|\bsystem\s*\(|\|\s*"/u;

const valueOf = (w) => w?.value ?? "";
const isOption = (w) => valueOf(w).startsWith("-") && valueOf(w) !== "-";
const flagChars = (v) => (/^-[A-Za-z0-9.]+$/u.test(v) ? v.slice(1) : "");
// zsh runs `=cat` as the path of `cat` (EQUALS).
const progName = (w) => (w && w.value ? basename(w.value.replace(/^=/u, "")).toLowerCase() : null);
const INPUT_OPS = new Set(["<", "<>", "<<<", "<<", "<<-", "<&"]);
const noInput = () => ({ stdin: CLEAN_T, other: CLEAN_T, heredoc: null });

class Analysis {
  constructor({ model, cwd, env }) {
    this.model = model;
    this.cwd = cwd;
    this.env = env;
    this.vars = new Map();
    this.positional = [];
    this.tainted = new Map();
    this.sourced = null;
    this.xtrace = false;
    this.findings = [];
    // The scope collects content that reaches descriptors the current
    // commands inherit (stderr, fd 3…); `side` is what the running command
    // writes besides its stdout, keyed by descriptor ("*" = any open one).
    this.scope = { emitted: new Map() };
    this.side = new Map();
    // `exec` with only redirections keeps them for later commands, so a
    // descriptor it opens may lead to the transcript.
    this.execRedirects = false;
    this.depth = 0;
    this.budget = 50_000;
  }

  find(why) {
    if (why && !this.findings.includes(why)) this.findings.push(why);
  }

  show(path) {
    const home = this.model.home;
    return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
  }

  // --- words

  variable(part) {
    const name = part.name;
    if (/^[0-9]$/u.test(name)) return this.positional[Number(name)] ?? synthetic(CLEAN, "");
    if (name === "@" || name === "*") return this.positional.slice(1).reduce((acc, p) => max(acc, p), synthetic(CLEAN, ""));
    if (this.vars.has(name)) return this.vars.get(name);
    if (name === "HOME") return synthetic(CLEAN, "", this.model.home);
    if (name === "PWD") return synthetic(CLEAN, "", this.cwd);
    if (this.sourced && !WELL_KNOWN_VARS.has(name)) return synthetic(CONTENT, `$${name} after ${this.sourced.label}`, null, this.sourced.origin);
    if (PATH_VARS.has(name) && typeof this.env?.[name] === "string" && this.env[name] !== "") return synthetic(CLEAN, "", this.env[name]);
    return part.fallback === null ? synthetic(CLEAN, "") : this.word(lexWord(part.fallback, 0).tok);
  }

  // A word token's static value (null when unknown), its pattern (unknown
  // parts as NUL), its taint and the taint of a process substitution.
  word(tok) {
    let value = "";
    let known = true;
    let taint = CLEAN_T;
    let proc = null;
    tok.parts.forEach((part, index) => {
      if (part.k === "lit") {
        const tilde = index === 0 && !part.q && (part.v === "~" || part.v.startsWith("~/"));
        value += tilde ? this.model.home + part.v.slice(1) : part.v;
        return;
      }
      if (part.k === "var") {
        const r = this.variable(part);
        taint = max(taint, r);
        if (r.value !== null && r.value !== undefined) {
          value += r.value;
          return;
        }
        if (r.pattern) {
          known = false;
          value += r.pattern;
          return;
        }
      } else if (part.k === "cmd") taint = max(taint, this.source(part.src, CLEAN_T));
      else if (part.k === "proc") proc = this.source(part.src, CLEAN_T);
      known = false;
      value += "\u0000";
    });
    return { value: known ? value : null, pattern: value, level: taint.level, why: taint.why, origin: taint.origin ?? null, proc };
  }

  // Custody facts of an argument used as a path, or null.
  pathOf(w) {
    if (w.proc) return { proc: w.proc };
    let raw = w.value;
    if (raw === null) {
      if (w.level >= PATHS) return { path: null, custody: true, display: "a custody path held in a variable" };
      const pattern = w.pattern.replaceAll("\u0000", "/x/");
      return textNamesCustody(pattern) ? { path: null, custody: true, display: w.pattern.replaceAll("\u0000", "…") } : null;
    }
    if (raw.startsWith("--") && raw.includes("=")) raw = raw.slice(raw.indexOf("=") + 1);
    else if (raw.startsWith("-") && raw !== "-") return null;
    if (raw.startsWith("file://")) raw = decodeURIComponent(raw.slice(7));
    else if (raw === "" || raw === "-" || /^[a-z][a-z0-9+.-]*:\/\//iu.test(raw)) return null;
    if (raw.startsWith("~/")) raw = this.model.home + raw.slice(1);
    const glob = raw.search(/[*?[]/u);
    if (glob >= 0) {
      // The shell expands the glob before the program runs. Its base
      // directory decides cheaply; only a base that holds custody is
      // expanded, to see whether the matches themselves are custody.
      const slash = raw.lastIndexOf("/", glob);
      const base = resolve(this.cwd, slash > 0 ? raw.slice(0, slash) : slash === 0 ? "/" : ".");
      let expanded;
      const expand = () => (expanded === undefined ? (expanded = this.model.expand(base, raw.slice(slash + 1))) : expanded);
      let custody = this.model.isCustodyPath(base) || this.model.directoryReachesCustody(base, { skipsHidden: true, respectsGitignore: true });
      if (custody && expand()?.length) custody = expand().some((m) => this.model.isCustodyPath(m));
      return { path: base, expand, custody, tainted: null, display: this.show(resolve(this.cwd, raw)) };
    }
    const path = resolve(this.cwd, raw);
    const embedded = /[\s:=,{]/u.test(raw) && (textNamesCustody(raw) || this.codeNamesCustodyPath(raw));
    const custody = this.model.isCustodyPath(path) || embedded;
    return { path, custody, tainted: this.tainted.get(this.model.fold(path)) ?? null, display: embedded ? this.show(raw) : undefined };
  }

  describe(p) {
    return p.display ?? this.show(p.path);
  }

  // CONTENT a reader takes in through its arguments (files and values).
  // `recursive` describes a directory search, which without any operand
  // searches the working directory.
  readArgs(name, args, recursive = null) {
    let out = CLEAN_T;
    const search = (dir) => {
      if (!this.model.directoryReachesCustody(dir, recursive)) return CLEAN_T;
      const hint = recursive.respectsGitignore ? "" : " (rg and the Grep tool skip Git-ignored custody)";
      return T(CONTENT, `\`${name}\` searches ${this.show(dir)}, which holds custody${hint}`, this.show(dir));
    };
    for (const w of args) {
      if (w.level === CONTENT) out = max(out, T(CONTENT, `\`${name}\` gets a value from ${w.origin ?? "custody"}`, w.origin));
      const p = this.pathOf(w);
      if (!p) continue;
      if (p.proc) {
        if (p.proc.level === CONTENT) out = max(out, T(CONTENT, `\`${name}\` reads content from ${p.proc.origin ?? "custody"}`, p.proc.origin));
      } else if (p.custody) out = max(out, T(CONTENT, `\`${name}\` reads ${this.describe(p)}`, this.describe(p)));
      else if (p.tainted) out = max(out, T(CONTENT, `\`${name}\` reads ${this.show(p.path)}, written from ${p.tainted.origin ?? "custody"} earlier in this command`, p.tainted.origin));
      else if (recursive) for (const dir of this.dirsOf(p, recursive)) out = max(out, search(dir));
    }
    if (recursive && args.length === 0) out = max(out, search(this.cwd));
    return out;
  }

  // Directories a search through this operand may enter.
  dirsOf(p, recursive) {
    if (!p.path) return [];
    if (!p.expand) return [p.path];
    if (!this.model.directoryReachesCustody(p.path, recursive)) return [];
    return p.expand() ?? [p.path];
  }

  reachesCustody(args, recursive = {}) {
    return args.some((w) => {
      const p = this.pathOf(w);
      return Boolean(p && (p.custody || this.dirsOf(p, recursive).some((dir) => this.model.directoryReachesCustody(dir, recursive))));
    });
  }

  assign(name, w) {
    const p = w.level === CLEAN ? this.pathOf(w) : null;
    const taint = p?.custody ? T(PATHS, "a custody path") : w;
    this.vars.set(name, { value: w.value, pattern: w.pattern, level: taint.level, why: taint.why, origin: taint.origin ?? null, proc: null });
    if (this.xtrace && w.level === CONTENT) this.find(`set -x prints ${name}, which holds a value from ${w.origin ?? "custody"}`);
  }

  // --- structure

  // Runs nested shell code. A child process (`bash -c`, `eval`, ssh) writes
  // its stderr and other descriptors through the calling command; an
  // expansion (`$(…)`, `<(…)`) writes them to the enclosing scope.
  source(src, stdin, { positional = null, xtrace = false, child = false } = {}) {
    if (++this.depth > 8) throw new ShellParseError("nesting too deep");
    const saved = { positional: this.positional, xtrace: this.xtrace, cwd: this.cwd, scope: this.scope, side: this.side };
    const nested = { emitted: new Map() };
    if (positional) this.positional = positional;
    if (xtrace) this.xtrace = true;
    this.scope = nested;
    try {
      return this.list(parseShell(src), stdin);
    } finally {
      Object.assign(this, saved);
      this.depth -= 1;
      for (const [fd, taint] of nested.emitted) (child ? this.addSide(fd, taint) : this.emit(fd, taint));
    }
  }

  emit(fd, taint) {
    if (taint.level === CONTENT) this.scope.emitted.set(fd, max(this.scope.emitted.get(fd) ?? CLEAN_T, taint));
  }

  addSide(fd, taint) {
    if (taint.level === CONTENT) this.side.set(fd, max(this.side.get(fd) ?? CLEAN_T, taint));
  }

  list(list, stdin) {
    let out = CLEAN_T;
    for (const pipeline of list.items) {
      let flow = stdin;
      const last = pipeline.cmds.length - 1;
      pipeline.cmds.forEach((cmd, k) => {
        flow = this.command(cmd, flow, { pipeIn: k > 0, pipeOut: k < last });
      });
      out = max(out, flow);
    }
    return out;
  }

  // A command's stdin. bash reads the last input redirection; zsh reads all
  // of them in turn, after the pipe the command already reads from (MULTIOS).
  // `stdin` covers both; `other` leaves out here-documents and here-strings,
  // which a shell or interpreter reading its code from stdin runs as `heredoc`.
  input(redirs, stdin, pipeIn = false) {
    const io = { stdin, other: stdin, heredoc: null };
    const piped = pipeIn ? stdin : CLEAN_T;
    let all = null;
    let other = piped;
    const code = (text) => {
      io.heredoc = io.heredoc === null ? text : `${io.heredoc}\n${text}`;
    };
    for (const r of redirs) {
      if (r.fd !== null && r.fd !== 0) continue;
      let taint;
      if (r.op === "<" || r.op === "<>") {
        const p = this.pathOf(this.word(r.target));
        if (p?.proc) taint = p.proc;
        else if (p?.custody) taint = T(CONTENT, `input from ${this.describe(p)}`, this.describe(p));
        else if (p?.tainted) taint = T(CONTENT, `input from ${this.show(p.path)}, written from ${p.tainted.origin ?? "custody"} earlier in this command`, p.tainted.origin);
        else taint = CLEAN_T;
        other = max(other, taint);
      } else if (r.op === "<<<") {
        const w = this.word(r.target);
        taint = w.level === CONTENT ? w : this.pathOf(w)?.custody ? T(PATHS) : CLEAN_T;
        if (w.value !== null) code(w.value);
        else other = max(other, taint);
      } else if (r.op === "<<" || r.op === "<<-") {
        code(r.body ?? "");
        taint = textNamesCustody(r.body ?? "") ? T(PATHS) : CLEAN_T;
        if (!r.quoted) {
          const parts = [];
          lexQuoted(r.body ?? "", 0, parts, true);
          taint = max(taint, this.word({ parts }));
        }
      } else continue;
      all = max(all ?? piped, taint);
    }
    if (all !== null) {
      io.stdin = all;
      io.other = other;
    }
    return io;
  }

  // Where a file name sends a descriptor: an inherited descriptor
  // ({ inherit: n }), "tty", "null", a file, or what `fd(n)` holds for
  // /dev/stdout, /dev/stderr and /dev/fd/n.
  destination(target, fd) {
    if (target === null) return { file: null };
    if (target === "/dev/null") return "null";
    if (target === "/dev/tty") return "tty";
    if (target === "/dev/stdout") return fd(1);
    if (target === "/dev/stderr") return fd(2);
    const n = /^\/dev\/fd\/(\d+)$/u.exec(target);
    if (n) return fd(Number(n[1]));
    return { file: resolve(this.cwd, target) };
  }

  // Applies a command's output redirections left to right to its stdout
  // taint and to what it writes elsewhere (`side`), once as bash does (each
  // redirection replaces the descriptor) and once as zsh does (MULTIOS: a
  // descriptor redirected again, or one already feeding a pipe, writes to
  // every target). Every route either shell takes counts. Stdout that stays
  // on inherited fd 1 is returned and flows on; content on another inherited
  // descriptor goes to the enclosing scope; the tty is the transcript at once.
  output(redirs, out, side = null, pipeOut = false) {
    const shells = [
      { multios: false, fds: new Map() },
      { multios: true, fds: new Map(pipeOut ? [[1, [{ inherit: 1 }]]] : []) },
    ];
    for (const r of redirs) {
      if (INPUT_OPS.has(r.op)) continue;
      const target = this.word(r.target).value;
      for (const { multios, fds } of shells) {
        const fd = (n) => fds.get(n) ?? [{ inherit: n }];
        const add = (n, to) => fds.set(n, multios && fds.has(n) ? [...fds.get(n), ...to] : to);
        const destination = () => [this.destination(target, fd)].flat();
        if (r.op === ">&" && target !== null && /^(\d+|-)$/u.test(target)) {
          if (target === "-") fds.set(r.fd ?? 1, ["null"]);
          else add(r.fd ?? 1, fd(Number(target)));
        } else if (r.op === "&>" || r.op === "&>>" || r.op === ">&") {
          const to = destination();
          add(1, to);
          add(2, to);
        } else {
          add(r.fd ?? 1, destination());
        }
      }
    }
    let result = CLEAN_T;
    const route = (taint, to) => {
      if (!taint || taint.level === CLEAN || to === "null") return;
      if (to?.inherit === 1) result = max(result, taint);
      else if (taint.level !== CONTENT) return;
      else if (to === "tty") this.find(`${taint.why}, sent to /dev/tty`);
      else if (to?.file) this.tainted.set(this.model.fold(to.file), taint);
      else if (to?.inherit !== undefined) this.emit(to.inherit, taint);
    };
    const send = (taint, n) => {
      for (const { fds } of shells) for (const to of fds.get(n) ?? [{ inherit: n }]) route(taint, to);
    };
    send(out, 1);
    for (const [n, taint] of side ?? []) {
      if (n === "tty") route(taint, "tty");
      else if (n !== "*") send(taint, n);
      else {
        // A program that can open any descriptor reaches every one opened
        // here, and whatever the enclosing scopes opened.
        for (const { fds } of shells) for (const [k, list] of fds) if (k >= 3) for (const to of list) route(taint, to);
        this.emit("*", taint);
      }
    }
    return result;
  }

  command(cmd, stdin, { pipeIn = false, pipeOut = false } = {}) {
    if (--this.budget < 0) throw new ShellParseError("analysis budget exceeded");
    const io = this.input(cmd.redirs, stdin, pipeIn);
    if (cmd.type === "compound") {
      const cwd = this.cwd;
      if (cmd.loopVar) {
        const ws = cmd.loopWords.map((tok) => this.word(tok));
        const taint = ws.reduce((acc, w) => max(acc, w.level === CLEAN && this.pathOf(w)?.custody ? T(PATHS, "a custody path") : w), CLEAN_T);
        this.vars.set(cmd.loopVar, { value: ws.length === 1 ? ws[0].value : null, pattern: "", level: taint.level, why: taint.why, origin: taint.origin ?? null, proc: null });
      }
      if (cmd.subject) this.word(cmd.subject);
      const scope = this.scope;
      const inner = { emitted: new Map() };
      this.scope = inner;
      let out = CLEAN_T;
      try {
        for (const list of cmd.body) out = max(out, this.list(list, io.stdin));
      } finally {
        this.scope = scope;
      }
      if (cmd.subshell) this.cwd = cwd;
      return this.output(cmd.redirs, out, inner.emitted, pipeOut);
    }
    for (const a of cmd.assigns) this.assign(a.name, this.word(a.value));
    const args = cmd.words.map((tok) => this.word(tok));
    const side = this.side;
    this.side = new Map();
    try {
      // For redirections without a command or assignment, zsh runs `cat`
      // (`more` for a lone `<`, NULLCMD and READNULLCMD) on them; `$(< file)`
      // expands to the file in both shells.
      const nullcmd = cmd.assigns.length === 0 && cmd.redirs.length > 0;
      const out = args.length ? this.program(args, io) : nullcmd ? io.stdin : CLEAN_T;
      return this.output(cmd.redirs, out, this.side, pipeOut);
    } finally {
      this.side = side;
    }
  }

  program(args, io) {
    let i = 0;
    let exec = false;
    for (let guard = 0; guard < 16 && i < args.length; guard += 1) {
      const wrapperName = progName(args[i]);
      const wrapper = own(WRAPPERS, wrapperName);
      const next = wrapper ? wrapper(args, i + 1, this) : null;
      if (next === null) break;
      exec ||= wrapperName === "exec";
      i = next;
    }
    const name = progName(args[i]);
    if (!name) {
      if (exec) this.execRedirects = true;
      return CLEAN_T;
    }
    const rest = args.slice(i + 1);
    const handler = own(HANDLERS, name);
    if (handler) return handler.call(this, name, rest, io);
    if (/^python[0-9.]*$|^pypy3?$/u.test(name)) return this.python(name, rest, io);
    if (READERS.has(name)) return this.reader(name, rest, io);
    if (LISTERS.has(name)) return this.reachesCustody(rest) ? T(PATHS) : CLEAN_T;
    return CLEAN_T;
  }

  reader(name, rest, io) {
    const values = rest.map(valueOf);
    const flags = values.filter((v) => v.startsWith("-") && !v.startsWith("--")).map(flagChars).join("");
    const longs = new Set(values.filter((v) => v.startsWith("--")).map((v) => v.split("=")[0]));
    // Programs and patterns (`jq FILTER`, `grep -e PATTERN`, `sed -f FILE`)
    // are read for custody too, but only file operands are searched.
    const programFlag = own(PROGRAM_FLAGS, name) ?? (() => false);
    const programs = [];
    const programFiles = [];
    const operands = [];
    for (let k = 0; k < rest.length; k += 1) {
      if (programFlag(values[k])) {
        if (rest[k + 1]) (/f$|^--(from-)?file$/u.test(values[k]) ? programFiles : programs).push(rest[k + 1]);
        k += 1;
      } else if ((GREP_LIKE.has(name) && GREP_VALUE_FLAGS.has(values[k])) || own(READER_VALUE_FLAGS, name)?.has(values[k])) k += 1;
      else if (!isOption(rest[k]) && !STDIN_ONLY.has(name) && !/^[+-]?\d+$/u.test(values[k])) operands.push(rest[k]);
    }
    if (PROGRAM_FIRST.has(name) && programs.length + programFiles.length === 0 && operands.length > 0) programs.push(operands.shift());
    const inlineValue = programs.find((w) => w.level === CONTENT);
    const fromProgram = inlineValue ? T(CONTENT, `\`${name}\` gets a value from ${inlineValue.origin ?? "custody"}`, inlineValue.origin) : CLEAN_T;
    let recursive = null;
    if (GREP_LIKE.has(name)) {
      const unrestricted = (flags.match(/u/gu) ?? []).length;
      if (["rg", "ag"].includes(name)) {
        recursive = {
          skipsHidden: !(longs.has("--hidden") || flags.includes(".") || unrestricted >= 2 || longs.has("--unrestricted")),
          respectsGitignore: !(longs.has("--no-ignore") || longs.has("--no-ignore-vcs") || longs.has("--skip-vcs-ignores") || unrestricted >= 1),
        };
      } else if (name === "ack" || /[rR]/u.test(flags) || longs.has("--recursive") || longs.has("--dereference-recursive")) {
        recursive = { skipsHidden: false, respectsGitignore: false };
      }
    }
    if (["sed", "gsed"].includes(name) && values.some((v) => /^-[A-Za-z]*i/u.test(v) || v.startsWith("--in-place"))) return CLEAN_T;
    let out = [fromProgram, this.readArgs(name, programFiles), this.readArgs(name, operands, recursive), io.stdin].reduce(max);
    if (out === io.stdin && out.level === CONTENT && out.why.startsWith("input from ")) {
      out = T(CONTENT, `\`${name}\` reads ${out.why.slice("input from ".length)}`, out.origin);
    }
    if (GREP_LIKE.has(name)) {
      if (/q/u.test(flags) || longs.has("--quiet") || longs.has("--silent")) return CLEAN_T;
      const namesOnly = /[lc]/u.test(flags) || (name !== "rg" && /L/u.test(flags)) || ["--files-with-matches", "--files-without-match", "--count", "--count-matches", "--files"].some((f) => longs.has(f));
      if (namesOnly) return out.level === CLEAN ? CLEAN_T : T(PATHS);
    }
    if (DIFFS.has(name) && (/q/u.test(flags) || longs.has("--brief"))) return CLEAN_T;
    // A program (awk, sed, jq) can write what it reads to stderr, another
    // descriptor or the tty itself; a program file is not inspected.
    if (out.level === CONTENT && PROGRAM_FIRST.has(name)) {
      const text = programs.map((w) => w.value ?? w.pattern ?? "").join("\n");
      const opaque = programFiles.length > 0;
      if (opaque || (JQ_LIKE.has(name) ? JQ_STDERR : STDERR_CAPABLE).test(text)) this.addSide(2, out);
      if (opaque || ANY_FD.test(text)) this.addSide("*", out);
      if (/\/dev\/tty/u.test(text)) this.addSide("tty", out);
    }
    return out;
  }

  // An interpreter running code given inline (-c, -e, a here-document or
  // stdin). A script run by path is a tool.
  inline(name, rest, io, codeFlags, valueFlags = new Set()) {
    let code = null;
    let after = [];
    for (let k = 0; k < rest.length; k += 1) {
      const v = valueOf(rest[k]);
      const cluster = flagChars(v);
      const flag = codeFlags.find((f) => v === f || v.startsWith(`${f}=`) || (f.length === 2 && cluster.length > 1 && cluster.endsWith(f[1])));
      if (flag) {
        code = v.startsWith(`${flag}=`) ? { ...rest[k], value: v.slice(flag.length + 1) } : (rest[k + 1] ?? null);
        after = rest.slice(k + 2);
        break;
      }
      if (v === "-") {
        after = rest.slice(k + 1);
        break;
      }
      if (valueFlags.has(v)) k += 1;
      else if (!v.startsWith("-")) return CLEAN_T;
    }
    // What the code can read on stdin: all of it, or, when the code is the
    // here-document itself, whatever else stdin carries.
    let stdin = io.stdin;
    if (code === null) {
      if (io.heredoc === null) return io.stdin.level === CONTENT ? T(CONTENT, `\`${name}\` runs content from ${io.stdin.origin ?? "custody"} as code`, io.stdin.origin) : CLEAN_T;
      code = synthetic(CLEAN, "", io.heredoc);
      stdin = io.other;
    }
    const text = code.value ?? code.pattern ?? "";
    const result = this.inlineTaint(name, text, code, after, stdin);
    // Inline code can write to stderr or any open descriptor as easily as to
    // stdout, and to the tty when it names it.
    if (result.level === CONTENT) {
      this.addSide(2, result);
      this.addSide("*", result);
      if (/\/dev\/tty/u.test(text)) this.addSide("tty", result);
    }
    return result;
  }

  inlineTaint(name, text, code, after, stdin) {
    if (textNamesCustody(text) || this.codeNamesCustodyPath(text)) return T(CONTENT, `inline \`${name}\` code opens custody`);
    if (code.level === CONTENT) return T(CONTENT, `inline \`${name}\` code embeds a value from ${code.origin ?? "custody"}`, code.origin);
    if (this.model.isCustodyPath(this.cwd)) return T(CONTENT, `inline \`${name}\` code runs inside custody ${this.show(this.cwd)}`);
    if (this.sourced && ENV_ACCESS.test(text)) return T(CONTENT, `inline \`${name}\` code reads the environment after ${this.sourced.label}`, this.sourced.origin);
    const fromArgs = this.readArgs(name, after);
    if (fromArgs.level === CONTENT) return T(CONTENT, `inline \`${name}\` code ${fromArgs.why.replace(/^`[^`]+` /u, "")}`, fromArgs.origin);
    if (stdin.level === CONTENT) return T(CONTENT, `inline \`${name}\` code reads ${stdin.origin ?? "custody"}`, stdin.origin);
    return CLEAN_T;
  }

  // A shell reading its script on stdin: here-document code is read as shell;
  // any other content on stdin is run as code, which can echo it in errors.
  script(label, io, xtrace = false) {
    const ran = io.heredoc === null ? CLEAN_T : this.source(io.heredoc, CLEAN_T, { xtrace, child: true });
    const data = io.heredoc === null ? io.stdin : io.other;
    return data.level === CONTENT ? max(ran, T(CONTENT, `${label} runs content from ${data.origin ?? "custody"}`, data.origin)) : ran;
  }

  codeNamesCustodyPath(text) {
    for (const m of text.matchAll(/(?:~|\$HOME|\$\{HOME\})?[\w.@%+=:,-]*\/[\w.@%+=:,/-]+/gu)) {
      const raw = m[0].replace(/^(\$HOME|\$\{HOME\})/u, "~");
      if (this.model.isCustodyPath(raw.startsWith("~/") ? this.model.home + raw.slice(1) : resolve(this.cwd, raw))) return true;
    }
    return false;
  }

  python(name, rest, io) {
    for (let k = 0; k < rest.length; k += 1) {
      const v = valueOf(rest[k]);
      if (v === "-m") {
        const mod = valueOf(rest[k + 1]);
        return PYTHON_READER_MODULES.has(mod) ? max(this.readArgs(`${name} -m ${mod}`, rest.slice(k + 2)), io.stdin) : CLEAN_T;
      }
      if (v === "-X" || v === "-W") k += 1;
      else if (!v.startsWith("-") || v === "-" || flagChars(v).includes("c")) break;
    }
    return this.inline(name, rest, io, ["-c"], new Set(["-X", "-W"]));
  }

  shell(name, rest, io) {
    let xtrace = false;
    for (let k = 0; k < rest.length; k += 1) {
      const v = valueOf(rest[k]);
      const cluster = flagChars(v);
      if (/[xv]/u.test(cluster)) xtrace = true;
      if (cluster.includes("c")) {
        const code = rest[k + 1];
        if (!code) return CLEAN_T;
        if (code.value === null) return code.level === CONTENT ? T(CONTENT, `\`${name} -c\` runs a value from ${code.origin ?? "custody"}`, code.origin) : CLEAN_T;
        return this.source(code.value, io.stdin, { positional: rest.slice(k + 2), xtrace, child: true });
      }
      if (v === "-o" || v === "+o" || cluster.endsWith("o")) {
        if (!v.startsWith("+") && /^(xtrace|verbose)$/u.test(valueOf(rest[k + 1]))) xtrace = true;
        k += 1;
      } else if (v === "-" || v === "-s") break;
      else if (!v.startsWith("-") && !v.startsWith("+")) {
        const handlesCustody = this.reachesCustody(rest.slice(k)) || io.stdin.level === CONTENT || Boolean(this.sourced);
        return xtrace && handlesCustody ? T(CONTENT, `\`${name} -x\` traces a script that handles custody`) : CLEAN_T;
      }
    }
    return this.script(`\`${name}\``, io, xtrace);
  }
}

function skipOptions(args, i, withValue = new Set()) {
  while (i < args.length) {
    const v = valueOf(args[i]);
    if (v === "--") return i + 1;
    if (!v.startsWith("-") || v === "-") return i;
    i += withValue.has(v) ? 2 : 1;
  }
  return i;
}

// Programs that run their operands as a command: each returns the index of
// that command, or null when this form is not a wrapper.
const TIMEOUT_FLAGS = new Set(["-s", "-k", "--signal", "--kill-after"]);
const WRAPPERS = {
  sudo: (a, i) => skipOptions(a, i, new Set(["-u", "-g", "-C", "-p", "-h", "-D", "-r", "-t", "-T", "-U"])),
  doas: (a, i) => skipOptions(a, i, new Set(["-u", "-C"])),
  command: (a, i) => skipOptions(a, i),
  builtin: (a, i) => i,
  exec: (a, i) => skipOptions(a, i, new Set(["-a"])),
  nohup: (a, i) => i,
  time: (a, i) => skipOptions(a, i),
  nice: (a, i) => skipOptions(a, i, new Set(["-n"])),
  caffeinate: (a, i) => skipOptions(a, i, new Set(["-t", "-w"])),
  stdbuf: (a, i) => skipOptions(a, i, new Set(["-i", "-o", "-e"])),
  unbuffer: (a, i) => i,
  chronic: (a, i) => i,
  timeout: (a, i) => skipOptions(a, i, TIMEOUT_FLAGS) + 1,
  gtimeout: (a, i) => skipOptions(a, i, TIMEOUT_FLAGS) + 1,
  watch: (a, i) => skipOptions(a, i, new Set(["-n", "--interval"])),
  npx: (a, i) => skipOptions(a, i, new Set(["-p", "--package"])),
  bunx: (a, i) => skipOptions(a, i, new Set(["-p", "--package"])),
  uvx: (a, i) => skipOptions(a, i, new Set(["--with", "--from", "--python"])),
  uv: (a, i) => (valueOf(a[i]) === "run" ? skipOptions(a, i + 1, new Set(["--with", "--python", "--project", "--directory"])) : null),
  env: (a, i, st) => {
    let k = skipOptions(a, i, new Set(["-u", "-C", "-P", "-S", "--unset", "--chdir"]));
    while (k < a.length && /^[A-Za-z_][A-Za-z0-9_]*=/u.test(valueOf(a[k]))) {
      st.assign(valueOf(a[k]).split("=")[0], a[k]);
      k += 1;
    }
    return k < a.length ? k : null;
  },
};

function envPrinter(st) {
  if (st.sourced) return T(CONTENT, `printing the environment after ${st.sourced.label}`, st.sourced.origin);
  for (const [name, v] of st.vars) if (v.level === CONTENT) return T(CONTENT, `printing the environment, whose ${name} holds a value from ${v.origin ?? "custody"}`, v.origin);
  return CLEAN_T;
}

function declare(name, rest) {
  const assigns = rest.filter((w) => !isOption(w));
  for (const w of assigns) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=/u.exec(w.value ?? w.pattern);
    if (m) this.assign(m[1], { ...w, value: w.value === null ? null : w.value.slice(m[0].length) });
  }
  return assigns.length === 0 && name !== "local" ? envPrinter(this) : CLEAN_T;
}

function copyLike(name, rest) {
  const operands = rest.filter((w) => !isOption(w));
  const dest = operands.at(-1);
  if (operands.length < 2 || dest.value === null || /^[^/]+:/u.test(dest.value)) return CLEAN_T;
  const target = resolve(this.cwd, dest.value);
  let out = CLEAN_T;
  for (const w of operands.slice(0, -1)) {
    const p = this.pathOf(w);
    if (!p?.path || !(p.custody || p.tainted)) continue;
    const why = T(CONTENT, `${this.show(p.path)} copied by \`${name}\``, p.tainted?.origin ?? this.describe(p));
    const device = this.destination(dest.value, (n) => ({ inherit: n }));
    if (device?.inherit === 1) {
      out = why;
      continue;
    }
    if (device === "tty" || device?.inherit !== undefined) {
      this.addSide(device === "tty" ? "tty" : device.inherit, why);
      continue;
    }
    this.tainted.set(this.model.fold(target), why);
    this.tainted.set(this.model.fold(join(target, basename(p.path))), why);
  }
  return out;
}

function readsWhen(test) {
  return function conditionalReader(name, rest, io) {
    return test(rest.map(valueOf)) ? this.reader(name, rest, io) : CLEAN_T;
  };
}

function inlineWith(codeFlags) {
  return function inlineInterpreter(name, rest, io) {
    return this.inline(name, rest, io, codeFlags);
  };
}

const HANDLERS = {
  cd(name, rest) {
    const w = rest.find((x) => !isOption(x));
    if (!w) this.cwd = this.model.home;
    else if (w.value !== null && w.value !== "-") this.cwd = resolve(this.cwd, w.value);
    return CLEAN_T;
  },
  source(name, rest) {
    const p = rest[0] ? this.pathOf(rest[0]) : null;
    if (p?.custody || p?.tainted) {
      this.sourced = { label: `\`${name}\` of ${this.describe(p)}`, origin: this.describe(p) };
      if (this.xtrace) this.find(`set -x prints the values of ${this.sourced.label}`);
    }
    return CLEAN_T;
  },
  set(name, rest) {
    if (rest.length === 0) return envPrinter(this);
    for (let k = 0; k < rest.length; k += 1) {
      const v = valueOf(rest[k]);
      if (v === "-o" || v === "+o") {
        if (/^(xtrace|verbose)$/u.test(valueOf(rest[k + 1]))) this.xtrace = v === "-o";
        k += 1;
      } else if (/^-[A-Za-z]*[xv]/u.test(v)) this.xtrace = true;
      else if (/^\+[A-Za-z]*[xv]/u.test(v)) this.xtrace = false;
    }
    if (this.xtrace && this.sourced) this.find(`set -x prints the values of ${this.sourced.label}`);
    return CLEAN_T;
  },
  export: declare,
  declare,
  typeset: declare,
  readonly: declare,
  local: declare,
  printenv(name, rest) {
    const names = rest.filter((w) => !isOption(w));
    if (names.length === 0) return envPrinter(this);
    const found = names.map((w) => this.variable({ name: valueOf(w), fallback: null })).find((v) => v.level === CONTENT);
    return found ? T(CONTENT, `\`printenv\` prints a value from ${found.origin ?? "custody"}`, found.origin) : CLEAN_T;
  },
  env(name, rest) {
    return envPrinter(this);
  },
  read(name, rest, io) {
    for (let k = 0; k < rest.length; k += 1) {
      const v = valueOf(rest[k]);
      if (["-a", "-d", "-n", "-N", "-p", "-t", "-u", "-i"].includes(v)) {
        if (v === "-a" && rest[k + 1]?.value) this.vars.set(rest[k + 1].value, synthetic(io.stdin.level, io.stdin.why, null, io.stdin.origin));
        k += 1;
      } else if (!v.startsWith("-")) this.vars.set(v, synthetic(io.stdin.level, io.stdin.why, null, io.stdin.origin));
    }
    return CLEAN_T;
  },
  mapfile(name, rest, io) {
    const target = rest.filter((w) => !isOption(w)).at(-1)?.value ?? "MAPFILE";
    this.vars.set(target, synthetic(io.stdin.level, io.stdin.why, null, io.stdin.origin));
    return CLEAN_T;
  },
  echo(name, rest) {
    let out = CLEAN_T;
    for (const w of rest) {
      if (w.level === CONTENT) out = max(out, T(CONTENT, `\`${name}\` prints a value from ${w.origin ?? "custody"}`, w.origin));
      else if (w.level === PATHS || this.pathOf(w)?.custody) out = max(out, T(PATHS));
    }
    return out;
  },
  tee(name, rest, io) {
    for (const w of rest) {
      const v = valueOf(w);
      if (!v || isOption(w)) continue;
      const to = this.destination(v, (n) => ({ inherit: n }));
      if (to === "tty" || (to?.inherit !== undefined && to.inherit !== 1)) this.addSide(to === "tty" ? "tty" : to.inherit, io.stdin);
      else if (to?.file && io.stdin.level === CONTENT) this.tainted.set(this.model.fold(to.file), io.stdin);
    }
    return io.stdin;
  },
  cp: copyLike,
  mv: copyLike,
  ln: copyLike,
  install: copyLike,
  rsync: copyLike,
  ditto: copyLike,
  xargs(name, rest, io) {
    const withValue = new Set(["-I", "-J", "-L", "-n", "-P", "-d", "-E", "-s", "-a", "--arg-file", "--delimiter", "--max-args", "--max-procs", "--replace"]);
    let k = 0;
    while (k < rest.length && isOption(rest[k])) k += withValue.has(rest[k].value) ? 2 : 1;
    const command = rest.slice(k);
    if (command.length === 0) command.push(synthetic(CLEAN, "", "echo"));
    if (io.stdin.level === CLEAN) return this.program(command, noInput());
    const fed = io.stdin.level === CONTENT ? synthetic(CONTENT, io.stdin.why, null, io.stdin.origin) : synthetic(PATHS, "custody paths from the pipe");
    return this.program([...command, fed], noInput());
  },
  find(name, rest) {
    let k = 0;
    const starts = [];
    while (k < rest.length && !/^[-(!,]/u.test(valueOf(rest[k]))) starts.push(rest[k++]);
    const reaches = this.reachesCustody(starts.length ? starts : [synthetic(CLEAN, "", ".")]);
    let out = reaches ? T(PATHS) : CLEAN_T;
    for (; k < rest.length; k += 1) {
      if (!["-exec", "-execdir", "-ok", "-okdir"].includes(rest[k].value)) continue;
      const command = [];
      for (k += 1; k < rest.length && rest[k].value !== ";" && rest[k].value !== "+"; k += 1) {
        command.push(rest[k].value === "{}" && reaches ? synthetic(PATHS, "custody files found by `find`") : rest[k]);
      }
      if (command.length) out = max(out, this.program(command, noInput()));
    }
    return out;
  },
  eval(name, rest, io) {
    if (rest.some((w) => w.value === null)) return rest.some((w) => w.level === CONTENT) ? T(CONTENT, "`eval` runs a custody value") : CLEAN_T;
    return this.source(rest.map((w) => w.value).join(" "), io.stdin, { child: true });
  },
  dd(name, rest, io) {
    const operand = (key) => {
      const w = rest.find((x) => (x.value ?? x.pattern ?? "").startsWith(`${key}=`));
      return w ? { ...w, value: w.value === null ? null : w.value.slice(key.length + 1), pattern: (w.pattern ?? "").slice(key.length + 1) } : null;
    };
    const input = operand("if");
    let content = io.stdin;
    if (input) {
      const p = this.pathOf(input);
      content = p?.custody ? T(CONTENT, `\`dd\` reads ${this.describe(p)}`, this.describe(p)) : (p?.tainted ?? CLEAN_T);
    }
    const output = operand("of");
    if (!output) return content;
    const to = this.destination(output.value, (n) => ({ inherit: n }));
    if (to?.inherit === 1) return content;
    if (to === "tty" || to?.inherit !== undefined) this.addSide(to === "tty" ? "tty" : to.inherit, content);
    else if (to?.file && content.level === CONTENT) this.tainted.set(this.model.fold(to.file), content);
    return CLEAN_T;
  },
  cmp: readsWhen((v) => v.some((x) => x === "--verbose" || x === "--print-bytes" || /^-[A-Za-z]*[lb]/u.test(x))),
  openssl(name, rest, io) {
    const sub = valueOf(rest[0]);
    if (["dgst", "sha1", "sha256", "sha512", "md5", "rand", "version", "help", "list"].includes(sub) || rest.some((w) => w.value === "-out")) return CLEAN_T;
    return this.reader(name, rest.slice(1), io);
  },
  plutil(name, rest, io) {
    const v = rest.map(valueOf);
    const prints = v.includes("-p") || v.some((x, k) => x === "-o" && v[k + 1] === "-");
    return prints ? this.reader(name, rest.filter((w) => !["-o", "-"].includes(w.value)), io) : CLEAN_T;
  },
  unzip: readsWhen((v) => v.some((x) => /^-[A-Za-z]*[pc]/u.test(x))),
  // Archives and compressed streams written to stdout carry the content.
  tar: readsWhen((v) => {
    const cluster = (x, k) => (x.startsWith("-") && !x.startsWith("--") ? x.slice(1) : k === 0 ? x : "");
    const extractsToStdout = v.includes("--to-stdout") || v.some((x, k) => cluster(x, k).includes("O"));
    const creates = v.includes("--create") || v.some((x, k) => /c/u.test(cluster(x, k)));
    const archive = v.findIndex((x, k) => x === "--file" || x.startsWith("--file=") || /f$/u.test(cluster(x, k)));
    const toStdout = archive < 0 || v[archive] === "--file=-" || v[archive + 1] === "-";
    return extractsToStdout || (creates && toStdout);
  }),
  zip: readsWhen((v) => v.filter((x) => !x.startsWith("-") || x === "-")[0] === "-"),
  gzip(name, rest, io) {
    const v = rest.map(valueOf);
    const toStdout = v.some((x) => x === "--stdout" || x === "--to-stdout" || /^-[A-Za-z0-9]*c/u.test(x));
    const fromStdin = !rest.some((w) => !isOption(w));
    return toStdout || fromStdin ? this.reader(name, rest, io) : CLEAN_T;
  },
  gpg: readsWhen((v) => !v.some((x) => x === "-o" || x.startsWith("--output")) && (v.some((x) => x === "--decrypt" || /^-[A-Za-z]*d/u.test(x)) || !v.some((x) => x.startsWith("-")))),
  git(name, rest, io) {
    let k = 0;
    while (k < rest.length && isOption(rest[k])) k += ["-C", "-c", "--git-dir", "--work-tree"].includes(rest[k].value) ? 2 : 1;
    const sub = valueOf(rest[k]);
    const v = rest.map(valueOf);
    const reads = ["diff", "show", "cat-file", "blame", "log"].includes(sub) || (sub === "grep" && (v.includes("--no-index") || v.includes("--untracked")));
    return reads ? this.reader(`git ${sub}`, rest.slice(k + 1), io) : CLEAN_T;
  },
  perl(name, rest, io) {
    return rest.some((w) => /^-[A-Za-z0-9]*i/u.test(valueOf(w))) ? CLEAN_T : this.inline(name, rest, io, ["-e", "-E"]);
  },
  ruby(name, rest, io) {
    return rest.some((w) => /^-[A-Za-z0-9]*i/u.test(valueOf(w))) ? CLEAN_T : this.inline(name, rest, io, ["-e"]);
  },
  node: inlineWith(["-e", "--eval", "-p", "--print"]),
  bun(name, rest, io) {
    const sub = valueOf(rest[0]);
    if (sub === "exec") return rest[1]?.value ? this.source(rest[1].value, io.stdin, { child: true }) : CLEAN_T;
    if (sub === "x") return this.program(rest.slice(1), io);
    if (sub === "run") return valueOf(rest[1]) === "-" ? this.inline(name, rest.slice(1), io, []) : CLEAN_T;
    return this.inline(name, rest, io, ["-e", "--eval", "-p", "--print"]);
  },
  ssh(name, rest, io) {
    const withValue = new Set(["-b", "-c", "-D", "-E", "-e", "-F", "-I", "-i", "-J", "-L", "-l", "-m", "-O", "-o", "-p", "-Q", "-R", "-S", "-W", "-w", "-B"]);
    let k = 0;
    while (k < rest.length && isOption(rest[k])) k += withValue.has(rest[k].value) ? 2 : 1;
    const remote = rest.slice(k + 1);
    if (remote.length === 0) return this.script("the remote shell", io);
    if (remote.some((w) => w.value === null)) return remote.some((w) => w.level === CONTENT) ? T(CONTENT, "a remote command embeds a custody value") : CLEAN_T;
    const out = this.source(remote.map((w) => w.value).join(" "), io.stdin, { child: true });
    return out.level === CONTENT ? T(CONTENT, `on the remote host, ${out.why}`, out.origin) : out;
  },
  docker(name, rest, io) {
    if (valueOf(rest[0]) !== "exec") return CLEAN_T;
    const withValue = new Set(["-e", "--env", "-u", "--user", "-w", "--workdir", "--env-file"]);
    let k = 1;
    while (k < rest.length && isOption(rest[k])) k += withValue.has(rest[k].value) ? 2 : 1;
    return this.program(rest.slice(k + 1), io);
  },
};
const alias = (names, target) => {
  for (const name of names.split(" ")) HANDLERS[name] = target;
};
alias(".", HANDLERS.source);
alias("pushd", HANDLERS.cd);
alias("readarray", HANDLERS.mapfile);
alias("printf print", HANDLERS.echo);
alias("gunzip bzip2 bunzip2 xz unxz zstd unzstd lz4 brotli compress", HANDLERS.gzip);
alias("age", HANDLERS.gpg);
alias("nodejs", HANDLERS.node);
alias("sh bash zsh dash ksh mksh fish", function shellHandler(name, rest, io) {
  return this.shell(name, rest, io);
});

// ------------------------------------------------------------------- api ---

const READER_WORD = new RegExp(
  `(^|[\\s;&|({\`$])(${[...READERS, "python[0-9.]*", "node", "bun", "perl", "ruby", "plutil", "source"].join("|")})(?=[\\s;&|)}\`]|$)`,
  "u",
);

// Last resort when the command cannot be parsed: a custody name next to a
// reader is treated as a match.
function coarse(command, model, cwd) {
  const named = textNamesCustody(command) || model.isCustodyPath(cwd);
  return named && READER_WORD.test(command) ? ["the command names custody next to a reader and could not be parsed exactly"] : [];
}

// The reasons a command would print custody content; empty when it would
// not. Throws only on internal errors, on which callers fail open.
export function custodyLeaks(command, { model, cwd, env = process.env }) {
  const analysis = new Analysis({ model, cwd: isAbsolute(cwd ?? "") ? cwd : model.home, env });
  try {
    const out = analysis.list(parseShell(command), CLEAN_T);
    // At the top, inherited stderr is the transcript; other descriptors are
    // not open unless `exec` opened them.
    for (const [fd, taint] of analysis.scope.emitted) {
      if (fd === 2) analysis.find(`${taint.why}, sent to stderr`);
      else if (analysis.execRedirects) analysis.find(`${taint.why}, sent to a descriptor that \`exec\` opened`);
    }
    if (out.level === CONTENT) analysis.findings.unshift(`${out.why}, and the output reaches the transcript`);
    return analysis.findings;
  } catch (error) {
    if (error instanceof ShellParseError) return coarse(command, model, analysis.cwd);
    throw error;
  }
}
