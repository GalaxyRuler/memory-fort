import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { formatLongMemEvalMarkdown } from "../../eval/longmemeval/report-markdown.js";
import { runLongMemEval } from "../../eval/longmemeval/runner.js";
import type {
  LongMemEvalReport,
  RunLongMemEvalOptions,
} from "../../eval/longmemeval/types.js";

export interface EvalLongMemEvalCliFlags {
  corpus?: string;
  dataset?: string;
  k?: string;
  limit?: string | number;
  baseline?: string | number;
  output?: string;
  markdown?: string;
  verbose?: boolean;
  cwd?: string;
  now?: () => Date;
  runner?: (opts: RunLongMemEvalOptions) => Promise<LongMemEvalReport>;
}

export interface ParsedEvalLongMemEvalOptions {
  vaultRoot: string;
  datasetPath: string;
  k: number[];
  limit?: number;
  baseline: number;
  outputPath: string;
  markdownPath: string;
  verbose: boolean;
}

export interface EvalLongMemEvalCliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  outputPath: string;
  markdownPath: string;
  report: LongMemEvalReport;
}

export function parseEvalLongMemEvalOptions(
  flags: EvalLongMemEvalCliFlags = {},
  timestamp = timestampForPath((flags.now ?? (() => new Date()))()),
): ParsedEvalLongMemEvalOptions {
  const cwd = flags.cwd ?? process.cwd();
  const outputPath = flags.output ??
    join(cwd, "wiki", ".audit", `longmemeval-${timestamp}.json`);
  return {
    vaultRoot: flags.corpus ?? join(homedir(), ".memory"),
    datasetPath: flags.dataset ??
      join(homedir(), ".memory", "datasets", "longmemeval-s", "questions.jsonl"),
    k: parseK(flags.k ?? "1,5,10"),
    limit: parseOptionalInteger(flags.limit, "limit"),
    baseline: parseNumber(flags.baseline ?? 0.92, "baseline"),
    outputPath,
    markdownPath: flags.markdown ?? outputPath.replace(/\.json$/i, ".md"),
    verbose: flags.verbose === true,
  };
}

export async function runEvalLongMemEval(
  flags: EvalLongMemEvalCliFlags = {},
): Promise<EvalLongMemEvalCliResult> {
  const parsed = parseEvalLongMemEvalOptions(flags);
  const runner = flags.runner ?? runLongMemEval;
  const report = await runner({
    datasetPath: parsed.datasetPath,
    vaultRoot: parsed.vaultRoot,
    k: parsed.k,
    limit: parsed.limit,
  });
  const markdown = formatLongMemEvalMarkdown(report);

  await mkdir(dirname(parsed.outputPath), { recursive: true });
  await mkdir(dirname(parsed.markdownPath), { recursive: true });
  await writeFile(parsed.outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf-8");
  await writeFile(parsed.markdownPath, markdown, "utf-8");

  const summary = formatSummary(report);
  const verbose = parsed.verbose ? formatVerbose(report) : "";
  const recall5 = report.recall[5] ?? 0;
  const failed = recall5 < parsed.baseline;
  const stderr = failed
    ? `\x1b[31mRecall@5 ${formatRate(recall5)} fell below baseline ${formatRate(parsed.baseline)}\x1b[0m\n`
    : "";

  return {
    stdout: `${verbose}${summary}\n`,
    stderr,
    exitCode: failed ? 1 : 0,
    outputPath: parsed.outputPath,
    markdownPath: parsed.markdownPath,
    report,
  };
}

export function formatSummary(report: LongMemEvalReport): string {
  const rates = Object.entries(report.recall)
    .sort(([left], [right]) => Number(left) - Number(right))
    .map(([k, value]) => `R@${k}=${formatRate(value)}`)
    .join(" | ");
  return `LongMemEval-S | ${rates} | mean=${Math.round(report.meanLatencyMs)}ms | p95=${Math.round(report.p95LatencyMs)}ms | n=${report.questionCount}`;
}

function formatVerbose(report: LongMemEvalReport): string {
  return report.perQuestion
    .map((question) =>
      `[${question.questionId}] R@5=${question.hits[5] ? "hit" : "miss"} ${Math.round(question.latencyMs)}ms\n`,
    )
    .join("");
}

function parseK(value: string): number[] {
  const values = value.split(",").map((part) => {
    const parsed = Number(part.trim());
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new Error(`Invalid --k value: ${value}`);
    }
    return parsed;
  });
  return [...new Set(values)].sort((a, b) => a - b);
}

function parseOptionalInteger(
  value: string | number | undefined,
  label: string,
): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`Invalid --${label}: ${value}`);
  }
  return parsed;
}

function parseNumber(value: string | number, label: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid --${label}: ${value}`);
  }
  return parsed;
}

function formatRate(value: number): string {
  return value.toFixed(2);
}

function timestampForPath(date: Date): string {
  return date.toISOString().replace(/[:.]/g, "-");
}
