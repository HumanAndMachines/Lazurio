export function runtimeRecoveryModel(error = {}) {
  const payload = error?.payload && typeof error.payload === "object" ? error.payload : {};
  const code = cleanToken(error?.code ?? payload.error ?? "runtime_action_failed");
  const failureKind = cleanToken(payload.failure_kind ?? error?.failure_kind ?? code);
  const technical = uniqueStrings([
    payload.message,
    error?.message,
    ...(Array.isArray(payload.details) ? payload.details : []),
    ...(Array.isArray(error?.details) ? error.details : []),
  ]);

  if (["invalid_discovery", "invalid_manifest", "bad_cwd", "missing_script"].includes(failureKind)
    || ["invalid_discovery", "invalid_manifest", "app_not_found"].includes(code)) {
    return {
      title: "Nastavení aplikace je potřeba opravit",
      message: "Launchpad aplikaci bezpečně nespustil. Připravil přesný kontext, se kterým může Codex opravit správnou deklaraci a ověřit spuštění.",
      action: "codex",
      actionLabel: "Vyřešit s Codexem",
      code,
      failureKind,
      technical,
    };
  }

  if (["missing_dependencies", "needs_install", "install_script_failed", "missing_package"].includes(failureKind)
    || ["app_install_failed", "app_repair_failed"].includes(code)) {
    return {
      title: "Aplikaci je potřeba opravit",
      message: "Chybí nebo nesedí potřebné součásti. Launchpad je může bezpečně opravit v rozsahu této aplikace.",
      action: "repair",
      actionLabel: "Opravit balíčky",
      code,
      failureKind,
      technical,
    };
  }

  if (["start_timeout", "starting_timeout", "health_timeout"].includes(failureKind)) {
    return {
      title: "Aplikace startuje příliš dlouho",
      message: "Launchpad zatím nepotvrdil, že aplikace odpovídá. Stav můžete znovu ověřit a spuštění bezpečně zopakovat.",
      action: "retry",
      actionLabel: "Zkusit znovu",
      code,
      failureKind,
      technical,
    };
  }

  return {
    title: "Spuštění se nepovedlo",
    message: "Launchpad zachoval přesnou příčinu a připravil bezpečné předání do Codexu, který problém ověří a opraví ve správném scope.",
    action: "codex",
    actionLabel: "Vyřešit s Codexem",
    code,
    failureKind,
    technical,
  };
}

export function runtimeRecoveryForApp(app = {}, error = null) {
  const runtime = app?.runtime && typeof app.runtime === "object" ? app.runtime : {};
  const details = uniqueStrings([
    ...(Array.isArray(app?.dependencies?.missing_required_dependencies)
      ? app.dependencies.missing_required_dependencies.map((name) => `Chybí balíček: ${name}`)
      : []),
    runtime.last_error,
    runtime.message,
    Number.isInteger(runtime?.probe?.status_code) ? `Health odpověděl HTTP ${runtime.probe.status_code}.` : null,
    runtime?.probe?.error,
    app?.dependencies?.message,
    app?.health_url ? `Health endpoint: ${app.health_url}` : null,
  ]);

  if (error) {
    return clampRecoveryToAppCapabilities(app, runtimeRecoveryModel(error), details);
  }

  if (app?.dependencies?.state === "needs_install") {
    if (app.dependencies?.can_install === true) {
      return {
        title: "Aplikaci je potřeba připravit",
        message: "Než ji otevřete, je potřeba bezpečně doplnit chybějící balíčky podle uzamčených verzí.",
        action: "install",
        actionLabel: "Instalovat",
        code: "dependencies_incomplete",
        failureKind: "missing_dependencies",
        technical: details,
      };
    }
    return runtimeRecoveryModel({
      code: "app_install_unavailable",
      message: app.dependencies?.message ?? "Chybějící balíčky nelze bezpečně nainstalovat z verzovaného lockfilu.",
      payload: {
        error: "app_install_unavailable",
        failure_kind: "dependency_install_unavailable",
        details,
      },
    });
  }

  if (app?.dependencies?.state === "dependency_boundary_invalid") {
    return runtimeRecoveryModel({
      code: "app_dependency_boundary_invalid",
      message: app.dependencies?.message ?? "Dependency strom aplikace překračuje owning checkout.",
      payload: {
        error: "app_dependency_boundary_invalid",
        failure_kind: "dependency_boundary_invalid",
        details,
      },
    });
  }

  if (["missing_lockfile", "missing_package", "unknown_package_manager"].includes(app?.dependencies?.state)) {
    const dependencyState = app.dependencies.state;
    return clampRecoveryToAppCapabilities(app, runtimeRecoveryModel({
      code: `app_${dependencyState}`,
      message: app.dependencies?.message ?? "Dependency kontrakt aplikace je potřeba opravit.",
      payload: {
        error: `app_${dependencyState}`,
        failure_kind: dependencyState,
        details,
      },
    }), details);
  }

  if (app?.runtime_status !== "unhealthy") return null;
  return clampRecoveryToAppCapabilities(app, runtimeRecoveryModel({
    code: "app_unhealthy",
    message: runtime.last_error ?? runtime.message ?? "Aplikace neprošla kontrolou health endpointu.",
    payload: {
      error: "app_unhealthy",
      failure_kind: runtime.failure_kind ?? "health_failed",
      message: runtime.last_error ?? runtime.message,
      details,
    },
  }), details);
}

function clampRecoveryToAppCapabilities(app, recovery, technical = []) {
  const mergedTechnical = uniqueStrings([...(recovery.technical ?? []), ...technical]);
  if (!["install", "repair"].includes(recovery.action) || app?.dependencies?.can_install === true) {
    return { ...recovery, technical: mergedTechnical };
  }
  const preservedCause = uniqueStrings([
    `Původní kód chyby: ${recovery.code}`,
    `Původní druh selhání: ${recovery.failureKind}`,
    ...mergedTechnical,
  ]);
  return runtimeRecoveryModel({
    code: "app_install_unavailable",
    message: app?.dependencies?.message ?? recovery.message,
    payload: {
      error: "app_install_unavailable",
      failure_kind: "dependency_install_unavailable",
      details: preservedCause,
    },
  });
}

function cleanToken(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "runtime_action_failed";
}

function uniqueStrings(values) {
  return [...new Set(values
    .filter((value) => value !== null && value !== undefined)
    .map((value) => String(value).trim())
    .filter(Boolean))];
}
