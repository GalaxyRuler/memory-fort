import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { pass, warn, type CheckDescriptor, type VerifyCheckResult, type RunCheckOptions } from "./types.js";

const EMBEDDING_FILES: Array<{ kind: string; filename: string }> = [
  { kind: "wiki", filename: "wiki.embeddings.jsonl" },
  { kind: "raw", filename: "raw.embeddings.jsonl" },
  { kind: "crystal", filename: "crystal.embeddings.jsonl" },
];

export const embeddingsIntegrityCheck: CheckDescriptor = {
  id: "retrieval.embeddings-integrity",
  label: "embedding sidecar files are well-formed JSONL",
  roles: ["operator"],
  run: checkEmbeddingsIntegrity,
};

export async function checkEmbeddingsIntegrity(ctx: RunCheckOptions): Promise<VerifyCheckResult> {
  const malformed: string[] = [];
  let totalLines = 0;

  for (const { kind, filename } of EMBEDDING_FILES) {
    const path = join(ctx.vaultRoot, "embeddings", filename);
    if (!existsSync(path)) continue;

    let content: string;
    try {
      content = await readFile(path, "utf-8");
    } catch {
      malformed.push(`${kind}: unreadable`);
      continue;
    }

    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line.length === 0) continue;
      totalLines++;
      try {
        JSON.parse(line);
      } catch {
        malformed.push(`${kind}:${i + 1}`);
      }
    }
  }

  if (malformed.length === 0) {
    const detail = totalLines > 0 ? `${totalLines} lines parsed OK` : undefined;
    return pass("retrieval.embeddings-integrity", "embedding sidecar files are well-formed JSONL", detail);
  }

  const shown = malformed.slice(0, 10).join(", ");
  const suffix = malformed.length > 10 ? ` (+${malformed.length - 10} more)` : "";
  return warn(
    "retrieval.embeddings-integrity",
    `${malformed.length} malformed line(s) in embedding sidecars`,
    `${shown}${suffix}`,
    "run `memory provider reindex-embeddings --apply` to rebuild sidecars",
  );
}
