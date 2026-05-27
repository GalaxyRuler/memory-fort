import { existsSync } from "node:fs";
import { mkdir, readdir, readFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { atomicWrite } from "../../storage/atomic-write.js";
import { memoryRoot } from "../../storage/paths.js";
import { parseFrontmatter, serializeFrontmatter, type Frontmatter } from "../../storage/frontmatter.js";

export interface BackfillSourceOptions {
  vaultRoot?: string;
  mode?: "plan" | "apply";
  force?: boolean;
  now?: Date;
}

export interface BackfillSourceResult {
  report: string;
  changed: number;
  auditLogPath?: string;
}

interface WikiSourcePage {
  relPath: string;
  fullPath: string;
  frontmatter: Frontmatter;
  body: string;
}

interface SourceProposal {
  page: WikiSourcePage;
  source: string;
}

const SOURCE_BACKFILL_ID = "backfill-source";

export async function runBackfillSource(opts: BackfillSourceOptions = {}): Promise<BackfillSourceResult> {
  const vaultRoot = opts.vaultRoot ?? memoryRoot();
  const mode = opts.mode ?? "plan";
  const now = opts.now ?? new Date();
  const pages = await loadLiveWikiPages(vaultRoot);
  const missing = pages.filter((page) => lacksSource(page.frontmatter.source));
  const candidates = opts.force ? pages : missing;
  const proposals: SourceProposal[] = [];
  const unmatched: WikiSourcePage[] = [];

  for (const page of candidates) {
    const source = inferSource(page.relPath);
    if (!source) {
      if (opts.force || lacksSource(page.frontmatter.source)) unmatched.push(page);
      continue;
    }
    if (opts.force || page.frontmatter.source !== source) {
      proposals.push({ page, source });
    }
  }

  let changed = 0;
  let auditLogPath: string | undefined;
  if (mode === "apply" && proposals.length > 0) {
    for (const proposal of proposals) {
      await atomicWrite(
        proposal.page.fullPath,
        serializeFrontmatter({ ...proposal.page.frontmatter, source: proposal.source }, proposal.page.body),
      );
      changed += 1;
    }
    auditLogPath = await writeAuditLog(vaultRoot, proposals, unmatched, now);
  }

  return {
    report: formatBackfillSourceReport({
      mode,
      total: pages.length,
      missing: missing.length,
      proposals,
      unmatched,
      changed,
      auditLogPath,
    }),
    changed,
    auditLogPath,
  };
}

async function loadLiveWikiPages(vaultRoot: string): Promise<WikiSourcePage[]> {
  const files = await listMarkdown(join(vaultRoot, "wiki"), vaultRoot);
  const pages: WikiSourcePage[] = [];
  for (const fullPath of files) {
    const relPath = relative(vaultRoot, fullPath).replace(/\\/g, "/");
    if (relPath.startsWith("wiki/archive/")) continue;
    const parsed = parseFrontmatter(await readFile(fullPath, "utf-8"));
    pages.push({
      relPath,
      fullPath,
      frontmatter: parsed.frontmatter,
      body: parsed.body,
    });
  }
  return pages.sort((a, b) => a.relPath.localeCompare(b.relPath));
}

async function listMarkdown(root: string, vaultRoot: string): Promise<string[]> {
  const files: string[] = [];
  async function walk(dir: string): Promise<void> {
    if (!existsSync(dir)) return;
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const fullPath = join(dir, entry.name);
      const relPath = relative(vaultRoot, fullPath).replace(/\\/g, "/");
      if (entry.isDirectory()) {
        if (relPath === "wiki/archive" || relPath.startsWith("wiki/archive/")) continue;
        await walk(fullPath);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        files.push(fullPath);
      }
    }
  }
  await walk(root);
  return files.sort();
}

function inferSource(relPath: string): string | null {
  if (/^wiki\/\.audit\/agentmemory-migration-.*\.md$/.test(relPath)) return "import-agentmemory";
  if (/^wiki\/\.audit\/backfill-source-.*\.md$/.test(relPath)) return SOURCE_BACKFILL_ID;
  if (/^wiki\/\.audit\/backfill-.*\.md$/.test(relPath)) return "backfill";
  if (/^wiki\/\.audit\/consolidate-.*\.md$/.test(relPath)) return "consolidate";
  if (/^wiki\/\.audit\/.*\.md$/.test(relPath)) return "unknown-audit";
  if (/^wiki\/crystals\/.*\.md$/.test(relPath)) return "crystal-extraction";
  if (/^wiki\/references\/fork-smoke-marker-.*\.md$/.test(relPath)) return "codex-fork-smoke";
  return null;
}

function lacksSource(source: unknown): boolean {
  return typeof source !== "string" || source.trim().length === 0 || source === "unknown";
}

async function writeAuditLog(
  vaultRoot: string,
  proposals: SourceProposal[],
  unmatched: WikiSourcePage[],
  now: Date,
): Promise<string> {
  const timestamp = now.toISOString().replace(/[:.]/g, "-");
  const auditLogPath = join(vaultRoot, "wiki", ".audit", `${SOURCE_BACKFILL_ID}-${timestamp}.md`);
  await mkdir(dirname(auditLogPath), { recursive: true });
  const lines = [
    "# source field backfill audit",
    "",
    `started: ${now.toISOString()}`,
    `changed: ${proposals.length}`,
    `unmatched: ${unmatched.length}`,
    "",
    "The audit log uses `source: backfill-source` to identify this specific metadata migration command.",
    "",
  ];
  for (const proposal of proposals) {
    lines.push(`- [write] ${proposal.page.relPath} -> ${proposal.source}`);
  }
  for (const page of unmatched) {
    lines.push(`- [unmatched] ${page.relPath}`);
  }

  await atomicWrite(
    auditLogPath,
    serializeFrontmatter(
      {
        type: "references",
        title: "source field backfill audit",
        created: now.toISOString().slice(0, 10),
        updated: now.toISOString().slice(0, 10),
        status: "active",
        source: SOURCE_BACKFILL_ID,
        cognitive_type: "semantic",
      },
      `${lines.join("\n")}\n`,
    ),
  );
  return auditLogPath;
}

function formatBackfillSourceReport(opts: {
  mode: "plan" | "apply";
  total: number;
  missing: number;
  proposals: SourceProposal[];
  unmatched: WikiSourcePage[];
  changed: number;
  auditLogPath?: string;
}): string {
  const lines = [
    `Memory backfill-source ${opts.mode}`,
    `total wiki pages: ${opts.total} (excluding archive)`,
    `missing/unknown source: ${opts.missing}`,
  ];
  for (const proposal of opts.proposals) {
    lines.push(`  - ${proposal.page.relPath} -> ${proposal.source}`);
  }
  lines.push(`unmatched: ${opts.unmatched.length}`);
  for (const page of opts.unmatched) {
    lines.push(`  - ${page.relPath}`);
  }
  if (opts.mode === "apply") {
    lines.push(`changed: ${opts.changed}`);
    if (opts.auditLogPath) lines.push(`audit: ${opts.auditLogPath}`);
  }
  return `${lines.join("\n")}\n`;
}
