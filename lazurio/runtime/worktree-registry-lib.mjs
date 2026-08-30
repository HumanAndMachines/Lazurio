import { existsSync, realpathSync } from "fs";
import { readFile } from "fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "path";

import { createTrustedGitHubProvider } from "../core/github-provider-lib.mjs";
import { githubRepositoryCoordinate } from "../core/organization-slot-scope-lib.mjs";
import {
  GIT_LOCAL_TIMEOUT_MS,
  mapWithConcurrency,
  runGit,
} from "./git-lib.mjs";
import { readGitRepoStatus } from "./git-status-lib.mjs";

const OWNER_INSPECTION_CONCURRENCY = 8;
const WORKTREE_INSPECTION_CONCURRENCY = 8;
const GITHUB_GRAPHQL_BATCH_SIZE = 20;

export async function buildRegisteredWorktreeIndex({
  companiesRoot,
  repos = [],
  includeRoot = true,
  refreshPullRequests = false,
  githubProvider = null,
  now = () => new Date(),
} = {}) {
  if (!companiesRoot) throw new Error("buildRegisteredWorktreeIndex requires companiesRoot");
  const root = canonicalPath(resolve(companiesRoot));
  const ownerCandidates = [
    ...(includeRoot ? [{
      key: "lazurio::root",
      organization: "HumanAndMachines",
      organization_path: ".",
      module: "Lazurio",
      repo_kind: "root_repo",
      absolute_path: root,
      expected_branch: "main",
      remote: null,
    }] : []),
    ...repos,
  ].filter((repo) => typeof repo?.absolute_path === "string" && existsSync(repo.absolute_path));

  const inspectedOwners = await mapWithConcurrency(
    ownerCandidates,
    OWNER_INSPECTION_CONCURRENCY,
    (owner) => inspectOwnerRegistry(owner),
  );
  const ownerErrors = inspectedOwners
    .filter((owner) => !owner.ok)
    .map((owner) => ({
      owner_key: owner.owner.key,
      owner_path: owner.owner.absolute_path,
      error: owner.error,
    }));
  const uniqueOwners = deduplicateOwnerRegistries(inspectedOwners.filter((owner) => owner.ok));
  const projectionRoot = uniqueOwners.find((owner) => owner.owner.key === "lazurio::root")
    ?.primary_path ?? root;
  const registered = uniqueOwners.flatMap((owner) =>
    owner.records
      .filter((record) => !samePath(record.path, owner.primary_path))
      .map((record) => ({ owner, record })),
  );
  let worktrees = await mapWithConcurrency(
    registered,
    WORKTREE_INSPECTION_CONCURRENCY,
    ({ owner, record }) => inspectRegisteredWorktree({ root: projectionRoot, owner, record }),
  );

  if (refreshPullRequests) {
    worktrees = await refreshGitHubEvidence(worktrees, {
      provider: githubProvider ?? createTrustedGitHubProvider({ cwd: root }),
      now,
    });
  }
  worktrees = worktrees.map((worktree) => ({
    ...worktree,
    cleanup_dry_run: classifyWorktreeCleanup(worktree, {
      refreshRequested: refreshPullRequests,
    }),
  }));

  return {
    schema_version: "lazurio.registered_worktrees.v1",
    generated_at: now().toISOString(),
    refresh_prs_requested: refreshPullRequests,
    owner_candidates: ownerCandidates.length,
    owner_registries: uniqueOwners.length,
    primary_checkouts: uniqueOwners.length,
    worktrees,
    owner_errors: ownerErrors,
    summary: {
      registered_worktrees: worktrees.length,
      canonical: worktrees.filter((worktree) => worktree.path_class.startsWith("canonical_")).length,
      organization_environment: worktrees.filter((worktree) => worktree.path_class === "organization_environment").length,
      invalid_legacy: worktrees.filter((worktree) => worktree.path_class === "invalid_legacy").length,
      external: worktrees.filter((worktree) => worktree.path_class === "external").length,
      dirty: worktrees.filter((worktree) => worktree.dirty === true).length,
      missing: worktrees.filter((worktree) => !worktree.exists).length,
      cleanup_candidates: worktrees.filter(
        (worktree) => worktree.cleanup_dry_run.classification === "candidate",
      ).length,
      cleanup_needs_attention: worktrees.filter(
        (worktree) => worktree.cleanup_dry_run.classification === "needs_attention",
      ).length,
      cleanup_active: worktrees.filter(
        (worktree) => worktree.cleanup_dry_run.classification === "active",
      ).length,
      cleanup_not_refreshed: worktrees.filter(
        (worktree) => worktree.cleanup_dry_run.classification === "not_refreshed",
      ).length,
    },
  };
}

