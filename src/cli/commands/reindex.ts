import { memoryRoot } from "../../storage/paths.js";
import { rebuildIndex, type RebuildIndexResult } from "../../compile/index.js";

export interface ReindexOptions {
  vaultRoot?: string;
  plan?: boolean;
}

export async function runReindex(opts: ReindexOptions = {}): Promise<RebuildIndexResult> {
  return rebuildIndex(opts.vaultRoot ?? memoryRoot(), { plan: opts.plan });
}

export function formatReindexResult(result: RebuildIndexResult, opts: { plan?: boolean } = {}): string {
  const mode = opts.plan ? "plan" : "apply";
  const action = result.changed
    ? opts.plan ? "would rewrite" : "rewrote"
    : "unchanged";
  return [
    `Reindex ${mode} complete`,
    `  index:   ${action}`,
    `  entries: ${result.entries}`,
    `  path:    ${result.path}`,
    "",
  ].join("\n");
}
