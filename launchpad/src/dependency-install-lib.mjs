import { existsSync } from "node:fs";
import { lstat, readFile, realpath, rename, rm } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

const BUN_LOCKFILES = Object.freeze(["bun.lock", "bun.lockb"]);
const NODE_MODULES_RECOVERY = ".lazurio-node_modules-recovery";

export function frozenBunInstallCommand(bunExecutable = process.execPath) {
  return [bunExecutable, "install", "--frozen-lockfile"];
}

export async function runFrozenBunInstall({
  cwd,
  boundaryRoot,
  mode = "ensure",
  command = frozenBunInstallCommand(),
  spawnProcess = Bun.spawn,
  env = process.env,
} = {}) {
  const packageRoot = await validatePackageRoot({ cwd, boundaryRoot });
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
    return {
      ok: false,
      reason: "node_modules_recovery_pending",
      detail: "Předchozí čistá oprava zůstala nedokončená; Lazurio ji musí bezpečně obnovit a zopakovat.",
      mode,
      removed_node_modules: false,
      runtime_tree_usable: false,
    };
  }

  let removedNodeModules = false;
  if (mode === "clean") {
    const prepared = await prepareCleanInstall(packageRoot.cwd);
    if (!prepared.ok) return { ...prepared, mode, removed_node_modules: false };
    removedNodeModules = prepared.had_previous_tree;
  }

  let installResult;
  try {
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
    if (exitCode !== 0) {
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
    } else if (packageRoot.requiresNodeModules && !existsSync(join(packageRoot.cwd, "node_modules"))) {
      installResult = {
        ok: false,
        reason: "dependency_install_incomplete",
        detail: "Instalace skončila bez chyby, ale nevytvořila očekávanou složku node_modules.",
        exit_code: exitCode,
        stdout,
        stderr,
        command,
        mode,
        removed_node_modules: removedNodeModules,
        runtime_tree_usable: mode === "ensure" ? false : null,
      };
    } else {
      installResult = {
        ok: true,
        exit_code: exitCode,
        stdout,
        stderr,
        command,
        mode,
        removed_node_modules: removedNodeModules,
        runtime_tree_usable: true,
      };
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
  const finalized = installResult.ok
    ? await discardPreviousTree(packageRoot.cwd)
    : await restorePreviousTree(packageRoot.cwd);
  if (!finalized.ok) {
    return {
      ...installResult,
      ok: false,
      reason: finalized.reason,
      detail: `${installResult.detail ? `${installResult.detail} ` : ""}${finalized.detail}`.trim(),
      rollback_ok: false,
      runtime_tree_usable: installResult.ok && existsSync(join(packageRoot.cwd, "node_modules")),
    };
  }
  return {
    ...installResult,
    rollback_ok: installResult.ok ? null : true,
    runtime_tree_usable: true,
  };
}

export async function refreshFrozenBunDependencies(options = {}) {
  const ensured = await runFrozenBunInstall({ ...options, mode: "ensure" });
  if (ensured.ok) {
    return { ...ensured, refresh_strategy: "ensure" };
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

async function validatePackageRoot({ cwd, boundaryRoot }) {
  if (!cwd || !boundaryRoot || !isAbsolute(cwd) || !isAbsolute(boundaryRoot)) {
    return { ok: false, reason: "package_root_invalid", detail: "Dependency install vyžaduje absolutní package a boundary cestu." };
  }
  let canonicalBoundary;
  let canonicalCwd;
  try {
    [canonicalBoundary, canonicalCwd] = await Promise.all([realpath(boundaryRoot), realpath(cwd)]);
  } catch (error) {
    return {
      ok: false,
      reason: "package_root_unavailable",
      detail: `Package root nejde bezpečně otevřít: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const pathFromBoundary = relative(canonicalBoundary, canonicalCwd);
  if (pathFromBoundary === ".." || pathFromBoundary.startsWith(`..${sep}`) || isAbsolute(pathFromBoundary)) {
    return { ok: false, reason: "package_root_outside_boundary", detail: "Package root leží mimo owning checkout." };
  }
  const packagePath = join(canonicalCwd, "package.json");
  if (!existsSync(packagePath)) {
    return { ok: false, reason: "package_json_missing", detail: "V package rootu chybí package.json." };
  }
  const lockfile = BUN_LOCKFILES.find((name) => existsSync(join(canonicalCwd, name))) ?? null;
  if (!lockfile) {
    return { ok: false, reason: "bun_lockfile_missing", detail: "V package rootu chybí Bun lockfile." };
  }
  try {
    const packageJson = JSON.parse(await readFile(packagePath, "utf8"));
    return {
      ok: true,
      cwd: canonicalCwd,
      boundary_root: canonicalBoundary,
      lockfile,
      requiresNodeModules: declaredDependencyCount(packageJson) > 0,
    };
  } catch (error) {
    return {
      ok: false,
      reason: "package_json_invalid",
      detail: `package.json nejde přečíst: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
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

function declaredDependencyCount(packageJson) {
  return ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]
    .map((key) => packageJson?.[key])
    .filter((value) => value && typeof value === "object" && !Array.isArray(value))
    .reduce((count, value) => count + Object.keys(value).length, 0);
}

function unchangedFailure(result, mode) {
  return {
    ...result,
    mode,
    removed_node_modules: false,
    runtime_tree_usable: true,
  };
}
