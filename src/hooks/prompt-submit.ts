import { runHook, type HookPayload } from "./error-handler.js";
import { detectTool } from "./util/detect-tool.js";
import {
  ensureRawSessionFile,
  appendBlock,
  formatPromptBlock,
} from "./raw-file.js";
import type { ToolName } from "../storage/paths.js";

export interface PromptSubmitDeps {
  detectTool?: typeof detectTool;
  ensureRawSessionFile?: typeof ensureRawSessionFile;
  appendBlock?: typeof appendBlock;
  now?: () => Date;
}

export async function promptSubmitBody(
  payload: HookPayload,
  deps: PromptSubmitDeps = {},
): Promise<void> {
  const detectFn = deps.detectTool ?? detectTool;
  const ensureFn = deps.ensureRawSessionFile ?? ensureRawSessionFile;
  const appendFn = deps.appendBlock ?? appendBlock;
  const nowFn = deps.now ?? (() => new Date());

  const prompt =
    typeof payload.prompt === "string" && payload.prompt.trim().length > 0
      ? payload.prompt
      : null;
  if (!prompt) return; // nothing to log

  const tool: ToolName = detectFn();
  const sessionId =
    typeof payload.session_id === "string" && payload.session_id.length > 0
      ? payload.session_id
      : "unknown";
  const cwd =
    typeof payload.cwd === "string" && payload.cwd.length > 0
      ? payload.cwd
      : process.cwd();
  const now = nowFn();

  await ensureFn({ tool, sessionId, cwd, now });
  await appendFn({
    tool,
    sessionId,
    block: formatPromptBlock(prompt, now),
    now,
  });
}

if (process.argv[1]?.endsWith("prompt-submit.mjs")) {
  runHook({ hookName: "prompt-submit", body: promptSubmitBody });
}
