import { readFile as readFsFile } from "node:fs/promises";
import { join } from "node:path";
import { parseFrontmatter } from "../storage/frontmatter.js";
import { indexPath, memoryRoot as defaultMemoryRoot } from "../storage/paths.js";

export interface ConfidenceAwareIndexOptions {
  indexFilePath?: string;
  memoryRoot?: string;
  readFile?: (path: string) => Promise<string>;
}

interface BucketedEntry {
  confidence: number;
  line: string;
}

const DEFAULT_CONFIDENCE = 0.5;
const WIKI_CATEGORIES = new Set([
  "projects",
  "people",
  "decisions",
  "lessons",
  "references",
  "tools",
]);

export async function confidenceAwareIndex(
  opts: ConfidenceAwareIndexOptions = {},
): Promise<string> {
  const readFile =
    opts.readFile ?? ((path: string) => readFsFile(path, "utf-8"));
  const root = opts.memoryRoot ?? defaultMemoryRoot();
  const indexFile = opts.indexFilePath ?? indexPath();
  const indexContent = await readFile(indexFile);
  const floor = injectionConfidenceFloor();
  const buckets = {
    high: [] as BucketedEntry[],
    medium: [] as BucketedEntry[],
    low: [] as BucketedEntry[],
  };

  for (const line of indexContent.split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    const confidence = await confidenceForIndexLine(line, { readFile, root });
    if (confidence < floor) continue;
    if (confidence >= 0.8) buckets.high.push({ confidence, line });
    else if (confidence >= 0.5) buckets.medium.push({ confidence, line });
    else buckets.low.push({ confidence, line });
  }

  return formatBuckets(buckets, floor);
}

async function confidenceForIndexLine(
  line: string,
  deps: { readFile: (path: string) => Promise<string>; root: string },
): Promise<number> {
  const relPath = extractIndexedPagePath(line);
  if (!relPath) return DEFAULT_CONFIDENCE;

  try {
    const content = await deps.readFile(join(deps.root, relPath));
    const { frontmatter } = parseFrontmatter(content);
    return typeof frontmatter.confidence === "number"
      ? frontmatter.confidence
      : DEFAULT_CONFIDENCE;
  } catch {
    return DEFAULT_CONFIDENCE;
  }
}

function extractIndexedPagePath(line: string): string | null {
  const wikiLink = line.match(/\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/);
  const markdownLink = line.match(/\]\(([^)#]+)(?:#[^)]+)?\)/);
  const barePath = line.match(
    /\b((?:wiki|crystals|projects|people|decisions|lessons|references|tools)\/[^\s)`]+(?:\.md)?)\b/,
  );
  const rawPath = wikiLink?.[1] ?? markdownLink?.[1] ?? barePath?.[1];
  if (!rawPath) return null;

  let normalized = rawPath.replace(/\\/g, "/").replace(/^\.\//, "");
  normalized = normalized.replace(/^\/+/, "").replace(/#.*$/, "");
  if (normalized.length === 0) return null;
  if (!normalized.endsWith(".md")) normalized = `${normalized}.md`;

  const firstSegment = normalized.split("/")[0];
  if (firstSegment && WIKI_CATEGORIES.has(firstSegment)) {
    return `wiki/${normalized}`;
  }
  if (normalized.startsWith("wiki/") || normalized.startsWith("crystals/")) {
    return normalized;
  }

  return null;
}

function injectionConfidenceFloor(): number {
  const raw = process.env["MEMORY_FORT_INJECTION_CONF_FLOOR"];
  if (!raw) return 0;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : 0;
}

function formatBuckets(
  buckets: {
    high: BucketedEntry[];
    medium: BucketedEntry[];
    low: BucketedEntry[];
  },
  floor: number,
): string {
  const sections: string[] = [];
  if (floor < 1 || buckets.high.length > 0) {
    sections.push(formatSection("High-confidence entries", buckets.high));
  }
  if (floor < 0.8 || buckets.medium.length > 0) {
    sections.push(formatSection("Medium-confidence entries", buckets.medium));
  }
  if (floor < 0.5 || buckets.low.length > 0) {
    sections.push(
      formatSection(
        "Low-confidence / drafts",
        buckets.low.map((entry) => ({
          ...entry,
          line: `⚠ DRAFT: ${entry.line}`,
        })),
      ),
    );
  }
  return sections.join("\n\n");
}

function formatSection(label: string, entries: BucketedEntry[]): string {
  return `--- ${label} (${entries.length}) ---\n${entries
    .map((entry) => entry.line)
    .join("\n")}`;
}
