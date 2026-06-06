import { isDebugLogEnabled } from "../llm/audit.js";

export function debugLogBannerLines(opts: {
  env?: NodeJS.ProcessEnv;
  now?: Date;
} = {}): string[] {
  if (!isDebugLogEnabled(opts.env)) return [];
  const date = (opts.now ?? new Date()).toISOString().slice(0, 10);
  return [
    `⚠️  MEMORY_LLM_DEBUG_LOG=1 — prompt/response plaintext is being persisted to ~/.memory/wiki/.audit/llm-debug-${date}.md`,
    "⚠️  Disable with `unset MEMORY_LLM_DEBUG_LOG` (POSIX) or `Remove-Item Env:MEMORY_LLM_DEBUG_LOG` (PowerShell)",
  ];
}

export function printDebugLogBanner(opts: {
  env?: NodeJS.ProcessEnv;
  now?: Date;
  write?: (text: string) => void;
} = {}): void {
  const lines = debugLogBannerLines(opts);
  if (lines.length === 0) return;
  (opts.write ?? ((text) => process.stderr.write(text)))(`${lines.join("\n")}\n`);
}
