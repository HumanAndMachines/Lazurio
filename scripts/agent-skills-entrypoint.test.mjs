import { afterEach, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkAgentSkillsMirror,
  repairAgentSkillsMirror,
  trustedGitExecutable,
} from "./agent-skills-entrypoint.mjs";
import { supportsFileSymlinks } from "./test-platform-capabilities.mjs";

const tempRoots = [];

const fileSymlinkTest = (await supportsFileSymlinks()) ? test : test.skip;

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function git(root, args) {
  const result = Bun.spawnSync({ cmd: ["git", ...args], cwd: root, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} selhalo: ${new TextDecoder().decode(result.stderr)}`);
  }
}

async function rootFixture(name, { slugs = ["example-skill"] } = {}) {
  const root = await mkdtemp(join(tmpdir(), `agent-skills-mirror-${name}-`));
  tempRoots.push(root);
  git(root, ["init", "--quiet"]);
  for (const slug of slugs) {
    await mkdir(join(root, ".agents", "skills", slug), { recursive: true });
    await writeFile(join(root, ".agents", "skills", slug, "SKILL.md"), `# ${slug}\n`);
  }
  await writeFile(
    join(root, ".agents", "skills", "manifest.json"),
    JSON.stringify({
      schema_version: "conglomerate.skills.v0",
      claude_compatibility: "tracked-derived-mirror",
      skills: slugs.map((slug) => ({ slug, path: `.agents/skills/${slug}/SKILL.md` })),
    }),
  );
  return root;
}

async function materializeFixtureMirror(root) {
  const manifest = JSON.parse(await readFile(join(root, ".agents", "skills", "manifest.json"), "utf8"));
  for (const { slug } of manifest.skills) {
    await cp(
      join(root, ".agents", "skills", slug),
      join(root, ".claude", "skills", slug),
      { recursive: true },
    );
  }
  git(root, ["add", ".agents", ".claude"]);
}

test("čerstvý checkout: repair diagnostikuje chybějící mirror bez zápisu", async () => {
  const root = await rootFixture("fresh");

  const before = await checkAgentSkillsMirror(root);
  expect(before.status).toBe("repair_needed");
  expect(before.code).toBe("mirror_missing");

  const after = await repairAgentSkillsMirror(root);
  expect(after.status).toBe("blocked");
  expect(after.code).toBe("manual_repair_required");
  await expect(
    readFile(join(root, ".claude", "skills", "example-skill", "SKILL.md")),
  ).rejects.toThrow();
});

test("legacy symlink: repair zachová link i kanonický cíl", async () => {
  const root = await rootFixture("legacy");
  await mkdir(join(root, ".claude"), { recursive: true });
  await symlink(join(root, ".agents", "skills"), join(root, ".claude", "skills"), "junction");

  const before = await checkAgentSkillsMirror(root);
  expect(before.code).toBe("mirror_legacy_link");

  const after = await repairAgentSkillsMirror(root);
  expect(after.status).toBe("blocked");
  expect(after.code).toBe("manual_repair_required");
  const canonical = await readFile(join(root, ".agents", "skills", "example-skill", "SKILL.md"), "utf8");
  expect(canonical).toBe("# example-skill\n");
});

test("drift mirroru: repair zachová obsah a vyžádá reviewovanou změnu", async () => {
  const root = await rootFixture("drift");
  await materializeFixtureMirror(root);
  await writeFile(join(root, ".claude", "skills", "example-skill", "SKILL.md"), "# stale\n");
  await mkdir(join(root, ".claude", "skills", "removed-skill"), { recursive: true });
  await writeFile(join(root, ".claude", "skills", "removed-skill", "SKILL.md"), "# removed\n");

  const before = await checkAgentSkillsMirror(root);
  expect(before.code).toBe("mirror_drift");

  const after = await repairAgentSkillsMirror(root);
  expect(after.status).toBe("blocked");
  expect(after.code).toBe("manual_repair_required");
  const mirror = await readFile(join(root, ".claude", "skills", "example-skill", "SKILL.md"), "utf8");
  expect(mirror).toBe("# stale\n");
  expect(await readFile(join(root, ".claude", "skills", "removed-skill", "SKILL.md"), "utf8"))
    .toBe("# removed\n");
});

