import { describe, expect, it } from "vitest";
import { debugLogBannerLines } from "../../src/cli/debug-banner.js";

describe("LLM debug banner", () => {
  it("returns no banner unless MEMORY_LLM_DEBUG_LOG is exactly 1", () => {
    expect(debugLogBannerLines({ env: {}, now: new Date("2026-05-28T12:00:00.000Z") })).toEqual([]);
    expect(debugLogBannerLines({ env: { MEMORY_LLM_DEBUG_LOG: "" }, now: new Date("2026-05-28T12:00:00.000Z") })).toEqual([]);
    expect(debugLogBannerLines({ env: { MEMORY_LLM_DEBUG_LOG: "true" }, now: new Date("2026-05-28T12:00:00.000Z") })).toEqual([]);
  });

  it("returns the two-line plaintext persistence warning when enabled", () => {
    expect(debugLogBannerLines({
      env: { MEMORY_LLM_DEBUG_LOG: "1" },
      now: new Date("2026-05-28T12:00:00.000Z"),
    })).toEqual([
      "⚠️  MEMORY_LLM_DEBUG_LOG=1 — prompt/response plaintext is being persisted to ~/.memory/wiki/.audit/llm-debug-2026-05-28.md",
      "⚠️  Disable with `unset MEMORY_LLM_DEBUG_LOG` (POSIX) or `Remove-Item Env:MEMORY_LLM_DEBUG_LOG` (PowerShell)",
    ]);
  });
});
