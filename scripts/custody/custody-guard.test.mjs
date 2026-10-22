import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
    ["custody compressed from stdin and encoded", `cat ${SECRETS} | gzip | base64`],
    ["gzip -c of custody", `gzip -c ${ENV} | xxd`],
    ["zip to stdout", "zip -r - ~/.config/lazurio/credentials/lane | base64"],
  ];
  for (const [name, command, cwd] of cases) {
    test(name, () => {
      expect(bash(command, cwd)).toEqual(expect.any(String));
    });
  }

  test("Monitor runs commands like Bash", () => {
    expect(custodyReason({ tool_name: "Monitor", tool_input: { command: `tail -f ${ENV}` }, cwd: lazurio }, { model, env: {} })).toEqual(expect.any(String));
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
    ["compressed in place", `gzip ${ENV}`],
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
