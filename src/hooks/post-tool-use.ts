import { runHook, type HookPayload } from "./error-handler.js";
import { detectTool } from "./util/detect-tool.js";
import {
  ensureRawSessionFile,
  appendBlock,
  formatToolUseBlock,
} from "./raw-file.js";
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

  const toolName =
    typeof payload.tool_name === "string" && payload.tool_name.length > 0
      ? payload.tool_name
      : null;
  if (!toolName) return;

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
    block: formatToolUseBlock({
      toolName,
      toolInput: payload.tool_input,
      toolOutput: payload.tool_output ?? "",
      now,
      maxOutputBytes: 8192,
    }),
    now,
  });
}

if (process.argv[1]?.endsWith("post-tool-use.mjs")) {
  runHook({ hookName: "post-tool-use", body: postToolUseBody });
}
