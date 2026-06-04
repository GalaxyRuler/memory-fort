import { createServer as createHttpServer, type IncomingHttpHeaders, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runVerify, type VerifyResult, type VerifyRole } from "../cli/commands/verify.js";
import { detectRole } from "../cli/commands/verify/role.js";
import { createSearchRuntimeCache, runSearch } from "../retrieval/search.js";
import { loadSearchCorpus, type SearchScope } from "../retrieval/corpus.js";
import { isEntityWikiPath } from "../retrieval/wiki-paths.js";
import { isIntentLabel, type IntentLabel } from "../retrieval/query-intent.js";
import type { EmbedClient } from "../retrieval/refresh.js";
import {
  createEmbedderFromConfig,
  getActiveEmbedderConfig,
} from "../retrieval/embedder/factory.js";
import { makeVoyageClient, type VoyageClient, type VoyageClientOptions } from "../retrieval/voyage-client.js";
import { loadMemoryConfig, type MemoryConfig } from "../storage/config.js";
import { getVaultWriteCapability, type VaultWriteCapability } from "../sync/vault-capability.js";
import { createLLMFromConfig, getActiveLLMConfig } from "../llm/factory.js";
import type { LLMProvider } from "../llm/types.js";
import { createAutoPromoteScheduler } from "./auto-promote-scheduler.js";
import { runScheduledCompileOnce, type DashboardCompileRunResult } from "./auto-promote-scheduler.js";
import { applyConfigPatch, ConfigPatchError, validateConfigPatch } from "./config-patch.js";
import { buildProvidersCatalog } from "./providers-catalog.js";
import { computeGraphHealth, type GraphHealthReport } from "./graph-health.js";
import {
  listProposedCompile,
  listProposedProcedures,
  listProposedThreads,
  loadProposedSummary,
  parseProposedActionBody,
  promoteProposedDraft,
  rejectProposedDraft,
} from "./proposed.js";
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
  voyageClientFactory?: (opts: VoyageClientOptions) => VoyageClient;
  env?: NodeJS.ProcessEnv;
  embedClient?: EmbedClient | null;
  llmProvider?: LLMProvider | null;
  dashboardDistRoot?: string | null;
  compileRunner?: (opts?: { execute?: boolean }) => Promise<DashboardCompileRunResult>;
  writeCapability?: VaultWriteCapability;
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

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString("utf-8");
  if (text.trim().length === 0) return {};
  return JSON.parse(text) as unknown;
}

export function sameOriginAllowed(
  reqOrigin: string | string[] | undefined,
  requestUrl: URL,
  headers: IncomingHttpHeaders,
  trustedOrigins: string[] = [],
): boolean {
  const origin = normalizeOrigin(firstHeaderValue(reqOrigin));
  if (!origin) return true;

  const normalizedTrusted = trustedOrigins.map(normalizeOrigin).filter((value): value is string => value !== null);
  if (normalizedTrusted.includes(origin)) return true;

  const directOrigin = normalizeOrigin(requestUrl.origin);
  if (directOrigin === origin) return true;

  return effectiveRequestOrigin(requestUrl, headers) === origin;
}

function effectiveRequestOrigin(requestUrl: URL, headers: IncomingHttpHeaders): string | null {
  const forwardedProto = firstCommaValue(headers["x-forwarded-proto"]);
  const forwardedHost = firstCommaValue(headers["x-forwarded-host"]);
  const scheme = (forwardedProto ?? requestUrl.protocol.replace(/:$/, "")).toLowerCase();
  const host = forwardedHost ?? firstHeaderValue(headers.host) ?? requestUrl.host;
  return normalizeOrigin(`${scheme}://${host}`);
}

function firstCommaValue(value: string | string[] | undefined): string | undefined {
  const raw = firstHeaderValue(value);
  return raw?.split(",")[0]?.trim() || undefined;
}

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

function normalizeOrigin(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const parsed = new URL(value.trim().replace(/\/+$/, ""));
    const protocol = parsed.protocol.toLowerCase();
    if (protocol !== "http:" && protocol !== "https:") return null;
    const defaultPort = protocol === "https:" ? "443" : "80";
    const port = parsed.port && parsed.port !== defaultPort ? `:${parsed.port}` : "";
    return `${protocol}//${parsed.hostname.toLowerCase()}${port}`;
  } catch {
    return null;
  }
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

