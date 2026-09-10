#!/usr/bin/env bun
// Kanonická lane pro založení root worktree (decisions 0049/0103/0112):
// worktree + branch + schema-validní sidecar jedním příkazem, aby worktrees
// vznikaly správně už konstrukcí a Launchpad/doctor s nimi uměly pracovat.
//
// Použití:
//   bun run worktrees:create -- --plan CAC-0085 [--branch agent/<basename>]
//     [--repository organizations/<Org-mount>]
//     [--purpose "..."] [--surface claude-code] [--agent-label "Claude Code"]
//     [--task-agent-id <opaque-id>] [--created-by <id>] [--dry-run]

import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { mkdir, readFile, readdir } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { hostname, userInfo } from "node:os";
import { trustedGitExecutable } from "./agent-skills-entrypoint.mjs";
import {
  parseWorktreeCreateArgs,
  PLAN_CODE_PATTERN,
} from "./worktree-create-contract.mjs";
import {
  allocateOwnedWorktreeBranch,
  rollbackCreatedWorktree,
  writeSidecarAtomically,
} from "./worktree-create-lib.mjs";
import {
  CHECKOUT_TRANSPORT_OVERRIDE_PATTERN,
  SAFE_WORKTREE_GIT_CONFIG,
  safeWorktreeGitEnvironment,
} from "./worktree-create-git-policy.mjs";
import {
  acquireCreateLock,
  releaseCreateLock,
} from "./worktree-create-lock.mjs";
import {
  hasRepositoryDbAuthorityMarker,
  readMissionControlRepositoryDbAuthority,
} from "./repository-db-authority-contract.mjs";
import { resolveTaskAgentLocator } from "../lazurio/core/task-agent-locator.mjs";
import { readOrganizationRoot } from "../lazurio/core/organization-root-reader-lib.mjs";
import {
  validateCanonicalMissionControlPlan,
} from "../.agents/skills/worktree-development-discipline/scripts/worktree-inventory.mjs";

let activeCreateLock = null;

function canonicalOwnedWorktreePath(path) {
  try {
    const entry = lstatSync(path);
    return entry.isDirectory() && !entry.isSymbolicLink() ? realpathSync(path) : null;
  } catch {
    return null;
  }
}

function fail(message) {
  throw new Error(message);
}

function git(cwd, args, { allowFail = false, useSafetyConfig = true } = {}) {
  const executable = trustedGitExecutable();
  if (!executable) fail("důvěryhodný Git executable nebyl nalezen.");
  const result = spawnSync(executable, [...(useSafetyConfig ? SAFE_WORKTREE_GIT_CONFIG : []), ...args], {
    cwd,
    encoding: "utf8",
    env: safeWorktreeGitEnvironment(),
    shell: false,
  });
  if (result.status !== 0 && !allowFail) {
    fail(`git ${args.join(" ")} selhalo: ${(result.stderr || "").trim()}`);
  }
  return {
    status: result.status,
    stdout: (result.stdout || "").trim(),
    stderr: (result.stderr || "").trim(),
  };
}

function normalizeExplicitAuthorityRoot(rawCandidate) {
  const candidate = resolve(rawCandidate);
  const repositoryDb = join(candidate, "mission-control", "db");
  if (hasRepositoryDbAuthorityMarker(candidate)) {
    return realpathSync(candidate);
  }
  if (hasRepositoryDbAuthorityMarker(repositoryDb)) {
    return realpathSync(repositoryDb);
  }
  return existsSync(candidate) ? realpathSync(candidate) : candidate;
}

