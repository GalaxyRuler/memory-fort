import { runHook, type HookPayload } from "./error-handler.js";
import { detectTool } from "./util/detect-tool.js";
import {
  ensureRawSessionFile,
  appendBlock,
  formatToolUseBlock,
  formatSummaryBlock,
  formatMetadataBlock,
} from "./raw-file.js";
import { readCaptureMode } from "./capture-mode.js";
import {
  readCwd,
  readSessionId,
  readToolInput,
  readToolName,
  readToolOutput,
} from "./util/payload-fields.js";
import type { ToolName } from "../storage/paths.js";
import { errorsLogPath, memoryRoot } from "../storage/paths.js";
import { atomicAppend } from "../storage/atomic-write.js";
import { isClientEnabled, loadMemoryConfig, type MemoryConfig } from "../storage/config.js";
import { scheduleAutoPush } from "../sync/auto-push.js";

export interface PostToolUseDeps {
  detectTool?: typeof detectTool;
  ensureRawSessionFile?: typeof ensureRawSessionFile;
  appendBlock?: typeof appendBlock;
  scheduleAutoPush?: typeof scheduleAutoPush;
  configLoader?: (root: string) => Promise<MemoryConfig>;
  appendErrorLog?: (line: string) => Promise<void>;
  now?: () => Date;
}

export async function postToolUseBody(
  payload: HookPayload,
  deps: PostToolUseDeps = {},
): Promise<void> {
  const detectFn = deps.detectTool ?? detectTool;
  const ensureFn = deps.ensureRawSessionFile ?? ensureRawSessionFile;
  const appendFn = deps.appendBlock ?? appendBlock;
  const scheduleFn = deps.scheduleAutoPush ?? (deps.ensureRawSessionFile || deps.appendBlock ? null : scheduleAutoPush);
  const appendErrorFn = deps.appendErrorLog ?? ((line: string) => atomicAppend(errorsLogPath(), line));
  const nowFn = deps.now ?? (() => new Date());

  const toolName = readToolName(payload);
  if (!toolName) return;

  const root = memoryRoot();
  const config = await loadHookConfig(deps, root);
  const captureCaps = readCaptureCaps(config);
  const tool: ToolName = detectFn();
  if (!isClientEnabled(config, tool)) return;
  const sessionId = readSessionId(payload);
  const cwd = readCwd(payload);
  const now = nowFn();

  const toolInput = readToolInput(payload);
  const toolOutput = readToolOutput(payload) ?? "";
  const toolInputJson = typeof toolInput === "string" ? toolInput : JSON.stringify(toolInput ?? "");
  const mode = readCaptureMode(config, toolName, toolInputJson);

  await ensureFn({ tool, sessionId, cwd, now });

  if (mode !== "skip") {
    let block: string;
    if (mode === "metadata") {
      block = formatMetadataBlock({
        toolName,
        toolInput,
        now,
        maxInputBytes: captureCaps.maxInputBytes,
      });
    } else if (mode === "summary") {
      block = formatSummaryBlock({
        toolName,
        toolInput,
        toolOutput,
        now,
        maxInputBytes: captureCaps.maxInputBytes,
      });
    } else {
      block = formatToolUseBlock({
        toolName,
        toolInput,
        toolOutput,
        now,
        maxInputBytes: captureCaps.maxInputBytes,
        maxOutputBytes: captureCaps.maxOutputBytes,
      });
    }
    await appendFn({ tool, sessionId, block, now });
  }
  if (scheduleFn) {
    try {
      await scheduleFn({ memoryRoot: root });
    } catch (err) {
      await appendErrorFn(`${nowFn().toISOString()} auto-push schedule failed: ${(err as Error).message}\n`);
    }
  }
}

async function loadHookConfig(deps: PostToolUseDeps, root: string): Promise<MemoryConfig> {
  const shouldReadConfig = deps.configLoader !== undefined ||
    (deps.ensureRawSessionFile === undefined && deps.appendBlock === undefined);
  if (!shouldReadConfig) return {};
  return (deps.configLoader ?? loadMemoryConfig)(root);
}

function readCaptureCaps(config: MemoryConfig): { maxInputBytes: number; maxOutputBytes: number } {
  return {
    maxInputBytes: readPositiveInteger(config.capture?.max_input_bytes, 8192),
    maxOutputBytes: readPositiveInteger(config.capture?.max_output_bytes, 8192),
  };
}

function readPositiveInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : fallback;
}

if (process.argv[1]?.endsWith("post-tool-use.mjs")) {
  runHook({ hookName: "post-tool-use", body: postToolUseBody });
}
