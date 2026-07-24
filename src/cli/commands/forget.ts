import { existsSync } from "node:fs";
import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isAbsolute, join, relative, resolve } from "node:path";

import { rebuildIndex } from "../../compile/index.js";
import { deleteIndexDbFiles, openIndexDb, openReadOnlyIndexDb, resolveIndexDbPath } from "../../index/db.js";
import { reconcileIndex } from "../../index/reconcile.js";
import { parseFrontmatter } from "../../storage/frontmatter.js";
import { memoryRoot } from "../../storage/paths.js";
import { readRelationTarget } from "../../retrieval/relations.js";

const execFileAsync = promisify(execFile);

export type ForgetMode = "plan" | "apply";

export interface ForgetOptions {
  /** Defaults to plan: every erase needs an explicit --apply. */
  mode?: ForgetMode;
  /** Exact, canonical vault-relative paths. */
  paths?: readonly string[];
  /** Exact, canonical `raw/...` vault-relative paths. */
  rawPaths?: readonly string[];
  /** Capture/source identifiers, such as `codex` or `claude-code`. */
  sourceIds?: readonly string[];
}

export interface ForgetIndexInventory {
  path: string;
  fts: string[];
  vectors: string[];
}

export interface ForgetHistoryInventory {
  status: "history-retained";
  gitCommits: string[];
  backupManifests: string[];
}

export interface ForgetPlan {
  raw: string[];
  facts: string[];
  generated: string[];
  /** Generated documents with direct provenance relation(s) to the target. */
  relations: string[];
  /** Archived copies are explicitly inventoried but never erased by this command. */
  archive: string[];
  /** Crystals are explicitly excluded from forget and retention actions. */
  crystals: string[];
  erasedCrystals: string[];
  index: ForgetIndexInventory;
  history: ForgetHistoryInventory;
  /** Human-curated or mixed-lineage pages which cannot be safely erased as a unit. */
  blocked: string[];
}

export interface ForgetResult {
  mode: ForgetMode;
  status: "planned" | "live-erased/history-retained";
  plan: ForgetPlan;
  erased: string[];
  report: string;
}

interface GeneratedPage {
  relPath: string;
  sources: string[];
  hasDerivedRelation: boolean;
  generated: boolean;
}

interface FactFileChange {
  relPath: string;
  content: string;
  removeWholeFile: boolean;
}

/**
 * Plans or erases material from the live vault only. Git history, backups,
 * archive folders and crystals remain intact by design and are reported as
 * retained evidence rather than falsely claimed as forgotten.
 */
