import { memoryRoot } from "../../storage/paths.js";
import {
  runConsolidatePlan,
  type ConsolidateOptions,
  type ConsolidateResult,
} from "../../consolidate/runner.js";

export type { ConsolidatePlan, ConsolidateResult } from "../../consolidate/runner.js";

export interface RunConsolidateOptions {
  plan: boolean;
  apply?: boolean;
  minConfidence?: number;
  maxLinksPerObservation?: number;
  corpusRoot?: string;
  force?: boolean;
  now?: Date;
}

export async function runConsolidate(
  opts: RunConsolidateOptions,
): Promise<ConsolidateResult> {
  const runnerOptions: ConsolidateOptions = {
    plan: opts.plan,
    minConfidence: opts.minConfidence,
    maxLinksPerObservation: opts.maxLinksPerObservation,
    corpusRoot: opts.corpusRoot ?? memoryRoot(),
    force: opts.force,
    now: opts.now,
  };
  return runConsolidatePlan(runnerOptions);
}

export function formatConsolidateResult(result: ConsolidateResult): string {
  const lines = [
    `Memory consolidate ${result.mode}`,
    `scanned: ${result.summary.scanned}`,
    `proposed observations: ${result.summary.proposed}`,
    `proposed edges: ${result.summary.proposedEdges}`,
    `updated: ${result.summary.updated}`,
    `new edges: ${result.summary.newEdges}`,
  ];
  if (result.auditLogPath) lines.push(`audit: ${result.auditLogPath}`);
  lines.push("");

  for (const plan of result.plans.filter((item) => item.willWrite).slice(0, 20)) {
    lines.push(`${plan.observation}: ${plan.proposedRelations.length} ${plural(plan.proposedRelations.length, "relation")}`);
    for (const relation of plan.proposedRelations) {
      lines.push(`- ${relation.title} -> ${relation.relPath} (${relation.source}, ${relation.confidence.toFixed(2)})`);
    }
  }
  const remaining = result.plans.filter((item) => item.willWrite).length - 20;
  if (remaining > 0) lines.push(`... ${remaining} more observations with proposed relations`);
  return `${lines.join("\n")}\n`;
}

function plural(count: number, noun: string): string {
  return count === 1 ? noun : `${noun}s`;
}
