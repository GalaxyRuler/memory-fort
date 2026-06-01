import { errorsLogPath } from "../storage/paths.js";
import { atomicAppend } from "../storage/atomic-write.js";

/**
 * Minimal shape of the JSON payload each platform's hook system
 * sends on stdin. Platform payloads vary, so writer hooks use
 * payload field readers with fallback chains instead of branching
 * on platform identity.
 */
export interface HookPayload {
  // Claude Code shape
  session_id?: string;
  cwd?: string;
  prompt?: string;
  tool_name?: string;
  tool_input?: unknown;
  tool_output?: unknown;
  entrypoint?: string;
  // Codex shape
  turn_id?: string;
  tool_use_id?: string;
  tool_response?: unknown;
  // Generic fallbacks observed in the wild
  toolName?: string;
  toolInput?: unknown;
  output?: unknown;
  user_prompt?: string;
  message?: string;
  working_directory?: string;
  // Other / unknown
  [key: string]: unknown;
}

export interface HookContext {
  /** Used to namespace errors in errors.log. */
  hookName: string;
  /** What this hook actually does on a parsed payload. */
  body: (payload: HookPayload) => Promise<void>;
  /** Test seam — defaults to reading process.stdin. */
  readStdin?: () => Promise<string>;
  /** Test seam — defaults to appending to errors.log on disk. */
  appendError?: (text: string) => Promise<void>;
  /** Test seam — defaults to process.exit. */
  exit?: (code: number) => void;
  /** Test seam — defaults to new Date(). */
  now?: () => Date;
}

/**
 * Standard wrapper for every hook script. Reads stdin, parses
 * JSON, skips if the call is an SDK self-loop, runs the body,
 * routes any error to errors.log, and exits 0 unconditionally.
 *
 * Hooks NEVER break the host session — exit code 0 always,
 * even on errors. The errors are made visible via errors.log
 * (see `memory tail-errors`).
 */
export async function runHook(ctx: HookContext): Promise<void> {
  const readStdinFn = ctx.readStdin ?? defaultReadStdin;
  const appendErrFn = ctx.appendError ?? defaultAppendError;
  const exitFn = ctx.exit ?? ((code: number) => process.exit(code));
  const nowFn = ctx.now ?? (() => new Date());

  try {
    const raw = await readStdinFn();
    let payload: HookPayload;
    try {
      payload = JSON.parse(stripLeadingJsonBom(raw)) as HookPayload;
    } catch {
      if (
        process.env["MEMORY_SDK_CHILD"] === "1" ||
        process.env["AGENTMEMORY_SDK_CHILD"] === "1"
      ) {
        return;
      }
      const preview =
        raw.length > 4096 ? `${raw.slice(0, 4096)}...[truncated]` : raw;
      const line =
        `${nowFn().toISOString()} ${ctx.hookName} stdin-parse-failed ` +
        `(length=${raw.length}, env-CODEX_HOME=${!!process.env["CODEX_HOME"]}, ` +
        `env-CLAUDECODE=${!!process.env["CLAUDECODE"]}) raw:\n` +
        `${preview}\n\n`;
      try {
        await appendErrFn(line);
      } catch {
        // If errors.log itself cannot be written, keep the hook
        // non-disruptive for the host session.
      }
      return;
    }
    if (isSdkChildContext(payload)) {
      return;
    }
    await ctx.body(payload);
  } catch (err) {
    const e = err as Error;
    const line =
      `${nowFn().toISOString()} ${ctx.hookName} ${e.message ?? "unknown"}\n` +
      `${e.stack ?? "no stack"}\n\n`;
    try {
      await appendErrFn(line);
    } catch {
      // If we can't write to errors.log either, there's
      // nothing more we can do without compromising the host
      // session. Swallow.
    }
  } finally {
    exitFn(0);
  }
}

function stripLeadingJsonBom(raw: string): string {
  return raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw;
}

/**
 * Detect when a hook is firing from inside an SDK-spawned
 * subprocess (i.e., our own MCP/curation calls). Without this
 * check, the LLM's MCP call → hook fires → hook produces
 * observation → which the LLM sees → which fires another hook
 * → infinite loop.
 */
export function isSdkChildContext(payload: HookPayload): boolean {
  if (process.env["AGENTMEMORY_SDK_CHILD"] === "1") return true;
  if (process.env["MEMORY_SDK_CHILD"] === "1") return true;
  if (payload.entrypoint === "sdk-ts") return true;
  if (payload.entrypoint === "memory-mcp") return true;
  return false;
}

async function defaultReadStdin(): Promise<string> {
  let data = "";
  for await (const chunk of process.stdin) {
    data += chunk;
  }
  return data;
}

async function defaultAppendError(text: string): Promise<void> {
  await atomicAppend(errorsLogPath(), text);
}