export async function runForget(opts: ForgetOptions = {}): Promise<ForgetResult> {
  const root = memoryRoot();
  const mode = opts.mode ?? "plan";
  const selectors = normalizeSelectors(opts);
  if (selectors.paths.length + selectors.rawPaths.length + selectors.sourceIds.length === 0) {
    throw new Error("memory forget: provide at least one --path, --raw, or --source selector");
  }

  const selectedRaw = await selectedRawPaths(root, selectors);
  const pages = await collectGeneratedPages(root, selectors, selectedRaw);
  const facts = await collectFactChanges(root, selectedRaw);
  const generated = pages.filter((page) => page.generated && page.sources.every((source) => selectedRaw.has(source)));
  const blocked = pages
    .filter((page) => !page.generated || page.sources.some((source) => !selectedRaw.has(source)))
    .map((page) => page.relPath);
  const directPages = selectors.paths.filter((path) => path.startsWith("wiki/"));
  for (const relPath of directPages) {
    if (!pages.some((page) => page.relPath === relPath) && existsSync(join(root, ...relPath.split("/")))) {
      blocked.push(relPath);
    }
  }

  const plannedPaths = [...selectedRaw, ...generated.map((page) => page.relPath)];
  const plan: ForgetPlan = {
    raw: [...selectedRaw].sort(),
    facts: facts.map((fact) => fact.relPath).sort(),
    generated: generated.map((page) => page.relPath).sort(),
    relations: generated.filter((page) => page.hasDerivedRelation).map((page) => page.relPath).sort(),
    archive: await findArchivedCopies(root, selectedRaw),
    crystals: await listMarkdownFiles(root, "crystals"),
    erasedCrystals: [],
    index: readIndexInventory(root, plannedPaths),
    history: await readHistoryInventory(root, selectedRaw),
    blocked: [...new Set(blocked)].sort(),
  };

  if (mode === "plan") {
    return {
      mode,
      status: "planned",
      plan,
      erased: [],
      report: formatForgetReport("plan", plan, []),
    };
  }

  if (plan.blocked.length > 0) {
    throw new Error(`memory forget: ambiguous manual curated content blocks erase: ${plan.blocked.join(", ")}`);
  }

  const erased: string[] = [];
  for (const relPath of plan.raw) {
    await removeLivePath(root, relPath);
    erased.push(relPath);
  }
  for (const fact of facts) {
    if (fact.removeWholeFile) {
      await removeLivePath(root, fact.relPath);
    } else {
      await writeFile(join(root, ...fact.relPath.split("/")), fact.content, "utf8");
    }
    erased.push(fact.relPath);
  }
  for (const relPath of plan.generated) {
    await removeLivePath(root, relPath);
    erased.push(relPath);
  }

  // Both generated index.md and SQLite FTS/vector state are derived data. A
  // fresh reconciliation after erasing prevents stale hits from surviving the
  // live-source deletion, including same-size replacement edge cases.
  await rebuildIndex(root);
  await rebuildSearchIndex(root);

  return {
    mode,
    status: "live-erased/history-retained",
    plan,
    erased: erased.sort(),
    report: formatForgetReport("apply", plan, erased.sort()),
  };
}

function normalizeSelectors(opts: ForgetOptions): { paths: string[]; rawPaths: string[]; sourceIds: string[] } {
  const paths = normalizePathList(opts.paths ?? [], "--path");
  const rawPaths = normalizePathList(opts.rawPaths ?? [], "--raw");
  for (const path of paths) {
    if (path.startsWith("crystals/")) {
      throw new Error("memory forget: crystals are excluded from erase by behavior");
    }
    if (!path.startsWith("raw/") && !path.startsWith("wiki/")) {
      throw new Error(`memory forget: --path supports only canonical raw/... or wiki/... paths, got ${path}`);
    }
  }
  for (const path of rawPaths) {
    if (!path.startsWith("raw/") || !path.toLowerCase().endsWith(".md")) {
      throw new Error(`memory forget: --raw requires a canonical raw/... markdown path, got ${path}`);
    }
  }
  const sourceIds = [...new Set((opts.sourceIds ?? []).map((source) => source.trim()).filter(Boolean))].sort();
  if ((opts.sourceIds ?? []).some((source) => source.trim() !== source || source.includes("\n"))) {
    throw new Error("memory forget: --source requires a non-empty source ID without surrounding whitespace");
  }
  return { paths, rawPaths, sourceIds };
}

function normalizePathList(values: readonly string[], selector: "--path" | "--raw"): string[] {
  const paths: string[] = [];
  for (const value of values) {
    const normalized = canonicalRelPath(value);
    if (!normalized) throw new Error(`memory forget: ${selector} requires a canonical vault-relative path: ${value}`);
    paths.push(normalized);
  }
  return [...new Set(paths)].sort();
}

function canonicalRelPath(value: string): string | null {
  if (!value || value !== value.trim() || value !== value.normalize("NFC") || value.includes("\\") || isAbsolute(value) || /^[A-Za-z]:/u.test(value)) return null;
  if (value.startsWith("/") || value.includes("//") || value.split("/").some((part) => !part || part === "." || part === "..")) return null;
  return value;
}

