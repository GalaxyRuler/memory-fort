import { createServer as createHttpServer, type Server as HttpServer, type ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runVerify, type VerifyResult, type VerifyRole } from "../cli/commands/verify.js";
import { detectRole } from "../cli/commands/verify/role.js";
import { runSearch } from "../retrieval/search.js";
import { loadSearchCorpus, type SearchScope } from "../retrieval/corpus.js";
import type { EmbedClient } from "../retrieval/refresh.js";
import type { VoyageClient } from "../retrieval/voyage-client.js";
import { computeGraphHealth, type GraphHealthReport } from "./graph-health.js";
import {
  loadActivityEvents,
  loadCompileState,
  loadConflicts,
  loadCheckoutSyncState,
  loadDashboardStatus,
  loadGraphFeed,
  loadLogTail,
  loadMaintenanceScan,
  loadPageDetail,
  loadRedactedConfig,
  loadRawIndex,
  loadRawSession,
  loadRawSessionDetail,
  loadTimelineFeed,
  loadWikiIndex,
  type DashboardStatus,
  type TimelineZoom,
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

export { makeVoyageClient } from "../retrieval/voyage-client.js";

export interface ServerOptions {
  vaultRoot: string;
  port?: number;
  host?: string;
  loader?: (vaultRoot: string) => Promise<DashboardStatus>;
  verifyRunner?: (opts: { includeSearch: boolean; role: VerifyRole; vaultRoot: string }) => Promise<VerifyResult>;
  voyageClient?: VoyageClient | null;
  dashboardDistRoot?: string | null;
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
const DASHBOARD_MOUNT_PREFIX = "/memory";

interface StaticAssetsRoot {
  root: string;
  indexPath: string;
}

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".png": "image/png",
  ".map": "application/json; charset=utf-8",
};

type StaticServeResult = "served" | "miss" | "bad-request";

function isStrictChild(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel);
}

function isInsideOrSame(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

async function fileExists(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    return info.isFile();
  } catch {
    return false;
  }
}

function defaultDashboardDistRoot(): string | null {
  const serverPath = fileURLToPath(import.meta.url).replace(/\\/g, "/");
  if (!serverPath.includes("/dist/dashboard/")) return null;
  return fileURLToPath(new URL("../dashboard-ui/", import.meta.url));
}

async function resolveStaticAssetsRoot(input: string | null | undefined): Promise<StaticAssetsRoot | null> {
  if (input === null) return null;

  const configuredRoot = input ?? process.env["MEMORY_DASHBOARD_DIST"] ?? defaultDashboardDistRoot();
  if (!configuredRoot) return null;

  const root = resolve(configuredRoot);
  const indexPath = join(root, "index.html");
  const hasIndex = await fileExists(indexPath);

  if (!hasIndex) {
    throw new Error(`dashboard UI dist missing index.html at ${indexPath}; run npm run build:ui`);
  }

  return { root, indexPath };
}

function normalizeDashboardPath(pathname: string): string {
  if (pathname === DASHBOARD_MOUNT_PREFIX) return "/";
  if (pathname.startsWith(`${DASHBOARD_MOUNT_PREFIX}/`)) return pathname.slice(DASHBOARD_MOUNT_PREFIX.length);
  return pathname;
}

function contentTypeForPath(path: string): string {
  return MIME_TYPES[extname(path)] ?? "application/octet-stream";
}

async function writeStaticFile(
  res: ServerResponse,
  filePath: string,
  cacheControl: string,
): Promise<void> {
  const body = await readFile(filePath);
  res.writeHead(200, {
    "Content-Type": contentTypeForPath(filePath),
    "Cache-Control": cacheControl,
  });
  res.end(body);
}

async function serveStaticAssetIfFound(
  res: ServerResponse,
  assets: StaticAssetsRoot | null,
  segments: string[],
): Promise<StaticServeResult> {
  if (!assets) return "miss";
  if (segments.length === 0) {
    await writeStaticFile(res, assets.indexPath, "no-cache");
    return "served";
  }

  const candidate = join(assets.root, ...segments);
  if (!isInsideOrSame(assets.root, candidate)) return "bad-request";
  if (!(await fileExists(candidate))) return "miss";

  const isImmutableAsset = segments[0] === "assets";
  await writeStaticFile(
    res,
    candidate,
    isImmutableAsset ? "public, max-age=31536000, immutable" : "no-cache",
  );
  return "served";
}