async function inspectOwnerRegistry(owner) {
  const topLevel = await runGit(["rev-parse", "--show-toplevel"], {
    cwd: owner.absolute_path,
    timeoutMs: GIT_LOCAL_TIMEOUT_MS,
  });
  const prefix = await runGit(["rev-parse", "--show-prefix"], {
    cwd: owner.absolute_path,
    timeoutMs: GIT_LOCAL_TIMEOUT_MS,
  });
  // Git owns the repository boundary. Comparing the two path strings is not
  // portable on Windows, where tmpdir may expose an 8.3 alias while Git emits
  // the long spelling of the same directory. An empty Git prefix proves that
  // the inspected directory itself is the checkout root without relying on
  // either spelling.
  if (!topLevel.ok || !prefix.ok || prefix.stdout !== "") {
    return {
      ok: false,
      owner,
      error: topLevel.error
        || topLevel.stderr
        || prefix.error
        || prefix.stderr
        || "owner path is not the Git toplevel",
    };
  }
  const commonDirResult = await runGit(
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    { cwd: owner.absolute_path, timeoutMs: GIT_LOCAL_TIMEOUT_MS },
  );
  if (!commonDirResult.ok || !commonDirResult.stdout) {
    return {
      ok: false,
      owner,
      error: commonDirResult.error || commonDirResult.stderr || "Git common-dir is unavailable",
    };
  }
  const commonDirPath = isAbsolute(commonDirResult.stdout)
    ? resolve(commonDirResult.stdout)
    : resolve(owner.absolute_path, commonDirResult.stdout);
  const commonDir = canonicalPath(commonDirPath);
  const registryResult = await runGit(
    ["--git-dir", commonDir, "worktree", "list", "--porcelain", "-z"],
    { cwd: owner.absolute_path, timeoutMs: GIT_LOCAL_TIMEOUT_MS },
  );
  if (!registryResult.ok) {
    return {
      ok: false,
      owner,
      error: registryResult.error || registryResult.stderr || "Git worktree registry is unavailable",
    };
  }
  const remoteUrlResult = await runGit(["remote", "get-url", "origin"], {
    cwd: owner.absolute_path,
    timeoutMs: GIT_LOCAL_TIMEOUT_MS,
  });
  const githubRepository = owner.remote?.url_kind === "github"
    ? owner.remote.owner_repo
    : githubRepositoryCoordinate(remoteUrlResult.ok ? remoteUrlResult.stdout : null)?.ownerRepo ?? null;
  const records = parseGitWorktreePorcelain(registryResult.stdout);
  const primaryPath = records[0]?.path ? canonicalPath(records[0].path) : null;
  if (!primaryPath) {
    return {
      ok: false,
      owner,
      error: "Git worktree registry has no primary checkout",
    };
  }
  return {
    ok: true,
    owner: {
      ...owner,
      absolute_path: canonicalPath(topLevel.stdout),
      github_repository: githubRepository,
    },
    common_dir: commonDir,
    primary_path: primaryPath,
    records,
  };
}

function deduplicateOwnerRegistries(owners) {
  const byCommonDir = new Map();
  for (const owner of owners) {
    const commonDirIdentity = normalizeWorktreePathIdentity(owner.common_dir);
    const existing = byCommonDir.get(commonDirIdentity);
    if (!existing) {
      byCommonDir.set(commonDirIdentity, owner);
      continue;
    }
    existing.owner_aliases ??= [];
    existing.owner_aliases.push(owner.owner.key);
  }
  return [...byCommonDir.values()];
}

