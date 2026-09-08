// Agent skills entrypoint (rozhodnutí Principála 2026-09-08).
//
// `.agents/skills` je jediný autorský zdroj skillů (open standard, Codex ho čte
// nativně). `.claude/skills` je Git-tracked bajtově shodná kopie pro Claude
// Code — generovaný artefakt jako lockfile. Žádné symlinky, junctiony, Windows
// Developer Mode, placeholdery ani jiné stavy.
//
//   sync   zkopíruje `.agents/skills` → `.claude/skills` bajtově shodně, smaže
//          přebytečné soubory a adresáře v cíli; symlink/junction v cíli nahradí
//          skutečným adresářem; idempotentní a deterministické
//   check  fail-closed: oba stromy musí být bajtově shodné a `.claude/skills`
//          ani žádná jeho část nesmí být symlink/junction; jinak jediná hláška
//
// Kanonický zdroj tohoto souboru je HumanAndMachines/Lazurio
// `lazurio/runtime/agent-skills-entrypoint.mjs`. OrganizationTemplate_GEN3 ho
// nese jako managed verbatim kopii `scripts/agent-skills-entrypoint.mjs`.
// Soubor nemá jiné závislosti než Node/Bun standardní knihovnu a root bere
// z `process.cwd()` (`bun run` ho nastaví na root balíčku).
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  rm,
  rmdir,
  unlink,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export const CANONICAL_SKILLS_PATH = ".agents/skills";
export const CLAUDE_SKILLS_PATH = ".claude/skills";
export const AGENT_SKILLS_MIRROR_MESSAGE =
  "`.claude/skills` neodpovídá `.agents/skills`; spusť `bun run skills:sync` a změnu commitni";

// OS junk, které vytváří Finder/Explorer a které Git v GEN3 repech ignoruje.
// Není součástí ani jednoho stromu, takže ho sync nekopíruje a check nehlásí.
const IGNORED_ENTRIES = new Set([".DS_Store", "Thumbs.db", "desktop.ini"]);

async function lstatOrNull(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

// Deterministický rekurzivní sken stromu: relativní posix cesta → absolutní
// cesta. Symlink (na Windows i junction) nebo jiný filesystem typ kdekoli
// uvnitř jde do `unsafe`; adresáře se vrací zvlášť kvůli mazání prázdných.
async function scanTree(baseDirectory, displayPrefix) {
  const files = new Map();
  const directories = [];
  const unsafe = [];
  const stack = [""];
  while (stack.length > 0) {
    const relativeDirectory = stack.pop();
    const directory = relativeDirectory ? join(baseDirectory, relativeDirectory) : baseDirectory;
    const entries = (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => !IGNORED_ENTRIES.has(entry.name))
      .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    for (const entry of entries) {
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) {
        unsafe.push({ relativePath, message: `${displayPrefix}/${relativePath} je symlink nebo junction.` });
      } else if (entry.isDirectory()) {
        directories.push(relativePath);
        stack.push(relativePath);
      } else if (entry.isFile()) {
        files.set(relativePath, join(directory, entry.name));
      } else {
        unsafe.push({ relativePath, message: `${displayPrefix}/${relativePath} má nepodporovaný filesystem typ.` });
      }
    }
  }
  return { files, directories, unsafe };
}

