import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENT_SKILLS_MIRROR_MESSAGE, syncAgentSkillsMirror } from "./agent-skills-entrypoint.mjs";
import {
  agentSkillsEntrypointsDoctorCheck,
  inspectAgentSkillsEntrypoint,
} from "./agent-skills-doctor-lib.mjs";

const tempRoots = [];
const mounts = [{ path: "organizations/Example_GEN3", status: "mounted" }];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function companiesFixture(name) {
  const companiesRoot = await mkdtemp(join(tmpdir(), `agent-skills-doctor-${name}-`));
  tempRoots.push(companiesRoot);
  return { companiesRoot, organizationRoot: join(companiesRoot, "organizations", "Example_GEN3") };
}

async function writeSkill(root, slug, contents = `# ${slug}\n`) {
  await mkdir(join(root, ".agents", "skills", slug), { recursive: true });
  await writeFile(join(root, ".agents", "skills", slug, "SKILL.md"), contents);
}

test("checkout bez katalogu je not_applicable, ne fail", async () => {
  const { companiesRoot, organizationRoot } = await companiesFixture("none");
  await mkdir(organizationRoot, { recursive: true });

  expect(await inspectAgentSkillsEntrypoint(organizationRoot)).toMatchObject({ status: "not_applicable" });
  const check = await agentSkillsEntrypointsDoctorCheck({ companiesRoot, includeRoot: false, mounts });
  expect(check.status).toBe("not_applicable");
  expect(check.not_applicable_reason).toBe("not_declared");
});

test("bajtově shodný mirror je ok pro root i mount", async () => {
  const { companiesRoot, organizationRoot } = await companiesFixture("ok");
  await writeSkill(companiesRoot, "root-skill");
  await syncAgentSkillsMirror(companiesRoot);
  await writeSkill(organizationRoot, "example-skill");
  await syncAgentSkillsMirror(organizationRoot);

  const check = await agentSkillsEntrypointsDoctorCheck({ companiesRoot, mounts });
  expect(check.status).toBe("ok");
  expect(check.id).toBe("launchpad.agent_skills_entrypoints");
  expect(check.details).toHaveLength(2);
  expect(check.details[0]).toStartWith("root: ok");
  expect(check.details[1]).toStartWith("organizations/Example_GEN3: ok");
});

test("chybějící, driftující i symlinkovaný mirror je jeden warn s jedinou remedy", async () => {
  const { companiesRoot, organizationRoot } = await companiesFixture("warn");
  await writeSkill(organizationRoot, "example-skill");

  const missing = await agentSkillsEntrypointsDoctorCheck({ companiesRoot, includeRoot: false, mounts });
  expect(missing.status).toBe("warn");
  expect(missing.details[0]).toBe(`organizations/Example_GEN3: repair_needed — ${AGENT_SKILLS_MIRROR_MESSAGE}`);
  expect(missing.message).toContain("bun run skills:sync");

  await syncAgentSkillsMirror(organizationRoot);
  await writeFile(join(organizationRoot, ".claude", "skills", "example-skill", "SKILL.md"), "# stale\n");
  const drift = await agentSkillsEntrypointsDoctorCheck({ companiesRoot, includeRoot: false, mounts });
  expect(drift.status).toBe("warn");
  expect(drift.details[0]).toContain(AGENT_SKILLS_MIRROR_MESSAGE);

  await rm(join(organizationRoot, ".claude", "skills"), { recursive: true });
  await symlink(
    join(organizationRoot, ".agents", "skills"),
    join(organizationRoot, ".claude", "skills"),
    process.platform === "win32" ? "junction" : "dir",
  );
  const linked = await agentSkillsEntrypointsDoctorCheck({ companiesRoot, includeRoot: false, mounts });
  expect(linked.status).toBe("warn");
  expect(linked.details[0]).toContain(AGENT_SKILLS_MIRROR_MESSAGE);
});

test("Doctor nespouští Organization skript a plánované mounty přeskočí", async () => {
  const { companiesRoot, organizationRoot } = await companiesFixture("no-exec");
  await writeSkill(organizationRoot, "example-skill");
  await mkdir(join(organizationRoot, "scripts"), { recursive: true });
  await writeFile(
    join(organizationRoot, "scripts", "agent-skills-entrypoint.mjs"),
    "throw new Error('Doctor nesmí spustit Organization kód');\n",
  );

  const check = await agentSkillsEntrypointsDoctorCheck({
    companiesRoot,
    includeRoot: false,
    mounts: [...mounts, { path: "organizations/Planned_GEN3", status: "planned" }],
  });
  expect(check.status).toBe("warn");
  expect(check.details).toHaveLength(1);
});
