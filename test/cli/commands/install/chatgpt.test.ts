import { describe, it, expect, vi } from "vitest";
import { runInstallChatGpt } from "../../../../src/cli/commands/install/chatgpt.js";

vi.mock("../../../../src/storage/config.js", () => ({
  loadMemoryConfig: async () => ({}),
  getChatGptBridgePort: () => 3100,
}));

vi.mock("../../../../src/cli/commands/chatgpt-bridge.js", () => ({
  runChatGptBridgeStatus: async () => ({ running: false, pid: null, port: 3100, url: "http://localhost:3100/sse" }),
  runChatGptBridgeStart: async () => ({ running: true, pid: 12345, port: 3100, url: "http://localhost:3100/sse" }),
}));

vi.mock("../../../../src/mcp/tls.js", () => ({
  loadBridgeTlsCert: vi.fn(async () => null),
  generateBridgeTlsCert: vi.fn(async () => ({
    cert: "-----BEGIN CERTIFICATE-----\n-----END CERTIFICATE-----",
    key: "-----BEGIN PRIVATE KEY-----\n-----END PRIVATE KEY-----",
  })),
  trustBridgeCert: vi.fn(async () => ({ trusted: true, message: "trusted" })),
}));

vi.mock("../../../../src/storage/paths.js", () => ({
  memoryRoot: () => "/tmp/test-memory",
  chatgptBridgePidPath: () => "/tmp/test-chatgpt-bridge.pid",
}));

vi.mock("../../../../src/storage/atomic-write.js", () => ({
  atomicWrite: vi.fn(async () => undefined),
}));

describe("runInstallChatGpt", () => {
  it("returns bridge URL and instructions on dryRun", async () => {
    const result = await runInstallChatGpt({ dryRun: true });
    expect(result.bridgeUrl).toBe("https://localhost:3100/sse");
    expect(result.port).toBe(3100);
    expect(result.instructions).toContain("https://localhost:3100/sse");
  });

  it("throws on invalid port", async () => {
    await expect(runInstallChatGpt({ dryRun: true, port: 80 })).rejects.toThrow(
      "Invalid bridge port 80: must be integer between 1024 and 65535",
    );
  });

  it("writes chatgpt.bridge_port to config on non-dryRun", async () => {
    const { atomicWrite } = await import("../../../../src/storage/atomic-write.js");
    const mockWrite = vi.mocked(atomicWrite);
    mockWrite.mockClear();

    const result = await runInstallChatGpt({ dryRun: false, noAutostart: true });

    expect(result.port).toBe(3100);
    expect(mockWrite).toHaveBeenCalledOnce();

    const [writtenPath, writtenContent] = mockWrite.mock.calls[0] as [string, string];
    expect(writtenPath).toContain("config.yaml");
    expect(writtenContent).toContain("clients:");
    expect(writtenContent).toContain("chatgpt: true");
    expect(writtenContent).toContain("bridge_port: 3100");
  });
});
