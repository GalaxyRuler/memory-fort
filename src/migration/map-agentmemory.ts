import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, stat } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { atomicWrite } from "../storage/atomic-write.js";
import { parseFrontmatter, serializeFrontmatter } from "../storage/frontmatter.js";
import { formatIsoDate, memoryRoot } from "../storage/paths.js";
import type { AgentMemoryKvEntry } from "./agentmemory-kv-reader.js";
import { observedDateFromAgentMemoryKey } from "./uuidv7-timestamp.js";

export type AgentMemoryImportActionKind =
  | "write"
  | "dedup-skipped"
  | "conflict"
  | "flagged";

export interface AgentMemoryImportAction {
  action: AgentMemoryImportActionKind;
  relPath: string;
  sourceKey: string;
  title: string;
  content: string;
  reason?: string;
}

export interface AgentMemoryImportPlan {
  root: string;
  actions: AgentMemoryImportAction[];
  counts: Record<string, number>;
}

export interface PlanAgentMemoryImportOptions {
  entries: AgentMemoryKvEntry[];
  root?: string;
  now?: Date;
}

export interface ApplyAgentMemoryImportResult {
  written: string[];
  skipped: string[];
  conflicts: string[];
  flagged: string[];
  auditLogPath: string;
}

const KNOWN_WIKI_TYPES = new Set([
  "projects",
  "people",
  "decisions",
  "lessons",
  "references",
  "tools",
]);

export async function planAgentMemoryImport(
  opts: PlanAgentMemoryImportOptions,
): Promise<AgentMemoryImportPlan> {
  const root = opts.root ?? memoryRoot();
  const existing = await loadExistingPages(root);
  const actions: AgentMemoryImportAction[] = [];

  for (const entry of opts.entries) {
    const mapped = mapEntry(entry, opts.now ?? new Date());
    if (!mapped) {
      actions.push({
        action: "flagged",
        relPath: "",
        sourceKey: entry.key,
        title: entry.entryKey || entry.scope,
        content: "",
        reason: `unsupported agentmemory scope ${entry.scope}`,
      });
      continue;
    }

    const mappedHash = normalizedHash(bodyFromMarkdown(mapped.content));
    const dedup =
      existing.find((page) => page.hash === mappedHash) ??
      existing.find((page) => normalizeTitle(page.title) === normalizeTitle(mapped.title));
    if (!dedup) {
      actions.push({ action: "write", ...mapped });
      existing.push(existingPageFromMapped(root, mapped));
      continue;
    }

    const incomingUpdated = updatedDateFromMarkdown(mapped.content);
    if (!incomingUpdated || dedup.updated.getTime() >= incomingUpdated.getTime()) {
      actions.push({
        action: "dedup-skipped",
        ...mapped,
        relPath: dedup.relPath,
        reason: `matched existing ${dedup.relPath}`,
      });
      continue;
    }

    const conflictPath = mapped.relPath.replace(/\.md$/, ".imported.md");
    actions.push({
      action: "conflict",
      ...mapped,
      relPath: conflictPath,
      reason: `title matched older existing ${dedup.relPath}`,
    });
    existing.push(existingPageFromMapped(root, { ...mapped, relPath: conflictPath }));
  }

  return { root, actions, counts: countActions(actions) };
}

export async function applyAgentMemoryImportPlan(
  plan: AgentMemoryImportPlan,
  opts: { root?: string; now?: Date } = {},
): Promise<ApplyAgentMemoryImportResult> {
  const root = opts.root ?? plan.root;
  const written: string[] = [];
  const skipped: string[] = [];
  const conflicts: string[] = [];
  const flagged: string[] = [];

  for (const action of plan.actions) {
    if (action.action === "write" || action.action === "conflict") {
      const fullPath = join(root, ...action.relPath.split("/"));
      await atomicWrite(fullPath, action.content);
      written.push(action.relPath);
      if (action.action === "conflict") conflicts.push(action.relPath);
    } else if (action.action === "dedup-skipped") {
      skipped.push(action.relPath);
    } else {
      flagged.push(action.sourceKey);
    }
  }

  const ts = (opts.now ?? new Date()).toISOString().replace(/[:.]/g, "-");
  const auditLogPath = join(root, "wiki", ".audit", `agentmemory-migration-${ts}.md`);
  await atomicWrite(auditLogPath, formatAuditLog(plan));

  return { written, skipped, conflicts, flagged, auditLogPath };
}

