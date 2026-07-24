import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, readdir, stat, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { TextDecoder } from "node:util";
import { captureSpoolDir, rawSessionFile } from "../storage/paths.js";
import { redactSecrets } from "../privacy/redaction.js";
import { atomicAppend, atomicCreate, atomicWrite } from "../storage/atomic-write.js";
import {
  FileLockTimeoutError,
  withFileLock,
  type FileLockOptions,
} from "../storage/file-lock.js";
import {
  parseFrontmatter,
  serializeFrontmatter,
  type Frontmatter,
} from "../storage/frontmatter.js";
import type { ToolName } from "../storage/paths.js";

/** Shared lock options for raw session writers (append + frontmatter RMW). */
const RAW_FILE_LOCK = { timeoutMs: 15_000, staleMs: 60_000 } as const;
/**
 * Replay is opportunistic recovery: it must not hold a new hook behind stale
 * capture contention for the normal session-lock timeout.
 */
const CAPTURE_REPLAY_LOCK = { timeoutMs: 100, staleMs: 60_000, pollMs: 50 } as const;
const CAPTURE_REPLAY_EVENT_BUDGET = 2;
const CAPTURE_EVENT_MARKER = "memory-fort-capture";
const CAPTURE_SPOOLED_DIAGNOSTICS_FILE = "capture-spooled.jsonl";
const CAPTURE_DROPPED_DIAGNOSTICS_FILE = "capture-dropped-stale.jsonl";
const CAPTURE_DRAIN_FAILURES_FILE = "capture-drain-failures.jsonl";
const CAPTURE_REPLAY_CURSOR_FILE = "capture-replay-cursor.txt";
const CAPTURE_SPOOL_COORDINATION_TARGET = ".capture-spool-coordination";
const CAPTURE_EPOCHS_DIR = "epochs";

interface CaptureEvent {
  version: 1 | 2;
  id: string;
  hash: string;
  rawPath: string;
  block: string;
  createdAt: string;
  captureEpoch?: string;
}
interface CaptureSpoolEntry { name: string; path: string; event: CaptureEvent; }
interface RawCaptureEpochState { version: 1; state: "ready" | "invalidating"; token: string; }
export interface RawCaptureEpochTransition {
  rawPath: string;
  previousToken: string;
  invalidatingToken: string;
  readyToken: string;
}
export interface CaptureSpooledDiagnostic { type: "capture_spooled"; eventId: string; hash: string; createdAt: string; }
export interface CaptureSpoolStatus { pendingEventCount: number; oldestPendingAgeMs: number | null; drainFailures: number; captureSpooled: CaptureSpooledDiagnostic[]; }
export interface CaptureSpoolAttribution {
  status:
    | "none"
    | "pending-attributable"
    | "removed-attributable"
    | "partial-removed-attributable";
  attributableEventCount: number;
  pendingEventCount: number;
  removedEventCount: number;
  /** Absolute operational event paths only; capture block contents are never exposed. */
  paths: string[];
  pendingPaths: string[];
  removedPaths: string[];
  failedPath?: string;
  epochInvalidation?: CaptureEpochInvalidationAttribution;
}

export interface CaptureEpochInvalidationAttribution {
  status: "not-started" | "partial-invalidating" | "all-invalidating";
  advancedRawPaths: string[];
  quarantinedRawPaths: string[];
  pendingRawPaths: string[];
}

export class CapturePreparationMutationError extends Error {
  readonly attribution: CaptureSpoolAttribution;
  readonly failedOperation: "spool-removal" | "epoch-invalidation";
  readonly failedPath: string;

  constructor(
    attribution: CaptureSpoolAttribution,
    failedOperation: "spool-removal" | "epoch-invalidation",
    failedPath: string,
    cause: unknown,
  ) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`capture preparation ${failedOperation} failed for ${failedPath}: ${detail}`);
    this.name = "CapturePreparationMutationError";
    this.attribution = attribution;
    this.failedOperation = failedOperation;
    this.failedPath = failedPath;
    this.cause = cause;
  }
}

