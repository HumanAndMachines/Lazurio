import { lstat } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  CANONICAL_SKILLS_PATH,
  CLAUDE_SKILLS_PATH,
  checkAgentSkillsMirror,
} from "./agent-skills-entrypoint.mjs";

// Read-only Doctor surface nad agent-skills entrypointem (rozhodnutí
// Principála 2026-09-08, nahrazuje repair lane z decision 0104). Jediný
// kontrakt: `.claude/skills` je Git-tracked bajtově shodná kopie
// `.agents/skills` bez symlinků → `ok`; jinak `repair_needed` s jedinou
// hláškou „spusť `bun run skills:sync`“. Algoritmus vlastní
// `agent-skills-entrypoint.mjs`; Doctor ho jen volá nad rootem a mounty a
// nikdy nespouští kód Organizace ani nic nezapisuje.

async function exists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

export async function inspectAgentSkillsEntrypoint(repositoryRoot) {
  const root = resolve(repositoryRoot);
  const [canonicalPresent, mirrorPresent] = await Promise.all([
    exists(join(root, CANONICAL_SKILLS_PATH)),
    exists(join(root, CLAUDE_SKILLS_PATH)),
  ]);
  if (!canonicalPresent && !mirrorPresent) {
    return {
      status: "not_applicable",
      message: "Repozitář nemá agent-skills katalog.",
    };
  }
  const { status, message } = await checkAgentSkillsMirror(root);
  return { status, message };
}

export async function agentSkillsEntrypointsDoctorCheck({
  companiesRoot,
  mounts = [],
  includeRoot = true,
}) {
  const targets = [
    ...(includeRoot ? [{ path: ".", label: "root" }] : []),
    ...mounts.filter((mount) => mount?.path && mount.status !== "planned"),
  ];
  const inspected = await Promise.all(
    targets.map(async (mount) => {
      try {
        return { mount, state: await inspectAgentSkillsEntrypoint(join(companiesRoot, mount.path)) };
      } catch (error) {
        return {
          mount,
          state: { status: "repair_needed", message: `Filesystem kontrola selhala: ${error.message}` },
        };
      }
    }),
  );
  const applicable = inspected.filter((item) => item.state.status !== "not_applicable");
  const repairNeeded = applicable.filter((item) => item.state.status === "repair_needed");
  // „Žádný checkout katalog nemá" je FAKT o mountech, ne nezměřená kontrola —
  // proto `not_applicable` (společný surface doctorů, decision 0118).
  const status = repairNeeded.length > 0
    ? "warn"
    : applicable.length > 0
      ? "ok"
      : "not_applicable";

  return {
    id: "launchpad.agent_skills_entrypoints",
    status,
    severity: "local-state",
    title: "Agent skills entrypointy",
    message:
      status === "warn"
        ? `${repairNeeded.length} z ${applicable.length} checkoutů: ${CLAUDE_SKILLS_PATH} neodpovídá ${CANONICAL_SKILLS_PATH}; v daném repu spusť bun run skills:sync a změnu commitni.`
        : status === "ok"
          ? `${applicable.length} checkoutů drží ${CLAUDE_SKILLS_PATH} jako bajtově shodnou kopii ${CANONICAL_SKILLS_PATH}.`
          : "Žádný checkout nemá agent-skills katalog.",
    paths: [
      CANONICAL_SKILLS_PATH,
      CLAUDE_SKILLS_PATH,
      `organizations/*/${CANONICAL_SKILLS_PATH}`,
      `organizations/*/${CLAUDE_SKILLS_PATH}`,
    ],
    links: [],
    details: applicable.map(({ mount, state }) =>
      `${mount.label ?? mount.path}: ${state.status} — ${state.message}`),
    ...(status === "not_applicable"
      ? {
        not_applicable_reason: "not_declared",
        owner: "namountované checkouty (katalog deklaruje mount, ne sdílený root)",
      }
      : {}),
  };
}
