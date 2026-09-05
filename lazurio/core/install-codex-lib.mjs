import { lstatSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, posix, win32 } from "node:path";
import { inspectLazurioInstallation } from "./install-core-lib.mjs";
import { trustedWindowsSystemExecutable } from "./windows-system-path-lib.mjs";
import { spawnToolSync } from "./tool-invocation-lib.mjs";

// The provider owns installation, locking and User PATH. Lazurio owns consent,
// bounded invocation and fresh observation; no persisted install journal.
export async function installMissingCodex({
  root = null,
  allowUserPath = false,
  codexAbsent = false,
  platform = process.platform,
  architecture = process.arch,
  environment = process.env,
  homeDirectory = homedir(),
  inspect = inspectLazurioInstallation,
  pathExists = entryExists,
  userPathsSafe = codexUserPathsSafe,
  runInstaller = runOfficialCodexInstaller,
} = {}) {
  const observationOptions = { root, platform, architecture, environment, homeDirectory };
  let installation = inspect(observationOptions);
  const finish = (status, reason, attempted = false) => ({
    schema_version: "lazurio.install.apply.v1",
    status: status === "failed" || installation.status === "failed" ? "failed"
      : status === "action_required" ? status : installation.status,
    action: { tool: "codex", status, reason, attempted },
    installation,
  });
  const codex = installation.steps.find((step) => step.id === "codex");
  if (codex?.status === "completed") return finish("completed", "codex_preserved");
  if (codex?.reason !== "codex_missing") return finish("action_required", "codex_existing_unusable");
  if (installation.steps.find((step) => step.id === "platform")?.status !== "completed"
    || installation.root.layout.includes("generated")) {
    return finish("action_required", "codex_install_unsupported");
  }
  if (allowUserPath !== true) return finish("action_required", "codex_user_path_consent_required");

  const paths = platform === "win32" ? win32 : posix;
  const expectedHome = platform === "win32" ? environment.USERPROFILE : environment.HOME;
  // Custom installer destinations need their own exact mandate. Never inherit
  // an ambient override that can silently expand this User-only operation.
  if (!expectedHome || paths.resolve(expectedHome) !== paths.resolve(homeDirectory)
    || environment.CODEX_INSTALL_DIR || environment.CODEX_HOME
    || (platform === "win32" && (!environment.LOCALAPPDATA
      || !paths.isAbsolute(environment.LOCALAPPDATA)
      || paths.relative(homeDirectory, environment.LOCALAPPDATA).startsWith("..")
      || paths.isAbsolute(paths.relative(homeDirectory, environment.LOCALAPPDATA))))) {
    return finish("action_required", "codex_custom_location");
  }
  const binary = platform === "win32"
    ? paths.join(environment.LOCALAPPDATA, "Programs", "OpenAI", "Codex", "bin", "codex.exe")
    : paths.join(homeDirectory, ".local", "bin", "codex");
  try {
    if (!userPathsSafe({ binary, homeDirectory, platform })) {
      return finish("action_required", "codex_custom_location");
    }
    const candidates = platform === "win32" ? [binary,
      environment.APPDATA && paths.join(environment.APPDATA, "npm", "codex.cmd"),
      paths.join(environment.LOCALAPPDATA, "Microsoft", "WinGet", "Links", "codex.exe"),
      paths.join(homeDirectory, "scoop", "shims", "codex.exe"),
      paths.join(homeDirectory, "scoop", "shims", "codex.ps1"),
      paths.join(homeDirectory, ".bun", "bin", "codex.exe"),
    ] : [binary, "/opt/homebrew/bin/codex", "/usr/local/bin/codex", "/usr/bin/codex",
      "/opt/homebrew/Caskroom/codex", "/usr/local/Caskroom/codex",
      "/usr/local/lib/node_modules/@openai/codex",
      paths.join(homeDirectory, ".bun", "bin", "codex"),
    ];
    if (candidates.filter(Boolean).some(pathExists)) return finish("action_required", "codex_outside_path");
  } catch {
    return finish("failed", "codex_install_probe_failed");
  }
  // No finite path inventory proves absence at custom package-manager prefixes.
  // A clean-image runner or an Agent must supply that verified fact explicitly;
  // missing PATH alone never authorizes creating a second installation.
  if (codexAbsent !== true) return finish("action_required", "codex_absence_unverified");
  let result;
  try {
    result = await runInstaller({ platform, environment });
  } catch {
    result = { status: 1 };
  }
  installation = inspect(observationOptions);
  if (result?.status !== 0) return finish("failed", "codex_installer_failed", true);
  // A child cannot prove a Windows harness restart or persistent PATH refresh.
  if (platform === "win32" || installation.steps.find((step) => step.id === "codex")?.status !== "completed") {
    return finish("action_required", "codex_restart_required", true);
  }
  return finish("completed", "codex_installed", true);
}

export async function runOfficialCodexInstaller({
  platform = process.platform,
  environment = process.env,
  fetchImpl = fetch,
  spawn = spawnToolSync,
} = {}) {
  const windows = platform === "win32";
  const executable = windows
    ? trustedWindowsSystemExecutable(["System32", "WindowsPowerShell", "v1.0", "powershell.exe"], environment)
    : "/bin/sh";
  const url = `https://chatgpt.com/codex/install.${windows ? "ps1" : "sh"}`;
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(30_000) });
  const finalUrl = new URL(response.url || url);
  if (!response.ok || finalUrl.protocol !== "https:"
    || !["chatgpt.com", "releases.openai.com"].includes(finalUrl.hostname)) return { status: 1 };
  // Download fully before execution; a failed/truncated transfer is never piped
  // into a shell. The official provider remains the release/signature authority.
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > 1_048_576) throw new Error("Installer exceeds download bound.");
    chunks.push(chunk);
  }
  if (!size) return { status: 1 };
  const directory = await mkdtemp(join(tmpdir(), "lazurio-codex-install-"));
  try {
    const script = join(directory, windows ? "install.ps1" : "install.sh");
    await writeFile(script, Buffer.concat(chunks), { mode: 0o600 });
    const args = windows
      ? ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, "-Release", "latest"]
      : [script, "--release", "latest"];
    const result = spawn(executable, args, {
      env: { ...environment, CODEX_NON_INTERACTIVE: "1" },
      cwd: directory,
      encoding: "utf8",
      timeout: 600_000,
      maxBuffer: 1_048_576,
      stdio: ["ignore", "pipe", "pipe"],
    });
    // Never expose installer output, environment or exceptions in the report.
    return { status: result?.status === 0 ? 0 : 1 };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function entryExists(path) {
  try { lstatSync(path); return true; } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

function codexUserPathsSafe({ binary, homeDirectory, platform }) {
  const paths = platform === "win32" ? win32 : posix;
  const targets = [paths.dirname(binary), paths.join(homeDirectory, ".codex", "packages", "standalone")];
  if (platform !== "win32") {
    targets.push(...[".profile", ".bash_profile", ".bashrc", ".zprofile", ".zshrc"]
      .map((name) => paths.join(homeDirectory, name)));
  }
  // Upstream modifies a User profile/PATH and its own directories. An existing
  // symlink/junction could redirect those writes outside that mandate.
  for (let target of targets) {
    while (target !== homeDirectory) {
      const relative = paths.relative(homeDirectory, target);
      if (relative.startsWith("..") || paths.isAbsolute(relative)) return false;
      try { if (lstatSync(target).isSymbolicLink()) return false; } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      const parent = paths.dirname(target);
      if (parent === target) return false;
      target = parent;
    }
  }
  return true;
}
