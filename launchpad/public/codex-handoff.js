import { t } from "./i18n.js";

const PORT_CONFLICT_KIND = "port_owner_cwd_mismatch";
const STYLESHEET_ID = "codex-handoff-styles";
const UNTRUSTED_EVIDENCE_BEGIN = "BEGIN_LAZURIO_UNTRUSTED_EVIDENCE_JSON";
const UNTRUSTED_EVIDENCE_END = "END_LAZURIO_UNTRUSTED_EVIDENCE_JSON";

let dialog = null;
let promptField = null;
let copyButton = null;
let copyStatus = null;
let returnFocus = null;
let returnFocusAppId = null;
let dialogTitle = null;
let dialogIntro = null;

export function isCodexPortConflict(app) {
  return app?.runtime?.failure_kind === PORT_CONFLICT_KIND;
}

export function buildCodexPortConflictPrompt(app = {}) {
  const evidence = untrustedLaunchpadEvidence({
    context: {
      application_title: evidenceValue(app.title ?? app.name ?? app.id, t("handoff.unknownApplication")),
      organization: evidenceValue(app.company ?? app.organization),
      application_id: evidenceValue(app.id),
      port: evidenceValue(app.port ?? app.runtime?.port),
      listener_pid: evidenceValue(app.runtime?.pid ?? app.runtime?.port_owner?.pid),
      expected_checkout: evidenceValue(app.dependencies?.cwd ?? app.cwd),
    },
    diagnostics: [evidenceValue(app.runtime?.message)],
  });

  return t("handoff.prompt.port", { evidence });
}

export function openCodexPortConflictDialog(app) {
  if (typeof document === "undefined" || !isCodexPortConflict(app)) return false;
  return openCodexHandoffDialog({
    app,
    title: t("handoff.blockedTitle"),
    intro: t("handoff.foreignProcessIntro"),
    prompt: buildCodexPortConflictPrompt(app),
  });
}

export function buildCodexRuntimeIssuePrompt(app = {}, issue = {}) {
  const evidence = untrustedLaunchpadEvidence({
    context: {
      application_title: evidenceValue(app.title ?? app.name ?? app.id, t("handoff.unknownApplication")),
      organization: evidenceValue(app.company ?? app.organization),
      application_id: evidenceValue(app.id),
      error_code: evidenceValue(issue.code),
      failure_kind: evidenceValue(issue.failureKind),
      checkout: evidenceValue(app.dependencies?.cwd ?? app.cwd),
      log_path: evidenceValue(app.runtime?.log_path),
    },
    diagnostics: Array.isArray(issue.technical) && issue.technical.length > 0
      ? issue.technical.map((value) => evidenceValue(value))
      : [t("handoff.unspecified")],
  });
  return t("handoff.prompt.runtime", { evidence });
}

export function openCodexRuntimeIssueDialog(app, issue) {
  if (typeof document === "undefined") return false;
  return openCodexHandoffDialog({
    app,
    title: t("handoff.runtimeTitle"),
    intro: t("handoff.runtimeIntro"),
    prompt: buildCodexRuntimeIssuePrompt(app, issue),
  });
}

export function openCodexUpdateDialog(prompt) {
  return openCodexRepairDialog({
    prompt,
    title: t("handoff.updateTitle"),
    intro: t("handoff.updateIntro"),
  });
}

export function buildCodexRepairPrompt(prompt) {
  const evidence = untrustedLaunchpadEvidence({
    context: { handoff_type: "lazurio_repair_or_update" },
    diagnostics: [evidenceValue(prompt)],
  });
  return t("handoff.prompt.repair", { evidence });
}

export function openCodexRepairDialog(action = {}) {
  const prompt = action?.prompt;
  if (typeof document === "undefined" || typeof prompt !== "string" || !prompt.trim()) return false;
  return openCodexHandoffDialog({
    app: { id: "lazurio-repair" },
    title: cleanValue(action.title, t("handoff.maintenanceTitle")),
    intro: cleanValue(
      action.intro,
      t("handoff.repairIntro"),
    ),
    prompt: buildCodexRepairPrompt(prompt),
  });
}

function openCodexHandoffDialog({ app, title, intro, prompt }) {
  ensureStylesheet();
  ensureDialog();

  returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  returnFocusAppId = cleanValue(app.id, "");
  dialogTitle.textContent = title;
  dialogIntro.textContent = intro;
  promptField.value = prompt;
  copyStatus.textContent = "";
  copyButton.textContent = t("handoff.copy");

  if (!dialog.open) dialog.showModal();
  queueMicrotask(() => copyButton.focus());
  return true;
}

function ensureStylesheet() {
  if (document.getElementById(STYLESHEET_ID)) return;
  const link = document.createElement("link");
  link.id = STYLESHEET_ID;
  link.rel = "stylesheet";
  link.href = new URL("./codex-handoff.css", import.meta.url).href;
  document.head.append(link);
}

