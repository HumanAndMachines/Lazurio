import { existsSync } from "node:fs";
import { lstat, opendir, realpath, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep, win32 } from "node:path";
import {
  inspectDirectoryWithinCanonicalBoundary,
  readFileWithinCanonicalBoundary,
} from "../../lazurio/core/path-boundary-lib.mjs";

const BUN_LOCKFILES = Object.freeze(["bun.lock", "bun.lockb"]);
const PACKAGE_LOCKFILES = Object.freeze([
  ...BUN_LOCKFILES,
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
]);
const NODE_MODULES_RECOVERY = ".lazurio-node_modules-recovery";
const LOCAL_DEPENDENCY_TREE_ENTRY_LIMIT = 20_000;

export function frozenBunInstallCommand(bunExecutable = process.execPath) {
  return [bunExecutable, "install", "--frozen-lockfile"];
}

export async function runFrozenBunInstall({
  cwd,
  boundaryRoot,
  organizationDependencyRoot = null,
  mode = "ensure",
  command = frozenBunInstallCommand(),
  spawnProcess = Bun.spawn,
  env = process.env,
  beforeFinalReadback = null,
} = {}) {
  const packageRoot = await validatePackageRoot({ cwd, boundaryRoot, organizationDependencyRoot });
  if (!packageRoot.ok) return unchangedFailure(packageRoot, mode);
  if (!Array.isArray(command) || command.length === 0) {
    return unchangedFailure({ ok: false, reason: "install_command_missing", detail: "Chybí příkaz pro instalaci balíčků." }, mode);
  }
  if (!new Set(["ensure", "clean"]).has(mode)) {
    return unchangedFailure({ ok: false, reason: "install_mode_invalid", detail: `Neplatný dependency install režim ${JSON.stringify(mode)}.` }, mode);
  }

  const recoveryPath = join(packageRoot.cwd, NODE_MODULES_RECOVERY);
  if (mode === "ensure" && existsSync(recoveryPath)) {
    const recovery = await regularDirectory(recoveryPath, "node_modules recovery");
    if (!recovery.ok) return recovery;
    const currentState = await pinnedRuntimeTreeState(packageRoot);
    return {
      ok: false,
      reason: "node_modules_recovery_pending",
      detail: "Předchozí čistá oprava zůstala nedokončená; Lazurio ji musí bezpečně obnovit a zopakovat.",
      mode,
      removed_node_modules: false,
      runtime_tree_usable: currentState.runtime_tree_usable,
    };
  }

  let removedNodeModules = false;
  if (mode === "clean") {
    const prepared = await prepareCleanInstall(packageRoot.cwd);
    if (!prepared.ok) {
      const currentState = await pinnedRuntimeTreeState(packageRoot);
      return {
        ...prepared,
        mode,
        removed_node_modules: false,
        runtime_tree_usable: currentState.runtime_tree_usable,
      };
    }
    removedNodeModules = prepared.had_previous_tree;
  }

  let installResult;
  try {
    // Clean mode may have moved node_modules since the initial validation.
    // Reconfirm the exact manifest + lock bytes immediately before handing
    // lifecycle authority to Bun; a concurrent checkout refresh must not turn
    // an earlier validation into permission to execute different source.
    const preSpawnAuthority = await verifyInstallAuthority(packageRoot.authority_snapshot);
    if (!preSpawnAuthority.ok) {
      installResult = {
        ok: false,
        reason: preSpawnAuthority.reason,
        detail: preSpawnAuthority.detail,
        exit_code: null,
        stdout: "",
        stderr: "",
        command,
        mode,
        removed_node_modules: removedNodeModules,
        runtime_tree_usable: mode === "ensure" ? false : null,
      };
    } else {
      const child = spawnProcess(command, {
        cwd: packageRoot.cwd,
        env,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        windowsHide: true,
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        child.stdout ? new Response(child.stdout).text() : "",
        child.stderr ? new Response(child.stderr).text() : "",
        child.exited,
      ]);
      const authorityState = await verifyInstallAuthority(packageRoot.authority_snapshot);
      if (!authorityState.ok) {
        installResult = {
          ok: false,
          reason: authorityState.reason,
          detail: authorityState.detail,
          exit_code: exitCode,
          stdout,
          stderr,
          command,
          mode,
          removed_node_modules: removedNodeModules,
          runtime_tree_usable: mode === "ensure" ? false : null,
        };
      } else if (exitCode !== 0) {
        installResult = {
          ok: false,
          reason: "dependency_install_failed",
          detail: stderr.trim() || stdout.trim() || `Instalace balíčků skončila kódem ${exitCode}.`,
          exit_code: exitCode,
          stdout,
          stderr,
          command,
          mode,
          removed_node_modules: removedNodeModules,
          runtime_tree_usable: mode === "ensure" ? false : null,
        };
      } else {
        // Completeness is evaluated against the exact package.json bytes that
        // authorized the install, never against a newly read manifest which
        // could silently shrink the required set while the child is running.
        const dependencyState = await inspectCanonicalRequiredDependencies({
          cwd: packageRoot.cwd,
          boundaryRoot: packageRoot.boundary_root,
          organizationDependencyRoot: packageRoot.organization_dependency_root,
          packageJson: packageRoot.package_json,
          localDependencyAuthorities: packageRoot.local_dependency_authorities,
        });
        if (!dependencyState.ok) {
          installResult = {
            ok: false,
            reason: dependencyState.reason,
            detail: dependencyState.detail,
            exit_code: exitCode,
            stdout,
            stderr,
            command,
            mode,
            removed_node_modules: removedNodeModules,
            runtime_tree_usable: mode === "ensure" ? false : null,
            missing_required_dependencies: dependencyState.missing_required_dependencies,
          };
        } else if (dependencyState.missing_required_dependencies.length > 0) {
          const visibleNames = dependencyState.missing_required_dependencies.slice(0, 5).join(", ");
          const remainingCount = dependencyState.missing_required_dependencies.length - 5;
          const suffix = remainingCount > 0 ? ` a ${remainingCount} dalších` : "";
          installResult = {
            ok: false,
            reason: "dependency_install_incomplete",
            detail: `Instalace skončila bez chyby, ale stále chybí povinné balíčky: ${visibleNames}${suffix}.`,
            exit_code: exitCode,
            stdout,
            stderr,
            command,
            mode,
            removed_node_modules: removedNodeModules,
            runtime_tree_usable: mode === "ensure" ? false : null,
            missing_required_dependencies: dependencyState.missing_required_dependencies,
          };
        } else {
          const finalAuthority = await verifyInstallAuthority(packageRoot.authority_snapshot);
          installResult = finalAuthority.ok
            ? {
                ok: true,
                exit_code: exitCode,
                stdout,
                stderr,
                command,
                mode,
                removed_node_modules: removedNodeModules,
                runtime_tree_usable: true,
                missing_required_dependencies: [],
              }
            : {
                ok: false,
                reason: finalAuthority.reason,
                detail: finalAuthority.detail,
                exit_code: exitCode,
                stdout,
                stderr,
                command,
                mode,
                removed_node_modules: removedNodeModules,
                runtime_tree_usable: mode === "ensure" ? false : null,
                missing_required_dependencies: [],
              };
        }
      }
    }
  } catch (error) {
    installResult = {
      ok: false,
      reason: "dependency_install_spawn_failed",
      detail: error instanceof Error ? error.message : String(error),
      command,
      mode,
      removed_node_modules: removedNodeModules,
      runtime_tree_usable: mode === "ensure" ? false : null,
    };
  }

  if (mode !== "clean") return installResult;
  if (installResult.ok) {
    // This is the commit point for a clean repair: keep the quarantined tree
    // until the original authority is still exact immediately before discard.
    const commitAuthority = await verifyInstallAuthority(packageRoot.authority_snapshot);
    if (!commitAuthority.ok) {
      installResult = {
        ...installResult,
        ok: false,
        reason: commitAuthority.reason,
        detail: commitAuthority.detail,
        runtime_tree_usable: null,
      };
    }
  }
  const finalized = installResult.ok
    ? await discardPreviousTree(packageRoot.cwd)
    : await restorePreviousTree(packageRoot.cwd);
  if (!finalized.ok) {
    const currentState = await pinnedRuntimeTreeState(packageRoot);
    return {
      ...installResult,
      ok: false,
      reason: finalized.reason,
      detail: `${installResult.detail ? `${installResult.detail} ` : ""}${finalized.detail}`.trim(),
      rollback_ok: false,
      runtime_tree_usable: currentState.runtime_tree_usable,
    };
  }
  // Deterministic race-test seam. Production callers omit it; it deliberately
  // sits after cleanup/rollback and before the last authority + tree readback.
  if (beforeFinalReadback) await beforeFinalReadback();
  const finalState = await pinnedRuntimeTreeState(packageRoot);
  if (installResult.ok && !finalState.runtime_tree_usable) {
    const finalFailure = finalRuntimeTreeFailure(finalState);
    return {
      ...installResult,
      ok: false,
      reason: finalFailure.reason,
      detail: finalFailure.detail,
      rollback_ok: null,
      runtime_tree_usable: false,
      missing_required_dependencies:
        finalState.dependency_state.missing_required_dependencies
        ?? installResult.missing_required_dependencies
        ?? [],
    };
  }
  return {
    ...installResult,
    rollback_ok: installResult.ok ? null : true,
    runtime_tree_usable: finalState.runtime_tree_usable
      && (installResult.ok || installResult.reason !== "dependency_authority_changed"),
  };
}

