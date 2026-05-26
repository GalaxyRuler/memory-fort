import type { LongMemEvalReport } from "./types.js";

export function formatLongMemEvalMarkdown(report: LongMemEvalReport): string {
  const lines = [
    `# LongMemEval-S Evaluation - ${report.startedAt}`,
    "",
    "| Metric | Value |",
    "|---|---|",
    `| Questions | ${report.questionCount} |`,
    ...Object.entries(report.recall)
      .sort(([left], [right]) => Number(left) - Number(right))
      .map(([k, value]) => `| R@${k} | ${formatRate(value)} |`),
    `| Mean latency | ${Math.round(report.meanLatencyMs)}ms |`,
    `| P95 latency | ${Math.round(report.p95LatencyMs)}ms |`,
    `| Duration | ${formatSeconds(report.durationMs)}s |`,
    `| Dataset version | ${escapeCell(report.datasetVersion)} |`,
    `| Vault root | ${escapeCell(report.vaultRoot)} |`,
    "",
  ];

  const misses = report.perQuestion.filter((question) => question.hits[5] === false);
  lines.push(`## Failures (R@5 misses, ${misses.length} total)`, "");
  if (misses.length === 0) {
    lines.push("No R@5 misses.", "");
  } else {
    for (const question of misses) {
      lines.push(
        `- [${question.questionId}] "${question.question}"`,
        `  - Expected: ${question.expected.join(", ")}`,
        `  - Retrieved: [${question.retrieved.join(", ")}]`,
        "",
      );
    }
  }

  lines.push("## Per Question", "");
  for (const question of report.perQuestion) {
    lines.push(
      `- [${question.questionId}] R@5=${question.hits[5] ? "hit" : "miss"} ${Math.round(question.latencyMs)}ms`,
    );
  }
  lines.push("");

  return lines.join("\n");
}

function formatRate(value: number): string {
  return value.toFixed(2);
}

function formatSeconds(ms: number): string {
  return (ms / 1000).toFixed(1);
}

function escapeCell(value: string): string {
  return value.replace(/\|/g, "\\|");
}
