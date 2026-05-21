import { describe, it, expect } from "vitest";
import {
  readSessionId,
  readPrompt,
  readToolName,
  readToolOutput,
  readCwd,
} from "../../../src/hooks/util/payload-fields.js";

describe("payload field readers (Claude Code shape)", () => {
  it("reads session_id and prompt", () => {
    expect(readSessionId({ session_id: "abc" })).toBe("abc");
    expect(readPrompt({ prompt: "hello" })).toBe("hello");
  });

  it("reads tool_name and tool_output", () => {
    expect(readToolName({ tool_name: "Bash" })).toBe("Bash");
    expect(readToolOutput({ tool_output: "result" })).toBe("result");
  });
});

describe("payload field readers (Codex shape)", () => {
  it("falls back to turn_id when session_id absent", () => {
    expect(readSessionId({ turn_id: "t123" })).toBe("t123");
  });

  it("falls back to tool_response when tool_output absent", () => {
    expect(readToolOutput({ tool_response: "codex-output" })).toBe(
      "codex-output",
    );
  });

  it("falls back to working_directory when cwd absent", () => {
    expect(readCwd({ working_directory: "/work" })).toBe("/work");
  });

  it("falls back to user_prompt and message when prompt absent", () => {
    expect(readPrompt({ user_prompt: "from user_prompt" })).toBe(
      "from user_prompt",
    );
    expect(readPrompt({ message: "from message" })).toBe("from message");
  });

  it("falls back to camelCase toolName", () => {
    expect(readToolName({ toolName: "Read" })).toBe("Read");
  });
});

describe("payload field readers (empty/missing)", () => {
  it("returns unknown for missing session", () => {
    expect(readSessionId({})).toBe("unknown");
  });

  it("returns null for missing prompt", () => {
    expect(readPrompt({})).toBeNull();
  });

  it("returns null for missing tool_name", () => {
    expect(readToolName({})).toBeNull();
  });
});