async function resolveAuthorityRoot(primaryRoot, planCode) {
  if (process.env.MISSION_CONTROL_AUTHORITY_ROOT) {
    return normalizeExplicitAuthorityRoot(process.env.MISSION_CONTROL_AUTHORITY_ROOT);
  }

  const organizationsRoot = join(primaryRoot, "organizations");
  let entries = [];
  try {
    entries = await readdir(organizationsRoot, { withFileTypes: true });
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  const matches = [];
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = join(organizationsRoot, entry.name, "mission-control", "db");
    try {
      readMissionControlRepositoryDbAuthority(candidate);
    } catch {
      continue;
    }
    const plan = await findPlanFile(candidate, planCode);
    if (!plan) continue;
    const authorityPath = organizationAuthorityPath(primaryRoot, candidate);
    if (!authorityPath) continue;
    matches.push(candidate);
  }

  if (matches.length === 1) return realpathSync(matches[0]);
  if (matches.length > 1) {
    fail(
      `plán ${planCode} byl nalezen ve více Organization Mission Control autoritách: `
      + matches.join(", "),
    );
  }
  fail(
    `plán ${planCode} nebyl nalezen v žádné připojené Organization Mission Control autoritě; `
    + "připoj vlastnickou Organizaci nebo nastav MISSION_CONTROL_AUTHORITY_ROOT na její Organization root či mission-control/db.",
  );
}

function organizationAuthorityPath(primaryRoot, authorityRoot) {
  try {
    readMissionControlRepositoryDbAuthority(authorityRoot);
  } catch {
    return null;
  }
  const databaseRoot = resolve(authorityRoot);
  const missionControlRoot = dirname(databaseRoot);
  const organizationRoot = dirname(missionControlRoot);
  const organizationsRoot = dirname(organizationRoot);
  const owningRoot = dirname(organizationsRoot);
  const organizationName = basename(organizationRoot);
  if (!sameFilesystemEntry(primaryRoot, owningRoot)) return null;
  if (
    basename(databaseRoot) !== "db"
    || basename(missionControlRoot) !== "mission-control"
    || basename(organizationsRoot) !== "organizations"
    || !organizationName
    || organizationName === "."
    || organizationName === ".."
  ) {
    fail(
      `repository-db Mission Control authority ${authorityRoot} musí ležet v `
      + "organizations/<organization>/mission-control/db pod tímto Lazurio rootem.",
    );
  }
  const relativePath = `organizations/${organizationName}/mission-control/db`;
  let cursor = primaryRoot;
  for (const segment of relativePath.split("/")) {
    cursor = join(cursor, segment);
    const stat = lstatSync(cursor);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      fail("repository-db Mission Control authority obsahuje symlink nebo neadresářovou komponentu.");
    }
  }
  const canonicalOrganizationRoot = join(primaryRoot, "organizations", organizationName);
  const resolution = readOrganizationRoot({ organizationRoot: canonicalOrganizationRoot });
  if (
    !["legacy", "transition"].includes(resolution.state)
    || resolution.resource_count !== 1
  ) {
    fail(`Mission Control authority nemá mutation-safe Organization manifest (${resolution.state}; ${resolution.issues.join(", ") || "no stable resource"}).`);
  }
  if (resolution.resource.kind !== "organization") {
    fail("Mission Control authority musí vlastnit runtime Organization.");
  }
  return relativePath;
}

function sameFilesystemEntry(left, right) {
  try {
    const leftStat = lstatSync(left);
    const rightStat = lstatSync(right);
    if (leftStat.dev === rightStat.dev && leftStat.ino !== 0 && leftStat.ino === rightStat.ino) {
      return true;
    }
    const canonical = realpathSync.native ?? realpathSync;
    const leftPath = canonical(left);
    const rightPath = canonical(right);
    return process.platform === "win32"
      ? leftPath.toLocaleLowerCase("en-US") === rightPath.toLocaleLowerCase("en-US")
      : leftPath === rightPath;
  } catch {
    return false;
  }
}

