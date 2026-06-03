import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import {
  autoLinkRawToWiki,
  type AutoLinkMatch,
} from "../../capture/auto-link.js";
import { readRelations } from "../../retrieval/relations.js";
import { loadMemoryConfig, type MemoryConfig } from "../../storage/config.js";
import { parseFrontmatter } from "../../storage/frontmatter.js";
import { memoryRoot as defaultMemoryRoot } from "../../storage/paths.js";

export type LinkRawMode = "plan" | "apply";

export interface LinkRawOptions {
  vaultRoot?: string;
  mode?: LinkRawMode;
  threshold?: number;
  titleThreshold?: number;
  expectedEmbeddingDim?: number;
  massCollisionThreshold?: number;
  now?: Date;
  configLoader?: () => Promise<MemoryConfig>;
}

export interface LinkRawFileResult {
  path: string;
  outcome: "planned" | "linked" | "skipped";
  links: AutoLinkMatch[];
  reason?: string;
}

export interface LinkRawResult {
  mode: LinkRawMode;
  threshold: number;
  files: LinkRawFileResult[];
  summary: {
    scanned: number;
    orphaned: number;
    linked: number;
    written: number;
    skipped: number;
  };
}

const DEFAULT_THRESHOLD = 0.75;
const DEFAULT_TITLE_THRESHOLD = 0.65;
const DEFAULT_MASS_COLLISION_THRESHOLD = 0.2;
const MASS_COLLISION_MIN_ORPHANS = 5;

export async function runLinkRaw(opts: LinkRawOptions = {}): Promise<LinkRawResult> {
  const vaultRoot = opts.vaultRoot ?? defaultMemoryRoot();
  const mode = opts.mode ?? "plan";
  const config = await (opts.configLoader ?? (() => loadMemoryConfig(vaultRoot)))();
  const autoLink = typeof config.auto_link === "object" && config.auto_link !== null
    ? config.auto_link
    : {};
  const threshold = readThreshold(opts.threshold ?? autoLink.similarity_threshold);
  const titleThreshold = readThreshold(opts.titleThreshold ?? autoLink.title_threshold, DEFAULT_TITLE_THRESHOLD);
  const massCollisionThreshold = readThreshold(
    opts.massCollisionThreshold ?? autoLink.mass_collision_threshold,
    DEFAULT_MASS_COLLISION_THRESHOLD,
  );
  const expectedEmbeddingDim = readPositiveInteger(
    opts.expectedEmbeddingDim ?? config.embedding?.dim,
  );
  const enabled = autoLink.enabled !== false;
  const rawFiles = await listRawFiles(vaultRoot);
  const files: LinkRawFileResult[] = [];
  const orphanPaths: string[] = [];

  for (const raw of rawFiles) {
    if (!enabled) {
      files.push({ path: raw.relPath, outcome: "skipped", links: [], reason: "auto_link disabled" });
      continue;
    }
    if (!(await isOrphanRaw(raw.fullPath, raw.relPath))) {
      files.push({ path: raw.relPath, outcome: "skipped", links: [], reason: "raw already has relations" });
      continue;
    }
    orphanPaths.push(raw.relPath);
    const linked = await autoLinkRawToWiki(raw.relPath, {
      vaultRoot,
      threshold,
      titleThreshold,
      expectedEmbeddingDim,
      apply: false,
      now: opts.now,
    });
    files.push({
      path: raw.relPath,
      outcome: linked.linked.length === 0 ? "skipped" : mode === "apply" ? "linked" : "planned",
      links: linked.linked,
      reason: linked.linked.length === 0 ? linked.reason ?? "no match above threshold" : undefined,
    });
  }

  if (mode === "plan") {
    suppressMassCollisionCandidates(files, orphanPaths.length, massCollisionThreshold);
  } else {
    assertNoMassCollision(files, orphanPaths.length, massCollisionThreshold);
    for (const file of files.filter((item) => item.links.length > 0)) {
      await autoLinkRawToWiki(file.path, {
        vaultRoot,
        threshold,
        titleThreshold,
        expectedEmbeddingDim,
        apply: true,
        now: opts.now,
      });
    }
  }

  return {
    mode,
    threshold,
    files,
    summary: {
      scanned: rawFiles.length,
      orphaned: files.filter((file) => file.reason !== "raw already has relations").length,
      linked: files.filter((file) => file.links.length > 0).length,
      written: files.filter((file) => file.outcome === "linked").length,
      skipped: files.filter((file) => file.outcome === "skipped").length,
    },
  };
}

