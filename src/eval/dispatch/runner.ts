import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { classifyDispatch } from "../../compile/fact-dispatch.js";
import type {
  DispatchPolicyGoldEntry,
  DispatchPolicyEvalReport,
  DispatchPolicyEvalResult,
} from "./types.js";

export interface RunDispatchPolicyEvalOptions {
  goldPath: string;
}

function goldTypeToConflictType(type: DispatchPolicyGoldEntry["type"]): string {
  switch (type) {
    case "noop":
    case "duplicate":
      return "noop";
    case "contradiction":
      return "contradiction";
    case "supersession":
      return "supersession";
    case "novel":
      return "novel";
  }
}

async function loadGold(goldPath: string): Promise<DispatchPolicyGoldEntry[]> {
  const entries: DispatchPolicyGoldEntry[] = [];
  const rl = createInterface({ input: createReadStream(goldPath), crlfDelay: Infinity });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    entries.push(JSON.parse(trimmed) as DispatchPolicyGoldEntry);
  }
  return entries;
}

function evaluateEntry(entry: DispatchPolicyGoldEntry): DispatchPolicyEvalResult {
  let got: string;

  if (entry.type === "novel" || !entry.existing_page) {
    got = "write_page";
  } else {
    const conflictType = entry.conflict_type ?? goldTypeToConflictType(entry.type);
    const result = classifyDispatch({
      similarity: entry.similarity ?? 0.85,
      threshold: 0.8,
      existingPageDate: "2025-01-01",
      newSessionDate: "2026-06-09",
      conflictType,
    });
    got = result.kind;
  }

  return {
    scenario: entry.scenario,
    type: entry.type,
    expected: entry.expected_op,
    got,
    correct: got === entry.expected_op,
  };
}

export async function runDispatchPolicyEval(
  opts: RunDispatchPolicyEvalOptions,
): Promise<DispatchPolicyEvalReport> {
  const gold = await loadGold(opts.goldPath);
  const results = gold.map(evaluateEntry);

  const total = results.length;
  const correct = results.filter((r) => r.correct).length;
  const accuracy = total > 0 ? correct / total : 0;

  const byTypeMap: Record<string, { total: number; correct: number }> = {};
  for (const r of results) {
    if (!byTypeMap[r.type]) byTypeMap[r.type] = { total: 0, correct: 0 };
    byTypeMap[r.type]!.total += 1;
    if (r.correct) byTypeMap[r.type]!.correct += 1;
  }
  const byType: Record<string, { total: number; correct: number; accuracy: number }> = {};
  for (const [type, counts] of Object.entries(byTypeMap)) {
    byType[type] = { ...counts, accuracy: counts.total > 0 ? counts.correct / counts.total : 0 };
  }

  return { total, correct, accuracy, byType, results };
}
