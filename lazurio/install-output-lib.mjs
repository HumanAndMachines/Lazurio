import cs from "./locales/install.cs.json";
import en from "./locales/install.en.json";
import {
  INSTALL_STEP_IDS,
  INSTALL_STEP_STATUSES,
  installReasonCodes,
  isValidLazurioInstallReport,
} from "./core/install-core-lib.mjs";

export const INSTALL_LANGUAGES = Object.freeze(["cs", "en"]);

const catalogs = Object.freeze({ cs, en });

export function selectInstallLanguage({ requested = null, environment = process.env } = {}) {
  if (requested !== null) {
    if (!INSTALL_LANGUAGES.includes(requested)) {
      throw new Error(`--language musí být ${INSTALL_LANGUAGES.join(" nebo ")}.`);
    }
    return requested;
  }
  const ambient = [environment.LC_ALL, environment.LC_MESSAGES, environment.LANG]
    .find((value) => typeof value === "string" && value !== "")
    ?.toLowerCase();
  if (ambient?.startsWith("en")) return "en";
  return "cs";
}

export function renderHumanInstallReport(report, { language = "cs" } = {}) {
  if (!isValidLazurioInstallReport(report)) {
    throw new Error("Nelze vykreslit neplatný instalační report.");
  }
  const catalog = catalogs[language];
  if (!catalog) throw new Error(`Nepodporovaný jazyk instalačního reportu: ${language}`);

  const lines = [
    catalog["report.title"],
    catalog["report.read_only"],
    `${catalog["report.status"]}: ${catalog[`status.${report.status}`]}`,
    `${catalog["report.machine"]}: ${report.machine.platform}/${report.machine.architecture}`,
    `${catalog["report.root"]}: ${printablePath(report.root.path)}`,
    "",
  ];

  for (const step of report.steps) {
    lines.push(
      `${symbol(step.status)} ${catalog[`step.${step.id}`]} — ${renderInstallText(catalog[`reason.${step.reason}`], report)}`,
    );
  }

  const actions = report.steps
    .filter((step) => step.status === "action_required" || step.status === "failed")
    .map((step) => renderInstallText(catalog[`action.${step.reason}`], report))
    .filter(Boolean);
  if (actions.length > 0) {
    lines.push("", catalog["report.next_actions"]);
    for (const action of actions) lines.push(`- ${action}`);
  }
  lines.push("", catalog["report.footer"]);
  return lines.join("\n");
}

function renderInstallText(template, report) {
  if (typeof template !== "string") return template;
  return template
    .replaceAll("{current}", report.machine.bun.current_version ?? "unknown")
    .replaceAll("{required}", report.machine.bun.required_version);
}

export function installCatalogIssues() {
  const requiredKeys = new Set([
    "report.title",
    "report.read_only",
    "report.status",
    "report.machine",
    "report.root",
    "report.next_actions",
    "report.footer",
    ...INSTALL_STEP_IDS.map((id) => `step.${id}`),
    ...INSTALL_STEP_STATUSES.map((status) => `status.${status}`),
    ...installReasonCodes().map((reason) => `reason.${reason}`),
  ]);
  const issues = [];
  for (const language of INSTALL_LANGUAGES) {
    const catalog = catalogs[language];
    for (const key of requiredKeys) {
      if (typeof catalog[key] !== "string" || catalog[key] === "") {
        issues.push(`${language}: missing ${key}`);
      }
    }
    for (const key of Object.keys(catalog)) {
      if (!requiredKeys.has(key) && !key.startsWith("action.")) {
        issues.push(`${language}: orphan ${key}`);
      }
      if (key.startsWith("action.") && !installReasonCodes().includes(key.slice("action.".length))) {
        issues.push(`${language}: orphan ${key}`);
      }
    }
  }
  const referenceKeys = Object.keys(catalogs.cs).sort().join("\n");
  for (const language of INSTALL_LANGUAGES.slice(1)) {
    if (Object.keys(catalogs[language]).sort().join("\n") !== referenceKeys) {
      issues.push(`${language}: catalog keys differ from cs`);
    }
  }
  return issues;
}

function symbol(status) {
  if (status === "completed") return "✓";
  if (status === "skipped") return "–";
  if (status === "action_required") return "!";
  return "×";
}

function printablePath(path) {
  return JSON.stringify(path);
}
