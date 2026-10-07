import { expect, test } from "bun:test";
import { buildCodexRuntimeIssuePrompt } from "../public/codex-handoff.js";
import { runtimeRecoveryForApp } from "../public/runtime-recovery.js";

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
