import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { installMissingCodex, runOfficialCodexInstaller } from "./install-codex-lib.mjs";
import { inspectLazurioInstallation, isValidLazurioInstallReport } from "./install-core-lib.mjs";
import { renderHumanInstallApplyReport, installCatalogIssues } from "../install-output-lib.mjs";
import { validateAgainstSchema } from "../runtime/json-schema-mini.mjs";
import schema from "../install-apply.v1.schema.json";
import reportSchema from "../install-report.v2.schema.json";

function fixture(overrides = {}) {
  let present = false;
  const calls = [];
  const options = {
    platform: "linux", architecture: "x64", environment: { HOME: "/home/example" },
    homeDirectory: "/home/example", allowUserPath: true, pathExists: () => false, userPathsSafe: () => true,
    inspect: () => inspectLazurioInstallation({
      platform: "linux", architecture: "x64", homeDirectory: "/home/example",
      bunVersion: "1.4.1", requiredBunVersion: "1.4.1",
      resolvePathCommand: (name) => name === "codex" && !present ? null : name,
      runCommand: ({ executable, args }) => ({ status: 0, stdout: {
        bun: "1.4.1", node: "v24.19.0", git: "git version 2.47.0",
        codex: "codex-cli 0.146.0", gh: args[0] === "config" ? "ssh" : "gh version 2.70.0",
      }[executable] }),
      inspectRoot: (path) => ({ path, layout: "source_root", status: "completed", reason: "source_root_ready" }),
    }),
    runInstaller: async (args) => { calls.push(args); present = true; return { status: 0 }; },
    ...overrides,
  };
  return { options, calls, setPresent: (value) => { present = value; } };
}

test("explicit User PATH mandate is required before any installer side effect", async () => {
  const f = fixture({ allowUserPath: false });
  const report = await installMissingCodex(f.options);
  expect(report.action.reason).toBe("codex_user_path_consent_required");
  expect(report.status).toBe("action_required");
  expect(f.calls).toHaveLength(0);
  expect(validateAgainstSchema(report, { ...schema, properties: { ...schema.properties, installation: reportSchema } }, "apply")).toEqual([]);
  expect(isValidLazurioInstallReport(report.installation)).toBe(true);
  expect(installCatalogIssues()).toEqual([]);
  expect(renderHumanInstallApplyReport(report, { language: "en" })).toContain("--allow-user-path");
  expect(renderHumanInstallApplyReport(report, { language: "en" })).not.toContain("changes nothing");
  expect(renderHumanInstallApplyReport(report, { language: "cs" })).toContain("souhlasu Principála");
});

test("install then rerun converges without upgrading a working installation", async () => {
  const f = fixture();
  expect((await installMissingCodex(f.options)).action.reason).toBe("codex_installed");
  expect((await installMissingCodex({ ...f.options, allowUserPath: false })).action.reason).toBe("codex_preserved");
  expect(f.calls).toHaveLength(1);
});

test("existing destination outside PATH is preserved", async () => {
  const f = fixture({ pathExists: () => true });
  expect((await installMissingCodex(f.options)).action.reason).toBe("codex_outside_path");
  expect(f.calls).toHaveLength(0);
});

test("custom destinations and mismatched home never reach the installer", async () => {
  for (const environment of [
    { HOME: "/different" }, { HOME: "/home/example", CODEX_INSTALL_DIR: "/system/bin" },
    { HOME: "/home/example", CODEX_HOME: "/custom/state" },
  ]) {
    const f = fixture({ environment });
    expect((await installMissingCodex(f.options)).action.reason).toBe("codex_custom_location");
    expect(f.calls).toHaveLength(0);
  }
});

test("broken Codex and immutable Resident are not silently repaired", async () => {
  for (const kind of ["broken", "resident", "unsupported"]) {
    const f = fixture();
    const inspect = f.options.inspect;
    f.options.inspect = () => {
      const report = inspect();
      if (kind === "broken") Object.assign(report.steps.find((s) => s.id === "codex"), { status: "failed", reason: "codex_unusable" });
      if (kind === "resident") report.root.layout = "generated_root";
      if (kind === "unsupported") report.steps[0].status = "action_required";
      return report;
    };
    expect((await installMissingCodex(f.options)).action.status).toBe("action_required");
    expect(f.calls).toHaveLength(0);
  }
});

test("provider failures and exceptions are bounded and redacted", async () => {
  for (const runInstaller of [async () => { throw new Error("CANARY_SECRET"); },
    async () => ({ status: 1, stdout: "CANARY_SECRET", stderr: "CANARY_SECRET" })]) {
    const report = await installMissingCodex(fixture({ runInstaller }).options);
    expect(report.status).toBe("failed");
    expect(report.action.reason).toBe("codex_installer_failed");
    expect(JSON.stringify(report)).not.toContain("CANARY");
  }
});

test("installer exit zero without visible Codex requires fresh session", async () => {
  const f = fixture({ runInstaller: async () => ({ status: 0 }) });
  expect((await installMissingCodex(f.options)).action.reason).toBe("codex_restart_required");
});

