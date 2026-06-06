import { copyBundledPrompt, listPromptSyncActions, type PromptSyncAction } from "../../prompts/runtime.js";
import { memoryRoot } from "../../storage/paths.js";

export interface SyncPromptsOptions {
  vaultRoot?: string;
  sourceRepoDir?: string;
  plan?: boolean;
  apply?: boolean;
}

export interface SyncPromptsResult {
  mode: "plan" | "apply";
  actions: PromptSyncAction[];
}

export async function runSyncPrompts(opts: SyncPromptsOptions = {}): Promise<SyncPromptsResult> {
  const root = opts.vaultRoot ?? memoryRoot();
  const mode = opts.apply ? "apply" : "plan";
  const actionsWithContent = await listPromptSyncActions({
    vaultRoot: root,
    sourceRepoDir: opts.sourceRepoDir,
  });
  if (mode === "apply") {
    for (const action of actionsWithContent) {
      await copyBundledPrompt({ vaultRoot: root, action });
    }
  }
  return {
    mode,
    actions: actionsWithContent.map(({ content: _content, ...action }) => action),
  };
}

export function formatSyncPromptsResult(result: SyncPromptsResult): string {
  const lines = [
    `Sync prompts ${result.mode} complete`,
    `  prompts: ${result.actions.length}`,
  ];
  for (const action of result.actions) {
    lines.push(`  - ${action.action}: ${action.path}`);
  }
  return `${lines.join("\n")}\n`;
}
