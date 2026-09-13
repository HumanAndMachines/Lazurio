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
//
// Ukotvení zápisu: Node/Bun nemají `openat`, jedinou kernelem drženou referenci
// na adresář je pracovní adresář procesu. `sync` proto čte zdroj i provádí
// každou mutaci cíle uvnitř `anchored()`: validovaný adresář (lstat skutečný
// adresář, realpath uvnitř rootu) se stane cwd, jeho dev+ino se ověří proti
// validaci a všechny cesty jsou relativní. Přejmenování nebo záměna předka po
// validaci tak zápis nepřesměruje — zůstává v původním inode uvnitř repozitáře.
// Cwd je procesově globální, proto jsou ukotvené sekce serializované; read-only
// `check` (běží i paralelně nad více mounty v Doctoru) cwd nemění.
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rm,
  rmdir,
  stat,
  unlink,
} from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

export const CANONICAL_SKILLS_PATH = ".agents/skills";
export const CLAUDE_SKILLS_PATH = ".claude/skills";
export const AGENT_SKILLS_MIRROR_MESSAGE =
  "`.claude/skills` neodpovídá `.agents/skills`; spusť `bun run skills:sync` a změnu commitni";

// Pouze pro testy: hook zavolaný po validaci a ukotvení cílového parentu, před
// první mutací. Produkční běh ho nenastavuje.
export const syncTestHooks = Object.seal({ afterParentValidated: null });

// OS junk, které vytváří Finder/Explorer a které Git v GEN3 repech ignoruje.
// Není součástí ani jednoho stromu, takže ho sync nekopíruje a check nehlásí.
const IGNORED_ENTRIES = new Set([".DS_Store", "Thumbs.db", "desktop.ini"]);
// Finální komponenta otevíraného souboru nesmí být symlink (na Windows flag
// neexistuje; tam symlink souboru odhalí lstat před otevřením).
const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;

async function lstatOrNull(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function comparablePath(path) {
  return process.platform === "win32" ? path.toLowerCase() : path;
}

// Validovaný adresář: skutečný adresář (ne symlink) s realpath uvnitř realpath
// rootu; vrací realpath a identitu inode pro ukotvení.
async function validatedDirectory(root, path, label) {
  const entryStat = await lstatOrNull(path);
  if (!entryStat) return null;
  if (entryStat.isSymbolicLink() || !entryStat.isDirectory()) {
    throw new Error(`${label} musí být skutečný adresář, ne symlink nebo junction.`);
  }
  const [rootReal, pathReal] = await Promise.all([realpath(root), realpath(path)]);
  if (!comparablePath(pathReal).startsWith(comparablePath(rootReal) + sep)) {
    throw new Error(`${label} musí ležet uvnitř repozitáře (žádný symlinkovaný předek).`);
  }
  const identity = await stat(pathReal);
  return { realPath: pathReal, dev: identity.dev, ino: identity.ino };
}

// Spustí `work` s cwd ukotveným na validovaný adresář; cesty uvnitř jsou
// relativní k němu. Sekce se v procesu nikdy nepřekrývají a cwd se po skončení
// obnoví.
let anchorQueue = Promise.resolve();
function anchored(directory, label, work) {
  const run = anchorQueue.then(async () => {
    const previousCwd = process.cwd();
    process.chdir(directory.realPath);
    try {
      const here = await stat(".");
      if (here.dev !== directory.dev || here.ino !== directory.ino) {
        throw new Error(`${label} se během práce změnil; nic nebylo zapsáno.`);
      }
      return await work();
    } finally {
      process.chdir(previousCwd);
    }
  });
  anchorQueue = run.then(() => undefined, () => undefined);
  return run;
}

// Deterministický rekurzivní sken stromu pod `baseDirectory` (v ukotvené sekci
// relativní k cwd).
// Symlink (na Windows i junction) nebo jiný filesystem typ kdekoli uvnitř jde
// do `unsafe`; adresáře se vrací zvlášť kvůli mazání prázdných.
async function scanTree(baseDirectory, displayPrefix) {
  const files = [];
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
        files.push(relativePath);
      } else {
        unsafe.push({ relativePath, message: `${displayPrefix}/${relativePath} má nepodporovaný filesystem typ.` });
      }
    }
  }
  return { files, directories, unsafe };
}

