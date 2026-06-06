import { runHook, type HookPayload } from "./error-handler.js";
import {
  appendBlock,
  ensureRawSessionFile,
  formatTimestamp,
  truncateMiddle,
} from "./raw-file.js";
import { redactSecrets } from "../privacy/redaction.js";

const OPENCODE_TOOL = "opencode" as const;
const MAX_EVENT_BYTES = 8192;
const SUPPORTED_EVENT_TYPES = new Set([
  "session.created",
  "session.idle",
  "tool.execute.after",
]);

export interface OpenCodeEventDeps {
  ensureRawSessionFile?: typeof ensureRawSessionFile;
  appendBlock?: typeof appendBlock;
  now?: () => Date;
}

export async function opencodeEventBody(
  payload: HookPayload,
  deps: OpenCodeEventDeps = {},
): Promise<void> {
  const eventType = readSupportedEventType(payload["type"]);
  if (!eventType) return;

  const ensureFn = deps.ensureRawSessionFile ?? ensureRawSessionFile;
  const appendFn = deps.appendBlock ?? appendBlock;
  const nowFn = deps.now ?? (() => new Date());
  const now = nowFn();
  const sessionId = readSessionId(payload);
  const cwd = readCwd(payload);

  await ensureFn({ tool: OPENCODE_TOOL, sessionId, cwd, now });
  await appendFn({
    tool: OPENCODE_TOOL,
    sessionId,
    block: formatOpenCodeEventBlock({
      eventType,
      payload,
      now,
    }),
    now,
  });
}

function formatOpenCodeEventBlock(input: {
  eventType: string;
  payload: HookPayload;
  now: Date;
}): string {
  const ts = formatTimestamp(input.now);
  const json = safeJsonStringify(input.payload);
  const redacted = redactSecrets(json);
  const truncated = truncateMiddle(redacted, MAX_EVENT_BYTES);
  return (
    `\n## [${ts}] OpenCode Event: ${input.eventType}\n\n` +
    `\`\`\`json\n${truncated}\n\`\`\`\n`
  );
}

function readSessionId(payload: HookPayload): string {
  return (
    readNonEmptyString(payload["sessionID"]) ??
    readNonEmptyString(payload["session_id"]) ??
    readNonEmptyString(readPath(payload, ["properties", "sessionID"])) ??
    readNonEmptyString(readPath(payload, ["properties", "info", "id"])) ??
    "unknown"
  );
}

function readCwd(payload: HookPayload): string {
  return (
    readNonEmptyString(payload["cwd"]) ??
    readNonEmptyString(payload["directory"]) ??
    readNonEmptyString(payload["working_directory"]) ??
    readNonEmptyString(readPath(payload, ["properties", "directory"])) ??
    readNonEmptyString(readPath(payload, ["properties", "info", "directory"])) ??
    readNonEmptyString(payload["worktree"]) ??
    process.cwd()
  );
}

function readSupportedEventType(value: unknown): string | null {
  const eventType = readNonEmptyString(value);
  if (!eventType) return null;
  return SUPPORTED_EVENT_TYPES.has(eventType) ? eventType : null;
}

function readPath(value: unknown, path: string[]): unknown {
  let current = value;
  for (const part of path) {
    if (!isRecord(current)) return undefined;
    current = current[part];
  }
  return current;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? "undefined";
  } catch {
    return `[unserializable: ${typeof value}]`;
  }
}

if (process.argv[1]?.endsWith("opencode-event.mjs")) {
  runHook({ hookName: "opencode-event", body: opencodeEventBody });
}
