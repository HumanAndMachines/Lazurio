// Windows-safe compatibility contract: .agents/skills is canonical and
// .claude/skills is a Git-tracked byte-for-byte derived mirror. No symlink,
// junction, Developer Mode, or per-checkout materialization is required.
import { realpathSync, statSync } from "node:fs";
import {
  lstat,
  readFile,
  readdir,
  realpath,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const AGENT_SKILLS_ENTRYPOINT_SCHEMA = "companiesascode.agent_skills_entrypoint.v2";
export const CANONICAL_SKILLS_PATH = ".agents/skills";
export const CLAUDE_SKILLS_PATH = ".claude/skills";
export const CLAUDE_SKILLS_MATERIALIZATION = "tracked-derived-mirror";

const LEGACY_PLACEHOLDER = "../.agents/skills";
const IGNORED_ENTRIES = new Set([".DS_Store", "Thumbs.db", "desktop.ini"]);
const scriptPath = fileURLToPath(import.meta.url);
const defaultRoot = resolve(dirname(scriptPath), "..");

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

function comparablePath(path, platform = process.platform) {
  const normalized = resolve(path).replaceAll("\\", "/").replace(/\/+$/u, "");
  return platform === "win32" ? normalized.toLowerCase() : normalized;
}

function pathIsInside(root, target, platform = process.platform) {
  const relativePath = relative(root, target);
  return relativePath === "" || (
    !isAbsolute(relativePath)
    && !/^\.\.(?:[\\/]|$)/u.test(relativePath)
    && comparablePath(target, platform).startsWith(`${comparablePath(root, platform)}/`)
  );
}

async function lstatOrNull(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

export async function readActiveSkillSlugs(root = defaultRoot) {
  const manifest = JSON.parse(
    await readFile(join(resolve(root), CANONICAL_SKILLS_PATH, "manifest.json"), "utf8"),
  );
  const slugs = [];
  for (const skill of manifest.skills ?? []) {
    if (typeof skill.slug !== "string" || !/^[a-z0-9]+(-[a-z0-9]+)*$/u.test(skill.slug)) {
      throw new Error("Každý aktivní skill musí mít bezpečný kebab-case slug.");
    }
    const expectedPath = `${CANONICAL_SKILLS_PATH}/${skill.slug}/SKILL.md`;
    if (skill.path !== expectedPath) {
      throw new Error(`Manifest skill ${skill.slug} musí mít path ${expectedPath}.`);
    }
    slugs.push(skill.slug);
  }
  return [...new Set(slugs)].sort();
}

export async function listSkillFiles(baseDirectory, displayPrefix) {
  const files = new Map();
  const unsafe = [];
  const stack = [""];
  while (stack.length > 0) {
    const relativeDirectory = stack.pop();
    const directory = relativeDirectory ? join(baseDirectory, relativeDirectory) : baseDirectory;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (IGNORED_ENTRIES.has(entry.name)) continue;
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) unsafe.push(`${displayPrefix}/${relativePath} je symlink.`);
      else if (entry.isDirectory()) stack.push(relativePath);
      else if (entry.isFile()) files.set(relativePath, join(directory, entry.name));
      else unsafe.push(`${displayPrefix}/${relativePath} má nepodporovaný filesystem typ.`);
    }
  }
  return { files, unsafe };
}

async function expectedMirror(root) {
  const files = new Map();
  for (const slug of await readActiveSkillSlugs(root)) {
    const canonicalDirectory = join(root, CANONICAL_SKILLS_PATH, slug);
    const directoryStat = await lstatOrNull(canonicalDirectory);
    const skillStat = await lstatOrNull(join(canonicalDirectory, "SKILL.md"));
    if (
      !directoryStat?.isDirectory() || directoryStat.isSymbolicLink()
      || !skillStat?.isFile() || skillStat.isSymbolicLink()
    ) {
      throw new Error(`${CANONICAL_SKILLS_PATH}/${slug} musí být skutečný adresář s obyčejným SKILL.md.`);
    }
    const scan = await listSkillFiles(canonicalDirectory, `${CANONICAL_SKILLS_PATH}/${slug}`);
    if (scan.unsafe.length > 0) throw new Error(scan.unsafe.join(" "));
    for (const [relativeFile, path] of scan.files) files.set(`${slug}/${relativeFile}`, path);
  }
  return files;
}

