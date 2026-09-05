import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  PUBLICATION_QUESTION,
  PUBLICATION_DOUBLE_QUESTION,
  checkOrganizationAgentsInstance,
  classifyAgentsInstanceSlot,
  readAgentsInstanceFile,
  collectAgentsInstanceTargets,
  inspectAgentsInstanceText,
  requiredStatementsForKind,
  runAgentsInstanceCli,
  slotIsPlanned,
} from "./check-organization-agents-instance.mjs";

const scriptPath = fileURLToPath(new URL("./check-organization-agents-instance.mjs", import.meta.url));
const roots = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("baseline Knowledgebase, Mission Control and data remain required even as planned slots", () => {
  const targets = collectAgentsInstanceTargets({
    kind: "organization",
    repository_inventory: [
      slot("workspace/knowledgebase", { category: "knowledge", status: "planned_slot" }),
      slot("mission-control", { category: "planning", status: "planned_slot" }),
      slot("mission-control/db", { category: "planning-data", status: "planned_slot" }),
      slot("design-system", { category: "design", status: "planned_slot" }),
      slot("infra", { category: "infrastructure", status: "planned_slot" }),
    ],
  });
  expect(targets.map(({ relativePath, kind }) => `${kind}:${relativePath}`)).toEqual([
    "root:AGENTS.md",
    "knowledgebase:workspace/knowledgebase/AGENTS.md",
    "mission-control:mission-control/AGENTS.md",
    "mission-control-data:mission-control/db/AGENTS.md",
  ]);
});

test("off-path knowledge category does not satisfy the canonical Knowledgebase baseline", () => {
  const targets = collectAgentsInstanceTargets({
    repository_inventory: [
      slot("workspace/not-knowledgebase", { category: "knowledge", status: "active" }),
    ],
  });
  expect(targets).toEqual(expect.arrayContaining([
    { relativePath: "workspace/knowledgebase/AGENTS.md", kind: "knowledgebase", required: true },
    { relativePath: "workspace/not-knowledgebase/AGENTS.md", kind: "knowledgebase", required: true },
    { relativePath: "mission-control/AGENTS.md", kind: "mission-control", required: true },
    { relativePath: "mission-control/db/AGENTS.md", kind: "mission-control-data", required: true },
  ]));
});

test("off-path planning category does not satisfy the canonical Mission Control baseline", () => {
  const targets = collectAgentsInstanceTargets({
    repository_inventory: [
      slot("workspace/planning-notes", { category: "planning", status: "active" }),
    ],
  });
  expect(targets.map(({ relativePath }) => relativePath)).toEqual(expect.arrayContaining([
    "mission-control/AGENTS.md",
    "mission-control/db/AGENTS.md",
    "workspace/knowledgebase/AGENTS.md",
    "workspace/planning-notes/AGENTS.md",
  ]));
});

test("canonical Knowledgebase remains required when only an off-path knowledge slot exists", () => {
  const root = writeOrganizationFixture({
    slots: [slot("workspace/not-knowledgebase", { category: "knowledge", status: "active" })],
    files: {
      "AGENTS.md": instanceRoot(),
      "workspace/not-knowledgebase/AGENTS.md": [
        "Toto je privátní knowledgebase této Organizace.",
        "Čti parent AGENTS.md.",
        PUBLICATION_QUESTION,
        "",
      ].join("\n"),
      "mission-control/AGENTS.md": [
        "Instance Mission Control app této Organizace.",
        PUBLICATION_QUESTION,
        "",
      ].join("\n"),
      "mission-control/db/AGENTS.md": [
        "PR proti v3 je Draft.",
        PUBLICATION_QUESTION,
        "",
      ].join("\n"),
    },
  });
  expect(checkOrganizationAgentsInstance({ organizationRoot: root }).findings).toEqual([
    expect.objectContaining({
      code: "missing_file",
      path: "workspace/knowledgebase/AGENTS.md",
    }),
  ]);
});