export function formatAgentMemoryImportReport(
  mode: "plan" | "apply",
  plan: AgentMemoryImportPlan,
  auditLogPath?: string,
): string {
  const lines = [`Memory import-agentmemory ${mode}`];
  lines.push(`total: ${plan.actions.length}`);
  for (const kind of ["write", "dedup-skipped", "conflict", "flagged"] as const) {
    lines.push(`${kind}: ${plan.counts[kind] ?? 0}`);
  }
  for (const action of plan.actions) {
    const target = action.relPath ? ` -> ${action.relPath}` : "";
    const reason = action.reason ? ` (${action.reason})` : "";
    lines.push(`- [${action.action}] ${action.sourceKey}${target}${reason}`);
  }
  if (auditLogPath) lines.push(`audit: ${auditLogPath}`);
  return `${lines.join("\n")}\n`;
}

function mapEntry(
  entry: AgentMemoryKvEntry,
  now: Date,
): Omit<AgentMemoryImportAction, "action"> | null {
  if (entry.scope.startsWith("stream:mem-live:")) {
    const value = record(entry.value);
    const observation = value["observation"];
    if (observation !== undefined) {
      return mapObservation(
        {
          ...entry,
          scope: `mem:obs:${entry.scope.replace(/^stream:mem-live:/, "")}`,
          value: observation,
        },
        now,
      );
    }
  }
  if (entry.scope.startsWith("mem:obs:")) return mapObservation(entry, now);
  if (entry.scope === "mem:memories") return mapMemory(entry, now);
  if (entry.scope === "mem:insights" || entry.scope === "mem:crystals") {
    return mapCrystal(entry, now);
  }
  if (entry.scope === "mem:routines" || entry.scope === "mem:procedural") {
    return mapMemory(entry, now, "lessons");
  }
  if (entry.scope.startsWith("mem:") || entry.scope.startsWith("stream:")) {
    return mapLegacyReference(entry, now);
  }
  return null;
}

function mapObservation(
  entry: AgentMemoryKvEntry,
  now: Date,
): Omit<AgentMemoryImportAction, "action"> {
  const value = record(entry.value);
  const id = stringField(value, "id") ?? entry.entryKey;
  const timestamp = dateField(value, "timestamp") ?? now;
  const title = stringField(value, "title") ?? id;
  const date = formatIsoDate(timestamp);
  const observedAt =
    observedDateFromAgentMemoryKey(entry.scope) ??
    observedDateFromAgentMemoryKey(entry.key) ??
    undefined;
  const body = [
    `# ${title}`,
    "",
    stringField(value, "narrative") ??
      stringField(value, "summary") ??
      stringField(value, "content") ??
      JSON.stringify(value, null, 2),
    "",
    ...(arrayField(value, "files").length > 0
      ? ["## Files", "", ...arrayField(value, "files").map((file) => `- ${file}`), ""]
      : []),
  ].join("\n");
  const frontmatter = {
      type: "raw-session",
      title,
      created: date,
      updated: date,
      source: "agentmemory" as never,
      session: entry.scope.replace(/^mem:obs:/, ""),
      confidence: numberField(value, "confidence") ?? undefined,
      tags: arrayField(value, "concepts"),
      imported_from: {
        system: "agentmemory",
        original_key: entry.key,
      },
      cognitive_type: "episodic",
      ...(observedAt ? { observed_at: observedAt } : {}),
    };
  const content = serializeFrontmatter(
    frontmatter,
    body,
  );
  return {
    relPath: `raw/${date}/agentmemory-${safeFilename(id)}.md`,
    sourceKey: entry.key,
    title,
    content,
  };
}

