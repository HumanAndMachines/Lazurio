import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { buildCodexRuntimeIssuePrompt } from "../public/codex-handoff.js";
import { runtimeRecoveryForApp } from "../public/runtime-recovery.js";

const publicRoot = join(import.meta.dirname, "..", "public");

test("portový blokátor otevírá přístupný Codex handoff dialog", async () => {
  const [app, component, css] = await Promise.all([
    readFile(join(publicRoot, "app.js"), "utf8"),
    readFile(join(publicRoot, "codex-handoff.js"), "utf8"),
    readFile(join(publicRoot, "codex-handoff.css"), "utf8"),
  ]);

  expect(app).toContain('from "./codex-handoff.js"');
  expect(app).toContain("isCodexPortConflict(app)");
  expect(app).toContain("openCodexPortConflictDialog(app)");
  expect(app).toContain('action.textContent = isCodexPortConflict(app) ? "Vyřešit s Codexem" : "Zobrazit aplikaci"');
  expect(app).toContain("action.dataset.appId = app.id");
  expect(component).toContain('document.createElement("dialog")');
  expect(component).toContain('dialog.setAttribute("aria-labelledby", "codexHandoffTitle")');
  expect(component).toContain('copyStatus.setAttribute("aria-live", "polite")');
  expect(component).toContain('copyButton.textContent = "Zkopírovat zprávu"');
  expect(component).toContain('navigator.clipboard?.writeText');
  expect(component).toContain("findAppTrigger(appId)");
  expect(component).toContain("focusTarget?.focus({ preventScroll: true })");
  expect(css).toContain(".codex-handoff-dialog::backdrop");
  expect(css).toContain("@media (max-width: 640px)");
});

test("Codex prompt po capability downgrade zachová původní runtime příčinu", () => {
  const app = {
    id: "humanandmachine-ai-website-v1",
    title: "Website Lazurio",
    company: "HumanAndMachine-ai",
    cwd: "organizations/HumanAndMachine-ai/workspace/website/app/v1",
    dependencies: {
      state: "ready",
      can_install: false,
      cwd: "/machine/organizations/HumanAndMachine-ai/workspace/website/app/v1",
      message: "Chybí bezpečný frozen install kontrakt.",
    },
    runtime_status: "unhealthy",
    runtime: {
      failure_kind: "install_script_failed",
      message: "Cannot find package simple-icons.",
      log_path: "logs/apps/humanandmachine-ai-website-v1.log",
    },
  };
  const issue = runtimeRecoveryForApp(app);
  const prompt = buildCodexRuntimeIssuePrompt(app, issue);

  expect(issue).toMatchObject({
    action: "codex",
    failureKind: "dependency_install_unavailable",
  });
  expect(prompt).toContain("Původní kód chyby: app_unhealthy");
  expect(prompt).toContain("Původní druh selhání: install_script_failed");
  expect(prompt).not.toContain("undefined");
  expect(prompt).not.toContain("null");
});