async function selectedRawPaths(
  root: string,
  selectors: ReturnType<typeof normalizeSelectors>,
): Promise<Set<string>> {
  const allRaw = await listMarkdownFiles(root, "raw");
  const selected = new Set<string>([...selectors.rawPaths, ...selectors.paths.filter((path) => path.startsWith("raw/"))]);
  const sourceSet = new Set(selectors.sourceIds);
  if (sourceSet.size > 0) {
    for (const relPath of allRaw) {
      if (sourceSet.has(await readRawSource(root, relPath))) selected.add(relPath);
    }
  }
  for (const relPath of selected) {
    if (!relPath.startsWith("raw/")) continue;
    if (!existsSync(join(root, ...relPath.split("/")))) {
      throw new Error(`memory forget: selected raw path does not exist: ${relPath}`);
    }
  }
  return selected;
}

async function readRawSource(root: string, relPath: string): Promise<string> {
  try {
    const parsed = parseFrontmatter(await readFile(join(root, ...relPath.split("/")), "utf8"));
    if (typeof parsed.frontmatter.source === "string" && parsed.frontmatter.source.trim()) return parsed.frontmatter.source.trim();
  } catch {
    // Fall back to the filename convention used by the retrieval corpus.
  }
  const filename = relPath.split("/").at(-1) ?? "";
  for (const source of ["claude-code", "codex", "antigravity", "manual"]) {
    if (filename.startsWith(`${source}-`)) return source;
  }
  return "unknown";
}

async function collectGeneratedPages(
  root: string,
  selectors: ReturnType<typeof normalizeSelectors>,
  selectedRaw: Set<string>,
): Promise<GeneratedPage[]> {
  const pages: GeneratedPage[] = [];
  const sourceIds = new Set(selectors.sourceIds);
  for (const relPath of await listMarkdownFiles(root, "wiki", { excludeArchives: true })) {
    const content = await readFile(join(root, ...relPath.split("/")), "utf8");
    let frontmatter: Record<string, unknown>;
    try {
      frontmatter = parseFrontmatter(content).frontmatter as Record<string, unknown>;
    } catch {
      continue;
    }
    const sources = collectPageSources(frontmatter).filter((source) => selectedRaw.has(source));
    const directlySelected = selectors.paths.includes(relPath);
    const sourceSelected = typeof frontmatter.source === "string" && sourceIds.has(frontmatter.source);
    if (!directlySelected && !sourceSelected && sources.length === 0) continue;
    const allSources = collectPageSources(frontmatter);
    pages.push({
      relPath,
      sources: allSources.length > 0 ? allSources : sources,
      hasDerivedRelation: hasSelectedDerivedRelation(frontmatter, selectedRaw),
      generated: isGeneratedPage(frontmatter),
    });
  }
  return pages;
}

function collectPageSources(frontmatter: Record<string, unknown>): string[] {
  const sources = new Set<string>();
  if (Array.isArray(frontmatter.source_facts)) {
    for (const value of frontmatter.source_facts) {
      if (typeof value !== "string") continue;
      const raw = value.split("#", 1)[0]!;
      if (raw.startsWith("raw/")) sources.add(raw);
    }
  }
  const relations = frontmatter.relations;
  if (typeof relations === "object" && relations !== null && !Array.isArray(relations)) {
    const derived = (relations as Record<string, unknown>).derived_from;
    if (Array.isArray(derived)) {
      for (const relation of derived) {
        const target = readRelationTarget(relation);
        if (target?.startsWith("raw/")) sources.add(target);
      }
    }
  }
  return [...sources].sort();
}

function hasSelectedDerivedRelation(frontmatter: Record<string, unknown>, selectedRaw: Set<string>): boolean {
  const relations = frontmatter.relations;
  if (typeof relations !== "object" || relations === null || Array.isArray(relations)) return false;
  const derived = (relations as Record<string, unknown>).derived_from;
  return Array.isArray(derived) && derived.some((relation) => {
    const target = readRelationTarget(relation);
    return target !== null && selectedRaw.has(target);
  });
}

function isGeneratedPage(frontmatter: Record<string, unknown>): boolean {
  return frontmatter.generated === true ||
    frontmatter.generated_by === "memory-fort" ||
    frontmatter.source === "compile";
}

