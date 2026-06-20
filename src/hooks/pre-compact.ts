import { runHook, type HookPayload } from "./error-handler.js";
import { detectTool } from "./util/detect-tool.js";
import {
  ensureRawSessionFile,
  appendBlock,
  formatMarker,
} from "./raw-file.js";
import { readCwd, readSessionId } from "./util/payload-fields.js";
import type { ToolName } from "../storage/paths.js";
import { memoryRoot } from "../storage/paths.js";
import { isClientEnabled, loadMemoryConfig, type MemoryConfig } from "../storage/config.js";

export interface PreCompactDeps {
  detectTool?: typeof detectTool;
  ensureRawSessionFile?: typeof ensureRawSessionFile;
  appendBlock?: typeof appendBlock;
  configLoader?: (root: string) => Promise<MemoryConfig>;
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
  if (await shouldSkipForDisabledClient(tool, deps)) return;
  const sessionId = readSessionId(payload);
  const cwd = readCwd(payload);
  const now = nowFn();

  await ensureFn({ tool, sessionId, cwd, now });
  await appendFn({
    tool,
    sessionId,
    block: formatMarker("CompactionMarker", now),
    now,
  });
}

async function shouldSkipForDisabledClient(tool: ToolName, deps: PreCompactDeps): Promise<boolean> {
  const shouldReadConfig = deps.configLoader !== undefined ||
    (deps.ensureRawSessionFile === undefined && deps.appendBlock === undefined);
  if (!shouldReadConfig) return false;
  const root = memoryRoot();
  const config = await (deps.configLoader ?? loadMemoryConfig)(root);
  return !isClientEnabled(config, tool);
}

if (process.argv[1]?.endsWith("pre-compact.mjs")) {
  runHook({ hookName: "pre-compact", body: preCompactBody });
}