test("active Design System and infra slots require their AGENTS.md", () => {
  const targets = collectAgentsInstanceTargets({
    repository_inventory: [
      slot("workspace/design-system-light-works", { category: "design", status: "active" }),
      slot("infra", { category: "infrastructure", status: "active" }),
    ],
  });
  expect(targets).toEqual(expect.arrayContaining([
    { relativePath: "workspace/design-system-light-works/AGENTS.md", kind: "design-system", required: true },
    { relativePath: "infra/AGENTS.md", kind: "infra", required: true },
    { relativePath: "workspace/knowledgebase/AGENTS.md", kind: "knowledgebase", required: true },
  ]));
});

test("planned materialization is treated as planned", () => {
  expect(slotIsPlanned({ status: "active", materialization: "planned_slot" })).toBe(true);
  expect(classifyAgentsInstanceSlot(slot("mission-control/db", { category: "planning" }))).toBe(
    "mission-control-data",
  );
});

test("inspect fails each missing required statement and leftover template identity", () => {
  expect(inspectAgentsInstanceText({
    relativePath: "workspace/knowledgebase/AGENTS.md",
    kind: "knowledgebase",
    text: "KnowledgebaseTemplate — šablona bez parent pointeru\n",
  })).toEqual(expect.arrayContaining([
    expect.objectContaining({ code: "forbidden_text", detail: "KnowledgebaseTemplate —" }),
    expect.objectContaining({ code: "missing_statement", detail: "privátní knowledgebase" }),
    expect.objectContaining({ code: "missing_statement", detail: "AGENTS.md" }),
    expect.objectContaining({ code: "missing_statement", detail: PUBLICATION_QUESTION }),
  ]));
  expect(inspectAgentsInstanceText({
    relativePath: "mission-control/db/AGENTS.md",
    kind: "mission-control-data",
    text: "Commit a push jsou Publikace dat na v3.\n",
  })).toEqual(expect.arrayContaining([
    expect.objectContaining({ code: "missing_statement", detail: "PR proti" }),
    expect.objectContaining({ code: "missing_statement", detail: PUBLICATION_QUESTION }),
  ]));
  for (const kind of Object.keys({
    root: true,
    knowledgebase: true,
    "mission-control": true,
    "mission-control-data": true,
    "design-system": true,
    infra: true,
  })) {
    const empty = inspectAgentsInstanceText({ relativePath: "AGENTS.md", kind, text: "" });
    if (kind === "root") {
      expect(empty).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "handoff_not_first", detail: "Povinný handoff" }),
        ...PUBLICATION_DOUBLE_QUESTION.map((detail) => expect.objectContaining({
          code: "missing_statement",
          detail,
        })),
      ]));
      continue;
    }
    for (const statement of requiredStatementsForKind(kind)) {
      expect(empty.some((finding) => finding.code === "missing_statement" && finding.detail === statement)).toBe(true);
    }
  }
});

test("root handoff must be the first block and include the full double-question", () => {
  expect(inspectAgentsInstanceText({
    relativePath: "AGENTS.md",
    kind: "root",
    text: [
      "# Úvod",
      "",
      "Běžný text před handoffem.",
      "",
      "## Povinný handoff",
      "Mám změny Publikovat tvým jménem? Nebo mám požádat jiného oprávněného Principála o kontrolu a Publikaci?",
      "",
    ].join("\n"),
  })).toEqual([
    expect.objectContaining({ code: "handoff_not_first", detail: "Povinný handoff" }),
  ]);
  expect(inspectAgentsInstanceText({
    relativePath: "AGENTS.md",
    kind: "root",
    text: [
      "## Povinný handoff",
      "Mám změny Publikovat.",
      "",
    ].join("\n"),
  })).toEqual(expect.arrayContaining([
    expect.objectContaining({
      code: "missing_statement",
      detail: "Mám změny Publikovat tvým jménem?",
    }),
    expect.objectContaining({
      code: "missing_statement",
      detail: "Nebo mám požádat jiného oprávněného Principála o kontrolu a Publikaci?",
    }),
  ]));
  expect(inspectAgentsInstanceText({
    relativePath: "AGENTS.md",
    kind: "root",
    text: [
      "# Běžný úvod",
      "## Povinný handoff",
      "Mám změny Publikovat tvým jménem? Nebo mám požádat jiného oprávněného Principála o kontrolu a Publikaci?",
      "",
    ].join("\n"),
  })).toEqual([
    expect.objectContaining({ code: "handoff_not_first", detail: "Povinný handoff" }),
  ]);
  expect(inspectAgentsInstanceText({
    relativePath: "AGENTS.md",
    kind: "root",
    text: [
      "## Povinný handoff",
      "Mám změny Publikovat tvým jménem?",
      "Nebo mám požádat kohokoliv.",
      "",
    ].join("\n"),
  })).toEqual([
    expect.objectContaining({
      code: "missing_statement",
      detail: "Nebo mám požádat jiného oprávněného Principála o kontrolu a Publikaci?",
    }),
  ]);
  expect(inspectAgentsInstanceText({
    relativePath: "AGENTS.md",
    kind: "root",
    text: [
      "## Povinný handoff — nepovolený doplněk",
      "Mám změny Publikovat tvým jménem? Nebo mám požádat jiného oprávněného Principála o kontrolu a Publikaci?",
      "",
    ].join("\n"),
  })).toEqual([
    expect.objectContaining({ code: "handoff_not_first", detail: "Povinný handoff" }),
  ]);
});