async function collectFactChanges(root: string, selectedRaw: Set<string>): Promise<FactFileChange[]> {
  const changes: FactFileChange[] = [];
  for (const relPath of await listFiles(root, "facts", (name) => name.endsWith(".json"))) {
    const full = join(root, ...relPath.split("/"));
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(full, "utf8"));
    } catch {
      continue;
    }
    const rewritten = removeSelectedFacts(parsed, selectedRaw);
    if (!rewritten.changed) continue;
    changes.push({
      relPath,
      content: `${JSON.stringify(rewritten.value, null, 2)}\n`,
      removeWholeFile: rewritten.empty,
    });
  }
  return changes;
}

function removeSelectedFacts(value: unknown, selectedRaw: Set<string>): { value: unknown; changed: boolean; empty: boolean } {
  if (Array.isArray(value)) {
    const next = value.filter((fact) => !factMatchesSelectedRaw(fact, selectedRaw));
    return { value: next, changed: next.length !== value.length, empty: next.length === 0 };
  }
  if (typeof value !== "object" || value === null) return { value, changed: false, empty: false };
  const record = value as Record<string, unknown>;
  const facts = Array.isArray(record.facts) ? record.facts : [];
  const next = facts.filter((fact) => !factMatchesSelectedRaw(fact, selectedRaw));
  const rootMatches = rawPathFromRecord(record) !== null && selectedRaw.has(rawPathFromRecord(record)!);
  const changed = rootMatches || next.length !== facts.length;
  return {
    value: { ...record, ...(Array.isArray(record.facts) ? { facts: next } : {}) },
    changed,
    empty: changed && (rootMatches || (Array.isArray(record.facts) && next.length === 0)),
  };
}

function factMatchesSelectedRaw(value: unknown, selectedRaw: Set<string>): boolean {
  return rawPathFromRecord(value) !== null && selectedRaw.has(rawPathFromRecord(value)!);
}

function rawPathFromRecord(value: unknown): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const sourceRawPath = (value as Record<string, unknown>).sourceRawPath;
  return typeof sourceRawPath === "string" ? sourceRawPath.replace(/\\/g, "/") : null;
}

async function findArchivedCopies(root: string, selectedRaw: Set<string>): Promise<string[]> {
  const results = new Set<string>();
  for (const directory of ["wiki/archive", "wiki/.archive", ".archive", "raw/.compact-archive"]) {
    for (const relPath of await listFiles(root, directory)) {
      const original = archiveOriginalPath(relPath);
      if (original && selectedRaw.has(original)) results.add(relPath);
    }
  }
  return [...results].sort();
}

function archiveOriginalPath(relPath: string): string | null {
  const match = /(?:^|\/)(?:archive|\.compact-archive)\/[^/]+\/(raw\/.*)$/u.exec(relPath);
  return match?.[1] ?? null;
}

function readIndexInventory(root: string, paths: string[]): ForgetIndexInventory {
  const path = resolveIndexDbPath({ vaultRoot: root });
  if (!existsSync(path) || paths.length === 0) return { path, fts: [], vectors: [] };
  try {
    const index = openReadOnlyIndexDb({ vaultRoot: root });
    try {
      const placeholders = paths.map(() => "?").join(", ");
      const fts = index.database
        .prepare<string[], { relPath: string }>(`SELECT DISTINCT relPath FROM chunks WHERE relPath IN (${placeholders}) ORDER BY relPath`)
        .all(...paths)
        .map((row) => row.relPath);
      const vectors = index.database
        .prepare<string[], { relPath: string }>(`SELECT DISTINCT c.relPath FROM chunk_vectors cv JOIN chunks c ON c.rowid = cv.chunkRowid WHERE c.relPath IN (${placeholders}) ORDER BY c.relPath`)
        .all(...paths)
        .map((row) => row.relPath);
      return { path, fts, vectors };
    } finally {
      index.close();
    }
  } catch {
    // An unavailable derived index is never a reason to skip the live plan.
    return { path, fts: [], vectors: [] };
  }
}

