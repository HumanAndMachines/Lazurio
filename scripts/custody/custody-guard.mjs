#!/usr/bin/env bun
// PreToolUse guard for Claude Code (and Codex, which speaks the same hook
// protocol): denies a tool call that would print values from local secret
// custody into the agent transcript, and points to custody-shape.mjs.
//
// Contract: reads the hook JSON on stdin. On a positive match it prints a
// `deny` decision; otherwise it prints nothing and the call proceeds. Any
// internal error exits 0 without a decision (fail open), so a broken guard
// never blocks the agents of this Mac. There is no bypass flag or variable:
// the only way around a deny is to change the command, or for the person to
// remove the hook from their settings.
//
// Rules, installation and known limits: manual/security/local-secret-custody.md.
import { isAbsolute, join, resolve } from "node:path";
import { createCustodyModel } from "./custody-model.mjs";
import { custodyLeaks } from "./shell-taint.mjs";

const ROOT = resolve(import.meta.dir, "..", "..");
const HELPER = join(ROOT, "scripts", "custody", "custody-shape.mjs");
const STANDARD = join(ROOT, "manual", "security", "local-secret-custody.md");

function tilde(path, home) {
  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

// The reason a tool call would print custody values, or null.
export function custodyReason(input, { model = createCustodyModel(), env = process.env } = {}) {
  const toolInput = input?.tool_input ?? {};
  const cwd = typeof input?.cwd === "string" && isAbsolute(input.cwd) ? input.cwd : model.home;
  const at = (path) => resolve(cwd, path.startsWith("~/") ? model.home + path.slice(1) : path);
  switch (input?.tool_name) {
    case "Bash":
    case "Monitor": {
      const command = toolInput.command;
      if (typeof command !== "string" || command.trim() === "") return null;
      return custodyLeaks(command, { model, cwd, env })[0] ?? null;
    }
    case "Read": {
      if (typeof toolInput.file_path !== "string") return null;
      const path = at(toolInput.file_path);
      return model.isCustodyPath(path) ? `Read would show ${tilde(path, model.home)}` : null;
    }
    case "Grep": {
      if (toolInput.output_mode !== "content") return null;
      const path = at(typeof toolInput.path === "string" && toolInput.path ? toolInput.path : ".");
      // The Grep tool runs ripgrep with --hidden and honours .gitignore.
      const reaches = model.directoryReachesCustody(path, { skipsHidden: false, respectsGitignore: true });
      return reaches ? `Grep in content mode would print lines from ${tilde(path, model.home)}, which holds custody` : null;
    }
    default:
      return null;
  }
}

export function denyMessage(reason, { home = createCustodyModel().home } = {}) {
  return [
    `Lazurio custody guard: ${reason}. That would put secret values from local custody into this transcript, so the call was not run.`,
    `To see a custody file's structure, run \`bun ${tilde(HELPER, home)} <file>\`: key paths, types and lengths, never values. Add --fingerprint and several files to check whether values are equal.`,
    "Pass custody paths to tools and scripts instead of reading them yourself, and send output that may contain values to a file inside custody.",
    `Rules and limits: ${tilde(STANDARD, home)}.`,
  ].join(" ");
}

export function hookResponse(input, options = {}) {
  const reason = custodyReason(input, options);
  if (!reason) return null;
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: denyMessage(reason, options.model ? { home: options.model.home } : {}),
    },
  };
}

if (import.meta.main) {
  try {
    const response = hookResponse(JSON.parse(await Bun.stdin.text()));
    if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
  } catch (error) {
    process.stderr.write(`custody guard: internal ${error?.name ?? "error"}; allowing the call\n`);
  }
  process.exit(0);
}
