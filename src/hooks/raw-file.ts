import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { TextDecoder } from "node:util";
import { captureSpoolDir, rawSessionFile } from "../storage/paths.js";
import { redactSecrets } from "../privacy/redaction.js";
import { atomicAppend, atomicCreate, atomicWrite } from "../storage/atomic-write.js";
import { FileLockTimeoutError, withFileLock } from "../storage/file-lock.js";
import {
  parseFrontmatter,
  serializeFrontmatter,
  type Frontmatter,
} from "../storage/frontmatter.js";
import type { ToolName } from "../storage/paths.js";

/** Shared lock options for raw session writers (append + frontmatter RMW). */
const RAW_FILE_LOCK = { timeoutMs: 15_000, staleMs: 60_000 } as const;
const CAPTURE_EVENT_MARKER = "memory-fort-capture";

interface CaptureEvent { version: 1; id: string; hash: string; rawPath: string; block: string; createdAt: string; }
export interface CaptureSpooledDiagnostic { type: "capture_spooled"; eventId: string; hash: string; createdAt: string; }
export interface CaptureSpoolStatus { pendingEventCount: number; oldestPendingAgeMs: number | null; drainFailures: number; captureSpooled: CaptureSpooledDiagnostic[]; }
const captureSpoolRuntime = { drainFailures: 0 };

export async function getCaptureSpoolStatus(now = new Date()): Promise<CaptureSpoolStatus> {
  const events = await readCaptureSpoolEvents();
  const oldestPendingAgeMs = events.reduce<number | null>((oldest, event) => {
    const age = Math.max(0, now.getTime() - Date.parse(event.createdAt));
    return oldest === null || age > oldest ? age : oldest;
  }, null);
  return { pendingEventCount: events.length, oldestPendingAgeMs, drainFailures: captureSpoolRuntime.drainFailures,
    captureSpooled: events.map((event) => ({ type: "capture_spooled", eventId: event.id, hash: event.hash, createdAt: event.createdAt })) };
}

/**
 * Serialize multi-process access to a raw session file.
 * Use for appends and any full-file rewrite so concurrent hooks cannot
 * interleave or clobber each other.
 */
export async function withRawFileLock<T>(
  absolutePath: string,
  operation: () => Promise<T>,
): Promise<T> {
  return withFileLock(absolutePath, operation, RAW_FILE_LOCK);
}

/**
 * Format HH:MM:SS in UTC (matches the YYYY-MM-DD UTC convention
 * in paths.ts → no TZ drift across machines).
 */
export function formatTimestamp(now: Date): string {
  const h = String(now.getUTCHours()).padStart(2, "0");
  const m = String(now.getUTCMinutes()).padStart(2, "0");
  const s = String(now.getUTCSeconds()).padStart(2, "0");
  return `${h}:${m}:${s}`;
}

/**
 * Truncate text to at most `maxBytes` UTF-8 bytes. If truncated,
 * appends a `… [truncated to N bytes]` marker so consumers know
 * data was lost.
 */
export function truncate(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, "utf-8");
  if (buf.byteLength <= maxBytes) return text;
  // Truncate on a UTF-8 boundary — slice to maxBytes, then trim
  // back to the last whole codepoint by decoding.
  const slice = buf.subarray(0, maxBytes).toString("utf-8");
  return `${slice}\n\n… [truncated to ${maxBytes} bytes]`;
}

export function truncateMiddle(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, "utf-8");
  if (buf.byteLength <= maxBytes) return text;
  if (maxBytes <= 0) return "";

  let marker = "\n\n… [bytes elided] …\n\n";
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const markerBytes = Buffer.byteLength(marker, "utf-8");
    if (markerBytes >= maxBytes) return sliceUtf8Prefix(marker, maxBytes);
    const payloadBudget = maxBytes - markerBytes;
    const headBudget = Math.floor(payloadBudget * 0.4);
    const tailBudget = payloadBudget - headBudget;
    const head = sliceUtf8Head(buf, headBudget);
    const tail = sliceUtf8Tail(buf, tailBudget);
    const elided = Math.max(0, buf.byteLength - Buffer.byteLength(head, "utf-8") - Buffer.byteLength(tail, "utf-8"));
    const nextMarker = `\n\n… [${elided} bytes elided] …\n\n`;
    const candidate = `${head}${nextMarker}${tail}`;
    if (Buffer.byteLength(candidate, "utf-8") <= maxBytes) return candidate;
    marker = nextMarker;
  }

  const markerBytes = Buffer.byteLength(marker, "utf-8");
  const payloadBudget = Math.max(0, maxBytes - markerBytes);
  const head = sliceUtf8Head(buf, Math.floor(payloadBudget * 0.4));
  const tail = sliceUtf8Tail(buf, payloadBudget - Buffer.byteLength(head, "utf-8"));
  return `${head}${marker}${tail}`;
}

