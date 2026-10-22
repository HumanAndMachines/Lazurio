import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createCustodyModel } from "./custody-model.mjs";
import { custodyReason, denyMessage, hookResponse } from "./custody-guard.mjs";

// A synthetic machine: a home with machine-wide custody and a Lazurio root
// with Organization and Personalspace custody. No real custody is touched.
const sandbox = mkdtempSync(join(tmpdir(), "custody-guard-"));
const home = join(sandbox, "home");
const lazurio = join(home, "Lazurio");
const write = (path, content) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
};
const lane = join(home, ".config/lazurio/credentials/lane");
write(join(lane, "issuer-secrets.json"), JSON.stringify({ keycloak_env: "KC_DB_PASSWORD=synthetic-one\nKC_BOOTSTRAP_ADMIN_PASSWORD=synthetic-two\n" }));
write(join(lane, "credential-map.json"), JSON.stringify({ credentials: { "credentials/issuer": { path: join(lane, "issuer-secrets.json") } } }));
write(join(lane, "issuer.env"), "KC_DB_PASSWORD=synthetic-one\n");
write(join(lane, "id_ed25519.pub"), "ssh-ed25519 AAAA synthetic\n");
write(join(lane, "known_hosts"), "host ssh-ed25519 AAAA\n");
symlinkSync(join(lane, "issuer.env"), join(lane, "export.pub"));
write(join(home, ".config/lazurio/custody/run/apply.log"), "synthetic log\n");
const org = join(lazurio, "organizations/ExampleOrg_GEN3");
write(join(org, "company/colleagues/agent/private/secrets/google/client.json"), "{}");
write(join(org, "infra/private/secrets/broker.env"), "TOKEN=synthetic\n");
write(join(org, "infra/machines/record.json"), "{}");
write(join(lazurio, "personalspace/owner_GEN3/secrets/token.json"), "{}");
write(join(lazurio, "README.md"), "# synthetic\n");
afterAll(() => rmSync(sandbox, { recursive: true, force: true }));

const model = createCustodyModel({ home, lazurioRoot: lazurio, caseInsensitive: false });
const bash = (command, cwd = lazurio) => custodyReason({ tool_name: "Bash", tool_input: { command }, cwd }, { model, env: {} });

const MAP = "~/.config/lazurio/credentials/lane/credential-map.json";
const SECRETS = "~/.config/lazurio/credentials/lane/issuer-secrets.json";
const ENV = "~/.config/lazurio/credentials/lane/issuer.env";
const KIT = "organizations/ExampleOrg_GEN3/.agents/skills/org-pipeline-bootstrap/scripts";

