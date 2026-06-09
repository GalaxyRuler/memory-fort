import { describe, it, expect } from "vitest";
import { parseRawCaptureSourceFromFilename } from "../../src/capture/raw-captures.js";

describe("parseRawCaptureSourceFromFilename — new clients", () => {
  it("detects chatgpt", () => {
    expect(parseRawCaptureSourceFromFilename("chatgpt-session-abc123.md")).toBe("chatgpt");
  });
  it("detects opencode", () => {
    expect(parseRawCaptureSourceFromFilename("opencode-abc123.md")).toBe("opencode");
  });
  it("detects opencoven", () => {
    expect(parseRawCaptureSourceFromFilename("opencoven-abc123.md")).toBe("opencoven");
  });
  it("detects vscode", () => {
    expect(parseRawCaptureSourceFromFilename("vscode-abc123.md")).toBe("vscode");
  });
  it("still returns unknown for unrecognized prefix", () => {
    expect(parseRawCaptureSourceFromFilename("unknown-tool-abc.md")).toBe("unknown");
  });
  it("still detects existing sources", () => {
    expect(parseRawCaptureSourceFromFilename("claude-code-session-x.md")).toBe("claude-code");
    expect(parseRawCaptureSourceFromFilename("codex-abc.md")).toBe("codex");
    expect(parseRawCaptureSourceFromFilename("antigravity-abc.md")).toBe("antigravity");
    expect(parseRawCaptureSourceFromFilename("claude-desktop-abc.md")).toBe("claude-desktop");
    expect(parseRawCaptureSourceFromFilename("manual-abc.md")).toBe("manual");
  });
});