export async function getCaptureSpoolStatus(now = new Date()): Promise<CaptureSpoolStatus> {
  const events = await readCaptureSpoolEvents();
  const oldestPendingAgeMs = events.reduce<number | null>((oldest, event) => {
    const age = Math.max(0, now.getTime() - Date.parse(event.createdAt));
    return oldest === null || age > oldest ? age : oldest;
  }, null);
  const captureSpooled = new Map<string, CaptureSpooledDiagnostic>();
  for (const diagnostic of await readCaptureSpooledDiagnostics()) {
    captureSpooled.set(diagnostic.eventId, diagnostic);
  }
  for (const event of events) {
    if (!captureSpooled.has(event.id)) {
      captureSpooled.set(event.id, {
        type: "capture_spooled",
        eventId: event.id,
        hash: event.hash,
        createdAt: event.createdAt,
      });
    }
  }
  return {
    pendingEventCount: events.length,
    oldestPendingAgeMs,
    drainFailures: await countCaptureDrainFailures(),
    captureSpooled: [...captureSpooled.values()],
  };
}

export async function inspectCaptureSpoolAttribution(
  absoluteRawPaths: readonly string[],
): Promise<CaptureSpoolAttribution> {
  return captureSpoolAttribution(
    await readCaptureSpoolEntries(),
    rawTargetKeys(absoluteRawPaths),
    "pending-attributable",
    [],
  );
}

/**
 * Remove queued captures attributable to the selected raws while holding the
 * same spool-then-raw lock order used by replay. The callback runs with those
 * locks still held, allowing forget to delete the raw files before replay can
 * observe the now-removed queue entries.
 */
export async function withCaptureSpoolEventsRemoved<T>(
  absoluteRawPaths: readonly string[],
  beforeRemoval: (epochs: readonly RawCaptureEpochTransition[]) => Promise<void>,
  operation: (
    attribution: CaptureSpoolAttribution,
    epochs: readonly RawCaptureEpochTransition[],
  ) => Promise<T>,
): Promise<T> {
  const rawPaths = uniqueAbsoluteRawPaths(absoluteRawPaths);
  const targetKeys = rawTargetKeys(rawPaths);
  return withCaptureSpoolLock(async () => withRawFileLocks(rawPaths, async () => {
    const entries = await readCaptureSpoolEntries();
    const attributable = entries.filter((entry) => targetKeys.has(normalizeRawTarget(entry.event.rawPath)));
    const epochs: RawCaptureEpochTransition[] = [];
    for (const rawPath of rawPaths) {
      const previousToken = await ensureRawCaptureEpoch(rawPath);
      const previous = await readRawCaptureEpoch(rawPath);
      if (!previous || previous.state !== "ready" || previous.token !== previousToken) {
        throw new Error(`raw capture epoch is already invalidating for ${rawPath}`);
      }
      epochs.push({
        rawPath,
        previousToken,
        invalidatingToken: randomUUID(),
        readyToken: randomUUID(),
      });
    }
    await beforeRemoval(epochs);
    const removedPaths: string[] = [];
    for (const entry of attributable) {
      try {
        await unlink(entry.path);
        removedPaths.push(entry.path);
      } catch (error) {
        if (isCode(error, "ENOENT")) {
          removedPaths.push(entry.path);
          continue;
        }
        throw new CapturePreparationMutationError(
          captureSpoolAttribution(
            attributable,
            targetKeys,
            "partial-removed-attributable",
            removedPaths,
            entry.path,
            captureEpochInvalidationAttribution(rawPaths, []),
          ),
          "spool-removal",
          entry.path,
          error,
        );
      }
    }
    const advanced: RawCaptureEpochTransition[] = [];
    for (const transition of epochs) {
      try {
        await writeRawCaptureEpoch(transition.rawPath, {
          version: 1,
          state: "invalidating",
          token: transition.invalidatingToken,
        });
        advanced.push(transition);
      } catch (error) {
        const failedPath = rawCaptureEpochPath(transition.rawPath);
        throw new CapturePreparationMutationError(
          captureSpoolAttribution(
            attributable,
            targetKeys,
            "removed-attributable",
            removedPaths,
            failedPath,
            captureEpochInvalidationAttribution(
              rawPaths,
              advanced.map((advancedTransition) => advancedTransition.rawPath),
            ),
          ),
          "epoch-invalidation",
          failedPath,
          error,
        );
      }
    }
    return operation(captureSpoolAttribution(
      attributable,
      targetKeys,
      "removed-attributable",
      removedPaths,
    ), epochs);
  }));
}

