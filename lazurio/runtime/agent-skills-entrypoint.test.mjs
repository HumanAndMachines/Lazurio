import { afterEach, expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AGENT_SKILLS_MIRROR_MESSAGE,
  checkAgentSkillsMirror,
  syncAgentSkillsMirror,
} from "./agent-skills-entrypoint.mjs";

const scriptPath = fileURLToPath(new URL("./agent-skills-entrypoint.mjs", import.meta.url));
const tempRoots = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(name) {
  const root = await mkdtemp(join(tmpdir(), `agent-skills-${name}-`));
  tempRoots.push(root);
  await mkdir(join(root, ".agents", "skills", "example-skill", "references"), { recursive: true });
  await writeFile(join(root, ".agents", "skills", "example-skill", "SKILL.md"), "# example-skill\n");
  await writeFile(join(root, ".agents", "skills", "example-skill", "references", "data.yaml"), "key: value\n");
  await writeFile(join(root, ".agents", "skills", "manifest.json"), "{\"skills\":[]}\n");
  return root;
}

// Windows directory junction nevyžaduje Developer Mode; na POSIX je to symlink.
async function linkDirectory(target, linkPath) {
  await symlink(target, linkPath, process.platform === "win32" ? "junction" : "dir");
}

async function tree(directory, prefix = "") {
  const entries = await readdir(directory, { withFileTypes: true });
  const result = {};
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) result[relativePath] = "<symlink>";
    else if (entry.isDirectory()) Object.assign(result, await tree(join(directory, entry.name), relativePath));
    else result[relativePath] = await readFile(join(directory, entry.name), "utf8");
  }
  return result;
}

async function expectMirrorEqualsCanonical(root) {
  expect(await tree(join(root, ".claude", "skills"))).toEqual(await tree(join(root, ".agents", "skills")));
  expect(await checkAgentSkillsMirror(root)).toMatchObject({ status: "ok", differences: [] });
}

test("sync vytvoří bajtově shodnou kopii a je idempotentní", async () => {
  const root = await fixture("sync");
  expect(await checkAgentSkillsMirror(root)).toMatchObject({
    status: "repair_needed",
    message: AGENT_SKILLS_MIRROR_MESSAGE,
  });

  const first = await syncAgentSkillsMirror(root);
  expect(first.changed.length).toBeGreaterThan(0);
  await expectMirrorEqualsCanonical(root);

  const second = await syncAgentSkillsMirror(root);
  expect(second.changed).toEqual([]);
  await expectMirrorEqualsCanonical(root);
});

test("check hlásí přidaný, změněný i smazaný soubor a cizí adresář jedinou hláškou; sync je opraví", async () => {
  const root = await fixture("drift");
  await syncAgentSkillsMirror(root);
  const mirror = join(root, ".claude", "skills");

  const scenarios = [
    ["přidaný soubor", () => writeFile(join(mirror, "example-skill", "notes.md"), "lokální\n")],
    ["změněný soubor", () => writeFile(join(mirror, "example-skill", "SKILL.md"), "# stale\n")],
    ["smazaný soubor", () => rm(join(mirror, "example-skill", "references", "data.yaml"))],
    ["smazaný adresář", () => rm(join(mirror, "example-skill", "references"), { recursive: true })],
    ["cizí adresář", async () => {
      await mkdir(join(mirror, "removed-skill"), { recursive: true });
      await writeFile(join(mirror, "removed-skill", "SKILL.md"), "# removed\n");
    }],
    ["prázdný cizí adresář", () => mkdir(join(mirror, "scratch"), { recursive: true })],
    ["soubor místo adresáře", async () => {
      await rm(join(mirror, "example-skill", "references"), { recursive: true });
      await writeFile(join(mirror, "example-skill", "references"), "soubor\n");
    }],
  ];
  for (const [label, mutate] of scenarios) {
    await mutate();
    const state = await checkAgentSkillsMirror(root);
    expect(state.status, label).toBe("repair_needed");
    expect(state.message, label).toBe(AGENT_SKILLS_MIRROR_MESSAGE);
    expect(state.differences.length, label).toBeGreaterThan(0);
    await syncAgentSkillsMirror(root);
    await expectMirrorEqualsCanonical(root);
  }
});

test("změna kanonického katalogu je drift, dokud sync mirror nepřepíše", async () => {
  const root = await fixture("canonical-change");
  await syncAgentSkillsMirror(root);
  await writeFile(join(root, ".agents", "skills", "example-skill", "SKILL.md"), "# updated\n");
  await mkdir(join(root, ".agents", "skills", "new-skill"), { recursive: true });
  await writeFile(join(root, ".agents", "skills", "new-skill", "SKILL.md"), "# new\n");
  await rm(join(root, ".agents", "skills", "example-skill", "references"), { recursive: true });

  expect((await checkAgentSkillsMirror(root)).status).toBe("repair_needed");
  await syncAgentSkillsMirror(root);
  await expectMirrorEqualsCanonical(root);
  expect(await readFile(join(root, ".claude", "skills", "new-skill", "SKILL.md"), "utf8")).toBe("# new\n");
});