function parseSearchIntent(value: string | null): IntentLabel | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  return isIntentLabel(normalized) ? normalized : undefined;
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
  const env = opts.env ?? process.env;
  const config = await loadMemoryConfig(opts.vaultRoot);
  const voyageClient = opts.voyageClient === undefined
    ? makeConfiguredVoyageClient(config, env, opts.voyageClientFactory ?? makeVoyageClient)
    : opts.voyageClient;
  const embedClient = opts.embedClient ?? await makeConfiguredEmbedClient(
    opts.vaultRoot,
    voyageClient,
    config,
    opts.voyageClient === null,
    env,
  );
  const llmProvider = opts.llmProvider ?? await makeConfiguredLLMProvider(opts.vaultRoot, config, env);
  const staticAssets = await resolveStaticAssetsRoot(opts.dashboardDistRoot);
  const writeCapability = opts.writeCapability ?? await getVaultWriteCapability(opts.vaultRoot);
  const healthCache = new Map<string, HealthCacheEntry>();
  const graphHealthCache = new Map<string, GraphHealthCacheEntry>();
  const searchRuntimeCache = createSearchRuntimeCache();
  const autoPromoteScheduler = await createAutoPromoteScheduler({
    vaultRoot: opts.vaultRoot,
    writeCapability,
  });
  const closeAutoPromoteScheduler = () => autoPromoteScheduler.close();
  let compileRunActive = false;
  process.once("SIGTERM", closeAutoPromoteScheduler);

  const server = createHttpServer(async (req, res) => {
    const method = req.method ?? "GET";
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const path = normalizeDashboardPath(url.pathname);

    if (method === "PATCH" && path === "/api/config") {
      if (!sameOriginAllowed(req.headers.origin, url, req.headers, await loadTrustedDashboardOrigins(opts.vaultRoot))) {
        writeJson(res, { ok: false, error: "cross-origin config updates are not allowed" }, 403);
        return;
      }
      if (!writeCapability.writable) {
        writeJson(res, { ok: false, error: writeCapability.reason }, 403);
        return;
      }
      try {
        const body = await readJsonBody(req);
        const validation = validateConfigPatch(body);
        if (!validation.ok) {
          writeJson(res, { ok: false, errors: validation.errors }, 400);
          return;
        }
        const result = await applyConfigPatch(opts.vaultRoot, body as Record<string, unknown>);
        writeJson(res, { ok: true, applied: result.applied });
      } catch (err) {
        if (err instanceof ConfigPatchError) {
          writeJson(res, { ok: false, errors: err.errors }, 400);
          return;
        }
        writeJson(res, { ok: false, error: (err as Error).message }, 500);
      }
      return;
    }

    if ((method === "POST" && path === "/api/proposed/promote") || (method === "POST" && path === "/api/proposed/reject")) {
      if (!sameOriginAllowed(req.headers.origin, url, req.headers, await loadTrustedDashboardOrigins(opts.vaultRoot))) {
        writeJson(res, { ok: false, error: "cross-origin proposed draft updates are not allowed" }, 403);
        return;
      }
      if (!writeCapability.writable) {
        writeJsonError(res, 403, writeCapability.reason ?? "vault is read-only");
        return;
      }
      try {
        const body = await readJsonBody(req);
        const action = parseProposedActionBody(body);
        if (!action.ok) {
          writeJsonError(res, 400, action.message);
          return;
        }
        if (path.endsWith("/promote")) {
          const result = await promoteProposedDraft(opts.vaultRoot, action.kind, action.slug);
          writeJson(res, { ok: true, promotedPath: result.promotedPath });
        } else {
          const result = await rejectProposedDraft(opts.vaultRoot, action.kind, action.slug);
          writeJson(res, { ok: true, rejectedPath: result.rejectedPath });
        }
      } catch (err) {
        const message = (err as Error).message;
        writeJsonError(res, message.includes("not found") ? 404 : 500, message);
      }
      return;
    }

    if (method === "POST" && path === "/api/compile/run") {
      if (!sameOriginAllowed(req.headers.origin, url, req.headers, await loadTrustedDashboardOrigins(opts.vaultRoot))) {
        writeJsonError(res, 403, "cross-origin compile runs are not allowed");
        return;
      }
      if (compileRunActive) {
        writeJsonError(res, 409, "compile already running");
        return;
      }
      compileRunActive = true;
      try {
        const body = await readJsonBody(req);
        const execute = typeof body === "object" && body !== null && (body as Record<string, unknown>).execute === true;
        if (execute && !writeCapability.writable) {
          writeJsonError(res, 403, writeCapability.reason ?? "vault is read-only");
          return;
        }
        const result = await (opts.compileRunner ?? ((runOpts) => runScheduledCompileOnce(opts.vaultRoot, runOpts)))({ execute });
        writeJson(res, {
          ok: true,
          summary: compileRunSummaryForResponse(result, execute),
        });
      } catch (error) {
        writeJsonError(res, 500, error instanceof Error ? error.message : String(error));
      } finally {
        compileRunActive = false;
      }
      return;
    }

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
        const status = {
          ...await loader(opts.vaultRoot),
          capabilities: writeCapability,
        };
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

      if (segments.length === 2 && segments[0] === "api" && segments[1] === "providers") {
        writeJson(res, buildProvidersCatalog(env));
        return;
      }

      if (segments.length === 3 && segments[0] === "api" && segments[1] === "proposed" && segments[2] === "threads") {
        writeJson(res, await listProposedThreads(opts.vaultRoot));
        return;
      }

      if (segments.length === 3 && segments[0] === "api" && segments[1] === "proposed" && segments[2] === "procedures") {
        writeJson(res, await listProposedProcedures(opts.vaultRoot));
        return;
      }

      if (segments.length === 3 && segments[0] === "api" && segments[1] === "proposed" && segments[2] === "compile") {
        writeJson(res, await listProposedCompile(opts.vaultRoot));
        return;
      }

      if (segments.length === 3 && segments[0] === "api" && segments[1] === "proposed" && segments[2] === "summary") {
        writeJson(res, await loadProposedSummary(opts.vaultRoot));
        return;
      }

      if (segments.length === 3 && segments[0] === "api" && segments[1] === "compile" && segments[2] === "state") {
        const [state, config] = await Promise.all([
          loadCompileState(opts.vaultRoot),
          loadMemoryConfig(opts.vaultRoot),
        ]);
        writeJson(res, {
          ...state,
          schedule: compileScheduleForResponse(config),
          execute: compileExecuteAvailability(config, process.env),
        });
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
        const intent = parseSearchIntent(url.searchParams.get("intent"));
        try {
          const result = await runSearch({
            query,
            scope: parseSearchScope(url.searchParams.get("scope")),
            k: parseClampedInt(url.searchParams.get("k"), 10, 1, 50),
            minScore: parseClampedFloat(url.searchParams.get("minScore"), 0, 0, 1),
            noRerank: noRerank || !voyageClient,
            noHyde: parseSearchBoolean(url.searchParams.get("noHyde")),
            intent,
            hydeExpansion,
            vaultRoot: opts.vaultRoot,
            embedClient,
            voyageClient: voyageClient ?? unavailableVoyageClient,
            llmProvider: intent ? llmProvider : null,
            refreshEmbeddings: false,
            runtimeCache: searchRuntimeCache,
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
    close: async () => {
      process.off("SIGTERM", closeAutoPromoteScheduler);
      autoPromoteScheduler.close();
      await closeServer(server);
    },
  };
}

async function makeConfiguredEmbedClient(
  vaultRoot: string,
  voyageClient: VoyageClient | null,
  config?: MemoryConfig,
  explicitVoyageDisabled = false,
  env: NodeJS.ProcessEnv = process.env,
): Promise<EmbedClient> {
  if (explicitVoyageDisabled) return makeEmbedClient(null);
  try {
    const memoryConfig = config ?? await loadMemoryConfig(vaultRoot);
    const active = getActiveEmbedderConfig(memoryConfig);
    if (active.provider === "voyage" && voyageClient) return makeEmbedClient(voyageClient);
    return createEmbedderFromConfig(active, env);
  } catch {
    return makeEmbedClient(null);
  }
}

function makeConfiguredVoyageClient(
  config: MemoryConfig,
  env: NodeJS.ProcessEnv,
  factory: (opts: VoyageClientOptions) => VoyageClient,
): VoyageClient | null {
  const apiKey = env["VOYAGE_API_KEY"]?.trim();
  if (!apiKey) return null;
  try {
    const active = getActiveEmbedderConfig(config);
    return factory({
      apiKey,
      embedModel: active.provider === "voyage" ? active.model : undefined,
      rerankModel: readOptionalString(asRecord(config.voyage)?.["rerank_model"]),
    });
  } catch {
    return factory({ apiKey });
  }
}

async function loadTrustedDashboardOrigins(vaultRoot: string): Promise<string[]> {
  const config = await loadMemoryConfig(vaultRoot);
  const dashboard = typeof config.dashboard === "object" && config.dashboard !== null
    ? config.dashboard as Record<string, unknown>
    : {};
  const origins = dashboard["trusted_origins"];
  return Array.isArray(origins) ? origins.filter((origin): origin is string => typeof origin === "string") : [];
}

async function makeConfiguredLLMProvider(
  vaultRoot: string,
  config?: MemoryConfig,
  env: NodeJS.ProcessEnv = process.env,
): Promise<LLMProvider | null> {
  try {
    const memoryConfig = config ?? await loadMemoryConfig(vaultRoot);
    return createLLMFromConfig(getActiveLLMConfig(memoryConfig), env);
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

async function loadGraphHealthReport(vaultRoot: string): Promise<GraphHealthReport> {
  const [feed, corpus] = await Promise.all([
    loadGraphFeed(vaultRoot, "all"),
    loadSearchCorpus({ vaultRoot, scope: "wiki" }),
  ]);
  return computeGraphHealth({
    feed,
    wikiPages: corpus.documents.filter((document) => isEntityWikiPath(document.relPath)),
  });
}

function compileScheduleForResponse(config: Awaited<ReturnType<typeof loadMemoryConfig>>): {
  scheduled: boolean;
  cadence: "daily" | "weekly" | "manual";
  nextRunAt: string | null;
} {
  const record = typeof config.compile === "object" && config.compile !== null
    ? config.compile as Record<string, unknown>
    : {};
  const cadence = record["cadence"] === "weekly" || record["cadence"] === "manual"
    ? record["cadence"]
    : "daily";
  const scheduled = record["scheduled"] === true;
  return {
    scheduled,
    cadence,
    nextRunAt: scheduled && cadence !== "manual"
      ? new Date(Date.now() + (cadence === "weekly" ? 7 : 1) * 24 * 60 * 60 * 1000).toISOString()
      : null,
  };
}

function compileRunSummaryForResponse(result: DashboardCompileRunResult, execute: boolean) {
  const execution = result.execution;
  return {
    rawIncluded: result.rawFilesIncluded.length,
    rawSkipped: result.rawFilesSkipped.length,
    rawRemaining: result.rawRemaining,
    opsApplied: execution?.applied.length ?? 0,
    opsStaged: execution?.proposed.length ?? 0,
    opsRejected: execution?.rejected.length ?? 0,
    outcomes: execution?.outcomes ?? [],
    referencesStripped: execution?.referencesStripped ?? 0,
    pagesRewritten: execution?.pagesRewritten ?? 0,
    pagesUpdated: execution?.pagesUpdated ?? 0,
    pagesUnchanged: execution?.pagesUnchanged ?? 0,
    factsExtracted: execution?.factsExtracted ?? 0,
    sessionsScanned: execution?.sessionsScanned ?? 0,
    ...(execution?.extractionTokensUsed ? { extractionTokensUsed: execution.extractionTokensUsed } : {}),
    ...(execution?.rewriteTokensUsed ? { rewriteTokensUsed: execution.rewriteTokensUsed } : {}),
    outputPath: result.outputPath,
    execute,
    ...(execution?.rejected.length ? { error: execution.rejected.map((item) => `${item.path}: ${item.reason}`).join("; ") } : {}),
  };
}

function compileExecuteAvailability(
  config: Awaited<ReturnType<typeof loadMemoryConfig>>,
  env: NodeJS.ProcessEnv,
): { available: boolean; reason: string | null } {
  if (env["MEMORY_LLM_DISABLED"]?.trim().toLowerCase() === "true") {
    return { available: false, reason: "LLM access disabled by MEMORY_LLM_DISABLED=true" };
  }
  try {
    const llmConfig = getActiveLLMConfig(config);
    if (!llmConfig) {
      return { available: false, reason: "No LLM provider configured" };
    }
    createLLMFromConfig(llmConfig, env);
    return { available: true, reason: null };
  } catch (error) {
    return {
      available: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}
