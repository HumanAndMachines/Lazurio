import { existsSync } from "fs";
import { lstat, readFile, readdir } from "fs/promises";
import { basename, join, relative } from "path";
import { buildGitInventory } from "./git-inventory-lib.mjs";
import { readGitRepoStatus } from "./git-status-lib.mjs";
import { readMissionControlPlanAt } from "./mission-control-plan-lib.mjs";
import { inspectCanonicalPathBoundary } from "../core/path-boundary-lib.mjs";

const invalidWorktreeLocations = [
  ".claude/worktrees",
  ".codex-tmp",
  ".pr-worktrees",
  ".worktrees/modules",
  ".worktrees/root-repos",
];

const invalidLocationScanDepth = 3;
const invalidLocationEntryBudget = 200;

export async function buildWorktreeIndex({
  companiesRoot,
  organization = null,
  inventoryOrganizations = null,
  module = null,
} = {}) {
  if (!companiesRoot) throw new Error("buildWorktreeIndex requires companiesRoot");
  const inventory = await buildGitInventory({
    companiesRoot,
    organizations: inventoryOrganizations,
  });
  const organizations = uniqueOrganizations(inventory.repos).filter((org) => !organization || org.slug === organization);
  const worktrees = [];
  const invalid_locations = [];
  const warnings = [];

  if (organization === null) {
    invalid_locations.push(...await scanInvalidWorktreeLocations({
      companiesRoot,
      scopeRoot: companiesRoot,
      organization: null,
      scope: "root",
    }));
  }

  for (const org of organizations) {
    const organizationRoot = join(companiesRoot, org.path);
    if (!existsSync(organizationRoot)) continue;
    invalid_locations.push(...await scanInvalidWorktreeLocations({
      companiesRoot,
      scopeRoot: organizationRoot,
      organization: org.slug,
      scope: "organization",
    }));
    const scanned = await scanCanonicalOrganizationWorktrees({ companiesRoot, organization: org });
    for (const worktree of scanned) {
      if (module && worktree.module !== module) continue;
      worktrees.push(worktree);
    }
  }

  for (const worktree of worktrees) {
    if (!worktree.metadata) continue;
    for (const message of detectNonCanonicalSidecarFields(worktree.metadata)) {
      warnings.push({
        organization: worktree.organization,
        slug: worktree.slug,
        path: worktree.sidecar_path,
        level: "warning",
        message,
      });
    }
  }

  return {
    schema_version: "companiesascode.launchpad.worktrees.v1",
    generated_at: new Date().toISOString(),
    worktrees,
    invalid_locations,
    warnings,
  };
}

async function scanInvalidWorktreeLocations({ companiesRoot, scopeRoot, organization, scope }) {
  const records = [];
  for (const invalidLocation of invalidWorktreeLocations) {
    const absolutePath = join(scopeRoot, invalidLocation);
    const diagnosis = await describeInvalidWorktreeLocation({ companiesRoot, absolutePath });
    if (!diagnosis) continue;
    records.push({
      organization,
      scope,
      path: relative(companiesRoot, absolutePath).replace(/\\/g, "/") || ".",
      status: "invalid",
      message: diagnosis.message,
      details: diagnosis.details,
    });
  }
  return records;
}

