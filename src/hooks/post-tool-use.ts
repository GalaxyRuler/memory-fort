import { runHook, type HookPayload } from "./error-handler.js";
import { detectTool } from "./util/detect-tool.js";
import {
  ensureRawSessionFile,
  appendBlock,
  formatToolUseBlock,
} from "./raw-file.js";
import {
  readCwd,
  readSessionId,
  readToolInput,
  readToolName,
  readToolOutput,
} from "./util/payload-fields.js";
import type { ToolName } from "../storage/paths.js";

export interface PostToolUseDeps {
  detectTool?: typeof detectTool;
  ensureRawSessionFile?: typeof ensureRawSessionFile;
  appendBlock?: typeof appendBlock;
  now?: () => Date;
}

export async function postToolUseBody(
  payload: HookPayload,
  deps: PostToolUseDeps = {},
): Promise<void> {
  const detectFn = deps.detectTool ?? detectTool;
  const ensureFn = deps.ensureRawSessionFile ?? ensureRawSessionFile;
  const appendFn = deps.appendBlock ?? appendBlock;
  const nowFn = deps.now ?? (() => new Date());

  const toolName = readToolName(payload);
  if (!toolName) return;

  const tool: ToolName = detectFn();
  const sessionId = readSessionId(payload);
  const cwd = readCwd(payload);
  const now = nowFn();

  await ensureFn({ tool, sessionId, cwd, now });
  await appendFn({
    tool,
    sessionId,
    block: formatToolUseBlock({
      toolName,
      toolInput: readToolInput(payload),
      toolOutput: readToolOutput(payload) ?? "",
      now,
      maxOutputBytes: 8192,
    }),
    now,
  });
}

if (process.argv[1]?.endsWith("post-tool-use.mjs")) {
  runHook({ hookName: "post-tool-use", body: postToolUseBody });
}
