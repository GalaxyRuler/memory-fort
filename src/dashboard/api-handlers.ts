import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { parseFrontmatter } from "../storage/frontmatter.js";

interface HandlerResult {
  status: number;
  body: Record<string, unknown>;
}

export interface ApiPageMeta {
  path: string;
  title: string;
  type?: string;
  updated?: string;
  status?: string;
}

/**
 * POST /api/observations — log a one-off observation into a raw session
 * file. Extracted from the HTTP server so it is testable with a plain
 * vaultRoot and request body.
 */
export async function handlePostObservation(opts: {
  body: Record<string, unknown>;
  vaultRoot: string;
}): Promise<HandlerResult> {
  const text = opts.body["text"];
  if (!text || typeof text !== "string" || !text.trim()) {
    return { status: 400, body: { error: "missing required field: text" } };
  }
  const { ensureRawSessionFile, appendBlock, formatObservationBlock } = await import(
    "../hooks/raw-file.js"
  );
  const now = new Date();
  const sessionId = `api-${now.getTime()}`;
  await ensureRawSessionFile({
    vaultRoot: opts.vaultRoot,
    tool: "manual",
    sessionId,
    cwd: process.cwd(),
    now,
  });
  const tags = Array.isArray(opts.body["tags"])
    ? (opts.body["tags"] as unknown[]).filter((t): t is string => typeof t === "string")
    : undefined;
  const block = formatObservationBlock({
    text: text.trim(),
    tags,
    confidence:
      typeof opts.body["confidence"] === "number" ? opts.body["confidence"] : undefined,
    now,
  });
  await appendBlock({ vaultRoot: opts.vaultRoot, tool: "manual", sessionId, block, now });
  return { status: 200, body: { ok: true, session: sessionId } };
}

/**
 * GET /api/pages — list wiki page metadata, optionally filtered by type.
 * Walks vaultRoot/wiki, skipping dot-directories and the archive.
 */
export async function handleGetPages(opts: {
  vaultRoot: string;
  type?: string;
}): Promise<HandlerResult> {
  const wikiRoot = join(opts.vaultRoot, "wiki");
  const pages: ApiPageMeta[] = [];

  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.startsWith(".") || entry.name === "archive") continue;
        await walk(full);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        try {
          const content = await readFile(full, "utf-8");
          const parsed = parseFrontmatter(content);
          const relPath = `wiki/${relative(wikiRoot, full).replace(/\\/g, "/")}`;
          pages.push({
            path: relPath,
            title:
              typeof parsed.frontmatter.title === "string"
                ? parsed.frontmatter.title
                : entry.name.replace(/\.md$/, ""),
            type: typeof parsed.frontmatter.type === "string" ? parsed.frontmatter.type : undefined,
            updated:
              typeof parsed.frontmatter.updated === "string"
                ? parsed.frontmatter.updated
                : undefined,
            status:
              typeof parsed.frontmatter.status === "string"
                ? parsed.frontmatter.status
                : undefined,
          });
        } catch {
          // Skip unreadable pages — listing should not fail wholesale.
        }
      }
    }
  }

  await walk(wikiRoot);
  const filtered = opts.type ? pages.filter((p) => p.type === opts.type) : pages;
  filtered.sort((a, b) => a.path.localeCompare(b.path));
  return { status: 200, body: { pages: filtered } };
}