function finalRuntimeTreeFailure(finalState) {
  if (!finalState.authority_state.ok) {
    return {
      reason: finalState.authority_state.reason ?? "dependency_authority_changed",
      detail: finalState.authority_state.detail
        ?? "Dependency autorita se před finálním přijetím výsledku změnila.",
    };
  }
  if (!finalState.dependency_state.ok) {
    return {
      reason: finalState.dependency_state.reason ?? "dependency_tree_inspection_failed",
      detail: finalState.dependency_state.detail
        ?? "Finální dependency strom nejde bezpečně ověřit.",
    };
  }
  const names = finalState.dependency_state.missing_required_dependencies ?? [];
  return {
    reason: "dependency_install_incomplete",
    detail: `Finální kontrola dependency stromu našla chybějící povinné balíčky: ${names.join(", ")}.`,
  };
}

export async function refreshFrozenBunDependencies(options = {}) {
  const ensured = await runFrozenBunInstall({ ...options, mode: "ensure" });
  if (ensured.ok) {
    return { ...ensured, refresh_strategy: "ensure" };
  }
  if (!["dependency_install_failed", "dependency_install_incomplete", "node_modules_recovery_pending"].includes(ensured.reason)) {
    return {
      ...ensured,
      refresh_strategy: "ensure_failed",
      ensure_failure: {
        reason: ensured.reason ?? null,
        detail: ensured.detail ?? null,
        exit_code: ensured.exit_code ?? null,
      },
    };
  }
  const repaired = await runFrozenBunInstall({ ...options, mode: "clean" });
  return {
    ...repaired,
    refresh_strategy: repaired.ok ? "clean_repair" : "clean_repair_failed",
    ensure_failure: {
      reason: ensured.reason ?? null,
      detail: ensured.detail ?? null,
      exit_code: ensured.exit_code ?? null,
    },
  };
}

