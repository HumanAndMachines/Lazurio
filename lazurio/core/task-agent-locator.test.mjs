import { describe, expect, test } from "bun:test";
import { resolveTaskAgentLocator } from "./task-agent-locator.mjs";

describe("Task Agent recovery locator", () => {
  test.each([
    [
      "Codex thread ID",
      { CODEX_THREAD_ID: "codex-thread", CODEX_SESSION_ID: "codex-session" },
      { id: "codex-thread", surface: "codex", source: "CODEX_THREAD_ID" },
    ],
    [
      "Codex session fallback",
      { CODEX_SESSION_ID: "codex-session" },
      { id: "codex-session", surface: "codex", source: "CODEX_SESSION_ID" },
    ],
    [
      "Claude Code session ID",
      { CLAUDE_CODE_SESSION_ID: "claude-session" },
      { id: "claude-session", surface: "claude-code", source: "CLAUDE_CODE_SESSION_ID" },
    ],
    [
      "legacy Claude session fallback",
      { CLAUDE_SESSION_ID: "legacy-claude-session" },
      { id: "legacy-claude-session", surface: "claude-code", source: "CLAUDE_SESSION_ID" },
    ],
  ])("resolves %s", (_name, environment, expected) => {
    expect(resolveTaskAgentLocator({ environment })).toEqual(expected);
  });

  test("keeps the harness surface with an explicit Cursor chat ID", () => {
    expect(resolveTaskAgentLocator({
      id: "cursor-chat-id",
      surface: "cursor-cli",
      environment: { CODEX_THREAD_ID: "inherited-codex-thread" },
    })).toEqual({ id: "cursor-chat-id", surface: "cursor-cli", source: "explicit" });
  });

  test("does not attach an inherited Codex ID to a Cursor surface", () => {
    expect(resolveTaskAgentLocator({
      surface: "cursor-cli",
      environment: { CODEX_THREAD_ID: "inherited-codex-thread" },
    })).toEqual({ id: null, surface: "cursor-cli", source: null });
  });

  test("requires a surface alongside the harness-neutral Lazurio ID", () => {
    expect(resolveTaskAgentLocator({
      environment: { LAZURIO_TASK_AGENT_ID: "opaque-id" },
    })).toEqual({ id: "opaque-id", surface: null, source: "LAZURIO_TASK_AGENT_ID" });
    expect(resolveTaskAgentLocator({
      environment: {
        LAZURIO_TASK_AGENT_ID: "opaque-id",
        LAZURIO_TASK_AGENT_SURFACE: "cursor-cli",
      },
    })).toEqual({
      id: "opaque-id",
      surface: "cursor-cli",
      source: "LAZURIO_TASK_AGENT_ID",
    });
  });
});
