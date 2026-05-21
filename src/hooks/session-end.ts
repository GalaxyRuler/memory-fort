import { runHook, type HookPayload } from "./error-handler.js";
import { detectTool } from "./util/detect-tool.js";
import {
  ensureRawSessionFile,
  appendBlock,
  formatMarker,
} from "./raw-file.js";
import { readCwd, readSessionId } from "./util/payload-fields.js";
import type { ToolName } from "../storage/paths.js";

export interface SessionEndDeps {
  detectTool?: typeof detectTool;
  ensureRawSessionFile?: typeof ensureRawSessionFile;
  appendBlock?: typeof appendBlock;
  now?: () => Date;
}

export async function sessionEndBody(
  payload: HookPayload,
  deps: SessionEndDeps = {},
): Promise<void> {
  const detectFn = deps.detectTool ?? detectTool;
  const ensureFn = deps.ensureRawSessionFile ?? ensureRawSessionFile;
  const appendFn = deps.appendBlock ?? appendBlock;
  const nowFn = deps.now ?? (() => new Date());

  const tool: ToolName = detectFn();
  const sessionId = readSessionId(payload);
  const cwd = readCwd(payload);
  const now = nowFn();

  await ensureFn({ tool, sessionId, cwd, now });
  await appendFn({
    tool,
    sessionId,
    block: formatMarker("SessionEnd", now),
    now,
  });
}

if (process.argv[1]?.endsWith("session-end.mjs")) {
  runHook({ hookName: "session-end", body: sessionEndBody });
}