test("extra soubor v aktivním skill adresáři: repair failuje zavřeně a soubor přežije", async () => {
  const root = await rootFixture("active-extra");
  await materializeFixtureMirror(root);
  await writeFile(join(root, ".claude", "skills", "example-skill", "notes.md"), "lokální poznámky\n");

  const result = await repairAgentSkillsMirror(root);
  expect(result.status).toBe("blocked");
  expect(result.code).toBe("manual_repair_required");
  const survived = await readFile(join(root, ".claude", "skills", "example-skill", "notes.md"), "utf8");
  expect(survived).toBe("lokální poznámky\n");

});

test("stray soubor přímo v mirroru: repair failuje zavřeně a soubor přežije", async () => {
  const root = await rootFixture("stray-file");
  await mkdir(join(root, ".claude", "skills"), { recursive: true });
  await writeFile(join(root, ".claude", "skills", "README.txt"), "stray\n");

  const result = await repairAgentSkillsMirror(root);
  expect(result.status).toBe("blocked");
  expect(result.code).toBe("manual_repair_required");
  const survived = await readFile(join(root, ".claude", "skills", "README.txt"), "utf8");
  expect(survived).toBe("stray\n");
});

test("neznámý obsah mirroru: repair failuje zavřeně a nic nemaže", async () => {
  const root = await rootFixture("unknown");
  await mkdir(join(root, ".claude", "skills", "scratch"), { recursive: true });
  await writeFile(join(root, ".claude", "skills", "scratch", "notes.md"), "moje poznámky\n");

  const result = await repairAgentSkillsMirror(root);
  expect(result.status).toBe("blocked");
  expect(result.code).toBe("manual_repair_required");
  const survived = await readFile(join(root, ".claude", "skills", "scratch", "notes.md"), "utf8");
  expect(survived).toBe("moje poznámky\n");
});

test("gitignored .claude/skills blokuje repair před zápisem", async () => {
  const root = await rootFixture("ignored");
  await writeFile(join(root, ".gitignore"), ".claude/skills\n");

  const result = await repairAgentSkillsMirror(root);
  expect(result.status).toBe("blocked");
  expect(result.code).toBe("entrypoint_contract_invalid");
  expect(result.problems.join(" ")).toContain(".gitignore");
  await expect(readFile(join(root, ".claude", "skills"))).rejects.toThrow();
});

test("slug s traversal cestou v manifestu je blocked manifest_invalid", async () => {
  const root = await rootFixture("traversal");
  await writeFile(
    join(root, ".agents", "skills", "manifest.json"),
    JSON.stringify({
      schema_version: "conglomerate.skills.v0",
      claude_compatibility: "tracked-derived-mirror",
      skills: [{ slug: "../../evil", path: ".agents/skills/../../evil/SKILL.md" }],
    }),
  );

  const state = await checkAgentSkillsMirror(root);
  expect(state.status).toBe("blocked");
  expect(state.code).toBe("manifest_invalid");
});

fileSymlinkTest("symlink v kanonickém katalogu: repair failuje zavřeně a nic nekopíruje [requires file symlink capability]", async () => {
  const root = await rootFixture("canonical-symlink");
  const outside = await mkdtemp(join(tmpdir(), "canonical-outside-"));
  tempRoots.push(outside);
  await writeFile(join(outside, "secret.md"), "tajný obsah\n");
  await rm(join(root, ".agents", "skills", "example-skill", "SKILL.md"));
  await symlink(
    join(outside, "secret.md"),
    join(root, ".agents", "skills", "example-skill", "SKILL.md"),
    "file",
  );

  const state = await repairAgentSkillsMirror(root);
  expect(state.status).toBe("blocked");
  expect(state.code).toBe("canonical_unsafe_content");
});