function mapMemory(
  entry: AgentMemoryKvEntry,
  now: Date,
  forcedType?: string,
): Omit<AgentMemoryImportAction, "action"> {
  const value = record(entry.value);
  const title = stringField(value, "title") ?? stringField(value, "name") ?? entry.entryKey;
  const type = forcedType ?? wikiType(value);
  const created = formatIsoDate(dateField(value, "createdAt") ?? dateField(value, "created") ?? now);
  const updated = formatIsoDate(
    dateField(value, "updatedAt") ?? dateField(value, "updated") ?? dateField(value, "createdAt") ?? now,
  );
  const body =
    stringField(value, "content") ??
    stringField(value, "description") ??
    stringField(value, "text") ??
    JSON.stringify(value, null, 2);
  const content = serializeFrontmatter(
    {
      type: type as never,
      title,
      created,
      updated,
      status: "active",
      confidence: numberField(value, "confidence") ?? undefined,
      tags: arrayField(value, "tags").concat(arrayField(value, "concepts")),
      imported_from: {
        system: "agentmemory",
        original_key: entry.key,
      },
      cognitive_type: type === "lessons" ? "procedural" : "semantic",
    },
    body,
  );
  return {
    relPath: `wiki/${type}/${safeSlug(title)}.md`,
    sourceKey: entry.key,
    title,
    content,
  };
}

function mapCrystal(
  entry: AgentMemoryKvEntry,
  now: Date,
): Omit<AgentMemoryImportAction, "action"> {
  const value = record(entry.value);
  const title = stringField(value, "title") ?? stringField(value, "name") ?? entry.entryKey;
  const created = formatIsoDate(dateField(value, "createdAt") ?? dateField(value, "created") ?? now);
  const updated = formatIsoDate(
    dateField(value, "updatedAt") ?? dateField(value, "updated") ?? dateField(value, "createdAt") ?? now,
  );
  const body =
    stringField(value, "insight") ??
    stringField(value, "content") ??
    stringField(value, "summary") ??
    JSON.stringify(value, null, 2);
  const content = serializeFrontmatter(
    {
      type: "crystal",
      title,
      created,
      updated,
      status: "active",
      confidence: numberField(value, "confidence") ?? undefined,
      tags: arrayField(value, "tags").concat(arrayField(value, "concepts")),
      imported_from: {
        system: "agentmemory",
        original_key: entry.key,
      },
      cognitive_type: "semantic",
    },
    body,
  );
  return {
    relPath: `wiki/crystals/${safeSlug(title)}.md`,
    sourceKey: entry.key,
    title,
    content,
  };
}

function mapLegacyReference(
  entry: AgentMemoryKvEntry,
  now: Date,
): Omit<AgentMemoryImportAction, "action"> {
  const title = `agentmemory ${entry.scope} ${entry.entryKey}`.trim();
  const date = formatIsoDate(now);
  const body = [
    `# ${title}`,
    "",
    "This page preserves a legacy agentmemory auxiliary store entry that does not map cleanly to a first-class Memory Fort page type.",
    "",
    "```json",
    JSON.stringify(entry.value, null, 2),
    "```",
    "",
  ].join("\n");
  const content = serializeFrontmatter(
    {
      type: "references",
      title,
      created: date,
      updated: date,
      status: "active",
      tags: ["agentmemory", "legacy-store", safeSlug(entry.scope)],
      imported_from: {
        system: "agentmemory",
        original_key: entry.key,
      },
      cognitive_type: "semantic",
    },
    body,
  );
  return {
    relPath: `wiki/references/agentmemory-${safeSlug(entry.scope)}-${safeSlug(entry.entryKey || "entry")}.md`,
    sourceKey: entry.key,
    title,
    content,
  };
}

async function loadExistingPages(root: string): Promise<ExistingPage[]> {
  const files = await listMarkdown(root, ["wiki", "raw", "crystals"]);
  const pages: ExistingPage[] = [];
  for (const fullPath of files) {
    const relPath = relative(root, fullPath).replace(/\\/g, "/");
    const raw = await readFile(fullPath, "utf-8");
    let title = relPath.split("/").at(-1) ?? relPath;
    let body = raw;
    let updated = (await stat(fullPath)).mtime;
    try {
      const parsed = parseFrontmatter(raw);
      title = typeof parsed.frontmatter.title === "string" ? parsed.frontmatter.title : title;
      body = parsed.body;
      const parsedUpdated = Date.parse(String(parsed.frontmatter.updated ?? ""));
      if (Number.isFinite(parsedUpdated)) updated = new Date(parsedUpdated);
    } catch {
      // Best-effort dedupe still works by body hash.
    }
    pages.push({ relPath, title, hash: normalizedHash(body), updated });
  }
  return pages;
}