describe("denies a command that prints custody values", () => {
  const cases = [
    // The incident of 2026-10-22: a structure query whose filter falls through to the value.
    ["incident: jq filter falls through to an env block", `jq -r '.keycloak_env | if type == "object" then keys else . end' ${SECRETS}`],
    ["cat", `cat ${SECRETS}`],
    ["head bytes", `head -c 64 ${SECRETS}`],
    ["tail", `tail -n 5 ${ENV}`],
    ["less", `less ${ENV}`],
    ["bat", `bat ${SECRETS}`],
    ["grep", `grep KC_ ${ENV}`],
    ["grep -o through cut", `grep -o 'KC_[A-Z_]*=.*' ${ENV} | cut -d= -f1`],
    ["rg over a custody dir", "rg password ~/.config/lazurio/credentials"],
    ["sed", `sed -n 1p ${ENV}`],
    ["awk keys", `awk -F= '{print $1}' ${ENV}`],
    ["cut", `cut -d= -f2 ${ENV}`],
    ["od", `od -c ${ENV}`],
    ["xxd", `xxd ${ENV}`],
    ["hexdump", `hexdump -C ${ENV}`],
    ["strings", `strings ${ENV}`],
    ["base64", `base64 ${ENV}`],
    ["diff without -q", `diff ${SECRETS} ${MAP}`],
    ["diff of process substitutions", `diff <(jq -S . ${SECRETS}) <(jq -S . ${MAP})`],
    ["plutil -p", `plutil -p ${SECRETS}`],
    ["yq", `yq . ${SECRETS}`],
    ["python -c", `python3 -c "import json; print(json.load(open('${SECRETS}')))"`],
    ["python -c via os.path.join", `python3 -c "import os; print(open(os.path.join(os.path.expanduser('~'), '.config', 'lazurio', 'credentials', 'lane', 'issuer.env')).read())"`],
    ["python heredoc", `python3 - <<'PY'\nimport json\nprint(json.load(open("${SECRETS}")).keys())\nPY`],
    ["python -m json.tool", `python3 -m json.tool ${SECRETS}`],
    ["python fed by a pipe", `cat ${SECRETS} | python3 -c 'import sys; print(sys.stdin.read())'`],
    ["node -e with a path argument", `node -e 'console.log(require("fs").readFileSync(process.argv[1], "utf8"))' ${SECRETS}`],
    ["bun -e", `bun -e 'console.log(await Bun.file("${SECRETS}").text())'`],
    ["perl -ne", `perl -ne 'print' ${ENV}`],
    ["ruby -e", `ruby -e 'puts File.read(ARGV[0])' ${ENV}`],
    ["variable", `F=${SECRETS}; jq . "$F"`],
    ["for loop over a glob", "for f in ~/.config/lazurio/credentials/lane/*.json; do head -c 80 \"$f\"; done"],
    ["while read from custody", `while read -r line; do echo "$line"; done < ${ENV}`],
    ["find | xargs cat", "find ~/.config/lazurio/credentials -name '*.json' | xargs cat"],
    ["find -exec cat", "find ~/.config/lazurio/credentials -name '*.env' -exec cat {} \\;"],
    ["cd into custody", "cd ~/.config/lazurio/credentials/lane && cat issuer-secrets.json"],
    ["copy then read in one command", `cp ${SECRETS} /tmp/s.json && cat /tmp/s.json`],
    ["redirect then read in one command", `jq . ${SECRETS} > /tmp/s.json; head /tmp/s.json`],
    ["captured value echoed", `X=$(jq -r .keycloak_env ${SECRETS}); echo "$X"`],
    ["command substitution echoed", `echo "$(cat ${ENV})"`],
    ["sourced env printed", `set -a; . ${ENV}; set +a; env`],
    ["sourced variable echoed", `source ${ENV} && echo "$KC_DB_PASSWORD"`],
    ["xtrace of a sourced file", `set -x; . ${ENV}`],
    ["bash -c with a positional path", `bash -c 'cat "$1"' _ ${SECRETS}`],
    ["sh -c", `sh -c "jq . ${SECRETS}"`],
    ["remote shell echoes stdin", `ssh host cat < ${ENV}`],
    ["sent to stderr", `cat ${ENV} >&2`],
    ["tee to stderr", `jq . ${SECRETS} | tee /dev/stderr > /dev/null`],
    ["zsh bare input redirection", `< ${ENV}`],
    ["cat from input redirection", `cat < ${ENV}`],
    ["recursive grep over a custody parent", "grep -rn password ~/.config/lazurio"],
    ["recursive grep over a tree holding repository custody", "grep -rn TOKEN .", org],
    ["Organization custody", "cat organizations/ExampleOrg_GEN3/company/colleagues/agent/private/secrets/google/client.json"],
    ["Organization infra custody", "jq . organizations/ExampleOrg_GEN3/infra/private/secrets/broker.env"],
    ["Personalspace custody", "jq . personalspace/owner_GEN3/secrets/token.json"],
    ["a custody log", "tail -f ~/.config/lazurio/custody/run/apply.log"],
    ["unparseable but names custody next to a reader", `cat ${SECRETS} "unterminated`],
    ["custody archived to stdout and encoded", "tar -cf - ~/.config/lazurio/credentials/lane | base64"],
    // Redirections apply left to right: the last one decides where stdout goes.
    ["stdout to /dev/null, then onto stderr", `cat ${ENV} >/dev/null 1>&2`],
    ["stdout to a file, then onto stderr", `cat ${ENV} > /tmp/copy >&2`],
    ["awk writing to /dev/stderr itself", `awk '{print > "/dev/stderr"}' ${ENV} > /dev/null`],
    ["sed writing to /dev/stderr itself", `sed -n 'w /dev/stderr' ${ENV} > /dev/null`],
    ["jq debug writes to stderr", `jq 'debug' ${SECRETS} > /dev/null`],
    ["inline code with only stdout sunk", `python3 -c "print(open('${ENV}').read())" > /tmp/out.txt`],
    ["dd to stdout", `dd if=${ENV} bs=64 count=1`],
    ["dd to stderr", `dd if=${ENV} of=/dev/stderr`],
    ["cp to stdout", `cp ${ENV} /dev/stdout`],
    ["cp to stderr", `cp ${ENV} /dev/stderr`],
    ["a symlink with a public name pointing at a secret", "cat ~/.config/lazurio/credentials/lane/export.pub"],
    // Review of 71e74444: jq builtins and descriptors the program opens itself.
    ["jq halt_error writes the input to stderr", `jq -R 'halt_error(1)' ${ENV} > /dev/null`],
    ["jq error writes the value to stderr", `jq '.keycloak_env | error' ${SECRETS} > /dev/null`],
    ["awk to /dev/fd/3 routed to stderr", `awk '{ print > "/dev/fd/3" }' ${ENV} 3>&2 > /dev/null`],
    ["awk to /dev/fd/3 opened by an enclosing group", `{ awk '{ print > "/dev/fd/3" }' ${ENV} > /dev/null; } 3>&2`],
    ["tee to /dev/stderr", `tee /dev/stderr < ${ENV} > /dev/null`],
    ["stderr of a command substitution is not covered by the command's redirection", `X=$(cat ${ENV} >&2) 2>/dev/null`],
    ["custody compressed from stdin and encoded", `cat ${SECRETS} | gzip | base64`],
    ["gzip -c of custody", `gzip -c ${ENV} | xxd`],
    ["zip to stdout", "zip -r - ~/.config/lazurio/credentials/lane | base64"],
    // zsh, which Claude Code runs on macOS: a descriptor redirected twice, or
    // one already feeding a pipe, writes to every target (MULTIOS); input
    // redirections are concatenated; redirections without a command run `cat`.
    ["zsh: stdout onto stderr and /dev/null", `cat ${ENV} >&2 > /dev/null`],
    ["zsh: stdout into a file and the pipe", `cat ${ENV} > /tmp/env.copy | cat`],
    ["zsh: stdout into /dev/null and the pipe, after stderr onto it", `grep KC_ ${ENV} 2>&1 > /dev/null | head`],
    ["zsh: &> /dev/null still feeds the pipe", `jq . ${SECRETS} &> /dev/null | cat`],
    ["zsh: a group into /dev/null and the pipe", `{ cat ${ENV}; } > /dev/null | cat`],
    ["zsh: tee into /dev/null and the pipe", `cat ${ENV} | tee /tmp/env.copy > /dev/null | cat`],
    ["zsh: >&1 keeps the transcript next to a file", `cat ${ENV} >&1 > /tmp/env.copy`],
    ["zsh: descriptor 3 carries stderr to stdout", `cat ${ENV} 3>&2 >&3 > /dev/null`],
    ["zsh: input redirections are concatenated", `cat < ${ENV} < /dev/null`],
    ["zsh: an input redirection adds to the pipe", `cat ${ENV} | cat < /dev/null`],
    ["zsh: a here-string adds to the pipe", `cat ${ENV} | cat <<< x`],
    ["zsh: redirections without a command run cat", `< ${ENV} >&2`],
    ["zsh: a pipe into redirections without a command", `cat ${ENV} | >&2`],
    ["zsh: a here-string without a command", `X=$(jq -r .keycloak_env ${SECRETS}); <<< "$X"`],
    ["zsh: a here-document without a command", `<<EOF\n$(cat ${ENV})\nEOF`],
    ["zsh: =cat runs cat", `=cat ${ENV}`],
    ["zsh: the pipe runs before a here-document as code", `cat ${ENV} | python3 - <<'PY'\nprint(1)\nPY`],
    // Both shells.
    ["|& sends stderr into the pipe after the command's redirections", `bash -c 'cat ${ENV} >&2' 2>/dev/null |& cat`],
    ["exec opens a descriptor onto stderr for later commands", `exec 3>&2; cat ${ENV} >&3`],
    ["a here-string as a shell script", `bash <<< "cat ${ENV}"`],
    ["inline code reading a here-document that holds a value", `python3 -c 'import sys; print(sys.stdin.read())' <<EOF\n$(cat ${ENV})\nEOF`],
    ["stderr of a command substitution in a command's arguments", `echo "$(cat ${ENV} >&2)" 2>/dev/null`],
  ];
  for (const [name, command, cwd] of cases) {
    test(name, () => {
      expect(bash(command, cwd)).toEqual(expect.any(String));
    });
  }

  test("Monitor runs commands like Bash", () => {
    expect(custodyReason({ tool_name: "Monitor", tool_input: { command: `tail -f ${ENV}` }, cwd: lazurio }, { model, env: {} })).toEqual(expect.any(String));
  });

  test("a secret in the environment never reaches the deny reason", () => {
    const secret = "tok-Zq8xVk2mWp9Lr4Tn8Yc1";
    const reason = custodyReason(
      { tool_name: "Bash", tool_input: { command: "cat ~/.config/lazurio/credentials/$API_TOKEN" }, cwd: lazurio },
      { model, env: { API_TOKEN: secret } },
    );
    expect(reason).toEqual(expect.any(String));
    expect(reason).not.toContain(secret);
  });

  test("Read of a public-named symlink that points at a secret", () => {
    expect(custodyReason({ tool_name: "Read", tool_input: { file_path: join(lane, "export.pub") }, cwd: lazurio }, { model })).toContain("Read would show");
  });

  test("Read of a custody file", () => {
    expect(custodyReason({ tool_name: "Read", tool_input: { file_path: join(lane, "issuer-secrets.json") }, cwd: lazurio }, { model })).toContain("Read would show");
  });

  test("Grep in content mode over a custody parent", () => {
    const input = { tool_name: "Grep", tool_input: { pattern: "KC_", path: join(home, ".config/lazurio"), output_mode: "content" }, cwd: lazurio };
    expect(custodyReason(input, { model })).toContain("Grep in content mode");
  });
});

