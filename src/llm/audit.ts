import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, stat, writeFile, appendFile } from "node:fs/promises";
import { join } from "node:path";
import type { LLMFinishReason, LLMMessage, LLMProvider, LLMRequest, LLMResponse } from "./types.js";

export interface LLMAuditEntry {
  ts: Date | string;
  consumer: string;
  provider: string;
  model: string;
  promptHash: string;
  responseHash: string;
  tokensIn?: number | null;
  tokensOut?: number | null;
  durationMs: number;
  costUsd?: number | null;
  estimatedCostUSD?: number | null;
  referencesStripped?: number | null;
  strippedSamples?: string[];
  finishReason: LLMFinishReason;
  error?: string;
}

export interface LLMAuditMetadata {
  referencesStripped?: number | null;
  strippedSamples?: string[];
}

export interface ChatWithAuditOptions {
  llm: LLMProvider;
  vaultRoot: string;
  consumer: string;
  request: LLMRequest;
  auditMetadata?: (response: LLMResponse) => LLMAuditMetadata | Promise<LLMAuditMetadata>;
}

export interface LLMAuditConsumerSummary {
  consumer: string;
  calls: number;
  costUsd: number;
  referencesStripped: number;
}

export interface LLMAuditProviderModelSummary {
  provider: string;
  model: string;
  calls: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
}

export interface LLMAuditSummary {
  totalCalls: number;
  totalCostUsd: number;
  byConsumer: LLMAuditConsumerSummary[];
  byProviderModel: LLMAuditProviderModelSummary[];
}

const HEADER = [
  "| ts | consumer | provider | model | prompt_hash | response_hash | tokens_in | tokens_out | duration_ms | cost_usd | references_stripped | stripped_samples | finish | error |",
  "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
].join("\n");

export function hashPrompt(messages: LLMMessage[]): string {
  return hash16(messages.map((message) => `${message.role}:${message.content}`).join("\n"));
}

export function hashResponse(content: string): string {
  return hash16(content);
}

export async function writeLLMAuditEntry(vaultRoot: string, entry: LLMAuditEntry): Promise<void> {
  const ts = toDate(entry.ts);
  const auditDir = join(vaultRoot, "wiki", ".audit");
  await mkdir(auditDir, { recursive: true });
  const path = join(auditDir, `llm-${dateKey(ts)}.md`);
  if (!(await exists(path))) {
    await writeFile(path, `# LLM audit log ${dateKey(ts)}\n\n${HEADER}\n`, "utf-8");
  }
  await appendFile(path, `${formatEntry(entry)}\n`, "utf-8");
}