/**
 * The block formatters all produce markdown that gets appended to
 * a session file. They start with `## [HH:MM:SS] <Label>` so the
 * compile pass (Phase 2) can detect thread boundaries.
 */

export function formatPromptBlock(prompt: string, now: Date): string {
  const ts = formatTimestamp(now);
  return `\n## [${ts}] Prompt\n\n${redactSecrets(prompt.trim())}\n`;
}

export function formatToolUseBlock(input: {
  toolName: string;
  toolInput: unknown;
  toolOutput: unknown;
  now: Date;
  maxInputBytes?: number;
  maxOutputBytes?: number;
}): string {
  const ts = formatTimestamp(input.now);
  const maxInput = input.maxInputBytes ?? 8192;
  const maxOutput = input.maxOutputBytes ?? 8192;
  const inJson = safeJsonStringify(input.toolInput);
  const outString =
    typeof input.toolOutput === "string"
      ? input.toolOutput
      : safeJsonStringify(input.toolOutput);
  const truncatedInput = truncateMiddle(redactSecrets(inJson), maxInput);
  const truncatedOutput = truncateMiddle(redactSecrets(outString), maxOutput);
  return (
    `\n## [${ts}] ToolUse: ${input.toolName}\n\n` +
    `**Input:**\n\n\`\`\`json\n${truncatedInput}\n\`\`\`\n\n` +
    `**Output:**\n\n\`\`\`\n${truncatedOutput}\n\`\`\`\n`
  );
}

const SUMMARY_MAX_OUTPUT_BYTES = 512;

function truncateSuffix(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf-8") <= maxBytes) return text;
  const buf = Buffer.from(text, "utf-8");
  return buf.subarray(0, maxBytes).toString("utf-8") + "\n... [truncated]";
}

export function formatSummaryBlock(input: {
  toolName: string;
  toolInput: unknown;
  toolOutput: unknown;
  now: Date;
  maxInputBytes?: number;
}): string {
  const ts = formatTimestamp(input.now);
  const maxInput = input.maxInputBytes ?? 8192;
  const inJson = safeJsonStringify(input.toolInput);
  const outString =
    typeof input.toolOutput === "string"
      ? input.toolOutput
      : safeJsonStringify(input.toolOutput);
  const truncatedInput = truncateMiddle(redactSecrets(inJson), maxInput);
  const truncatedOutput = truncateSuffix(redactSecrets(outString), SUMMARY_MAX_OUTPUT_BYTES);
  return (
    `\n## [${ts}] ToolUse: ${input.toolName} (summary)\n\n` +
    `**Input:**\n\n\`\`\`json\n${truncatedInput}\n\`\`\`\n\n` +
    `**Output (truncated):**\n\n\`\`\`\n${truncatedOutput}\n\`\`\`\n`
  );
}

export function formatMetadataBlock(input: {
  toolName: string;
  toolInput: unknown;
  now: Date;
  maxInputBytes?: number;
}): string {
  const ts = formatTimestamp(input.now);
  const maxInput = input.maxInputBytes ?? 8192;
  const inJson = safeJsonStringify(input.toolInput);
  const truncatedInput = truncateMiddle(redactSecrets(inJson), maxInput);
  return (
    `\n## [${ts}] ToolUse: ${input.toolName} (metadata)\n\n` +
    `**Input:**\n\n\`\`\`json\n${truncatedInput}\n\`\`\`\n`
  );
}

export function formatMarker(label: string, now: Date): string {
  const ts = formatTimestamp(now);
  return `\n---\n## [${ts}] ${label}\n\n`;
}