async function validatePackageRoot({ cwd, boundaryRoot, organizationDependencyRoot = null }) {
  if (
    !cwd
    || !boundaryRoot
    || !isAbsolute(cwd)
    || !isAbsolute(boundaryRoot)
    || (organizationDependencyRoot !== null && !isAbsolute(organizationDependencyRoot))
  ) {
    return { ok: false, reason: "package_root_invalid", detail: "Dependency install vyžaduje absolutní package a boundary cestu." };
  }
  let canonicalBoundary;
  let canonicalCwd;
  let canonicalOrganizationDependencyRoot;
  try {
    [canonicalBoundary, canonicalCwd, canonicalOrganizationDependencyRoot] = await Promise.all([
      realpath(boundaryRoot),
      realpath(cwd),
      realpath(organizationDependencyRoot ?? boundaryRoot),
    ]);
  } catch (error) {
    const missing = ["ENOENT", "ENOTDIR"].includes(error?.code);
    return {
      ok: false,
      reason: missing ? "package_root_unavailable" : "package_root_inspection_failed",
      detail: `Package root nejde bezpečně otevřít: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const pathFromBoundary = relative(canonicalBoundary, canonicalCwd);
  if (pathFromBoundary === ".." || pathFromBoundary.startsWith(`..${sep}`) || isAbsolute(pathFromBoundary)) {
    return { ok: false, reason: "package_root_outside_boundary", detail: "Package root leží mimo owning checkout." };
  }
  if (!pathInsideBoundary(canonicalOrganizationDependencyRoot, canonicalBoundary)) {
    return {
      ok: false,
      reason: "dependency_tree_boundary_invalid",
      detail: "Owning checkout neleží uvnitř zvolené Organization dependency hranice.",
    };
  }
  const packagePath = join(canonicalCwd, "package.json");
  if (!existsSync(packagePath)) {
    return { ok: false, reason: "package_json_missing", detail: "V package rootu chybí package.json." };
  }
  const lockfile = BUN_LOCKFILES.find((name) => existsSync(join(canonicalCwd, name))) ?? null;
  if (!lockfile) {
    return { ok: false, reason: "bun_lockfile_missing", detail: "V package rootu chybí Bun lockfile." };
  }
  const authoritySnapshot = await captureInstallAuthority({
    cwd: canonicalCwd,
    boundaryRoot: canonicalBoundary,
    organizationDependencyRoot: canonicalOrganizationDependencyRoot,
    lockfile,
  });
  if (!authoritySnapshot.ok) return authoritySnapshot;
  const declaredManager = declaredPackageManagerName(authoritySnapshot.package_json);
  if (declaredManager && declaredManager !== "bun") {
    return {
      ok: false,
      reason: "package_manager_lockfile_mismatch",
      detail: `packageManager ${declaredManager} neodpovídá zvolenému ${lockfile}; Lazurio nespustí Bun instalaci odhadem.`,
    };
  }
  const dependencyState = await inspectCanonicalRequiredDependencies({
    cwd: canonicalCwd,
    boundaryRoot: canonicalBoundary,
    organizationDependencyRoot: canonicalOrganizationDependencyRoot,
    packageJson: authoritySnapshot.package_json,
    localDependencyAuthorities: authoritySnapshot.local_dependency_authorities,
  });
  if (!dependencyState.ok) return dependencyState;
  return {
    ok: true,
    cwd: canonicalCwd,
    boundary_root: canonicalBoundary,
    organization_dependency_root: canonicalOrganizationDependencyRoot,
    lockfile,
    package_json: authoritySnapshot.package_json,
    required_dependency_count: dependencyState.required_dependency_count,
    authority_snapshot: authoritySnapshot,
  };
}

function declaredPackageManagerName(packageJson) {
  if (packageJson?.packageManager === undefined) return null;
  if (typeof packageJson.packageManager !== "string" || packageJson.packageManager.trim() === "") {
    return "invalid";
  }
  const value = packageJson.packageManager.trim();
  if (value.startsWith("@")) {
    const parts = value.split("@").filter(Boolean);
    return parts.length >= 2 ? `@${parts[0]}` : value;
  }
  return value.split("@")[0];
}

async function captureInstallAuthority({ cwd, boundaryRoot, organizationDependencyRoot, lockfile }) {
  const packageAuthority = await readAuthorityFile({
    path: join(cwd, "package.json"),
    boundaryRoot: cwd,
    label: "package.json",
  });
  if (!packageAuthority.ok) return packageAuthority;
  const lockAuthority = await readAuthorityFile({
    path: join(cwd, lockfile),
    boundaryRoot: cwd,
    label: lockfile,
  });
  if (!lockAuthority.ok) return lockAuthority;
  let packageJson;
  try {
    packageJson = JSON.parse(packageAuthority.bytes.toString("utf8"));
  } catch (error) {
    return {
      ok: false,
      reason: "package_json_invalid",
      detail: `package.json nejde přečíst: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const declarationIssue = requiredDependencyDeclarationIssue(packageJson);
  if (declarationIssue) {
    return { ok: false, reason: "package_json_invalid", detail: declarationIssue };
  }
  const localDependencyState = await inspectDeclaredFileDependencyAuthorities({
    cwd,
    boundaryRoot,
    organizationDependencyRoot,
    packageJson,
  });
  if (!localDependencyState.ok) return localDependencyState;
  return {
    ok: true,
    cwd,
    boundary_root: boundaryRoot,
    organization_dependency_root: organizationDependencyRoot,
    package_path: packageAuthority.canonical_path,
    package_bytes: packageAuthority.bytes,
    lockfile,
    lockfile_path: lockAuthority.canonical_path,
    lockfile_bytes: lockAuthority.bytes,
    package_json: packageJson,
    required_dependency_names: requiredDependencyNames(packageJson),
    local_dependency_authorities: localDependencyState.authorities,
  };
}

async function verifyInstallAuthority(snapshot) {
  const selectedLockfile = BUN_LOCKFILES.find((name) => existsSync(join(snapshot.cwd, name))) ?? null;
  if (selectedLockfile !== snapshot.lockfile) {
    return {
      ok: false,
      reason: "dependency_authority_changed",
      detail: `Zvolený Bun lockfile se během instalace změnil (${snapshot.lockfile} → ${selectedLockfile ?? "missing"}).`,
    };
  }
  const current = await captureInstallAuthority({
    cwd: snapshot.cwd,
    boundaryRoot: snapshot.boundary_root,
    organizationDependencyRoot: snapshot.organization_dependency_root,
    lockfile: snapshot.lockfile,
  });
  if (!current.ok) {
    return {
      ok: false,
      reason: "dependency_authority_changed",
      detail: current.detail,
    };
  }
  if (
    current.package_path !== snapshot.package_path
    || current.lockfile_path !== snapshot.lockfile_path
    || !sameBytes(current.package_bytes, snapshot.package_bytes)
    || !sameBytes(current.lockfile_bytes, snapshot.lockfile_bytes)
    || !sameLocalDependencyAuthorities(
      current.local_dependency_authorities,
      snapshot.local_dependency_authorities,
    )
  ) {
    return {
      ok: false,
      reason: "dependency_authority_changed",
      detail: "package.json nebo zvolený lockfile se během instalace změnil; Lazurio výsledek nepřijme.",
    };
  }
  const selectedLockfileAfterRead = BUN_LOCKFILES.find((name) => existsSync(join(snapshot.cwd, name))) ?? null;
  if (selectedLockfileAfterRead !== snapshot.lockfile) {
    return {
      ok: false,
      reason: "dependency_authority_changed",
      detail: `Zvolený Bun lockfile se během ověření změnil (${snapshot.lockfile} → ${selectedLockfileAfterRead ?? "missing"}).`,
    };
  }
  return { ok: true };
}

async function pinnedRuntimeTreeState(packageRoot) {
  // Runtime usability is always evaluated against the same package.json bytes
  // that authorized this operation. Re-read authority only after walking the
  // dependency tree so a concurrent manifest/lockfile change cannot shrink the
  // required set and turn an old tree into a false positive.
  const dependencyState = await inspectCanonicalRequiredDependencies({
    cwd: packageRoot.cwd,
    boundaryRoot: packageRoot.boundary_root,
    organizationDependencyRoot: packageRoot.organization_dependency_root,
    packageJson: packageRoot.package_json,
    localDependencyAuthorities: packageRoot.local_dependency_authorities,
  });
  const authorityState = await verifyInstallAuthority(packageRoot.authority_snapshot);
  return {
    authority_state: authorityState,
    dependency_state: dependencyState,
    runtime_tree_usable: authorityState.ok
      && dependencyState.ok
      && dependencyState.missing_required_dependencies.length === 0,
  };
}

function sameBytes(left, right) {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

async function prepareCleanInstall(cwd) {
  const nodeModulesPath = join(cwd, "node_modules");
  const recoveryPath = join(cwd, NODE_MODULES_RECOVERY);
  try {
    // Crash-safe retry: pokud předchozí běh nechal quarantine vedle nového nebo
    // chybějícího stromu, vrať nejdřív původní strom a až potom začni znovu.
    if (existsSync(recoveryPath)) {
      const recovery = await regularDirectory(recoveryPath, "node_modules recovery");
      if (!recovery.ok) return { ...recovery, runtime_tree_usable: existsSync(nodeModulesPath) };
      if (existsSync(nodeModulesPath)) {
        const partial = await regularDirectory(nodeModulesPath, "node_modules");
        if (!partial.ok) return { ...partial, runtime_tree_usable: true };
        await rm(nodeModulesPath, { recursive: true, force: false });
      }
      await rename(recoveryPath, nodeModulesPath);
    }

    if (!existsSync(nodeModulesPath)) return { ok: true, had_previous_tree: false };
    const current = await regularDirectory(nodeModulesPath, "node_modules");
    if (!current.ok) return { ...current, runtime_tree_usable: true };
    await rename(nodeModulesPath, recoveryPath);
    return { ok: true, had_previous_tree: true };
  } catch (error) {
    // Pokud rename vůbec nezačal, recovery neexistuje a původní strom se nesmí
    // „obnovovat“ odstraněním sebe sama. Rollback je potřeba jen tehdy, když
    // quarantine skutečně vznikla nebo už existovala po dřívějším pádu.
    const rollback = existsSync(recoveryPath)
      ? await restorePreviousTree(cwd)
      : { ok: true };
    return {
      ok: false,
      reason: "node_modules_prepare_failed",
      detail: [
        `Čistou opravu node_modules se nepodařilo bezpečně připravit: ${error instanceof Error ? error.message : String(error)}`,
        rollback.ok ? null : rollback.detail,
      ].filter(Boolean).join(" "),
      rollback_ok: rollback.ok,
      runtime_tree_usable: rollback.ok && existsSync(nodeModulesPath),
    };
  }
}

async function discardPreviousTree(cwd) {
  const recoveryPath = join(cwd, NODE_MODULES_RECOVERY);
  if (!existsSync(recoveryPath)) return { ok: true };
  try {
    const recovery = await regularDirectory(recoveryPath, "node_modules recovery");
    if (!recovery.ok) return recovery;
    await rm(recoveryPath, { recursive: true, force: false });
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      reason: "node_modules_cleanup_failed",
      detail: `Předchozí dependency strom se po úspěšné instalaci nepodařilo uklidit: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

async function restorePreviousTree(cwd) {
  const nodeModulesPath = join(cwd, "node_modules");
  const recoveryPath = join(cwd, NODE_MODULES_RECOVERY);
  try {
    if (existsSync(nodeModulesPath)) {
      const partial = await regularDirectory(nodeModulesPath, "node_modules");
      if (!partial.ok) return partial;
      await rm(nodeModulesPath, { recursive: true, force: false });
    }
    if (existsSync(recoveryPath)) {
      const recovery = await regularDirectory(recoveryPath, "node_modules recovery");
      if (!recovery.ok) return recovery;
      await rename(recoveryPath, nodeModulesPath);
    }
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      reason: "node_modules_rollback_failed",
      detail: `Původní node_modules se po neúspěšné instalaci nepodařilo obnovit: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

async function regularDirectory(path, label) {
  try {
    const entry = await lstat(path);
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      return {
        ok: false,
        reason: "node_modules_boundary_invalid",
        detail: `${label} není běžná složka; Lazurio ji z bezpečnostních důvodů nezměnilo.`,
      };
    }
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      reason: "node_modules_inspection_failed",
      detail: `${label} nejde bezpečně ověřit: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export function declaredDependencyCount(packageJson) {
  return ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]
    .map((key) => packageJson?.[key])
    .filter((value) => value && typeof value === "object" && !Array.isArray(value))
    .reduce((count, value) => count + Object.keys(value).length, 0);
}

export function requiredDependencyNames(packageJson) {
  return [...new Set(
    ["dependencies", "devDependencies"]
      .map((key) => packageJson?.[key])
      .filter((value) => value && typeof value === "object" && !Array.isArray(value))
      .flatMap((value) => Object.keys(value)),
  )].sort();
}

function requiredDependencyDeclarationIssue(packageJson) {
  if (!packageJson || typeof packageJson !== "object" || Array.isArray(packageJson)) {
    return "package.json root musí být JSON objekt";
  }
  for (const key of ["dependencies", "devDependencies"]) {
    const value = packageJson[key];
    if (value === undefined) continue;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return `package.json#${key} musí být objekt názvů balíčků`;
    }
  }
  if (
    packageJson.packageManager !== undefined
    && (typeof packageJson.packageManager !== "string" || packageJson.packageManager.trim() === "")
  ) {
    return "package.json#packageManager musí být neprázdný řetězec";
  }
  return null;
}

async function inspectDeclaredFileDependencyAuthorities({
  cwd,
  boundaryRoot,
  organizationDependencyRoot,
  packageJson,
}) {
  const authorities = [];
  const localDependencyTargets = [];
  const failure = (result) => ({
    ...result,
    local_dependency_targets: localDependencyTargets.map((target) => ({ ...target })),
  });
  for (const dependencyName of requiredDependencyNames(packageJson)) {
    const spec = requiredDependencySpec(packageJson, dependencyName);
    if (typeof spec !== "string" || !spec.startsWith("file:")) continue;
    const relativeTarget = spec.slice("file:".length);
    if (
      !relativeTarget
      || relativeTarget.includes("\0")
      || relativeTarget.startsWith("//")
      || isAbsolute(relativeTarget)
      || win32.isAbsolute(relativeTarget)
    ) {
      return failure({
        ok: false,
        reason: "dependency_tree_boundary_invalid",
        detail: `Lokální balíček ${dependencyName} musí používat relativní file: cestu bez URL, drive nebo UNC autority.`,
        dependency_name: dependencyName,
      });
    }

    const lexicalTarget = resolve(cwd, relativeTarget);
    const declaredTarget = {
      dependency_name: dependencyName,
      path: lexicalTarget,
      canonical_root: null,
      attribution_path: lexicalTarget,
    };
    localDependencyTargets.push(declaredTarget);
    if (!pathInsideBoundary(organizationDependencyRoot, lexicalTarget)) {
      return failure({
        ok: false,
        reason: "dependency_tree_boundary_invalid",
        detail: `Deklarovaný lokální cíl balíčku ${dependencyName} leží lexikálně mimo stejnou Organization hranici.`,
        dependency_name: dependencyName,
      });
    }
    let targetEntry;
    try {
      targetEntry = await lstat(lexicalTarget);
    } catch (error) {
      declaredTarget.attribution_path = await canonicalMissingTargetAttribution({
        targetPath: lexicalTarget,
        organizationDependencyRoot,
      }) ?? lexicalTarget;
      return failure({
        ok: false,
        reason: "dependency_tree_inspection_failed",
        detail: `Deklarovaný lokální cíl balíčku ${dependencyName} nejde otevřít (${lexicalTarget}): ${error instanceof Error ? error.message : String(error)}`,
        dependency_name: dependencyName,
      });
    }

    // A file: archive inside the selected checkout remains a regular package
    // manager input. The Organization exception is deliberately directory-only
    // so it never turns an arbitrary sibling file into executable authority.
    if (targetEntry.isFile()) {
      let canonicalFile;
      try {
        canonicalFile = await realpath(lexicalTarget);
      } catch (error) {
        return failure({
          ok: false,
          reason: "dependency_tree_inspection_failed",
          detail: `Lokální archive cíl balíčku ${dependencyName} nejde bezpečně ověřit: ${error instanceof Error ? error.message : String(error)}`,
          dependency_name: dependencyName,
        });
      }
      declaredTarget.canonical_root = canonicalFile;
      declaredTarget.attribution_path = canonicalFile;
      if (pathInsideBoundary(boundaryRoot, canonicalFile)) continue;
      return failure({
        ok: false,
        reason: "dependency_tree_boundary_invalid",
        detail: `Lokální cíl balíčku ${dependencyName} mimo owning checkout musí být adresář uvnitř stejné Organizace.`,
        dependency_name: dependencyName,
      });
    }
    if (!targetEntry.isDirectory() && !targetEntry.isSymbolicLink()) {
      declaredTarget.attribution_path = await canonicalMissingTargetAttribution({
        targetPath: lexicalTarget,
        organizationDependencyRoot,
      }) ?? lexicalTarget;
      return failure({
        ok: false,
        reason: "dependency_tree_boundary_invalid",
        detail: `Lokální cíl balíčku ${dependencyName} není bezpečný adresář package zdroje.`,
        dependency_name: dependencyName,
      });
    }

    const targetBoundary = await inspectDirectoryWithinCanonicalBoundary({
      rootPath: organizationDependencyRoot,
      rootRealPath: organizationDependencyRoot,
      targetPath: lexicalTarget,
    });
    if (!targetBoundary.ok || !targetBoundary.targetRealPath) {
      declaredTarget.attribution_path = targetBoundary.targetRealPath
        && pathInsideBoundary(organizationDependencyRoot, targetBoundary.targetRealPath)
        ? targetBoundary.targetRealPath
        : await canonicalMissingTargetAttribution({
            targetPath: lexicalTarget,
            organizationDependencyRoot,
          }) ?? lexicalTarget;
      return failure({
        ok: false,
        reason: "dependency_tree_boundary_invalid",
        detail: `Deklarovaný lokální cíl balíčku ${dependencyName} neleží uvnitř stejné Organization hranice.`,
        dependency_name: dependencyName,
      });
    }
    declaredTarget.canonical_root = targetBoundary.targetRealPath;
    declaredTarget.attribution_path = targetBoundary.targetRealPath;

    const targetTree = await inspectLocalDependencyTree({
      treeRoot: targetBoundary.targetRealPath,
      allowedTargetRoot: targetBoundary.targetRealPath,
      requireFileSymlinks: false,
      dependencyName,
      label: "Deklarovaný lokální balíček",
    });
    if (!targetTree.ok) return failure(targetTree);

    const targetPackagePath = join(targetBoundary.targetRealPath, "package.json");
    let targetPackage;
    try {
      targetPackage = await readFileWithinCanonicalBoundary({
        rootPath: targetBoundary.targetRealPath,
        rootRealPath: targetBoundary.targetRealPath,
        targetPath: targetPackagePath,
        label: `package.json deklarovaného lokálního balíčku ${dependencyName}`,
      });
    } catch (error) {
      return failure({
        ok: false,
        reason: isCanonicalBoundaryError(error)
          ? "dependency_tree_boundary_invalid"
          : "dependency_tree_inspection_failed",
        detail: `Deklarovaný lokální balíček ${dependencyName} nemá bezpečně čitelný package.json: ${error instanceof Error ? error.message : String(error)}`,
        dependency_name: dependencyName,
      });
    }
    let metadata;
    try {
      metadata = JSON.parse(targetPackage.value.toString("utf8"));
    } catch (error) {
      return failure({
        ok: false,
        reason: "dependency_tree_inspection_failed",
        detail: `package.json deklarovaného lokálního balíčku ${dependencyName} není platný JSON: ${error instanceof Error ? error.message : String(error)}`,
        dependency_name: dependencyName,
      });
    }
    const targetPackageName = typeof metadata?.name === "string" ? metadata.name.trim() : "";
    if (!dependencyPathParts(targetPackageName)) {
      return failure({
        ok: false,
        reason: "dependency_tree_inspection_failed",
        detail: `package.json deklarovaného lokálního balíčku ${dependencyName} nemá bezpečnou package identitu.`,
        dependency_name: dependencyName,
      });
    }
    authorities.push({
      dependency_name: dependencyName,
      spec,
      target_root: targetBoundary.targetRealPath,
      target_outside_checkout: !pathInsideBoundary(boundaryRoot, targetBoundary.targetRealPath),
      target_package_path: targetPackage.targetRealPath,
      target_package_bytes: targetPackage.value,
      target_package_name: targetPackageName,
      target_tree_authority: targetTree.authority,
    });
  }
  return { ok: true, authorities, local_dependency_targets: localDependencyTargets };
}

async function canonicalMissingTargetAttribution({ targetPath, organizationDependencyRoot }) {
  let cursor = targetPath;
  const missingSuffix = [];
  while (pathInsideBoundary(organizationDependencyRoot, cursor)) {
    try {
      const canonicalParent = await realpath(cursor);
      if (!pathInsideBoundary(organizationDependencyRoot, canonicalParent)) return null;
      return resolve(canonicalParent, ...missingSuffix);
    } catch (error) {
      if (!["ENOENT", "ENOTDIR"].includes(error?.code)) return null;
    }
    if (samePath(cursor, organizationDependencyRoot)) break;
    missingSuffix.unshift(basename(cursor));
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return null;
}

async function inspectLocalDependencyTree({
  treeRoot,
  allowedTargetRoot,
  requireFileSymlinks,
  dependencyName,
  label,
}) {
  let canonicalTreeRoot;
  try {
    canonicalTreeRoot = await realpath(treeRoot);
  } catch (error) {
    return {
      ok: false,
      reason: "dependency_tree_inspection_failed",
      detail: `${label} ${dependencyName} nemá ověřitelný kořen: ${error instanceof Error ? error.message : String(error)}`,
      dependency_name: dependencyName,
    };
  }
  const pending = [treeRoot];
  const authority = [];
  let inspectedEntries = 0;
  while (pending.length > 0) {
    const currentDirectory = pending.pop();
    let directory;
    let beforeDirectoryTarget;
    let beforeDirectoryState;
    try {
      beforeDirectoryTarget = await realpath(currentDirectory);
      beforeDirectoryState = await stat(beforeDirectoryTarget);
      if (
        !pathInsideBoundary(canonicalTreeRoot, beforeDirectoryTarget)
        || !beforeDirectoryState.isDirectory()
      ) {
        return {
          ok: false,
          reason: "dependency_tree_boundary_invalid",
          detail: `${label} ${dependencyName} obsahuje adresář mimo svůj přesný package strom.`,
          dependency_name: dependencyName,
        };
      }
      directory = await opendir(currentDirectory);
    } catch (error) {
      return {
        ok: false,
        reason: "dependency_tree_inspection_failed",
        detail: `${label} ${dependencyName} nejde bezpečně projít: ${error instanceof Error ? error.message : String(error)}`,
        dependency_name: dependencyName,
      };
    }
    authority.push([
      "walk-directory",
      relative(treeRoot, currentDirectory).replace(/\\/g, "/") || ".",
      String(beforeDirectoryState.dev),
      String(beforeDirectoryState.ino),
    ].join("\0"));
    try {
      for await (const entry of directory) {
        inspectedEntries += 1;
        if (inspectedEntries > LOCAL_DEPENDENCY_TREE_ENTRY_LIMIT) {
          return {
            ok: false,
            reason: "dependency_tree_inspection_failed",
            detail: `${label} ${dependencyName} přesahuje bezpečný limit ${LOCAL_DEPENDENCY_TREE_ENTRY_LIMIT} položek.`,
            dependency_name: dependencyName,
          };
        }
        const entryPath = join(currentDirectory, entry.name);
        let entryState;
        try {
          entryState = await lstat(entryPath);
        } catch (error) {
          return {
            ok: false,
            reason: "dependency_tree_inspection_failed",
            detail: `${label} ${dependencyName} se během ověření změnil: ${error instanceof Error ? error.message : String(error)}`,
            dependency_name: dependencyName,
          };
        }
        const entryRelativePath = relative(treeRoot, entryPath).replace(/\\/g, "/");
        if (entryState.isSymbolicLink()) {
          let beforeTarget;
          let afterTarget;
          let targetState;
          try {
            beforeTarget = await realpath(entryPath);
            targetState = await stat(beforeTarget);
            afterTarget = await realpath(entryPath);
          } catch (error) {
            return {
              ok: false,
              reason: "dependency_tree_inspection_failed",
              detail: `${label} ${dependencyName} obsahuje neověřitelný symlink ${entryRelativePath}: ${error instanceof Error ? error.message : String(error)}`,
              dependency_name: dependencyName,
            };
          }
          if (
            !pathInsideBoundary(allowedTargetRoot, beforeTarget)
            || !samePath(beforeTarget, afterTarget)
            || (!targetState.isFile() && !targetState.isDirectory())
          ) {
            return {
              ok: false,
              reason: "dependency_tree_boundary_invalid",
              detail: `${label} ${dependencyName} obsahuje symlink ${entryRelativePath} mimo přesný deklarovaný package cíl.`,
              dependency_name: dependencyName,
            };
          }
          authority.push([
            "link",
            entryRelativePath,
            beforeTarget,
            String(entryState.dev),
            String(entryState.ino),
            String(targetState.dev),
            String(targetState.ino),
          ].join("\0"));
          continue;
        }
        if (entryState.isDirectory()) {
          authority.push(`directory\0${entryRelativePath}`);
          pending.push(entryPath);
          continue;
        }
        if (entryState.isFile() && !requireFileSymlinks) {
          authority.push(`file\0${entryRelativePath}`);
          continue;
        }
        return {
          ok: false,
          reason: "dependency_tree_boundary_invalid",
          detail: requireFileSymlinks
            ? `${label} ${dependencyName} obsahuje nepřipnutý soubor ${entryRelativePath}; link-farm smí odkazovat jen do přesného deklarovaného cíle.`
            : `${label} ${dependencyName} obsahuje nepodporovaný filesystem objekt ${entryRelativePath}.`,
          dependency_name: dependencyName,
        };
      }
    } finally {
      await directory.close().catch(() => {});
    }
    let afterDirectoryTarget;
    let afterDirectoryState;
    try {
      afterDirectoryTarget = await realpath(currentDirectory);
      afterDirectoryState = await stat(afterDirectoryTarget);
    } catch (error) {
      return {
        ok: false,
        reason: "dependency_authority_changed",
        detail: `${label} ${dependencyName} změnil adresář během ověření: ${error instanceof Error ? error.message : String(error)}`,
        dependency_name: dependencyName,
      };
    }
    if (
      !samePath(beforeDirectoryTarget, afterDirectoryTarget)
      || beforeDirectoryState.dev !== afterDirectoryState.dev
      || beforeDirectoryState.ino !== afterDirectoryState.ino
    ) {
      return {
        ok: false,
        reason: "dependency_authority_changed",
        detail: `${label} ${dependencyName} změnil adresář během ověření.`,
        dependency_name: dependencyName,
      };
    }
  }
  return { ok: true, authority: authority.sort().join("\n") };
}

function requiredDependencySpec(packageJson, dependencyName) {
  return packageJson?.dependencies?.[dependencyName]
    ?? packageJson?.devDependencies?.[dependencyName]
    ?? null;
}

function sameLocalDependencyAuthorities(left = [], right = []) {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    const current = left[index];
    const expected = right[index];
    if (
      current.dependency_name !== expected.dependency_name
      || current.spec !== expected.spec
      || !samePath(current.target_root, expected.target_root)
      || current.target_outside_checkout !== expected.target_outside_checkout
      || !samePath(current.target_package_path, expected.target_package_path)
      || current.target_package_name !== expected.target_package_name
      || !sameBytes(current.target_package_bytes, expected.target_package_bytes)
      || current.target_tree_authority !== expected.target_tree_authority
    ) return false;
  }
  return true;
}

export async function inspectRequiredDependencies({
  cwd,
  boundaryRoot,
  organizationDependencyRoot = null,
  packageJson: fallbackPackageJson,
  lockfile = null,
  beforeDependencyMetadataFailureInspection = null,
  beforeLocalDependencyAuthorityRecheck = null,
  beforeLocalDependencyTreeRecheck = null,
} = {}) {
  const fallbackNames = requiredDependencyNames(fallbackPackageJson);
  if (
    !cwd
    || !boundaryRoot
    || !isAbsolute(cwd)
    || !isAbsolute(boundaryRoot)
    || (organizationDependencyRoot !== null && !isAbsolute(organizationDependencyRoot))
  ) {
    return {
      ok: false,
      reason: "package_root_invalid",
      detail: "Dependency inspection vyžaduje absolutní package a boundary cestu.",
      required_dependency_names: fallbackNames,
      required_dependency_count: fallbackNames.length,
      missing_required_dependencies: fallbackNames,
    };
  }
  let canonicalBoundary;
  let canonicalCwd;
  let canonicalOrganizationDependencyRoot;
  try {
    [canonicalBoundary, canonicalCwd, canonicalOrganizationDependencyRoot] = await Promise.all([
      realpath(boundaryRoot),
      realpath(cwd),
      realpath(organizationDependencyRoot ?? boundaryRoot),
    ]);
  } catch (error) {
    const missing = ["ENOENT", "ENOTDIR"].includes(error?.code);
    return {
      ok: false,
      reason: missing ? "package_root_unavailable" : "package_root_inspection_failed",
      detail: `Package root nejde bezpečně otevřít: ${error instanceof Error ? error.message : String(error)}`,
      required_dependency_names: fallbackNames,
      required_dependency_count: fallbackNames.length,
      missing_required_dependencies: fallbackNames,
    };
  }
  const pathFromBoundary = relative(canonicalBoundary, canonicalCwd);
  if (pathFromBoundary === ".." || pathFromBoundary.startsWith(`..${sep}`) || isAbsolute(pathFromBoundary)) {
    return {
      ok: false,
      reason: "package_root_outside_boundary",
      detail: "Package root leží mimo owning checkout.",
      required_dependency_names: fallbackNames,
      required_dependency_count: fallbackNames.length,
      missing_required_dependencies: fallbackNames,
    };
  }
  if (!pathInsideBoundary(canonicalOrganizationDependencyRoot, canonicalBoundary)) {
    return {
      ok: false,
      reason: "dependency_tree_boundary_invalid",
      detail: "Owning checkout neleží uvnitř zvolené Organization dependency hranice.",
      required_dependency_names: fallbackNames,
      required_dependency_count: fallbackNames.length,
      missing_required_dependencies: fallbackNames,
    };
  }

  const authorityFiles = await inspectPackageAuthorityFiles({
    cwd: canonicalCwd,
    boundaryRoot: canonicalBoundary,
    requiredLockfile: lockfile,
  });
  if (!authorityFiles.ok) {
    return {
      ...authorityFiles,
      required_dependency_names: fallbackNames,
      required_dependency_count: fallbackNames.length,
      missing_required_dependencies: fallbackNames,
    };
  }

  let packageJson;
  try {
    packageJson = JSON.parse(authorityFiles.package_bytes.toString("utf8"));
  } catch (error) {
    return {
      ok: false,
      reason: "package_json_invalid",
      detail: `package.json nejde přečíst: ${error instanceof Error ? error.message : String(error)}`,
      required_dependency_names: [],
      required_dependency_count: 0,
      missing_required_dependencies: [],
    };
  }
  const declarationIssue = requiredDependencyDeclarationIssue(packageJson);
  if (declarationIssue) {
    return {
      ok: false,
      reason: "package_json_invalid",
      detail: declarationIssue,
      required_dependency_names: [],
      required_dependency_count: 0,
      missing_required_dependencies: [],
    };
  }
  const localDependencyState = await inspectDeclaredFileDependencyAuthorities({
    cwd: canonicalCwd,
    boundaryRoot: canonicalBoundary,
    organizationDependencyRoot: canonicalOrganizationDependencyRoot,
    packageJson,
  });
  if (!localDependencyState.ok) {
    return {
      ...localDependencyState,
      required_dependency_names: requiredDependencyNames(packageJson),
      required_dependency_count: requiredDependencyNames(packageJson).length,
      missing_required_dependencies: localDependencyState.dependency_name
        ? [localDependencyState.dependency_name]
        : requiredDependencyNames(packageJson),
    };
  }
  const dependencyState = await inspectCanonicalRequiredDependencies({
    cwd: canonicalCwd,
    boundaryRoot: canonicalBoundary,
    organizationDependencyRoot: canonicalOrganizationDependencyRoot,
    packageJson,
    localDependencyAuthorities: localDependencyState.authorities,
    beforeDependencyMetadataFailureInspection,
    beforeLocalDependencyTreeRecheck,
  });
  if (!dependencyState.ok) {
    return {
      ...dependencyState,
      package_json: packageJson,
      local_dependency_targets: localDependencyState.local_dependency_targets,
    };
  }
  if (beforeLocalDependencyAuthorityRecheck) await beforeLocalDependencyAuthorityRecheck();
  const recheckedLocalDependencies = await inspectDeclaredFileDependencyAuthorities({
    cwd: canonicalCwd,
    boundaryRoot: canonicalBoundary,
    organizationDependencyRoot: canonicalOrganizationDependencyRoot,
    packageJson,
  });
  if (
    !recheckedLocalDependencies.ok
    || !sameLocalDependencyAuthorities(
      recheckedLocalDependencies.authorities,
      localDependencyState.authorities,
    )
  ) {
    return {
      ok: false,
      reason: "dependency_authority_changed",
      detail: recheckedLocalDependencies.ok
        ? "Deklarovaný lokální dependency cíl se během ověření změnil."
        : recheckedLocalDependencies.detail,
      required_dependency_names: dependencyState.required_dependency_names,
      required_dependency_count: dependencyState.required_dependency_count,
      missing_required_dependencies: dependencyState.required_dependency_names,
      package_json: packageJson,
      local_dependency_targets: recheckedLocalDependencies.local_dependency_targets
        ?? localDependencyState.local_dependency_targets,
    };
  }
  return {
    ...dependencyState,
    package_json: packageJson,
    local_dependency_targets: localDependencyState.local_dependency_targets,
  };
}

async function inspectCanonicalRequiredDependencies({
  cwd,
  boundaryRoot,
  organizationDependencyRoot,
  packageJson,
  localDependencyAuthorities = [],
  beforeDependencyMetadataFailureInspection = null,
  beforeLocalDependencyTreeRecheck = null,
}) {
  const requiredNames = requiredDependencyNames(packageJson);
  const localAuthoritiesByName = new Map(
    localDependencyAuthorities.map((authority) => [authority.dependency_name, authority]),
  );
  const nodeModulesRoots = await inspectNodeModulesRoots({ cwd, boundaryRoot });
  if (!nodeModulesRoots.ok) {
    return {
      ...nodeModulesRoots,
      required_dependency_names: requiredNames,
      required_dependency_count: requiredNames.length,
      missing_required_dependencies: requiredNames,
    };
  }
  const missingNames = [];
  for (const dependencyName of requiredNames) {
    const inspection = await requiredDependencyPackageJsonPath({
      cwd,
      boundaryRoot,
      dependencyName,
      packageJson,
      localDependencyAuthority: localAuthoritiesByName.get(dependencyName) ?? null,
      organizationDependencyRoot,
      beforeDependencyMetadataFailureInspection,
      beforeLocalDependencyTreeRecheck,
    });
    if (!inspection.ok) {
      return {
        ok: false,
        reason: inspection.reason,
        detail: inspection.detail,
        required_dependency_names: requiredNames,
        required_dependency_count: requiredNames.length,
        missing_required_dependencies: [dependencyName],
      };
    }
    if (!inspection.path) missingNames.push(dependencyName);
  }
  return {
    ok: true,
    required_dependency_names: requiredNames,
    required_dependency_count: requiredNames.length,
    missing_required_dependencies: missingNames,
  };
}

async function requiredDependencyPackageJsonPath({
  cwd,
  boundaryRoot,
  dependencyName,
  packageJson,
  localDependencyAuthority = null,
  beforeDependencyMetadataFailureInspection = null,
  beforeLocalDependencyTreeRecheck = null,
}) {
  const parts = dependencyPathParts(dependencyName);
  if (!parts) {
    return {
      ok: false,
      reason: "dependency_name_invalid",
      detail: `Deklarovaný název balíčku ${JSON.stringify(dependencyName)} není bezpečná npm package cesta.`,
      path: null,
    };
  }
  let cursor = resolve(cwd);
  const boundary = resolve(boundaryRoot);
  while (pathInsideBoundary(boundary, cursor)) {
    const candidateRoot = join(cursor, "node_modules", ...parts);
    try {
      // Missing roots simply mean this dependency is not installed at this
      // resolution level. A present but invalid nearer package is terminal:
      // it may never reopen fallback to a different ancestor package.
      await lstat(candidateRoot);
      return await inspectInstalledDependencyCandidate({
        candidateRoot,
        boundary,
        dependencyName,
        packageJson,
        localDependencyAuthority,
        beforeDependencyMetadataFailureInspection,
        beforeLocalDependencyTreeRecheck,
      });
    } catch (error) {
      if (!["ENOENT", "ENOTDIR"].includes(error?.code)) {
        return {
          ok: false,
          reason: isCanonicalBoundaryError(error)
            ? "dependency_tree_boundary_invalid"
            : "dependency_tree_inspection_failed",
          detail: `Balíček ${dependencyName} nejde bezpečně ověřit: ${error instanceof Error ? error.message : String(error)}`,
          path: null,
        };
      }
    }
    if (cursor === boundary) break;
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return { ok: true, path: null };
}

async function inspectInstalledDependencyCandidate({
  candidateRoot,
  boundary,
  dependencyName,
  packageJson,
  localDependencyAuthority,
  beforeDependencyMetadataFailureInspection,
  beforeLocalDependencyTreeRecheck,
}) {
  const candidateBoundary = await inspectDirectoryWithinCanonicalBoundary({
    rootPath: boundary,
    rootRealPath: boundary,
    targetPath: candidateRoot,
  });
  let canonicalCandidateRoot = candidateBoundary.targetRealPath;
  let directLocalAlias = false;
  if (!candidateBoundary.ok || !canonicalCandidateRoot) {
    if (
      !localDependencyAuthority
      || !canonicalCandidateRoot
      || !samePath(canonicalCandidateRoot, localDependencyAuthority.target_root)
    ) {
      return {
        ok: false,
        reason: "dependency_tree_boundary_invalid",
        detail: `Balíček ${dependencyName} odkazuje mimo owning checkout a neodpovídá přesně deklarovanému Organization-local file: cíli.`,
        path: null,
      };
    }
    const exactAlias = await inspectExactDirectoryAlias({
      aliasPath: candidateRoot,
      expectedTarget: localDependencyAuthority.target_root,
    });
    if (!exactAlias.ok) return exactAlias;
    canonicalCandidateRoot = localDependencyAuthority.target_root;
    directLocalAlias = true;
  } else if (
    localDependencyAuthority
    && samePath(canonicalCandidateRoot, localDependencyAuthority.target_root)
  ) {
    directLocalAlias = true;
  }

  const canonicalCandidatePackage = join(canonicalCandidateRoot, "package.json");
  let packageSnapshot;
  let localLinkFarm = false;
  let linkFarmTreeAuthority = null;
  try {
    packageSnapshot = await readFileWithinCanonicalBoundary({
      rootPath: canonicalCandidateRoot,
      rootRealPath: canonicalCandidateRoot,
      targetPath: canonicalCandidatePackage,
      label: `package.json balíčku ${dependencyName}`,
    });
  } catch (error) {
    if (localDependencyAuthority && isCanonicalBoundaryError(error) && !directLocalAlias) {
      const linkedMetadata = await readExactDeclaredLocalPackageLink({
        candidatePackage: join(candidateRoot, "package.json"),
        authority: localDependencyAuthority,
        dependencyName,
      });
      if (linkedMetadata.ok) {
        packageSnapshot = linkedMetadata.snapshot;
        localLinkFarm = true;
      } else {
        return linkedMetadata;
      }
    } else {
      return dependencyMetadataReadFailure({
        error,
        dependencyName,
        packagePath: canonicalCandidatePackage,
        beforeDependencyMetadataFailureInspection,
      });
    }
  }

  if (localDependencyAuthority) {
    if (
      localDependencyAuthority.target_outside_checkout
      && !directLocalAlias
      && !localLinkFarm
    ) {
      return {
        ok: false,
        reason: "dependency_tree_inspection_failed",
        detail: `Instalovaný balíček ${dependencyName} není propojený s přesně deklarovaným file: cílem; Lazurio jej nepoužije jako aktuální lokální dependency.`,
        path: null,
      };
    }
    if (
      (directLocalAlias || localLinkFarm)
      && (
        !samePath(packageSnapshot.targetRealPath, localDependencyAuthority.target_package_path)
        || !sameBytes(packageSnapshot.value, localDependencyAuthority.target_package_bytes)
      )
    ) {
      return {
        ok: false,
        reason: "dependency_authority_changed",
        detail: `Deklarovaný lokální balíček ${dependencyName} změnil package identitu během ověření.`,
        path: null,
      };
    }
    if (localLinkFarm) {
      const linkFarmTree = await inspectLocalDependencyTree({
        treeRoot: candidateRoot,
        allowedTargetRoot: localDependencyAuthority.target_root,
        requireFileSymlinks: true,
        dependencyName,
        label: "Instalovaný Organization-local link-farm balíček",
      });
      if (!linkFarmTree.ok) return linkFarmTree;
      linkFarmTreeAuthority = linkFarmTree.authority;
    }
    const rootRecheck = directLocalAlias
      ? await inspectExactDirectoryAlias({
          aliasPath: candidateRoot,
          expectedTarget: localDependencyAuthority.target_root,
        })
      : await inspectDirectoryWithinCanonicalBoundary({
          rootPath: boundary,
          rootRealPath: boundary,
          targetPath: candidateRoot,
        });
    if (!rootRecheck.ok || (rootRecheck.targetRealPath && !samePath(rootRecheck.targetRealPath, canonicalCandidateRoot))) {
      return {
        ok: false,
        reason: "dependency_authority_changed",
        detail: `Adresář lokálního balíčku ${dependencyName} se během ověření změnil.`,
        path: null,
      };
    }
    if (localLinkFarm) {
      if (beforeLocalDependencyTreeRecheck) {
        await beforeLocalDependencyTreeRecheck({ dependencyName, candidateRoot });
      }
      const recheckedLinkFarmTree = await inspectLocalDependencyTree({
        treeRoot: candidateRoot,
        allowedTargetRoot: localDependencyAuthority.target_root,
        requireFileSymlinks: true,
        dependencyName,
        label: "Instalovaný Organization-local link-farm balíček",
      });
      if (!recheckedLinkFarmTree.ok || recheckedLinkFarmTree.authority !== linkFarmTreeAuthority) {
        return {
          ok: false,
          reason: "dependency_authority_changed",
          detail: recheckedLinkFarmTree.ok
            ? `Instalovaný link-farm balíček ${dependencyName} se během ověření změnil.`
            : recheckedLinkFarmTree.detail,
          path: null,
        };
      }
    }
  }

  let metadata;
  try {
    metadata = JSON.parse(packageSnapshot.value.toString("utf8"));
  } catch (error) {
    return {
      ok: false,
      reason: "dependency_tree_inspection_failed",
      detail: `package.json balíčku ${dependencyName} není platný JSON: ${error instanceof Error ? error.message : String(error)}`,
      path: null,
    };
  }
  const allowedNames = localDependencyAuthority
    ? new Set([localDependencyAuthority.target_package_name])
    : dependencyMetadataNames(packageJson, dependencyName);
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)
    || typeof metadata.name !== "string" || !allowedNames.has(metadata.name.trim())) {
    const actualName = metadata && typeof metadata === "object" && !Array.isArray(metadata)
      && typeof metadata.name === "string"
      ? metadata.name.trim()
      : null;
    return {
      ok: false,
      reason: "dependency_tree_inspection_failed",
      detail: `package.json balíčku ${dependencyName} má neplatnou identitu (očekáváno ${[...allowedNames].join(" nebo ")}, nalezeno ${actualName || "chybějící name"}); Lazurio nepoužije jiný ancestor balíček.`,
      path: null,
    };
  }
  return { ok: true, path: packageSnapshot.targetRealPath };
}

async function dependencyMetadataReadFailure({
  error,
  dependencyName,
  packagePath,
  beforeDependencyMetadataFailureInspection,
}) {
  // Deterministic race-test seam. Production callers omit it; the subsequent
  // lstat must never turn an earlier failed read into permission to resolve a
  // different ancestor package.
  if (beforeDependencyMetadataFailureInspection) {
    await beforeDependencyMetadataFailureInspection({ dependencyName, packagePath });
  }
  let packageEntryExists = true;
  try {
    await lstat(packagePath);
  } catch (inspectionError) {
    if (!["ENOENT", "ENOTDIR"].includes(inspectionError?.code)) {
      return {
        ok: false,
        reason: "dependency_tree_inspection_failed",
        detail: `package.json balíčku ${dependencyName} nejde po chybě čtení bezpečně ověřit: ${inspectionError instanceof Error ? inspectionError.message : String(inspectionError)}`,
        path: null,
      };
    }
    packageEntryExists = false;
  }
  if (!packageEntryExists) {
    return {
      ok: false,
      reason: "dependency_tree_inspection_failed",
      detail: ["ENOENT", "ENOTDIR"].includes(error?.code)
        ? `package.json balíčku ${dependencyName} změnil existenci během bezpečného ověření; Lazurio nepoužije jiný ancestor balíček.`
        : `Adresář balíčku ${dependencyName} existuje, ale chybí v něm package.json; Lazurio tento neúplný strom automaticky nepřepíše.`,
      path: null,
    };
  }
  return {
    ok: false,
    reason: isCanonicalBoundaryError(error)
      ? "dependency_tree_boundary_invalid"
      : "dependency_tree_inspection_failed",
    detail: ["ENOENT", "ENOTDIR"].includes(error?.code)
      ? `package.json balíčku ${dependencyName} změnil existenci během bezpečného ověření; Lazurio nepoužije jiný ancestor balíček.`
      : `package.json balíčku ${dependencyName} nejde bezpečně přečíst: ${error instanceof Error ? error.message : String(error)}`,
    path: null,
  };
}

async function readExactDeclaredLocalPackageLink({ candidatePackage, authority, dependencyName }) {
  try {
    const beforeTarget = await realpath(candidatePackage);
    if (!samePath(beforeTarget, authority.target_package_path)) {
      return {
        ok: false,
        reason: "dependency_tree_boundary_invalid",
        detail: `package.json balíčku ${dependencyName} neodkazuje na přesně deklarovaný file: cíl.`,
        path: null,
      };
    }
    const snapshot = await readFileWithinCanonicalBoundary({
      rootPath: authority.target_root,
      rootRealPath: authority.target_root,
      targetPath: authority.target_package_path,
      label: `package.json deklarovaného lokálního balíčku ${dependencyName}`,
    });
    const afterTarget = await realpath(candidatePackage);
    if (!samePath(beforeTarget, afterTarget)) {
      return {
        ok: false,
        reason: "dependency_authority_changed",
        detail: `package.json balíčku ${dependencyName} změnil cíl během ověření.`,
        path: null,
      };
    }
    return { ok: true, snapshot };
  } catch (error) {
    return {
      ok: false,
      reason: isCanonicalBoundaryError(error)
        ? "dependency_tree_boundary_invalid"
        : "dependency_tree_inspection_failed",
      detail: `Organization-local package.json balíčku ${dependencyName} nejde bezpečně ověřit: ${error instanceof Error ? error.message : String(error)}`,
      path: null,
    };
  }
}

async function inspectExactDirectoryAlias({ aliasPath, expectedTarget }) {
  try {
    const aliasEntry = await lstat(aliasPath);
    const beforeTarget = await realpath(aliasPath);
    const beforeEntry = await stat(beforeTarget);
    if (!aliasEntry.isSymbolicLink() || !beforeEntry.isDirectory() || !samePath(beforeTarget, expectedTarget)) {
      return {
        ok: false,
        reason: "dependency_tree_boundary_invalid",
        detail: "Lokální dependency adresář není přesný symlink/junction na deklarovaný file: cíl.",
        path: null,
      };
    }
    const afterTarget = await realpath(aliasPath);
    const afterEntry = await stat(afterTarget);
    if (
      !samePath(beforeTarget, afterTarget)
      || beforeEntry.dev !== afterEntry.dev
      || beforeEntry.ino !== afterEntry.ino
    ) {
      return {
        ok: false,
        reason: "dependency_authority_changed",
        detail: "Lokální dependency adresář změnil cíl během ověření.",
        path: null,
      };
    }
    return { ok: true, targetRealPath: beforeTarget };
  } catch (error) {
    return {
      ok: false,
      reason: "dependency_tree_inspection_failed",
      detail: `Lokální dependency adresář nejde bezpečně ověřit: ${error instanceof Error ? error.message : String(error)}`,
      path: null,
    };
  }
}

async function inspectPackageAuthorityFiles({ cwd, boundaryRoot, requiredLockfile = null }) {
  const packageAuthority = await readAuthorityFile({
    path: join(cwd, "package.json"),
    boundaryRoot: cwd,
    label: "package.json",
  });
  if (!packageAuthority.ok) return packageAuthority;

  if (requiredLockfile !== null && !PACKAGE_LOCKFILES.includes(requiredLockfile)) {
    return {
      ok: false,
      reason: "dependency_tree_boundary_invalid",
      detail: "Vybraný lockfile není podporovaný package-root soubor.",
    };
  }
  const lockfiles = requiredLockfile
    ? [requiredLockfile]
    : PACKAGE_LOCKFILES.filter((name) => existsSync(join(cwd, name)));
  for (const lockfile of lockfiles) {
    const lockAuthority = await readAuthorityFile({
      path: join(cwd, lockfile),
      boundaryRoot: cwd,
      label: lockfile,
    });
    if (!lockAuthority.ok) return lockAuthority;
  }
  if (!pathInsideBoundary(boundaryRoot, cwd)) {
    return {
      ok: false,
      reason: "package_root_outside_boundary",
      detail: "Package root leží mimo owning checkout.",
    };
  }
  return {
    ok: true,
    package_path: packageAuthority.canonical_path,
    package_bytes: packageAuthority.bytes,
  };
}

async function readAuthorityFile({ path, boundaryRoot, label }) {
  try {
    const snapshot = await readFileWithinCanonicalBoundary({
      rootPath: boundaryRoot,
      rootRealPath: boundaryRoot,
      targetPath: path,
      label,
    });
    return {
      ok: true,
      canonical_path: snapshot.targetRealPath,
      bytes: snapshot.value,
    };
  } catch (error) {
    const missing = ["ENOENT", "ENOTDIR"].includes(error?.code);
    const boundaryFailure = isCanonicalBoundaryError(error);
    let lexicalEntryExists = false;
    try {
      await lstat(path);
      lexicalEntryExists = true;
    } catch (inspectionError) {
      if (!["ENOENT", "ENOTDIR"].includes(inspectionError?.code)) {
        return {
          ok: false,
          reason: "dependency_tree_inspection_failed",
          detail: `${label} nejde bezpečně ověřit: ${inspectionError instanceof Error ? inspectionError.message : String(inspectionError)}`,
        };
      }
    }
    return {
      ok: false,
      reason: label === "package.json" && missing && !lexicalEntryExists
        ? "package_json_missing"
        : boundaryFailure || (missing && lexicalEntryExists)
          ? "dependency_tree_boundary_invalid"
          : "dependency_tree_inspection_failed",
      detail: `${label} nejde bezpečně ověřit: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function isCanonicalBoundaryError(error) {
  return [
    "LAZURIO_PATH_BOUNDARY_INVALID",
    "LAZURIO_PATH_ENTRY_TYPE_INVALID",
    "LAZURIO_PATH_AUTHORITY_CHANGED",
  ].includes(error?.code);
}

async function inspectNodeModulesRoots({ cwd, boundaryRoot }) {
  let cursor = resolve(cwd);
  const boundary = resolve(boundaryRoot);
  while (pathInsideBoundary(boundary, cursor)) {
    const nodeModulesRoot = join(cursor, "node_modules");
    let nodeModulesEntryExists = false;
    try {
      await lstat(nodeModulesRoot);
      nodeModulesEntryExists = true;
      const nodeModulesBoundary = await inspectDirectoryWithinCanonicalBoundary({
        rootPath: boundary,
        rootRealPath: boundary,
        targetPath: nodeModulesRoot,
      });
      if (!nodeModulesBoundary.ok) {
        return {
          ok: false,
          reason: "dependency_tree_boundary_invalid",
          detail: `node_modules pro ${cwd} odkazuje mimo owning checkout; Lazurio ho nepoužije ani nezmění.`,
        };
      }
    } catch (error) {
      if (error?.code !== "ENOENT" || nodeModulesEntryExists) {
        return {
          ok: false,
          reason: "dependency_tree_inspection_failed",
          detail: `node_modules pro ${cwd} nejde bezpečně ověřit: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    }
    if (cursor === boundary) break;
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return { ok: true };
}

function dependencyMetadataNames(packageJson, dependencyName) {
  const spec = packageJson?.dependencies?.[dependencyName]
    ?? packageJson?.devDependencies?.[dependencyName];
  if (typeof spec !== "string" || !spec.startsWith("npm:")) return new Set([dependencyName]);
  const alias = npmAliasPackageName(spec.slice(4));
  return new Set(alias ? [alias] : [dependencyName]);
}

function npmAliasPackageName(spec) {
  if (!spec) return null;
  let name;
  if (spec.startsWith("@")) {
    const slash = spec.indexOf("/");
    if (slash < 2) return null;
    const versionSeparator = spec.indexOf("@", slash + 1);
    name = versionSeparator === -1 ? spec : spec.slice(0, versionSeparator);
  } else {
    const versionSeparator = spec.indexOf("@");
    name = versionSeparator === -1 ? spec : spec.slice(0, versionSeparator);
  }
  return dependencyPathParts(name) ? name : null;
}

function dependencyPathParts(dependencyName) {
  if (typeof dependencyName !== "string" || !dependencyName || dependencyName.includes("\\") || dependencyName.includes("\0")) return null;
  if (isAbsolute(dependencyName) || win32.isAbsolute(dependencyName)) return null;
  const parts = dependencyName.split("/");
  const validParts = dependencyName.startsWith("@")
    ? parts.length === 2 && parts[0].length > 1
    : parts.length === 1;
  if (!validParts || parts.some((part) => !part || part === "." || part === "..")) return null;
  return parts;
}

function pathInsideBoundary(boundary, candidate) {
  const pathFromBoundary = relative(boundary, candidate);
  return pathFromBoundary === ""
    || (pathFromBoundary !== ".." && !pathFromBoundary.startsWith(`..${sep}`) && !isAbsolute(pathFromBoundary));
}

function samePath(left, right) {
  return relative(resolve(left), resolve(right)) === "";
}

function unchangedFailure(result, mode) {
  return {
    ...result,
    mode,
    removed_node_modules: false,
    runtime_tree_usable: false,
  };
}
