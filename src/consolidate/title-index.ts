import type { SearchDocument } from "../retrieval/corpus.js";
import { tokenize } from "../retrieval/bm25.js";

export interface Match {
  relPath: string;
  title: string;
  position: number;
  confidence: number;
}

export interface TitleIndexEntry {
  title: string;
  normalized: string;
  relPath: string;
  confidence: number;
}

export interface TitleIndex {
  entries: TitleIndexEntry[];
  titleToRelPath: Map<string, string>;
}

const STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "for",
  "in",
  "memory",
  "of",
  "on",
  "system",
  "test",
  "the",
  "to",
]);

export function buildTitleIndex(corpus: SearchDocument[]): TitleIndex {
  const titleToRelPath = new Map<string, string>();
  const byKey = new Map<string, TitleIndexEntry>();

  for (const doc of corpus) {
    if (doc.kind !== "wiki") continue;
    for (const title of titlesForDocument(doc)) {
      addEntry(byKey, titleToRelPath, {
        title,
        normalized: normalizeTitle(title),
        relPath: doc.relPath,
        confidence: 1,
      });
    }

    for (const title of partialTitles(doc.title)) {
      addEntry(byKey, titleToRelPath, {
        title,
        normalized: normalizeTitle(title),
        relPath: doc.relPath,
        confidence: 0.85,
      });
    }
  }

  return {
    entries: [...byKey.values()].sort(
      (a, b) => b.normalized.length - a.normalized.length ||
        a.relPath.localeCompare(b.relPath) ||
        b.confidence - a.confidence,
    ),
    titleToRelPath,
  };
}

export function findTitleMentions(body: string, index: TitleIndex): Match[] {
  const bestByRelPath = new Map<string, Match>();

  for (const entry of index.entries) {
    const position = findCaseInsensitiveWholePhrase(body, entry.normalized);
    if (position === -1) continue;
    const existing = bestByRelPath.get(entry.relPath);
    const next: Match = {
      relPath: entry.relPath,
      title: entry.title,
      position,
      confidence: entry.confidence,
    };
    if (!existing || compareMatch(next, existing) < 0) {
      bestByRelPath.set(entry.relPath, next);
    }
  }

  return [...bestByRelPath.values()].sort(compareMatch);
}

function addEntry(
  byKey: Map<string, TitleIndexEntry>,
  titleToRelPath: Map<string, string>,
  entry: TitleIndexEntry,
): void {
  if (!isIndexableTitle(entry.normalized)) return;
  const key = `${entry.normalized}\0${entry.relPath}`;
  const current = byKey.get(key);
  if (!current || entry.confidence > current.confidence) {
    byKey.set(key, entry);
  }
  titleToRelPath.set(entry.normalized, entry.relPath);
}

function titlesForDocument(doc: SearchDocument): string[] {
  return [doc.title, ...readAliases(doc)].filter((title) => title.trim().length > 0);
}

function readAliases(doc: SearchDocument): string[] {
  const aliases = doc.rawFrontmatter?.["aliases"];
  if (!Array.isArray(aliases)) return [];
  return aliases.filter((alias): alias is string => typeof alias === "string");
}

function partialTitles(title: string): string[] {
  const tokens = title.match(/[\p{L}\p{N}]+/gu) ?? [];
  if (tokens.length < 3) return [];
  return [tokens.slice(0, 2).join(" ")];
}

function normalizeTitle(title: string): string {
  return tokenize(title).join(" ");
}

function isIndexableTitle(normalized: string): boolean {
  if (normalized.length < 4) return false;
  if (/^\d+$/.test(normalized)) return false;
  const tokens = normalized.split(" ").filter(Boolean);
  if (tokens.length === 1 && STOPWORDS.has(tokens[0]!)) return false;
  return true;
}

function findCaseInsensitiveWholePhrase(body: string, normalized: string): number {
  const normalizedBody = body.toLowerCase();
  const phrase = normalized.toLowerCase();
  let position = normalizedBody.indexOf(phrase);

  while (position !== -1) {
    const before = position === 0 ? "" : normalizedBody[position - 1]!;
    const afterIndex = position + phrase.length;
    const after = afterIndex >= normalizedBody.length ? "" : normalizedBody[afterIndex]!;
    if (!isWordChar(before) && !isWordChar(after)) return position;
    position = normalizedBody.indexOf(phrase, position + 1);
  }

  return -1;
}

function isWordChar(value: string): boolean {
  return /^[\p{L}\p{N}]$/u.test(value);
}

function compareMatch(a: Match, b: Match): number {
  return a.position - b.position ||
    b.confidence - a.confidence ||
    a.relPath.localeCompare(b.relPath);
}