async function inspectFilesystem(root, platform) {
  const canonicalPath = join(root, CANONICAL_SKILLS_PATH);
  const compatibilityPath = join(root, CLAUDE_SKILLS_PATH);
  const compatibilityParent = dirname(compatibilityPath);
  const [canonicalStat, compatibilityStat, parentStat] = await Promise.all([
    lstatOrNull(canonicalPath),
    lstatOrNull(compatibilityPath),
    lstatOrNull(compatibilityParent),
  ]);
  if (!canonicalStat?.isDirectory() || canonicalStat.isSymbolicLink()) {
    return publicState({
      status: "blocked",
      code: canonicalStat ? "canonical_not_directory" : "canonical_missing",
      problems: [`${CANONICAL_SKILLS_PATH} musí být skutečný kanonický adresář.`],
      message: "Kanonický agent-skills katalog není bezpečný.",
    });
  }
  const [rootRealPath, canonicalRealPath] = await Promise.all([realpath(root), realpath(canonicalPath)]);
  if (!pathIsInside(rootRealPath, canonicalRealPath, platform)) {
    return publicState({
      status: "blocked",
      code: "canonical_path_escape",
      problems: [`${CANONICAL_SKILLS_PATH} se dostává mimo root Organizace.`],
      message: "Kanonický agent-skills katalog není bezpečný.",
    });
  }
  if (parentStat && (!parentStat.isDirectory() || parentStat.isSymbolicLink())) {
    return publicState({
      status: "blocked",
      code: "entrypoint_parent_invalid",
      problems: [".claude musí být skutečný adresář uvnitř rootu Organizace."],
      message: "Claude compatibility mirror nemá bezpečný parent.",
    });
  }
  if (parentStat && !pathIsInside(rootRealPath, await realpath(compatibilityParent), platform)) {
    return publicState({
      status: "blocked",
      code: "entrypoint_parent_escape",
      problems: [".claude se dostává mimo root Organizace."],
      message: "Claude compatibility mirror nemá bezpečný parent.",
    });
  }
  if (!compatibilityStat) {
    return publicState({
      status: "repair_needed",
      code: "mirror_missing",
      message: `${CLAUDE_SKILLS_PATH} chybí; obnov ho explicitně v task worktree a commitni odvozený mirror.`,
    });
  }
  if (compatibilityStat.isSymbolicLink()) {
    try {
      const compatibilityRealPath = await realpath(compatibilityPath);
      if (comparablePath(compatibilityRealPath, platform) !== comparablePath(canonicalRealPath, platform)) {
        return publicState({
          status: "blocked",
          code: "entrypoint_wrong_link",
          problems: [`${CLAUDE_SKILLS_PATH} nemíří na ${CANONICAL_SKILLS_PATH}; Repair ho nesmaže.`],
          message: "Claude compatibility mirror obsahuje neznámý link.",
        });
      }
    } catch (error) {
      return publicState({
        status: "blocked",
        code: "entrypoint_wrong_link",
        problems: [`${CLAUDE_SKILLS_PATH} není ověřený legacy link: ${error instanceof Error ? error.message : String(error)}`],
        message: "Claude compatibility mirror obsahuje neznámý link.",
      });
    }
    return publicState({
      status: "repair_needed",
      code: "mirror_legacy_link",
      message: `${CLAUDE_SKILLS_PATH} je legacy link; jeho migrace vyžaduje explicitní Git-reviewovanou změnu.`,
    });
  }
  if (compatibilityStat.isFile()) {
    const contents = (await readFile(compatibilityPath, "utf8")).replace(/^\uFEFF/u, "").trim();
    return contents === LEGACY_PLACEHOLDER
      ? publicState({
        status: "repair_needed",
        code: "mirror_legacy_placeholder",
        message: `${CLAUDE_SKILLS_PATH} je legacy placeholder; jeho migrace vyžaduje explicitní Git-reviewovanou změnu.`,
      })
      : publicState({
        status: "blocked",
        code: "entrypoint_unexpected_file",
        problems: [`${CLAUDE_SKILLS_PATH} je neznámý soubor; Repair ho nesmaže.`],
        message: "Claude compatibility mirror nelze bezpečně opravit automaticky.",
      });
  }
  if (!compatibilityStat.isDirectory()) {
    return publicState({
      status: "blocked",
      code: "entrypoint_unknown_type",
      problems: [`${CLAUDE_SKILLS_PATH} má nepodporovaný filesystem typ.`],
      message: "Claude compatibility mirror není bezpečný.",
    });
  }
  let expected;
  try {
    expected = await expectedMirror(root);
  } catch (error) {
    return publicState({
      status: "blocked",
      code: "canonical_unsafe_content",
      problems: [error instanceof Error ? error.message : String(error)],
      message: "Kanonický katalog obsahuje nebezpečný nebo neplatný obsah.",
    });
  }
  const mirror = await listSkillFiles(compatibilityPath, CLAUDE_SKILLS_PATH);
  if (mirror.unsafe.length > 0) {
    return publicState({
      status: "blocked",
      code: "mirror_unsafe_content",
      problems: mirror.unsafe,
      message: "Claude skills mirror obsahuje nebezpečný obsah.",
    });
  }
  const drift = [];
  for (const [relativeFile, canonicalFile] of expected) {
    const mirrorFile = mirror.files.get(relativeFile);
    if (!mirrorFile) {
      drift.push(`${CLAUDE_SKILLS_PATH}/${relativeFile} chybí.`);
      continue;
    }
    const [canonicalBytes, mirrorBytes] = await Promise.all([readFile(canonicalFile), readFile(mirrorFile)]);
    if (!canonicalBytes.equals(mirrorBytes)) drift.push(`${CLAUDE_SKILLS_PATH}/${relativeFile} není byte-for-byte shodný.`);
  }
  for (const relativeFile of mirror.files.keys()) {
    if (!expected.has(relativeFile)) drift.push(`${CLAUDE_SKILLS_PATH}/${relativeFile} nepatří do mirroru.`);
  }
  return drift.length > 0
    ? publicState({
      status: "repair_needed",
      code: "mirror_drift",
      problems: drift,
      message: `${CLAUDE_SKILLS_PATH} není exact mirror; oprav ho explicitně v task worktree.`,
    })
    : publicState({
      status: "ok",
      code: "mirror_ready",
      message: `${CLAUDE_SKILLS_PATH} je byte-for-byte mirror aktivních skillů.`,
    });
}