async function readHistoryInventory(root: string, selectedRaw: Set<string>): Promise<ForgetHistoryInventory> {
  const backupManifests = [
    ...(await listFiles(root, "backups", (name) => /manifest.*\.json$/iu.test(name))),
    ...(await listFiles(root, ".backups", (name) => /manifest.*\.json$/iu.test(name))),
  ].sort();
  if (selectedRaw.size === 0 || !existsSync(join(root, ".git"))) {
    return { status: "history-retained", gitCommits: [], backupManifests };
  }
  try {
    const { stdout } = await execFileAsync("git", ["-C", root, "log", "--all", "--format=%H", "--", ...selectedRaw], {
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });
    return {
      status: "history-retained",
      gitCommits: stdout.split(/\r?\n/u).filter(Boolean).sort(),
      backupManifests,
    };
  } catch {
    return { status: "history-retained", gitCommits: [], backupManifests };
  }
}

async function rebuildSearchIndex(root: string): Promise<void> {
  // This database contains only derived chunks, FTS postings, and vectors.
  // Remove the old generation first so no stale live hit can survive a failed
  // reconciliation; the new database is populated solely from the post-erase vault.
  deleteIndexDbFiles(resolveIndexDbPath({ vaultRoot: root }));
  const index = openIndexDb({ vaultRoot: root });
  try {
    await reconcileIndex(index, root);
  } finally {
    index.close();
  }
}

async function removeLivePath(root: string, relPath: string): Promise<void> {
  const fullPath = safeResolveUnder(root, relPath);
  if (!fullPath || !existsSync(fullPath)) throw new Error(`memory forget: live path disappeared before erase: ${relPath}`);
  await rm(fullPath, { force: true });
}

async function listMarkdownFiles(root: string, directory: string, options: { excludeArchives?: boolean } = {}): Promise<string[]> {
  return listFiles(root, directory, (name) => name.toLowerCase().endsWith(".md"), options);
}

async function listFiles(
  root: string,
  directory: string,
  include: (name: string) => boolean = () => true,
  options: { excludeArchives?: boolean } = {},
): Promise<string[]> {
  const base = join(root, ...directory.split("/"));
  if (!existsSync(base)) return [];
  const found: string[] = [];
  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      const relPath = relative(root, full).replace(/\\/g, "/");
      if (entry.isDirectory()) {
        if (options.excludeArchives && relPath.split("/").some((part) => part === "archive" || part.startsWith("."))) continue;
        await walk(full);
      } else if (entry.isFile() && include(entry.name)) {
        found.push(relPath);
      }
    }
  }
  await walk(base);
  return found.sort();
}

function safeResolveUnder(root: string, relPath: string): string | null {
  const finalPath = resolve(root, ...relPath.split("/"));
  const rel = relative(resolve(root), finalPath);
  return rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel) ? finalPath : null;
}

function formatForgetReport(mode: ForgetMode, plan: ForgetPlan, erased: string[]): string {
  const lines = [
    `Memory forget ${mode}`,
    `Live raw: ${plan.raw.length}`,
    `Derived facts: ${plan.facts.length}`,
    `Generated pages: ${plan.generated.length}`,
    `SQLite FTS rows: ${plan.index.fts.length}`,
    `SQLite vector rows: ${plan.index.vectors.length}`,
    `Archived copies retained: ${plan.archive.length}`,
    `Crystals retained: ${plan.crystals.length}`,
    `Git history retained: ${plan.history.gitCommits.length}`,
    `Backup manifests retained: ${plan.history.backupManifests.length}`,
    `Status: ${mode === "apply" ? "live-erased/history-retained" : "planned; history-retained"}`,
  ];
  if (plan.blocked.length > 0) lines.push(`Blocked manual curated pages: ${plan.blocked.join(", ")}`);
  if (erased.length > 0) lines.push("", "Live material erased:", ...erased.map((path) => `- ${path}`));
  return `${lines.join("\n")}\n`;
}
