import { join } from "node:path";
import { runDispatchPolicyEval } from "../../eval/dispatch/runner.js";
import type { DispatchPolicyEvalReport } from "../../eval/dispatch/types.js";

export interface EvalDispatchCliFlags {
  gold?: string;
  json?: boolean;
  cwd?: string;
}

export interface EvalDispatchCliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  report: DispatchPolicyEvalReport;
}

export async function runEvalDispatch(
  flags: EvalDispatchCliFlags = {},
): Promise<EvalDispatchCliResult> {
  const cwd = flags.cwd ?? process.cwd();
  const goldPath = flags.gold ?? join(cwd, "qa", "dispatch-gold.jsonl");
  const report = await runDispatchPolicyEval({ goldPath });

  const stdout = flags.json
    ? `${JSON.stringify(report, null, 2)}\n`
    : `${formatDispatchEvalSummary(report)}\n`;

  // Policy truth-table eval: anything below 100% means the mapping drifted.
  const failed = report.accuracy < 1;
  const stderr = failed
    ? `dispatch policy accuracy ${(report.accuracy * 100).toFixed(1)}% — classifyDispatch truth table drifted from gold\n`
    : "";

  return { stdout, stderr, exitCode: failed ? 1 : 0, report };
}

export function formatDispatchEvalSummary(report: DispatchPolicyEvalReport): string {
  const byType = Object.entries(report.byType)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([type, value]) => `${type}: ${value.correct}/${value.total}`)
    .join(" | ");
  const failures = report.results
    .filter((r) => !r.correct)
    .map((r) => `  FAIL ${r.scenario}: expected ${r.expected}, got ${r.got}`);
  return [
    `Dispatch policy | ${report.correct}/${report.total} (${(report.accuracy * 100).toFixed(1)}%) | ${byType}`,
    ...failures,
  ].join("\n");
}