async function inspectRegisteredWorktree({ root, owner, record }) {
  const absolutePath = resolve(record.path);
  const exists = existsSync(absolutePath);
  const gitIdentity = exists ? await readGitWorktreeIdentity(absolutePath) : null;
  const sidecarPath = join(dirname(absolutePath), `${basename(absolutePath)}.worktree.json`);
  const pathClass = classifyRegisteredWorktreePath({
    companiesRoot: root,
    ownerRoot: owner.primary_path,
    worktreePath: absolutePath,
  });
  const sidecarBase = pathClass === "organization_environment"
    && typeof owner.owner.organization_path === "string"
    ? join(root, owner.owner.organization_path)
    : owner.primary_path;
  const sidecar = await readSidecarHint({
    path: sidecarPath,
    ownerRoot: sidecarBase,
    worktreePath: absolutePath,
    branch: record.branch,
  });
  const localStatus = exists
    ? await readGitRepoStatus({
        key: `${owner.owner.key}::${absolutePath}`,
        absolute_path: absolutePath,
        expected_branch: record.branch ?? owner.owner.expected_branch ?? "main",
        remote: owner.owner.remote ?? null,
      })
    : null;
  const baseBranch = sidecar.metadata?.base_branch
    ?? owner.owner.expected_branch
    ?? "main";
  const baseHeadResult = exists
    ? await runGit(["rev-parse", "--verify", `origin/${baseBranch}`], {
        cwd: absolutePath,
        timeoutMs: GIT_LOCAL_TIMEOUT_MS,
      })
    : null;
  const relativePath = relative(root, absolutePath);
  const insideRoot = relativePath === ""
    || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
  const path = insideRoot ? relativePath.replaceAll(sep, "/") : absolutePath;
  const localStatusKnown = localStatus
    && !["repo_missing", "git_unavailable", "check_failed"].includes(localStatus.status);
  return {
    registry_id: `${owner.common_dir}\0${absolutePath}`,
    git_identity: gitIdentity,
    registered: true,
    owner_key: owner.owner.key,
    owner_path: owner.primary_path,
    owner_common_dir: owner.common_dir,
    owner_repo_kind: owner.owner.repo_kind ?? null,
    organization: owner.owner.organization ?? null,
    organization_path: owner.owner.organization_path ?? null,
    module: owner.owner.module ?? null,
    github_repository: owner.owner.github_repository,
    path,
    absolute_path: absolutePath,
    path_class: pathClass,
    head: record.head,
    branch: record.branch,
    detached: record.detached,
    locked: record.locked,
    prunable: record.prunable,
    exists,
    sidecar_path: insideRoot
      ? relative(root, sidecarPath).replaceAll(sep, "/")
      : sidecarPath,
    sidecar_exists: sidecar.exists,
    sidecar_hint_valid: sidecar.valid,
    sidecar_hint_error: sidecar.error,
    sidecar_metadata: sidecar.metadata,
    local_status: localStatus,
    local_status_known: Boolean(localStatusKnown),
    dirty: localStatusKnown ? localStatus.counts.changed_files > 0 : null,
    outgoing: localStatusKnown ? localStatus.counts.outgoing : null,
    incoming: localStatusKnown ? localStatus.counts.incoming : null,
    upstream: localStatusKnown ? localStatus.upstream : null,
    operation: localStatusKnown ? localStatus.operation : null,
    base_branch: baseBranch,
    base_head: baseHeadResult?.ok ? baseHeadResult.stdout : null,
    github_evidence: null,
  };
}

