import type { SearchDocument } from "../retrieval/corpus.js";
import { buildBm25Index, scoreBm25 } from "../retrieval/bm25.js";
import type { Match } from "./title-index.js";

export interface BM25MentionOptions {
  threshold?: number;
  topK?: number;
}

export interface ConsolidationMention extends Match {
  source: "lexical" | "bm25" | "both";
}

const DEFAULT_THRESHOLD = 5.0;
const DEFAULT_TOP_K = 10;

export function findBM25Mentions(
  body: string,
  corpus: SearchDocument[],
  opts: BM25MentionOptions = {},
): ConsolidationMention[] {
  const threshold = opts.threshold ?? DEFAULT_THRESHOLD;
  const topK = opts.topK ?? DEFAULT_TOP_K;
  const wikiDocs = corpus.filter((doc) => doc.kind === "wiki");
  const docsByPath = new Map(wikiDocs.map((doc) => [doc.relPath, doc]));
  const index = buildBm25Index(
    wikiDocs.map((doc) => ({
      relPath: doc.relPath,
      text: documentText(doc),
    })),
  );

  return scoreBm25(body, index)
    .filter((score) => score.score >= threshold)
    .slice(0, topK)
    .map((score): ConsolidationMention => {
      const doc = docsByPath.get(score.relPath)!;
      return {
        relPath: score.relPath,
        title: doc.title,
        position: -1,
        confidence: confidenceForScore(score.score, threshold),
        source: "bm25",
      };
    });
}

export function combineMentions(
  lexical: Match[],
  bm25: ConsolidationMention[],
): ConsolidationMention[] {
  const combined = new Map<string, ConsolidationMention>();

  for (const match of lexical) {
    combined.set(match.relPath, { ...match, source: "lexical" });
  }

  for (const match of bm25) {
    const existing = combined.get(match.relPath);
    if (!existing) {
      combined.set(match.relPath, match);
      continue;
    }
    combined.set(match.relPath, {
      ...existing,
      confidence: Math.max(existing.confidence, match.confidence),
      source: "both",
    });
  }

  return [...combined.values()].sort(
    (a, b) => b.confidence - a.confidence ||
      relationPosition(a) - relationPosition(b) ||
      a.relPath.localeCompare(b.relPath),
  );
}

function documentText(doc: SearchDocument): string {
  return [
    doc.title,
    doc.tags.join(" "),
    doc.body,
  ].filter((part) => part.trim().length > 0).join("\n");
}

function confidenceForScore(score: number, threshold: number): number {
  const ratio = threshold <= 0 ? 1 : (score - threshold) / threshold;
  return Math.min(0.8, Math.max(0.5, 0.5 + ratio * 0.3));
}

function relationPosition(match: Match): number {
  return match.position < 0 ? Number.MAX_SAFE_INTEGER : match.position;
}