function resolveRepositoryIdentity(primaryRoot) {
  // Read the declared endpoint, not its insteadOf expansion. A matching path
  // suffix or an embedded github.com hostname is not a GitHub origin.
  const remote = git(primaryRoot, ["config", "--local", "--get", "remote.origin.url"]);
  const match = remote.stdout.match(
    /^(?:git@github\.com:|ssh:\/\/(?:git@)?github\.com\/|https:\/\/github\.com\/)([A-Za-z0-9_-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/i,
  );
  if (!match || [".", ".."].includes(match[2])) {
    fail("origin musí být podporovaný GitHub origin (HTTPS nebo SSH), nikoli filesystem či jiný endpoint.");
  }
  const [, organization, repository] = match;
  return {
    remoteUrl: remote.stdout,
    organization,
    repository,
    module: repository.replace(/_GEN[0-9]+$/i, ""),
  };
}

function portableRelativePath(path) {
  return relative(path.root, path.target).split(sep).join("/");
}

function resolveEditRepository(lazurioRoot, rawRepository) {
  if (!rawRepository) {
    const identity = resolveRepositoryIdentity(lazurioRoot);
    return {
      root: lazurioRoot,
      identity,
      organizationPath: ".",
      modulePath: ".",
      module: identity.module,
      repoKind: "root_repo",
    };
  }
  if (
    rawRepository.includes("\\")
    || rawRepository.startsWith("/")
    || /^[A-Za-z]:[\\/]/.test(rawRepository)
    || !/^organizations\/[^/]+$/.test(rawRepository)
  ) {
    fail("--repository musí být portable cesta organizations/<organization> bez traversalu.");
  }
  let cursor = lazurioRoot;
  for (const segment of rawRepository.split("/")) {
    cursor = join(cursor, segment);
    let stat;
    try {
      stat = lstatSync(cursor);
    } catch {
      fail(`--repository neexistuje: ${rawRepository}`);
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      fail("--repository obsahuje symlink nebo neadresářovou komponentu.");
    }
  }
  const repositoryRoot = realpathSync(cursor);
  const rootRelative = portableRelativePath({ root: lazurioRoot, target: repositoryRoot });
  if (rootRelative !== rawRepository) {
    fail("--repository se musí přesně shodovat s kanonickou cestou Organization rootu.");
  }
  const resolution = readOrganizationRoot({ organizationRoot: repositoryRoot });
  if (
    !["legacy", "transition"].includes(resolution.state)
    || resolution.resource_count !== 1
    || resolution.resource?.kind !== "organization"
  ) {
    fail(`--repository nemá mutation-safe runtime Organization manifest (${resolution.state}).`);
  }
  const gitRoot = git(repositoryRoot, ["rev-parse", "--show-toplevel"], { allowFail: true });
  if (gitRoot.status !== 0 || !sameFilesystemEntry(repositoryRoot, gitRoot.stdout)) {
    fail("--repository musí být samostatný Git-backed Organization root.");
  }
  const identity = resolveRepositoryIdentity(repositoryRoot);
  const declaredFullName = resolution.resource.root_repository?.locator;
  const actualFullName = `${identity.organization}/${identity.repository}`;
  if (declaredFullName !== actualFullName) {
    fail(`--repository origin ${actualFullName} neodpovídá Organization manifestu ${String(declaredFullName)}.`);
  }
  const branch = git(repositoryRoot, ["symbolic-ref", "--short", "HEAD"], { allowFail: true });
  if (branch.status !== 0 || branch.stdout !== "main") {
    fail("--repository primary checkout musí být na main.");
  }
  if (git(repositoryRoot, ["status", "--porcelain=v1", "--untracked-files=all"]).stdout) {
    fail("--repository primary checkout musí být clean.");
  }
  const upstream = git(repositoryRoot, ["rev-parse", "--abbrev-ref", "@{upstream}"], { allowFail: true });
  if (upstream.status !== 0 || upstream.stdout !== "origin/main") {
    fail("--repository primary checkout musí sledovat origin/main.");
  }
  return {
    root: repositoryRoot,
    identity,
    organizationPath: rootRelative,
    modulePath: rootRelative,
    module: "root",
    repoKind: "organization_root",
    organization: resolution.resource.organization.slug,
  };
}

function checkoutTransportOverrideKeys(primaryRoot) {
  const keys = [];
  const worktreeConfig = git(
    primaryRoot,
    ["config", "--local", "--get", "extensions.worktreeConfig"],
    { allowFail: true, useSafetyConfig: false },
  );
  const scopes = ["--local"];
  if (worktreeConfig.status === 0 && worktreeConfig.stdout.toLowerCase() === "true") {
    scopes.push("--worktree");
  }
  for (const scope of scopes) {
    const overrides = git(primaryRoot, [
      "config", scope,
      "--name-only",
      "--get-regexp",
      CHECKOUT_TRANSPORT_OVERRIDE_PATTERN,
    ], { allowFail: true, useSafetyConfig: false });
    if (overrides.status === 1) continue;
    if (overrides.status !== 0) {
      fail(`${scope} transportní konfiguraci nelze bezpečně ověřit: ${overrides.stderr}`);
    }
    keys.push(...overrides.stdout.split("\n").filter(Boolean));
  }
  return [...new Set(keys)];
}

async function findPlanFile(authorityRoot, planCode) {
  const planRoots = [
    join(authorityRoot, "data", "mission-control", "plans"),
  ];
  const matches = [];
  for (const planRoot of planRoots) {
    if (!existsSync(planRoot)) continue;
    const stack = [planRoot];
    while (stack.length > 0) {
      const current = stack.pop();
      const entries = await readdir(current, { withFileTypes: true });
      entries.sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        const entryPath = join(current, entry.name);
        if (entry.isDirectory()) {
          stack.push(entryPath);
        } else if (
          entry.name.endsWith(".yaml")
          && (entry.name === `${planCode}.yaml` || entry.name.startsWith(`${planCode}-`))
        ) {
          matches.push(entryPath);
        }
      }
    }
  }
  matches.sort((left, right) => left.localeCompare(right));
  if (matches.length > 1) {
    throw new Error(
      `plán ${planCode} má více kanonických kandidátů: ${matches.join(", ")}`,
    );
  }
  if (matches.length === 0) return null;
  return {
    path: matches[0],
    relative: relative(authorityRoot, matches[0]).split(sep).join("/"),
  };
}

async function main({ remoteGit = git } = {}) {
  let options;
  try {
    options = parseWorktreeCreateArgs(process.argv.slice(2));
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  const planCode = options.plan;
  if (!planCode || !PLAN_CODE_PATTERN.test(planCode)) {
    fail("--plan <KOD-XXXX> je povinný (kód vlastnického Mission Control plánu).");
  }

  const lazurioRoot = git(process.cwd(), ["rev-parse", "--show-toplevel"]).stdout;
  if (!existsSync(join(lazurioRoot, "launchpad.gen3.json"))) {
    fail(`${lazurioRoot} nevypadá jako Lazurio root (chybí launchpad.gen3.json).`);
  }
  if (lazurioRoot.split("/").includes(".worktrees")) {
    fail("spouštěj z primárního checkoutu, ne z linked worktree.");
  }

  const editRepository = resolveEditRepository(lazurioRoot, options.repository);
  const primaryRoot = editRepository.root;

  const authorityRoot = await resolveAuthorityRoot(lazurioRoot, planCode);
  const authorityPath = organizationAuthorityPath(lazurioRoot, authorityRoot);
  if (!authorityPath) {
    fail(
      "nový worktree vyžaduje Mission Control authority v "
      + "organizations/<organization>/mission-control/db pod tímto Lazurio rootem; "
      + "externí authority je podporovaná jen jako explicitní compatibility vstup inventury legacy sidecarů.",
    );
  }
  let plan;
  try {
    plan = await findPlanFile(authorityRoot, planCode);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  if (!plan) {
    fail(
      `plán ${planCode} nebyl nalezen ve zvolené Organization Mission Control autoritě ${authorityRoot}; `
      + "worktree bez vlastnického Mission Control plánu je orphan/invalid (decision 0049).",
    );
  }
  let planSource;
  let planData;
  try {
    planSource = await readFile(plan.path, "utf8");
    planData = Bun.YAML.parse(planSource);
  } catch (error) {
    fail(`plán ${plan.relative} nejde načíst: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!planData || typeof planData !== "object" || Array.isArray(planData)) {
    fail(`plán ${plan.relative} nemá objektový YAML kořen.`);
  }
  const planValidation = await validateCanonicalMissionControlPlan(
    authorityRoot,
    plan.path,
    planSource,
    planData,
  );
  if (!planValidation.valid) {
    fail(`plán ${plan.relative} neprošel kanonickou validací: ${planValidation.error}`);
  }
  if (planData.dev_code !== planCode) {
    fail(`plán ${plan.relative} deklaruje dev_code ${String(planData.dev_code)}, očekáváno ${planCode}.`);
  }
  const planBasename = basename(plan.path, ".yaml");
  const worktreePath = join(primaryRoot, ".worktrees", "root", planBasename);
  const sidecarPath = join(primaryRoot, ".worktrees", "root", `${planBasename}.worktree.json`);
  const branch = options.branch ?? `agent/${planBasename}`;
  if (!branch.includes(planCode)) {
    fail(`branch ${branch} neobsahuje kód plánu ${planCode}.`);
  }

  const createLockPath = join(lazurioRoot, ".worktrees", ".worktree-create.lock");
  await mkdir(dirname(createLockPath), { recursive: true });
  const acquiredLock = await acquireCreateLock({
    lockPath: createLockPath,
    primaryRoot,
    branch,
    planCode,
  });
  if (!acquiredLock.ok) {
    fail(`jiná worktree create operace blokuje create lane: ${acquiredLock.message}.`);
  }
  activeCreateLock = acquiredLock.lock;

  if (existsSync(worktreePath)) fail(`worktree už existuje: ${worktreePath}`);
  // Osiřelý sidecar bez worktree může nést recovery handoff přerušené práce —
  // nikdy ho tiše nepřepisuj.
  if (existsSync(sidecarPath)) fail(`sidecar už existuje: ${sidecarPath}; zkontroluj jeho recovery_handoff a odstraň ho vědomě.`);
  const identity = editRepository.identity;
  const revalidateOrganizationCheckout = () => {
    if (editRepository.repoKind !== "organization_root") return;
    const current = resolveEditRepository(lazurioRoot, options.repository);
    if (current.identity.remoteUrl !== identity.remoteUrl
      || current.organization !== editRepository.organization) {
      fail("--repository origin nebo Organization identita se během create preflightu změnily.");
    }
    const overrides = checkoutTransportOverrideKeys(primaryRoot);
    if (overrides.length > 0) {
      fail("--repository primary checkout změnil transportní konfiguraci během create preflightu.");
    }
  };
  const transportOverrides = checkoutTransportOverrideKeys(primaryRoot);
  if (transportOverrides.length > 0) {
    fail(
      "checkout-local transportní konfigurace je zakázaná pro worktree create: "
      + `${transportOverrides.join(", ")}. Odstraň ji vědomě před spuštěním.`,
    );
  }
  const resolvedRemote = git(primaryRoot, ["ls-remote", "--get-url", identity.remoteUrl]);
  if (resolvedRemote.stdout !== identity.remoteUrl) {
    fail(
      `origin URL přepisuje globální url.*.insteadOf (${identity.remoteUrl} -> ${resolvedRemote.stdout}); `
      + "create lane vyžaduje exact endpoint, credential helper a proxy zůstávají podporované.",
    );
  }
  if (editRepository.repoKind === "organization_root") {
    const remoteMain = remoteGit(primaryRoot, ["ls-remote", identity.remoteUrl, "refs/heads/main"]);
    const remoteHead = remoteMain.stdout.split(/\s+/)[0];
    const localHead = git(primaryRoot, ["rev-parse", "HEAD"]).stdout;
    if (!/^[0-9a-f]{40,64}$/i.test(remoteHead) || remoteHead !== localHead) {
      fail("--repository primary checkout musí být přesně aktuální vůči remote main.");
    }
  }
  const now = new Date().toISOString();
  const explicitTaskAgentId = options["task-agent-id"] ?? options["thread-id"] ?? null;
  const taskAgentLocator = resolveTaskAgentLocator({
    environment: process.env,
    id: explicitTaskAgentId,
    surface: options.surface ?? null,
  });
  if (!taskAgentLocator.id) {
    fail(
      "Task Agent task/thread/session ID není dostupné. Codex poskytuje CODEX_THREAD_ID/CODEX_SESSION_ID, "
      + "Claude Code CLAUDE_CODE_SESSION_ID. Cursor a ostatní harnessy musí předat "
      + "--task-agent-id <id> --surface <slug> nebo LAZURIO_TASK_AGENT_ID společně s "
      + "LAZURIO_TASK_AGENT_SURFACE.",
    );
  }
  if (!taskAgentLocator.surface) {
    fail(
      "Recovery locator nemá harness surface. Předej --surface <slug> nebo "
      + "LAZURIO_TASK_AGENT_SURFACE; samotné opaque ID není mezi harnessy jednoznačné.",
    );
  }
  const machineRef = (process.env.LAZURIO_MACHINE_REF ?? hostname()).trim();
  if (!machineRef || machineRef.length > 255 || /[\0\r\n]/.test(machineRef)) {
    fail("LAZURIO_MACHINE_REF musí být neprázdný jednořádkový lokální label do 255 znaků.");
  }
  const sidecar = {
    schema_version: "companiesascode.worktree.v1",
    organization: editRepository.organization ?? identity.organization,
    organization_path: editRepository.organizationPath,
    workspace: "root",
    module: editRepository.module,
    module_path: editRepository.modulePath,
    repo_kind: editRepository.repoKind,
    base_branch: "main",
    branch,
    mission_control_plan_code: planCode,
    ...(authorityPath ? { mission_control_authority_path: authorityPath } : {}),
    mission_control_plan_path: plan.relative,
    worktree_path: editRepository.repoKind === "root_repo"
      ? `.worktrees/root/${planBasename}`
      : `${editRepository.organizationPath}/.worktrees/root/${planBasename}`,
    created_at: now,
    created_by: options["created-by"] ?? `${taskAgentLocator.surface}-for-${userInfo().username}@${hostname()}`,
    last_touched: now,
    status: "active",
    pr_url: null,
    purpose: options.purpose ?? `Práce na plánu ${planCode} (${planBasename}).`,
    conversation_origin: {
      machine_ref: machineRef,
      surface: taskAgentLocator.surface,
      agent_label: options["agent-label"] ?? "Task Agent",
      thread_id: taskAgentLocator.id,
      thread_locator_status: "captured",
      local_only: true,
      captured_at: now,
    },
    recovery_handoff: {
      state: "in_progress",
      summary: `Worktree založen lane worktrees:create pro plán ${planCode}.`,
      blocker: null,
      next_action: "Pracuj podle skillu worktree-development-discipline: průběžně commituj a pushuj, po prvním pushi otevři Draft PR.",
      updated_at: now,
    },
    cleanup_rule:
      "Remove only after the pull request is merged or explicitly abandoned, the tree is clean, the exact HEAD is preserved remotely, no runtime uses the path, and no active writer remains.",
  };

  if (options.dryRun) {
    revalidateOrganizationCheckout();
    console.log(`ok - dry-run: plán ${plan.relative}`);
    console.log(`ok - dry-run: worktree ${worktreePath}`);
    console.log(`ok - dry-run: branch ${branch} z origin/main`);
    console.log(`ok - dry-run: sidecar ${sidecarPath}`);
    return;
  }

  remoteGit(primaryRoot, [
    "fetch",
    identity.remoteUrl,
    "+refs/heads/main:refs/remotes/origin/main",
  ]);
  await mkdir(dirname(worktreePath), { recursive: true });
  // The remote calls and filesystem await above allow another writer to change
  // the checkout. Re-read all Organization preconditions at the mutation gate.
  revalidateOrganizationCheckout();
  if (
    editRepository.repoKind === "organization_root"
    && git(primaryRoot, ["rev-parse", "HEAD"]).stdout
      !== git(primaryRoot, ["rev-parse", "origin/main"]).stdout
  ) {
    fail("--repository primary checkout se během create preflightu rozešel s origin/main.");
  }
  const branchAllocation = allocateOwnedWorktreeBranch({
    git,
    primaryRoot,
    branch,
    baseRef: "origin/main",
  });
  if (!branchAllocation.ok) {
    fail(`branch ${branch} nelze bezpečně alokovat: ${branchAllocation.message}. Nic se nemaže bez ownership důkazu.`);
  }
  const worktreeAdd = git(primaryRoot, ["worktree", "add", worktreePath, branch], { allowFail: true });
  if (worktreeAdd.status !== 0) {
    const rollbackReport = rollbackCreatedWorktree({
      git,
      primaryRoot,
      worktreePath,
      canonicalWorktreePath: canonicalOwnedWorktreePath(worktreePath),
      worktreeCreated: false,
      branch,
      ownerMarker: branchAllocation.ownerMarker,
      branchHead: branchAllocation.branchHead,
      pathExists: existsSync,
    });
    fail(`git worktree add selhalo: ${worktreeAdd.stderr || "bez stderr"}; ${rollbackReport}.`);
  }
  try {
    const sidecarWrite = await writeSidecarAtomically({
      sidecarPath,
      contents: `${JSON.stringify(sidecar, null, 2)}\n`,
    });
    if (sidecarWrite.stagingCleanupError) {
      console.error(
        `warn - worktrees:create: sidecar ${sidecarPath} je platně publikovaný, ale staging soubor ${sidecarWrite.stagingPath} `
        + "nelze odstranit; worktree zůstává platný, dokonči úklid staging souboru vědomě.",
      );
    }
  } catch (error) {
    // Bez sidecaru by worktree zůstal orphan a blokoval čistý retry.
    // Prokázaný worktree vrať zpět; owned branch zachovej a příští create ji
    // idempotentně reuse-ne. Ref deletion nelze atomicky svázat s Git worktree
    // registry a mohl by smazat branch právě připojenou jiným aktérem.
    const rollbackReport = rollbackCreatedWorktree({
      git,
      primaryRoot,
      worktreePath,
      canonicalWorktreePath: canonicalOwnedWorktreePath(worktreePath),
      branch,
      ownerMarker: branchAllocation.ownerMarker,
      branchHead: branchAllocation.branchHead,
      pathExists: existsSync,
      stagingPath: error?.stagingPath,
      stagingCleanupError: error?.stagingCleanupError,
    });
    fail(`zápis sidecaru selhal (${error instanceof Error ? error.message : error}); ${rollbackReport}.`);
  }

  console.log(`ok - worktree: ${worktreePath}`);
  console.log(`ok - branch: ${branch} (base origin/main)`);
  console.log(`ok - sidecar: ${sidecarPath}`);
  console.log("next - ověř `bun run worktrees:check`; pracuj podle skillu worktree-development-discipline.");
}

// Explicit dependency injection keeps local fixture transports outside the CLI.
// Callers cannot enable it through checkout configuration or environment flags.
export async function runWorktreeCreate(dependencies = {}) {
  try {
    await main(dependencies);
  } finally {
    const released = await releaseCreateLock(activeCreateLock);
    if (activeCreateLock && !released.released) {
      console.error(
        `warn - worktrees:create: námi vlastněný create lock nelze bezpečně uvolnit (${released.reason}).`,
      );
    }
    activeCreateLock = null;
  }
}

if (import.meta.main) {
  try {
    await runWorktreeCreate();
  } catch (error) {
    console.error(`fail - worktrees:create: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
