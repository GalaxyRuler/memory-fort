#!/usr/bin/env node
import { readFileSync, appendFileSync } from "node:fs";

// fd 0 is portable stdin across Linux/macOS/Windows
const raw = readFileSync(0, "utf-8").trim();
let report;
try {
  report = JSON.parse(raw);
} catch {
  process.stderr.write("ci-eval-summary: could not parse stdin as JSON\n");
  process.exit(1);
}

function buildRetrieval(r) {
  const rows = Object.entries(r.recall ?? {})
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([k, v]) => `| R@${k} | ${(v.withGraph * 100).toFixed(1)}% | ${(v.withoutGraph * 100).toFixed(1)}% |`)
    .join("\n");
  // mrr is {withGraph, withoutGraph} in RetrievalEvalReport; tolerate plain number too
  const mrrValue = typeof r.mrr === "number" ? r.mrr : r.mrr?.withGraph;
  const mrr = mrrValue != null ? `\nMRR: **${(mrrValue * 100).toFixed(1)}%**` : "";
  return `## Retrieval Eval\n\n| Metric | With graph | No graph |\n|---|---|---|\n${rows}\n${mrr}\n`;
}

function buildDispatch(r) {
  const rows = Object.entries(r.byType ?? {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([t, v]) => `| ${t} | ${v.correct}/${v.total} | ${(v.accuracy * 100).toFixed(1)}% |`)
    .join("\n");
  return `## Dispatch Policy Eval\n\nOverall: **${r.correct}/${r.total}** (${(r.accuracy * 100).toFixed(1)}%)\n\n| Type | Correct | Accuracy |\n|---|---|---|\n${rows}\n`;
}

// Detect report type by shape
const summary = report.recall != null ? buildRetrieval(report) : buildDispatch(report);

const summaryFile = process.env["GITHUB_STEP_SUMMARY"];
if (summaryFile) appendFileSync(summaryFile, summary);
// Always print markdown, even locally
process.stdout.write(summary);
