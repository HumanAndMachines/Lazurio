import { t } from "./i18n.js";
import { launchpadFetch } from "./session-aware-fetch.js";

// Network section of Settings on a laptop: ask an Organization's Admin to
// accept this laptop into its Headscale. Nothing here grants access — the
// Admin registers the node and declares port 22 in the Deployment Repo.

const LAUNCHPAD_DOWNLOAD = "https://tailscale.com/download";
let content = null;
let state = null;

async function requestJson(path, body) {
  const response = await launchpadFetch(path, body === undefined
    ? { cache: "no-store" }
    : { method: "POST", cache: "no-store", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(payload?.error ?? "http_error");
    error.code = payload?.error ?? "http_error";
    error.details = payload?.details ?? {};
    throw error;
  }
  return payload;
}

export function readNetwork() {
  return requestJson("/api/setup/network");
}

export async function mountNetworkStep(container) {
  content = container;
  content.classList.add("ssh-access-body");
  content.replaceChildren(paragraph(t("network.loading")));
  try {
    state = await readNetwork();
    render();
  } catch {
    content.replaceChildren(paragraph(t("network.loadFailed"), "ssh-access-error"));
  }
}

function render() {
  const nodes = [paragraph(t("network.intro"))];
  const rows = document.createElement("div");
  rows.className = "settings-rows";
  rows.append(row(t("network.tailscale"), state.tailscale.installed ? t("network.tailscaleInstalled") : t("network.tailscaleMissing"), state.tailscale.installed ? "" : "settings-error"));
  if (!state.tailscale.installed) {
    const link = document.createElement("a");
    link.className = "btn btn-primary btn-sm";
    link.href = LAUNCHPAD_DOWNLOAD;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = t("network.installTailscale");
    rows.append(rowNode(t("network.blocked"), link));
  }
  rows.append(row(t("network.currentTailnet"), state.status.tailnet ?? t("network.noTailnet")));
  nodes.push(rows);

  const heading = document.createElement("h3");
  heading.textContent = t("network.organizationsTitle");
  nodes.push(heading);
  if (!state.organizations.length) nodes.push(paragraph(t("network.organizationsEmpty"), "ssh-access-muted"));
  for (const organization of state.organizations) nodes.push(organizationCard(organization));
  nodes.push(button(t("network.refresh"), () => mountNetworkStep(content), "btn btn-secondary btn-sm"));
  content.replaceChildren(...nodes);
}

function organizationCard(organization) {
  const card = document.createElement("section");
  card.className = "settings-card";
  card.dataset.state = organization.state;
  const title = document.createElement("h4");
  title.textContent = organization.display_name;
  card.append(title);
  if (organization.tailnet) card.append(paragraph(organization.tailnet, "ssh-access-muted"));
  const status = paragraph("", "ssh-access-muted");
  status.setAttribute("aria-live", "polite");
  switch (organization.state) {
    case "connected":
      card.append(paragraph(t("network.state.connected"), "settings-ok"));
      break;
    case "pending": {
      card.append(paragraph(t("network.state.pending"), ""));
      if (organization.request?.issue_url) {
        const link = document.createElement("a");
        link.href = organization.request.issue_url;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.textContent = t("network.requestLink", { state: organization.request.issue_state ?? "open" });
        card.append(link);
      }
      card.append(paragraph(t("network.state.pendingHint"), "ssh-access-muted"));
      break;
    }
    case "unconfigured":
      card.append(paragraph(t("network.state.unconfigured"), "ssh-access-muted"));
      break;
    default: {
      // "refused": the Admin closed the request without registering the
      // laptop; say so and let the person ask again. "none": never asked.
      if (organization.state === "refused") {
        card.append(paragraph(t("network.state.refused"), "ssh-access-error"));
        if (organization.request?.issue_url) {
          const link = document.createElement("a");
          link.href = organization.request.issue_url;
          link.target = "_blank";
          link.rel = "noopener noreferrer";
          link.textContent = t("network.requestLink", { state: organization.request.issue_state ?? "closed" });
          card.append(link);
        }
      } else {
        card.append(paragraph(t("network.state.none"), "ssh-access-muted"));
      }
      const join = button(t(organization.state === "refused" ? "network.requestAgain" : "network.requestJoin"), async () => {
        join.disabled = true;
        status.textContent = t("network.requesting");
        try {
          const result = await requestJson("/api/setup/network/join", { organization: organization.slug });
          state = await readNetwork();
          render();
          flash(result.state === "connected" ? t("network.alreadyConnected") : t("network.requested"));
        } catch (error) {
          status.className = "ssh-access-error";
          status.textContent = errorText(error);
          const registration = error.details?.registration;
          if (registration) status.append(document.createElement("br"), document.createTextNode(t("network.manualFallback", { url: registration.url })));
          join.disabled = false;
        }
      }, "btn btn-primary btn-sm");
      if (!state.tailscale.installed) join.disabled = true;
      card.append(join, status);
    }
  }
  return card;
}

function errorText(error) {
  switch (error.code) {
    case "tailscale_missing": return t("network.error.tailscaleMissing");
    case "login_server_unconfigured": return t("network.state.unconfigured");
    case "github_cli_unavailable": return t("network.error.github");
    case "join_request_failed": return t("network.error.request", { repository: error.details?.repository ?? "" });
    case "registration_url_unavailable": return t("network.error.registration");
    case "mutating_request_forbidden": return t("ssh.error.session");
    default: return t("ssh.error.generic");
  }
}

function flash(message) {
  const note = paragraph(message, "ssh-access-flash");
  note.setAttribute("role", "status");
  content.prepend(note);
}

function row(label, value, className = "") {
  const detail = document.createElement("span");
  detail.className = `settings-row-value ${className}`.trim();
  detail.textContent = value;
  return rowNode(label, detail);
}

function rowNode(label, control) {
  const node = document.createElement("div");
  node.className = "settings-row";
  const copy = document.createElement("span");
  copy.className = "settings-row-copy";
  const name = document.createElement("span");
  name.className = "settings-row-label";
  name.textContent = label;
  copy.append(name);
  node.append(copy, control);
  return node;
}

function paragraph(text, className = "") {
  const node = document.createElement("p");
  if (className) node.className = className;
  node.textContent = text;
  return node;
}

function button(text, onClick, className) {
  const node = document.createElement("button");
  node.type = "button";
  node.className = className;
  node.textContent = text;
  node.addEventListener("click", onClick);
  return node;
}
