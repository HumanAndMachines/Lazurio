import { existsSync } from "fs";
import { readFile } from "fs/promises";
import { join, relative, resolve } from "path";
import {
  organizationNestedRepoSlotPaths,
  organizationModuleSlotScope,
  ownershipPatternsOverlap,
  repositoryObservationAuthorizesTemplateWrite,
  validateOrganizationDocuments,
} from "./validation.mjs";

export const compilerVersion = "companiesascode.organization_compiler.v1";
const ownershipKinds = ["managed", "derived", "override", "manual"];

export class OrganizationCompilerError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "OrganizationCompilerError";
    this.details = details;
  }
}

export async function prepareOrganizationCompilation({
  organizationRoot,
  workspaceRoot,
  write = false,
  schemaDocuments = null,
  repositoryObservation = null,
} = {}) {
  const rootInput = organizationRoot ?? workspaceRoot;
  if (!rootInput) throw new OrganizationCompilerError("compileOrganization vyžaduje organizationRoot");
  if (write && repositoryObservation?.status === "offline") {
    throw new OrganizationCompilerError(
      "Offline repository validace je pouze read-only/dry-run a nesmí autorizovat compiler write",
    );
  }
  const root = resolve(rootInput);
  const companyConfigPath = join(root, "company.gen3.json");
  if (!existsSync(companyConfigPath)) {
    throw new OrganizationCompilerError(`Chybí company.gen3.json: ${companyConfigPath}`);
  }

  const companyConfig = JSON.parse(await readFile(companyConfigPath, "utf8"));
  const modulesManifest = await readOptionalJson(join(root, "modules.manifest.json"));
  const effectiveRepositoryObservation = repositoryObservation;
  if (
    write &&
    companyConfig.organization_kind === "template" &&
    !repositoryObservationAuthorizesTemplateWrite(
      effectiveRepositoryObservation,
    )
  ) {
    throw new OrganizationCompilerError(
      "Compiler write OrganizationTemplate vyžaduje důvěryhodně zjištěný kanonický template checkout; samotný organization_kind nestačí",
      {
        failures: [
          "company.gen3.json/organization_kind: template write není autorizovaný trusted checkout identitou TemplatesRozjedeme-ai/OrganizationTemplate_GEN3",
        ],
      },
    );
  }
  const validation = await validateOrganizationDocuments({
    companyConfig,
    modulesManifest,
    schemaDocuments,
    repositoryObservation: effectiveRepositoryObservation,
  });
  if (!validation.valid) {
    throw new OrganizationCompilerError("Organization config neprošel schema/semantic validací", {
      failures: validation.failures,
      warnings: validation.warnings,
    });
  }
  const generation = companyConfig.organization_generation ?? companyConfig.workspace_generation ?? null;
  if (generation !== "gen3") {
    throw new OrganizationCompilerError(
      `company.gen3.json musí mít organization_generation: "gen3" (nebo deprecated alias workspace_generation): ${companyConfigPath}`,
    );
  }
  const ownership = companyConfig.governance?.file_ownership ?? {};
  const targets = buildCompanyTargets({ companyConfig, modulesManifest });
  const context = buildContextPaths(root, ownership);
  const targetReports = await Promise.all(
    targets.map(async (target) => buildTargetReport({ root, target, ownership })),
  );
  const ownershipIssues = [...targetReports, ...context].filter(
    (item) => item.ownership_matches.length !== 1,
  );
  if (ownershipIssues.length > 0) {
    throw new OrganizationCompilerError(
      "Compiler vyžaduje pro každý target a vstup právě jednu ownership klasifikaci",
      {
        ownership_issues: ownershipIssues.map(({ path, ownership_matches: matches }) => ({
          path,
          matches,
        })),
      },
    );
  }
  const blockedTargets = targetReports.filter((target) => target.ownership !== "derived");

  if (write && blockedTargets.length > 0) {
    throw new OrganizationCompilerError("Compiler odmítl zapsat target mimo derived ownership", {
      blocked_targets: blockedTargets.map(({ path, ownership }) => ({ path, ownership })),
    });
  }

  const report = {
    schema_version: "companiesascode.organization_compiler_report.v1",
    compiler_version: compilerVersion,
    mode: write ? "write" : "dry-run",
    // `workspace_root` is the deprecated compatibility copy for older callers;
    // `organization_root` is the canonical CAC-0016 report field.
    organization_root: root,
    workspace_root: root,
    config_path: "company.gen3.json",
    company: companyConfig.company,
    target_count: targetReports.length,
    changed_target_count: targetReports.filter((target) => target.status !== "unchanged").length,
    ownership_summary: summarizeOwnership([...targetReports, ...context]),
    blocked_targets: blockedTargets,
    validation_warnings: validation.warnings,
    context,
    targets: targetReports,
  };
  return {
    report,
    writes: targets.map(({ path, content }) => ({ path, content })),
  };
}

