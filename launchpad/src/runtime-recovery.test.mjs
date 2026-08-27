import { expect, test } from "bun:test";
import { runtimeRecoveryForApp, runtimeRecoveryModel } from "../public/runtime-recovery.js";

test("cross-Organization discovery failure offers a concrete Codex repair handoff", () => {
  const model = runtimeRecoveryModel(Object.assign(
    new Error("Runtime akce vyžaduje validní Launchpad discovery."),
    {
      code: "invalid_discovery",
      payload: {
        error: "invalid_discovery",
        failure_kind: "invalid_discovery",
        message: "Organizace Lumbio potřebuje opravit nastavení.",
        details: ["modules.manifest.json module_slots[3].path není kanonická boundary"],
      },
    },
  ));

  expect(model).toMatchObject({
    title: "Nastavení aplikace je potřeba opravit",
    action: "codex",
    actionLabel: "Vyřešit s Codexem",
    code: "invalid_discovery",
    failureKind: "invalid_discovery",
  });
  expect(model.technical.join("\n")).toContain("module_slots[3]");
});

test("missing dependencies offer direct scoped repair", () => {
  const model = runtimeRecoveryModel({
    code: "app_start_failed",
    message: "Chybí dependencies.",
    payload: { failure_kind: "missing_dependencies" },
  });

  expect(model.action).toBe("repair");
  expect(model.actionLabel).toBe("Opravit balíčky");
});

test("unknown early exit never degrades to a logs-only dead end", () => {
  const model = runtimeRecoveryModel({
    code: "app_start_failed",
    payload: {
      failure_kind: "unknown_early_exit",
      log_excerpt: "process exited 1",
    },
  });

  expect(model.action).toBe("codex");
  expect(model.message).not.toContain("podívej se na logy");
});

test("passive HTTP health failure offers the same scoped Codex handoff", () => {
  const model = runtimeRecoveryForApp({
    runtime_status: "unhealthy",
    health_url: "http://127.0.0.1:24215/",
    dependencies: {
      message: "Website Lazurio: dependency state je ready.",
    },
    runtime: {
      message: "Managed proces odpověděl HTTP 500.",
    },
  });

  expect(model).toMatchObject({
    action: "codex",
    actionLabel: "Vyřešit s Codexem",
    code: "app_unhealthy",
    failureKind: "health_failed",
  });
  expect(model.technical).toContain("Managed proces odpověděl HTTP 500.");
  expect(model.technical).toContain("Health endpoint: http://127.0.0.1:24215/");
});

test("missing dependency state takes precedence over an unhealthy runtime", () => {
  const model = runtimeRecoveryForApp({
    runtime_status: "unhealthy",
    dependencies: {
      state: "needs_install",
      can_install: true,
      message: "Chybí simple-icons.",
      missing_required_dependencies: ["simple-icons"],
    },
    runtime: { message: "Managed proces odpověděl HTTP 500." },
  });

  expect(model).toMatchObject({
    action: "install",
    actionLabel: "Instalovat",
    failureKind: "missing_dependencies",
  });
  expect(model.technical).toContain("Chybí balíček: simple-icons");
});

test("missing dependencies without a frozen install capability fail closed to Codex", () => {
  const model = runtimeRecoveryForApp({
    runtime_status: "unhealthy",
    dependencies: {
      state: "needs_install",
      can_install: false,
      message: "Chybí Bun lockfile.",
      missing_required_dependencies: ["simple-icons"],
    },
  });

  expect(model).toMatchObject({
    action: "codex",
    actionLabel: "Vyřešit s Codexem",
    failureKind: "dependency_install_unavailable",
  });
});

test("missing lockfile hands the exact repair contract to Codex without Install", () => {
  const model = runtimeRecoveryForApp({
    runtime_status: "stopped",
    dependencies: {
      state: "missing_lockfile",
      can_install: false,
      message: "Chybí podporovaný lockfile; vytvoř a commitni ho.",
      missing_required_dependencies: ["simple-icons"],
    },
  });

  expect(model).toMatchObject({
    action: "codex",
    actionLabel: "Vyřešit s Codexem",
    failureKind: "missing_lockfile",
  });
  expect(model.technical).toContain("Chybí podporovaný lockfile; vytvoř a commitni ho.");
});

test("an invalid dependency boundary is never openable and hands exact evidence to Codex", () => {
  const model = runtimeRecoveryForApp({
    runtime_status: "healthy",
    url: "http://127.0.0.1:4174/",
    dependencies: {
      state: "dependency_boundary_invalid",
      can_install: false,
      message: "node_modules odkazuje mimo owning checkout.",
    },
  });

  expect(model).toMatchObject({
    action: "codex",
    actionLabel: "Vyřešit s Codexem",
    failureKind: "dependency_boundary_invalid",
  });
  expect(model.technical).toContain("node_modules odkazuje mimo owning checkout.");
});

test("passive missing-dependency failure offers Repair only with install capability", () => {
  const app = {
    runtime_status: "unhealthy",
    dependencies: { state: "ready", can_install: true },
    runtime: { failure_kind: "missing_dependencies", message: "Cannot find package simple-icons." },
  };

  expect(runtimeRecoveryForApp(app).action).toBe("repair");
  const unavailable = runtimeRecoveryForApp({
    ...app,
    dependencies: { ...app.dependencies, can_install: false },
  });
  expect(unavailable).toMatchObject({ action: "codex", failureKind: "dependency_install_unavailable" });
  expect(unavailable.technical).toContain("Původní kód chyby: app_unhealthy");
  expect(unavailable.technical).toContain("Původní druh selhání: missing_dependencies");
});

test("passive health timeout remains retryable", () => {
  expect(runtimeRecoveryForApp({
    runtime_status: "unhealthy",
    dependencies: { state: "ready", can_install: true },
    runtime: { failure_kind: "health_timeout", message: "Health endpoint zatím neodpovídá." },
  })).toMatchObject({ action: "retry", actionLabel: "Zkusit znovu" });
});