describe("allows normal work with custody", () => {
  const cases = [
    ["machines-operate with a credential map, piped to tail", `machines-operate apply --credential-map ${MAP} 2>&1 | tail -40`],
    ["credential map as --flag=value", `machines-operate plan --credential-map=${MAP} | tee /tmp/plan.log`],
    ["kit apply.sh by path", `bash ${KIT}/apply.sh lane-dir 35 2>&1 | tail -20`],
    ["kit plan-capture.sh by path", `${KIT}/plan-capture.sh lane-dir --dry-run`],
    ["kit deploy.sh by path", "./deploy.sh window-ready lane.env 2>&1 | tail -5"],
    ["ls piped to grep", "ls -la ~/.config/lazurio/credentials/lane | grep json"],
    ["stat", `stat -f '%Lp %z' ${SECRETS}`],
    ["test and echo", `test -s ${SECRETS} && echo present`],
    ["chmod", `chmod 600 ${SECRETS}`],
    ["mkdir in custody", "mkdir -p ~/.config/lazurio/credentials/new-lane && chmod 700 ~/.config/lazurio/credentials/new-lane"],
    ["cp and mv within custody", `cp ${SECRETS} ${SECRETS}.bak && mv ${SECRETS}.bak ${SECRETS}`],
    ["wc -c from a redirect", `wc -c < ${SECRETS}`],
    ["wc -c", `wc -c ${SECRETS}`],
    ["shasum", `shasum -a 256 ${SECRETS} | cut -c1-12`],
    ["cmp", `cmp -s ${SECRETS} ${MAP} && echo same || echo different`],
    ["jq into a file, then mv", `jq '.a = 1' ${SECRETS} > /tmp/out.json && mv /tmp/out.json ${SECRETS}`],
    ["python script by path that writes custody", `python3 -I tools/build-apply-custody.py ${MAP} vhr_synthetic`],
    ["bun script by path", `bun tools/build-map.ts --credential-map ${MAP}`],
    ["node script by path", `node tools/check.mjs ${SECRETS}`],
    ["the custody helper", `bun scripts/custody/custody-shape.mjs --fingerprint ${SECRETS} ${MAP}`],
    ["grep -q", `grep -q KC_DB ${ENV} && echo present`],
    ["grep -c", `grep -c '=' ${ENV}`],
    ["grep -l -r", "grep -l -r issuer ~/.config/lazurio/credentials"],
    ["a value passed to a tool", `X=$(jq -r .token ${SECRETS}); curl -sS -H "Authorization: Bearer $X" https://example.invalid`],
    ["gh secret set from a redirect", `gh secret set TOKEN --repo example/example < ${ENV}`],
    ["remote write from stdin", `ssh host 'sudo tee /etc/example >/dev/null' < ${ENV}`],
    ["public key", "cat ~/.config/lazurio/credentials/lane/id_ed25519.pub"],
    ["known_hosts", "awk '{print $1}' ~/.config/lazurio/credentials/lane/known_hosts"],
    ["rg in the Lazurio root (Git-ignored custody)", "rg -n TODO ."],
    ["rg over home (hidden directories skipped)", "rg -n TODO ~"],
    ["echo a custody path", `echo ${MAP}`],
    ["source then run a tool", `set -a; . ${ENV}; set +a; ./deploy.sh lane`],
    ["hash of content", `cat ${SECRETS} | shasum -a 256`],
    ["length of a value", `jq -r .keycloak_env ${SECRETS} | wc -c`],
    ["jq exit status only", `jq -e '.keycloak_env' ${SECRETS} > /dev/null && echo has-env`],
    ["sed in place", `sed -i.bak 's/a/b/' ${ENV}`],
    ["find lists names", "find ~/.config/lazurio/credentials -name '*.json' | sort"],
    ["find -exec shasum", "find ~/.config/lazurio/credentials -type f -exec shasum -a 256 {} +"],
    ["subshell cd does not leak", "(cd ~/.config/lazurio/credentials/lane && ls) && cat README.md"],
    ["unrelated", "git status --short && git log --oneline -3 && cat README.md | head -5"],
    ["grep over a tree without custody", "grep -rn record infra/machines", org],
    ["archive of custody into custody", "tar -czf ~/.config/lazurio/custody/run/lane.tgz -C ~/.config/lazurio/credentials lane"],
    ["stdout and stderr both to /dev/null", `cat ${ENV} > /dev/null 2>&1`],
    ["stderr onto the pipe first, then stdout to a file", `cat ${ENV} 2>&1 > /tmp/env.copy`],
    ["inline code with stdout and stderr sunk", `python3 -c "print(open('${ENV}').read())" > /tmp/out.txt 2>&1`],
    ["inline code sunk inside bash -c", `bash -c "python3 -c 'print(open(\\"${ENV}\\").read())' > /tmp/o 2>/dev/null"`],
    ["dd into a file", `dd if=${ENV} of=/tmp/env.bin`],
    ["a child shell whose stderr is sunk by the caller", `bash -c 'cat ${ENV} >&2' 2>/dev/null`],
    ["a group whose stderr is sunk", `{ cat ${ENV} >&2; } 2>/dev/null`],
    ["tee to /dev/stderr with stderr sunk", `tee /dev/stderr < ${ENV} > /dev/null 2>/dev/null`],
    ["awk to /dev/fd/3 opened onto a file", `awk '{ print > "/dev/fd/3" }' ${ENV} 3>/tmp/fd3.out > /dev/null`],
    ["compressed in place", `gzip ${ENV}`],
    ["stdout into two files (zsh writes both)", `jq . ${SECRETS} > /tmp/a.json > /tmp/b.json`],
    ["stdout into a file and the pipe to a hasher", `cat ${ENV} > /tmp/env.copy | shasum -a 256`],
    ["redirections without a command, into a file", `< ${ENV} > /tmp/env.copy`],
    ["a pipe into redirections without a command, into a file", `cat ${ENV} | > /tmp/env.copy`],
    ["an assignment with an input redirection runs nothing", `X=1 < ${ENV}`],
  ];
  for (const [name, command, cwd] of cases) {
    test(name, () => {
      expect(bash(command, cwd)).toBeNull();
    });
  }

  test("Read of public key material and of non-custody files", () => {
    expect(custodyReason({ tool_name: "Read", tool_input: { file_path: join(lane, "id_ed25519.pub") }, cwd: lazurio }, { model })).toBeNull();
    expect(custodyReason({ tool_name: "Read", tool_input: { file_path: join(lazurio, "README.md") }, cwd: lazurio }, { model })).toBeNull();
  });

  test("Grep in content mode over the Lazurio root, and listing custody files", () => {
    expect(custodyReason({ tool_name: "Grep", tool_input: { pattern: "x", output_mode: "content" }, cwd: lazurio }, { model })).toBeNull();
    expect(custodyReason({ tool_name: "Grep", tool_input: { pattern: "x", path: lane }, cwd: lazurio }, { model })).toBeNull();
  });

  test("other tools and malformed input are not judged", () => {
    expect(custodyReason({ tool_name: "Write", tool_input: { file_path: join(lane, "x.json") } }, { model })).toBeNull();
    expect(custodyReason({ tool_name: "Bash", tool_input: {} }, { model })).toBeNull();
    expect(custodyReason(null, { model })).toBeNull();
  });
});