function trustedGitCandidates(platform = process.platform) {
  if (platform === "darwin") return ["/usr/bin/git", "/opt/homebrew/bin/git", "/usr/local/bin/git"];
  if (platform === "linux") return ["/usr/bin/git", "/bin/git", "/usr/local/bin/git"];
  if (platform !== "win32") return [];
  return [
    "C:\\Program Files\\Git\\cmd\\git.exe",
    "C:\\Program Files\\Git\\bin\\git.exe",
    "C:\\Program Files (x86)\\Git\\cmd\\git.exe",
    "C:\\Program Files (x86)\\Git\\bin\\git.exe",
  ];
}

function trustedGitExecutable() {
  for (const candidate of trustedGitCandidates()) {
    try {
      const canonical = realpathSync.native(candidate);
      if (isAbsolute(canonical) && statSync(canonical).isFile()) return canonical;
    } catch {}
  }
  return null;
}

function runGit(root, args) {
  const executable = trustedGitExecutable();
  if (!executable) return { exitCode: 1, stdout: "" };
  const result = Bun.spawnSync([executable, ...args], {
    cwd: root,
    env: {
      LC_ALL: "C",
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
      GIT_CONFIG_COUNT: "0",
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      ...(process.env.ComSpec ? { ComSpec: process.env.ComSpec } : {}),
      ...(process.env.TEMP ? { TEMP: process.env.TEMP } : {}),
      ...(process.env.TMP ? { TMP: process.env.TMP } : {}),
    },
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  });
  return { exitCode: result.exitCode, stdout: new TextDecoder().decode(result.stdout).trim() };
}

function expectedGitPaths(expected) {
  return [...expected.keys()].map((path) => `${CLAUDE_SKILLS_PATH}/${path}`).sort();
}

