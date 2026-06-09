import { stat } from "node:fs/promises";
import { TextDecoder } from "node:util";
import { rawSessionFile } from "../storage/paths.js";
import { redactSecrets } from "../privacy/redaction.js";
import { atomicAppend, atomicWrite } from "../storage/atomic-write.js";
import {
  serializeFrontmatter,
  type Frontmatter,
} from "../storage/frontmatter.js";
import type { ToolName } from "../storage/paths.js";

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
  exists?: (path: string) => Promise<boolean>;
  write?: (path: string, content: string) => Promise<void>;
}): Promise<string> {
  const now = input.now ?? new Date();
  const path = rawSessionFile(input.tool, input.sessionId, now);
  const existsFn = input.exists ?? defaultExists;
  const writeFn = input.write ?? atomicWrite;
  if (await existsFn(path)) return path;
  const fm: Frontmatter = {
    type: "raw-session",
    title: `${input.tool} session ${input.sessionId}`,
    created: isoDate(now),
    updated: isoDate(now),
    source: input.tool,
    session: input.sessionId,
    // Custom field — tracking working directory the session ran in
    cwd: input.cwd,
  };
  const header = serializeFrontmatter(fm, "").replace(
    `session: ${input.sessionId}\n`,
    `session: "${input.sessionId}"\n`,
  );
  await writeFn(path, header);
  return path;
}

/**
 * Append a pre-formatted block to a session file. Caller is
 * responsible for calling ensureRawSessionFile first (or
 * accepting the cheap cost of doing it again — append creates
 * the file if missing, but without frontmatter that's a defect).
 */
export async function appendBlock(input: {
  tool: ToolName;
  sessionId: string;
  block: string;
  now?: Date;
  append?: (path: string, content: string) => Promise<void>;
}): Promise<void> {
  const now = input.now ?? new Date();
  const path = rawSessionFile(input.tool, input.sessionId, now);
  const appendFn = input.append ?? atomicAppend;
  await appendFn(path, input.block);
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
