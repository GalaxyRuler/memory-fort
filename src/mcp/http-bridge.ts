import http from "node:http";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { secretsPath } from "../storage/paths.js";
import { loadSecretsIntoEnv } from "../storage/secrets.js";
import { createServer } from "./server.js";

const DEFAULT_PORT = 3100;

/**
 * Start the HTTP/SSE MCP bridge on the given port.
 * Returns an async cleanup function that closes the server.
 */
export async function startHttpBridge(port: number = DEFAULT_PORT): Promise<() => Promise<void>> {
  const activeTransports = new Map<string, SSEServerTransport>();

  const httpServer = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);

    if (req.method === "GET" && url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("ok");
      return;
    }

    if (req.method === "GET" && url.pathname === "/sse") {
      const transport = new SSEServerTransport("/message", res);
      const mcpServer = createServer();
      await mcpServer.connect(transport);
      activeTransports.set(transport.sessionId, transport);
      res.on("close", () => {
        activeTransports.delete(transport.sessionId);
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/message") {
      const sessionId = url.searchParams.get("sessionId") ?? "";
      const transport = activeTransports.get(sessionId);
      if (transport) {
        await transport.handlePostMessage(req, res);
      } else {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("No active session for sessionId: " + sessionId);
      }
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(port, "127.0.0.1", resolve);
  });

  return () =>
    new Promise<void>((resolve, reject) => {
      httpServer.close((err) => (err ? reject(err) : resolve()));
    });
}

// Entry point when run directly as a process
const isMain =
  process.argv[1]?.endsWith("http-bridge.mjs") ||
  process.argv[1]?.endsWith("http-bridge.js");

if (isMain) {
  loadSecretsIntoEnv(secretsPath());
  const port = process.env["MEMORY_BRIDGE_PORT"]
    ? parseInt(process.env["MEMORY_BRIDGE_PORT"], 10)
    : DEFAULT_PORT;
  startHttpBridge(port)
    .then(() => {
      process.stdout.write(`memory bridge listening on http://127.0.0.1:${port}/sse\n`);
    })
    .catch((err) => {
      process.stderr.write(`memory bridge failed to start: ${(err as Error).message}\n`);
      process.exit(1);
    });
}
