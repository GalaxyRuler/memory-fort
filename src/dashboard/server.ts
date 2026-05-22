import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { loadDashboardStatus, type DashboardStatus } from "./loaders.js";
import { renderHomepage, renderNotFound } from "./render.js";

export interface ServerOptions {
  vaultRoot: string;
  port?: number;
  host?: string;
  loader?: (vaultRoot: string) => Promise<DashboardStatus>;
}

export interface RunningServer {
  port: number;
  host: string;
  close(): Promise<void>;
}

function closeServer(server: HttpServer): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

export async function createServer(opts: ServerOptions): Promise<RunningServer> {
  const port = opts.port ?? 4410;
  const host = opts.host ?? "127.0.0.1";
  const loader = opts.loader ?? loadDashboardStatus;

  const server = createHttpServer(async (req, res) => {
    const method = req.method ?? "GET";
    const path = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`).pathname;

    if (method !== "GET") {
      res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
      res.end(renderNotFound(path));
      return;
    }

    if (path === "/healthz") {
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("ok");
      return;
    }

    if (path === "/" || path === "/api/status") {
      try {
        const status = await loader(opts.vaultRoot);
        if (path === "/api/status") {
          res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify(status, null, 2));
        } else {
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(renderHomepage(status));
        }
      } catch (err) {
        res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
        res.end(`dashboard failed: ${(err as Error).message}`);
      }
      return;
    }

    res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
    res.end(renderNotFound(path));
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;

  return {
    port: actualPort,
    host,
    close: () => closeServer(server),
  };
}
