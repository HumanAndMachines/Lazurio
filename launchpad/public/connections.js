import { t } from "./i18n.js";
import { launchpadFetch } from "./session-aware-fetch.js";

// Connections section of Settings on a laptop: the SSH hosts this laptop may
// reach, and the hand-over from a hosted Machine's Launchpad. That page shows
// a hand-over code (base64url JSON with the Machine's label, tailnet address,
// user, host key and its own URL) the person pastes here; a `#connect=<code>`
// fragment is accepted too for a caller that knows this Launchpad's real URL.
// The Machine's page never guesses where this Launchpad listens. This laptop
// creates the key and the pinned Host block, then sends the public key back
// through the return URL's fragment so the Machine's page can add it with one
// click. The code never reaches any server as such; every field is validated
// again here and on the laptop's own Launchpad server before anything is
// written.

let content = null;
let handover = null;

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

export function readConnections() {
  return requestJson("/api/setup/connections");
}

// Accepts the bare code, `connect=<code>`, `#connect=<code>` or a whole URL
// whose fragment carries it.
export function parseHandover(input) {
  const text = String(input ?? "").trim();
  const match = /^(?:.*#)?(?:connect=)?([A-Za-z0-9_-]{16,})$/.exec(text);
  if (!match) return null;
  try {
    const json = atob(match[1].replace(/-/g, "+").replace(/_/g, "/"));
    const payload = JSON.parse(decodeURIComponent(escape(json)));
    const returnUrl = new URL(payload.return);
    if (returnUrl.protocol !== "https:" || !returnUrl.hostname.endsWith(".lazurio.io")) return null;
    return {
      label: String(payload.label ?? ""),
      ipv4: String(payload.ipv4 ?? ""),
      user: String(payload.user ?? ""),
      tailnet: String(payload.tailnet ?? ""),
      host_key: { type: String(payload.host_key?.type ?? ""), key: String(payload.host_key?.key ?? "") },
      fingerprint: String(payload.fingerprint ?? ""),
      return: returnUrl.href,
    };
  } catch {
    return null;
  }
}

async function refreshList() {
  try {
    const state = await readConnections();
    const list = content.querySelector(".connections-list");
    if (list) list.replaceChildren(...listNodes(state));
  } catch {}
}

export async function mountConnectionsStep(container) {
  content = container;
  content.classList.add("ssh-access-body");
  handover = parseHandover(window.location.hash);
  content.replaceChildren(paragraph(t("connections.loading")));
  try {
    render(await readConnections());
  } catch {
    content.replaceChildren(paragraph(t("connections.loadFailed"), "ssh-access-error"));
  }
}

function render(state) {
  const nodes = [paragraph(t("connections.intro"))];
  nodes.push(handover ? handoverCard(handover) : pasteCard(state));
  const list = document.createElement("div");
  list.className = "connections-list ssh-access-body";
  list.append(...listNodes(state));
  nodes.push(list);
  content.replaceChildren(...nodes);
}

function listNodes(state) {
  const heading = document.createElement("h3");
  heading.textContent = t("connections.listTitle");
  const nodes = [heading];
  if (!state.connections?.length) nodes.push(paragraph(t("connections.empty"), "ssh-access-muted"));
  for (const connection of state.connections ?? []) {
    const row = document.createElement("div");
    row.className = "ssh-access-key";
    const text = document.createElement("div");
    const name = document.createElement("strong");
    name.textContent = connection.label;
    const detail = document.createElement("code");
    detail.textContent = `${connection.user ?? "?"}@${connection.host ?? "?"} · ${connection.connect}`;
    text.append(name, detail);
    if (connection.managed === false) {
      row.append(text, paragraph(t("connections.unmanaged"), "ssh-access-muted"));
      nodes.push(row);
      continue;
    }
    const remove = button(t("connections.remove"), async () => {
      if (!globalThis.confirm(t("connections.removeConfirm", { label: connection.label }))) return;
      remove.disabled = true;
      try {
        await requestJson("/api/setup/connections/remove", { label: connection.label });
        await refreshList();
      } catch (error) {
        remove.disabled = false;
        flash(errorText(error));
      }
    }, "btn btn-secondary btn-sm");
    row.append(text, remove);
    nodes.push(row);
  }
  return nodes;
}

// Where a new connection starts on the laptop: paste the code the Machine's
// Launchpad shows under "Through the Launchpad on your laptop".
function pasteCard(state) {
  const card = document.createElement("section");
  card.className = "settings-card connections-paste";
  const title = document.createElement("h4");
  title.textContent = t("connections.paste.title");
  card.append(title, paragraph(t("connections.paste.hint"), "ssh-access-muted"));
  const field = document.createElement("textarea");
  field.className = "ssh-access-code";
  field.rows = 3;
  field.spellcheck = false;
  field.setAttribute("aria-label", t("connections.paste.title"));
  const status = paragraph("", "ssh-access-error");
  status.setAttribute("aria-live", "polite");
  const use = button(t("connections.paste.use"), () => {
    const parsed = parseHandover(field.value);
    if (!parsed) {
      status.textContent = t("connections.paste.invalid");
      return;
    }
    handover = parsed;
    render(state);
  }, "btn btn-primary btn-sm");
  card.append(field, use, status);
  return card;
}

function handoverCard(payload) {
  const card = document.createElement("section");
  card.className = "settings-card settings-card-accent";
  const title = document.createElement("h4");
  title.textContent = t("connections.handover.title", { label: payload.label });
  card.append(title);
  card.append(paragraph(t("connections.handover.facts", { user: payload.user, ip: payload.ipv4, tailnet: payload.tailnet }), "ssh-access-muted"));
  if (payload.fingerprint) card.append(paragraph(t("ssh.fingerprint", { fingerprint: payload.fingerprint }), "ssh-access-muted"));
  const status = paragraph("", "ssh-access-muted");
  status.setAttribute("aria-live", "polite");
  const result = document.createElement("div");
  const go = button(t("connections.handover.activate"), async () => {
    go.disabled = true;
    status.className = "ssh-access-muted";
    status.textContent = t("connections.handover.working");
    try {
      const outcome = await requestJson("/api/setup/connections/connect", {
        label: payload.label, ipv4: payload.ipv4, user: payload.user, tailnet: payload.tailnet, host_key: payload.host_key,
      });
      status.textContent = outcome.created ? t("connections.handover.keyCreated") : t("connections.handover.keyReused");
      const key = document.createElement("textarea");
      key.className = "ssh-access-code";
      key.readOnly = true;
      key.rows = 3;
      key.value = outcome.public_key;
      const back = document.createElement("a");
      back.className = "btn btn-primary btn-sm";
      back.href = `${payload.return.split("#")[0]}#add_key=${encodeURIComponent(outcome.public_key)}`;
      back.textContent = t("connections.handover.addOnMachine", { label: payload.label });
      result.replaceChildren(paragraph(t("connections.handover.next")), key, back);
      go.hidden = true;
      refreshList();
    } catch (error) {
      status.className = "ssh-access-error";
      status.textContent = errorText(error);
      go.disabled = false;
    }
  }, "btn btn-primary btn-sm");
  card.append(go, status, result);
  return card;
}

function errorText(error) {
  switch (error.code) {
    case "tailscale_missing": return t("network.error.tailscaleMissing");
    case "tailnet_mismatch": return t("connections.error.tailnet", { active: error.details?.active ?? "—", expected: error.details?.expected ?? "" });
    case "ssh_keygen_failed": return t("connections.error.keygen");
    case "connection_unmanaged": return t("connections.error.unmanaged", { label: error.details?.label ?? "" });
    case "label_invalid":
    case "ipv4_invalid":
    case "user_invalid":
    case "tailnet_invalid":
    case "host_key_invalid": return t("connections.error.handover");
    case "mutating_request_forbidden": return t("ssh.error.session");
    default: return t("ssh.error.generic");
  }
}

function flash(message) {
  const note = paragraph(message, "ssh-access-flash");
  note.setAttribute("role", "status");
  content.prepend(note);
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
