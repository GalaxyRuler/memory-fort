import { describe, it, expect, afterEach } from "vitest";
import { createServer as createHttpServer } from "node:http";
import https from "node:https";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startHttpBridge } from "../../src/mcp/http-bridge.js";
import { generateBridgeTlsCert, removeBridgeTlsCert } from "../../src/mcp/tls.js";

describe("startHttpBridge", () => {
  let cleanup: (() => Promise<void>) | undefined;

  afterEach(async () => {
    if (cleanup) {
      await cleanup();
      cleanup = undefined;
    }
  });

  it("listens on the given port and returns 200 on GET /health", async () => {
    const testPort = await getFreePort();
    cleanup = await startHttpBridge(testPort);
    const res = await fetch(`http://127.0.0.1:${testPort}/health`);
    expect(res.status).toBe(200);
  });

  it("returns 404 on POST /message with unknown sessionId", async () => {
    const testPort = await getFreePort();
    cleanup = await startHttpBridge(testPort);
    const res = await fetch(`http://127.0.0.1:${testPort}/message?sessionId=nonexistent`, {
      method: "POST",
      body: "{}",
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(404);
  });

  it("initializes a Streamable HTTP session on POST /mcp", async () => {
    const testPort = await getFreePort();
    cleanup = await startHttpBridge(testPort);
    const res = await fetch(`http://127.0.0.1:${testPort}/mcp`, {
      method: "POST",
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "test", version: "1.0" },
        },
      }),
      headers: {
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
      },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("mcp-session-id")).toBeTruthy();
  });

  it("returns 400 on GET /mcp without a session", async () => {
    const testPort = await getFreePort();
    cleanup = await startHttpBridge(testPort);
    const res = await fetch(`http://127.0.0.1:${testPort}/mcp`, {
      headers: { Accept: "text/event-stream" },
    });

    expect(res.status).toBe(400);
  });

  it("serves HTTPS when TLS cert exists", async () => {
    const origAppData = process.env["APPDATA"];
    const tempDir = await mkdtemp(join(tmpdir(), "mf-bridge-tls-"));
    process.env["APPDATA"] = tempDir;
    try {
      const tlsCert = await generateBridgeTlsCert();
      const testPort = await getFreePort();
      cleanup = await startHttpBridge(testPort);

      const status = await new Promise<number>((resolve, reject) => {
        const req = https.get(
          { hostname: "127.0.0.1", port: testPort, path: "/health", ca: tlsCert.cert },
          (res) => resolve(res.statusCode ?? 0),
        );
        req.on("error", reject);
      });

      expect(status).toBe(200);
    } finally {
      if (cleanup) {
        await cleanup();
        cleanup = undefined;
      }
      await removeBridgeTlsCert();
      if (origAppData === undefined) {
        delete process.env["APPDATA"];
      } else {
        process.env["APPDATA"] = origAppData;
      }
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createHttpServer();
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as AddressInfo).port;
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}