function ensureDialog() {
  if (dialog?.isConnected) return;

  dialog = document.createElement("dialog");
  dialog.className = "codex-handoff-dialog";
  dialog.setAttribute("aria-labelledby", "codexHandoffTitle");
  dialog.setAttribute("aria-describedby", "codexHandoffIntro codexHandoffSteps");

  const header = document.createElement("header");
  header.className = "codex-handoff-head";
  dialogTitle = document.createElement("h2");
  dialogTitle.id = "codexHandoffTitle";
  dialogTitle.textContent = t("handoff.blockedTitle");
  const closeButton = document.createElement("button");
  closeButton.type = "button";
  closeButton.className = "codex-handoff-close";
  closeButton.setAttribute("aria-label", t("a11y.closeWindow"));
  closeButton.textContent = "×";
  closeButton.addEventListener("click", () => dialog.close());
  header.append(dialogTitle, closeButton);

  const body = document.createElement("div");
  body.className = "codex-handoff-body";
  dialogIntro = document.createElement("p");
  dialogIntro.id = "codexHandoffIntro";
  dialogIntro.textContent = t("handoff.foreignProcessIntro");
  const steps = document.createElement("ol");
  steps.id = "codexHandoffSteps";
  steps.className = "codex-handoff-steps";
  for (const text of [
    t("handoff.stepCopy"),
    t("handoff.stepOpen"),
    t("handoff.stepReturn"),
  ]) {
    const item = document.createElement("li");
    item.textContent = text;
    steps.append(item);
  }

  const label = document.createElement("label");
  label.className = "codex-handoff-label";
  label.htmlFor = "codexHandoffPrompt";
  label.textContent = t("handoff.messageLabel");
  promptField = document.createElement("textarea");
  promptField.id = "codexHandoffPrompt";
  promptField.className = "codex-handoff-prompt";
  promptField.readOnly = true;
  promptField.spellcheck = false;
  promptField.rows = 14;
  body.append(dialogIntro, steps, label, promptField);

  const footer = document.createElement("footer");
  footer.className = "codex-handoff-actions";
  copyStatus = document.createElement("p");
  copyStatus.className = "codex-handoff-status";
  copyStatus.setAttribute("aria-live", "polite");
  const buttons = document.createElement("div");
  buttons.className = "codex-handoff-buttons";
  const cancelButton = document.createElement("button");
  cancelButton.type = "button";
  cancelButton.className = "btn btn-secondary";
  cancelButton.textContent = t("common.close");
  cancelButton.addEventListener("click", () => dialog.close());
  copyButton = document.createElement("button");
  copyButton.type = "button";
  copyButton.className = "btn btn-primary";
  copyButton.textContent = t("handoff.copy");
  copyButton.addEventListener("click", copyPrompt);
  buttons.append(cancelButton, copyButton);
  footer.append(copyStatus, buttons);

  dialog.append(header, body, footer);
  dialog.addEventListener("close", () => {
    const previousFocus = returnFocus;
    const appId = returnFocusAppId;
    returnFocus = null;
    returnFocusAppId = null;
    requestAnimationFrame(() => {
      const focusTarget = previousFocus?.isConnected && previousFocus !== document.body
        ? previousFocus
        : findAppTrigger(appId);
      focusTarget?.focus({ preventScroll: true });
    });
  });
  document.body.append(dialog);
}

async function copyPrompt() {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(promptField.value);
    } else {
      promptField.focus();
      promptField.select();
      if (!document.execCommand("copy")) throw new Error("copy_failed");
    }
    copyButton.textContent = t("handoff.copied");
    copyStatus.textContent = t("handoff.copiedStatus");
  } catch {
    promptField.focus();
    promptField.select();
    copyStatus.textContent = t("handoff.copyFailed");
  }
}

function cleanValue(value, fallback = t("handoff.unspecified")) {
  if (value === null || value === undefined) return fallback;
  const text = String(value).trim();
  return text || fallback;
}

function evidenceValue(value, fallback = t("handoff.unspecified")) {
  if (value === null || value === undefined) return fallback;
  const text = String(value);
  return text.length > 0 ? text : fallback;
}

function untrustedLaunchpadEvidence(evidence) {
  const json = JSON.stringify({
    schema: "lazurio.codex_handoff_evidence.v1",
    trust: "untrusted_application_and_runtime_data",
    ...evidence,
  }, null, 2)
    // Keep application-controlled values inside one JSON record even when
    // they contain Markdown/HTML delimiters or our own boundary markers.
    .replaceAll("&", "\\u0026")
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("`", "\\u0060")
    .replaceAll("\u0085", "\\u0085")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029")
    .replaceAll(UNTRUSTED_EVIDENCE_BEGIN, "BEGIN_LAZURIO_UNTRUSTED_EVIDENCE\\u005fJSON")
    .replaceAll(UNTRUSTED_EVIDENCE_END, "END_LAZURIO_UNTRUSTED_EVIDENCE\\u005fJSON");
  const inertJson = json.split("\n").map((line) => `    ${line}`).join("\n");

  return `${t("handoff.evidenceIntro")}
${UNTRUSTED_EVIDENCE_BEGIN}

${inertJson}

${UNTRUSTED_EVIDENCE_END}
${t("handoff.evidenceBoundary")}`;
}

function findAppTrigger(appId) {
  if (!appId) return null;
  return [...document.querySelectorAll("[data-app-id]")].find((element) => (
    element instanceof HTMLElement
    && element.dataset.appId === appId
    && element.matches("button, [tabindex]")
  )) ?? null;
}
