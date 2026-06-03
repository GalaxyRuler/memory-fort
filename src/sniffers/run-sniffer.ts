import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { atomicWrite } from "../storage/atomic-write.js";
import { redactSecrets } from "../privacy/redaction.js";
import { parseFrontmatter, serializeFrontmatter, type Frontmatter } from "../storage/frontmatter.js";
import { formatIsoDate, memoryRoot } from "../storage/paths.js";
import type { ListOpts, RawSession, Sniffer } from "./types.js";

export interface RunSnifferOptions extends ListOpts {
  root?: string;
}

export interface SnifferSkip {
  relPath: string;
  sessionId: string;
  reason: "duplicate-content" | "unavailable";
}

export interface RunSnifferResult {
  sniffer: string;
  written: string[];
  skipped: SnifferSkip[];
}

interface ExistingRaw {
  relPath: string;
  hash: string;
}

export async function runSniffer(
  sniffer: Sniffer,
  opts: RunSnifferOptions = {},
): Promise<RunSnifferResult> {
  const root = opts.root ?? memoryRoot();
  const result: RunSnifferResult = {
    sniffer: sniffer.name,
    written: [],
    skipped: [],
  };

  if (!(await sniffer.available())) {
    result.skipped.push({ relPath: "", sessionId: "", reason: "unavailable" });
    return result;
  }

  const existing = await loadExistingRaw(root);
  for await (const session of sniffer.list({ since: opts.since, limit: opts.limit })) {
    const hash = normalizedHash(redactSecrets(session.body));
    const duplicate = existing.find((page) => page.hash === hash);
    if (duplicate) {
      result.skipped.push({
        relPath: duplicate.relPath,
        sessionId: session.sessionId,
        reason: "duplicate-content",
      });
      continue;
    }

    const relPath = rawSessionRelPath(session);
    const content = renderRawSession(session, hash);
    await atomicWrite(join(root, ...relPath.split("/")), content);
    existing.push({ relPath, hash });
    result.written.push(relPath);
  }

  return result;
}

export function rawSessionRelPath(session: RawSession): string {
  const startedAt = parseSessionDate(session.startedAt, "startedAt");
  return `raw/${formatIsoDate(startedAt)}/${session.source}-${safeFilename(session.sessionId)}.md`;
}

export function renderRawSession(session: RawSession, hash?: string): string {
  const body = redactSecrets(session.body);
  const captureHash = hash ?? normalizedHash(body);
  const startedAt = parseSessionDate(session.startedAt, "startedAt");
  const updatedAt = parseSessionDate(session.updatedAt, "updatedAt");
  const frontmatter: Frontmatter = {
    type: "raw-session",
    title: `${session.source} session ${session.sessionId}`,
    created: formatIsoDate(startedAt),
    updated: formatIsoDate(updatedAt),
    source: session.source as never,
    session: session.sessionId,
    cwd: session.cwd,
    capture_hash: captureHash,
    imported_from: {
      system: session.source,
      session_id: session.sessionId,
    },
    cognitive_type: "episodic",
  };
  return serializeFrontmatter(frontmatter, body);
}

async function loadExistingRaw(root: string): Promise<ExistingRaw[]> {
  const files = await listMarkdown(join(root, "raw"));
  const existing: ExistingRaw[] = [];
  for (const fullPath of files) {
    const relPath = relative(root, fullPath).replace(/\\/g, "/");
    const raw = await readFile(fullPath, "utf-8");
    try {
      const parsed = parseFrontmatter(raw);
      const frontmatterHash = parsed.frontmatter["capture_hash"];
      existing.push({
        relPath,
        hash: typeof frontmatterHash === "string" ? frontmatterHash : normalizedHash(parsed.body),
      });
    } catch {
      existing.push({ relPath, hash: normalizedHash(raw) });
    }
  }
  return existing;
}

async function listMarkdown(root: string): Promise<string[]> {
  const files: string[] = [];
  async function walk(dir: string): Promise<void> {
    if (!existsSync(dir)) return;
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile() && entry.name.endsWith(".md")) {
        const info = await stat(full);
        if (info.isFile()) files.push(full);
      }
    }
  }
  await walk(root);
  return files.sort();
}

function parseSessionDate(value: string, field: string): Date {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new Error(`sniffer session ${field} is not an ISO timestamp: ${value}`);
  return new Date(ms);
}

function normalizedHash(body: string): string {
  return createHash("sha256")
    .update(body.toLowerCase().replace(/\s+/g, " ").trim())
    .digest("hex");
}

function safeFilename(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 100) || "untitled";
}
