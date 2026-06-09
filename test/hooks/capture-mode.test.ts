import { describe, it, expect } from "vitest";
import { readCaptureMode, type CaptureMode } from "../../src/hooks/capture-mode.js";
import type { MemoryConfig } from "../../src/storage/config.js";

describe("readCaptureMode", () => {
  it("returns 'full' when no capture config exists", () => {
    const config = {} as MemoryConfig;
    expect(readCaptureMode(config, "Read")).toBe("full");
  });

  it("returns 'full' when tool is not listed in capture.tools", () => {
    const config = { capture: { tools: { Bash: "summary" } } } as MemoryConfig;
    expect(readCaptureMode(config, "Read")).toBe("full");
  });

  it("returns configured mode for a listed tool", () => {
    const config = {
      capture: { tools: { Read: "metadata", Grep: "summary", Glob: "skip" } },
    } as MemoryConfig;
    expect(readCaptureMode(config, "Read")).toBe("metadata");
    expect(readCaptureMode(config, "Grep")).toBe("summary");
    expect(readCaptureMode(config, "Glob")).toBe("skip");
  });

  it("returns 'full' for invalid mode values", () => {
    const config = {
      capture: { tools: { Read: "bogus" as CaptureMode } },
    } as MemoryConfig;
    expect(readCaptureMode(config, "Read")).toBe("full");
  });

  it("returns 'skip' when exclude_patterns matches tool input", () => {
    const config = {
      capture: {
        tools: { Bash: "summary" },
        exclude_patterns: ["git status", "^ls "],
      },
    } as MemoryConfig;
    expect(readCaptureMode(config, "Bash", '{"command": "git status"}')).toBe("skip");
    expect(readCaptureMode(config, "Bash", '{"command": "npm test"}')).toBe("summary");
  });

  it("exclude_patterns takes precedence over tool mode", () => {
    const config = {
      capture: {
        tools: { Bash: "full" },
        exclude_patterns: ["git status"],
      },
    } as MemoryConfig;
    expect(readCaptureMode(config, "Bash", '{"command": "git status"}')).toBe("skip");
  });

  it("ignores invalid regex in exclude_patterns gracefully", () => {
    const config = {
      capture: {
        exclude_patterns: ["[invalid("],
      },
    } as MemoryConfig;
    expect(readCaptureMode(config, "Bash", "anything")).toBe("full");
  });
});
