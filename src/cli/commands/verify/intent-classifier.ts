import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fail, pass, warn, type CheckDescriptor, type VerifyCheckResult } from "./types.js";

export const intentClassifierHealthCheck: CheckDescriptor = {
  id: "retrieval.intent-classifier-health",
  label: "query intent classifier",
  roles: ["operator", "server"],
  run: async (ctx) => checkIntentClassifierHealth(ctx.vaultRoot, ctx.now()),
};

interface IntentAuditStats {
  total: number;
  errors: number;
}

const WINDOW_DAYS = 7;

export async function checkIntentClassifierHealth(
  vaultRoot: string,
  now: Date,
): Promise<VerifyCheckResult> {
  const stats = await readRecentIntentAuditStats(vaultRoot, now);
  if (stats.total === 0) {
    return pass(
      "retrieval.intent-classifier-health",
      "query intent classifier",
      "no query-intent-classify LLM calls in the last 7 days; heuristic/fallback path healthy by default",
    );
  }

  const errorRate = stats.errors / stats.total;
  const detail = [
    `llm calls: ${stats.total}`,
    "heuristic rate: not persisted",
    "llm rate: tracked as LLM call volume",
    `error rate: ${(errorRate * 100).toFixed(1)}%`,
  ].join("; ");

  if (stats.total >= 20 && errorRate > 0.1) {
    return fail(
      "retrieval.intent-classifier-health",
      "query intent classifier",
      "inspect wiki/.audit/llm-*.md for query-intent-classify errors",
      detail,
    );
  }

  if (stats.total >= 50) {
    return warn(
      "retrieval.intent-classifier-health",
      "query intent classifier",
      detail,
      "tune query intent heuristics",
    );
  }

  return pass(
    "retrieval.intent-classifier-health",
    "query intent classifier",
    detail,
  );
}

async function readRecentIntentAuditStats(vaultRoot: string, now: Date): Promise<IntentAuditStats> {
  const auditDir = join(vaultRoot, "wiki", ".audit");
  let entries;
  try {
    entries = await readdir(auditDir, { withFileTypes: true });
  } catch {
    return { total: 0, errors: 0 };
  }

  const minTime = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
  ) - (WINDOW_DAYS - 1) * 24 * 60 * 60 * 1000;
  const stats = { total: 0, errors: 0 };

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const match = /^llm-(\d{4}-\d{2}-\d{2})\.md$/.exec(entry.name);
    if (!match) continue;
    const fileTime = Date.parse(`${match[1]}T00:00:00.000Z`);
    if (!Number.isFinite(fileTime) || fileTime < minTime) continue;
    collectRows(await readFile(join(auditDir, entry.name), "utf-8"), stats);
  }

  return stats;
}

function collectRows(text: string, stats: IntentAuditStats): void {
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("| ") || line.includes("---") || line.startsWith("| ts ")) continue;
    const cells = line.split("|").slice(1, -1).map((cell) => cell.trim());
    if (cells.length < 12) continue;
    const consumer = unescapeCell(cells[1] ?? "");
    if (consumer !== "query-intent-classify") continue;
    stats.total += 1;
    const finish = cells[10] ?? "";
    const error = unescapeCell(cells[11] ?? "");
    if (finish === "error" || error.length > 0) stats.errors += 1;
  }
}

function unescapeCell(value: string): string {
  return value.replace(/\\\|/g, "|").replace(/\\\\/g, "\\");
}