export function buildCompanyTargets({ companyConfig, modulesManifest = null }) {
  // Roster je union kanonického teams[] a deprecated workspaces[] aliasu
  // (reálné manifesty zatím používají workspaces[]), DEDUPLIKOVANÝ podle
  // slugu — při stejném slugu v obou polích vyhrává kanonický teams[] záznam
  // (jinak by generované rostery nesly dvě kopie s možnými konflikty
  // display_name/default).
  const rosterBySlug = new Map();
  for (const entry of Array.isArray(companyConfig.workspaces) ? companyConfig.workspaces : []) {
    if (entry && typeof entry.slug === "string") rosterBySlug.set(entry.slug, entry);
  }
  for (const entry of Array.isArray(companyConfig.teams) ? companyConfig.teams : []) {
    if (entry && typeof entry.slug === "string") rosterBySlug.set(entry.slug, entry);
  }
  const rosterEntries = [...rosterBySlug.values()];
  const defaultTeam = rosterEntries.find((team) => team.default === true)?.slug ?? "workspace";
  const teamSlugs = new Set(
    rosterEntries.length > 0 ? rosterEntries.map((team) => team.slug) : ["workspace"],
  );
  assertMissionControlRuntimeDependency(modulesManifest?.module_slots ?? []);
  const modules = (companyConfig.modules ?? []).map((module) => {
    const isProductionspace = module.path?.startsWith("productionspace/") ?? false;
    // Fallback chain: kanonické teams[] → deprecated přechodový plurál
    // workspaces[] (krátce kanonický mezi 0041 narovnáním a Team namingem;
    // tiché ignorování by manifestu psanému proti té verzi ztratilo
    // deklarované skupiny) → deprecated singular workspace → default.
    const declaredTeams =
      Array.isArray(module.teams) && module.teams.length > 0
        ? [...module.teams]
        : Array.isArray(module.workspaces) && module.workspaces.length > 0
          ? [...module.workspaces]
          : module.workspace
            ? [module.workspace]
            : isProductionspace
              ? []
              : [defaultTeam];

    if (isProductionspace && declaredTeams.length > 0) {
      throw new OrganizationCompilerError(
        `Modul '${module.slug}' je productionspace repo a nesmí mít Team memberships`,
      );
    }
    for (const team of declaredTeams) {
      if (!teamSlugs.has(team)) {
        throw new OrganizationCompilerError(
          `Modul '${module.slug}' odkazuje na neexistující Team '${team}'`,
        );
      }
    }
    return {
      slug: module.slug,
      path: module.path,
      space: isProductionspace ? "productionspace" : "workspace",
      // Kanonicky N:M plurál modules[].teams (revize 0041 2026-07-11, Team naming);
      // singular `workspace` je deprecated alias. Modul bez deklarace patří
      // do defaultu; productionspace repo nepatří do žádného Teamu.
      teams: declaredTeams,
      // Deprecated kompatibilní kopie pro starší konzumenty (první Team).
      workspace: declaredTeams[0] ?? null,
      category: module.category ?? null,
      source_of_truth: module.source_of_truth ?? null,
      repo: module.repo ?? null,
      access: module.access ?? null,
    };
  });
  const generatedFiles = [
    "generated/company-summary.json",
    "generated/business-context.md",
    "generated/modules.index.json",
    "generated/generation-policy.md",
  ];

  return [
    {
      path: "generated/company-summary.json",
      kind: "company-summary",
      content: json({
        schema_version: "companiesascode.company_summary.v1",
        compiler_version: compilerVersion,
        company: companyConfig.company,
        business_context: summarizeBusinessContext(companyConfig.business_context),
        source_files: ["company.gen3.json", modulesManifest ? "modules.manifest.json" : null].filter(Boolean),
        generated_files: generatedFiles,
      }),
    },
    {
      path: "generated/business-context.md",
      kind: "business-context-doc",
      content: businessContextMarkdown(companyConfig),
    },
    {
      path: "generated/modules.index.json",
      kind: "modules-index",
      content: json({
        schema_version: "companiesascode.modules_index.v2",
        compiler_version: compilerVersion,
        company_slug: companyConfig.company?.slug ?? null,
        teams: summarizeTeams(rosterEntries),
        // Deprecated kompatibilní kopie rosteru pro konzumenty v1 indexu
        // (stejný obsah pod bývalým klíčem; zmizí s dokončením Team migrace).
        workspaces: summarizeTeams(rosterEntries),
        modules,
        // Sloty normalizované na kanonický tvar: teams (fallback chain jako
        // u modules[] — přechodový plurál workspaces → deprecated singular
        // workspace → default), aby konzument v2 indexu nikdy nemusel číst
        // aliasy.
        manifest_slots: (modulesManifest?.module_slots ?? []).map((slot) => {
          // Workspace sloty se grupují do Teamů. Productionspace a root
          // checkout boundaries (infra, Mission Control, primární Design
          // System) žádný Team nemají a compiler jim default nedosazuje.
          const slotScope = organizationModuleSlotScope(slot.path);
          const declared =
            Array.isArray(slot.teams) && slot.teams.length > 0
              ? [...slot.teams]
              : Array.isArray(slot.workspaces) && slot.workspaces.length > 0
                ? [...slot.workspaces]
                : slot.workspace
                  ? [slot.workspace]
                  : null;
          const hasTeamMembershipField =
            Object.hasOwn(slot, "teams") ||
            Object.hasOwn(slot, "workspaces") ||
            Object.hasOwn(slot, "workspace");
          const hasCheckoutCoordinates =
            typeof slot.git?.url === "string" &&
            slot.git.url.trim() !== "" &&
            typeof slot.git?.branch === "string" &&
            slot.git.branch.trim() !== "";
          const legacyCheckoutFields = ["repo", "repository", "branch"].filter((field) =>
            Object.hasOwn(slot, field),
          );
          if (slotScope !== "workspace" && hasTeamMembershipField) {
            throw new OrganizationCompilerError(
              `Module slot '${slot.path}' je ${slotScope} a nesmí mít Team memberships`,
            );
          }
          if (
            organizationNestedRepoSlotPaths.has(slot.path) &&
            legacyCheckoutFields.length > 0
          ) {
            throw new OrganizationCompilerError(
              `Nested root slot '${slot.path}' nesmí deklarovat legacy checkout souřadnice (${legacyCheckoutFields.join(", ")}); používej výhradně git.url a git.branch`,
            );
          }
          if (
            organizationNestedRepoSlotPaths.has(slot.path) &&
            slot.status === "planned_slot" &&
            slot.git !== undefined
          ) {
            throw new OrganizationCompilerError(
              `Planned nested repo slot '${slot.path}' nesmí deklarovat git; s checkout souřadnicemi už jde o aktivní nebo missing-access slot`,
            );
          }
          if (
            organizationNestedRepoSlotPaths.has(slot.path) &&
            slot.status !== "planned_slot" &&
            !hasCheckoutCoordinates
          ) {
            throw new OrganizationCompilerError(
              `Aktivní nested repo slot '${slot.path}' musí mít git.url a git.branch; bez checkout údajů použij status planned_slot`,
            );
          }
          const slotTeams = slotScope === "workspace" ? (declared ?? [defaultTeam]) : [];
          return {
            ...slot,
            space: slotScope,
            teams: slotTeams,
            workspace: slotTeams[0] ?? null,
          };
        }),
      }),
    },
    {
      path: "generated/generation-policy.md",
      kind: "generation-policy-doc",
      content: generationPolicyMarkdown(companyConfig),
    },
  ];
}

