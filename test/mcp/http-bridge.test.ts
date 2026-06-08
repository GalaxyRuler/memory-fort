import { describe, it, expect, afterEach } from "vitest";
import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { startHttpBridge } from "../../src/mcp/http-bridge.js";

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
