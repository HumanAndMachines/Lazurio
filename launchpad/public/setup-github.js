import { t } from "./i18n.js";
import { launchpadFetch } from "./session-aware-fetch.js";

// The one-time GitHub code only ever lives in this page's DOM while GitHub
// waits for the person. It is never stored, logged or put on the clipboard;
// the person types it on GitHub. Only the tab that started the login holds
// the capability that reveals it (sessionStorage, this tab only).
//
// `mountGitHubStep` binds the GitHub section of the Settings page (its
// markup lives there under the setupGitHub* ids) and loads the status once.

export function mountGitHubStep() {
  const $ = (id) => document.getElementById(id);
  const elements = {
    status: $("setupGitHubStatus"),
    notice: $("setupGitHubNotice"),
    organization: $("setupGitHubOrganization"),
    organizations: $("setupGitHubOrganizations"),
    start: $("setupGitHubStart"),
    refresh: $("setupGitHubRefresh"),
    logout: $("setupGitHubLogout"),
    session: $("setupGitHubSession"),
    steps: $("setupGitHubSteps"),
    device: $("setupGitHubDevice"),
    code: $("setupGitHubCode"),
    deviceLink: $("setupGitHubDeviceLink"),
    expiry: $("setupGitHubExpiry"),
    sessionResult: $("setupGitHubSessionResult"),
    cancel: $("setupGitHubCancel"),
    next: $("setupGitHubNext"),
    update: $("setupGitHubUpdate"),
    install: $("setupGitHubInstall"),
    nextResult: $("setupGitHubNextResult"),
  };
  const activeSessionStates = new Set(["running", "awaiting_user"]);
  let pollTimer = null;
  let lastStatus = null;
  const capabilityKey = "launchpad.setup.github.capability";

  function sessionCapability() {
    try {
      return sessionStorage.getItem(capabilityKey);
    } catch {
      return null;
    }
  }

  function rememberCapability(value) {
    try {
      if (value) sessionStorage.setItem(capabilityKey, value);
      else sessionStorage.removeItem(capabilityKey);
    } catch {}
  }

  async function post(path, body = {}) {
    const response = await launchpadFetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(payload.error ?? `http_${response.status}`);
      error.code = payload.error ?? "generic";
      throw error;
    }
    return payload;
  }

  function organizationValue() {
    return elements.organization.value.trim() || null;
  }

  function errorText(code) {
    const text = t(`setup.github.error.${code}`);
    return text.startsWith("[") ? t("setup.github.error.generic", { code }) : text;
  }

  function showNotice(node, text, tone = "warn") {
    node.hidden = !text;
    node.textContent = text ?? "";
    node.dataset.tone = tone;
  }

  function statusRow(label, value, tone = null) {
    const term = document.createElement("dt");
    term.textContent = label;
    const detail = document.createElement("dd");
    detail.textContent = value;
    if (tone) detail.dataset.tone = tone;
    return [term, detail];
  }

  function renderStatus(status) {
    lastStatus = status;
    const rows = [];
    const account = status.account ?? null;
    if (status.mode === "brokered") {
      rows.push(...statusRow(t("setup.github.row.account"), t("setup.github.brokered")));
    } else if (account) {
      rows.push(...statusRow(
        t("setup.github.row.account"),
        account.state === "logged_in" && account.login ? account.login : t("setup.github.value.loggedOut"),
        account.state === "logged_in" ? "ok" : "bad",
      ));
      if (account.state === "logged_in") {
        rows.push(...statusRow(
          t("setup.github.row.protocol"),
          account.git_protocol ?? t("setup.github.value.unknown"),
          account.git_protocol === "ssh" ? "ok" : "bad",
        ));
      }
    }
    if (status.ssh) {
      const matches = status.ssh.matches_account;
      rows.push(...statusRow(
        t("setup.github.row.ssh"),
        status.ssh.state === "ok"
          ? t("setup.github.value.sshOk", { login: status.ssh.login })
          : t(`setup.github.ssh.${status.ssh.state}`),
        status.ssh.state === "ok" && matches !== false ? "ok" : status.ssh.state === "skipped" ? null : "bad",
      ));
    }
    if (status.organization) {
      const probe = status.organization.ls_remote;
      rows.push(...statusRow(
        t("setup.github.row.organization"),
        `${status.organization.root_repository} — ${t(`setup.github.rootProbe.${probe}`)}`,
        probe === "ok" ? "ok" : probe === "failed" ? "bad" : null,
      ));
    }
    elements.status.replaceChildren(...rows);

    if (status.blocker) {
      showNotice(elements.notice, errorText(status.blocker), "bad");
    } else if (status.ready) {
      showNotice(elements.notice, t("setup.github.ready"), "ok");
    } else {
      showNotice(elements.notice, null);
    }

    const suggestions = status.organization_suggestions ?? [];
    elements.organizations.replaceChildren(...suggestions.map((login) => {
      const option = document.createElement("option");
      option.value = login;
      return option;
    }));
    if (!elements.organization.value && suggestions.length === 1) elements.organization.value = suggestions[0];

    const running = activeSessionStates.has(status.session?.state);
    elements.start.hidden = !status.actions?.login;
    elements.start.disabled = running;
    elements.logout.hidden = !status.actions?.logout;
    elements.logout.disabled = running;
    elements.next.hidden = !status.actions?.update;
    const installTarget = status.actions?.organization_install ? status.organization?.login : null;
    elements.install.hidden = !installTarget;
    if (installTarget) elements.install.textContent = t("setup.github.install", { organization: installTarget });
    if (status.session) renderSession(status.session);
  }

  function renderSession(session) {
    elements.session.hidden = false;
    elements.steps.replaceChildren(...session.steps.map((step) => {
      const item = document.createElement("li");
      item.dataset.state = step.state;
      item.textContent = `${t(`setup.github.step.${step.id}`)} — ${t(`setup.github.stepState.${step.state}`)}`;
      return item;
    }));

    const device = session.state === "awaiting_user" ? session.device : null;
    elements.device.hidden = !device;
    elements.code.textContent = device?.user_code ?? "";
    if (device) {
      elements.deviceLink.href = device.verification_uri;
      elements.expiry.textContent = t("setup.github.deviceExpiry", {
        time: new Date(device.expires_at).toLocaleTimeString(),
      });
    } else {
      elements.deviceLink.removeAttribute("href");
      elements.expiry.textContent = "";
    }

    const active = activeSessionStates.has(session.state);
    // Only the starting tab can cancel; others just watch the progress.
    elements.cancel.hidden = !active || !sessionCapability();
    if (session.state === "completed") {
      const extras = [
        session.ssh_key_created ? t("setup.github.keyCreated") : null,
        session.ssh_key_registered ? t("setup.github.keyRegistered") : null,
      ].filter(Boolean).join(" ");
      showNotice(elements.sessionResult, `${t("setup.github.completed")} ${extras}`.trim(), "ok");
    } else if (session.state === "failed" || session.state === "cancelled") {
      showNotice(elements.sessionResult, errorText(session.error ?? "login_failed"), "bad");
    } else {
      showNotice(elements.sessionResult, null);
    }
    elements.start.disabled = active;
  }

  async function loadStatus() {
    elements.refresh.disabled = true;
    showNotice(elements.notice, t("setup.github.checking"));
    try {
      renderStatus(await post("/api/setup/github/status", { organization: organizationValue() }));
      if (activeSessionStates.has(lastStatus?.session?.state) && sessionCapability()) schedulePoll();
    } catch (error) {
      showNotice(elements.notice, errorText(error.code ?? "generic"), "bad");
    } finally {
      elements.refresh.disabled = false;
    }
  }

  function schedulePoll() {
    clearTimeout(pollTimer);
    pollTimer = setTimeout(pollSession, 1_500);
  }

  async function pollSession() {
    try {
      const { session } = await post("/api/setup/github/session", { capability: sessionCapability() });
      if (!session) return;
      renderSession(session);
      if (activeSessionStates.has(session.state)) {
        schedulePoll();
      } else {
        rememberCapability(null);
        await loadStatus();
      }
    } catch (error) {
      showNotice(elements.sessionResult, errorText(error.code ?? "generic"), "bad");
    }
  }

  elements.start.addEventListener("click", async () => {
    elements.start.disabled = true;
    try {
      const { session } = await post("/api/setup/github/start", { organization: organizationValue() });
      rememberCapability(session.capability);
      renderSession(session);
      schedulePoll();
    } catch (error) {
      elements.start.disabled = false;
      showNotice(elements.notice, errorText(error.code ?? "generic"), "bad");
    }
  });

  elements.cancel.addEventListener("click", async () => {
    try {
      renderSession((await post("/api/setup/github/cancel", { capability: sessionCapability() })).session);
    } catch (error) {
      showNotice(elements.sessionResult, errorText(error.code ?? "generic"), "bad");
    }
  });

  elements.logout.addEventListener("click", async () => {
    const login = lastStatus?.account?.login;
    if (!globalThis.confirm(t("setup.github.logoutConfirm", { login: login ?? "GitHub" }))) return;
    elements.logout.disabled = true;
    try {
      const result = await post("/api/setup/github/logout");
      rememberCapability(null);
      elements.session.hidden = true;
      await loadStatus();
      if (result.logged_out) {
        const detail = result.ssh_key_removed ? ` ${t("setup.github.logoutKeyRemoved")}` : "";
        showNotice(elements.notice, `${t("setup.github.loggedOutNotice", { login: result.login ?? "GitHub" })}${detail}`, "ok");
      }
    } catch (error) {
      showNotice(elements.notice, errorText(error.code ?? "generic"), "bad");
    } finally {
      elements.logout.disabled = false;
    }
  });

  elements.refresh.addEventListener("click", () => loadStatus());
  elements.organization.addEventListener("change", () => loadStatus());

  elements.update.addEventListener("click", async () => {
    elements.update.disabled = true;
    showNotice(elements.nextResult, t("setup.github.running"));
    try {
      const result = await post("/api/update");
      // The engine says why it stopped (top-level message, blocked repositories
      // with their reason, next action); a bare state is not actionable.
      const blocked = (result.results ?? [])
        .filter((entry) => entry.state === "blocked")
        .map((entry) => [entry.path && entry.path !== "." ? `${entry.path}:` : null, entry.message ?? entry.reason].filter(Boolean).join(" "));
      const detail = [result.message, ...blocked, result.next_action]
        .filter((text) => typeof text === "string" && text.trim())
        .filter((text, index, all) => all.indexOf(text) === index)
        .join(" ");
      showNotice(
        elements.nextResult,
        `${t("setup.github.updateResult", { state: result.state ?? "unknown" })}${detail ? ` ${detail}` : ""}`,
        result.state === "blocked" ? "bad" : "ok",
      );
    } catch (error) {
      showNotice(elements.nextResult, errorText(error.code ?? "generic"), "bad");
    } finally {
      elements.update.disabled = false;
    }
  });

  elements.install.addEventListener("click", async () => {
    const organization = lastStatus?.organization?.login;
    if (!organization) return;
    elements.install.disabled = true;
    showNotice(elements.nextResult, t("setup.github.running"));
    try {
      const { report } = await post("/api/setup/organization-install", { organization });
      const message = report?.target?.message ? ` ${report.target.message}` : "";
      showNotice(
        elements.nextResult,
        `${t("setup.github.installResult", { state: report?.state ?? "unknown" })}${message}`,
        report?.state === "blocked" ? "bad" : "ok",
      );
    } catch (error) {
      showNotice(elements.nextResult, errorText(error.code ?? "generic"), "bad");
    } finally {
      elements.install.disabled = false;
    }
  });

  loadStatus();
}
