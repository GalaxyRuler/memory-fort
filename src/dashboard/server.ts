import { createServer as createHttpServer, type Server as HttpServer, type ServerResponse } from "node:http";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
  loadDashboardStatus,
  loadLogTail,
  loadPageDetail,
  loadRawIndex,
  loadRawSession,
  loadWikiIndex,
  type DashboardStatus,
} from "./loaders.js";
import {
  renderBadRequest,
  renderHomepage,
  renderLogTail,
  renderNotFound,
  renderRawIndex,
  renderRawSession,
  renderWikiIndex,
  renderWikiPage,
} from "./render.js";

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

const SAFE_SEGMENT_RE = /^[A-Za-z0-9._-]+$/;

function isStrictChild(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel);
}

function parseSafeSegments(pathname: string): string[] | null {
  let decoded = "";
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }

  const segments = decoded.split("/").filter((segment) => segment.length > 0);
  for (const segment of segments) {
    if (segment.includes("..") || segment.includes("\\") || segment.startsWith("/") || !SAFE_SEGMENT_RE.test(segment)) {
      return null;
    }
  }
  return segments;
}

function assertVaultChild(vaultRoot: string, ...parts: string[]): boolean {
  return isStrictChild(vaultRoot, join(vaultRoot, ...parts));
}

function writeHtml(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
  res.end(body);
}

function writeJson(res: ServerResponse, body: unknown): void {
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body, null, 2));
}

function parseLineCount(value: string | null): number {
  if (!value) return 100;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return 100;
  return Math.max(0, Math.min(1000, parsed));
}

export async function createServer(opts: ServerOptions): Promise<RunningServer> {
  const port = opts.port ?? 4410;
  const host = opts.host ?? "127.0.0.1";
  const loader = opts.loader ?? loadDashboardStatus;

  const server = createHttpServer(async (req, res) => {
    const method = req.method ?? "GET";
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const path = url.pathname;

    if (method !== "GET") {
      writeHtml(res, 404, renderNotFound(path));
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
          writeJson(res, status);
        } else {
          writeHtml(res, 200, renderHomepage(status));
        }
      } catch (err) {
        res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
        res.end(`dashboard failed: ${(err as Error).message}`);
      }
      return;
    }

    const segments = parseSafeSegments(path);
    if (!segments) {
      writeHtml(res, 400, renderBadRequest("Malformed dashboard path."));
      return;
    }

    try {
      if (segments.length === 1 && segments[0] === "wiki") {
        writeHtml(res, 200, renderWikiIndex(await loadWikiIndex(opts.vaultRoot)));
        return;
      }

      if (segments.length === 2 && segments[0] === "api" && segments[1] === "wiki") {
        writeJson(res, await loadWikiIndex(opts.vaultRoot));
        return;
      }

      if (segments.length === 3 && segments[0] === "wiki") {
        const relPath = `${segments[1]}/${segments[2]}.md`;
        if (!assertVaultChild(opts.vaultRoot, "wiki", relPath)) {
          writeHtml(res, 400, renderBadRequest("Malformed wiki path."));
          return;
        }
        const page = await loadPageDetail(opts.vaultRoot, relPath);
        if (!page) {
          writeHtml(res, 404, renderNotFound(path));
          return;
        }
        writeHtml(res, 200, renderWikiPage(page));
        return;
      }

      if (segments.length === 4 && segments[0] === "api" && segments[1] === "wiki") {
        const relPath = `${segments[2]}/${segments[3]}.md`;
        if (!assertVaultChild(opts.vaultRoot, "wiki", relPath)) {
          writeHtml(res, 400, renderBadRequest("Malformed wiki path."));
          return;
        }
        const page = await loadPageDetail(opts.vaultRoot, relPath);
        if (!page) {
          writeHtml(res, 404, renderNotFound(path));
          return;
        }
        writeJson(res, page);
        return;
      }

      if (segments.length === 1 && segments[0] === "raw") {
        writeHtml(res, 200, renderRawIndex(await loadRawIndex(opts.vaultRoot)));
        return;
      }

      if (segments.length === 2 && segments[0] === "api" && segments[1] === "raw") {
        writeJson(res, await loadRawIndex(opts.vaultRoot));
        return;
      }

      if (segments.length === 3 && segments[0] === "raw") {
        if (!assertVaultChild(opts.vaultRoot, "raw", segments[1]!, segments[2]!)) {
          writeHtml(res, 400, renderBadRequest("Malformed raw path."));
          return;
        }
        const session = await loadRawSession(opts.vaultRoot, segments[1]!, segments[2]!);
        if (!session) {
          writeHtml(res, 404, renderNotFound(path));
          return;
        }
        writeHtml(res, 200, renderRawSession(session));
        return;
      }

      if (segments.length === 4 && segments[0] === "api" && segments[1] === "raw") {
        if (!assertVaultChild(opts.vaultRoot, "raw", segments[2]!, segments[3]!)) {
          writeHtml(res, 400, renderBadRequest("Malformed raw path."));
          return;
        }
        const session = await loadRawSession(opts.vaultRoot, segments[2]!, segments[3]!);
        if (!session) {
          writeHtml(res, 404, renderNotFound(path));
          return;
        }
        writeJson(res, session);
        return;
      }

      if (segments.length === 1 && segments[0] === "log") {
        writeHtml(res, 200, renderLogTail(await loadLogTail(opts.vaultRoot, parseLineCount(url.searchParams.get("lines")))));
        return;
      }

      if (segments.length === 2 && segments[0] === "api" && segments[1] === "log") {
        writeJson(res, await loadLogTail(opts.vaultRoot, parseLineCount(url.searchParams.get("lines"))));
        return;
      }
    } catch (err) {
      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(`dashboard failed: ${(err as Error).message}`);
      return;
    }

    writeHtml(res, 404, renderNotFound(path));
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