test("happy Organization fixture passes the instance rewrite", () => {
  const root = writeOrganizationFixture({
    slots: baselineSlots(),
    files: baselineFiles(),
  });
  expect(checkOrganizationAgentsInstance({ organizationRoot: root })).toEqual({
    ok: true,
    findings: [],
  });
});

test("missing nested AGENTS.md fails closed", () => {
  for (const relativePath of [
    "workspace/knowledgebase/AGENTS.md",
    "mission-control/AGENTS.md",
    "mission-control/db/AGENTS.md",
  ]) {
    const files = baselineFiles();
    delete files[relativePath];
    const root = writeOrganizationFixture({ slots: baselineSlots(), files });
    expect(checkOrganizationAgentsInstance({ organizationRoot: root }).findings).toEqual([
      expect.objectContaining({ code: "missing_file", path: relativePath }),
    ]);
  }
});

test("active Design System without AGENTS.md fails; planned Design System may be absent", () => {
  const planned = writeOrganizationFixture({
    slots: [...baselineSlots(), slot("design-system", { category: "design", status: "planned_slot" })],
    files: baselineFiles(),
  });
  expect(checkOrganizationAgentsInstance({ organizationRoot: planned }).ok).toBe(true);

  const active = writeOrganizationFixture({
    slots: [...baselineSlots(), slot("design-system", { category: "design", status: "active" })],
    files: baselineFiles(),
  });
  expect(checkOrganizationAgentsInstance({ organizationRoot: active }).findings).toEqual([
    expect.objectContaining({ code: "missing_file", path: "design-system/AGENTS.md" }),
  ]);
});

test("permission scan error fails instead of passing", () => {
  const root = writeOrganizationFixture({ slots: baselineSlots(), files: baselineFiles() });
  const permission = Object.assign(new Error("permission denied"), { code: "EACCES" });
  const result = checkOrganizationAgentsInstance({
    organizationRoot: root,
    readText() {
      throw permission;
    },
  });
  expect(result.ok).toBe(false);
  expect(result.findings.every((finding) => finding.code === "read_error" && finding.detail === "EACCES")).toBe(true);
});

test("incomplete scan after a readable root file still fails", () => {
  const root = writeOrganizationFixture({ slots: baselineSlots(), files: baselineFiles() });
  const incomplete = Object.assign(new Error("read interrupted"), { code: "EIO" });
  const result = checkOrganizationAgentsInstance({
    organizationRoot: root,
    readText(absolutePath) {
      if (absolutePath.endsWith(join("workspace", "knowledgebase", "AGENTS.md"))) {
        throw incomplete;
      }
      return readAgentsInstanceFile(absolutePath);
    },
  });
  expect(result.ok).toBe(false);
  expect(result.findings).toEqual(expect.arrayContaining([
    expect.objectContaining({
      code: "read_error",
      path: "workspace/knowledgebase/AGENTS.md",
      detail: "EIO",
    }),
  ]));
});

