import { homedir } from "node:os";
import { join } from "node:path";
import {
  runRetrievalEval,
  type RunRetrievalEvalOptions,
} from "../../eval/retrieval/runner.js";
import type { RetrievalEvalReport } from "../../eval/retrieval/types.js";

export interface EvalRetrievalCliFlags {
  corpus?: string;
  gold?: string;
  k?: string;
  limit?: string | number;
  json?: boolean;
  cwd?: string;
  runner?: (opts: RunRetrievalEvalOptions) => Promise<RetrievalEvalReport>;
}

export interface ParsedEvalRetrievalOptions {
  vaultRoot: string;
  goldPath: string;
  k: number[];
  limit?: number;
  json: boolean;
}

export interface EvalRetrievalCliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  report: RetrievalEvalReport;
}

export function parseEvalRetrievalOptions(flags: EvalRetrievalCliFlags = {}): ParsedEvalRetrievalOptions {
  const cwd = flags.cwd ?? process.cwd();
  return {
    vaultRoot: flags.corpus ?? join(homedir(), ".memory"),
    goldPath: flags.gold ?? join(cwd, "qa", "retrieval-gold.jsonl"),
    k: parseK(flags.k ?? "5,10"),
    limit: parseOptionalInteger(flags.limit, "limit"),
    json: flags.json === true,
  };
}

export async function runEvalRetrieval(flags: EvalRetrievalCliFlags = {}): Promise<EvalRetrievalCliResult> {
  const parsed = parseEvalRetrievalOptions(flags);
  const runner = flags.runner ?? runRetrievalEval;
  const report = await runner({
    vaultRoot: parsed.vaultRoot,
    goldPath: parsed.goldPath,
    k: parsed.k,
    limit: parsed.limit,
  });
  const stdout = parsed.json
    ? `${JSON.stringify(report, null, 2)}\n`
    : `${formatRetrievalEvalSummary(report)}\n`;
  const lift5 = report.graphLift[5] ?? 0;
  const failed = lift5 <= 0;
  const stderr = failed
    ? `\x1b[31mGraph lift@5 ${formatRate(lift5)} is not positive; graph-spread is decorative or harmful on this gold set.\x1b[0m\n`
    : "";

  return {
    stdout,
    stderr,
    exitCode: failed ? 1 : 0,
    report,
  };
}

export function formatRetrievalEvalSummary(report: RetrievalEvalReport): string {
  const rates = Object.entries(report.recall)
    .sort(([left], [right]) => Number(left) - Number(right))
    .map(([k, value]) =>
      `R@${k}=${formatRate(value.withGraph)} no-graph=${formatRate(value.withoutGraph)} lift=${formatRate(report.graphLift[Number(k)] ?? 0)}`,
    )
    .join(" | ");
  const byType = Object.entries(report.byType)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([type, value]) => {
      const recall5 = value.recall[5];
      return `${type}: n=${value.questionCount} R@5=${formatRate(recall5?.withGraph ?? 0)} lift=${formatRate(value.graphLift[5] ?? 0)}`;
    })
    .join(" | ");
  return [
    `Retrieval gold | ${rates} | MRR=${formatRate(report.mrr.withGraph)} no-graph=${formatRate(report.mrr.withoutGraph)} | n=${report.questionCount}`,
    byType ? `By type | ${byType}` : "",
  ].filter((line) => line.length > 0).join("\n");
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

function formatRate(value: number): string {
  return value.toFixed(2);
}
