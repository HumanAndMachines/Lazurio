// Decision 0104: .claude/skills je Git-tracked byte-for-byte mirror kanonického
// .agents/skills. Tenhle skript je lokální doctor/repair lane Lazuria
// rootu (adaptace referenční implementace z OrganizationTemplate_GEN3):
//   bun run doctor:agent-skills  — read-only parity check (drift => exit 1)
//   bun run repair:agent-skills  — fail-closed no-write diagnostika
import {
  readFile,
} from "node:fs/promises";
import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { trustedGitCandidates as canonicalTrustedGitCandidates } from "../lazurio/core/cli-provenance-lib.mjs";
import {
  AGENT_SKILLS_ENTRYPOINT_SCHEMA,
  CLAUDE_SKILLS_MATERIALIZATION,
  inspectAgentSkillsEntrypoint,
  listSkillFiles,
} from "../lazurio/runtime/agent-skills-entrypoint-lib.mjs";

export const CANONICAL_SKILLS_PATH = ".agents/skills";
export const CLAUDE_SKILLS_PATH = ".claude/skills";

const scriptPath = fileURLToPath(import.meta.url);
const defaultRoot = resolve(dirname(scriptPath), "..");
// Známé instalační prefixy Gitu. Discovery zůstává bez PATH lookupu (obrana
// proti podvrženému `git` v PATH), ale musí pokrýt i instalace bez admin práv:
// Git for Windows se u korporátního uživatele bez administrátora instaluje do
// %LOCALAPPDATA%\Programs\Git (cílová persona decision 0059), na macOS bývá
// vedle systémového shimu Homebrew.
export function trustedGitCandidates(platform = process.platform, env = process.env) {
  return canonicalTrustedGitCandidates(platform, {
    homeDirectory: homedir(),
    environment: env,
  });
}

function sanitizedGitEnvironment() {
  const environment = {};
  for (const key of ["TMPDIR", "TEMP", "TMP", "SystemRoot", "ComSpec", "PATHEXT"]) {
    if (typeof process.env[key] === "string") environment[key] = process.env[key];
  }
  environment.LC_ALL = "C";
  environment.GIT_TERMINAL_PROMPT = "0";
  environment.GIT_OPTIONAL_LOCKS = "0";
  environment.GIT_PAGER = "cat";
  environment.GIT_CONFIG_NOSYSTEM = "1";
  environment.GIT_CONFIG_GLOBAL = process.platform === "win32" ? "NUL" : "/dev/null";
  environment.GIT_CONFIG_COUNT = "0";
  return environment;
}

export function trustedGitExecutable(platform = process.platform) {
  for (const candidate of trustedGitCandidates(platform)) {
    try {
      const canonicalPath = realpathSync.native(candidate);
      if (isAbsolute(canonicalPath) && statSync(canonicalPath).isFile()) {
        return canonicalPath;
      }
    } catch {
      // Zkus další system-owned kandidát; caller-controlled discovery není povolená.
    }
  }
  return null;
}

function git(root, args) {
  const executable = trustedGitExecutable();
  if (!executable) {
    return { exitCode: 1, stdout: new Uint8Array(), stderr: new Uint8Array() };
  }
  return Bun.spawnSync({
    cmd: [executable, ...args],
    cwd: root,
    env: sanitizedGitEnvironment(),
    stdout: "pipe",
    stderr: "pipe",
  });
}

function output(result) {
  return new TextDecoder().decode(result.stdout).trim();
}

function comparablePath(path, platform = process.platform) {
  const normalized = resolve(path).replaceAll("\\", "/").replace(/\/+$/, "");
  return platform === "win32" ? normalized.toLowerCase() : normalized;
}

function publicState({ status, code, problems = [], message }) {
  return {
    schema_version: AGENT_SKILLS_ENTRYPOINT_SCHEMA,
    status,
    code,
    canonical_path: CANONICAL_SKILLS_PATH,
    compatibility_path: CLAUDE_SKILLS_PATH,
    materialization: CLAUDE_SKILLS_MATERIALIZATION,
    problems,
    message,
  };
}

