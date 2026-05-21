import { runHook, type HookPayload } from "./error-handler.js";
import { detectTool } from "./util/detect-tool.js";
import {
  ensureRawSessionFile,
  appendBlock,
  formatMarker,
} from "./raw-file.js";
import type { ToolName } from "../storage/paths.js";

export interface PreCompactDeps {
  detectTool?: typeof detectTool;
  ensureRawSessionFile?: typeof ensureRawSessionFile;
  appendBlock?: typeof appendBlock;
  now?: () => Date;
}

export async function preCompactBody(
  payload: HookPayload,
  deps: PreCompactDeps = {},
): Promise<void> {
  const detectFn = deps.detectTool ?? detectTool;
  const ensureFn = deps.ensureRawSessionFile ?? ensureRawSessionFile;
  const appendFn = deps.appendBlock ?? appendBlock;
  const nowFn = deps.now ?? (() => new Date());

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
    block: formatMarker("CompactionMarker", now),
    now,
  });
}

if (process.argv[1]?.endsWith("pre-compact.mjs")) {
  runHook({ hookName: "pre-compact", body: preCompactBody });
}