async function readSidecarHint({ path, ownerRoot, worktreePath, branch }) {
  if (!existsSync(path)) return { exists: false, valid: false, error: "missing", metadata: null };
  let metadata;
  try {
    metadata = JSON.parse(await readFile(path, "utf8"));
  } catch {
    return { exists: true, valid: false, error: "invalid_json", metadata: null };
  }
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return { exists: true, valid: false, error: "invalid_shape", metadata: null };
  }
  for (const field of [
    "schema_version",
    "branch",
    "mission_control_plan_code",
    "mission_control_plan_path",
    "worktree_path",
  ]) {
    if (typeof metadata[field] !== "string" || metadata[field].trim() === "") {
      return { exists: true, valid: false, error: `missing_${field}`, metadata };
    }
  }
  if (metadata.schema_version !== "companiesascode.worktree.v1") {
    return { exists: true, valid: false, error: "unsupported_schema", metadata };
  }
  if (metadata.branch !== branch) {
    return { exists: true, valid: false, error: "branch_mismatch", metadata };
  }
  const declaredPath = isAbsolute(metadata.worktree_path)
    ? resolve(metadata.worktree_path)
    : resolve(ownerRoot, metadata.worktree_path);
  if (!samePath(declaredPath, worktreePath)) {
    return { exists: true, valid: false, error: "worktree_path_mismatch", metadata };
  }
  return { exists: true, valid: true, error: null, metadata };
}

