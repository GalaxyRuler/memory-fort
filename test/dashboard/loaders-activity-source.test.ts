import { describe, it, expect } from "vitest";
import { timelineLaneForEvent } from "../../src/dashboard/loaders.js";
import type { ActivityEvent } from "../../src/dashboard/loaders.js";

function makeEvent(source: ActivityEvent["source"]): ActivityEvent {
  return { timestamp: "2026-06-08T00:00:00Z", source, level: "info", summary: "test" };
}

describe("timelineLaneForEvent — new clients", () => {
  it("chatgpt → chatgpt lane", () => {
    expect(timelineLaneForEvent(makeEvent("chatgpt"))).toBe("chatgpt");
  });
  it("opencode → opencode lane", () => {
    expect(timelineLaneForEvent(makeEvent("opencode"))).toBe("opencode");
  });
  it("opencoven → opencoven lane", () => {
    expect(timelineLaneForEvent(makeEvent("opencoven"))).toBe("opencoven");
  });
  it("vscode → vscode lane", () => {
    expect(timelineLaneForEvent(makeEvent("vscode"))).toBe("vscode");
  });
  it("existing sources still route correctly", () => {
    expect(timelineLaneForEvent(makeEvent("claude-code"))).toBe("claude-code");
    expect(timelineLaneForEvent(makeEvent("codex"))).toBe("codex");
    expect(timelineLaneForEvent(makeEvent("compile"))).toBe("compile");
    expect(timelineLaneForEvent(makeEvent("sync"))).toBe("sync");
  });
  it("git falls through to manual", () => {
    expect(timelineLaneForEvent(makeEvent("git"))).toBe("manual");
  });
});