async function describeInvalidWorktreeLocation({ companiesRoot, absolutePath }) {
  try {
    const location = await lstat(absolutePath);
    if (location.isSymbolicLink()) {
      return {
        message: "Nepovolená legacy worktree cesta je symlink. Doctor jeho cíl neotevřel ani nezměnil.",
        details: [
          "state: symlink",
          "agent_action: ověř provenance a odstraň případně pouze přesný symlink, nikdy jeho cíl",
        ],
      };
    }
    if (!location.isDirectory()) {
      return {
        message: "Nepovolená legacy worktree cesta není adresář. Doctor ji nezměnil.",
        details: [
          `state: ${location.isFile() ? "file" : "other"}`,
          "agent_action: ověř provenance přesné položky; neodstraňuj ji odhadem",
        ],
      };
    }
    const entries = await readdir(absolutePath);
    if (entries.length === 0) {
      return {
        message: "Prázdná nepovolená legacy worktree složka. Doctor ji nezměnil.",
        details: [
          "state: empty",
          "entries: 0",
          "agent_action: prázdnou přesnou cestu lze odstranit pomocí rmdir; nikdy nepoužívej rekurzivní mazání",
        ],
      };
    }
    const inspection = await inspectInvalidLocationGitCheckouts({ companiesRoot, absolutePath });
    return {
      message: `Nepovolené legacy umístění obsahuje data (${inspection.git_checkouts.length} Git checkoutů nalezeno). Doctor nic neodstranil.`,
      details: [
        "state: non_empty",
        `entries: ${entries.length}`,
        `git_checkouts: ${inspection.git_checkouts.length}`,
        `scan_truncated: ${inspection.scan_truncated}`,
        ...inspection.git_checkouts.map(formatInvalidLocationCheckout),
        inspection.git_checkouts.length > 0
          ? "agent_action: ověř přesný owner Git registry, PR/remote zachování, runtime a active writera podle worktree-development-discipline; teprve potom použij git worktree remove"
          : "agent_action: ověř provenance všech položek a bezpečně zachovej případnou práci; Doctor tuto cestu neuklízí",
      ],
    };
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    return {
      message: "Nepovolenou legacy worktree cestu nelze bezpečně načíst. Doctor ji nezměnil.",
      details: [
        "state: unreadable",
        `error: ${error instanceof Error ? error.message : String(error)}`,
        "agent_action: oprav přístup nebo provenance a spusť Doctor znovu; neodstraňuj cestu odhadem",
      ],
    };
  }
}

async function inspectInvalidLocationGitCheckouts({ companiesRoot, absolutePath }) {
  const gitCheckouts = [];
  const queue = [{ path: absolutePath, depth: 0 }];
  let visited = 0;
  let scanTruncated = false;
  while (queue.length > 0) {
    const current = queue.shift();
    if (visited >= invalidLocationEntryBudget) {
      scanTruncated = true;
      break;
    }
    visited += 1;
    if (current.path !== absolutePath && existsSync(join(current.path, ".git"))) {
      const status = await readGitRepoStatus({
        key: relative(companiesRoot, current.path).replace(/\\/g, "/"),
        absolute_path: current.path,
      });
      gitCheckouts.push({
        path: relative(companiesRoot, current.path).replace(/\\/g, "/"),
        branch: status.branch,
        head: status.head?.sha ?? null,
        upstream: status.upstream,
        operation: status.operation?.kind ?? null,
        changed_files: status.counts?.changed_files ?? null,
        untracked_files: status.counts?.untracked_files ?? null,
        outgoing: status.counts?.outgoing ?? null,
      });
      continue;
    }
    if (current.depth >= invalidLocationScanDepth) continue;
    for (const entry of await safeReaddir(current.path)) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      queue.push({ path: join(current.path, entry.name), depth: current.depth + 1 });
    }
  }
  return {
    git_checkouts: gitCheckouts,
    scan_truncated: scanTruncated,
  };
}

function formatInvalidLocationCheckout(checkout) {
  const branch = checkout.branch ?? "detached-or-unknown";
  const head = checkout.head ?? "unknown";
  const upstream = checkout.upstream ?? "none";
  const operation = checkout.operation ?? "none";
  return `git_checkout: ${checkout.path} — branch=${branch}; head=${head}; upstream=${upstream}; changed_files=${checkout.changed_files ?? "unknown"}; untracked_files=${checkout.untracked_files ?? "unknown"}; outgoing=${checkout.outgoing ?? "unknown"}; operation=${operation}`;
}

async function scanCanonicalOrganizationWorktrees({ companiesRoot, organization }) {
  const organizationRoot = join(companiesRoot, organization.path);
  const output = [];
  let realOrganizationRoot = null;
  let scanResult = await scanTwoLevelWorktrees({
    companiesRoot,
    organization,
    organizationRoot,
    rootRealPath: realOrganizationRoot,
    base: join(organizationRoot, ".worktrees", "workspace"),
    workspace: "workspace",
    repoKind: "module",
    output,
  });
  realOrganizationRoot = scanResult.realOrganizationRoot;
  scanResult = await scanTwoLevelWorktrees({
    companiesRoot,
    organization,
    organizationRoot,
    rootRealPath: realOrganizationRoot,
    base: join(organizationRoot, ".worktrees", "productionspace"),
    workspace: "productionspace",
    repoKind: "productionspace",
    output,
  });
  realOrganizationRoot = scanResult.realOrganizationRoot;
  await scanRootWorktrees({
    companiesRoot,
    organization,
    organizationRoot,
    rootRealPath: realOrganizationRoot,
    base: join(organizationRoot, ".worktrees", "root"),
    output,
  });
  return output;
}