/** Publish fresh ready epochs after the owning generation is ready, while raw locks remain held. */
export async function completeRawCaptureEpochInvalidation(
  transitions: readonly RawCaptureEpochTransition[],
): Promise<void> {
  for (const transition of transitions) {
    const current = await readRawCaptureEpoch(transition.rawPath);
    if (current?.state === "ready" && current.token === transition.readyToken) continue;
    if (current?.state === "ready" && current.token === transition.previousToken) continue;
    if (current?.state !== "invalidating" || current.token !== transition.invalidatingToken) {
      throw new Error(`raw capture epoch ownership changed for ${transition.rawPath}`);
    }
    await writeRawCaptureEpoch(transition.rawPath, {
      version: 1,
      state: "ready",
      token: transition.readyToken,
    });
  }
}

/** Hold the replay-compatible spool-then-sorted-raw lock order without mutating captures. */
export function withCaptureSpoolAndRawLocks<T>(
  absoluteRawPaths: readonly string[],
  operation: () => Promise<T>,
): Promise<T> {
  const rawPaths = uniqueAbsoluteRawPaths(absoluteRawPaths);
  return withCaptureSpoolLock(() => withRawFileLocks(rawPaths, operation));
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
  if (
    (input.exists !== undefined || input.write !== undefined)
    && await existsFn(path)
  ) return path;
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
    await ensureRawCaptureEpoch(path);
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
  lockOptions?: FileLockOptions;
}): Promise<void> {
  const now = input.now ?? new Date();
  const path = rawSessionFile(input.tool, input.sessionId, now, input.vaultRoot);
  const appendFn = input.append ?? atomicAppend;
  if (input.append !== undefined) {
    await appendFn(path, renderCaptureEvent(createLegacyCaptureEvent(path, input.block, now)));
    return;
  }
  const event = await createCaptureEvent(path, input.block, now);
  if (!event.captureEpoch) {
    await spoolCaptureEvent(event);
    return;
  }
  await drainCaptureSpool();
  let disposition: "current" | "stale" | "unverifiable";
  try {
    disposition = await withFileLock(path, async () => {
      const currentDisposition = await captureEventEpochDisposition(event);
      if (currentDisposition === "current") {
        await appendFn(path, renderCaptureEvent(event));
      }
      return currentDisposition;
    }, input.lockOptions ?? RAW_FILE_LOCK);
  } catch (err) {
    if (err instanceof FileLockTimeoutError) {
      await spoolCaptureEvent(event);
      return;
    }
    throw err;
  }
  if (disposition === "stale") await recordCaptureDropped(event, "stale-epoch");
  else if (disposition === "unverifiable") await spoolCaptureEvent(event);
}

