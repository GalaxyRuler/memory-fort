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

export interface ImportAgentMemoryOptions {
  from: string;
  mode: "plan" | "apply";
  now?: Date;
}

export interface ImportAgentMemoryResult {
  report: string;
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
  return {
    report: formatAgentMemoryImportReport("apply", plan, result.auditLogPath),
  };
}

function resolveStateStoreDir(from: string): string {
  const direct = from.endsWith("state_store.db") ? from : join(from, "state_store.db");
  if (!existsSync(direct)) {
    throw new Error(`memory import-agentmemory: state_store.db not found at ${direct}`);
  }
  return direct;
}
