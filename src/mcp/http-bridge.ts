import http from "node:http";
import https from "node:https";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { secretsPath } from "../storage/paths.js";
import { loadSecretsIntoEnv } from "../storage/secrets.js";
import { createServer } from "./server.js";
import { loadBridgeTlsCert } from "./tls.js";

const DEFAULT_PORT = 3100;

/**
 * Start the HTTP/SSE MCP bridge on the given port.
 * Returns an async cleanup function that closes the server.
 */
export async function startHttpBridge(port: number = DEFAULT_PORT): Promise<() => Promise<void>> {
  const activeTransports = new Map<string, SSEServerTransport>();
  const streamableSessions = new Map<string, StreamableHTTPServerTransport>();
  const tlsCert = await loadBridgeTlsCert();
  const scheme = tlsCert ? "https" : "http";

  const handler = async (req: http.IncomingMessage, res: http.ServerResponse) => {
    try {
      const url = new URL(req.url ?? "/", `${scheme}://127.0.0.1:${port}`);

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

      if (url.pathname === "/mcp") {
        const sessionHeader = req.headers["mcp-session-id"];
        const sessionId = Array.isArray(sessionHeader) ? sessionHeader[0] : sessionHeader;

        if (sessionId) {
          const transport = streamableSessions.get(sessionId);
          if (transport) {
            await transport.handleRequest(req, res);
            return;
          }
        }

        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid) => {
            streamableSessions.set(sid, transport);
            const previousOnClose = transport.onclose;
            transport.onclose = () => {
              streamableSessions.delete(sid);
              previousOnClose?.();
            };
          },
        });
        const mcpServer = createServer();
        await mcpServer.connect(transport);
        await transport.handleRequest(req, res);
        return;
      }

      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("Internal server error");
      }
    }
  };

  const server = tlsCert
    ? https.createServer({ cert: tlsCert.cert, key: tlsCert.key }, handler)
    : http.createServer(handler);

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });

  return async () => {
    // Close all active SSE transports
    for (const transport of activeTransports.values()) {
      try {
        await transport.close();
      } catch {
        // Ignore errors during cleanup
      }
    }
    activeTransports.clear();

    // Close all active Streamable HTTP transports
    for (const transport of streamableSessions.values()) {
      try {
        await transport.close();
      } catch {
        // Ignore errors during cleanup
      }
    }
    streamableSessions.clear();

    return new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  };
}

// Entry point when run directly as a process
const isMain = process.argv[1] === fileURLToPath(import.meta.url);

if (isMain) {
  loadSecretsIntoEnv(secretsPath());
  const port = process.env["MEMORY_BRIDGE_PORT"]
    ? parseInt(process.env["MEMORY_BRIDGE_PORT"], 10)
    : DEFAULT_PORT;
  startHttpBridge(port)
    .then(async () => {
      const hasTls = await loadBridgeTlsCert();
      const scheme = hasTls ? "https" : "http";
      process.stdout.write(`memory bridge listening on ${scheme}://127.0.0.1:${port}/sse\n`);
    })
    .catch((err) => {
      process.stderr.write(`memory bridge failed to start: ${(err as Error).message}\n`);
      process.exit(1);
    });
}
