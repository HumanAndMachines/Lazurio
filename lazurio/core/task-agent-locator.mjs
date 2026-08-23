function optionalText(value) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function isCodexSurface(surface) {
  return surface === "codex" || surface?.startsWith("codex-");
}

function isClaudeSurface(surface) {
  return surface === "claude" || surface?.startsWith("claude-");
}

/**
 * Resolve the opaque Task Agent task/thread/session locator supplied by a
 * supported harness.
 *
 * The pair { surface, id } is only a self-reported local recovery hint: it is
 * mutable, spoofable, and not identity or provenance proof. IDs are not
 * assumed to be globally unique across harnesses. Cursor and other surfaces
 * without a documented ambient variable use an explicit ID or the
 * Lazurio-neutral env pair instead of filesystem/transcript heuristics.
 */
export function resolveTaskAgentLocator({
  environment = {},
  id = null,
  surface = null,
} = {}) {
  const env = environment && typeof environment === "object" ? environment : {};
  const explicitId = optionalText(id);
  const requestedSurface = optionalText(surface);

  if (explicitId) {
    return { id: explicitId, surface: requestedSurface, source: "explicit" };
  }

  const lazurioId = optionalText(env.LAZURIO_TASK_AGENT_ID);
  const lazurioSurface = optionalText(env.LAZURIO_TASK_AGENT_SURFACE);
  if (lazurioId) {
    return {
      id: lazurioId,
      surface: requestedSurface ?? lazurioSurface,
      source: "LAZURIO_TASK_AGENT_ID",
    };
  }

  const legacyGenericId = optionalText(env.HUMANANDMACHINE_THREAD_ID);
  if (legacyGenericId) {
    return {
      id: legacyGenericId,
      surface: requestedSurface
        ?? optionalText(env.HUMANANDMACHINE_AGENT_SURFACE)
        ?? "humanandmachine-agent",
      source: "HUMANANDMACHINE_THREAD_ID",
    };
  }

  const codexId = optionalText(env.CODEX_THREAD_ID) ?? optionalText(env.CODEX_SESSION_ID);
  const codexSource = optionalText(env.CODEX_THREAD_ID) ? "CODEX_THREAD_ID" : "CODEX_SESSION_ID";
  const claudeId = optionalText(env.CLAUDE_CODE_SESSION_ID) ?? optionalText(env.CLAUDE_SESSION_ID);
  const claudeSource = optionalText(env.CLAUDE_CODE_SESSION_ID)
    ? "CLAUDE_CODE_SESSION_ID"
    : "CLAUDE_SESSION_ID";

  if (requestedSurface) {
    if (isCodexSurface(requestedSurface) && codexId) {
      return { id: codexId, surface: requestedSurface, source: codexSource };
    }
    if (isClaudeSurface(requestedSurface) && claudeId) {
      return { id: claudeId, surface: requestedSurface, source: claudeSource };
    }
    return { id: null, surface: requestedSurface, source: null };
  }

  if (codexId) return { id: codexId, surface: "codex", source: codexSource };
  if (claudeId) return { id: claudeId, surface: "claude-code", source: claudeSource };
  return { id: null, surface: null, source: null };
}
