import type { ToolName } from "../../storage/paths.js";
import type { HookPayload } from "../error-handler.js";

export interface DetectToolInput {
  /** Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /** Payload that fired the hook. Optional — env vars usually suffice. */
  payload?: HookPayload;
}

/**
 * Identify which platform fired a hook.
 *
 * These shared hook scripts are installed for Claude Code and Codex.
 * Antigravity live capture uses a separate plugin hook set, so if this
 * script fires it can only be Claude Code or Codex. The `manual` tool
 * name is set explicitly by the `memory log` CLI and never appears via
 * the hook path.
 *
 * - `CLAUDECODE=1` is set by Claude Code in every hook subprocess
 *   (verified — Anthropic docs document this as the
 *   nested-session detection variable).
 * - Codex doesn't set a dedicated identifier env var; we treat
 *   any non-Claude-Code hook firing as Codex (fallback).
 *
 * Phase 4 may refine this if a multi-platform session ever
 * misattributes; for Phase 1 it's correct by construction.
 */
export function detectTool(input: DetectToolInput = {}): ToolName {
  const env = input.env ?? process.env;
  if (env["CLAUDECODE"] === "1") return "claude-code";
  return "codex";
}