export function formatLinkRawResult(result: LinkRawResult): string {
  const lines = [
    "Memory link-raw",
    `Mode: ${result.mode}`,
    `Threshold: ${result.threshold}`,
    `Scanned raw observations: ${result.summary.scanned}`,
    `Orphaned raw observations: ${result.summary.orphaned}`,
    `Matched observations: ${result.summary.linked}`,
    `Written observations: ${result.summary.written}`,
    `Skipped observations: ${result.summary.skipped}`,
  ];
  if (result.files.length > 0) {
    lines.push("", "Files:");
    for (const file of result.files) {
      const links = file.links.length > 0
        ? ` -> ${file.links.map((link) => `${link.target} (${link.strategy} ${link.score.toFixed(3)})`).join(", ")}`
        : "";
      lines.push(`  - ${file.outcome}: ${file.path}${links}${file.reason ? ` (${file.reason})` : ""}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

async function listRawFiles(vaultRoot: string): Promise<Array<{ fullPath: string; relPath: string }>> {
  const rawRoot = join(vaultRoot, "raw");
  if (!existsSync(rawRoot)) return [];
  const files: Array<{ fullPath: string; relPath: string }> = [];
  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        files.push({ fullPath, relPath: relative(vaultRoot, fullPath).replace(/\\/g, "/") });
      }
    }
  }
  await walk(rawRoot);
  return files.sort((a, b) => a.relPath.localeCompare(b.relPath));
}

async function isOrphanRaw(fullPath: string, relPath: string): Promise<boolean> {
  const parsed = parseFrontmatter(await readFile(fullPath, "utf-8"));
  const relations = readRelations(parsed.frontmatter.relations, relPath);
  return !Object.values(relations).some((edges) => edges.length > 0);
}

function assertNoMassCollision(
  files: LinkRawFileResult[],
  orphaned: number,
  threshold: number,
): void {
  const collision = findMassCollision(files, orphaned, threshold);
  if (!collision) return;
  throw new Error(
    `refusing to link: ${Math.round(collision.share * 100)}% of orphans map to ${collision.target} — embeddings likely degenerate`,
  );
}

function suppressMassCollisionCandidates(
  files: LinkRawFileResult[],
  orphaned: number,
  threshold: number,
): void {
  const suppressed: string[] = [];
  for (;;) {
    const collision = findMassCollision(files, orphaned, threshold);
    if (!collision) return;
    suppressed.push(collision.target);
    for (const file of files) {
      if (!file.links.some((link) => link.target === collision.target)) continue;
      file.links = file.links.filter((link) => link.target !== collision.target);
      if (file.links.length === 0) {
        file.outcome = "skipped";
        file.reason = `mass-collision candidate suppressed: ${suppressed.join(", ")}`;
      }
    }
  }
}

function findMassCollision(
  files: LinkRawFileResult[],
  orphaned: number,
  threshold: number,
): { target: string; count: number; share: number } | null {
  if (orphaned < MASS_COLLISION_MIN_ORPHANS) return null;
  const targetCounts = new Map<string, number>();
  for (const file of files) {
    for (const target of new Set(file.links.map((link) => link.target))) {
      targetCounts.set(target, (targetCounts.get(target) ?? 0) + 1);
    }
  }
  const top = [...targetCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
  if (!top) return null;
  const [target, count] = top;
  const share = count / orphaned;
  if (share > threshold) {
    return { target, count, share };
  }
  return null;
}

function readThreshold(value: number | undefined, fallback = DEFAULT_THRESHOLD): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.min(1, value))
    : fallback;
}

function readPositiveInteger(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}