export async function readActiveSkillSlugs(root = defaultRoot) {
  const manifestPath = join(resolve(root), CANONICAL_SKILLS_PATH, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const slugs = [];
  for (const skill of manifest.skills ?? []) {
    if (typeof skill.slug !== "string" || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(skill.slug)) {
      // Slug je součást filesystem cest mirroru; cokoliv mimo kebab-case
      // (tečky, lomítka, "..") by dovolilo traversal mimo kanonický katalog.
      throw new Error(
        `Manifest skill ${typeof skill.slug === "string" ? skill.slug : "<bez slugu>"} musí mít kebab-case slug bez cest.`,
      );
    }
    const expectedPath = `${CANONICAL_SKILLS_PATH}/${skill.slug}/SKILL.md`;
    if (skill.path !== expectedPath) {
      throw new Error(
        `Manifest skill ${skill.slug} musí mít path ${expectedPath}.`,
      );
    }
    slugs.push(skill.slug);
  }
  return [...new Set(slugs)].sort();
}

// Očekávaný mirror = všechny obyčejné soubory celých adresářů aktivních
// skillů (SKILL.md + references/ + templates/ + scripts/), decision 0104
// + CAC-0085. Symlinky walker vynechá; jejich fail-closed hlášení drží
// inspect/repair guardy.
export async function expectedMirrorPaths(root, slugs) {
  const paths = [];
  for (const slug of slugs) {
    const canonicalDirectory = join(resolve(root), CANONICAL_SKILLS_PATH, slug);
    const { files, unsafe } = await listSkillFiles(
      canonicalDirectory,
      `${CANONICAL_SKILLS_PATH}/${slug}`,
    );
    if (unsafe.length > 0 || !files.has("SKILL.md")) {
      throw new Error([
        ...unsafe,
        ...(!files.has("SKILL.md")
          ? [`${CANONICAL_SKILLS_PATH}/${slug}/SKILL.md musí být obyčejný soubor.`]
          : []),
      ].join(" "));
    }
    for (const relativeFile of files.keys()) {
      paths.push(`${CLAUDE_SKILLS_PATH}/${slug}/${relativeFile}`);
    }
  }
  return paths.sort();
}

// Git kontrakt: mirror nesmí být gitignored a tracked obsah .claude/skills smí
// být jen odvozený mirror aktivních skillů. `blockers` jsou stavy, které
// repair lane nesmí řešit sama; `staleTracked` jsou tracked mirror artefakty
// bez kanonického protějšku a vyžadují explicitní Git-reviewovanou změnu.
export function validateGitContract(root, expectedPaths) {
  const blockers = [];
  const staleTracked = [];
  const topLevel = git(root, ["rev-parse", "--show-toplevel"]);
  if (topLevel.exitCode !== 0) {
    blockers.push("Agent-skills mirror lze spravovat jen uvnitř Git checkoutu.");
    return { blockers, staleTracked };
  }
  try {
    // Bez téhle vazby by check i repair pracovaly s indexem nadřazeného
    // repozitáře, kdyby root nebyl vlastní Git checkout.
    if (
      comparablePath(realpathSync.native(output(topLevel))) !==
      comparablePath(realpathSync.native(root))
    ) {
      blockers.push("Agent-skills mirror nesmí převzít Git index nadřazeného repozitáře.");
      return { blockers, staleTracked };
    }
  } catch {
    blockers.push("Nelze bezpečně svázat agent-skills mirror s Git rootem repozitáře.");
    return { blockers, staleTracked };
  }

  const ignored = git(root, ["check-ignore", "--no-index", "-q", "--", CLAUDE_SKILLS_PATH]);
  if (ignored.exitCode === 0) {
    blockers.push(`${CLAUDE_SKILLS_PATH} je Git-tracked odvozený mirror a nesmí být v .gitignore.`);
  }

  const tracked = git(root, ["ls-files", "--cached", "--", CLAUDE_SKILLS_PATH]);
  if (tracked.exitCode !== 0) {
    blockers.push(`Nelze bezpečně načíst Git index pro ${CLAUDE_SKILLS_PATH}.`);
    return { blockers, staleTracked };
  }
  const expected = new Set(expectedPaths);
  for (const path of output(tracked).split("\n").filter(Boolean)) {
    if (!expected.has(path)) {
      staleTracked.push(`Trackovaný ${path} už nepatří do odvozeného mirroru aktivních skillů.`);
    }
  }
  return { blockers, staleTracked };
}

export async function checkAgentSkillsMirror(root = defaultRoot, options = {}) {
  const repoRoot = resolve(root);
  const inspection = await inspectAgentSkillsEntrypoint(repoRoot, options);
  if (inspection.status === "blocked" || inspection.status === "not_applicable") {
    return inspection;
  }
  let slugs;
  try {
    slugs = await readActiveSkillSlugs(repoRoot);
  } catch (error) {
    return publicState({
      status: "blocked",
      code: "manifest_invalid",
      problems: [error instanceof Error ? error.message : String(error)],
      message: "Manifest aktivních skillů nelze bezpečně přečíst.",
    });
  }
  let expectedPaths;
  try {
    expectedPaths = await expectedMirrorPaths(repoRoot, slugs);
  } catch (error) {
    return publicState({
      status: "blocked",
      code: "canonical_unsafe_content",
      problems: [error instanceof Error ? error.message : String(error)],
      message: "Kanonický katalog obsahuje nebezpečný nebo neplatný obsah.",
    });
  }
  const gitContract = validateGitContract(repoRoot, expectedPaths);
  if (gitContract.blockers.length > 0) {
    return publicState({
      status: "blocked",
      code: "entrypoint_contract_invalid",
      problems: gitContract.blockers,
      message: "Claude skills mirror porušuje Git kontrakt.",
    });
  }
  if (gitContract.staleTracked.length > 0 && inspection.status === "ok") {
    return publicState({
      status: "repair_needed",
      code: "mirror_stale_tracked",
      problems: gitContract.staleTracked,
      message: `${CLAUDE_SKILLS_PATH} nese tracked artefakty mimo aktivní skilly; oprav je explicitně v task worktree.`,
    });
  }
  if (inspection.status === "ok") {
    // Obsahová parita nestačí: mirror soubor mimo Git index by tiše chyběl
    // v commitu i čerstvém checkoutu, i když doctor vidí shodné bajty.
    const tracked = git(repoRoot, ["ls-files", "--cached", "--", CLAUDE_SKILLS_PATH]);
    if (tracked.exitCode === 0) {
      const trackedSet = new Set(output(tracked).split("\n").filter(Boolean));
      const untracked = expectedPaths.filter((path) => !trackedSet.has(path));
      if (untracked.length > 0) {
        return publicState({
          status: "repair_needed",
          code: "mirror_untracked",
          problems: untracked.map((path) => `${path} není v Git indexu.`),
          message: `${CLAUDE_SKILLS_PATH} mirror není celý v Git indexu; oprav ho explicitně v task worktree.`,
        });
      }
    }
  }
  return inspection;
}

export async function repairAgentSkillsMirror(root = defaultRoot, options = {}) {
  const repoRoot = resolve(root);
  const before = await checkAgentSkillsMirror(repoRoot, options);
  if (before.status === "ok" || before.status === "blocked" || before.status === "not_applicable") {
    return before;
  }
  return publicState({
    status: "blocked",
    code: "manual_repair_required",
    problems: before.problems ?? [],
    message: `${CLAUDE_SKILLS_PATH} vyžaduje explicitní Git-reviewovanou opravu v task worktree; příkaz nic nezměnil.`,
  });
}

function printState(state, json) {
  if (json) {
    console.log(JSON.stringify(state, null, 2));
    return;
  }
  const label = state.status === "ok" ? "ok" : state.status === "repair_needed" ? "repair" : "fail";
  console.log(`${label} - agent-skills-entrypoint: ${state.message}`);
  for (const problem of state.problems ?? []) console.log(`  - ${problem}`);
}

async function main() {
  const [command = "check", ...args] = process.argv.slice(2);
  const json = args.includes("--json");
  if (!["check", "repair"].includes(command)) {
    throw new Error("Použití: agent-skills-entrypoint.mjs <check|repair> [--json].");
  }
  const state = command === "repair"
    ? await repairAgentSkillsMirror(defaultRoot)
    : await checkAgentSkillsMirror(defaultRoot);
  printState(state, json);
  if (state.status !== "ok") process.exitCode = 1;
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    const state = publicState({
      status: "blocked",
      code: "entrypoint_operation_failed",
      problems: [error instanceof Error ? error.message : String(error)],
      message: "Kontrola nebo diagnostika agent-skills mirroru selhala.",
    });
    printState(state, process.argv.includes("--json"));
    process.exitCode = 1;
  }
}
