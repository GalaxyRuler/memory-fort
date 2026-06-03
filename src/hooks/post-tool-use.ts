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
import { errorsLogPath, memoryRoot } from "../storage/paths.js";
import { atomicAppend } from "../storage/atomic-write.js";
import { loadMemoryConfig, type MemoryConfig } from "../storage/config.js";
import { scheduleAutoPush } from "../sync/auto-push.js";
import { autoLinkRawToWiki } from "../capture/auto-link.js";

export interface PostToolUseDeps {
  detectTool?: typeof detectTool;
  ensureRawSessionFile?: typeof ensureRawSessionFile;
  appendBlock?: typeof appendBlock;
  scheduleAutoPush?: typeof scheduleAutoPush;
  autoLinkRawToWiki?: typeof autoLinkRawToWiki;
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
  const autoLinkFn = deps.autoLinkRawToWiki ?? (deps.ensureRawSessionFile || deps.appendBlock ? null : autoLinkRawToWiki);
  const appendErrorFn = deps.appendErrorLog ?? ((line: string) => atomicAppend(errorsLogPath(), line));
  const nowFn = deps.now ?? (() => new Date());

  const toolName = readToolName(payload);
  if (!toolName) return;

  const root = memoryRoot();
  const config = await (deps.configLoader ?? loadMemoryConfig)(root);
  const captureCaps = readCaptureCaps(config);
  const tool: ToolName = detectFn();
  const sessionId = readSessionId(payload);
  const cwd = readCwd(payload);
  const now = nowFn();

  const rawPath = await ensureFn({ tool, sessionId, cwd, now });
  await appendFn({
    tool,
    sessionId,
    block: formatToolUseBlock({
      toolName,
      toolInput: readToolInput(payload),
      toolOutput: readToolOutput(payload) ?? "",
      now,
      maxInputBytes: captureCaps.maxInputBytes,
      maxOutputBytes: captureCaps.maxOutputBytes,
    }),
    now,
  });
  if (autoLinkFn && readAutoLinkEnabled(config)) {
    try {
      await autoLinkFn(rawPath, {
        vaultRoot: root,
        threshold: readAutoLinkThreshold(config),
        titleThreshold: readAutoLinkTitleThreshold(config),
        expectedEmbeddingDim: readExpectedEmbeddingDim(config),
        apply: true,
        now,
      });
    } catch (err) {
      await appendErrorFn(`${nowFn().toISOString()} auto-link failed for ${rawPath}: ${(err as Error).message}\n`);
    }
  }
  if (scheduleFn) {
    try {
      await scheduleFn({ memoryRoot: root });
    } catch (err) {
      await appendErrorFn(`${nowFn().toISOString()} auto-push schedule failed: ${(err as Error).message}\n`);
    }
  }
}

function readAutoLinkEnabled(config: MemoryConfig): boolean {
  return config.auto_link?.enabled !== false;
}

function readAutoLinkThreshold(config: MemoryConfig): number | undefined {
  const value = config.auto_link?.similarity_threshold;
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readAutoLinkTitleThreshold(config: MemoryConfig): number | undefined {
  const value = config.auto_link?.title_threshold;
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readExpectedEmbeddingDim(config: MemoryConfig): number | undefined {
  const value = config.embedding?.dim;
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
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
