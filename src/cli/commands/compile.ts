import { existsSync } from "node:fs";
import {
  mkdir,
  readFile,
  readdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { applyCompileOperations, parseCompileOperationsBlock, type ApplyCompileOperationsResult } from "../../compile/execute.js";
import { chatWithAudit } from "../../llm/audit.js";
import {
  createLLMFromConfig,
  getActiveLLMConfig,
  type LLMConfig,
} from "../../llm/factory.js";
import { type LLMProvider } from "../../llm/types.js";
import { loadMemoryConfig, type MemoryConfig } from "../../storage/config.js";
import {
  memoryRoot,
} from "../../storage/paths.js";

export interface CompileOptions {
  vaultRoot?: string;
  since?: string;
  perFileMaxBytes?: number;
  totalMaxBytes?: number;
  outputPath?: string;
  execute?: boolean;
  plan?: boolean;
  env?: NodeJS.ProcessEnv;
  configLoader?: () => Promise<MemoryConfig>;
  llmFactory?: (config: LLMConfig | null, env: NodeJS.ProcessEnv) => LLMProvider;
}

export interface CompileResult {
  prompt: string;
  rawFilesIncluded: string[];
  rawFilesSkipped: { path: string; reason: string }[];
  sinceCutoff: string;
  truncatedAtTotalCap: boolean;
  execution?: {
    mode: "plan" | "execute";
  } & ApplyCompileOperationsResult;
}

interface RawCandidate {
  path: string;
  mtimeMs: number;
}

const DEFAULT_PER_FILE_MAX_BYTES = 10_000;
const DEFAULT_TOTAL_MAX_BYTES = 200_000;
const COMPILE_LOG_RE =
  /^## \[(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})\] compile \|/gm;

export async function runCompile(
  opts: CompileOptions = {},
): Promise<CompileResult> {
  const perFileMaxBytes = readPositiveInteger(
    opts.perFileMaxBytes,
    DEFAULT_PER_FILE_MAX_BYTES,
    "perFileMaxBytes",
  );
  const totalMaxBytes = readPositiveInteger(
    opts.totalMaxBytes,
    DEFAULT_TOTAL_MAX_BYTES,
    "totalMaxBytes",
  );
  const root = opts.vaultRoot ?? memoryRoot();
  const promptTemplate = await readRequiredFile(
    join(root, "prompts", "compile.md"),
    "compile prompt",
  );
  const schema = await readRequiredFile(join(root, "schema.md"), "schema.md");
  const index = await readOptionalFile(join(root, "index.md"));
  const log = await readOptionalFile(join(root, "log.md"));
  const sinceDate = opts.since
    ? parseCutoff(opts.since)
    : detectSinceFromLog(log) ?? new Date(0);

  const rawFilesSkipped: CompileResult["rawFilesSkipped"] = [];
  const rawFilesIncluded: string[] = [];
  const rawContentBlocks: string[] = [];
  let totalUsed = 0;
  let truncatedAtTotalCap = false;

  const rawFiles = await listRawFiles(join(root, "raw"));
  for (const candidate of rawFiles) {
    if (candidate.mtimeMs < sinceDate.getTime()) {
      rawFilesSkipped.push({
        path: candidate.path,
        reason: "before since cutoff",
      });
      continue;
    }
    if (totalUsed >= totalMaxBytes) {
      truncatedAtTotalCap = true;
      rawFilesSkipped.push({
        path: candidate.path,
        reason: "totalMaxBytes reached",
      });
      continue;
    }

    let content: string;
    try {
      content = await readFile(candidate.path, "utf-8");
    } catch (err) {
      rawFilesSkipped.push({
        path: candidate.path,
        reason: `read failed: ${(err as Error).message}`,
      });
      continue;
    }

    const perFile = truncateToBytes(content, perFileMaxBytes);
    let text = perFile.text;
    if (perFile.truncated) {
      text += `\n\n[truncated to ${perFileMaxBytes} bytes]`;
    }

    const remaining = totalMaxBytes - totalUsed;
    const totalLimited = truncateToBytes(text, remaining);
    text = totalLimited.text;
    if (totalLimited.truncated) {
      truncatedAtTotalCap = true;
      text += `\n\n[truncated at totalMaxBytes ${totalMaxBytes}]`;
    }

    totalUsed += Buffer.byteLength(totalLimited.text, "utf-8");
    rawFilesIncluded.push(candidate.path);
    rawContentBlocks.push(
      `### ${candidate.path}\n\n\`\`\`markdown\n${text}\n\`\`\``,
    );
  }

  const prompt = renderPrompt(promptTemplate, {
    schema_content: schema,
    index_content: index,
    recent_log_lines: tailLines(log, 50),
    raw_files_list:
      rawFilesIncluded.length === 0
        ? "(none)"
        : rawFilesIncluded.map((path) => `- ${path}`).join("\n"),
    raw_content:
      rawContentBlocks.length === 0 ? "(none)" : rawContentBlocks.join("\n\n"),
  });

  if (opts.outputPath) {
    await mkdir(dirname(opts.outputPath), { recursive: true });
    await writeFile(opts.outputPath, prompt);
  }

  const execution = opts.execute
    ? await executeCompilePrompt({ ...opts, root, prompt })
    : undefined;

  return {
    prompt,
    rawFilesIncluded,
    rawFilesSkipped,
    sinceCutoff: sinceDate.toISOString(),
    truncatedAtTotalCap,
    execution,
  };
}

async function executeCompilePrompt(opts: CompileOptions & {
  root: string;
  prompt: string;
}): Promise<CompileResult["execution"]> {
  const env = opts.env ?? process.env;
  const config = await (opts.configLoader ?? (() => loadMemoryConfig(opts.root)))();
  const llmConfig = getActiveLLMConfig(config);
  const llm = (opts.llmFactory ?? createLLMFromConfig)(llmConfig, env);
  const response = await chatWithAudit({
    llm,
    vaultRoot: opts.root,
    consumer: "compile-execute",
    request: {
      messages: [
        {
          role: "system",
          content: "Return only a fenced compile-ops JSON block describing append-only memory mutations.",
        },
        { role: "user", content: opts.prompt },
      ],
      maxTokens: llmConfig?.max_tokens,
      temperature: llmConfig?.temperature,
    },
    env,
  });
  const parsed = parseCompileOperationsBlock(response.content);
  if (!parsed.ok) {
    return {
      mode: opts.plan ? "plan" : "execute",
      applied: [],
      proposed: [],
      planned: [],
      rejected: [{ path: "(response)", reason: parsed.reason }],
      outcomes: [{
        path: "(response)",
        outcome: "rejected",
        reason: parsed.reason,
        contentPreserved: false,
      }],
      referencesStripped: 0,
      prosePathLeaks: 0,
    };
  }
  const applied = await applyCompileOperations({
    vaultRoot: opts.root,
    operations: parsed.operations,
    plan: opts.plan,
  });
  return {
    mode: opts.plan ? "plan" : "execute",
    ...applied,
  };
}

async function listRawFiles(rawRoot: string): Promise<RawCandidate[]> {
  if (!existsSync(rawRoot)) return [];
  const files: RawCandidate[] = [];

  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        const info = await stat(full);
        files.push({ path: full, mtimeMs: info.mtimeMs });
      }
    }
  }

  await walk(rawRoot);
  return files.sort(
    (a, b) => a.mtimeMs - b.mtimeMs || a.path.localeCompare(b.path),
  );
}

