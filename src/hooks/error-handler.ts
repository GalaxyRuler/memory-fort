import { errorsLogPath } from "../storage/paths.js";
import { atomicAppend } from "../storage/atomic-write.js";

/**
 * Minimal shape of the JSON payload each platform's hook system
 * sends on stdin. Platforms vary slightly; the fields here are
 * the conservative intersection that all three (Claude Code,
 * Codex, manual CLI invocation) provide. Hooks that need
 * platform-specific fields cast the payload at the call site.
 */
export interface HookPayload {
  session_id?: string;
  cwd?: string;
  prompt?: string;
  tool_name?: string;
  tool_input?: unknown;
  tool_output?: unknown;
  entrypoint?: string;
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
      payload = JSON.parse(raw) as HookPayload;
    } catch {
      // Malformed JSON on stdin: skip silently. Host tools
      // occasionally send empty stdin during plugin setup;
      // logging these as errors floods errors.log.
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
