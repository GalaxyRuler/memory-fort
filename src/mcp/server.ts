#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v3";
import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import { memoryRoot, wikiDir, type ToolName } from "../storage/paths.js";
import {
  ensureRawSessionFile,
  appendBlock,
  formatObservationBlock,
} from "../hooks/raw-file.js";
import { parseFrontmatter } from "../storage/frontmatter.js";
import { commitVaultChange as defaultCommitVaultChange } from "../sync/commit-vault-change.js";
import { isWikiDotDirectoryPath } from "../retrieval/wiki-paths.js";

const LogObservationInput = z.object({
  text: z.string().min(1, "text must be non-empty"),
  tags: z.array(z.string()).optional(),
  confidence: z.number().min(0).max(1).optional(),
  source: z.string().optional(),
});

export type LogObservationInput = z.infer<typeof LogObservationInput>;

export interface LogObservationDeps {
  ensureRawSessionFile?: typeof ensureRawSessionFile;
  appendBlock?: typeof appendBlock;
  commitVaultChange?: typeof defaultCommitVaultChange;
  now?: () => Date;
  sessionId?: () => string;
}

export async function logObservation(
  input: LogObservationInput,
  deps: LogObservationDeps = {},
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const ensureFn = deps.ensureRawSessionFile ?? ensureRawSessionFile;
  const appendFn = deps.appendBlock ?? appendBlock;
  const commitFn = deps.commitVaultChange ?? defaultCommitVaultChange;
  const nowFn = deps.now ?? (() => new Date());
  const sessionFn = deps.sessionId ?? (() => `mcp-${Date.now()}`);

  const tool: ToolName = isToolName(input.source) ? input.source : "manual";
  const sessionId = sessionFn();
  const cwd = process.cwd();
  const now = nowFn();
  const root = memoryRoot();

  const rawPath = await ensureFn({ tool, sessionId, cwd, now });
  await appendFn({
    tool,
    sessionId,
    block: formatObservationBlock({
      text: input.text,
      tags: input.tags,
      confidence: input.confidence,
      now,
    }),
    now,
  });
  try {
    await commitFn({
      paths: [relative(root, rawPath).replace(/\\/g, "/")],
      message: `chore: log ${tool} observation`,
      memoryRoot: root,
    });
  } catch {
    // Commit-on-write is best effort; recording the observation must not fail
    // because Git is unavailable or temporarily locked.
  }

  return {
    content: [
      {
        type: "text",
        text: `Logged observation to raw session ${tool}-${sessionId}`,
      },
    ],
  };
}

const ReadPageInput = z.object({
  path: z.string().min(1, "path must be non-empty"),
});

export type ReadPageInput = z.infer<typeof ReadPageInput>;

export interface ReadPageDeps {
  readFile?: typeof readFile;
}

export async function readPage(
  input: ReadPageInput,
  deps: ReadPageDeps = {},
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const readFn = deps.readFile ?? readFile;
  if (
    input.path.includes("..") ||
    input.path.startsWith("/") ||
    /^[A-Z]:/.test(input.path) ||
    isWikiDotDirectoryPath(`wiki/${input.path}`)
  ) {
    return {
      content: [
        {
          type: "text",
          text: `Invalid path: ${input.path} (must be relative under wiki/)`,
        },
      ],
      isError: true,
    };
  }

  const fullPath = join(wikiDir(), input.path);
  if (!existsSync(fullPath)) {
    return {
      content: [{ type: "text", text: `Page not found: ${input.path}` }],
      isError: true,
    };
  }

  const content = await readFn(fullPath, "utf-8");
  const { frontmatter, body } = parseFrontmatter(content);
  return {
    content: [
      {
        type: "text",
        text:
          `# ${frontmatter.title ?? input.path}\n\n` +
          `**Type:** ${frontmatter.type ?? "unknown"}\n` +
          `**Updated:** ${frontmatter.updated ?? "unknown"}\n` +
          (frontmatter.tags
            ? `**Tags:** ${(frontmatter.tags as string[]).join(", ")}\n`
            : "") +
          `\n---\n\n${body.trim()}\n`,
      },
    ],
  };
}

const ListPagesInput = z.object({
  type: z.string().optional(),
  tag: z.string().optional(),
  status: z.string().optional(),
});

export type ListPagesInput = z.infer<typeof ListPagesInput>;

export interface ListPagesDeps {
  readdir?: typeof readdir;
  readFile?: typeof readFile;
}