function detectSinceFromLog(log: string): Date | null {
  let latest: Date | null = null;
  let match: RegExpExecArray | null;
  COMPILE_LOG_RE.lastIndex = 0;
  while ((match = COMPILE_LOG_RE.exec(log)) !== null) {
    const parsed = parseCutoff(`${match[1]}T${match[2]}Z`);
    if (!latest || parsed > latest) latest = parsed;
  }
  return latest;
}

function parseCutoff(value: string): Date {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    throw new Error(`memory compile: invalid --since value: ${value}`);
  }
  return parsed;
}

async function readRequiredFile(path: string, label: string): Promise<string> {
  if (!existsSync(path)) {
    throw new Error(`memory compile: missing ${label} at ${path}`);
  }
  return readFile(path, "utf-8");
}

async function readOptionalFile(path: string): Promise<string> {
  if (!existsSync(path)) return "";
  return readFile(path, "utf-8");
}

function readPositiveInteger(
  value: number | undefined,
  fallback: number,
  name: string,
): number {
  const n = value ?? fallback;
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`memory compile: ${name} must be a non-negative integer`);
  }
  return n;
}

function renderPrompt(
  template: string,
  vars: Record<string, string>,
): string {
  return template.replace(/\{\{([a-z_]+)\}\}/g, (full, key: string) => {
    return Object.prototype.hasOwnProperty.call(vars, key) ? vars[key]! : full;
  });
}

function tailLines(text: string, maxLines: number): string {
  const lines = text.split(/\r?\n/);
  return lines.slice(-maxLines).join("\n");
}

function truncateToBytes(
  text: string,
  maxBytes: number,
): { text: string; truncated: boolean } {
  const bytes = Buffer.from(text, "utf-8");
  if (bytes.byteLength <= maxBytes) return { text, truncated: false };
  return {
    text: bytes.subarray(0, maxBytes).toString("utf-8"),
    truncated: true,
  };
}