// Ground truth: each command runs on synthetic custody holding a marker,
// under bash and, where it is installed, zsh (Claude Code runs the user's
// shell, zsh on macOS). A row says whether the marker reaches stdout or
// stderr under bash and under zsh; the real runs check both columns, and the
// guard must deny exactly the rows where either shell prints (review of
// 71e74444 asked for real output, not only taint).
describe("the guard agrees with what bash and zsh really print", () => {
  const MARKER = "zq8x-synthetic-custody-marker";
  const home2 = join(sandbox, "oracle-home");
  const root2 = join(home2, "Lazurio");
  const dir = join(home2, ".config/lazurio/credentials/lane");
  write(join(dir, "secret.env"), `TOKEN=${MARKER}\n`);
  write(join(dir, "secret.json"), JSON.stringify({ token: MARKER }));
  mkdirSync(root2, { recursive: true });
  const model2 = createCustodyModel({ home: home2, lazurioRoot: root2, caseInsensitive: false });
  const E = "~/.config/lazurio/credentials/lane/secret.env";
  const J = "~/.config/lazurio/credentials/lane/secret.json";
  const ABS = join(dir, "secret.env");
  const cases = [
    // command, bash prints, zsh prints, program the row needs
    [`cat ${E}`, true, true],
    [`cat ${E} >/dev/null 1>&2`, true, true],
    [`cat ${E} > copy.out >&2`, true, true],
    [`cat ${E} > /dev/null 2>&1`, false, false],
    [`cat ${E} 2>&1 > copy.out`, false, false],
    [`awk '{ print > "/dev/stderr" }' ${E} > /dev/null`, true, true, "awk"],
    [`awk '{ print > "/dev/fd/3" }' ${E} 3>&2 > /dev/null`, true, true, "awk"],
    [`awk '{ print > "/dev/fd/3" }' ${E} 3> fd3.out > /dev/null`, false, false, "awk"],
    [`{ awk '{ print > "/dev/fd/3" }' ${E} > /dev/null; } 3>&2`, true, true, "awk"],
    [`sed -n 'w /dev/stderr' ${E} > /dev/null`, true, true, "sed"],
    [`jq -R 'halt_error(1)' ${E} > /dev/null`, true, true, "jq"],
    [`jq '.token | error' ${J} > /dev/null`, true, true, "jq"],
    [`jq '.token' ${J} > copy.json`, false, false, "jq"],
    // zsh expands `~` after `=` only with MAGIC_EQUAL_SUBST, so dd gets the absolute path.
    [`dd if=${ABS} 2>/dev/null`, true, true, "dd"],
    [`dd if=${ABS} of=copy.bin 2>/dev/null`, false, false, "dd"],
    [`cp ${E} copy.env`, false, false],
    [`tee /dev/stderr < ${E} > /dev/null`, true, true, "tee"],
    [`tee /dev/stderr < ${E} > /dev/null 2>/dev/null`, false, false, "tee"],
    [`bash -c 'cat ${E} >&2'`, true, true],
    [`bash -c 'cat ${E} >&2' 2>/dev/null`, false, false],
    [`{ cat ${E} >&2; } 2>/dev/null`, false, false],
    [`python3 -c "import sys; sys.stderr.write(open('${ABS}').read())" > /dev/null`, true, true, "python3"],
    [`python3 -c "print(open('${ABS}').read())" > copy.txt 2>&1`, false, false, "python3"],
    [`shasum -a 256 ${E} | cut -c1-8`, false, false, "shasum"],
    [`wc -c < ${E}`, false, false],
    [`grep -q TOKEN ${E} && echo present`, false, false],
    [`exec 3>&2; cat ${E} >&3`, true, true],
    [`bash <<< "cat ${E}"`, true, true],
    [`echo "$(cat ${E} >&2)" 2>/dev/null`, true, true],
    // Where the shells differ. bash runs an assignment's substitution
    // outside the command's redirections.
    [`X=$(cat ${E} >&2) 2>/dev/null`, true, false],
    // zsh MULTIOS: every target of a descriptor redirected twice, the pipe included.
    [`cat ${E} >&2 > /dev/null`, false, true],
    [`cat ${E} >&1 > copy.out`, false, true],
    [`cat ${E} 3>&2 >&3 > /dev/null`, false, true],
    [`cat ${E} > copy.out > /dev/null`, false, false],
    [`cat ${E} > /dev/null | cat`, false, true],
    [`cat ${E} 2>&1 > /dev/null | cat`, false, true],
    [`cat ${E} &> /dev/null | cat`, false, true],
    [`{ cat ${E}; } > /dev/null | cat`, false, true],
    [`cat ${E} | tee copy.out > /dev/null | cat`, false, true, "tee"],
    [`cat ${E} > copy.out | wc -c`, false, false],
    [`cat < ${E} < /dev/null`, false, true],
    [`cat ${E} | cat < /dev/null`, false, true],
    // zsh NULLCMD and READNULLCMD: redirections without a command run `cat`.
    [`< ${E}`, false, true],
    [`< ${E} >&2`, false, true],
    [`cat ${E} | >&2`, false, true],
    [`<<< "$(cat ${E})"`, false, true],
    [`< ${E} > copy.out`, false, false],
    [`X=1 < ${E}`, false, false],
    // zsh EQUALS.
    [`=cat ${E}`, false, true],
  ];
  for (const [command, bashPrints, zshPrints, needs] of cases) {
    const leaks = bashPrints || zshPrints;
    test(`${leaks ? "denies" : "allows"}: ${command}`, () => {
      const reason = custodyReason({ tool_name: "Bash", tool_input: { command }, cwd: root2 }, { model: model2, env: {} });
      expect(reason !== null).toBe(leaks);
    });
    for (const [shell, prints] of [
      ["bash", bashPrints],
      ["zsh", zshPrints],
    ]) {
      const runnable = Boolean(Bun.which(shell)) && (!needs || Boolean(Bun.which(needs)));
      test.skipIf(!runnable)(`${shell} ${prints ? "prints" : "keeps it out"}: ${command}`, () => {
        const env = { PATH: process.env.PATH ?? "", HOME: home2, LANG: "C" };
        const run = Bun.spawnSync([shell, "-c", command], { cwd: root2, env, stdin: "ignore" });
        expect(`${run.stdout}${run.stderr}`.includes(MARKER)).toBe(prints);
      });
    }
  }
});

