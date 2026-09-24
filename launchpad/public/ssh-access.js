import { t } from "./i18n.js";
import { launchpadFetch } from "./session-aware-fetch.js";

// SSH access: connect a laptop to this hosted Machine over the Headscale
// tailnet in three steps. The server offers it only in the hosted profile;
// on localhost `readSshAccess` answers available: false and the Settings page
// keeps the section out of its list. `mountSshAccessStep` is the
// self-contained step; Settings is one host for it, a later Machine setup
// guide can mount the same step next to its siblings.

let content = null;
let state = null;
let platform = /Windows/i.test(globalThis.navigator?.userAgent ?? "") ? "windows" : "macos";

async function requestJson(path, body) {
  const response = await launchpadFetch(path, body === undefined
    ? { cache: "no-store" }
    : { method: "POST", cache: "no-store", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(payload?.error ?? "http_error");
    error.code = payload?.error ?? "http_error";
    throw error;
  }
  return payload;
}

export function readSshAccess() {
  return requestJson("/api/setup/ssh");
}

export async function mountSshAccessStep(container) {
  content = container;
  content.classList.add("ssh-access-body");
  content.replaceChildren(paragraph(t("ssh.loading")));
  try {
    state = await readSshAccess();
    render();
  } catch {
    content.replaceChildren(paragraph(t("ssh.loadFailed"), "ssh-access-error"));
  }
}

function render() {
  const { label, commands, host_key: hostKey } = state;
  const nodes = [paragraph(t("ssh.intro", { label, tailnet: state.tailnet ?? "Headscale" }))];
  if (!commands) {
    nodes.push(paragraph(t("ssh.unavailable"), "ssh-access-error"));
    for (const issue of state.issues ?? []) nodes.push(paragraph(issueText(issue), "ssh-access-muted"));
    nodes.push(keysSection());
    content.replaceChildren(...nodes);
    return;
  }

  const commandField = codeField(commands[platform], 9);
  const tabs = document.createElement("div");
  tabs.className = "ssh-access-tabs";
  tabs.setAttribute("role", "group");
  for (const [id, text] of [["macos", "macOS"], ["windows", "Windows"]]) {
    const tab = button(text, () => {
      platform = id;
      render();
    }, "btn btn-secondary btn-sm");
    tab.setAttribute("aria-pressed", String(platform === id));
    tabs.append(tab);
  }
  nodes.push(step(
    t("ssh.step1"),
    tabs,
    paragraph(platform === "windows" ? t("ssh.step1.windows") : t("ssh.step1.macos"), "ssh-access-muted"),
    commandField,
    copyButton(t("ssh.copyCommand"), () => commandField.value),
  ));

  const keyField = document.createElement("textarea");
  keyField.className = "ssh-access-code";
  keyField.rows = 3;
  keyField.spellcheck = false;
  keyField.placeholder = "ssh-ed25519 AAAA… name@laptop";
  keyField.setAttribute("aria-label", t("ssh.step2"));
  const status = paragraph("", "ssh-access-muted");
  status.setAttribute("aria-live", "polite");
  const add = button(t("ssh.addKey"), async () => {
    add.disabled = true;
    try {
      const result = await requestJson("/api/setup/ssh/keys", { public_key: keyField.value });
      state = result;
      render();
      content.querySelector(".ssh-access-connect")?.scrollIntoView?.({ block: "nearest" });
      flash(result.added ? t("ssh.keyAdded") : t("ssh.keyPresent"));
    } catch (error) {
      status.textContent = errorText(error.code);
      add.disabled = false;
    }
  }, "btn btn-primary btn-sm");
  nodes.push(step(t("ssh.step2"), paragraph(t("ssh.step2.hint"), "ssh-access-muted"), keyField, add, status));

  const connect = codeField(commands.connect, 1);
  const connectStep = step(
    t("ssh.step3"),
    connect,
    copyButton(t("ssh.copyConnect"), () => connect.value),
    paragraph(t("ssh.fingerprint", { fingerprint: hostKey.fingerprint }), "ssh-access-muted"),
    paragraph(t("ssh.step3.hint", { label }), "ssh-access-muted"),
  );
  connectStep.classList.add("ssh-access-connect");
  nodes.push(connectStep, keysSection());
  nodes.push(paragraph(t("ssh.details", { user: state.user, ip: state.tailnet_ipv4 }), "ssh-access-muted"));
  content.replaceChildren(...nodes);
}

function keysSection() {
  const section = document.createElement("section");
  section.className = "ssh-access-keys";
  const heading = document.createElement("h3");
  heading.textContent = t("ssh.keysTitle");
  section.append(heading);
  if (!state.keys?.length) section.append(paragraph(t("ssh.keysEmpty"), "ssh-access-muted"));
  for (const key of state.keys ?? []) {
    const row = document.createElement("div");
    row.className = "ssh-access-key";
    const text = document.createElement("div");
    const name = document.createElement("strong");
    name.textContent = key.comment.replace(/^lazurio-launchpad\s*/, "") || key.type;
    const fingerprint = document.createElement("code");
    fingerprint.textContent = key.fingerprint;
    text.append(name, fingerprint);
    row.append(text);
    if (key.removable) {
      const remove = button(t("ssh.remove"), async () => {
        if (!globalThis.confirm(t("ssh.removeConfirm", { name: name.textContent }))) return;
        remove.disabled = true;
        try {
          state = await requestJson("/api/setup/ssh/keys/remove", { fingerprint: key.fingerprint });
          render();
          flash(t("ssh.keyRemoved"));
        } catch (error) {
          remove.disabled = false;
          flash(errorText(error.code));
        }
      }, "btn btn-secondary btn-sm");
      row.append(remove);
    } else {
      row.append(paragraph(t("ssh.keyManagedElsewhere"), "ssh-access-muted"));
    }
    section.append(row);
  }
  return section;
}

function flash(message) {
  const note = paragraph(message, "ssh-access-flash");
  note.setAttribute("role", "status");
  const heading = content.querySelector(".ssh-access-connect h3");
  if (heading) heading.after(note);
  else content.prepend(note);
}

function issueText(issue) {
  switch (issue) {
    case "tailnet_ip_unavailable": return t("ssh.issue.tailnet");
    case "host_key_unavailable": return t("ssh.issue.hostKey");
    default: return t("ssh.issue.user");
  }
}

function errorText(code) {
  switch (code) {
    case "ssh_key_empty": return t("ssh.error.empty");
    case "ssh_key_private_material": return t("ssh.error.private");
    case "ssh_key_multiline": return t("ssh.error.multiline");
    case "ssh_key_type_unsupported": return t("ssh.error.type");
    case "ssh_key_invalid":
    case "ssh_key_too_long": return t("ssh.error.invalid");
    case "ssh_key_not_managed": return t("ssh.error.notManaged");
    case "mutating_request_forbidden":
    case "hosted_session_expired": return t("ssh.error.session");
    default: return t("ssh.error.generic");
  }
}

function step(title, ...children) {
  const section = document.createElement("section");
  section.className = "ssh-access-step";
  const heading = document.createElement("h3");
  heading.textContent = title;
  section.append(heading, ...children);
  return section;
}

function paragraph(text, className = "") {
  const node = document.createElement("p");
  if (className) node.className = className;
  node.textContent = text;
  return node;
}

function codeField(value, rows) {
  const field = document.createElement("textarea");
  field.className = "ssh-access-code";
  field.readOnly = true;
  field.spellcheck = false;
  field.rows = rows;
  field.value = value;
  return field;
}

function button(text, onClick, className) {
  const node = document.createElement("button");
  node.type = "button";
  node.className = className;
  node.textContent = text;
  node.addEventListener("click", onClick);
  return node;
}

function copyButton(text, read) {
  const node = button(text, async () => {
    try {
      await navigator.clipboard.writeText(read());
      node.textContent = t("ssh.copied");
    } catch {
      node.textContent = t("ssh.copyFailed");
    }
    setTimeout(() => { node.textContent = text; }, 2000);
  }, "btn btn-primary btn-sm");
  return node;
}