export async function listPages(
  input: ListPagesInput,
  deps: ListPagesDeps = {},
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const readdirFn = deps.readdir ?? readdir;
  const readFn = deps.readFile ?? readFile;
  const results: Array<{
    path: string;
    title: string;
    type: string;
    updated: string;
    tags: string[];
  }> = [];

  async function scan(dir: string, prefix: string): Promise<void> {
    if (!existsSync(dir)) return;
    const entries = await readdirFn(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(dir, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const wikiRel = `wiki/${rel}`;
      if (entry.isDirectory()) {
        if (isWikiDotDirectoryPath(wikiRel)) continue;
        await scan(full, rel);
      } else if (entry.isFile() && entry.name.endsWith(".md") && !isWikiDotDirectoryPath(wikiRel)) {
        try {
          const content = await readFn(full, "utf-8");
          const { frontmatter } = parseFrontmatter(content);
          const fmType = String(frontmatter.type ?? "");
          const fmStatus = String(frontmatter.status ?? "active");
          const fmTags = Array.isArray(frontmatter.tags)
            ? (frontmatter.tags as string[])
            : [];

          if (input.type && fmType !== input.type) continue;
          if (input.status && fmStatus !== input.status) continue;
          if (input.tag && !fmTags.includes(input.tag)) continue;

          results.push({
            path: rel,
            title: String(frontmatter.title ?? rel),
            type: fmType,
            updated: String(frontmatter.updated ?? ""),
            tags: fmTags,
          });
        } catch {
          // Skip malformed files.
        }
      }
    }
  }

  await scan(wikiDir(), "");

  const lines = results
    .sort((a, b) => b.updated.localeCompare(a.updated))
    .map(
      (r) =>
        `- **${r.path}** [${r.type}] — ${r.title}` +
        `${r.tags.length ? ` _(${r.tags.join(", ")})_` : ""}`,
    )
    .join("\n");

  return {
    content: [
      {
        type: "text",
        text:
          results.length > 0
            ? `Found ${results.length} pages:\n\n${lines}`
            : "No pages match the filters.",
      },
    ],
  };
}

const SearchInput = z.object({
  query: z.string().min(1, "query must be non-empty").describe("The search query"),
  scope: z
    .enum(["wiki", "raw", "crystals", "all"])
    .optional()
    .describe("Search scope (default: all)"),
  k: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .describe("Top-K results (default: 10, max: 50)"),
  min_score: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe("Minimum score filter (0..1, default: 0)"),
  no_rerank: z
    .boolean()
    .optional()
    .describe("Skip Voyage rerank for faster but less accurate results"),
  hyde_expansion: z
    .string()
    .optional()
    .describe(
      "Pre-computed HyDE expansion text — if you previously got a hyde_prompt_pending response, call back with the expanded text here",
    ),
});

export type SearchInput = z.infer<typeof SearchInput>;

export interface SearchDeps extends LogObservationDeps {
  fetchFn?: typeof fetch;
  vpsUrl?: string;
}

interface ApiSearchResult {
  path: string;
  title?: string;
  snippet?: string;
  score?: number;
  source?: string;
  sources?: Array<{ source: string; rank: number }>;
  kind?: "wiki" | "raw" | "crystal";
}

interface ApiSearchResponse {
  query: string;
  results: ApiSearchResult[];
  warnings?: string[];
  timings?: { totalMs?: number; rerankMs?: number };
  degraded?: boolean;
  hyde?: {
    reason?: string;
    promptEmitted?: string;
  };
}

const DEFAULT_SEARCH_BASE_URL = "https://srv1317946.tail6916d8.ts.net/memory";

export async function searchMemory(
  input: SearchInput,
  deps: SearchDeps = {},
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const fetchFn = deps.fetchFn ?? fetch;
  const url = buildSearchUrl(deps.vpsUrl ?? DEFAULT_SEARCH_BASE_URL, input);

  let response: Response;
  try {
    response = await fetchFn(url);
  } catch {
    return toolError(
      "Search backend offline. The MCP server couldn't reach the VPS at " +
        "srv1317946 over Tailscale. Try: (a) confirm Tailscale is connected, " +
        "(b) use memory.read_page or memory.list_pages for offline browsing, " +
        "(c) ask user to verify the VPS is healthy.",
    );
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    return toolError(
      `Search backend returned HTTP ${response.status}: ${truncate(body, 500)}`,
    );
  }

  let body: ApiSearchResponse;
  try {
    body = (await response.json()) as ApiSearchResponse;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return toolError(`Failed to parse search backend JSON: ${message}`);
  }

  return {
    content: [
      {
        type: "text",
        text: formatSearchToolResponse(body),
      },
    ],
  };
}

export function createServer(deps: SearchDeps = {}): McpServer {
  const server = new McpServer({ name: "memory", version: "0.1.0" });

  server.registerTool(
    "log_observation",
    {
      description:
        "Log a memory observation to today's raw session file. Use for deliberate 'remember this' moments — the LLM decides what's worth recording explicitly, complementing the passive hooks.",
      inputSchema: LogObservationInput.shape,
    },
    async (args) => logObservation(args, deps),
  );

  server.registerTool(
    "read_page",
    {
      description:
        "Read a curated wiki page by relative path under wiki/. Returns frontmatter + body. Use for retrieving specific known pages; for discovery use list_pages.",
      inputSchema: ReadPageInput.shape,
    },
    async (args) => readPage(args),
  );

  server.registerTool(
    "list_pages",
    {
      description:
        "List curated wiki pages, optionally filtered by type (projects, people, decisions, lessons, references, tools), tag, or status. Returns each page's path, title, and tags.",
      inputSchema: ListPagesInput.shape,
    },
    async (args) => listPages(args),
  );

  server.registerTool(
    "search",
    {
      description:
        "Search the user's memory system (wiki + raw observations). Uses BM25 + Voyage embeddings + rerank + graph + metadata signals fused via RRF. Returns ranked results with snippets and provenance metadata. If query is short (≤5 words) AND no BM25 hits exist, the response includes a 'hyde_prompt_pending' field with a HyDE prompt the LLM can expand and re-submit via the 'hyde_expansion' parameter for better semantic matches.",
      inputSchema: SearchInput.shape,
    },
    async (args) => searchMemory(args, deps),
  );

  return server;
}

if (process.argv[1]?.endsWith("mcp-server.mjs")) {
  const server = createServer();
  const transport = new StdioServerTransport();
  server.connect(transport).catch((err: unknown) => {
    console.error(`[memory-mcp] fatal: ${(err as Error).message}`);
    process.exit(1);
  });
}

function isToolName(value: unknown): value is ToolName {
  return (
    value === "claude-code" ||
    value === "codex" ||
    value === "antigravity" ||
    value === "manual"
  );
}

function buildSearchUrl(baseUrl: string, input: SearchInput): string {
  const url = new URL(`${trimTrailingSlash(baseUrl)}/api/search`);
  url.searchParams.set("q", input.query);
  if (input.scope !== undefined) url.searchParams.set("scope", input.scope);
  if (input.k !== undefined) url.searchParams.set("k", String(input.k));
  if (input.min_score !== undefined) {
    url.searchParams.set("minScore", String(input.min_score));
  }
  url.searchParams.set("noRerank", String(input.no_rerank ?? true));
  if (input.hyde_expansion !== undefined) {
    url.searchParams.set("hydeExpansion", input.hyde_expansion);
  }
  return url.toString();
}

function formatSearchToolResponse(body: ApiSearchResponse): string {
  const results = (body.results ?? []).filter((item) => !isWikiDotDirectoryPath(item.path));
  const result = {
    query: body.query,
    result_count: results.length,
    degraded: body.degraded === true,
    warnings: body.warnings ?? [],
    results: results.map((item, index) => ({
      rank: index + 1,
      path: item.path,
      title: item.title ?? item.path,
      snippet: item.snippet ?? "",
      score: item.score ?? 0,
      source: item.source ?? "unknown",
      sources: item.sources ?? [],
      kind: item.kind ?? "wiki",
    })),
    ...(body.hyde?.reason === "triggered-pending-expansion" &&
    body.hyde.promptEmitted
      ? {
          hyde_prompt_pending: {
            prompt: body.hyde.promptEmitted,
            instruction:
              "To get better semantic matches, expand this prompt with the LLM, then call memory.search again with hyde_expansion set to your expansion.",
          },
        }
      : {}),
    timings: {
      total_ms: body.timings?.totalMs ?? 0,
      rerank_ms: body.timings?.rerankMs ?? 0,
    },
  };

  const status = result.degraded ? "degraded" : "ok";
  const text =
    `${result.result_count} results for "${result.query}" ` +
    `(${status}, ${result.timings.total_ms}ms total, ${result.timings.rerank_ms}ms rerank):\n` +
    "```json\n" +
    `${JSON.stringify(result, null, 2)}\n` +
    "```";

  if ("hyde_prompt_pending" in result) {
    return `${text}\n\nHyDE prompt pending: expand the prompt, then call memory.search again with hyde_expansion.`;
  }
  return text;
}

function toolError(message: string): {
  content: Array<{ type: "text"; text: string }>;
  isError: true;
} {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
  };
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 3)}...`;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}
