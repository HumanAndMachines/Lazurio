import { expect, test } from "bun:test";
import {
  buildCodexPortConflictPrompt,
  buildCodexRuntimeIssuePrompt,
  isCodexPortConflict,
} from "../public/codex-handoff.js";
import { runtimeRecoveryForApp } from "../public/runtime-recovery.js";

const blockedApp = {
  id: "rozjedeme-ai-mission-control-v3",
  title: "Mission Control v3",
  company: "Rozjedeme-ai",
  port: 5392,
  cwd: "organizations/Rozjedeme-ai_GEN3/mission-control/app/v3",
  dependencies: {
    cwd: "organizations/Rozjedeme-ai_GEN3/mission-control/app/v3",
  },
  runtime: {
    failure_kind: "port_owner_cwd_mismatch",
    message: "Port 5392 používá proces z jiného checkoutu.",
    pid: 55429,
  },
};

test("Codex handoff pozná pouze cizího vlastníka portu", () => {
  expect(isCodexPortConflict(blockedApp)).toBe(true);
  expect(isCodexPortConflict({ runtime: { failure_kind: "port_owner_cwd_unknown" } })).toBe(false);
  expect(isCodexPortConflict({ runtime_status: "unhealthy" })).toBe(false);
});

test("Codex handoff předá přesný kontext a bezpečnostní hranice", () => {
  const prompt = buildCodexPortConflictPrompt(blockedApp);

  expect(prompt).toContain("Mission Control v3");
  expect(prompt).toContain("Rozjedeme-ai");
  expect(prompt).toContain("Port: 5392");
  expect(prompt).toContain("PID procesu na portu: 55429");
  expect(prompt).toContain("organizations/Rozjedeme-ai_GEN3/mission-control/app/v3");
  expect(prompt).toContain("Nejdřív pouze čtením ověř");
  expect(prompt).toContain("Pokud se PID změnil");
  expect(prompt).toContain("nic neukončuj");
  expect(prompt).toContain("neměň soubory, Git stav, závislosti ani data aplikací");
  expect(prompt).toContain("kliknu na „Obnovit stav“");
});

test("Codex handoff nevypíše undefined při neúplné diagnostice", () => {
  const prompt = buildCodexPortConflictPrompt({
    title: "Guide",
    runtime: { failure_kind: "port_owner_cwd_mismatch" },
  });

  expect(prompt).not.toContain("undefined");
  expect(prompt).not.toContain("null");
  expect(prompt).toContain("neuvedeno");
});

test("obecný runtime handoff nese chybu, scope a publikační hranici", () => {
  const prompt = buildCodexRuntimeIssuePrompt(blockedApp, {
    code: "invalid_discovery",
    failureKind: "invalid_discovery",
    technical: ["Lumbio: module_slots[3].path není kanonická boundary"],
  });

  expect(prompt).toContain("invalid_discovery");
  expect(prompt).toContain("Lumbio: module_slots[3].path");
  expect(prompt).toContain("správný root / Organizaci / modul");
  expect(prompt).toContain("Nic nemerguj ani nepublikuj");
  expect(prompt).toContain("ověř její health");
});

test("passive HTTP failure prompt carries exact scoped diagnostics without null placeholders", () => {
  const app = {
    id: "humanandmachine-ai-website-lazurio-v1",
    title: "Website Lazurio",
    company: "HumanAndMachine-ai",
    runtime_status: "unhealthy",
    health_url: "http://127.0.0.1:24215/",
    dependencies: {
      state: "ready",
      can_install: true,
      cwd: "organizations/HumanAndMachine-ai_GEN3/workspace/website-lazurio/app",
    },
    runtime: {
      message: "Managed proces odpověděl HTTP 500.",
      log_path: "logs/apps/humanandmachine-ai-website-lazurio-v1.log",
      probe: { status_code: 500 },
    },
  };

  const prompt = buildCodexRuntimeIssuePrompt(app, runtimeRecoveryForApp(app));
  expect(prompt).toContain("HumanAndMachine-ai");
  expect(prompt).toContain("humanandmachine-ai-website-lazurio-v1");
  expect(prompt).toContain("workspace/website-lazurio/app");
  expect(prompt).toContain("logs/apps/humanandmachine-ai-website-lazurio-v1.log");
  expect(prompt).toContain("HTTP 500");
  expect(prompt).not.toContain("undefined");
  expect(prompt).not.toContain("null");
});