async function canonicalTree(root) {
  const canonicalPath = join(root, CANONICAL_SKILLS_PATH);
  const stat = await lstatOrNull(canonicalPath);
  if (!stat?.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${CANONICAL_SKILLS_PATH} musí být skutečný adresář.`);
  }
  const tree = await scanTree(canonicalPath, CANONICAL_SKILLS_PATH);
  if (tree.unsafe.length > 0) {
    throw new Error(
      `${CANONICAL_SKILLS_PATH} smí obsahovat jen obyčejné soubory a adresáře: ${tree.unsafe.map((entry) => entry.message).join(" ")}`,
    );
  }
  return tree;
}

// `.claude` musí být skutečný adresář (nebo chybět): přes symlinkovaný parent
// by sync zapisoval mimo repozitář a Git by mirror netrackoval.
async function mirrorParentProblem(mirrorPath) {
  const parentStat = await lstatOrNull(dirname(mirrorPath));
  if (parentStat && (parentStat.isSymbolicLink() || !parentStat.isDirectory())) {
    return `${dirname(CLAUDE_SKILLS_PATH)} musí být skutečný adresář, ne symlink nebo junction.`;
  }
  return null;
}

async function sameBytes(leftPath, rightPath) {
  const [left, right] = await Promise.all([readFile(leftPath), readFile(rightPath)]);
  return left.equals(right);
}

// Vrací seznam rozdílů; prázdný seznam znamená bajtově shodný mirror bez
// symlinků. Rozdíly slouží jen pro `--verbose`/testy, veřejná hláška je jedna.
export async function agentSkillsMirrorDifferences(root = process.cwd()) {
  const repositoryRoot = resolve(root);
  const mirrorPath = join(repositoryRoot, CLAUDE_SKILLS_PATH);
  let canonical;
  try {
    canonical = await canonicalTree(repositoryRoot);
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }
  const parentProblem = await mirrorParentProblem(mirrorPath);
  if (parentProblem) return [parentProblem];
  const mirrorStat = await lstatOrNull(mirrorPath);
  if (!mirrorStat) return [`${CLAUDE_SKILLS_PATH} chybí.`];
  if (mirrorStat.isSymbolicLink()) return [`${CLAUDE_SKILLS_PATH} je symlink nebo junction.`];
  if (!mirrorStat.isDirectory()) return [`${CLAUDE_SKILLS_PATH} není adresář.`];
  const mirror = await scanTree(mirrorPath, CLAUDE_SKILLS_PATH);
  const differences = mirror.unsafe.map((entry) => entry.message);
  for (const [relativePath, canonicalFile] of canonical.files) {
    const mirrorFile = mirror.files.get(relativePath);
    if (!mirrorFile) differences.push(`${CLAUDE_SKILLS_PATH}/${relativePath} chybí.`);
    else if (!(await sameBytes(canonicalFile, mirrorFile))) {
      differences.push(`${CLAUDE_SKILLS_PATH}/${relativePath} není bajtově shodný.`);
    }
  }
  for (const relativePath of mirror.files.keys()) {
    if (!canonical.files.has(relativePath)) differences.push(`${CLAUDE_SKILLS_PATH}/${relativePath} přebývá.`);
  }
  const canonicalDirectories = new Set(canonical.directories);
  for (const relativePath of mirror.directories) {
    if (!canonicalDirectories.has(relativePath)) differences.push(`${CLAUDE_SKILLS_PATH}/${relativePath}/ přebývá.`);
  }
  return differences;
}

export async function checkAgentSkillsMirror(root = process.cwd()) {
  const differences = await agentSkillsMirrorDifferences(root);
  return differences.length === 0
    ? { status: "ok", message: `${CLAUDE_SKILLS_PATH} je bajtově shodná kopie ${CANONICAL_SKILLS_PATH}.`, differences }
    : { status: "repair_needed", message: AGENT_SKILLS_MIRROR_MESSAGE, differences };
}

// Symlink i Windows junction odstraní jako link (cíl zůstává nedotčený);
// obyčejný soubor nebo adresář odstraní celý.
async function removeEntry(path, stat) {
  if (stat.isSymbolicLink()) {
    try {
      await unlink(path);
    } catch (error) {
      if (!["EPERM", "EISDIR"].includes(error?.code)) throw error;
      await rmdir(path);
    }
    return;
  }
  await rm(path, { recursive: true, force: true });
}

export async function syncAgentSkillsMirror(root = process.cwd()) {
  const repositoryRoot = resolve(root);
  const canonical = await canonicalTree(repositoryRoot);
  const mirrorPath = join(repositoryRoot, CLAUDE_SKILLS_PATH);
  const parentProblem = await mirrorParentProblem(mirrorPath);
  if (parentProblem) throw new Error(parentProblem);
  const changed = [];
  const mirrorStat = await lstatOrNull(mirrorPath);
  if (mirrorStat && (mirrorStat.isSymbolicLink() || !mirrorStat.isDirectory())) {
    await removeEntry(mirrorPath, mirrorStat);
    changed.push(`${CLAUDE_SKILLS_PATH} nahrazen skutečným adresářem.`);
  }
  await mkdir(mirrorPath, { recursive: true });
  const mirror = await scanTree(mirrorPath, CLAUDE_SKILLS_PATH);

  // 1. Přebytečné soubory, cizí adresáře a symlinky v cíli pryč.
  for (const relativePath of mirror.files.keys()) {
    if (canonical.files.has(relativePath)) continue;
    await rm(join(mirrorPath, relativePath), { force: true });
    changed.push(`${CLAUDE_SKILLS_PATH}/${relativePath} smazán.`);
  }
  for (const { relativePath } of mirror.unsafe) {
    const path = join(mirrorPath, relativePath);
    await removeEntry(path, await lstat(path));
    changed.push(`${CLAUDE_SKILLS_PATH}/${relativePath} odstraněn (nebyl obyčejný soubor ani adresář).`);
  }
  const canonicalDirectories = new Set(canonical.directories);
  for (const relativePath of [...mirror.directories].sort().reverse()) {
    if (canonicalDirectories.has(relativePath)) continue;
    await rm(join(mirrorPath, relativePath), { recursive: true, force: true });
    changed.push(`${CLAUDE_SKILLS_PATH}/${relativePath}/ smazán.`);
  }

  // 2. Adresáře a soubory podle kanonického stromu; kopíruje se jen rozdíl.
  for (const relativePath of canonical.directories) {
    await mkdir(join(mirrorPath, relativePath), { recursive: true });
  }
  for (const [relativePath, canonicalFile] of canonical.files) {
    const mirrorFile = join(mirrorPath, relativePath);
    if (mirror.files.has(relativePath) && (await sameBytes(canonicalFile, mirrorFile))) continue;
    await copyFile(canonicalFile, mirrorFile);
    changed.push(`${CLAUDE_SKILLS_PATH}/${relativePath} zapsán.`);
  }
  return { status: "ok", changed };
}

async function main(argv) {
  const [command, ...flags] = argv;
  const verbose = flags.includes("--verbose");
  if (command === "check") {
    const state = await checkAgentSkillsMirror();
    console.log(`${state.status === "ok" ? "ok" : "fail"} - agent-skills: ${state.message}`);
    if (verbose) for (const difference of state.differences) console.log(`  - ${difference}`);
    return state.status === "ok" ? 0 : 1;
  }
  if (command === "sync") {
    const result = await syncAgentSkillsMirror();
    console.log(`ok - agent-skills: ${CLAUDE_SKILLS_PATH} synchronizován (${result.changed.length} změn).`);
    if (verbose) for (const change of result.changed) console.log(`  - ${change}`);
    return 0;
  }
  console.error("Použití: agent-skills-entrypoint.mjs <check|sync> [--verbose]");
  return 2;
}

if (import.meta.main) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    console.error(`fail - agent-skills: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