test("Windows always requests full harness restart after installation", async () => {
  const f = fixture({ platform: "win32", homeDirectory: "C:\\Users\\example",
    environment: { USERPROFILE: "C:\\Users\\example", LOCALAPPDATA: "C:\\Users\\example\\AppData\\Local" } });
  const report = await installMissingCodex(f.options);
  expect(report.status).toBe("action_required");
  expect(report.action.reason).toBe("codex_restart_required");
  expect(f.calls).toHaveLength(1);
});

test("provider invocation uses official download, latest and noninteractive mode", async () => {
  for (const platform of ["linux", "darwin", "win32"]) {
    const calls = [];
    let scriptPath;
    const result = await runOfficialCodexInstaller({ platform,
      environment: { PATH: "untrusted-shadow-directory", SystemRoot: "C:\\Windows", CODEX_RELEASE: "0.1.0-alpha" },
      fetchImpl: async (url) => { calls.push(url); return new Response("provider fixture"); },
      spawn: (executable, args, options) => {
        calls.push({ executable, args, options });
        scriptPath = args[platform === "win32" ? 5 : 0];
        return { status: 0, stdout: "CANARY_SECRET" };
      },
    });
    expect(result).toEqual({ status: 0 });
    expect(calls[0]).toBe(`https://chatgpt.com/codex/install.${platform === "win32" ? "ps1" : "sh"}`);
    expect(calls[1].executable).toBe(platform === "win32"
      ? "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" : "/bin/sh");
    expect(calls[1].args.at(-1)).toBe("latest");
    expect(calls[1].options.env.CODEX_NON_INTERACTIVE).toBe("1");
    expect(calls[1].options.stdio[0]).toBe("ignore");
    expect(await readFile(scriptPath).catch((e) => e.code)).toBe("ENOENT");
  }
});

test("download failure, empty body and untrusted redirect never execute", async () => {
  for (const response of [new Response("no", { status: 500 }), new Response(""),
    { ok: true, url: "https://untrusted.example/install.sh" }]) {
    let called = false;
    expect((await runOfficialCodexInstaller({ platform: "linux",
      fetchImpl: async () => response, spawn: () => { called = true; },
    })).status).toBe(1);
    expect(called).toBe(false);
  }
});

test.skipIf(process.platform === "win32")("real subprocess executes downloaded fixture and cleans staging", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lazurio-codex-consumer-"));
  try {
    const marker = join(directory, "proof");
    const result = await runOfficialCodexInstaller({
      environment: { ...process.env, LAZURIO_TEST_INSTALL_MARKER: marker },
      fetchImpl: async () => new Response('set -eu\n[ "$1" = "--release" ]\n[ "$2" = "latest" ]\n[ "$CODEX_NON_INTERACTIVE" = "1" ]\nprintf verified > "$LAZURIO_TEST_INSTALL_MARKER"\n'),
    });
    expect(result.status).toBe(0);
    expect(await readFile(marker, "utf8")).toBe("verified");
  } finally { await rm(directory, { recursive: true, force: true }); }
});


test.skipIf(process.platform === "win32")("User-only installer refuses symlinked provider storage", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lazurio-codex-boundary-"));
  try {
    await mkdir(join(directory, ".codex"));
    const outside = join(directory, "other-owner");
    await mkdir(outside);
    await symlink(outside, join(directory, ".codex", "packages"));
    const f = fixture({ homeDirectory: directory, environment: { HOME: directory }, userPathsSafe: undefined });
    expect((await installMissingCodex(f.options)).action.reason).toBe("codex_custom_location");
    expect(f.calls).toHaveLength(0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("partial failure retries from the observed state and then preserves success", async () => {
  const f = fixture();
  const installer = f.options.runInstaller;
  let attempts = 0;
  f.options.runInstaller = async (args) => ++attempts === 1 ? { status: 1 } : installer(args);
  expect((await installMissingCodex(f.options)).status).toBe("failed");
  expect((await installMissingCodex(f.options)).status).toBe("completed");
  expect((await installMissingCodex(f.options)).action.attempted).toBe(false);
  expect(attempts).toBe(2);
});


test("an exception after mutation still returns a fresh observation", async () => {
  const f = fixture();
  f.options.runInstaller = async () => { f.setPresent(true); throw new Error("CANARY_AFTER_WRITE"); };
  const report = await installMissingCodex(f.options);
  expect(report.status).toBe("failed");
  expect(report.installation.steps.find((step) => step.id === "codex").status).toBe("completed");
  expect(JSON.stringify(report)).not.toContain("CANARY");
  expect(schema.properties.installation.$ref).toBe(reportSchema.$id);
});


test("Windows installer fails before download without a trusted SystemRoot", async () => {
  for (const environment of [{ PATH: "attacker" }, { SystemRoot: "relative" },
    { SystemRoot: "C:\\Windows\\..\\attacker" }, { SystemRoot: "\\\\remote\\share" }]) {
    let fetched = false;
    await expect(runOfficialCodexInstaller({ platform: "win32", environment,
      fetchImpl: async () => { fetched = true; return new Response("script"); },
    })).rejects.toThrow();
    expect(fetched).toBe(false);
  }
});
