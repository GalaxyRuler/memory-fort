import { describe, expect, it } from "vitest";
import { classifyClientPresentation, type ClientIntegrationStatus } from "../../src/clients/presentation.js";

describe("client presentation", () => {
  it("classifies a status without loading the Node-only status probe", () => {
    const status: ClientIntegrationStatus = {
      client: "codex",
      captureEnabled: true,
      installation: "installed",
      health: "healthy",
      lastCheckedAt: "2026-07-24T00:00:00.000Z",
      evidence: ["bounded MCP tools/list probe passed"],
    };

    expect(classifyClientPresentation(status)).toBe("Healthy");
  });
});
