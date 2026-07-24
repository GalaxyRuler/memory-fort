import { existsSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { hasArchiveOrSystemPathComponent } from "./archive-paths.js";

export interface RawFileEntry {
  fullPath: string;
  relPath: string;
  size: number;
  mtimeMs: number;
}

/**
 * Walk `raw/` for markdown files, skipping every dot entry (directories AND
 * files). Dot space under `raw/` is system space: compact-raw's
 * `.compact-archive/` holds pre-truncation originals with fresh relPaths and no
 * compile/compress watermarks — feeding them back into the pipeline means paid
 * duplicate re-processing. Sharing one excluding walker keeps every raw consumer
 * consistent (compile, compress, pending-summary, link-raw, and the sniffer's
 * dedup scan — the live file keeps its `capture_hash` frontmatter through
 * compaction, so the archive copy is not needed to dedup normal captures).
 */
export async function listRawMarkdownFiles(vaultRoot: string): Promise<RawFileEntry[]> {
  const rawRoot = join(vaultRoot, "raw");
  if (!existsSync(rawRoot)) return [];
  const files: RawFileEntry[] = [];

  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      const relPath = relative(vaultRoot, fullPath).replace(/\\/g, "/");
      if (hasArchiveOrSystemPathComponent(relPath)) continue;
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        const info = await stat(fullPath);
        files.push({
          fullPath,
          relPath,
          size: info.size,
          mtimeMs: info.mtimeMs,
        });
      }
    }
  }

  await walk(rawRoot);
  return files.sort((a, b) => a.relPath.localeCompare(b.relPath));
}
