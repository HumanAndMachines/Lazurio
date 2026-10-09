// `lazurio organization check <organization-root>`: read-only validation of one
// Organization root for people, agents and the Organization repository's CI
// (decision 0194 point 5). Core owns the resolution and the settings verdict;
// this surface reads the documents once, adds the published-schema pass and
// renders the result. It never writes, fetches or talks to a Forge.

import { resolve } from "node:path";

import {
  ORGANIZATION_ACTIVATABLE_MANIFEST_FORMATS,
  resolveOrganizationRootDocuments,
} from "./core/organization-activation-lib.mjs";
import {
  ORGANIZATION_DOCUMENT_PATHS,
  readOrganizationRootDocuments,
} from "./core/organization-root-reader-lib.mjs";
import { validateAgainstSchema } from "./runtime/json-schema-mini.mjs";
import canonicalSchema from "./lazurio.organization.v1.schema.json";

export const ORGANIZATION_CHECK_REPORT_SCHEMA = "lazurio.organization.check.v0";

const MIGRATE_COMMAND = "lazurio migrate organization-manifest <root> --write";

export function checkOrganizationRoot({ organizationRoot }) {
  const root = resolve(organizationRoot);
  const documents = readOrganizationRootDocuments({ organizationRoot: root });
  const resolution = resolveOrganizationRootDocuments(documents);
  // Accepted exactly when activation, install and update accept the root today.
  const accepted = ORGANIZATION_ACTIVATABLE_MANIFEST_FORMATS.includes(resolution.state)
    && resolution.resource_count === 1;
  const schemaIssues = canonicalSchemaIssues(documents);
  const failures = [];
  if (!accepted) {
    failures.push({ code: "manifest_state_not_accepted", message: stateMessage(resolution) });
  }
  if (schemaIssues.length > 0) {
    failures.push({
      code: "manifest_schema_invalid",
      message: `${ORGANIZATION_DOCUMENT_PATHS.canonical} neodpovídá schématu lazurio.organization.v1 (${schemaIssues.length} nálezů).`,
    });
  }
  if (resolution.settings.status === "invalid") {
    failures.push({
      code: "settings_invalid",
      message: `Sekce settings v ${ORGANIZATION_DOCUMENT_PATHS.canonical} je neplatná: Environmenty ji nepoužijí a drží `
        + "poslední použitou verzi. Oprav ji podle issues; company.gen3.json se kvůli ní neregeneruje.",
    });
  }
  return {
    schema_version: ORGANIZATION_CHECK_REPORT_SCHEMA,
    organization_root: root,
    ok: failures.length === 0,
    manifest: {
      state: resolution.state,
      declaration_source: resolution.declaration_source,
      accepted,
      issues: [...resolution.issues],
      warnings: [...resolution.warnings],
      schema_issues: schemaIssues,
    },
    settings: resolution.settings,
    failures,
  };
}

export function organizationCheckExitCode(report) {
  return report.ok ? 0 : 1;
}

export function renderHumanOrganizationCheck(report) {
  const { manifest, settings } = report;
  const lines = [
    `Lazurio Organization check: ${report.ok ? "ok" : "chyba"}`,
    `Root: ${report.organization_root}`,
    `Manifest: ${manifest.state} · ${manifest.declaration_source ?? "bez čitelné autority"} · ${manifest.accepted ? "přijatý" : "nepřijatý"}`,
  ];
  for (const issue of manifest.issues) lines.push(`  ! ${issue}`);
  for (const warning of manifest.warnings) lines.push(`  · ${warning}`);
  for (const failure of manifest.schema_issues) lines.push(`  ! schema: ${failure}`);
  lines.push(`Nastavení Organizace (settings): ${settingsStatusText(settings)}`);
  for (const entry of settings.effective ?? []) {
    lines.push(entry.governed
      ? `  ${entry.key} = ${JSON.stringify(entry.value)} · řídí Organizace pro všechny své pracovní Environmenty`
      : `  ${entry.key}: neřízeno · rozhoduje každý Environment`);
  }
  for (const issue of settings.issues) lines.push(`  ! ${issue.code} ${issue.path}`);
  for (const failure of report.failures) lines.push(`! ${failure.code}: ${failure.message}`);
  return lines.join("\n");
}

// The settings subtree is judged once, by Core, with exact JSON Pointers;
// organization-settings-lib.test.mjs pins Core to the schema's
// `$defs.organizationSettings`, so the schema pass covers the rest of the
// document and one problem is never reported twice.
function canonicalSchemaIssues(documents) {
  const canonical = documents.canonicalManifest;
  if (canonical === null || documents.documentIssues.includes("canonical_manifest_unreadable")) return [];
  const { settings: _settings, ...document } = canonical;
  return validateAgainstSchema(document, canonicalSchema, ORGANIZATION_DOCUMENT_PATHS.canonical);
}

function stateMessage(resolution) {
  if (resolution.state === "projection_drift") {
    return `${ORGANIZATION_DOCUMENT_PATHS.legacy_projection} není aktuální projekcí ${ORGANIZATION_DOCUMENT_PATHS.canonical}; `
      + `v task worktree spusť \`${MIGRATE_COMMAND}\` a commitni oba soubory.`;
  }
  if (resolution.state === "current") {
    return `Root drží jen ${ORGANIZATION_DOCUMENT_PATHS.canonical} bez legacy projekce; aktivace ani update ho zatím `
      + "nepřijmou (decision 0145, manual/lazurio-manifest-family.md).";
  }
  if (resolution.state === "missing") {
    return `V kořeni není ${ORGANIZATION_DOCUMENT_PATHS.canonical} ani ${ORGANIZATION_DOCUMENT_PATHS.legacy_projection}; není to Lazurio Organization.`;
  }
  return `Organization dokumenty nejde bezpečně vyřešit (${resolution.issues.join(", ") || resolution.state}); `
    + `postup drží manual/lazurio-manifest-family.md, drift projekce opraví \`${MIGRATE_COMMAND}\`.`;
}

function settingsStatusText(settings) {
  if (settings.status === "valid") return "platné";
  if (settings.status === "invalid") return "neplatné — Environmenty ho nepoužijí a drží poslední použitou verzi";
  if (settings.status === "unavailable") return "nedostupné — Organization manifest není bezpečně čitelný";
  return settings.source === null
    ? `neuvedené — root bez ${ORGANIZATION_DOCUMENT_PATHS.canonical} nic neřídí; nastavení lze deklarovat `
      + `až po \`${MIGRATE_COMMAND}\``
    : "neuvedené — Organizace nic neřídí, rozhoduje každý Environment";
}
