import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  readAgentMemoryKvStore,
  readAgentMemoryStoreDir,
} from "../../migration/agentmemory-kv-reader.js";
import {
  applyAgentMemoryImportPlan,
  formatAgentMemoryImportReport,
  planAgentMemoryImport,
} from "../../migration/map-agentmemory.js";
import { memoryRoot } from "../../storage/paths.js";
import {
  formatConsolidateResult,
  runConsolidate,
  type ConsolidateResult,
  type RunConsolidateOptions,
} from "./consolidate.js";

export interface ImportAgentMemoryOptions {
  from: string;
  mode: "plan" | "apply";
  now?: Date;
  consolidateAfter?: boolean;
  consolidateFn?: (opts: RunConsolidateOptions) => Promise<ConsolidateResult>;
}

export interface ImportAgentMemoryResult {
  report: string;
  consolidate?: ConsolidateResult;
}

export async function runImportAgentMemory(
  opts: ImportAgentMemoryOptions,
): Promise<ImportAgentMemoryResult> {
  const entries = opts.from.endsWith("state_store.db")
    ? await readAgentMemoryKvStore(resolveStateStoreDir(opts.from))
    : await readAgentMemoryStoreDir(opts.from);
  const plan = await planAgentMemoryImport({ entries, now: opts.now });

  if (opts.mode === "plan") {
    return { report: formatAgentMemoryImportReport("plan", plan) };
  }

  const result = await applyAgentMemoryImportPlan(plan, { now: opts.now });
  const consolidate = opts.consolidateAfter
    ? await (opts.consolidateFn ?? runConsolidate)({
        plan: false,
        corpusRoot: memoryRoot(),
        now: opts.now,
      })
    : undefined;
  const report = formatAgentMemoryImportReport("apply", plan, result.auditLogPath);
  return {
    report: consolidate ? `${report}\n${formatConsolidateResult(consolidate)}` : report,
    consolidate,
  };
}

function resolveStateStoreDir(from: string): string {
  const direct = from.endsWith("state_store.db") ? from : join(from, "state_store.db");
  if (!existsSync(direct)) {
    throw new Error(`memory import-agentmemory: state_store.db not found at ${direct}`);
  }
  return direct;
}