async function readRegularFile(path) {
  const handle = await open(path, constants.O_RDONLY | O_NOFOLLOW);
  try {
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

// Načte celý strom do paměti: relativní posix cesta → Buffer.
async function readTree(baseDirectory, label) {
  const scan = await scanTree(baseDirectory, label);
  const files = new Map();
  for (const relativePath of scan.files) {
    files.set(relativePath, await readRegularFile(join(baseDirectory, relativePath)));
  }
  return { files, directories: scan.directories, unsafe: scan.unsafe };
}

// Validovaný strom pod `relativeDirectory`; `anchor: true` čte ukotveně z cwd,
// takže záměna předka během čtení nic nepodstrčí (používá jen sync).
async function validatedTree(root, relativeDirectory, label, { anchor = false } = {}) {
  const directory = await validatedDirectory(root, join(root, relativeDirectory), label);
  if (!directory) throw new Error(`${label} musí být skutečný adresář.`);
  return anchor
    ? anchored(directory, label, () => readTree(".", label))
    : readTree(directory.realPath, label);
}

async function canonicalTree(root, options) {
  const tree = await validatedTree(root, CANONICAL_SKILLS_PATH, CANONICAL_SKILLS_PATH, options);
  if (tree.unsafe.length > 0) {
    throw new Error(
      `${CANONICAL_SKILLS_PATH} smí obsahovat jen obyčejné soubory a adresáře: ${tree.unsafe.map((entry) => entry.message).join(" ")}`,
    );
  }
  return tree;
}

// Vrací seznam rozdílů; prázdný seznam znamená bajtově shodný mirror bez
// symlinků. Rozdíly slouží jen pro `--verbose`/testy, veřejná hláška je jedna.
export async function agentSkillsMirrorDifferences(root = process.cwd()) {
  const repositoryRoot = resolve(root);
  let canonical;
  let mirror;
  try {
    canonical = await canonicalTree(repositoryRoot);
    const parent = await validatedDirectory(
      repositoryRoot,
      join(repositoryRoot, dirname(CLAUDE_SKILLS_PATH)),
      dirname(CLAUDE_SKILLS_PATH),
    );
    if (!parent) return [`${CLAUDE_SKILLS_PATH} chybí.`];
    const mirrorStat = await lstatOrNull(join(repositoryRoot, CLAUDE_SKILLS_PATH));
    if (!mirrorStat) return [`${CLAUDE_SKILLS_PATH} chybí.`];
    if (mirrorStat.isSymbolicLink()) return [`${CLAUDE_SKILLS_PATH} je symlink nebo junction.`];
    if (!mirrorStat.isDirectory()) return [`${CLAUDE_SKILLS_PATH} není adresář.`];
    mirror = await validatedTree(repositoryRoot, CLAUDE_SKILLS_PATH, CLAUDE_SKILLS_PATH);
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }
  const differences = mirror.unsafe.map((entry) => entry.message);
  for (const [relativePath, canonicalBytes] of canonical.files) {
    const mirrorBytes = mirror.files.get(relativePath);
    if (!mirrorBytes) differences.push(`${CLAUDE_SKILLS_PATH}/${relativePath} chybí.`);
    else if (!canonicalBytes.equals(mirrorBytes)) {
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
async function removeEntry(path, entryStat) {
  if (entryStat.isSymbolicLink()) {
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

async function ensureRealDirectory(path, label) {
  await mkdir(path, { recursive: true });
  const entryStat = await lstat(path);
  if (entryStat.isSymbolicLink() || !entryStat.isDirectory()) {
    throw new Error(`${label} musí být skutečný adresář, ne symlink nebo junction.`);
  }
}

async function writeRegularFile(path, bytes) {
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | O_NOFOLLOW);
  try {
    await handle.writeFile(bytes);
  } finally {
    await handle.close();
  }
}

export async function syncAgentSkillsMirror(root = process.cwd()) {
  const repositoryRoot = resolve(root);
  const canonical = await canonicalTree(repositoryRoot, { anchor: true });
  const parentPath = join(repositoryRoot, dirname(CLAUDE_SKILLS_PATH));
  const parentLabel = dirname(CLAUDE_SKILLS_PATH);
  if (!(await lstatOrNull(parentPath))) await mkdir(parentPath);
  const parent = await validatedDirectory(repositoryRoot, parentPath, parentLabel);
  const mirror = "skills";
  const changed = [];

  return anchored(parent, parentLabel, async () => {
    await syncTestHooks.afterParentValidated?.();

    const mirrorStat = await lstatOrNull(mirror);
    if (mirrorStat && (mirrorStat.isSymbolicLink() || !mirrorStat.isDirectory())) {
      await removeEntry(mirror, mirrorStat);
      changed.push(`${CLAUDE_SKILLS_PATH} nahrazen skutečným adresářem.`);
    }
    await ensureRealDirectory(mirror, CLAUDE_SKILLS_PATH);
    const existing = await scanTree(mirror, CLAUDE_SKILLS_PATH);
    const existingFiles = new Set(existing.files);

    // 1. Přebytečné soubory, symlinky a cizí adresáře v cíli pryč.
    for (const relativePath of existing.files) {
      if (canonical.files.has(relativePath)) continue;
      await rm(join(mirror, relativePath), { force: true });
      changed.push(`${CLAUDE_SKILLS_PATH}/${relativePath} smazán.`);
    }
    for (const { relativePath } of existing.unsafe) {
      const path = join(mirror, relativePath);
      await removeEntry(path, await lstat(path));
      changed.push(`${CLAUDE_SKILLS_PATH}/${relativePath} odstraněn (nebyl obyčejný soubor ani adresář).`);
    }
    const canonicalDirectories = new Set(canonical.directories);
    for (const relativePath of [...existing.directories].sort().reverse()) {
      if (canonicalDirectories.has(relativePath)) continue;
      await rm(join(mirror, relativePath), { recursive: true, force: true });
      changed.push(`${CLAUDE_SKILLS_PATH}/${relativePath}/ smazán.`);
    }

    // 2. Adresáře a soubory podle kanonického stromu; zapisuje se jen rozdíl.
    for (const relativePath of canonical.directories) {
      await ensureRealDirectory(join(mirror, relativePath), `${CLAUDE_SKILLS_PATH}/${relativePath}`);
    }
    for (const [relativePath, bytes] of canonical.files) {
      const path = join(mirror, relativePath);
      if (existingFiles.has(relativePath) && bytes.equals(await readRegularFile(path))) continue;
      await writeRegularFile(path, bytes);
      changed.push(`${CLAUDE_SKILLS_PATH}/${relativePath} zapsán.`);
    }
    return { status: "ok", changed };
  });
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