async function serveSpaHistoryFallback(res: ServerResponse, assets: StaticAssetsRoot): Promise<void> {
  await writeStaticFile(res, assets.indexPath, "no-cache");
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

function writeJson(res: ServerResponse, body: unknown, status = 200): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body, null, 2));
}

function writeJsonError(res: ServerResponse, status: number, message: string): void {
  writeJson(res, { error: message }, status);
}

function parseLineCount(value: string | null): number {
  if (!value) return 100;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return 100;
  return Math.max(0, Math.min(1000, parsed));
}

const SEARCH_SCOPES = new Set<SearchScope>(["wiki", "raw", "crystals", "all"]);
const HEALTH_CACHE_MS = 25_000;

interface HealthCacheEntry {
  atMs: number;
  report: VerifyResult;
}

interface GraphHealthCacheEntry {
  atMs: number;
  report: GraphHealthReport;
}

function parseSearchBoolean(value: string | null): boolean {
  return value === "true";
}

function parseClampedInt(value: string | null, fallback: number, min: number, max: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function parseClampedFloat(value: string | null, fallback: number, min: number, max: number): number {
  if (!value) return fallback;
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function parseSearchScope(value: string | null): SearchScope {
  return value && SEARCH_SCOPES.has(value as SearchScope) ? (value as SearchScope) : "all";
}

function parseGraphScope(value: string | null): SearchScope | null {
  if (!value) return "wiki";
  return SEARCH_SCOPES.has(value as SearchScope) ? (value as SearchScope) : null;
}

function parseHealthRole(value: string | null): VerifyRole | null {
  if (!value) return detectRole();
  return value === "operator" || value === "server" ? value : null;
}

const TIMELINE_ZOOMS = new Set<TimelineZoom>(["1H", "1D", "1W", "1M", "1Y"]);

function parseTimelineZoom(value: string | null): TimelineZoom | null {
  if (!value) return "1D";
  return TIMELINE_ZOOMS.has(value as TimelineZoom) ? (value as TimelineZoom) : null;
}

function parseIsoDate(value: string | null): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function makeEmbedClient(voyageClient: VoyageClient | null | undefined): EmbedClient {
  if (!voyageClient) {
    return {
      embed: async () => {
        throw new Error("voyage unavailable");
      },
    };
  }

  return {
    embed: async (
      texts: string[],
      embedOpts?: { inputType?: "document" | "query"; signal?: AbortSignal },
    ) => {
      const response = await voyageClient.embed(texts, {
        inputType: embedOpts?.inputType ?? "document",
        signal: embedOpts?.signal,
      });
      return { vectors: response.vectors, model: response.model, dim: response.dim };
    },
  } as EmbedClient;
}

const unavailableVoyageClient: VoyageClient = {
  embed: async () => {
    throw new Error("voyage unavailable");
  },
  rerank: async () => {
    throw new Error("voyage unavailable");
  },
};

export async function createServer(opts: ServerOptions): Promise<RunningServer> {
  const port = opts.port ?? 4410;
  const host = opts.host ?? "127.0.0.1";
  const loader = opts.loader ?? loadDashboardStatus;
  const verifyRunner = opts.verifyRunner ?? ((runnerOpts) =>
    runVerify({
      offline: false,
      includeSearch: runnerOpts.includeSearch,
      role: runnerOpts.role,
      vaultRoot: runnerOpts.vaultRoot,
    }));
  const voyageClient = opts.voyageClient ?? null;
  const embedClient = makeEmbedClient(voyageClient);
  const staticAssets = await resolveStaticAssetsRoot(opts.dashboardDistRoot);
  const healthCache = new Map<string, HealthCacheEntry>();
  const graphHealthCache = new Map<string, GraphHealthCacheEntry>();

  const server = createHttpServer(async (req, res) => {
    const method = req.method ?? "GET";
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const path = normalizeDashboardPath(url.pathname);

    if (method !== "GET") {
      if (path.startsWith("/api/")) {
        writeJsonError(res, 405, "method not allowed");
      } else {
        res.writeHead(405, {
          "Content-Type": "text/plain; charset=utf-8",
          "Allow": "GET",
        });
        res.end("method not allowed");
      }
      return;
    }

    if (path === "/healthz") {
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("ok");
      return;
    }

    if (path === "/api/status" || (path === "/" && !staticAssets)) {
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

    if (path === "/api/health") {
      try {
        const includeSearch = url.searchParams.get("deep") === "true";
        const role = parseHealthRole(url.searchParams.get("role"));
        if (!role) {
          writeJsonError(res, 400, "invalid role; expected operator or server");
          return;
        }
        const cacheKey = `${role}:${includeSearch ? "deep" : "shallow"}`;
        const cached = healthCache.get(cacheKey);
        const nowMs = Date.now();
        const report = cached && nowMs - cached.atMs < HEALTH_CACHE_MS
          ? cached.report
          : await verifyRunner({ includeSearch, role, vaultRoot: opts.vaultRoot });
        if (!cached || nowMs - cached.atMs >= HEALTH_CACHE_MS) {
          healthCache.set(cacheKey, { atMs: nowMs, report });
        }
        writeJson(res, report, report.overallStatus === "fail" ? 503 : 200);
      } catch (err) {
        writeJsonError(res, 500, (err as Error).message);
      }
      return;
    }

    const segments = parseSafeSegments(path);
    if (!segments) {
      if (path.startsWith("/api/")) {
        writeJsonError(res, 400, "malformed dashboard path");
      } else {
        writeHtml(res, 400, renderBadRequest("Malformed dashboard path."));
      }
      return;
    }

    try {
      if (segments.length >= 3 && segments[0] === "api" && segments[1] === "page") {
        const relPath = segments.slice(2).join("/");
        if (!relPath.startsWith("wiki/") || !relPath.endsWith(".md") || !assertVaultChild(opts.vaultRoot, ...segments.slice(2))) {
          writeJsonError(res, 400, "malformed page path");
          return;
        }
        const page = await loadPageDetail(opts.vaultRoot, relPath.slice("wiki/".length));
        if (!page) {
          writeJsonError(res, 404, "page not found");
          return;
        }
        writeJson(res, { ...page, relPath });
        return;
      }

      if (segments.length === 2 && segments[0] === "api" && segments[1] === "activity") {
        writeJson(res, await loadActivityEvents(opts.vaultRoot, {
          cursor: url.searchParams.get("cursor"),
          limit: parseClampedInt(url.searchParams.get("limit"), 50, 1, 200),
        }));
        return;
      }

      if (segments.length === 2 && segments[0] === "api" && segments[1] === "timeline") {
        const zoom = parseTimelineZoom(url.searchParams.get("zoom"));
        if (!zoom) {
          writeJsonError(res, 400, "invalid timeline zoom");
          return;
        }
        const to = parseIsoDate(url.searchParams.get("to")) ?? new Date();
        const from = parseIsoDate(url.searchParams.get("from")) ?? new Date(to.getTime() - 24 * 60 * 60 * 1000);
        if (from.getTime() > to.getTime()) {
          writeJsonError(res, 400, "timeline from must be before to");
          return;
        }
        writeJson(res, await loadTimelineFeed(opts.vaultRoot, { from, to, zoom }));
        return;
      }

      if (segments.length === 2 && segments[0] === "api" && segments[1] === "graph") {
        const scope = parseGraphScope(url.searchParams.get("scope"));
        if (!scope) {
          writeJsonError(res, 400, "invalid graph scope");
          return;
        }
        writeJson(res, await loadGraphFeed(opts.vaultRoot, scope));
        return;
      }

      if (segments.length === 2 && segments[0] === "api" && segments[1] === "graph-health") {
        const cacheKey = "all";
        const cached = graphHealthCache.get(cacheKey);
        const nowMs = Date.now();
        const report = cached && nowMs - cached.atMs < HEALTH_CACHE_MS
          ? cached.report
          : await loadGraphHealthReport(opts.vaultRoot);
        if (!cached || nowMs - cached.atMs >= HEALTH_CACHE_MS) {
          graphHealthCache.set(cacheKey, { atMs: nowMs, report });
        }
        writeJson(res, report, report.overallStatus === "fail" ? 503 : 200);
        return;
      }

      if (segments.length === 2 && segments[0] === "api" && segments[1] === "sync-state") {
        writeJson(res, await loadCheckoutSyncState(opts.vaultRoot));
        return;
      }

      if (segments.length === 2 && segments[0] === "api" && segments[1] === "config") {
        writeJson(res, await loadRedactedConfig(opts.vaultRoot));
        return;
      }

      if (segments.length === 3 && segments[0] === "api" && segments[1] === "compile" && segments[2] === "state") {
        writeJson(res, await loadCompileState(opts.vaultRoot));
        return;
      }

      if (segments.length === 2 && segments[0] === "api" && segments[1] === "conflicts") {
        writeJson(res, await loadConflicts(opts.vaultRoot));
        return;
      }

      if (
        segments.length === 3 &&
        segments[0] === "api" &&
        segments[1] === "maintenance" &&
        segments[2] === "scan"
      ) {
        writeJson(res, await loadMaintenanceScan(opts.vaultRoot));
        return;
      }

      if (staticAssets && !path.startsWith("/api/")) {
        const staticResult = await serveStaticAssetIfFound(res, staticAssets, segments);
        if (staticResult === "served") return;
        if (staticResult === "bad-request") {
          writeHtml(res, 400, renderBadRequest("Malformed dashboard path."));
          return;
        }
        await serveSpaHistoryFallback(res, staticAssets);
        return;
      }

      if (segments.length === 1 && segments[0] === "wiki") {
        writeHtml(res, 200, renderWikiIndex(await loadWikiIndex(opts.vaultRoot)));
        return;
      }

      if (segments.length === 2 && segments[0] === "api" && segments[1] === "wiki") {
        writeJson(res, await loadWikiIndex(opts.vaultRoot));
        return;
      }

      if (segments.length === 2 && segments[0] === "api" && segments[1] === "search") {
        const query = url.searchParams.get("q")?.trim() ?? "";
        if (query.length === 0) {
          writeJson(res, { error: "missing query parameter q" }, 400);
          return;
        }
        const noRerank = parseSearchBoolean(url.searchParams.get("noRerank"));
        const hydeExpansion = url.searchParams.get("hydeExpansion") ?? undefined;
        try {
          const result = await runSearch({
            query,
            scope: parseSearchScope(url.searchParams.get("scope")),
            k: parseClampedInt(url.searchParams.get("k"), 10, 1, 50),
            minScore: parseClampedFloat(url.searchParams.get("minScore"), 0, 0, 1),
            noRerank: noRerank || !voyageClient,
            noHyde: parseSearchBoolean(url.searchParams.get("noHyde")),
            hydeExpansion,
            vaultRoot: opts.vaultRoot,
            embedClient,
            voyageClient: voyageClient ?? unavailableVoyageClient,
          });
          writeJson(res, result);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
          res.end(JSON.stringify({ error: message }));
        }
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
          writeJsonError(res, 400, "malformed raw path");
          return;
        }
        const session = await loadRawSessionDetail(opts.vaultRoot, segments[2]!, segments[3]!);
        if (!session) {
          writeJsonError(res, 404, "session not found");
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
      if (path.startsWith("/api/")) {
        writeJsonError(res, 500, (err as Error).message);
      } else {
        res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
        res.end(`dashboard failed: ${(err as Error).message}`);
      }
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

async function loadGraphHealthReport(vaultRoot: string): Promise<GraphHealthReport> {
  const [feed, corpus] = await Promise.all([
    loadGraphFeed(vaultRoot, "all"),
    loadSearchCorpus({ vaultRoot, scope: "wiki" }),
  ]);
  return computeGraphHealth({ feed, wikiPages: corpus.documents });
}