export function parseGitWorktreePorcelain(output) {
  const nulTerminated = output.includes("\0");
  const blocks = nulTerminated
    ? output.split("\0\0")
    : output.trim().split(/\n\s*\n/u);
  return blocks
    .filter(Boolean)
    .map((block) => {
      const record = {
        path: null,
        head: null,
        branch: null,
        detached: false,
        locked: false,
        prunable: false,
      };
      for (const line of block.split(nulTerminated ? "\0" : "\n").filter(Boolean)) {
        const [key, ...rest] = line.split(" ");
        const value = rest.join(" ");
        if (key === "worktree") record.path = value;
        else if (key === "HEAD") record.head = value;
        else if (key === "branch") record.branch = value.replace(/^refs\/heads\//u, "");
        else if (key === "detached") record.detached = true;
        else if (key === "locked") record.locked = value || true;
        else if (key === "prunable") record.prunable = value || true;
      }
      return record;
    })
    .filter((record) => record.path);
}

export function classifyRegisteredWorktreePath({ companiesRoot, ownerRoot, worktreePath }) {
  const target = resolve(worktreePath);
  if (isDirectChild(join(companiesRoot, ".worktrees", "root"), target)) {
    return "canonical_root";
  }
  if (isDirectChild(join(ownerRoot, ".worktrees", "root"), target)) {
    return "canonical_owner";
  }
  const normalized = target.replaceAll("\\", "/");
  if (/\/organizations\/[^/]+\/\.worktrees\/(?:root|workspace|productionspace)\//u.test(normalized)) {
    return "organization_environment";
  }
  if (
    /\/(?:\.claude\/worktrees|\.codex-tmp|\.pr-worktrees|\.worktrees\/(?:modules|root-repos))(?:\/|$)/u
      .test(normalized)
  ) {
    return "invalid_legacy";
  }
  return "external";
}

export function classifyWorktreeCleanup(worktree, { refreshRequested = false } = {}) {
  const blockers = [];
  if (!worktree.exists) blockers.push("registered_path_missing");
  if (worktree.prunable) blockers.push("registry_entry_prunable");
  if (worktree.locked) blockers.push("worktree_locked");
  if (worktree.detached || !worktree.branch) blockers.push("detached_head");
  if (!worktree.local_status_known) blockers.push("local_git_state_unknown");
  if (worktree.dirty === true) blockers.push("dirty_worktree");
  if ((worktree.outgoing ?? 0) > 0) blockers.push("local_only_commits");
  if (worktree.operation) blockers.push(`git_operation_${worktree.operation.kind ?? "active"}`);
  if (!worktree.sidecar_exists) blockers.push("sidecar_missing");
  else if (!worktree.sidecar_hint_valid) blockers.push("sidecar_identity_invalid");
  if (blockers.length > 0) {
    return cleanupAssessment("needs_attention", blockers, "resolve_local_blockers");
  }
  if (!refreshRequested) {
    return cleanupAssessment(
      "not_refreshed",
      ["github_pr_evidence_not_refreshed"],
      "run_doctor_with_refresh_prs",
    );
  }
  const evidence = worktree.github_evidence;
  if (!evidence || evidence.status !== "fresh") {
    return cleanupAssessment(
      "needs_attention",
      [evidence?.reason ?? "github_pr_evidence_unavailable"],
      "restore_github_access_and_refresh",
    );
  }
  const pullRequest = evidence.pull_request;
  if (pullRequest?.state === "OPEN") {
    return cleanupAssessment("active", ["exact_head_pr_open"], "continue_or_finish_pull_request");
  }
  if (pullRequest?.state === "MERGED" && evidence.head_preserved) {
    return cleanupAssessment(
      "candidate",
      [],
      "recheck_runtime_writer_and_remove_with_git_worktree",
      { apply_guards_required: ["runtime_not_using_path", "no_active_writer"] },
    );
  }
  if (pullRequest?.state === "CLOSED") {
    return cleanupAssessment(
      "needs_attention",
      ["exact_head_pr_closed_without_merge"],
      "preserve_snapshot_or_mark_explicitly_abandoned",
    );
  }
  if (evidence.remote_branch_exists && evidence.remote_branch_head === worktree.head) {
    return cleanupAssessment("active", ["exact_head_remote_branch_exists"], "continue_or_open_pull_request");
  }
  if (
    evidence.remote_branch_exists === false
    && worktree.base_head
    && worktree.head === worktree.base_head
  ) {
    return cleanupAssessment(
      "candidate",
      [],
      "recheck_runtime_writer_and_remove_with_git_worktree",
      {
        reason: "deleted_branch_without_changes",
        apply_guards_required: ["runtime_not_using_path", "no_active_writer"],
      },
    );
  }
  if (evidence.remote_branch_exists === false) {
    return cleanupAssessment(
      "needs_attention",
      ["remote_branch_deleted_without_exact_merged_pr"],
      "preserve_exact_head_before_cleanup",
    );
  }
  return cleanupAssessment(
    "needs_attention",
    ["exact_head_pr_state_unknown"],
    "inspect_pull_request_and_remote_head",
  );
}

function cleanupAssessment(classification, blockers, nextAction, extra = {}) {
  return {
    classification,
    blockers,
    next_action: nextAction,
    ...extra,
  };
}

async function refreshGitHubEvidence(worktrees, { provider, now }) {
  const eligible = worktrees.filter((worktree) =>
    validGitHubRepository(worktree.github_repository)
    && typeof worktree.head === "string"
    && /^[0-9a-f]{40,64}$/iu.test(worktree.head)
    && typeof worktree.branch === "string"
    && worktree.branch !== "",
  );
  const evidence = new Map();
  for (let offset = 0; offset < eligible.length; offset += GITHUB_GRAPHQL_BATCH_SIZE) {
    const batch = eligible.slice(offset, offset + GITHUB_GRAPHQL_BATCH_SIZE);
    const aliases = batch.map((worktree, index) => ({
      alias: `q${index}`,
      worktree,
    }));
    if (!provider.available) {
      for (const { worktree } of aliases) {
        evidence.set(worktree.registry_id, unavailableGitHubEvidence("github_cli_unavailable"));
      }
      continue;
    }
    const response = provider.json(["api", "graphql", "-f", `query=${githubEvidenceQuery(aliases)}`]);
    if (!response.ok || !response.value?.data) {
      const reason = response.error?.kind === "http" && response.httpStatus === 401
        ? "github_auth_required"
        : "github_refresh_failed";
      for (const { worktree } of aliases) {
        evidence.set(worktree.registry_id, unavailableGitHubEvidence(reason));
      }
      continue;
    }
    const checkedAt = now().toISOString();
    for (const { alias, worktree } of aliases) {
      const repository = response.value.data[alias];
      if (!repository) {
        evidence.set(worktree.registry_id, unavailableGitHubEvidence("github_repository_unavailable"));
        continue;
      }
      const pullRequests = repository.object?.associatedPullRequests?.nodes ?? [];
      const exactPullRequests = pullRequests.filter((pullRequest) =>
        pullRequest?.headRefOid === worktree.head
      );
      const pullRequest = choosePullRequest(exactPullRequests);
      const remoteBranchHead = repository.ref?.target?.oid ?? null;
      evidence.set(worktree.registry_id, {
        status: "fresh",
        reason: null,
        checked_at: checkedAt,
        repository: worktree.github_repository,
        object_present: repository.object?.oid === worktree.head,
        remote_branch_exists: Boolean(repository.ref),
        remote_branch_head: remoteBranchHead,
        head_preserved: remoteBranchHead === worktree.head || Boolean(pullRequest),
        pull_request: pullRequest
          ? {
              number: pullRequest.number,
              url: pullRequest.url,
              state: pullRequest.state,
              merged_at: pullRequest.mergedAt ?? null,
              closed_at: pullRequest.closedAt ?? null,
              draft: pullRequest.isDraft,
              base: pullRequest.baseRefName,
              head_branch: pullRequest.headRefName,
              head: pullRequest.headRefOid,
            }
          : null,
      });
    }
  }
  return worktrees.map((worktree) => ({
    ...worktree,
    github_evidence: evidence.get(worktree.registry_id)
      ?? unavailableGitHubEvidence(
        validGitHubRepository(worktree.github_repository)
          ? "github_evidence_input_invalid"
          : "github_repository_not_supported",
      ),
  }));
}

function githubEvidenceQuery(aliases) {
  const fields = aliases.map(({ alias, worktree }) => {
    const [owner, name] = worktree.github_repository.split("/");
    return `${alias}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) {
      object(expression: ${JSON.stringify(worktree.head)}) {
        ... on Commit {
          oid
          associatedPullRequests(first: 100) {
            nodes {
              number
              url
              state
              mergedAt
              closedAt
              isDraft
              baseRefName
              headRefName
              headRefOid
            }
          }
        }
      }
      ref(qualifiedName: ${JSON.stringify(`refs/heads/${worktree.branch}`)}) {
        target { oid }
      }
    }`;
  });
  return `query WorktreePullRequestEvidence {\n${fields.join("\n")}\n}`;
}

function choosePullRequest(pullRequests) {
  const rank = { MERGED: 0, OPEN: 1, CLOSED: 2 };
  return [...pullRequests].sort((left, right) => {
    const stateRank = (rank[left.state] ?? 9) - (rank[right.state] ?? 9);
    if (stateRank !== 0) return stateRank;
    const baseRank = Number(right.baseRefName === "main") - Number(left.baseRefName === "main");
    if (baseRank !== 0) return baseRank;
    return (right.number ?? 0) - (left.number ?? 0);
  })[0] ?? null;
}

function unavailableGitHubEvidence(reason) {
  return {
    status: "unavailable",
    reason,
    checked_at: null,
    repository: null,
    object_present: null,
    remote_branch_exists: null,
    remote_branch_head: null,
    head_preserved: false,
    pull_request: null,
  };
}

function validGitHubRepository(value) {
  return typeof value === "string"
    && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(value);
}

function isDirectChild(parent, child) {
  const value = relative(resolve(parent), resolve(child));
  return value !== ""
    && !value.startsWith("..")
    && !isAbsolute(value)
    && !value.includes(sep);
}

function samePath(left, right) {
  return normalizeWorktreePathIdentity(canonicalPath(left))
    === normalizeWorktreePathIdentity(canonicalPath(right));
}

export async function readGitWorktreeIdentity(path) {
  const result = await runGit(["rev-parse", "--absolute-git-dir"], {
    cwd: path,
    timeoutMs: GIT_LOCAL_TIMEOUT_MS,
  });
  return result.ok && result.stdout
    ? normalizeWorktreePathIdentity(result.stdout)
    : null;
}

export function normalizeWorktreePathIdentity(path, { platform = process.platform } = {}) {
  const normalized = String(path ?? "")
    .replaceAll("\\", "/")
    .replace(/\/+$/u, "");
  return platform === "win32" ? normalized.toLowerCase() : normalized;
}

function canonicalPath(path) {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}
