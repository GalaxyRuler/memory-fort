import { existsSync } from "node:fs";
import { mkdir, readFile, readdir } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { atomicWrite } from "../../storage/atomic-write.js";
import { parseFrontmatter, serializeFrontmatter } from "../../storage/frontmatter.js";
import { memoryRoot } from "../../storage/paths.js";
import { isNarrativeKnowledgePagePath, moveToArchive } from "../../compile/synthesize-narrative.js";

export type DecayMode = "plan" | "apply";

export interface DecayOptions {
  vaultRoot?: string;
  mode: DecayMode;
  now?: Date;
}

export interface DecayEntry {
  path: string;
  from: number;
  to: number;
  periods: number;
}

export interface DecayResult {
  mode: DecayMode;
  decayed: DecayEntry[];
  archived: Array<{ from: string; to: string }>;
  moved: Array<{ from: string; to: string }>;
  skippedPinned: string[];
  auditLogPath?: string;
  report: string;
}

const DECAY_PERIOD_DAYS = 14;
const ARCHIVE_AFTER_DAYS = 180;
const DEFAULT_STRENGTH = 8;

export async function runDecay(opts: DecayOptions): Promise<DecayResult> {
  const root = opts.vaultRoot ?? memoryRoot();
  const now = opts.now ?? new Date();
  const archiveDate = isoDate(now);
  const pages = await listNarrativePages(root);
  const decayed: DecayEntry[] = [];
  const archived: Array<{ from: string; to: string }> = [];
  const moved: Array<{ from: string; to: string }> = [];
  const skippedPinned: string[] = [];
  let auditLogPath: string | undefined;

  for (const relPath of pages) {
    const fullPath = join(root, ...relPath.split("/"));
    const content = await readFile(fullPath, "utf-8");
    const parsed = parseFrontmatter(content);
    const lastAccessed = readDate(parsed.frontmatter.last_accessed) ?? readDate(parsed.frontmatter.updated);
    if (!lastAccessed) continue;
    const days = Math.floor((now.getTime() - lastAccessed.getTime()) / (24 * 60 * 60 * 1000));
    const periods = Math.floor(days / DECAY_PERIOD_DAYS);
    const currentStrength = typeof parsed.frontmatter.strength === "number" ? parsed.frontmatter.strength : DEFAULT_STRENGTH;
    const nextStrength = roundStrength(currentStrength * Math.pow(0.9, periods));
    const shouldArchive = nextStrength < 1 && days >= ARCHIVE_AFTER_DAYS;
    if (shouldArchive && parsed.frontmatter.pinned === true) {
      skippedPinned.push(relPath);
      continue;
    }
    if (periods > 0) {
      decayed.push({ path: relPath, from: currentStrength, to: nextStrength, periods });
    }
    if (shouldArchive) {
      const to = `wiki/.archive/${archiveDate}/${relPath}`;
      archived.push({ from: relPath, to });
      if (opts.mode === "apply") {
        moved.push(await moveToArchive(root, relPath, archiveDate));
      }
      continue;
    }
    if (opts.mode === "apply" && periods > 0 && nextStrength !== currentStrength) {
      await mkdir(dirname(fullPath), { recursive: true });
      await atomicWrite(fullPath, serializeFrontmatter({
        ...parsed.frontmatter,
        strength: nextStrength,
      }, parsed.body));
    }
  }

  if (opts.mode === "apply" && (decayed.length > 0 || moved.length > 0 || skippedPinned.length > 0)) {
    auditLogPath = await writeDecayAudit(root, now, decayed, moved, skippedPinned);
  }

  return {
    mode: opts.mode,
    decayed,
    archived,
    moved,
    skippedPinned,
    ...(auditLogPath ? { auditLogPath } : {}),
    report: formatDecayReport(opts.mode, decayed, archived, skippedPinned),
  };
}

async function listNarrativePages(root: string): Promise<string[]> {
  const wikiRoot = join(root, "wiki");
  if (!existsSync(wikiRoot)) return [];
  const pages: string[] = [];
  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const fullPath = join(dir, entry.name);
      const rel = relative(wikiRoot, fullPath).replace(/\\/g, "/");
      if (entry.isDirectory()) {
        if (rel.split("/").some((part) => part.startsWith(".") || part.endsWith("-proposed") || part === "archive")) continue;
        await walk(fullPath);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        const relPath = `wiki/${rel}`;
        if (isNarrativeKnowledgePagePath(relPath)) pages.push(relPath);
      }
    }
  }
  await walk(wikiRoot);
  return pages.sort();
}

function formatDecayReport(
  mode: DecayMode,
  decayed: DecayEntry[],
  archived: Array<{ from: string; to: string }>,
  skippedPinned: string[],
): string {
  const lines = [`Decay ${mode}`];
  lines.push(`Decayed: ${decayed.length}`);
  for (const entry of decayed) {
    lines.push(`- ${entry.path}: ${entry.from} -> ${entry.to}`);
  }
  lines.push(`Archived: ${archived.length}`);
  for (const entry of archived) {
    lines.push(`- ${entry.from} -> ${entry.to}`);
  }
  if (skippedPinned.length > 0) {
    lines.push("Skipped pinned:");
    for (const item of skippedPinned) lines.push(`- ${item}`);
  }
  return `${lines.join("\n")}\n`;
}

function readDate(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function roundStrength(value: number): number {
  return Number(value.toFixed(6));
}

function isoDate(now: Date): string {
  return now.toISOString().slice(0, 10);
}

async function writeDecayAudit(
  root: string,
  now: Date,
  decayed: DecayEntry[],
  moved: Array<{ from: string; to: string }>,
  skippedPinned: string[],
): Promise<string> {
  const timestamp = now.toISOString().replace(/[:.]/g, "-");
  const auditLogPath = join(root, "wiki", ".audit", `decay-${timestamp}.md`);
  await mkdir(dirname(auditLogPath), { recursive: true });
  const lines = [
    "# decay audit",
    "",
    `run_at: ${now.toISOString()}`,
    "",
    "## decayed",
    ...decayed.map((entry) => `- ${entry.path}: ${entry.from} -> ${entry.to} (${entry.periods} periods)`),
    "",
    "## archived",
    ...moved.map((entry) => `- ${entry.from} -> ${entry.to}`),
    "",
    "## skipped pinned",
    ...skippedPinned.map((entry) => `- ${entry}`),
  ];
  await atomicWrite(auditLogPath, `${lines.join("\n")}\n`);
  return auditLogPath;
}