async function createCaptureEvent(rawPath: string, block: string, now: Date): Promise<CaptureEvent> {
  let captureEpoch: string | undefined;
  try {
    captureEpoch = (await readRawCaptureEpoch(rawPath))?.token;
  } catch {
    // Missing or corrupt epoch state is fail-closed below.
  }
  return {
    version: 2,
    id: randomUUID(),
    hash: createHash("sha256").update(block, "utf-8").digest("hex"),
    rawPath,
    block,
    createdAt: now.toISOString(),
    captureEpoch,
  };
}
function createLegacyCaptureEvent(rawPath: string, block: string, now: Date): CaptureEvent {
  return {
    version: 1,
    id: randomUUID(),
    hash: createHash("sha256").update(block, "utf-8").digest("hex"),
    rawPath,
    block,
    createdAt: now.toISOString(),
  };
}
function renderCaptureEvent(event: CaptureEvent): string {
  return `${event.block}\n<!-- ${CAPTURE_EVENT_MARKER} id=${event.id} hash=${event.hash} -->\n`;
}
function marker(event: CaptureEvent): string { return `${CAPTURE_EVENT_MARKER} id=${event.id}`; }
async function spoolCaptureEvent(event: CaptureEvent): Promise<void> {
  await withCaptureSpoolLock(async () => {
    const spoolDir = captureSpoolDir();
    await atomicCreate(join(spoolDir, `${event.id}.json`), `${JSON.stringify(event)}\n`);
    await ensureCaptureSpooledDiagnostic(event);
  });
}
async function drainCaptureSpool(): Promise<void> {
  try {
    await withCaptureSpoolLock(async () => {
      const entries = rotateCaptureSpoolEntries(
        await readCaptureSpoolEntries(),
        await readCaptureReplayCursor(),
      );
      for (const entry of entries.slice(0, CAPTURE_REPLAY_EVENT_BUDGET)) {
        try {
          await withFileLock(entry.event.rawPath, async () => {
            const disposition = await captureEventEpochDisposition(entry.event);
            if (disposition === "current") {
              let existing = "";
              try { existing = await readFile(entry.event.rawPath, "utf-8"); }
              catch (error) { if (!isCode(error, "ENOENT")) throw error; }
              if (!existing.includes(marker(entry.event))) await atomicAppend(entry.event.rawPath, renderCaptureEvent(entry.event));
              await ensureCaptureSpooledDiagnostic(entry.event);
            } else if (disposition === "stale") {
              await recordCaptureDropped(entry.event, "stale-epoch", entry.path);
            } else {
              throw new Error(`capture epoch is unavailable for queued event ${entry.name}`);
            }
            try {
              await unlink(entry.path);
            } catch (error) {
              // Another replayer already persisted this event and removed the spool.
              if (!isCode(error, "ENOENT")) throw error;
            }
          }, CAPTURE_REPLAY_LOCK);
        } catch {
          await recordCaptureDrainFailure(entry.event);
        }
        await advanceCaptureReplayCursor(entry.name);
      }
    }, CAPTURE_REPLAY_LOCK);
  } catch (error) {
    // Replay remains opportunistic: a contended coordinator must not delay the
    // current hook capture behind another replay/forget transaction.
    if (!(error instanceof FileLockTimeoutError)) throw error;
  }
}
function rotateCaptureSpoolEntries(entries: CaptureSpoolEntry[], cursor: string | null): CaptureSpoolEntry[] {
  if (!cursor) return entries;
  const cursorIndex = entries.findIndex((entry) => entry.name === cursor);
  if (cursorIndex < 0) return entries;
  return [...entries.slice(cursorIndex + 1), ...entries.slice(0, cursorIndex + 1)];
}
async function readCaptureReplayCursor(): Promise<string | null> {
  try {
    const cursor = (await readFile(join(captureSpoolDir(), CAPTURE_REPLAY_CURSOR_FILE), "utf-8")).trim();
    return cursor || null;
  } catch {
    return null;
  }
}
async function advanceCaptureReplayCursor(name: string): Promise<void> {
  try {
    await atomicWrite(join(captureSpoolDir(), CAPTURE_REPLAY_CURSOR_FILE), `${name}\n`);
  } catch {
    // Replay cursor state must not prevent the current capture from persisting.
  }
}
async function recordCaptureDrainFailure(event: CaptureEvent): Promise<void> {
  try {
    await atomicAppend(
      join(captureSpoolDir(), CAPTURE_DRAIN_FAILURES_FILE),
      `${JSON.stringify({ type: "capture_drain_failed", eventId: event.id, createdAt: new Date().toISOString() })}\n`,
    );
  } catch {
    // Recovery telemetry must not prevent the current capture from persisting.
  }
}
async function recordCaptureDropped(
  event: CaptureEvent,
  reason: "stale-epoch" | "epoch-unavailable",
  eventPath?: string,
): Promise<void> {
  try {
    await atomicAppend(
      join(captureSpoolDir(), CAPTURE_DROPPED_DIAGNOSTICS_FILE),
      `${JSON.stringify({
        type: "capture_dropped_stale",
        eventId: event.id,
        hash: event.hash,
        rawPath: event.rawPath,
        ...(eventPath ? { eventPath } : {}),
        reason,
        createdAt: event.createdAt,
        droppedAt: new Date().toISOString(),
      })}\n`,
    );
  } catch {
    // A stale event remains dropped even when content-free telemetry is unavailable.
  }
}
async function countCaptureDrainFailures(): Promise<number> {
  let content: string;
  try {
    content = await readFile(join(captureSpoolDir(), CAPTURE_DRAIN_FAILURES_FILE), "utf-8");
  } catch (error) {
    if (isCode(error, "ENOENT")) return 0;
    throw error;
  }
  let count = 0;
  for (const line of content.split(/\r?\n/u)) {
    if (!line) continue;
    try {
      const record = JSON.parse(line) as { type?: unknown; eventId?: unknown; createdAt?: unknown };
      if (
        record.type === "capture_drain_failed"
        && typeof record.eventId === "string"
        && typeof record.createdAt === "string"
      ) count += 1;
    } catch {
      // A malformed failure record is passive observation, not a new replay attempt.
    }
  }
  return count;
}
async function ensureCaptureSpooledDiagnostic(event: CaptureEvent): Promise<void> {
  const existing = await readCaptureSpooledDiagnostics();
  if (existing.some((diagnostic) => diagnostic.eventId === event.id)) return;
  await atomicAppend(
    join(captureSpoolDir(), CAPTURE_SPOOLED_DIAGNOSTICS_FILE),
    `${JSON.stringify(diagnosticFromEvent(event))}\n`,
  );
}
function diagnosticFromEvent(event: CaptureEvent): CaptureSpooledDiagnostic {
  return {
    type: "capture_spooled",
    eventId: event.id,
    hash: event.hash,
    createdAt: event.createdAt,
  };
}
async function readCaptureSpooledDiagnostics(): Promise<CaptureSpooledDiagnostic[]> {
  let content: string;
  try {
    content = await readFile(join(captureSpoolDir(), CAPTURE_SPOOLED_DIAGNOSTICS_FILE), "utf-8");
  } catch (error) {
    if (isCode(error, "ENOENT")) return [];
    throw error;
  }
  const diagnostics: CaptureSpooledDiagnostic[] = [];
  for (const line of content.split(/\r?\n/u)) {
    if (!line) continue;
    try {
      const diagnostic = JSON.parse(line) as CaptureSpooledDiagnostic;
      if (
        diagnostic.type === "capture_spooled"
        && typeof diagnostic.eventId === "string"
        && typeof diagnostic.hash === "string"
        && typeof diagnostic.createdAt === "string"
      ) diagnostics.push(diagnostic);
    } catch {
      // A malformed diagnostic is passive observation, not a failed drain attempt.
    }
  }
  return diagnostics;
}
async function readCaptureSpoolEvents(): Promise<CaptureEvent[]> {
  return (await readCaptureSpoolEntries()).map((entry) => entry.event);
}
async function readCaptureSpoolEntries(): Promise<CaptureSpoolEntry[]> {
  let names: string[];
  try { names = await readdir(captureSpoolDir()); }
  catch (error) { if (isCode(error, "ENOENT")) return []; throw error; }
  const entries: CaptureSpoolEntry[] = [];
  for (const name of names.filter((candidate) => candidate.endsWith(".json")).sort()) {
    try {
      const path = join(captureSpoolDir(), name);
      const event = JSON.parse(await readFile(path, "utf-8")) as CaptureEvent;
      if (
        (event.version === 1 || event.version === 2)
        && typeof event.id === "string"
        && typeof event.hash === "string"
        && typeof event.rawPath === "string"
        && typeof event.block === "string"
        && typeof event.createdAt === "string"
        && (event.version === 1
          || event.captureEpoch === undefined
          || typeof event.captureEpoch === "string")
      ) entries.push({ name, path, event });
    } catch {
      // Passive observation is not a drain attempt and must not affect drain accounting.
    }
  }
  return entries;
}
function withCaptureSpoolLock<T>(
  operation: () => Promise<T>,
  options: FileLockOptions = RAW_FILE_LOCK,
): Promise<T> {
  return withFileLock(
    join(captureSpoolDir(), CAPTURE_SPOOL_COORDINATION_TARGET),
    operation,
    options,
  );
}
function uniqueAbsoluteRawPaths(paths: readonly string[]): string[] {
  const unique = new Map<string, string>();
  for (const path of paths) {
    const absolute = resolve(path);
    unique.set(normalizeRawTarget(absolute), absolute);
  }
  return [...unique.values()].sort((a, b) => a.localeCompare(b));
}
function rawTargetKeys(paths: readonly string[]): Set<string> {
  return new Set(paths.map(normalizeRawTarget));
}
function normalizeRawTarget(path: string): string {
  const normalized = resolve(path).replace(/\\/g, "/");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}