describe("hook protocol", () => {
  const guard = join(import.meta.dir, "custody-guard.mjs");
  const run = (stdin) => {
    const result = Bun.spawnSync([process.execPath, guard], { stdin: Buffer.from(stdin), env: { ...process.env, HOME: home } });
    return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() };
  };

  test("a positive match prints a PreToolUse deny with the reason", () => {
    const { code, out } = run(JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: `jq . ${SECRETS}` }, cwd: home }));
    expect(code).toBe(0);
    const response = JSON.parse(out);
    expect(response.hookSpecificOutput.hookEventName).toBe("PreToolUse");
    expect(response.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(response.hookSpecificOutput.permissionDecisionReason).toContain("custody-shape.mjs");
  });

  test("an allowed call prints nothing", () => {
    const { code, out } = run(JSON.stringify({ tool_name: "Bash", tool_input: { command: `ls ${SECRETS}` }, cwd: home }));
    expect(code).toBe(0);
    expect(out).toBe("");
  });

  test("broken input fails open: exit 0 and no decision", () => {
    const { code, out } = run("{ not json");
    expect(code).toBe(0);
    expect(out).toBe("");
  });

  test("the deny message offers the helper and no way around the guard", () => {
    const message = denyMessage("`cat` reads a file", { home });
    expect(message).toContain("custody-shape.mjs");
    expect(message).not.toMatch(/LAZURIO_[A-Z_]*=|--no-guard|bypass/iu);
    expect(hookResponse({ tool_name: "Bash", tool_input: { command: "ls" }, cwd: home }, { model })).toBeNull();
  });
});
