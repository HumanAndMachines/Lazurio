// Integrační test HumanAndMachines/Lazurio#245: fresh checkout Organization
// rootu (skutečný `git clone` fixture repa) prochází Lazurio root Doctorem
// i Organization Doctorem a oba vrací kódy podle strojové matice
// agent-skills-entrypoint-compatibility.json. Organization-side Doctor je
// pinned kopie template scriptu v lazurio/testdata (v2 = PR #48, v1 = legacy
// operator-managed-link); LAZURIO_AGENT_SKILLS_ORGANIZATION_SCRIPT smí
// ukázat na živý Organization/template script se stejným exportem.
import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  AGENT_CAPABILITY_MODES,
  AGENT_SKILLS_ENTRYPOINT_SCHEMA,
  AGENT_SKILLS_MANUAL_REPAIR_REMEDY,
  AGENT_SKILLS_MIGRATION_MANUAL_PATH,
  CLAUDE_SKILLS_MATERIALIZATION,
  agentSkillsEntrypointsDoctorCheck,
  inspectAgentSkillsEntrypoint,
} from "./agent-skills-entrypoint-lib.mjs";
import { checkAgentSkillsMirror } from "../../scripts/agent-skills-entrypoint.mjs";
import * as organizationDoctorV2Pinned from
  "../testdata/agent-skills-entrypoint/organization-template-v2/scripts/agent-skills-entrypoint.mjs";
import * as organizationDoctorV1 from
  "../testdata/agent-skills-entrypoint/organization-template-v1/scripts/agent-skills-entrypoint.mjs";

const runtimeDirectory = dirname(fileURLToPath(import.meta.url));
const matrix = JSON.parse(
  await readFile(join(runtimeDirectory, "agent-skills-entrypoint-compatibility.json"), "utf8"),
);
const provenance = JSON.parse(
  await readFile(join(runtimeDirectory, "..", "testdata", "agent-skills-entrypoint", "PROVENANCE.json"), "utf8"),
);
const liveOrganizationScript = process.env[provenance.live_override_env];
const organizationDoctorV2 = liveOrganizationScript
  ? await import(pathToFileURL(resolve(liveOrganizationScript)).href)
  : organizationDoctorV2Pinned;
const organizationDoctorLabel = liveOrganizationScript
  ? `živý Organization script ${liveOrganizationScript}`
  : `pinned OrganizationTemplate_GEN3@${provenance.fixtures["organization-template-v2"].commit.slice(0, 8)}`;