export function rawCaptureEpochPath(rawPath: string): string {
  const key = createHash("sha256").update(normalizeRawTarget(rawPath), "utf-8").digest("hex");
  return join(captureSpoolDir(), CAPTURE_EPOCHS_DIR, `${key}.json`);
}
export async function ensureRawCaptureEpoch(rawPath: string): Promise<string> {
  const existing = await readRawCaptureEpoch(rawPath);
  if (existing) return existing.token;
  const initial: RawCaptureEpochState = { version: 1, state: "ready", token: randomUUID() };
  try {
    await atomicCreate(rawCaptureEpochPath(rawPath), `${JSON.stringify(initial)}\n`);
    return initial.token;
  } catch (error) {
    if (!isCode(error, "EEXIST")) throw error;
    const raced = await readRawCaptureEpoch(rawPath);
    if (!raced) throw new Error(`raw capture epoch disappeared for ${rawPath}`);
    return raced.token;
  }
}
async function readRawCaptureEpoch(rawPath: string): Promise<RawCaptureEpochState | null> {
  let content: string;
  try {
    content = await readFile(rawCaptureEpochPath(rawPath), "utf-8");
  } catch (error) {
    if (isCode(error, "ENOENT")) return null;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error(`raw capture epoch is corrupt for ${rawPath}`);
  }
  if (
    typeof parsed !== "object"
    || parsed === null
    || (parsed as { version?: unknown }).version !== 1
    || ((parsed as { state?: unknown }).state !== "ready"
      && (parsed as { state?: unknown }).state !== "invalidating")
    || typeof (parsed as { token?: unknown }).token !== "string"
    || (parsed as { token: string }).token.length === 0
  ) {
    throw new Error(`raw capture epoch is corrupt for ${rawPath}`);
  }
  return parsed as RawCaptureEpochState;
}
async function writeRawCaptureEpoch(rawPath: string, state: RawCaptureEpochState): Promise<void> {
  await atomicWrite(rawCaptureEpochPath(rawPath), `${JSON.stringify(state)}\n`);
}
async function captureEventEpochDisposition(
  event: CaptureEvent,
): Promise<"current" | "stale" | "unverifiable"> {
  if (event.version !== 2 || typeof event.captureEpoch !== "string") return "unverifiable";
  try {
    const current = await readRawCaptureEpoch(event.rawPath);
    if (!current) return "unverifiable";
    if (current.state !== "ready") return "stale";
    return current.token === event.captureEpoch ? "current" : "stale";
  } catch {
    return "unverifiable";
  }
}
function captureSpoolAttribution(
  entries: readonly CaptureSpoolEntry[],
  targetKeys: ReadonlySet<string>,
  matchedStatus:
    | "pending-attributable"
    | "removed-attributable"
    | "partial-removed-attributable",
  removedPaths: readonly string[],
  failedPath?: string,
  epochInvalidation?: CaptureEpochInvalidationAttribution,
): CaptureSpoolAttribution {
  const paths = entries
    .filter((entry) => targetKeys.has(normalizeRawTarget(entry.event.rawPath)))
    .map((entry) => entry.path)
    .sort((a, b) => a.localeCompare(b));
  const removed = [...removedPaths].sort((a, b) => a.localeCompare(b));
  const removedKeys = new Set(removed.map(normalizeRawTarget));
  const pending = paths.filter((path) => !removedKeys.has(normalizeRawTarget(path)));
  return {
    status: paths.length > 0 ? matchedStatus : "none",
    attributableEventCount: paths.length,
    pendingEventCount: pending.length,
    removedEventCount: removed.length,
    paths,
    pendingPaths: pending,
    removedPaths: removed,
    ...(failedPath ? { failedPath } : {}),
    ...(epochInvalidation ? { epochInvalidation } : {}),
  };
}
function captureEpochInvalidationAttribution(
  rawPaths: readonly string[],
  advancedRawPaths: readonly string[],
): CaptureEpochInvalidationAttribution {
  const advancedKeys = new Set(advancedRawPaths.map(normalizeRawTarget));
  const advanced = rawPaths
    .filter((rawPath) => advancedKeys.has(normalizeRawTarget(rawPath)))
    .sort((a, b) => a.localeCompare(b));
  const pending = rawPaths
    .filter((rawPath) => !advancedKeys.has(normalizeRawTarget(rawPath)))
    .sort((a, b) => a.localeCompare(b));
  return {
    status: advanced.length === 0
      ? "not-started"
      : pending.length === 0
        ? "all-invalidating"
        : "partial-invalidating",
    advancedRawPaths: advanced,
    quarantinedRawPaths: [...advanced],
    pendingRawPaths: pending,
  };
}
async function withRawFileLocks<T>(
  absolutePaths: readonly string[],
  operation: () => Promise<T>,
): Promise<T> {
  const [first, ...rest] = absolutePaths;
  if (!first) return operation();
  return withRawFileLock(first, () => withRawFileLocks(rest, operation));
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
