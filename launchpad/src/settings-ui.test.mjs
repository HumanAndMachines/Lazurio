import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const publicRoot = join(import.meta.dirname, "..", "public");
const read = (name) => readFile(join(publicRoot, name), "utf8");

test("the shell links to Settings once and keeps no setup buttons of its own", async () => {
  const [html, app, css] = await Promise.all([read("index.html"), read("app.js"), read("styles.css")]);
  expect(html).toMatch(/<a\s+id="settingsLink"\s+href="\.\/settings\/"/);
  expect(html).toContain("<!-- iconoir/settings -->");
  expect(html).not.toContain("sshAccessButton");
  expect(html).not.toContain("setup-github.html");
  expect(html).not.toContain("settings.html");
  expect(app).not.toContain("ssh-access.js");
  const settingsBlock = app.slice(app.indexOf("function profileSettingsItem"), app.indexOf("function settingsIcon"));
  expect(settingsBlock).toContain('link.href = "./settings/"');
  expect(settingsBlock).not.toContain('document.createElement("select")');
  expect(css).toContain(".space-profile-settings-link");
  expect(css).not.toContain(".space-language-select");
});

test("Settings is one page with a section list; GitHub and SSH mount as steps", async () => {
  const [html, script, css] = await Promise.all([read("settings.html"), read("settings.js"), read("settings.css")]);
  // Sections are paths under /settings/, so the page loads everything from `../`.
  expect(html).toContain('href="../styles.css"');
  expect(html).toContain('src="../settings.js"');
  for (const section of ["general", "github", "network", "connections", "ssh"]) {
    expect(html).toContain(`href="${section}" data-section="${section}"`);
    expect(html).toContain(`class="settings-section" data-section="${section}"`);
  }
  // The laptop side (Network, Connections) appears only when a local server answers available: true.
  for (const section of ["network", "connections"]) {
    expect(html).toMatch(new RegExp(`href="${section}" data-section="${section}" hidden`));
  }
  expect(script).toContain('import { mountNetworkStep, readNetwork } from "./network.js";');
  expect(script).toContain('import { mountConnectionsStep } from "./connections.js";');
  expect(script).toContain("async function revealLaptopSections()");
  // SSH stays out of the list until a hosted server answers available: true.
  expect(html).toMatch(/href="ssh" data-section="ssh" hidden/);
  expect(html).toContain('id="setupGitHubStart"');
  expect(html).toContain('id="settingsSshStep"');
  expect(html).toContain('data-i18n="settings.ssh.direction"');
  expect(html).toContain('id="settingsLanguage"');
  expect(html).not.toContain("lucide/");

  expect(script).toContain('import { mountGitHubStep } from "./setup-github.js";');
  expect(script).toContain('import { mountSshAccessStep, readSshAccess } from "./ssh-access.js";');
  expect(script).toContain('launchpadFetch("/api/setup/environment"');
  expect(script).toContain('window.addEventListener("popstate", activate)');
  expect(script).toContain('window.history.pushState(null, "", section)');
  expect(script).toContain('if (active === "github") mountGitHubStep();');
  expect(script).toContain("if (!state?.available) return;");
  // Language is a browser choice (localStorage via setLocale), not a Machine
  // setting: the page must say so and never send it to the server.
  expect(script).toContain("setLocale(select.value)");
  expect(script).not.toMatch(/launchpadFetch\([^)]*locale/i);
  for (const kind of ["local", "organization", "personal"]) {
    expect(script.includes(`settings.environment.kind.${kind}`) || script.includes("settings.environment.kind.${kind}")).toBe(true);
  }

  expect(css).toContain("grid-template-columns: 240px minmax(0, 1fr)");
  expect(css).toContain('.settings-nav-item[aria-current="page"]');
  expect(css).toContain("@media (max-width: 760px)");
});

test("the laptop side asks to join a network and activates SSH without a terminal", async () => {
  const [network, connections, ssh] = await Promise.all([read("network.js"), read("connections.js"), read("ssh-access.js")]);
  expect(network).toContain('requestJson("/api/setup/network/join"');
  expect(network).toContain("https://tailscale.com/download");
  expect(network).toContain('case "github_cli_unavailable"');
  expect(network).toContain("error.details?.registration");
  // The hand-over fragment is validated: https return URL on lazurio.io only.
  expect(connections).toContain("export function parseHandover(hash)");
  expect(connections).toContain('returnUrl.protocol !== "https:"');
  expect(connections).toContain('returnUrl.hostname.endsWith(".lazurio.io")');
  expect(connections).toContain('requestJson("/api/setup/connections/connect"');
  expect(connections).toContain("#add_key=${encodeURIComponent(outcome.public_key)}");
  expect(connections).toContain('case "tailnet_mismatch"');
  // The Machine's page hands over to the laptop Launchpad and keeps the paste command as a hidden fallback.
  expect(ssh).toContain('const LAPTOP_LAUNCHPAD = "http://localhost:4174/settings/connections";');
  expect(ssh).toContain("function laptopHandoverUrl()");
  expect(ssh).toContain('document.createElement("details")');
  expect(ssh).toContain("/^#add_key=(.+)$/");
  expect(ssh).toContain("if (pendingKey) keyField.value = pendingKey;");
  expect(ssh).not.toContain("navigator.clipboard.writeText(state.host_key");
});

test("the GitHub and SSH steps are mountable and carry no page of their own", async () => {
  const [github, ssh, sshCss] = await Promise.all([read("setup-github.js"), read("ssh-access.js"), read("ssh-access.css")]);
  expect(github).toContain("export function mountGitHubStep()");
  expect(github).not.toContain("initializeI18n");
  expect(github).toContain('post("/api/setup/github/start"');

  expect(ssh).toContain("export function readSshAccess()");
  expect(ssh).toContain("export async function mountSshAccessStep(container)");
  expect(ssh).not.toContain('document.createElement("dialog")');
  expect(ssh).toContain('"/api/setup/ssh/keys"');
  expect(ssh).toContain('"/api/setup/ssh/keys/remove"');
  expect(ssh).toContain('status.setAttribute("aria-live", "polite")');
  for (const key of ["ssh.step1", "ssh.step2", "ssh.step3", "ssh.fingerprint", "ssh.keysTitle"]) {
    expect(ssh).toContain(`t("${key}"`);
  }
  expect(ssh).toContain("if (key.removable)");
  expect(ssh).toContain("globalThis.confirm(");
  expect(sshCss).not.toContain("::backdrop");
});

test("both locales carry the Settings copy and dropped the old topbar entries", async () => {
  for (const name of ["cs", "en"]) {
    const locale = await read(join("locales", `${name}.js`));
    for (const key of [
      "topbar.settings", "settings.title", "settings.back", "settings.nav.general", "settings.nav.github",
      "settings.nav.ssh", "settings.environment.kind.local", "settings.environment.kind.organization",
      "settings.environment.kind.personal", "settings.language.help", "settings.github.title", "settings.ssh.direction",
      "settings.nav.network", "settings.nav.connections", "network.requestJoin", "network.blocked", "connections.handover.activate",
      "ssh.launchpad.connect", "ssh.fallback.summary",
    ]) {
      expect(locale).toContain(`"${key}":`);
    }
    expect(locale).toMatch(/"settings\.language\.help": ".*(prohlížeč|browser)/);
    for (const key of ["topbar.ssh", "topbar.setupGitHub", "setup.github.back", "setup.github.title"]) {
      expect(locale).not.toContain(`"${key}":`);
    }
  }
});