export async function chatWithAudit(opts: ChatWithAuditOptions) {
  const started = Date.now();
  const promptHash = hashPrompt(opts.request.messages);
  try {
    const response = await opts.llm.chat(opts.request);
    const auditMetadata = opts.auditMetadata ? await opts.auditMetadata(response) : {};
    await writeLLMAuditEntry(opts.vaultRoot, {
      ts: new Date(),
      consumer: opts.consumer,
      provider: opts.llm.providerName,
      model: response.model,
      promptHash,
      responseHash: hashResponse(response.content),
      tokensIn: response.tokensUsed?.prompt ?? null,
      tokensOut: response.tokensUsed?.completion ?? null,
      durationMs: Math.max(0, Date.now() - started),
      costUsd: 0,
      ...auditMetadata,
      finishReason: response.finishReason,
    });
    return response;
  } catch (error) {
    await writeLLMAuditEntry(opts.vaultRoot, {
      ts: new Date(),
      consumer: opts.consumer,
      provider: opts.llm.providerName,
      model: opts.llm.modelName,
      promptHash,
      responseHash: "",
      tokensIn: null,
      tokensOut: null,
      durationMs: Math.max(0, Date.now() - started),
      costUsd: null,
      finishReason: "error",
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

export async function readLLMAuditSummary(
  vaultRoot: string,
  opts: { days: number; now?: Date },
): Promise<LLMAuditSummary> {
  const auditDir = join(vaultRoot, "wiki", ".audit");
  if (!(await exists(auditDir))) {
    return emptySummary();
  }

  const now = opts.now ?? new Date();
  const minTime = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
  ) - Math.max(0, opts.days - 1) * 24 * 60 * 60 * 1000;
  const consumers = new Map<string, LLMAuditConsumerSummary>();
  const providerModels = new Map<string, LLMAuditProviderModelSummary>();
  let totalCalls = 0;
  let totalCostUsd = 0;

  for (const entry of await readdir(auditDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const match = /^llm-(\d{4}-\d{2}-\d{2})\.md$/.exec(entry.name);
    if (!match) continue;
    const fileTime = Date.parse(`${match[1]}T00:00:00.000Z`);
    if (!Number.isFinite(fileTime) || fileTime < minTime) continue;
    const rows = parseAuditRows(await readFile(join(auditDir, entry.name), "utf-8"));
    for (const row of rows) {
      totalCalls += 1;
      const costUsd = parseOptionalNumber(row.costUsd) ?? 0;
      const referencesStripped = parseOptionalNumber(row.referencesStripped) ?? 0;
      const tokensIn = parseOptionalNumber(row.tokensIn) ?? 0;
      const tokensOut = parseOptionalNumber(row.tokensOut) ?? 0;
      totalCostUsd += costUsd;

      const consumer = consumers.get(row.consumer) ?? {
        consumer: row.consumer,
        calls: 0,
        costUsd: 0,
        referencesStripped: 0,
      };
      consumer.calls += 1;
      consumer.costUsd += costUsd;
      consumer.referencesStripped += referencesStripped;
      consumers.set(row.consumer, consumer);

      const providerModelKey = `${row.provider}\0${row.model}`;
      const providerModel = providerModels.get(providerModelKey) ?? {
        provider: row.provider,
        model: row.model,
        calls: 0,
        tokensIn: 0,
        tokensOut: 0,
        costUsd: 0,
      };
      providerModel.calls += 1;
      providerModel.tokensIn += tokensIn;
      providerModel.tokensOut += tokensOut;
      providerModel.costUsd += costUsd;
      providerModels.set(providerModelKey, providerModel);
    }
  }

  return {
    totalCalls,
    totalCostUsd,
    byConsumer: [...consumers.values()].sort(sortByCallsThenName("consumer")),
    byProviderModel: [...providerModels.values()].sort((a, b) =>
      b.calls - a.calls || a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model)
    ),
  };
}

function hash16(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function formatEntry(entry: LLMAuditEntry): string {
  const ts = toDate(entry.ts);
  const costUsd = entry.costUsd ?? entry.estimatedCostUSD;
  return `| ${[
    ts.toISOString(),
    escapeCell(entry.consumer),
    escapeCell(entry.provider),
    escapeCell(entry.model),
    entry.promptHash,
    entry.responseHash,
    formatOptionalNumber(entry.tokensIn),
    formatOptionalNumber(entry.tokensOut),
    String(entry.durationMs),
    formatOptionalNumber(costUsd),
    formatOptionalNumber(entry.referencesStripped),
    escapeCell((entry.strippedSamples ?? []).join("; ")),
    entry.finishReason,
    escapeCell(entry.error ?? ""),
  ].join(" | ")} |`;
}

function parseAuditRows(text: string): Array<{
  consumer: string;
  provider: string;
  model: string;
  tokensIn: string;
  tokensOut: string;
  costUsd: string;
  referencesStripped: string;
}> {
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("| ") || line.includes("---") || line.startsWith("| ts ")) {
      continue;
    }
    const cells = line.split("|").slice(1, -1).map((cell) => cell.trim());
    if (cells.length < 12) continue;
    const isNewShape = cells.length >= 14;
    rows.push({
      consumer: unescapeCell(cells[1] ?? ""),
      provider: unescapeCell(cells[2] ?? ""),
      model: unescapeCell(cells[3] ?? ""),
      tokensIn: cells[6] ?? "",
      tokensOut: cells[7] ?? "",
      costUsd: cells[9] ?? "",
      referencesStripped: isNewShape ? cells[10] ?? "" : "",
    });
  }
  return rows;
}

function formatOptionalNumber(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : "";
}

function parseOptionalNumber(value: string): number | undefined {
  if (value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function escapeCell(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function unescapeCell(value: string): string {
  return value.replace(/\\\|/g, "|").replace(/\\\\/g, "\\");
}

function dateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function emptySummary(): LLMAuditSummary {
  return {
    totalCalls: 0,
    totalCostUsd: 0,
    byConsumer: [],
    byProviderModel: [],
  };
}

function sortByCallsThenName<T extends { calls: number }>(
  nameKey: keyof T,
): (a: T, b: T) => number {
  return (a, b) => b.calls - a.calls || String(a[nameKey]).localeCompare(String(b[nameKey]));
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: unknown }).code === "ENOENT"
    ) {
      return false;
    }
    throw error;
  }
}