export function formatObservationBlock(input: {
  text: string;
  tags?: string[];
  confidence?: number;
  now: Date;
}): string {
  const ts = formatTimestamp(input.now);
  const meta = [
    input.tags && input.tags.length > 0 ? `tags: ${input.tags.join(", ")}` : null,
    input.confidence !== undefined ? `confidence: ${input.confidence}` : null,
    `observed_at: ${input.now.toISOString()}`,
  ].filter(Boolean);
  const metaLine = meta.length > 0 ? `_${meta.join(" · ")}_\n\n` : "";
  return `\n## [${ts}] Observation\n\n${metaLine}${redactSecrets(input.text)}\n`;
}

// Identity values come from env vars — validate before stamping into
// frontmatter so a malformed value can't corrupt YAML or smuggle newlines.
const IDENTITY_PATTERN = /^[A-Za-z0-9._@-]{1,128}$/;

function cleanIdentity(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (!IDENTITY_PATTERN.test(value)) return undefined;
  return value;
}

/**
 * Ensure the raw session file exists with proper frontmatter.
 * If the file exists, this is a no-op. If absent, atomically
 * writes the frontmatter header.
 *
 * Returns the absolute path of the session file.
 */
export async function ensureRawSessionFile(input: {
  tool: ToolName;
  sessionId: string;
  cwd: string;
  now?: Date;
  vaultRoot?: string;
  exists?: (path: string) => Promise<boolean>;
  write?: (path: string, content: string) => Promise<void>;
}): Promise<string> {
  const now = input.now ?? new Date();
  const path = rawSessionFile(input.tool, input.sessionId, now, input.vaultRoot);
  const existsFn = input.exists ?? defaultExists;
  const writeFn = input.write ?? atomicWrite;
  if (await existsFn(path)) return path;
  const agentId = cleanIdentity(process.env["MEMORY_FORT_AGENT_ID"]);
  const userId = cleanIdentity(process.env["MEMORY_FORT_USER_ID"]);
  const fm: Frontmatter = {
    type: "raw-session",
    title: `${input.tool} session ${input.sessionId}`,
    created: isoDate(now),
    updated: isoDate(now),
    source: input.tool,
    session: input.sessionId,
    // Custom field — tracking working directory the session ran in
    cwd: input.cwd,
    ...(agentId ? { agent_id: agentId } : {}),
    ...(userId ? { user_id: userId } : {}),
  };
  const header = serializeFrontmatter(fm, "").replace(
    `session: ${input.sessionId}\n`,
    `session: "${input.sessionId}"\n`,
  );
  // Custom write/exists deps (tests) skip the lock; production path serializes create.
  if (input.exists !== undefined || input.write !== undefined) {
    await writeFn(path, header);
    return path;
  }
  await withRawFileLock(path, async () => {
    if (await defaultExists(path)) return;
    await writeFn(path, header);
  });
  return path;
}

/**
 * Append a pre-formatted block to a session file. Caller is
 * responsible for calling ensureRawSessionFile first (or
 * accepting the cheap cost of doing it again — append creates
 * the file if missing, but without frontmatter that's a defect).
 *
 * Production appends take a per-file lock so concurrent auto-link /
 * consolidate frontmatter rewrites cannot erase mid-session appends.
 */
export async function appendBlock(input: {
  tool: ToolName;
  sessionId: string;
  block: string;
  now?: Date;
  vaultRoot?: string;
  append?: (path: string, content: string) => Promise<void>;
}): Promise<void> {
  const now = input.now ?? new Date();
  const path = rawSessionFile(input.tool, input.sessionId, now, input.vaultRoot);
  const appendFn = input.append ?? atomicAppend;
  if (input.append !== undefined) {
    await appendFn(path, renderCaptureEvent(createCaptureEvent(path, input.block, now)));
    return;
  }
  const event = createCaptureEvent(path, input.block, now);
  await drainCaptureSpool();
  try {
    await withRawFileLock(path, async () => {
      await appendFn(path, renderCaptureEvent(event));
    });
  } catch (err) {
    if (err instanceof FileLockTimeoutError) {
      await spoolCaptureEvent(event);
      return;
    }
    throw err;
  }
}