async function scanTwoLevelWorktrees({
  companiesRoot,
  organization,
  organizationRoot,
  rootRealPath,
  base,
  workspace,
  repoKind,
  output,
}) {
  const baseBoundary = await existingWorktreePathBoundary({
    organizationRoot,
    rootRealPath,
    path: base,
  });
  if (!baseBoundary.ok) return { realOrganizationRoot: baseBoundary.rootRealPath };
  for (const moduleEntry of await safeReaddir(base)) {
    if (!moduleEntry.isDirectory()) continue;
    const module = moduleEntry.name;
    const moduleRoot = join(base, module);
    const moduleBoundary = await existingWorktreePathBoundary({
      organizationRoot,
      rootRealPath: baseBoundary.rootRealPath,
      path: moduleRoot,
    });
    if (!moduleBoundary.ok) continue;
    for (const worktreeEntry of await safeReaddir(moduleRoot)) {
      if (!worktreeEntry.isDirectory()) continue;
      const absolutePath = join(moduleRoot, worktreeEntry.name);
      const worktreeBoundary = await existingWorktreePathBoundary({
        organizationRoot,
        rootRealPath: moduleBoundary.rootRealPath,
        path: absolutePath,
      });
      if (!worktreeBoundary.ok) continue;
      output.push(await buildWorktreeRecord({
        companiesRoot,
        organization,
        organizationRoot,
        rootRealPath: worktreeBoundary.rootRealPath,
        absolutePath,
        sidecarPath: join(moduleRoot, `${worktreeEntry.name}.worktree.json`),
        workspace,
        module,
        repoKind,
      }));
    }
  }
  return { realOrganizationRoot: baseBoundary.rootRealPath };
}

async function scanRootWorktrees({
  companiesRoot,
  organization,
  organizationRoot,
  rootRealPath,
  base,
  output,
}) {
  const baseBoundary = await existingWorktreePathBoundary({
    organizationRoot,
    rootRealPath,
    path: base,
  });
  if (!baseBoundary.ok) return { realOrganizationRoot: baseBoundary.rootRealPath };
  for (const entry of await safeReaddir(base)) {
    if (!entry.isDirectory()) continue;
    const path = join(base, entry.name);
    const pathBoundary = await existingWorktreePathBoundary({
      organizationRoot,
      rootRealPath: baseBoundary.rootRealPath,
      path,
    });
    if (!pathBoundary.ok) continue;
    if (await isGitCheckout(path)) {
      output.push(await buildWorktreeRecord({
        companiesRoot,
        organization,
        organizationRoot,
        rootRealPath: pathBoundary.rootRealPath,
        absolutePath: path,
        sidecarPath: join(base, `${entry.name}.worktree.json`),
        workspace: "root",
        module: "root",
        repoKind: "organization_root",
      }));
      continue;
    }
    for (const child of await safeReaddir(path)) {
      if (!child.isDirectory()) continue;
      const childPath = join(path, child.name);
      const childBoundary = await existingWorktreePathBoundary({
        organizationRoot,
        rootRealPath: pathBoundary.rootRealPath,
        path: childPath,
      });
      if (!childBoundary.ok) continue;
      output.push(await buildWorktreeRecord({
        companiesRoot,
        organization,
        organizationRoot,
        rootRealPath: childBoundary.rootRealPath,
        absolutePath: childPath,
        sidecarPath: join(path, `${child.name}.worktree.json`),
        workspace: "root",
        module: entry.name,
        repoKind: "root_repo",
      }));
    }
  }
  return { realOrganizationRoot: baseBoundary.rootRealPath };
}

