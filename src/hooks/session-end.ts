import { runHook, type HookPayload } from "./error-handler.js";
import { detectTool } from "./util/detect-tool.js";
import {
  ensureRawSessionFile,
  appendBlock,
  formatMarker,
} from "./raw-file.js";
import { readCwd, readSessionId } from "./util/payload-fields.js";
import type { ToolName } from "../storage/paths.js";
import { errorsLogPath, memoryRoot } from "../storage/paths.js";
import { atomicAppend } from "../storage/atomic-write.js";
import { scheduleAutoPush } from "../sync/auto-push.js";
import { isClientEnabled, loadMemoryConfig, type MemoryConfig } from "../storage/config.js";

export interface SessionEndDeps {
  detectTool?: typeof detectTool;
  ensureRawSessionFile?: typeof ensureRawSessionFile;
  appendBlock?: typeof appendBlock;
  scheduleAutoPush?: typeof scheduleAutoPush;
  appendErrorLog?: (line: string) => Promise<void>;
  configLoader?: (root: string) => Promise<MemoryConfig>;
  now?: () => Date;
}

export async function sessionEndBody(
  payload: HookPayload,
  deps: SessionEndDeps = {},
): Promise<void> {
  const detectFn = deps.detectTool ?? detectTool;
  const ensureFn = deps.ensureRawSessionFile ?? ensureRawSessionFile;
  const appendFn = deps.appendBlock ?? appendBlock;
  const scheduleFn = deps.scheduleAutoPush ?? (deps.ensureRawSessionFile || deps.appendBlock ? null : scheduleAutoPush);
  const appendErrorFn = deps.appendErrorLog ?? ((line: string) => atomicAppend(errorsLogPath(), line));
  const nowFn = deps.now ?? (() => new Date());

  const tool: ToolName = detectFn();
  if (await shouldSkipForDisabledClient(tool, deps)) return;
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
  if (scheduleFn) {
    try {
      await scheduleFn({ memoryRoot: memoryRoot() });
    } catch (err) {
      await appendErrorFn(`${nowFn().toISOString()} auto-push schedule failed: ${(err as Error).message}\n`);
    }
  }
}

async function shouldSkipForDisabledClient(tool: ToolName, deps: SessionEndDeps): Promise<boolean> {
  const shouldReadConfig = deps.configLoader !== undefined ||
    (deps.ensureRawSessionFile === undefined && deps.appendBlock === undefined);
  if (!shouldReadConfig) return false;
  const root = memoryRoot();
  const config = await (deps.configLoader ?? loadMemoryConfig)(root);
  return !isClientEnabled(config, tool);
}

if (process.argv[1]?.endsWith("session-end.mjs")) {
  runHook({ hookName: "session-end", body: sessionEndBody });
}