test("symlink nebo junction .claude/skills → check selže, sync ho nahradí adresářem a zdroj zachová", async () => {
  const root = await fixture("legacy-link");
  await mkdir(join(root, ".claude"), { recursive: true });
  await linkDirectory(join(root, ".agents", "skills"), join(root, ".claude", "skills"));

  const before = await checkAgentSkillsMirror(root);
  expect(before.status).toBe("repair_needed");
  expect(before.message).toBe(AGENT_SKILLS_MIRROR_MESSAGE);
  expect(before.differences).toEqual([".claude/skills je symlink nebo junction."]);

  await syncAgentSkillsMirror(root);
  expect((await lstat(join(root, ".claude", "skills"))).isSymbolicLink()).toBe(false);
  expect((await lstat(join(root, ".claude", "skills"))).isDirectory()).toBe(true);
  await expectMirrorEqualsCanonical(root);
  expect(await readFile(join(root, ".agents", "skills", "example-skill", "SKILL.md"), "utf8")).toBe("# example-skill\n");
});

test("junction uvnitř mirroru je drift; sync ho odstraní bez zásahu do cíle", async () => {
  const root = await fixture("inner-link");
  await syncAgentSkillsMirror(root);
  const outside = await mkdtemp(join(tmpdir(), "agent-skills-outside-"));
  tempRoots.push(outside);
  await writeFile(join(outside, "secret.md"), "tajné\n");
  await linkDirectory(outside, join(root, ".claude", "skills", "example-skill", "linked"));

  const state = await checkAgentSkillsMirror(root);
  expect(state.status).toBe("repair_needed");
  expect(state.differences).toEqual([".claude/skills/example-skill/linked je symlink nebo junction."]);

  await syncAgentSkillsMirror(root);
  await expectMirrorEqualsCanonical(root);
  expect(await readFile(join(outside, "secret.md"), "utf8")).toBe("tajné\n");
});

test("symlink souboru v mirroru je drift a sync ho nahradí obyčejným souborem", async () => {
  const root = await fixture("file-link");
  await syncAgentSkillsMirror(root);
  const linkPath = join(root, ".claude", "skills", "example-skill", "SKILL.md");
  await rm(linkPath);
  try {
    await symlink(join(root, ".agents", "skills", "example-skill", "SKILL.md"), linkPath, "file");
  } catch (error) {
    if (error?.code === "EPERM") return; // Windows bez Developer Mode
    throw error;
  }

  expect((await checkAgentSkillsMirror(root)).status).toBe("repair_needed");
  await syncAgentSkillsMirror(root);
  expect((await lstat(linkPath)).isSymbolicLink()).toBe(false);
  await expectMirrorEqualsCanonical(root);
});

test("symlinkovaný .claude parent nikdy nedostane zápis", async () => {
  const root = await fixture("parent-link");
  const outside = await mkdtemp(join(tmpdir(), "agent-skills-parent-outside-"));
  tempRoots.push(outside);
  await linkDirectory(outside, join(root, ".claude"));

  expect((await checkAgentSkillsMirror(root)).status).toBe("repair_needed");
  await expect(syncAgentSkillsMirror(root)).rejects.toThrow(".claude musí být skutečný adresář");
  expect(await readdir(outside)).toEqual([]);
});

test("chybějící nebo symlinkovaný .agents/skills: check selže a sync nic nemaže", async () => {
  const root = await fixture("canonical-missing");
  await syncAgentSkillsMirror(root);
  await rm(join(root, ".agents", "skills"), { recursive: true });

  expect((await checkAgentSkillsMirror(root)).status).toBe("repair_needed");
  await expect(syncAgentSkillsMirror(root)).rejects.toThrow(".agents/skills musí být skutečný adresář");
  expect(await readFile(join(root, ".claude", "skills", "example-skill", "SKILL.md"), "utf8")).toBe("# example-skill\n");
});

test("gitignored OS junk není drift", async () => {
  const root = await fixture("os-junk");
  await syncAgentSkillsMirror(root);
  await writeFile(join(root, ".claude", "skills", ".DS_Store"), "junk");
  await writeFile(join(root, ".agents", "skills", "example-skill", "Thumbs.db"), "junk");

  expect((await checkAgentSkillsMirror(root)).status).toBe("ok");
  expect((await syncAgentSkillsMirror(root)).changed).toEqual([]);
  expect(await readFile(join(root, ".claude", "skills", ".DS_Store"), "utf8")).toBe("junk");
});

test("CLI: check failuje jedinou hláškou, sync opraví, check projde", async () => {
  const root = await fixture("cli");
  const run = (command) => {
    const result = Bun.spawnSync({ cmd: ["bun", scriptPath, command], cwd: root, stdout: "pipe", stderr: "pipe" });
    return { exitCode: result.exitCode, stdout: new TextDecoder().decode(result.stdout) };
  };

  const failing = run("check");
  expect(failing.exitCode).toBe(1);
  expect(failing.stdout).toContain(AGENT_SKILLS_MIRROR_MESSAGE);

  expect(run("sync").exitCode).toBe(0);
  const passing = run("check");
  expect(passing.exitCode).toBe(0);
  expect(passing.stdout).toContain("ok - agent-skills");
  await expectMirrorEqualsCanonical(root);

  expect(run("repair").exitCode).toBe(2);
});
