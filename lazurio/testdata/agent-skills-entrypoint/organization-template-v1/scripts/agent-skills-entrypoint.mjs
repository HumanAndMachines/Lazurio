import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const AGENT_SKILLS_ENTRYPOINT_SCHEMA =
  "companiesascode.agent_skills_entrypoint.v1";
export const CANONICAL_SKILLS_PATH = ".agents/skills";
export const CLAUDE_SKILLS_PATH = ".claude/skills";
export const CLAUDE_SKILLS_MATERIALIZATION = "operator-managed-link";

const LEGACY_PLACEHOLDER = "../.agents/skills";
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
  const normalized = resolve(path).replaceAll("\\", "/").replace(/\/+$/, "");
  return platform === "win32" ? normalized.toLowerCase() : normalized;
}

function pathIsInside(root, target) {
  const relativePath = relative(root, target);
  return (
    relativePath === "" ||
    (!isAbsolute(relativePath) &&
      relativePath !== ".." &&
      !relativePath.startsWith("../") &&
      !relativePath.startsWith("..\\"))
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

export async function inspectAgentSkillsEntrypoint(
  root = process.cwd(),
  { platform = process.platform } = {},
) {
  const organizationRoot = resolve(root);
  const canonicalPath = join(organizationRoot, CANONICAL_SKILLS_PATH);
  const compatibilityPath = join(organizationRoot, CLAUDE_SKILLS_PATH);
  const compatibilityParent = dirname(compatibilityPath);

  const [canonicalStat, compatibilityStat, compatibilityParentStat] =
    await Promise.all([
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

  const [rootRealPath, canonicalRealPath] = await Promise.all([
    realpath(organizationRoot),
    realpath(canonicalPath),
  ]);
  if (!pathIsInside(rootRealPath, canonicalRealPath)) {
    return publicState({
      status: "blocked",
      code: "canonical_path_escape",
      problems: [`${CANONICAL_SKILLS_PATH} se dostává mimo root Organizace.`],
      message: "Kanonický agent-skills katalog není bezpečný.",
    });
  }

  if (
    compatibilityParentStat &&
    (!compatibilityParentStat.isDirectory() ||
      compatibilityParentStat.isSymbolicLink())
  ) {
    return publicState({
      status: "blocked",
      code: "entrypoint_parent_invalid",
      problems: [".claude musí být skutečný adresář uvnitř rootu Organizace."],
      message: "Claude compatibility entrypoint nemá bezpečný lokální parent.",
    });
  }

  if (compatibilityParentStat) {
    const parentRealPath = await realpath(compatibilityParent);
    if (!pathIsInside(rootRealPath, parentRealPath)) {
      return publicState({
        status: "blocked",
        code: "entrypoint_parent_escape",
        problems: [".claude se dostává mimo root Organizace."],
        message: "Claude compatibility entrypoint nemá bezpečný lokální parent.",
      });
    }
  }

  if (!compatibilityStat) {
    return publicState({
      status: "repair_needed",
      code: "entrypoint_missing",
      message: `${CLAUDE_SKILLS_PATH} chybí; vyžaduje ověřenou ruční materializaci Organization operátorem.`,
    });
  }

  if (compatibilityStat.isSymbolicLink()) {
    try {
      const compatibilityRealPath = await realpath(compatibilityPath);
      if (
        comparablePath(compatibilityRealPath, platform) ===
        comparablePath(canonicalRealPath, platform)
      ) {
        return publicState({
          status: "ok",
          code: "entrypoint_ready",
          message: `${CLAUDE_SKILLS_PATH} odkazuje na ${CANONICAL_SKILLS_PATH}.`,
        });
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    return publicState({
      status: "repair_needed",
      code: "entrypoint_wrong_link",
      message: `${CLAUDE_SKILLS_PATH} nemíří na ${CANONICAL_SKILLS_PATH}.`,
    });
  }

  if (compatibilityStat.isFile()) {
    const contents = (await readFile(compatibilityPath, "utf8"))
      .replace(/^\uFEFF/, "")
      .trim();
    if (contents === LEGACY_PLACEHOLDER) {
      return publicState({
        status: "repair_needed",
        code: "entrypoint_legacy_placeholder",
        message: `${CLAUDE_SKILLS_PATH} je textový placeholder z Windows checkoutu.`,
      });
    }
    return publicState({
      status: "blocked",
      code: "entrypoint_unexpected_file",
      problems: [`${CLAUDE_SKILLS_PATH} je neznámý soubor; Repair ho nesmaže.`],
      message: "Claude compatibility entrypoint nelze bezpečně opravit automaticky.",
    });
  }

  return publicState({
    status: "blocked",
    code: compatibilityStat.isDirectory()
      ? "entrypoint_duplicate_directory"
      : "entrypoint_unknown_type",
    problems: [
      compatibilityStat.isDirectory()
        ? `${CLAUDE_SKILLS_PATH} je samostatný adresář a druhý source of truth; Repair ho nesmaže.`
        : `${CLAUDE_SKILLS_PATH} má nepodporovaný filesystem typ.`,
    ],
    message: "Claude compatibility entrypoint nelze bezpečně opravit automaticky.",
  });
}

export async function repairAgentSkillsEntrypoint(root = process.cwd(), options = {}) {
  const before = await inspectAgentSkillsEntrypoint(resolve(root), options);
  if (before.status === "ok" || before.status === "blocked") return before;

  return publicState({
    status: "blocked",
    code: "entrypoint_manual_repair_required",
    problems: [
      `${CLAUDE_SKILLS_PATH} vyžaduje ruční lokální materializaci mimo Git; automatický Repair nic nevytváří, nemaže ani nepřepisuje.`,
    ],
    message: "Claude compatibility entrypoint vyžaduje ruční bezpečnou materializaci.",
  });
}

function printState(state, json) {
  if (json) {
    console.log(JSON.stringify(state, null, 2));
    return;
  }
  const label =
    state.status === "ok"
      ? "ok"
      : state.status === "repair_needed"
        ? "repair"
        : "fail";
  console.log(`${label} - agent-skills-entrypoint: ${state.message}`);
  for (const problem of state.problems) console.log(`  - ${problem}`);
}

async function main() {
  const [command = "check", ...args] = process.argv.slice(2);
  const json = args.includes("--json");
  if (!["check", "repair"].includes(command)) {
    throw new Error("Použití: agent-skills-entrypoint.mjs <check|repair> [--json].");
  }
  const state =
    command === "repair"
      ? await repairAgentSkillsEntrypoint(defaultRoot)
      : await inspectAgentSkillsEntrypoint(defaultRoot);
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
      message: "Kontrola nebo oprava agent-skills entrypointu selhala.",
    });
    printState(state, process.argv.includes("--json"));
    process.exitCode = 1;
  }
}