test("template checkout is not certified as an Organization instance", () => {
  const root = writeOrganizationFixture({
    kind: "template",
    slots: [],
    files: { "AGENTS.md": instanceRoot() },
  });
  expect(checkOrganizationAgentsInstance({ organizationRoot: root }).findings).toEqual([
    expect.objectContaining({ code: "not_an_organization" }),
  ]);
});

test("CLI writes fail to stderr and uses exit 1 for a missing nested file", () => {
  const files = baselineFiles();
  delete files["mission-control/AGENTS.md"];
  const root = writeOrganizationFixture({ slots: baselineSlots(), files });
  const stderr = { text: "", write(chunk) { this.text += chunk; } };
  const stdout = { text: "", write(chunk) { this.text += chunk; } };
  expect(runAgentsInstanceCli([root], { stdout, stderr })).toBe(1);
  expect(stdout.text).toBe("");
  expect(stderr.text).toContain("missing_file");
  expect(stderr.text).toContain("mission-control/AGENTS.md");
});

test("CLI spawn of the script reports a passing fixture with exit 0", () => {
  const root = writeOrganizationFixture({ slots: baselineSlots(), files: baselineFiles() });
  const result = spawnSync(process.execPath, [scriptPath, root], { encoding: "utf8" });
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("ok - Organization AGENTS instance rewrite");
  expect(result.stderr).toBe("");
});

test("CLI usage error is exit 2, distinct from a failed scan", () => {
  const stderr = { text: "", write(chunk) { this.text += chunk; } };
  const stdout = { text: "", write(chunk) { this.text += chunk; } };
  expect(runAgentsInstanceCli([], { stdout, stderr })).toBe(2);
  expect(stderr.text).toContain("usage:");
});

function fixtureRoot() {
  const root = mkdtempSync(join(tmpdir(), "lazurio-agents-instance-"));
  roots.push(root);
  return root;
}

function writeOrganizationFixture({ kind = "organization", slots, files }) {
  const root = fixtureRoot();
  writeJson(root, "company.gen3.json", {
    organization_generation: "gen3",
    organization_kind: kind,
    company: { slug: "example", display_name: "Example", github_org: "Example" },
    teams: [],
  });
  writeJson(root, "modules.manifest.json", {
    organization_generation: "gen3",
    company: "example",
    github_org: "Example",
    module_slots: slots,
  });
  for (const [relativePath, text] of Object.entries(files)) {
    const path = join(root, ...relativePath.split("/"));
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  }
  return root;
}

function writeJson(root, relativePath, value) {
  writeFileSync(join(root, relativePath), `${JSON.stringify(value, null, 2)}\n`);
}

function slot(path, extra = {}) {
  return { path, ...extra };
}

function baselineSlots() {
  return [
    slot("workspace/knowledgebase", { category: "knowledge", status: "active" }),
    slot("mission-control", { category: "planning", status: "active" }),
    slot("mission-control/db", { category: "planning-data", status: "active" }),
    slot("infra", { category: "infrastructure", status: "planned_slot" }),
  ];
}

function baselineFiles() {
  return {
    "AGENTS.md": instanceRoot(),
    "workspace/knowledgebase/AGENTS.md": [
      "Toto je privátní knowledgebase této Organizace.",
      "Čti parent AGENTS.md.",
      PUBLICATION_QUESTION,
      "",
    ].join("\n"),
    "mission-control/AGENTS.md": [
      "Instance Mission Control app této Organizace.",
      PUBLICATION_QUESTION,
      "",
    ].join("\n"),
    "mission-control/db/AGENTS.md": [
      "PR proti v3 je Draft.",
      PUBLICATION_QUESTION,
      "",
    ].join("\n"),
  };
}

function instanceRoot() {
  return [
    "## Povinný handoff",
    "Mám změny Publikovat tvým jménem? Nebo mám požádat jiného oprávněného Principála o kontrolu a Publikaci?",
    "",
  ].join("\n");
}
