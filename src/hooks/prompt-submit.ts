import { stat, readFile } from "node:fs/promises";
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
import { memoryRoot } from "../storage/paths.js";
import { isClientEnabled, loadMemoryConfig, type MemoryConfig } from "../storage/config.js";
import { resolveDashboardUrl } from "../cli/commands/verify/dashboard.js";

export interface PromptSubmitDeps {
  detectTool?: typeof detectTool;
  ensureRawSessionFile?: typeof ensureRawSessionFile;
  appendBlock?: typeof appendBlock;
  configLoader?: (root: string) => Promise<MemoryConfig>;
  now?: () => Date;
  fetchFn?: typeof fetch;
  write?: (text: string) => void;
  env?: NodeJS.ProcessEnv;
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
  if (await shouldSkipForDisabledClient(tool, deps)) return;
  const sessionId = readSessionId(payload);
  const cwd = readCwd(payload);
  const now = nowFn();

  const sessionPath = await ensureFn({ tool, sessionId, cwd, now });
  // Detect "first prompt of this session" BEFORE appending the block below.
  const firstPrompt = await isFirstPrompt(sessionPath);
  await appendFn({
    tool,
    sessionId,
    block: formatPromptBlock(prompt, now),
    now,
  });

  if (firstPrompt) {
    // Proactive retrieval: the user's first prompt is the best query for what
    // memory is relevant to this session. Fail-silent by design — retrieval
    // must never delay or break capture.
    await emitPromptRetrieval(prompt, deps);
  }
}

/** Session files start tiny; anything past this already saw its first prompt. */
const FIRST_PROMPT_MAX_SCAN_BYTES = 32 * 1024;
const RETRIEVAL_TIMEOUT_MS = 1500;
const RETRIEVAL_RESULTS = 3;
const RETRIEVAL_SNIPPET_CHARS = 220;

async function isFirstPrompt(sessionPath: string): Promise<boolean> {
  try {
    const info = await stat(sessionPath);
    if (info.size > FIRST_PROMPT_MAX_SCAN_BYTES) return false;
    const content = await readFile(sessionPath, "utf-8");
    return !content.includes("] Prompt\n");
  } catch {
    return false;
  }
}

/**
 * Search the memory system for the submitted prompt and emit curated wiki hits
 * to stdout, which the host agent (Claude Code / Codex) injects as context.
 * Uses the dashboard's bounded index search — never an in-process corpus load.
 * Kill switch: MEMORY_PROMPT_RETRIEVAL=0.
 */
async function emitPromptRetrieval(prompt: string, deps: PromptSubmitDeps): Promise<void> {
  const env = deps.env ?? process.env;
  if (env["MEMORY_PROMPT_RETRIEVAL"]?.trim() === "0") return;
  try {
    const baseUrl = await resolveDashboardUrl(undefined);
    const query = prompt.replace(/\s+/g, " ").trim().slice(0, 300);
    if (query.length < 8) return; // Too short to retrieve anything meaningful.
    const response = await (deps.fetchFn ?? fetch)(
      `${baseUrl}/api/search?q=${encodeURIComponent(query)}&k=8`,
      { signal: AbortSignal.timeout(RETRIEVAL_TIMEOUT_MS) },
    );
    if (!response.ok) return;
    const body = (await response.json()) as {
      results?: Array<{ path?: string; title?: string; snippet?: string }>;
    };
    if (!Array.isArray(body.results)) return;
    // Curated wiki pages only: raw results are mostly echoes of live sessions,
    // and dot-directories (.audit, compile-proposed) are operational surfaces.
    const hits = body.results
      .filter((result) =>
        typeof result.path === "string" &&
        result.path.startsWith("wiki/") &&
        !result.path.startsWith("wiki/.") &&
        !result.path.startsWith("wiki/compile-proposed/"))
      .slice(0, RETRIEVAL_RESULTS);
    if (hits.length === 0) return;
    const write = deps.write ?? ((text: string) => process.stdout.write(text));
    const lines = hits.map((hit) => {
      const snippet = (hit.snippet ?? "").replace(/\s+/g, " ").trim().slice(0, RETRIEVAL_SNIPPET_CHARS);
      return `- ${hit.path}${hit.title ? ` (${hit.title})` : ""}${snippet ? ` — ${snippet}` : ""}`;
    });
    write(`[memory:prompt-retrieval] Possibly relevant memory for this prompt (read with memory MCP read_page):\n${lines.join("\n")}\n`);
  } catch {
    // Dashboard offline, timeout, malformed response — retrieval is best-effort.
  }
}

async function shouldSkipForDisabledClient(tool: ToolName, deps: PromptSubmitDeps): Promise<boolean> {
  const shouldReadConfig = deps.configLoader !== undefined ||
    (deps.ensureRawSessionFile === undefined && deps.appendBlock === undefined);
  if (!shouldReadConfig) return false;
  const root = memoryRoot();
  const config = await (deps.configLoader ?? loadMemoryConfig)(root);
  return !isClientEnabled(config, tool);
}

if (process.argv[1]?.endsWith("prompt-submit.mjs")) {
  runHook({ hookName: "prompt-submit", body: promptSubmitBody });
}
