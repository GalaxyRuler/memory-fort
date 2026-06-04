import { basename } from "node:path";

export interface NextStepsOptions {
  vault: string;
  bin?: string;
}

export function formatNextSteps(opts: NextStepsOptions): string {
  const bin = opts.bin ?? deriveBinName();
  return [
    "",
    "Next steps:",
    `  Vault:            ${opts.vault}`,
    `  Verify it works:  ${bin} doctor`,
    `  Search now:       ${bin} grep "<term>"`,
    `  Browse + search:  ${bin} dashboard`,
    "  Embeddings and LLMs are optional; enable them later with env vars and config.yaml.",
    "",
  ].join("\n");
}

export function deriveBinName(argv = process.argv): string {
  const raw = argv[1]?.trim();
  if (!raw) return "memory";
  const name = basename(raw)
    .replace(/\.(cmd|ps1|bat|exe|mjs|cjs|js)$/iu, "")
    .trim();
  return name.length > 0 && name !== "cli" ? name : "memory";
}
