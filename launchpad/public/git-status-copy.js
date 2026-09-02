// Lidské texty git stavů (CAC-0044, step-005 prep) — portované 1:1 z GEN2
// Kontroly (GEN2 Launchpad app.js). Launchpad je
// builder surface pro neprogramátory: git mechanika se překládá do lidského
// jazyka, žádný git žargon v primárním UI.
//
// Tenhle modul je čistá copy/prezentační vrstva — nemá žádnou org-specific
// pravdu ani git implementaci. Data (status stringy) mu dodá git read model
// z CAC-0042. Bez dostupného git read modelu se chip na kartě chová graceful:
// bez git dat se prostě nezobrazí (viz gitChipModel).

import { t } from "./i18n.js";

// Krátký lidský label stavu — pro chip na kartě.
export function humanGitStatusLabel(status) {
  const keys = {
    up_to_date: "up_to_date",
    pull_available: "pull_available",
    update_available: "pull_available",
    push_required: "push_required",
    diverged: "diverged",
    draft_changes: "draft_changes",
    dirty_local_changes: "draft_changes",
    wrong_branch: "wrong_branch",
    rebase_in_progress: "rebase_in_progress",
    git_am_in_progress: "git_am_in_progress",
    not_on_main: "wrong_branch",
    repo_missing: "repo_missing",
    git_unavailable: "git_unavailable",
    check_failed: "check_failed",
  };
  return keys[status] ? t(`git.label.${keys[status]}`) : status;
}

// Delší vysvětlení stavu — pro detail a ⋯ menu. Diverged/wrong_branch vedou na
// pomocníka, ne na automatický pull (nesmí zamlčet riziko).
export function gitStatusUserMessage(repo) {
  if (!repo) return "";
  const keys = {
    up_to_date: "up_to_date",
    pull_available: "pull_available",
    update_available: "pull_available",
    push_required: "push_required",
    diverged: "diverged",
    draft_changes: "draft_changes",
    dirty_local_changes: "draft_changes",
    wrong_branch: "wrong_branch",
    rebase_in_progress: "rebase_in_progress",
    git_am_in_progress: "git_am_in_progress",
    not_on_main: "wrong_branch",
    repo_missing: "repo_missing",
    git_unavailable: "git_unavailable",
    check_failed: "check_failed",
  };
  return keys[repo.status] ? t(`git.message.${keys[repo.status]}`) : repo.message ?? repo.title ?? "";
}

// Tón chipu podle severity (ok/warn/fail) → mapuje na chip- třídy v CSS.
export function gitStatusTone(status) {
  const okStates = ["up_to_date"];
  const failStates = [
    "diverged",
    "rebase_in_progress",
    "git_am_in_progress",
    "repo_missing",
    "git_unavailable",
    "check_failed",
  ];
  if (okStates.includes(status)) return "muted";
  if (failStates.includes(status)) return "danger";
  return "warn";
}

// Git attention: stavy, které mají modul zahrnout při zapnutém kontrolním togglu.
// up_to_date není attention; všechno ostatní ano.
export function isGitAttentionStatus(status) {
  if (!status) return false;
  return status !== "up_to_date";
}

// Chip model pro kartu s graceful absencí. Vrací null, když git data nejsou —
// karta pak git chip vůbec nevykreslí (dokud git read model není dostupný).
export function gitChipModel(gitRepo) {
  if (!gitRepo || typeof gitRepo.status !== "string") return null;
  return {
    status: gitRepo.status,
    label: humanGitStatusLabel(gitRepo.status),
    message: gitStatusUserMessage(gitRepo),
    tone: gitStatusTone(gitRepo.status),
    attention: isGitAttentionStatus(gitRepo.status),
  };
}
