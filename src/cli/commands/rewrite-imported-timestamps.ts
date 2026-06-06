import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { observedDateFromAgentMemoryKey, uuidv7ToTimestamp } from "../../migration/uuidv7-timestamp.js";
import { formatIsoDate } from "../../storage/paths.js";
import { atomicWrite } from "../../storage/atomic-write.js";
import { parseFrontmatter, serializeFrontmatter } from "../../storage/frontmatter.js";
import { memoryRoot } from "../../storage/paths.js";

export interface RewriteImportedTimestampsResult {
  scanned: number;
  updated: number;
  skippedExisting: number;
  skippedNoTimestamp: number;
}

export async function runRewriteImportedTimestamps(
  opts: { root?: string } = {},
): Promise<RewriteImportedTimestampsResult> {
  const root = opts.root ?? memoryRoot();
  const files = await listMarkdownFiles(root, ["raw", "wiki", "crystals"]);
  const result: RewriteImportedTimestampsResult = {
    scanned: 0,
    updated: 0,
    skippedExisting: 0,
    skippedNoTimestamp: 0,
  };

  for (const file of files) {
    const content = await readFile(file, "utf-8");
    const parsed = parseFrontmatter(content);
    const frontmatter = parsed.frontmatter as Record<string, unknown>;
    const importedFrom = frontmatter["imported_from"];
    if (!isRecord(importedFrom)) continue;
    if (importedFrom["system"] !== "agentmemory") continue;

    result.scanned += 1;
    if (typeof frontmatter["observed_at"] === "string" && frontmatter["observed_at"].length > 0) {
      result.skippedExisting += 1;
      continue;
    }

    const originalKey = typeof importedFrom["original_key"] === "string" ? importedFrom["original_key"] : "";
    let observedAt = observedDateFromAgentMemoryKey(originalKey);

    // Fallback: many imports have a clean UUIDv7 in the `session` field.
    if (!observedAt && typeof frontmatter["session"] === "string") {
      const sessionDate = uuidv7ToTimestamp(frontmatter["session"]);
      if (sessionDate) observedAt = formatIsoDate(sessionDate);
    }

    if (!observedAt) {
      result.skippedNoTimestamp += 1;
      continue;
    }

    await atomicWrite(
      file,
      serializeFrontmatter(
        {
          ...parsed.frontmatter,
          observed_at: observedAt,
        },
        parsed.body,
      ),
    );
    result.updated += 1;
  }

  return result;
}

export function formatRewriteImportedTimestampsResult(result: RewriteImportedTimestampsResult): string {
  return [
    "Memory rewrite-imported-timestamps",
    `scanned: ${result.scanned}`,
    `updated: ${result.updated}`,
    `skipped-existing: ${result.skippedExisting}`,
    `skipped-no-timestamp: ${result.skippedNoTimestamp}`,
    "",
  ].join("\n");
}

async function listMarkdownFiles(root: string, topDirs: string[]): Promise<string[]> {
  const files: string[] = [];
  async function walk(dir: string): Promise<void> {
    if (!existsSync(dir)) return;
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) await walk(fullPath);
      else if (entry.isFile() && entry.name.endsWith(".md")) files.push(fullPath);
    }
  }
  for (const topDir of topDirs) await walk(join(root, topDir));
  return files.sort();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