function assertMissionControlRuntimeDependency(moduleSlots) {
  const appSlot = moduleSlots.find((slot) => slot?.path === "mission-control");
  const dataSlot = moduleSlots.find((slot) => slot?.path === "mission-control/db");
  if (!dataSlot || dataSlot.status === "planned_slot") return;
  const appHasCheckout =
    appSlot?.status !== "planned_slot" &&
    typeof appSlot?.git?.url === "string" &&
    appSlot.git.url.trim() !== "" &&
    typeof appSlot?.git?.branch === "string" &&
    appSlot.git.branch.trim() !== "";
  if (appHasCheckout) return;
  throw new OrganizationCompilerError(
    "Aktivní mission-control/db vyžaduje aktivní parent mission-control s git.url a git.branch",
  );
}

export function formatCompilerReport(report) {
  const lines = [
    "Organization Compiler Report",
    "",
    `organization: ${report.organization_root ?? report.workspace_root}`,
    `mode: ${report.mode}`,
    `company: ${report.company?.display_name ?? report.company?.slug ?? "unknown"}`,
    `targets: ${report.target_count}`,
    `changed: ${report.changed_target_count}`,
    `ownership: managed=${report.ownership_summary.managed}, derived=${report.ownership_summary.derived}, override=${report.ownership_summary.override}, manual=${report.ownership_summary.manual}, unclassified=${report.ownership_summary.unclassified}, ambiguous=${report.ownership_summary.ambiguous}`,
  ];

  if (report.blocked_targets.length > 0) {
    lines.push("", "blocked targets:");
    for (const target of report.blocked_targets) {
      lines.push(`  [${target.ownership}] ${target.path}`);
    }
  }

  if ((report.validation_warnings ?? []).length > 0) {
    lines.push("", "validation warnings:");
    for (const warning of report.validation_warnings) lines.push(`  ${warning}`);
  }

  lines.push("", "context:");
  for (const item of report.context) {
    lines.push(`  [${item.ownership}] ${item.path}`);
  }

  lines.push("", "targets:");
  for (const target of report.targets) {
    lines.push(`  [${target.ownership}] ${target.status.padEnd(9)} ${target.path}`);
    for (const diffLine of target.diff_preview ?? []) {
      lines.push(`    ${diffLine}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

async function buildTargetReport({ root, target, ownership }) {
  const absolutePath = join(root, target.path);
  const before = existsSync(absolutePath) ? await readFile(absolutePath, "utf8") : null;
  const status = before === null ? "create" : before === target.content ? "unchanged" : "update";
  const ownershipClassification = classifyOwnership(target.path, ownership);
  return {
    path: target.path,
    kind: target.kind,
    ...ownershipClassification,
    status,
    before_bytes: before?.length ?? 0,
    after_bytes: target.content.length,
    diff_preview: status === "unchanged" ? [] : buildDiffPreview(target.path, before, target.content),
  };
}

function buildContextPaths(root, ownership) {
  return ["company.gen3.json", "modules.manifest.json", "company/launchpad/plugins/README.md"]
    .filter((path) => existsSync(join(root, path)))
    .map((path) => ({
      path,
      role: "input-or-extension-point",
      ...classifyOwnership(path, ownership),
    }));
}

function summarizeTeams(teams) {
  if (!Array.isArray(teams) || teams.length === 0) {
    return [{ slug: "workspace", display_name: null, default: true, implicit: true }];
  }
  // Roster je čistě logický (revize 0041) — žádný adresář, žádný path.
  return teams.map((team) => ({
    slug: team.slug,
    display_name: team.display_name ?? null,
    default: team.default ?? false,
  }));
}

function summarizeBusinessContext(context = {}) {
  return {
    revenue_drivers: summarizeNamedList(context.revenue_drivers),
    customer_segments: summarizeNamedList(context.customer_segments),
    value_propositions: summarizeNamedList(context.value_propositions),
    decision_rules: (context.decision_rules ?? []).map((rule) => ({
      trigger: rule.trigger,
      owner: rule.owner ?? null,
    })),
    risks: summarizeNamedList(context.risks),
    metrics: summarizeNamedList(context.metrics),
  };
}

function summarizeNamedList(values = []) {
  return values.map((value) => ({
    slug: value.slug ?? null,
    description: value.description ?? null,
    priority: value.priority ?? null,
  }));
}

function businessContextMarkdown(companyConfig) {
  const context = companyConfig.business_context ?? {};
  return [
    "# Business kontext (generated)",
    "",
    "> Tento soubor je generovaný z `company.gen3.json`. Neupravuj ho ručně.",
    "",
    `Firma: ${companyConfig.company?.display_name ?? companyConfig.company?.slug ?? "neznámá"}`,
    "",
    "## Co firmu živí",
    markdownList(context.revenue_drivers, (item) => `${item.slug}: ${item.description}`),
    "",
    "## Komu firma slouží",
    markdownList(context.customer_segments, (item) => `${item.slug}: ${item.description}`),
    "",
    "## Proč zákazník platí",
    markdownList(context.value_propositions, (item) => `${item.slug}: ${item.description}`),
    "",
    "## Rozhodovací pravidla",
    markdownList(context.decision_rules, (item) => `${item.trigger}: ${item.rule}`),
    "",
    "## Rizika",
    markdownList(context.risks, (item) => `${item.slug}: ${item.description}`),
    "",
    "## Metriky",
    markdownList(context.metrics, (item) => `${item.slug}: ${item.description}`),
    "",
  ].join("\n");
}

function generationPolicyMarkdown(companyConfig) {
  const policy = companyConfig.generation_policy ?? {};
  return [
    "# Generační pravidla (generated)",
    "",
    "> Tento soubor je generovaný z `company.gen3.json`. Neupravuj ho ručně.",
    "",
    `Pravidlo prototypu: ${policy.prototype_rule ?? "není vyplněno"}`,
    "",
    "## Verze aplikací",
    markdownList(policy.application_versions, (item) => `${item.version}: ${item.purpose}`),
    "",
    "## Verze dat",
    markdownList(policy.data_versions, (item) => `${item.namespace}: ${item.source_of_truth}`),
    "",
    "## Migrační pravidla",
    markdownList(policy.migration_rules, (item) => item.rule),
    "",
  ].join("\n");
}

function markdownList(values = [], render) {
  if (!Array.isArray(values) || values.length === 0) return "- není vyplněno";
  return values.map((value) => `- ${render(value)}`).join("\n");
}

function summarizeOwnership(items) {
  const summary = {
    managed: 0,
    derived: 0,
    override: 0,
    manual: 0,
    unclassified: 0,
    ambiguous: 0,
  };
  for (const item of items) {
    summary[item.ownership] = (summary[item.ownership] ?? 0) + 1;
  }
  return summary;
}

function buildDiffPreview(path, before, after) {
  const beforeLines = before === null ? [] : before.split("\n");
  const afterLines = after.split("\n");
  const lines = [`--- ${path}`, `+++ ${path}`];
  if (before === null) {
    for (const line of afterLines.slice(0, 12)) lines.push(`+${line}`);
    if (afterLines.length > 12) lines.push(`... +${afterLines.length - 12} dalších řádků`);
    return lines;
  }

  const max = Math.max(beforeLines.length, afterLines.length);
  for (let index = 0; index < max && lines.length < 18; index += 1) {
    if (beforeLines[index] === afterLines[index]) continue;
    if (beforeLines[index] !== undefined) lines.push(`-${beforeLines[index]}`);
    if (afterLines[index] !== undefined) lines.push(`+${afterLines[index]}`);
  }
  if (lines.length >= 18) lines.push("... diff zkrácen");
  return lines;
}

function classifyOwnership(filePath, ownershipConfig) {
  const ownershipMatches = ownershipKinds.filter((ownership) =>
    (ownershipConfig[ownership] ?? []).some((pattern) =>
      ownershipPatternsOverlap(filePath, pattern),
    ),
  );
  return {
    ownership:
      ownershipMatches.length === 1
        ? ownershipMatches[0]
        : ownershipMatches.length === 0
          ? "unclassified"
          : "ambiguous",
    ownership_matches: ownershipMatches,
  };
}

async function readOptionalJson(path) {
  if (!existsSync(path)) return null;
  return JSON.parse(await readFile(path, "utf8"));
}

function json(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export const WorkspaceCompilerError = OrganizationCompilerError;
