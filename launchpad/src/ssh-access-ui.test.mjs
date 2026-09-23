import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const publicRoot = join(import.meta.dirname, "..", "public");

test("SSH access sits next to Chat and opens an accessible three-step dialog", async () => {
  const [html, app, component, css] = await Promise.all([
    readFile(join(publicRoot, "index.html"), "utf8"),
    readFile(join(publicRoot, "app.js"), "utf8"),
    readFile(join(publicRoot, "ssh-access.js"), "utf8"),
    readFile(join(publicRoot, "ssh-access.css"), "utf8"),
  ]);

  // Hidden by default: only a hosted server answers available: true.
  expect(html).toMatch(/id="chatButton"[^\n]*\n\s*<button id="sshAccessButton"[^>]*data-i18n="topbar.ssh"[^>]*hidden><\/button>/);
  expect(app).toContain('import { initSshAccess } from "./ssh-access.js";');
  expect(app).toContain("initSshAccess();");
  expect(component).toContain('requestJson("/api/setup/ssh")');
  expect(component).toContain("button.hidden = !data?.available");
  expect(component).toContain('"/api/setup/ssh/keys"');
  expect(component).toContain('"/api/setup/ssh/keys/remove"');
  expect(component).toContain('from "./session-aware-fetch.js"');
  expect(component).toContain("export async function mountSshAccessStep(container)");
  expect(component).toContain("return mountSshAccessStep(dialogBody)");
  expect(component).toContain('document.createElement("dialog")');
  expect(component).toContain('dialog.setAttribute("aria-labelledby", "sshAccessTitle")');
  expect(component).toContain('status.setAttribute("aria-live", "polite")');
  for (const key of ["ssh.step1", "ssh.step2", "ssh.step3", "ssh.fingerprint", "ssh.keysTitle"]) {
    expect(component).toContain(`t("${key}"`);
  }
  // Only keys Launchpad added offer Remove, and removal is confirmed.
  expect(component).toContain("if (key.removable)");
  expect(component).toContain("globalThis.confirm(");
  expect(css).toContain(".ssh-access-dialog::backdrop");
  expect(css).toContain("@media (max-width: 640px)");
});
