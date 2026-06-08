import { describe, expect, it } from "vitest";
import { skip } from "../../../../src/cli/commands/verify/types.js";

describe("skip()", () => {
  it("produces a skip-status check result", () => {
    const result = skip("client.codex.capture", "Codex capture is fresh", "client disabled");
    expect(result.status).toBe("skip");
    expect(result.id).toBe("client.codex.capture");
    expect(result.label).toBe("Codex capture is fresh");
    expect(result.detail).toBe("client disabled");
    expect(result.durationMs).toBe(0);
  });
});
