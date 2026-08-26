import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const temporaryRoots = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

test("package-safe Module status reports a missing per-user Server distinctly", async () => {
  const home = await mkdtemp(join(tmpdir(), "lazurio-module-lifecycle-cli-"));
  temporaryRoots.push(home);
  const result = runCli(["module", "status", "--json"], home);

  expect(result.status).toBe(3);
  expect(result.stderr).toBe("");
  expect(JSON.parse(result.stdout)).toMatchObject({
    schema_version: "lazurio.module_lifecycle.report.v1",
    status: "action_required",
    reason: "server_unavailable",
    action: "status",
    selector: null,
    server: { state: "unavailable" },
  });
});

test("Module lifecycle CLI rejects a second Root authority and unsafe confirmation", async () => {
  const home = await mkdtemp(join(tmpdir(), "lazurio-module-lifecycle-cli-"));
  temporaryRoots.push(home);

  const rootOverride = runCli([
    "module",
    "open",
    "ExampleOrganization/website",
    "--root",
    home,
    "--json",
  ], home);
  expect(rootOverride.status).toBe(3);
  expect(rootOverride.stderr).toContain("per-user Server locatoru");

  const stopConfirmation = runCli([
    "module",
    "stop",
    "ExampleOrganization/website",
    "--confirm-replace",
    "other-organization-portal-v1",
  ], home);
  expect(stopConfirmation.status).toBe(3);
  expect(stopConfirmation.stderr).toContain("pouze s module start nebo module open");
});

function runCli(args, home) {
  const result = spawnSync(process.execPath, [join(import.meta.dir, "cli.mjs"), ...args], {
    cwd: import.meta.dir,
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      LOCALAPPDATA: join(home, "AppData", "Local"),
      XDG_STATE_HOME: join(home, ".local", "state"),
    },
    shell: false,
    windowsHide: true,
  });
  return {
    status: result.status,
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? result.error?.message ?? ""),
  };
}