async function buildWorktreeRecord({
  companiesRoot,
  organization,
  organizationRoot,
  rootRealPath,
  absolutePath,
  sidecarPath,
  workspace,
  module,
  repoKind,
}) {
  const slug = basename(absolutePath);
  const base = {
    slug,
    organization: organization.slug,
    organization_path: organization.path,
    workspace,
    module,
    repo_kind: repoKind,
    path: relative(companiesRoot, absolutePath).replace(/\\/g, "/"),
    sidecar_path: relative(companiesRoot, sidecarPath).replace(/\\/g, "/"),
    branch: null,
    plan_code: null,
    owner_plan: null,
  };

  if (!existsSync(sidecarPath)) {
    return {
      ...base,
      ownership_status: "orphan_missing_plan",
      status: "orphan_missing_plan",
      message: "Worktree nemá sidecar metadata s Mission Control vlastníkem.",
    };
  }
  const sidecarBoundary = await existingWorktreePathBoundary({
    organizationRoot,
    rootRealPath,
    path: sidecarPath,
  });
  if (!sidecarBoundary.ok) {
    return {
      ...base,
      ownership_status: "invalid",
      status: "invalid",
      message: "Worktree sidecar se přes symlink/junction dostává mimo root Organizace.",
    };
  }

  let metadata;
  try {
    metadata = JSON.parse(await readFile(sidecarPath, "utf8"));
  } catch (error) {
    return {
      ...base,
      ownership_status: "invalid",
      status: "invalid",
      message: `Sidecar metadata nejdou přečíst: ${error.message}`,
    };
  }

  const validationErrors = validateWorktreeMetadata(metadata);
  if (validationErrors.length > 0) {
    return {
      ...base,
      metadata,
      branch: metadata.branch ?? null,
      plan_code: metadata.mission_control_plan_code ?? metadata.plan_code ?? null,
      ownership_status: "orphan_missing_plan",
      status: "orphan_missing_plan",
      message: validationErrors.join("; "),
    };
  }

  const planPath = metadata.mission_control_plan_path;
  const ownerPlan = await readMissionControlPlanAt({ companiesRoot, organizationPath: organization.path, planPath });
  if (!ownerPlan) {
    return {
      ...base,
      metadata,
      branch: metadata.branch,
      plan_code: metadata.mission_control_plan_code,
      ownership_status: "orphan_missing_file",
      status: "orphan_missing_file",
      message: `Mission Control plán neexistuje: ${planPath}`,
    };
  }

  const lifecycleStatus = deriveWorktreeLifecycleStatus(metadata);
  return {
    ...base,
    metadata,
    branch: metadata.branch,
    plan_code: metadata.mission_control_plan_code,
    owner_plan: {
      code: ownerPlan.code,
      path: ownerPlan.organization_relative_path,
      title: ownerPlan.title,
      status: ownerPlan.status,
    },
    ownership_status: "owned",
    status: lifecycleStatus,
    message: `Owned by ${ownerPlan.code} — ${ownerPlan.title}`,
  };
}

async function existingWorktreePathBoundary({
  organizationRoot,
  rootRealPath,
  path,
}) {
  if (!existsSync(path)) {
    return { ok: false, rootRealPath };
  }
  return inspectCanonicalPathBoundary({
    rootPath: organizationRoot,
    rootRealPath,
    targetPath: path,
  });
}

// Kanonické enumy z schemas/worktree.schema.json (companiesascode.worktree.v1).
// Držené inline (stejně jako schema_version const níže), aby runtime scan
// nemusel načítat/parsovat JSON schema při každém indexu.
const CANONICAL_REPO_KINDS = new Set(["module", "organization_root", "root_repo", "productionspace"]);
const CANONICAL_STATUSES = new Set([
  "active",
  "draft",
  "published_branch",
  "pr_open",
  "merged_cleanup_needed",
  "stale",
  "orphan_missing_plan",
  "invalid",
]);