test("mirror mimo Git index vyžaduje explicitní Git-reviewovanou opravu", async () => {
  const root = await rootFixture("untracked");
  await materializeFixtureMirror(root);

  const rmCached = Bun.spawnSync({
    cmd: ["git", "rm", "--cached", "--quiet", ".claude/skills/example-skill/SKILL.md"],
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(rmCached.exitCode).toBe(0);

  const before = await checkAgentSkillsMirror(root);
  expect(before.status).toBe("repair_needed");
  expect(before.code).toBe("mirror_untracked");

  const after = await repairAgentSkillsMirror(root);
  expect(after.status).toBe("blocked");
  expect(after.code).toBe("manual_repair_required");
});

test("gitignored OS junk (.DS_Store) v mirroru není drift ani blocker", async () => {
  const root = await rootFixture("os-junk");
  await materializeFixtureMirror(root);
  expect((await checkAgentSkillsMirror(root)).status).toBe("ok");

  await writeFile(join(root, ".claude", "skills", ".DS_Store"), "junk");
  await writeFile(join(root, ".claude", "skills", "example-skill", ".DS_Store"), "junk");

  const check = await checkAgentSkillsMirror(root);
  expect(check.status).toBe("ok");
  expect(check.code).toBe("mirror_ready");

  const repair = await repairAgentSkillsMirror(root);
  expect(repair.status).toBe("ok");
  const survived = await readFile(join(root, ".claude", "skills", ".DS_Store"), "utf8");
  expect(survived).toBe("junk");
});

test("Git kontrakt: toplevel guard nezaměňuje index nadřazeného repozitáře", async () => {
  const parent = await mkdtemp(join(tmpdir(), "agent-skills-parent-"));
  tempRoots.push(parent);
  git(parent, ["init", "--quiet"]);
  const nested = join(parent, "nested-root");
  await mkdir(join(nested, ".agents", "skills", "example-skill"), { recursive: true });
  await writeFile(join(nested, ".agents", "skills", "example-skill", "SKILL.md"), "# example-skill\n");
  await writeFile(
    join(nested, ".agents", "skills", "manifest.json"),
    JSON.stringify({
      schema_version: "conglomerate.skills.v0",
      claude_compatibility: "tracked-derived-mirror",
      skills: [{ slug: "example-skill", path: ".agents/skills/example-skill/SKILL.md" }],
    }),
  );

  const state = await checkAgentSkillsMirror(nested);
  expect(state.status).toBe("blocked");
  expect(state.code).toBe("entrypoint_contract_invalid");
  expect(state.problems.join(" ")).toContain("nadřazeného repozitáře");
});


test("resolution kandidátů najde na hostitelské platformě skutečný git", () => {
  // Běží v CI na Windows i Linuxu, takže pokrývá realpath+stat větev
  // discovery přesně tam, kde ji používá povinný doctor:agent-skills.
  const resolved = trustedGitExecutable();
  expect(typeof resolved).toBe("string");
  expect(isAbsolute(resolved)).toBe(true);

});

test("tracked mirror přijme celý adresář skillu včetně references (CAC-0085)", async () => {
  const root = await rootFixture("full-repair");
  await mkdir(join(root, ".agents", "skills", "example-skill", "references"), { recursive: true });
  await writeFile(
    join(root, ".agents", "skills", "example-skill", "references", "data.yaml"),
    "key: value\n",
  );

  await materializeFixtureMirror(root);
  const after = await checkAgentSkillsMirror(root);
  expect(after.status).toBe("ok");
  const mirrored = await readFile(
    join(root, ".claude", "skills", "example-skill", "references", "data.yaml"),
    "utf8",
  );
  expect(mirrored).toBe("key: value\n");
});

test("smazaný kanonický soubor: repair zachová tracked artefakt pro review", async () => {
  const root = await rootFixture("full-stale");
  await mkdir(join(root, ".agents", "skills", "example-skill", "references"), { recursive: true });
  await writeFile(
    join(root, ".agents", "skills", "example-skill", "references", "data.yaml"),
    "key: value\n",
  );
  await materializeFixtureMirror(root);
  expect((await checkAgentSkillsMirror(root)).status).toBe("ok");

  await rm(join(root, ".agents", "skills", "example-skill", "references", "data.yaml"));
  const before = await checkAgentSkillsMirror(root);
  expect(before.status).toBe("repair_needed");
  expect(before.code).toBe("mirror_drift");

  const after = await repairAgentSkillsMirror(root);
  expect(after.status).toBe("blocked");
  expect(after.code).toBe("manual_repair_required");
  expect(await readFile(
    join(root, ".claude", "skills", "example-skill", "references", "data.yaml"),
    "utf8",
  )).toBe("key: value\n");
});

test("repair odmítne nečitelný Git index ještě před zápisem", async () => {
  const root = await rootFixture("missing-git");
  await rm(join(root, ".git"), { recursive: true, force: true });

  const result = await repairAgentSkillsMirror(root);
  expect(result.status).toBe("blocked");
  expect(result.code).toBe("entrypoint_contract_invalid");
  await expect(
    readFile(join(root, ".claude", "skills", "example-skill", "SKILL.md")),
  ).rejects.toThrow();
});

test("agent-skills repair implementace nemá filesystem writer", async () => {
  const source = await readFile(new URL("./agent-skills-entrypoint.mjs", import.meta.url), "utf8");
  expect(source).not.toMatch(/\b(?:mkdir|rename|rm|unlink|writeFile)\s*\(/u);
});
