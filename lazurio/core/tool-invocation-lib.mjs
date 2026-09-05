import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { resolveExecutableOnPath } from "./toolchain-lib.mjs";

// npm/cmd-shim's plain-node Windows template. Recognize the complete wrapper,
// never interpret batch syntax or concatenate caller arguments into shell code.
const npmNodeShim = String.raw`@ECHO off
GOTO start
:find_dp0
SET dp0=%~dp0
EXIT /b
:start
SETLOCAL
CALL :find_dp0

IF EXIST "%dp0%\node.exe" (
  SET "_prog=%dp0%\node.exe"
) ELSE (
  SET "_prog=node"
  SET PATHEXT=%PATHEXT:;.JS;=;%
)

endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\<TARGET>" %*
`;

export function toolInvocation(executable, args, {
  platform = process.platform,
  environment = process.env,
  cwd = process.cwd(),
} = {}) {
  if (platform !== "win32" || !/\.(cmd|bat)$/iu.test(executable)) {
    return { executable, args };
  }
  const unsupported = () => new Error(`Unsupported Windows script shim: ${executable}. Use an unmodified npm node shim or a native CLI executable.`);
  const text = readFileSync(executable, "utf8").replaceAll("\r\n", "\n");
  const target = /"%dp0%\\(node_modules\\[^"\r\n]+)" %\*\n?$/u.exec(text)?.[1];
  if (!target || text.trimEnd() !== npmNodeShim.replace("<TARGET>", target).trimEnd()) throw unsupported();
  const parts = target.split("\\");
  if (parts.some((part) => !/^[A-Za-z0-9@_. -]+$/u.test(part) || part === "." || part === "..")) throw unsupported();
  const packageParts = parts[1]?.startsWith("@") ? 3 : 2;
  if (parts.length <= packageParts) throw unsupported();
  const packageRoot = join(dirname(executable), ...parts.slice(0, packageParts));
  const entry = join(dirname(executable), ...parts);
  const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
  const command = basename(executable, extname(executable));
  const declaredBin = typeof manifest.bin === "string"
    ? manifest.name?.split("/").at(-1) === command ? manifest.bin : null
    : manifest.bin?.[command];
  if (typeof declaredBin !== "string" || resolve(packageRoot, declaredBin) !== entry
    || !/\.(?:c|m)?js$/iu.test(entry) || !statSync(entry).isFile()) throw unsupported();
  const siblingNode = join(dirname(executable), "node.exe");
  let node;
  try { if (statSync(siblingNode).isFile()) node = siblingNode; } catch { /* npm also falls back to PATH */ }
  node ??= resolveExecutableOnPath("node", { environment, platform, cwd });
  if (!node || !/\.exe$/iu.test(node)) throw new Error(`Native node.exe required for npm shim: ${executable}`);
  return { executable: node, args: [entry, ...args] };
}

export function spawnToolSync(executable, args, options = {}) {
  try {
    const invocation = toolInvocation(executable, args, {
      environment: options.env ?? process.env,
      cwd: options.cwd,
    });
    return spawnSync(invocation.executable, invocation.args, { ...options, shell: false });
  } catch (error) {
    return { status: null, stdout: "", stderr: error.message, error };
  }
}
