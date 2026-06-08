import { describe, it, expect, vi } from "vitest";
import { runInstallChatGpt } from "../../../../src/cli/commands/install/chatgpt.js";

vi.mock("../../../../src/storage/config.js", () => ({
  loadMemoryConfig: async () => ({}),
  getChatGptBridgePort: () => 3100,
}));

vi.mock("../../../../src/cli/commands/chatgpt-bridge.js", () => ({
  runChatGptBridgeStatus: async () => ({ running: false, pid: null, port: 3100, url: "http://127.0.0.1:3100/sse" }),
  runChatGptBridgeStart: async () => ({ running: true, pid: 12345, port: 3100, url: "http://127.0.0.1:3100/sse" }),
}));

vi.mock("../../../../src/storage/paths.js", () => ({
  memoryRoot: () => "/tmp/test-memory",
  chatgptBridgePidPath: () => "/tmp/test-chatgpt-bridge.pid",
}));

describe("runInstallChatGpt", () => {
  it("returns bridge URL and instructions on dryRun", async () => {
    const result = await runInstallChatGpt({ dryRun: true });
    expect(result.bridgeUrl).toBe("http://127.0.0.1:3100/sse");
    expect(result.port).toBe(3100);
    expect(result.instructions).toContain("http://127.0.0.1:3100/sse");
  });
});