async function listMarkdown(root: string, topDirs: string[]): Promise<string[]> {
  const files: string[] = [];
  async function walk(dir: string): Promise<void> {
    if (!existsSync(dir)) return;
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile() && entry.name.endsWith(".md")) files.push(full);
    }
  }
  for (const topDir of topDirs) await walk(join(root, topDir));
  return files.sort();
}

function existingPageFromMapped(
  root: string,
  mapped: Omit<AgentMemoryImportAction, "action">,
): ExistingPage {
  return {
    relPath: mapped.relPath,
    title: mapped.title,
    hash: normalizedHash(bodyFromMarkdown(mapped.content)),
    updated: updatedDateFromMarkdown(mapped.content) ?? new Date(0),
  };
}

function formatAuditLog(plan: AgentMemoryImportPlan): string {
  const lines = ["# agentmemory migration audit", ""];
  for (const action of plan.actions) {
    const target = action.relPath ? ` -> ${action.relPath}` : "";
    const reason = action.reason ? ` (${action.reason})` : "";
    lines.push(`- [${action.action}] ${action.sourceKey}${target}${reason}`);
  }
  return `${lines.join("\n")}\n`;
}

function countActions(actions: AgentMemoryImportAction[]): Record<string, number> {
  const counts: Record<string, number> = { raw: 0, wiki: 0, crystals: 0 };
  for (const action of actions) {
    counts[action.action] = (counts[action.action] ?? 0) + 1;
    if (action.relPath.startsWith("raw/")) counts.raw++;
    else if (action.relPath.startsWith("wiki/crystals/")) counts.crystals++;
    else if (action.relPath.startsWith("wiki/")) counts.wiki++;
  }
  return counts;
}

function bodyFromMarkdown(content: string): string {
  try {
    return parseFrontmatter(content).body;
  } catch {
    return content;
  }
}

function updatedDateFromMarkdown(content: string): Date | null {
  try {
    const updated = Date.parse(String(parseFrontmatter(content).frontmatter.updated ?? ""));
    return Number.isFinite(updated) ? new Date(updated) : null;
  } catch {
    return null;
  }
}

function normalizedHash(body: string): string {
  return createHash("sha256")
    .update(body.toLowerCase().replace(/\s+/g, " ").trim())
    .digest("hex");
}

function normalizeTitle(title: string): string {
  return title.toLowerCase().replace(/\s+/g, " ").trim();
}

function wikiType(value: Record<string, unknown>): string {
  const raw = String(value["type"] ?? value["memoryType"] ?? "").toLowerCase();
  const mapped =
    raw === "decision"
      ? "decisions"
      : raw === "lesson" || raw === "workflow" || raw === "procedural"
        ? "lessons"
        : raw === "tool"
          ? "tools"
          : raw === "person"
            ? "people"
            : raw === "project"
              ? "projects"
              : raw === "reference"
                ? "references"
                : raw;
  return KNOWN_WIKI_TYPES.has(mapped) ? mapped : "references";
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : { value };
}

function stringField(value: Record<string, unknown>, key: string): string | null {
  const field = value[key];
  return typeof field === "string" && field.trim().length > 0 ? field.trim() : null;
}

function numberField(value: Record<string, unknown>, key: string): number | null {
  const field = value[key];
  return typeof field === "number" && Number.isFinite(field) ? field : null;
}

function arrayField(value: Record<string, unknown>, key: string): string[] {
  const field = value[key];
  return Array.isArray(field)
    ? field.filter((item): item is string => typeof item === "string")
    : [];
}

function dateField(value: Record<string, unknown>, key: string): Date | null {
  const field = value[key];
  if (typeof field !== "string") return null;
  const ms = Date.parse(field);
  return Number.isFinite(ms) ? new Date(ms) : null;
}

function safeSlug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "untitled";
}

function safeFilename(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 100) || "untitled";
}

interface ExistingPage {
  relPath: string;
  title: string;
  hash: string;
  updated: Date;
}
