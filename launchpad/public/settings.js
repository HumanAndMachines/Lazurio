import { getLocale, initializeI18n, setLocale, t } from "./i18n.js";
import { launchpadFetch } from "./session-aware-fetch.js";
import { mountGitHubStep } from "./setup-github.js";
import { mountSshAccessStep, readSshAccess } from "./ssh-access.js";

// Settings of this Environment — the Machine serving this Launchpad. One page,
// a left list of sections and one section at a time, addressed by the path
// (/settings/general, /settings/github, /settings/ssh; the server serves this
// page for all of them). Each section is a self-contained step mounted on its
// first visit; a section the profile does not offer (SSH on localhost) never
// appears in the list. The Launchpad shell only links here.

initializeI18n();

const SECTIONS = ["general", "github", "ssh"];
const navItems = new Map([...document.querySelectorAll(".settings-nav-item")].map((item) => [item.dataset.section, item]));
const sections = new Map([...document.querySelectorAll(".settings-section")].map((section) => [section.dataset.section, section]));
const crumb = document.getElementById("settingsCrumb");
const mounted = new Set();
const available = new Set(["general", "github"]);

function pathSection() {
  return window.location.pathname.split("/").pop();
}

function requestedSection() {
  const requested = pathSection();
  return SECTIONS.includes(requested) && available.has(requested) ? requested : "general";
}

function navigate(section) {
  if (pathSection() !== section) window.history.pushState(null, "", section);
  activate();
}

function activate() {
  const active = requestedSection();
  for (const [id, section] of sections) section.hidden = id !== active;
  for (const [id, item] of navItems) {
    if (id === active) item.setAttribute("aria-current", "page");
    else item.removeAttribute("aria-current");
  }
  crumb.textContent = t(`settings.nav.${active}`);
  if (mounted.has(active)) return;
  mounted.add(active);
  if (active === "github") mountGitHubStep();
  if (active === "ssh") void mountSshAccessStep(document.getElementById("settingsSshStep"));
}

function mountLanguage() {
  const select = document.getElementById("settingsLanguage");
  for (const locale of ["cs", "en"]) {
    const option = document.createElement("option");
    option.value = locale;
    option.textContent = t(`locale.${locale}`);
    select.append(option);
  }
  select.value = getLocale();
  select.addEventListener("change", () => {
    if (select.value === getLocale()) return;
    setLocale(select.value);
    window.location.reload();
  });
}

async function mountEnvironment() {
  const container = document.getElementById("settingsEnvironment");
  try {
    const response = await launchpadFetch("/api/setup/environment", { cache: "no-store" });
    if (!response.ok) throw new Error("http_error");
    renderEnvironment(container, await response.json());
  } catch {
    container.replaceChildren(row(t("settings.environment.kind"), t("settings.environment.loadFailed"), { className: "settings-error" }));
  }
}

function renderEnvironment(container, environment) {
  const kind = environment.profile === "hosted"
    ? (environment.scope === "personal" ? "personal" : "organization")
    : "local";
  const rows = [row(t("settings.environment.kind"), t(`settings.environment.kind.${kind}`))];
  for (const [key, value] of [
    ["machine", environment.machine],
    ["organization", environment.organization_slug],
    ["team", environment.team_id],
    ["domain", environment.domain],
  ]) {
    if (value) rows.push(row(t(`settings.environment.${key}`), value, { mono: true }));
  }
  container.replaceChildren(...rows);
}

function row(label, value, { className = "", mono = false } = {}) {
  const node = document.createElement("div");
  node.className = "settings-row";
  const copy = document.createElement("span");
  copy.className = "settings-row-copy";
  const name = document.createElement("span");
  name.className = "settings-row-label";
  name.textContent = label;
  copy.append(name);
  const detail = document.createElement("span");
  detail.className = `settings-row-value ${className}`.trim();
  if (mono) {
    const code = document.createElement("code");
    code.textContent = value;
    detail.append(code);
  } else {
    detail.textContent = value;
  }
  node.append(copy, detail);
  return node;
}

// Only a hosted server answers available: true; the localhost profile keeps
// the SSH section out of the list entirely.
async function revealSshSection() {
  const state = await readSshAccess().catch(() => null);
  if (!state?.available) return;
  available.add("ssh");
  navItems.get("ssh").hidden = false;
  if (pathSection() === "ssh") activate();
}

for (const [id, item] of navItems) {
  item.addEventListener("click", (event) => {
    event.preventDefault();
    navigate(id);
  });
}

mountLanguage();
void mountEnvironment();
void revealSshSection();
window.addEventListener("popstate", activate);
activate();