function createCaptureEvent(rawPath: string, block: string, now: Date): CaptureEvent {
  return { version: 1, id: randomUUID(), hash: createHash("sha256").update(block, "utf-8").digest("hex"), rawPath, block, createdAt: now.toISOString() };
}
function renderCaptureEvent(event: CaptureEvent): string {
  return `${event.block}\n<!-- ${CAPTURE_EVENT_MARKER} id=${event.id} hash=${event.hash} -->\n`;
}
function marker(event: CaptureEvent): string { return `${CAPTURE_EVENT_MARKER} id=${event.id}`; }
async function spoolCaptureEvent(event: CaptureEvent): Promise<void> {
  await atomicCreate(join(captureSpoolDir(), `${event.id}.json`), `${JSON.stringify(event)}\n`);
}
async function drainCaptureSpool(): Promise<void> {
  for (const entry of await readCaptureSpoolEntries()) {
    try {
      await withRawFileLock(entry.event.rawPath, async () => {
        let existing = "";
        try { existing = await readFile(entry.event.rawPath, "utf-8"); }
        catch (error) { if (!isCode(error, "ENOENT")) throw error; }
        if (!existing.includes(marker(entry.event))) await atomicAppend(entry.event.rawPath, renderCaptureEvent(entry.event));
        await unlink(entry.path);
      });
    } catch { captureSpoolRuntime.drainFailures += 1; }
  }
}
async function readCaptureSpoolEvents(): Promise<CaptureEvent[]> {
  return (await readCaptureSpoolEntries()).map((entry) => entry.event);
}
async function readCaptureSpoolEntries(): Promise<Array<{ path: string; event: CaptureEvent }>> {
  let names: string[];
  try { names = await readdir(captureSpoolDir()); }
  catch (error) { if (isCode(error, "ENOENT")) return []; throw error; }
  const entries: Array<{ path: string; event: CaptureEvent }> = [];
  for (const name of names.filter((candidate) => candidate.endsWith(".json")).sort()) {
    try {
      const path = join(captureSpoolDir(), name);
      const event = JSON.parse(await readFile(path, "utf-8")) as CaptureEvent;
      if (event.version === 1 && typeof event.id === "string" && typeof event.hash === "string" && typeof event.rawPath === "string" && typeof event.block === "string" && typeof event.createdAt === "string") entries.push({ path, event });
    } catch { captureSpoolRuntime.drainFailures += 1; }
  }
  return entries;
}
function isCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code;
}

export type MutateRawFrontmatterResult = "updated" | "skipped" | "missing";

/**
 * Read-modify-write raw markdown frontmatter under the session lock.
 *
 * Always re-reads under the lock and preserves the **latest body** so
 * concurrent appends that landed after a match/scan are not erased when
 * only frontmatter (e.g. relations) is being updated.
 *
 * `update` receives the latest frontmatter + body. Return `null` to skip
 * the write (e.g. relations already present).
 */
export async function mutateRawFrontmatter(
  absolutePath: string,
  update: (frontmatter: Frontmatter, body: string) => Frontmatter | null,
): Promise<MutateRawFrontmatterResult> {
  return withRawFileLock(absolutePath, async () => {
    if (!existsSync(absolutePath)) return "missing";
    const content = await readFile(absolutePath, "utf-8");
    const parsed = parseFrontmatter(content);
    const nextFrontmatter = update(parsed.frontmatter, parsed.body);
    if (nextFrontmatter === null) return "skipped";
    await atomicWrite(
      absolutePath,
      serializeFrontmatter(nextFrontmatter, parsed.body),
    );
    return "updated";
  });
}

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? "undefined";
  } catch {
    return `[unserializable: ${typeof value}]`;
  }
}

function isoDate(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

const fatalUtf8Decoder = new TextDecoder("utf-8", { fatal: true });

function sliceUtf8Prefix(text: string, maxBytes: number): string {
  return sliceUtf8Head(Buffer.from(text, "utf-8"), maxBytes);
}

function sliceUtf8Head(buf: Buffer, maxBytes: number): string {
  let end = Math.min(Math.max(0, maxBytes), buf.byteLength);
  while (end > 0) {
    try {
      return fatalUtf8Decoder.decode(buf.subarray(0, end));
    } catch {
      end -= 1;
    }
  }
  return "";
}

function sliceUtf8Tail(buf: Buffer, maxBytes: number): string {
  let start = Math.max(0, buf.byteLength - Math.max(0, maxBytes));
  while (start < buf.byteLength) {
    try {
      return fatalUtf8Decoder.decode(buf.subarray(start));
    } catch {
      start += 1;
    }
  }
  return "";
}

async function defaultExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