const MOUNT_PATH = "organizations/Fresh_GEN3";
const SLUG = "fixture-skill";
const tempRoots = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function git(cwd, args) {
  const result = Bun.spawnSync({
    cmd: ["git", "-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", ...args],
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} selhalo: ${new TextDecoder().decode(result.stderr)}`);
  }
}

async function tempDirectory(name) {
  const directory = await mkdtemp(join(tmpdir(), `agent-skills-compat-${name}-`));
  tempRoots.push(directory);
  return directory;
}

// Windows-safe link fixture: na POSIX symlink, na Windows directory junction
// (nevyžaduje Developer Mode ani SeCreateSymbolicLinkPrivilege). Oba tvary
// hlásí lstat jako symbolic link, takže Doctory jdou stejnou cestou.
async function linkDirectory(target, linkPath) {
  await symlink(target, linkPath, "junction");
}

// Upstream fixture repo = Organization root tak, jak ho zveřejní template.
// Fresh checkout vzniká skutečným `git clone`, ne kopií pracovního stromu.
async function publishOrganizationFixture(name, { committedCompatibility }) {
  const upstream = await tempDirectory(`${name}-upstream`);
  git(upstream, ["init", "--quiet", "--initial-branch=main"]);
  const canonical = join(upstream, ".agents", "skills", SLUG);
  await mkdir(join(canonical, "references"), { recursive: true });
  await writeFile(join(canonical, "SKILL.md"), `# ${SLUG}\n\n## Kdy použít\n\n## Postup\n\n## Ověření\n`);
  await writeFile(join(canonical, "references", "data.txt"), "reference\n");
  await writeFile(
    join(upstream, ".agents", "skills", "manifest.json"),
    `${JSON.stringify({
      schema_version: "companiesascode.organization_skills.v1",
      policy: { canonical_directory: ".agents/skills", claude_compatibility: CLAUDE_SKILLS_MATERIALIZATION },
      skills: [{ slug: SLUG, path: `.agents/skills/${SLUG}/SKILL.md` }],
    }, null, 2)}\n`,
  );
  // Root Doctor nesmí spouštět Organization kód; sentinel to prokáže.
  await mkdir(join(upstream, "scripts"), { recursive: true });
  await writeFile(
    join(upstream, "scripts", "agent-skills-entrypoint.mjs"),
    "throw new Error('Lazurio root Doctor nesmí spustit Organization kód');\n",
  );
  await committedCompatibility(upstream);
  git(upstream, ["add", "--all"]);
  git(upstream, ["commit", "--quiet", "--message", "Organization fixture"]);
  return upstream;
}

async function writeTrackedMirror(root, { skillContents } = {}) {
  const mirror = join(root, ".claude", "skills", SLUG);
  await mkdir(join(mirror, "references"), { recursive: true });
  await writeFile(
    join(mirror, "SKILL.md"),
    skillContents ?? await readFile(join(root, ".agents", "skills", SLUG, "SKILL.md")),
  );
  await writeFile(join(mirror, "references", "data.txt"), "reference\n");
}

// Jak vzniká každý stav matice: co je committed v upstreamu a co udělá
// operátor nebo prostředí až po fresh checkoutu.
const stateBuilders = {
  tracked_mirror: {
    committed: (root) => writeTrackedMirror(root),
    afterCheckout: async () => {},
  },
  legacy_link: {
    committed: async () => {},
    afterCheckout: async (root) => {
      await mkdir(join(root, ".claude"), { recursive: true });
      await linkDirectory(join(root, ".agents", "skills"), join(root, ".claude", "skills"));
    },
  },
  legacy_placeholder: {
    committed: async (root) => {
      await mkdir(join(root, ".claude"), { recursive: true });
      await writeFile(join(root, ".claude", "skills"), "../.agents/skills");
    },
    afterCheckout: async () => {},
  },
  missing: {
    committed: async () => {},
    afterCheckout: async () => {},
  },
  drift: {
    committed: (root) => writeTrackedMirror(root, { skillContents: "# stale\n" }),
    afterCheckout: async () => {},
  },
  wrong_link: {
    committed: async () => {},
    afterCheckout: async (root) => {
      const outside = await tempDirectory("wrong-link-target");
      await mkdir(join(root, ".claude"), { recursive: true });
      await linkDirectory(outside, join(root, ".claude", "skills"));
    },
  },
  unexpected_file: {
    committed: async (root) => {
      await mkdir(join(root, ".claude"), { recursive: true });
      await writeFile(join(root, ".claude", "skills"), "neznámý obsah\n");
    },
    afterCheckout: async () => {},
  },
  unsafe_link_inside_mirror: {
    committed: (root) => writeTrackedMirror(root),
    afterCheckout: async (root) => {
      await linkDirectory(
        join(root, ".agents", "skills", SLUG, "references"),
        join(root, ".claude", "skills", SLUG, "linked-references"),
      );
    },
  },
};

async function freshCheckout(stateId) {
  const builder = stateBuilders[stateId];
  if (!builder) throw new Error(`Matice zná stav ${stateId}, test pro něj nemá fixture builder.`);
  const upstream = await publishOrganizationFixture(stateId, { committedCompatibility: builder.committed });
  const companiesRoot = await tempDirectory(`${stateId}-lazurio-root`);
  const organizationRoot = join(companiesRoot, MOUNT_PATH);
  await mkdir(dirname(organizationRoot), { recursive: true });
  git(companiesRoot, ["clone", "--quiet", upstream, organizationRoot]);
  await builder.afterCheckout(organizationRoot);
  return { companiesRoot, organizationRoot };
}

function expectState(actual, expected, label) {
  expect({ label, status: actual.status, code: actual.code })
    .toEqual({ label, status: expected.status, code: expected.code });
}

function rootAggregate(companiesRoot, options = {}) {
  return agentSkillsEntrypointsDoctorCheck({
    companiesRoot,
    includeRoot: false,
    mounts: [{ path: MOUNT_PATH, status: "mounted" }],
    ...options,
  });
}

test("matice deklaruje současný root kontrakt a pinned Organization fixtures", () => {
  const rootContract = matrix.root_contracts.find((contract) => contract.id === "root-v2");
  expect(rootContract.schema_version).toBe(AGENT_SKILLS_ENTRYPOINT_SCHEMA);
  expect(rootContract.materialization).toBe(CLAUDE_SKILLS_MATERIALIZATION);
  expect(rootContract.accepts["org-v2"]).toBe("ok");
  expect(rootContract.accepts["org-v1"]).toBe("repair_needed");
  expect(matrix.organization_migration_manual).toBe(AGENT_SKILLS_MIGRATION_MANUAL_PATH);
  expect(AGENT_SKILLS_MANUAL_REPAIR_REMEDY).toContain(AGENT_SKILLS_MIGRATION_MANUAL_PATH);
  expect(matrix.remedy).toMatchObject({ deterministic: true, destructive: false, writer: "none" });

  expect(organizationDoctorV2Pinned.AGENT_SKILLS_ENTRYPOINT_SCHEMA)
    .toBe(provenance.fixtures["organization-template-v2"].schema_version);
  expect(organizationDoctorV2Pinned.CLAUDE_SKILLS_MATERIALIZATION)
    .toBe(provenance.fixtures["organization-template-v2"].materialization);
  expect(organizationDoctorV1.AGENT_SKILLS_ENTRYPOINT_SCHEMA)
    .toBe(provenance.fixtures["organization-template-v1"].schema_version);
  expect(organizationDoctorV1.CLAUDE_SKILLS_MATERIALIZATION)
    .toBe(provenance.fixtures["organization-template-v1"].materialization);
  // Organization v2 sdílí schema i materializaci s rootem — to je jádro #245.
  expect(organizationDoctorV2.AGENT_SKILLS_ENTRYPOINT_SCHEMA).toBe(AGENT_SKILLS_ENTRYPOINT_SCHEMA);
  expect(organizationDoctorV2.CLAUDE_SKILLS_MATERIALIZATION).toBe(CLAUDE_SKILLS_MATERIALIZATION);
  expect(Object.keys(stateBuilders).sort()).toEqual(matrix.states.map((state) => state.id).sort());
});

for (const row of matrix.states) {
  for (const platform of ["linux", "win32"]) {
    test(`fresh checkout · ${row.id} · ${platform}: root Doctor a Organization Doctor (${organizationDoctorLabel}) vrací kódy z matice`, async () => {
      const { companiesRoot, organizationRoot } = await freshCheckout(row.id);

      const rootState = await inspectAgentSkillsEntrypoint(organizationRoot, { platform });
      expectState(rootState, row.root_doctor, `root_doctor/${row.id}/${platform}`);
      expect(rootState.schema_version).toBe(AGENT_SKILLS_ENTRYPOINT_SCHEMA);
      if (rootState.status === "repair_needed" && row.remedy === "manual_migration") {
        expect(rootState.message).toContain(AGENT_SKILLS_MIGRATION_MANUAL_PATH);
        expect(rootState.message).not.toMatch(/repair lane ho nahrad|spusť bun run repair/u);
      }

      const aggregate = await rootAggregate(companiesRoot, { platform });
      expect(aggregate.status).toBe(row.root_aggregate_status);
      expect(aggregate.details[0]).toContain(`${row.root_doctor.status}/${row.root_doctor.code}`);
      if (aggregate.status === "warn") {
        expect(aggregate.message).toContain(AGENT_SKILLS_MIGRATION_MANUAL_PATH);
      }

      const organizationState = await organizationDoctorV2.inspectAgentSkillsEntrypoint(organizationRoot, { platform });
      expectState(organizationState, row.organization_doctor, `organization_doctor/${row.id}/${platform}`);

      const legacyState = await organizationDoctorV1.inspectAgentSkillsEntrypoint(organizationRoot, { platform });
      expectState(legacyState, row.organization_doctor_v1, `organization_doctor_v1/${row.id}/${platform}`);

      // Root vlastní lane (scripts/agent-skills-entrypoint.mjs, Organization-
      // ekvivalent pro Lazurio root jako checkout) nesmí mít druhou pravdu.
      const rootLane = await checkAgentSkillsMirror(organizationRoot, { platform });
      expectState(rootLane, row.root_doctor, `root_lane/${row.id}/${platform}`);
    });
  }
}

for (const override of matrix.platform_overrides) {
  for (const stateId of override.states) {
    test(`override ${override.id} · ${stateId}: root Doctor toleruje, Organization Doctor beze změny`, async () => {
      const row = matrix.states.find((state) => state.id === stateId);
      const { companiesRoot, organizationRoot } = await freshCheckout(stateId);
      const options = { platform: override.platform, agentCapabilityMode: override.agent_capability_mode };
      expect(Object.values(AGENT_CAPABILITY_MODES)).toContain(override.agent_capability_mode);

      expectState(
        await inspectAgentSkillsEntrypoint(organizationRoot, options),
        override.root_doctor,
        `override/${stateId}`,
      );
      const aggregate = await rootAggregate(companiesRoot, options);
      expect(aggregate.status).toBe(override.root_aggregate_status);

      expect(override.organization_doctor).toBe("unchanged");
      expectState(
        await organizationDoctorV2.inspectAgentSkillsEntrypoint(organizationRoot, { platform: override.platform }),
        row.organization_doctor,
        `override-organization/${stateId}`,
      );
    });
  }
}

test("Organization repair v2 nad fresh checkoutem je no-write a vrací manual_repair_required shodně s root lane", async () => {
  const { organizationRoot } = await freshCheckout("legacy_link");
  const before = await readFile(join(organizationRoot, ".agents", "skills", SLUG, "SKILL.md"), "utf8");

  const organizationRepair = await organizationDoctorV2.repairAgentSkillsEntrypoint(organizationRoot);
  expect(organizationRepair).toMatchObject({ status: "blocked", code: "manual_repair_required" });

  const { repairAgentSkillsMirror } = await import("../../scripts/agent-skills-entrypoint.mjs");
  const rootRepair = await repairAgentSkillsMirror(organizationRoot);
  expect(rootRepair).toMatchObject({ status: "blocked", code: "manual_repair_required" });
  expect(rootRepair.message).toContain(AGENT_SKILLS_MIGRATION_MANUAL_PATH);

  const linkStat = await import("node:fs/promises").then(({ lstat }) => lstat(join(organizationRoot, ".claude", "skills")));
  expect(linkStat.isSymbolicLink()).toBe(true);
  expect(await readFile(join(organizationRoot, ".agents", "skills", SLUG, "SKILL.md"), "utf8")).toBe(before);
});

test("junction/symlink fixture: win32 porovnává cesty case-insensitive a stále rozliší legacy link od cizího linku", async () => {
  const legacy = await freshCheckout("legacy_link");
  const wrong = await freshCheckout("wrong_link");
  const [legacyState, wrongState] = await Promise.all([
    inspectAgentSkillsEntrypoint(legacy.organizationRoot, { platform: "win32" }),
    inspectAgentSkillsEntrypoint(wrong.organizationRoot, { platform: "win32" }),
  ]);
  expect(legacyState.code).toBe("mirror_legacy_link");
  expect(wrongState.code).toBe("entrypoint_wrong_link");
  expect(legacyState.message).toContain(AGENT_SKILLS_MIGRATION_MANUAL_PATH);
  expect(wrongState.message).toContain(AGENT_SKILLS_MIGRATION_MANUAL_PATH);
  expect(matrix.windows.developer_mode_required).toBe(false);
});
