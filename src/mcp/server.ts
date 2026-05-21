#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v3";
import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { wikiDir, type ToolName } from "../storage/paths.js";
import {
  ensureRawSessionFile,
  appendBlock,
  formatObservationBlock,
} from "../hooks/raw-file.js";
import { parseFrontmatter } from "../storage/frontmatter.js";

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
  now?: () => Date;
  sessionId?: () => string;
}

export async function logObservation(
  input: LogObservationInput,
  deps: LogObservationDeps = {},
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const ensureFn = deps.ensureRawSessionFile ?? ensureRawSessionFile;
  const appendFn = deps.appendBlock ?? appendBlock;
  const nowFn = deps.now ?? (() => new Date());
  const sessionFn = deps.sessionId ?? (() => `mcp-${Date.now()}`);

  const tool: ToolName = isToolName(input.source) ? input.source : "manual";
  const sessionId = sessionFn();
  const cwd = process.cwd();
  const now = nowFn();

  await ensureFn({ tool, sessionId, cwd, now });
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
    /^[A-Z]:/.test(input.path)
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
      if (entry.isDirectory()) {
        await scan(full, rel);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
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

export function createServer(): McpServer {
  const server = new McpServer({ name: "memory", version: "0.1.0" });

  server.registerTool(
    "log_observation",
    {
      description:
        "Log a memory observation to today's raw session file. Use for deliberate 'remember this' moments — the LLM decides what's worth recording explicitly, complementing the passive hooks.",
      inputSchema: LogObservationInput.shape,
    },
    async (args) => logObservation(args),
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
