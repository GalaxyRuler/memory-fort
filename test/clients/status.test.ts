import { describe, expect, it } from "vitest";
import {
  classifyClientPresentation,
  runBoundedMcpProbe,
  type ClientIntegrationStatus,
} from "../../src/clients/status.js";

describe("client integration status", () => {
  it("does not call an enabled client installed without installation evidence", () => {
    const status: ClientIntegrationStatus = {
      client: "codex",
      captureEnabled: true,
      installation: "missing",
      health: "unknown",
      lastCheckedAt: null,
      evidence: ["Memory Fort block is absent from config.toml"],
    };

    expect(classifyClientPresentation(status)).toBe("Not installed");
  });

  it("separates a stale installation from an unhealthy installed client", () => {
    expect(classifyClientPresentation({
      client: "chatgpt",
      captureEnabled: true,
      installation: "stale",
      health: "unhealthy",
      lastCheckedAt: "2026-07-24T00:00:00.000Z",
      evidence: ["ChatGPT bridge endpoint did not answer"],
    })).toBe("Needs repair");
    expect(classifyClientPresentation({
      client: "chatgpt",
      captureEnabled: true,
      installation: "installed",
      health: "unhealthy",
      lastCheckedAt: "2026-07-24T00:00:00.000Z",
      evidence: ["ChatGPT bridge endpoint returned 503"],
    })).toBe("Unhealthy");
  });

  it("renders all distinct status states without inventing a health result", () => {
    const base = {
      client: "codex" as const,
      captureEnabled: true,
      installation: "installed" as const,
      evidence: ["configuration present"],
    };
    expect(classifyClientPresentation({ ...base, health: "unknown", lastCheckedAt: null })).toBe("Installed — health unknown");
    expect(classifyClientPresentation({ ...base, health: "healthy", lastCheckedAt: "2026-07-24T00:00:00.000Z" })).toBe("Healthy");
    expect(classifyClientPresentation({ ...base, captureEnabled: false, health: "unknown", lastCheckedAt: null })).toBe("Off");
  });

  it("uses a bounded MCP initialize and tools/list exchange as health evidence", async () => {
    const server = [
      "let buffer = '';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', (chunk) => {",
      "  buffer += chunk;",
      "  const lines = buffer.split('\\n'); buffer = lines.pop() || '';",
      "  for (const line of lines) {",
      "    const message = JSON.parse(line);",
      "    if (message.id === 1) process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:1,result:{protocolVersion:'2024-11-05',capabilities:{}}}) + '\\n');",
      "    if (message.id === 2) process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:2,result:{tools:[{name:'log_observation'},{name:'read_page'},{name:'search'}]}}) + '\\n');",
      "  }",
      "});",
    ].join("\n");

    await expect(runBoundedMcpProbe({ command: process.execPath, args: ["-e", server] }, 1_000)).resolves.toBe("healthy");
  });
});