// Schema-shape warning (decision 0049 kanonický kontrakt): non-fatal signál, že
// sidecar používá nekanonická / legacy pole (např. plan_code místo
// mission_control_plan_code, repo_kind "root" mimo enum). Jen upozorní
// buildera/Doctor, ať sidecar sladí — NIKDY neblokuje ownership resolve
// (na to je fail-closed validateWorktreeMetadata níže).
export function detectNonCanonicalSidecarFields(metadata) {
  const warnings = [];
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return warnings;
  if (metadata.plan_code && !metadata.mission_control_plan_code) {
    warnings.push("Nekanonické pole plan_code — kanonický klíč je mission_control_plan_code.");
  }
  if (metadata.owner && !metadata.created_by) {
    warnings.push("Nekanonické pole owner bez created_by — kanonický autor je created_by.");
  }
  if (metadata.repo_kind && !CANONICAL_REPO_KINDS.has(metadata.repo_kind)) {
    warnings.push(`repo_kind "${metadata.repo_kind}" není v kanonickém enumu (${[...CANONICAL_REPO_KINDS].join(", ")}).`);
  }
  if (metadata.status && !CANONICAL_STATUSES.has(metadata.status)) {
    warnings.push(`status "${metadata.status}" není v kanonickém enumu (${[...CANONICAL_STATUSES].join(", ")}).`);
  }
  if (!metadata.conversation_origin) {
    warnings.push("Sidecar nemá conversation_origin; doplň lokální agent surface a thread locator při nejbližším bezpečném dotyku.");
  } else if (
    typeof metadata.conversation_origin.surface !== "string"
    || typeof metadata.conversation_origin.agent_label !== "string"
    || !["captured", "unavailable", "not_applicable"].includes(metadata.conversation_origin.thread_locator_status)
    || metadata.conversation_origin.local_only !== true
  ) {
    warnings.push("conversation_origin nemá kanonický tvar.");
  } else if (
    typeof metadata.conversation_origin.machine_ref !== "string"
    || metadata.conversation_origin.machine_ref.trim() === ""
  ) {
    warnings.push("conversation_origin nemá machine_ref; legacy sidecar doplň při nejbližším bezpečném dotyku.");
  }
  if (!metadata.recovery_handoff) {
    warnings.push("Sidecar nemá recovery_handoff; doplň stav, summary, blocker a next action před pauzou nebo předáním.");
  } else if (
    typeof metadata.recovery_handoff.state !== "string"
    || typeof metadata.recovery_handoff.summary !== "string"
    || typeof metadata.recovery_handoff.next_action !== "string"
  ) {
    warnings.push("recovery_handoff nemá kanonický tvar.");
  }
  return warnings;
}

// Runtime záměrně validuje jen minimum kanonického kontraktu (schema_version,
// branch, mission_control_plan_code, mission_control_plan_path), NE celý JSON
// schema z schemas/worktree.schema.json. Důvod: (1) tolerance vůči starším /
// ručně psaným sidecarům, které ještě nemají všechna kanonická pole — nechceme
// je celé shodit z indexu jen kvůli chybějícímu module_path/base_branch;
// (2) tato čtveřice je přesně to, co drží fail-closed ownership resolve
// (bez branch + plan code/path nejde bezpečně dohledat vlastnický Mission
// Control plán, takže bez nich je worktree orphan a runtime se z něj nespustí).
// Úplnou schema-shape kontrolu dělá schema (writer path createWorktreeFromPlan +
// test) a non-fatal detectNonCanonicalSidecarFields() výše; kontrakt (enumy,
// nové statusy) se mění jen přes decision, ne tichým zpřísněním tady.
function validateWorktreeMetadata(metadata) {
  const errors = [];
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return ["Sidecar metadata musí být object."];
  }
  if (metadata.schema_version !== "companiesascode.worktree.v1") errors.push("schema_version musí být companiesascode.worktree.v1");
  if (typeof metadata.branch !== "string" || metadata.branch.trim() === "") errors.push("branch chybí");
  if (typeof metadata.mission_control_plan_code !== "string" || metadata.mission_control_plan_code.trim() === "") {
    errors.push("mission_control_plan_code chybí");
  }
  if (typeof metadata.mission_control_plan_path !== "string" || metadata.mission_control_plan_path.trim() === "") {
    errors.push("mission_control_plan_path chybí");
  }
  return errors;
}

function deriveWorktreeLifecycleStatus(metadata) {
  return metadata.status ?? "active";
}

async function isGitCheckout(path) {
  return existsSync(join(path, ".git"));
}

async function safeReaddir(path) {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch {
    return [];
  }
}

function uniqueOrganizations(repos) {
  const bySlug = new Map();
  for (const repo of repos) {
    if (!bySlug.has(repo.organization)) bySlug.set(repo.organization, { slug: repo.organization, path: repo.organization_path });
  }
  return [...bySlug.values()];
}