function gitContract(root, expected) {
  const expectedPaths = new Set(expectedGitPaths(expected));
  const tracked = runGit(root, ["ls-files", "--cached", "--", CLAUDE_SKILLS_PATH]);
  if (tracked.exitCode !== 0) {
    return {
      blockers: ["Nelze přečíst Git index mirroru."],
      indexReadable: false,
      ignoreReadable: false,
      ignored: null,
      tracked: new Set(),
      expectedPaths,
    };
  }
  const trackedPaths = new Set(tracked.stdout.split("\n").filter(Boolean));
  const blockers = [];
  const ignored = runGit(root, ["check-ignore", "--no-index", "-q", "--", CLAUDE_SKILLS_PATH]);
  const ignoreReadable = ignored.exitCode === 0 || ignored.exitCode === 1;
  const ignoredByGit = ignored.exitCode === 0;
  if (!ignoreReadable) blockers.push(`Nelze ověřit, zda Git ignoruje ${CLAUDE_SKILLS_PATH}.`);
  if (ignoredByGit) blockers.push(`${CLAUDE_SKILLS_PATH} nesmí být v .gitignore.`);
  for (const path of expectedPaths) {
    if (!trackedPaths.has(path)) blockers.push(`${path} není v Git indexu.`);
  }
  return {
    blockers,
    indexReadable: true,
    ignoreReadable,
    ignored: ignoredByGit,
    tracked: trackedPaths,
    expectedPaths,
  };
}

export async function inspectAgentSkillsEntrypoint(
  root = process.cwd(),
  { platform = process.platform, includeGit = true } = {},
) {
  const organizationRoot = resolve(root);
  const filesystem = await inspectFilesystem(organizationRoot, platform);
  if (filesystem.status !== "ok" || !includeGit) return filesystem;
  const expected = await expectedMirror(organizationRoot);
  const contract = gitContract(organizationRoot, expected);
  if (!contract.indexReadable || !contract.ignoreReadable || contract.ignored) {
    return publicState({
      status: "blocked",
      code: "mirror_git_preflight_failed",
      problems: contract.blockers,
      message: "Git kontrakt mirroru nelze bezpečně ověřit.",
    });
  }
  if (contract.blockers.length > 0) {
    return publicState({
      status: "repair_needed",
      code: "mirror_untracked",
      problems: contract.blockers,
      message: `${CLAUDE_SKILLS_PATH} musí být celý trackovaný exact mirror.`,
    });
  }
  for (const tracked of contract.tracked) {
    if (!contract.expectedPaths.has(tracked)) {
      return publicState({
        status: "repair_needed",
        code: "mirror_stale_tracked",
        problems: [`Trackovaný ${tracked} už nemá kanonický protějšek.`],
        message: `${CLAUDE_SKILLS_PATH} obsahuje stale odvozený soubor.`,
      });
    }
  }
  return filesystem;
}

export async function repairAgentSkillsEntrypoint(root = process.cwd(), options = {}) {
  const organizationRoot = resolve(root);
  const before = await inspectAgentSkillsEntrypoint(organizationRoot, {
    ...options,
    includeGit: true,
  });
  if (before.status === "ok" || before.status === "blocked") return before;
  const expected = await expectedMirror(organizationRoot);
  const contract = gitContract(organizationRoot, expected);
  if (!contract.indexReadable || !contract.ignoreReadable || contract.ignored) {
    return publicState({
      status: "blocked",
      code: "mirror_git_preflight_failed",
      problems: contract.blockers,
      message: "Git kontrakt mirroru nelze bezpečně ověřit; nic nebylo změněno.",
    });
  }
  return publicState({
    status: "blocked",
    code: "manual_repair_required",
    problems: [...before.problems, ...contract.blockers],
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
  for (const problem of state.problems) console.log(`  - ${problem}`);
}

async function main() {
  const [command = "check", ...args] = process.argv.slice(2);
  if (!["check", "repair"].includes(command)) {
    throw new Error("Použití: agent-skills-entrypoint.mjs <check|repair> [--json].");
  }
  const state = command === "repair"
    ? await repairAgentSkillsEntrypoint(defaultRoot)
    : await inspectAgentSkillsEntrypoint(defaultRoot);
  printState(state, args.includes("--json"));
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
