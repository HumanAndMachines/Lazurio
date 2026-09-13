#!/usr/bin/env bun

import { lstatSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { readOrganizationRoot } from "../lazurio/core/organization-root-reader-lib.mjs";
import { normalizeOrganizationSlotPath } from "../lazurio/core/organization-slot-scope-lib.mjs";

export const PUBLICATION_QUESTION = "Mám změny Publikovat";
export const ROOT_HANDOFF_HEADING = "Povinný handoff";
export const ROOT_HANDOFF_HEADING_PATTERN = /^#{1,6}[ \t]+Povinný handoff[ \t]*$/u;
export const PUBLICATION_DOUBLE_QUESTION = Object.freeze([
  "Mám změny Publikovat tvým jménem?",
  "Nebo mám požádat jiného Kolegu o kontrolu a Publikaci?",
]);

export const FORBIDDEN_LITERALS = Object.freeze([
  "KnowledgebaseTemplate",
  "není knowledgebase konkrétní firmy",
  "MissionControlTemplate",
  "forkable šablona",
]);

export const FORBIDDEN_LITERALS_BY_KIND = Object.freeze({
  "mission-control": ["Mattyčus"],
});

export function forbiddenLiteralsForKind(kind) {
  return [...FORBIDDEN_LITERALS, ...(FORBIDDEN_LITERALS_BY_KIND[kind] ?? [])];
}

export const BASELINE_KIND_PATHS = Object.freeze({
  knowledgebase: "workspace/knowledgebase",
  "mission-control": "mission-control",
  "mission-control-data": "mission-control/db",
});

const BASELINE_KINDS = new Set(Object.keys(BASELINE_KIND_PATHS));
const CONDITIONAL_KINDS = new Set(["design-system", "infra"]);

const REQUIRED_STATEMENTS = Object.freeze({
  knowledgebase: ["privátní knowledgebase", "AGENTS.md", PUBLICATION_QUESTION],
  "mission-control": [PUBLICATION_QUESTION],
  "mission-control-data": ["PR proti", "v3", PUBLICATION_QUESTION],
  "design-system": ["AGENTS.md"],
  infra: ["AGENTS.md"],
});

export function classifyAgentsInstanceSlot(slot) {
  const path = normalizeOrganizationSlotPath(slot?.path) ?? "";
  const category = String(slot?.category ?? "").toLowerCase();
  if (path === "mission-control/db") return "mission-control-data";
  if (path === "mission-control") return "mission-control";
  if (path === "workspace/knowledgebase") return "knowledgebase";
  if (category === "planning-data") return "mission-control-data";
  if (category === "planning") return "mission-control";
  if (category === "knowledge") return "knowledgebase";
  if (category === "design" || path === "design-system" || path.includes("design-system")) {
    return "design-system";
  }
  if (path === "infra" || category === "infrastructure") return "infra";
  return null;
}

export function slotIsPlanned(slot) {
  const status = String(slot?.status ?? "").toLowerCase();
  const materialization = String(slot?.materialization ?? "").toLowerCase();
  return ["planned", "planned_slot"].includes(status)
    || ["planned", "planned_slot"].includes(materialization);
}

export function requiredStatementsForKind(kind) {
  return REQUIRED_STATEMENTS[kind] ?? [];
}

export function isCanonicalBaselinePath(kind, path) {
  return BASELINE_KINDS.has(kind) && path === BASELINE_KIND_PATHS[kind];
}

export function collectAgentsInstanceTargets(resource) {
  const targets = [{ relativePath: "AGENTS.md", kind: "root", required: true }];
  const seenBaseline = new Set();
  const seenKeys = new Set(["root:AGENTS.md"]);

  for (const slot of resource?.repository_inventory ?? []) {
    const kind = classifyAgentsInstanceSlot(slot);
    const path = normalizeOrganizationSlotPath(slot?.path);
    if (!kind || !path) continue;
    const relativePath = `${path}/AGENTS.md`;
    const key = `${kind}:${relativePath}`;
    const canonical = isCanonicalBaselinePath(kind, path);
    const required = canonical
      || (BASELINE_KINDS.has(kind) && !slotIsPlanned(slot))
      || (CONDITIONAL_KINDS.has(kind) && !slotIsPlanned(slot));
    if (!required) continue;
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    targets.push({ relativePath, kind, required: true });
    if (canonical) seenBaseline.add(kind);
  }

  for (const [kind, path] of Object.entries(BASELINE_KIND_PATHS)) {
    const relativePath = `${path}/AGENTS.md`;
    const key = `${kind}:${relativePath}`;
    if (seenBaseline.has(kind) || seenKeys.has(key)) continue;
    seenKeys.add(key);
    targets.push({ relativePath, kind, required: true });
  }

  return targets;
}

export function firstNonEmptyMarkdownLine(text) {
  for (const line of String(text ?? "").replace(/^\uFEFF/, "").split(/\r?\n/)) {
    if (line.trim() !== "") return line.trim();
  }
  return "";
}

export function inspectRootHandoff(text, relativePath = "AGENTS.md") {
  const findings = [];
  const firstLine = firstNonEmptyMarkdownLine(text);
  if (!ROOT_HANDOFF_HEADING_PATTERN.test(firstLine)) {
    findings.push({
      code: "handoff_not_first",
      path: relativePath,
      detail: ROOT_HANDOFF_HEADING,
    });
  }
  for (const statement of PUBLICATION_DOUBLE_QUESTION) {
    if (!String(text ?? "").includes(statement)) {
      findings.push({ code: "missing_statement", path: relativePath, detail: statement });
    }
  }
  return findings;
}

export function inspectAgentsInstanceText({ relativePath, kind, text }) {
  const findings = [];
  for (const literal of forbiddenLiteralsForKind(kind)) {
    if (text.includes(literal)) {
      findings.push({ code: "forbidden_text", path: relativePath, detail: literal });
    }
  }
  if (kind === "root") {
    findings.push(...inspectRootHandoff(text, relativePath));
    return findings;
  }
  for (const statement of requiredStatementsForKind(kind)) {
    if (!text.includes(statement)) {
      findings.push({ code: "missing_statement", path: relativePath, detail: statement });
    }
  }
  return findings;
}

export function readAgentsInstanceFile(absolutePath) {
  try {
    const entry = lstatSync(absolutePath);
    if (!entry.isFile() || entry.isSymbolicLink()) {
      const error = new Error("AGENTS.md není běžný soubor");
      error.code = "ENOTFILE";
      throw error;
    }
    return readFileSync(absolutePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

export function checkOrganizationAgentsInstance({
  organizationRoot,
  readRoot = readOrganizationRoot,
  readText = readAgentsInstanceFile,
} = {}) {
  const findings = [];
  if (typeof organizationRoot !== "string" || organizationRoot.trim() === "") {
    return {
      ok: false,
      findings: [{ code: "usage", path: null, detail: "chybí cesta k Organization rootu" }],
    };
  }

  const resolution = readRoot({ organizationRoot });
  const resource = resolution?.resource;
  if (!resource) {
    return {
      ok: false,
      findings: [{
        code: "organization_unreadable",
        path: null,
        detail: `${resolution?.state ?? "unknown"}:${(resolution?.issues ?? []).join(",")}`,
      }],
    };
  }
  if (resource.kind !== "organization") {
    return {
      ok: false,
      findings: [{
        code: "not_an_organization",
        path: null,
        detail: `organization_kind=${resource.kind ?? "unknown"}`,
      }],
    };
  }

  for (const target of collectAgentsInstanceTargets(resource)) {
    const absolutePath = join(organizationRoot, ...target.relativePath.split("/"));
    let text;
    try {
      text = readText(absolutePath);
    } catch (error) {
      findings.push({
        code: "read_error",
        path: target.relativePath,
        detail: error?.code || error?.message || "unreadable",
      });
      continue;
    }
    if (text == null) {
      findings.push({
        code: "missing_file",
        path: target.relativePath,
        detail: target.kind,
      });
      continue;
    }
    findings.push(...inspectAgentsInstanceText({
      relativePath: target.relativePath,
      kind: target.kind,
      text,
    }));
  }

  return { ok: findings.length === 0, findings };
}

export function formatAgentsInstanceReport(result) {
  if (result.ok) return "ok - Organization AGENTS instance rewrite";
  return result.findings
    .map((finding) => [
      "fail",
      finding.code,
      finding.path,
      finding.detail,
    ].filter((part) => part != null && part !== "").join(" - "))
    .join("\n");
}

export function runAgentsInstanceCli(argv = process.argv.slice(2), io = process) {
  if (argv.includes("-h") || argv.includes("--help") || argv.length !== 1) {
    io.stderr.write("usage: bun scripts/check-organization-agents-instance.mjs <organization-root>\n");
    return 2;
  }
  const result = checkOrganizationAgentsInstance({ organizationRoot: resolve(argv[0]) });
  const report = `${formatAgentsInstanceReport(result)}\n`;
  if (result.ok) io.stdout.write(report);
  else io.stderr.write(report);
  return result.ok ? 0 : 1;
}

if (
  process.argv[1]
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  process.exit(runAgentsInstanceCli());
}
