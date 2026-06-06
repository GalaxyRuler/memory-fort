import type { HookPayload } from "../error-handler.js";

/** Session/turn identifier: Claude Code uses session_id, Codex uses turn_id. */
export function readSessionId(
  payload: HookPayload,
  fallback = "unknown",
): string {
  return (
    readNonEmptyString(payload.session_id) ??
    readNonEmptyString(payload.turn_id) ??
    fallback
  );
}

/** User prompt text: Claude Code uses prompt; Codex docs/name variants differ. */
export function readPrompt(payload: HookPayload): string | null {
  for (const k of ["prompt", "user_prompt", "message"] as const) {
    const v = readNonEmptyString(payload[k], true);
    if (v !== null) return v;
  }
  return null;
}

/** Tool name: Claude Code uses tool_name; camelCase appears in other payloads. */
export function readToolName(payload: HookPayload): string | null {
  for (const k of ["tool_name", "toolName"] as const) {
    const v = readNonEmptyString(payload[k]);
    if (v !== null) return v;
  }
  return null;
}

/** Tool input: Claude Code and Codex use tool_input; camelCase is a fallback. */
export function readToolInput(payload: HookPayload): unknown {
  return payload.tool_input ?? payload.toolInput ?? undefined;
}

/** Tool output/response: Claude Code uses tool_output; Codex uses tool_response. */
export function readToolOutput(payload: HookPayload): unknown {
  return payload.tool_output ?? payload.tool_response ?? payload.output ?? undefined;
}

/** Working directory: Claude Code uses cwd; Codex may use working_directory. */
export function readCwd(payload: HookPayload, fallback?: string): string {
  for (const k of ["cwd", "working_directory"] as const) {
    const v = readNonEmptyString(payload[k]);
    if (v !== null) return v;
  }
  return fallback ?? process.cwd();
}

function readNonEmptyString(value: unknown, trim = false): string | null {
  if (typeof value !== "string") return null;
  const candidate = trim ? value.trim() : value;
  return candidate.length > 0 ? value : null;
}
