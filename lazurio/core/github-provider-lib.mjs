import { spawnSync } from "node:child_process";

import { resolveTrustedGitHubCliExecutable } from "./cli-provenance-lib.mjs";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_STDIO_BYTES = 16 * 1024 * 1024;

export function createTrustedGitHubProvider({
  platform = process.platform,
  environment = process.env,
  cwd = process.cwd(),
  resolveExecutable = resolveTrustedGitHubCliExecutable,
  runCommand = runTrustedGitHubCliSync,
} = {}) {
  const executable = resolveExecutable({ platform, environment });
  const providerEnvironment = sanitizedGitHubEnvironment(environment, platform);

  const command = (args, { json = true } = {}) => {
    if (!executable) {
      return providerFailure("cli_unavailable", "GitHub CLI nebylo nalezeno.");
    }
    if (
      !Array.isArray(args)
      || args.length === 0
      || args.some((arg) => typeof arg !== "string" || arg.includes("\0"))
    ) {
      return providerFailure("invalid_request", "GitHub provider dostal neplatné argv.");
    }

    let result;
    try {
      result = runCommand({
        executable,
        args,
        cwd,
        environment: providerEnvironment,
      });
    } catch (error) {
      return providerFailure(
        "transport",
        error instanceof Error ? error.message : "GitHub provider nelze spustit.",
      );
    }

    if (!Number.isInteger(result?.status)) {
      const transportMessage = result?.error instanceof Error
        ? result.error.message
        : String(result?.error?.message ?? result?.stderr ?? "").trim();
      return providerFailure(
        "transport",
        transportMessage || "GitHub provider nelze spustit.",
        { status: null, stderr: result?.stderr },
      );
    }

    const status = result.status;
    const stdout = String(result?.stdout ?? "");
    const stderr = String(result?.stderr ?? "");
    let value = null;
    if (json && stdout.trim() !== "") {
      try {
        value = JSON.parse(stdout);
      } catch {
        return providerFailure(
          "invalid_response",
          "GitHub provider nevrátil validní JSON.",
          { status, stderr },
        );
      }
    }

    const stderrHttpStatus = stderr.match(
      /(?:\(|\b)HTTP\s+([1-5][0-9]{2})(?:\)|\b)/u,
    )?.[1];
    const httpStatus = Number(value?.status ?? stderrHttpStatus ?? 0) || null;
    if (status !== 0) {
      return providerFailure(
        httpStatus ? "http" : "command",
        providerMessage(value, stderr),
        { status, httpStatus, value, stderr },
      );
    }
    return Object.freeze({
      ok: true,
      status,
      httpStatus,
      value,
      error: null,
    });
  };

  return Object.freeze({
    available: executable !== null,
    executable,
    command,
    json: (args) => command(args, { json: true }),
  });
}

export function sanitizedGitHubEnvironment(
  environment,
  platform = process.platform,
) {
  const result = {};
  for (const key of [
    "PATH",
    "HOME",
    "XDG_CONFIG_HOME",
    "GH_CONFIG_DIR",
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "APPDATA",
    "LOCALAPPDATA",
    "USERPROFILE",
    "TMPDIR",
    "TEMP",
    "TMP",
    "SystemRoot",
    "ComSpec",
    "PATHEXT",
  ]) {
    if (typeof environment?.[key] === "string") result[key] = environment[key];
  }
  result.GH_HOST = "github.com";
  result.GH_PAGER = "cat";
  result.GH_PROMPT_DISABLED = "1";
  result.GH_NO_UPDATE_NOTIFIER = "1";
  result.NO_COLOR = "1";
  result.LC_ALL = "C";
  if (platform === "win32" && typeof result.SystemRoot !== "string") {
    delete result.SystemRoot;
  }
  return result;
}

export function runTrustedGitHubCliSync({
  executable,
  args,
  cwd,
  environment,
}) {
  const result = spawnSync(executable, args, {
    cwd,
    env: environment,
    encoding: "utf8",
    shell: false,
    windowsHide: true,
    timeout: DEFAULT_TIMEOUT_MS,
    maxBuffer: MAX_STDIO_BYTES,
  });
  return {
    status: result.status,
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? result.error?.message ?? ""),
    error: result.error ?? null,
  };
}

function providerMessage(value, stderr) {
  const message = typeof value?.message === "string"
    ? value.message
    : String(stderr ?? "").trim();
  return message || "GitHub provider selhal bez bližší zprávy.";
}

function providerFailure(
  kind,
  message,
  { status = 1, httpStatus = null, value = null, stderr = "" } = {},
) {
  return Object.freeze({
    ok: false,
    status,
    httpStatus,
    value,
    error: Object.freeze({
      kind,
      message: String(message || "GitHub provider selhal."),
      stderr: String(stderr).slice(-2_000),
    }),
  });
}
