import { runHook, type HookPayload } from "./error-handler.js";
import { isAbsolute, relative } from "node:path";
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
import { autoLinkRawToWiki } from "../capture/auto-link.js";
import { runAutoHealCapture } from "../retrieval/auto-heal.js";
import { isClientEnabled, loadMemoryConfig, type MemoryConfig } from "../storage/config.js";

export interface SessionEndDeps {
  detectTool?: typeof detectTool;
  ensureRawSessionFile?: typeof ensureRawSessionFile;
  appendBlock?: typeof appendBlock;
  scheduleAutoPush?: typeof scheduleAutoPush;
  autoLinkRawToWiki?: typeof autoLinkRawToWiki;
  autoHealRaw?: typeof runAutoHealCapture;
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
  // Injecting capture deps means test mode: only run real side-effect functions
  // (auto-link/auto-heal/scheduler) when they are explicitly injected.
  const testMode = deps.ensureRawSessionFile !== undefined || deps.appendBlock !== undefined;
  const scheduleFn = deps.scheduleAutoPush ?? (testMode ? null : scheduleAutoPush);
  const autoLinkFn = deps.autoLinkRawToWiki ?? (testMode ? null : autoLinkRawToWiki);
  const autoHealFn = deps.autoHealRaw ?? (testMode ? null : runAutoHealCapture);
  const appendErrorFn = deps.appendErrorLog ?? ((line: string) => atomicAppend(errorsLogPath(), line));
  const nowFn = deps.now ?? (() => new Date());

  const shouldReadConfig = deps.configLoader !== undefined
    || (deps.ensureRawSessionFile === undefined && deps.appendBlock === undefined);
  const root = memoryRoot();
  const config: MemoryConfig = shouldReadConfig
    ? await (deps.configLoader ?? loadMemoryConfig)(root)
    : {};

  const tool: ToolName = detectFn();
  if (shouldReadConfig && !isClientEnabled(config, tool)) return;
  const sessionId = readSessionId(payload);
  const cwd = readCwd(payload);
  const now = nowFn();

  const rawPath = await ensureFn({ tool, sessionId, cwd, now });
  await appendFn({
    tool,
    sessionId,
    block: formatMarker("SessionEnd", now),
    now,
  });

  // Auto-link and auto-heal run here (end of turn) rather than on every tool
  // call: this narrows the auto-link whole-file-rewrite race window (it fires at
  // most once per turn instead of once per tool call) and removes a full
  // embeddings-store load from the per-tool-call hot path. It does NOT fully
  // close the rewrite race — a concurrent worker or late append can still be
  // clobbered; per-writer serialization remains a separate hardening item.
  if (autoHealFn && readAutoHealEnabled(config)) {
    try {
      await autoHealFn({
        memoryRoot: root,
        relPath: toVaultRelPath(root, rawPath),
        configLoader: async () => config,
        now: nowFn,
      });
    } catch (err) {
      await appendErrorFn(`${nowFn().toISOString()} auto-heal failed for ${rawPath}: ${(err as Error).message}\n`);
    }
  }
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

function readAutoHealEnabled(config: MemoryConfig): boolean {
  return config.auto_heal?.enabled === true;
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

function toVaultRelPath(root: string, path: string): string {
  if (!isAbsolute(path)) return path.replace(/\\/g, "/");
  return relative(root, path).replace(/\\/g, "/");
}

if (process.argv[1]?.endsWith("session-end.mjs")) {
  runHook({ hookName: "session-end", body: sessionEndBody });
}
