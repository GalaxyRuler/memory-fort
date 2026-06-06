import { runHook, type HookPayload } from "./error-handler.js";
import { detectTool } from "./util/detect-tool.js";
import {
  ensureRawSessionFile,
  appendBlock,
  formatPromptBlock,
} from "./raw-file.js";
import {
  readCwd,
  readPrompt,
  readSessionId,
} from "./util/payload-fields.js";
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

  const prompt = readPrompt(payload);
  if (!prompt) return; // nothing to log

  const tool: ToolName = detectFn();
  const sessionId = readSessionId(payload);
  const cwd = readCwd(payload);
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
