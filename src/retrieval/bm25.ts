export interface Tokens {
  terms: string[];
  termCount: Map<string, number>;
  length: number;
}

export interface Bm25IndexEntry {
  relPath: string;
  tokens: Tokens;
}

export interface Bm25Index {
  entries: Bm25IndexEntry[];
  idf: Map<string, number>;
  avgdl: number;
  totalDocs: number;
  k1: number;
  b: number;
}

export interface Bm25Score {
  relPath: string;
  score: number;
}

export interface Bm25Options {
  k1?: number;
  b?: number;
}

const DEFAULT_K1 = 1.2;
const DEFAULT_B = 0.75;
const TOKEN_SPLIT_RE = /[^\p{L}\p{N}]+/u;

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(TOKEN_SPLIT_RE)
    .filter((term) => term.length > 0);
}

export function buildBm25Index(
  docs: Array<{ relPath: string; text: string }>,
  opts: Bm25Options = {},
): Bm25Index {
  const entries = docs
    .map((doc): Bm25IndexEntry => ({
      relPath: doc.relPath,
      tokens: buildTokens(doc.text),
    }))
    .sort((a, b) => a.relPath.localeCompare(b.relPath));
  return buildBm25IndexFromEntries(entries, opts);
}

export function buildBm25IndexFromEntries(
  entriesInput: Bm25IndexEntry[],
  opts: Bm25Options = {},
): Bm25Index {
  const entries = [...entriesInput].sort((a, b) => a.relPath.localeCompare(b.relPath));
  const totalDocs = entries.length;
  const totalLength = entries.reduce((sum, entry) => sum + entry.tokens.length, 0);
  const documentFrequency = new Map<string, number>();

  for (const entry of entries) {
    for (const term of entry.tokens.termCount.keys()) {
      documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
    }
  }

  const idf = new Map<string, number>();
  for (const [term, frequency] of documentFrequency) {
    idf.set(
      term,
      Math.log((totalDocs - frequency + 0.5) / (frequency + 0.5) + 1),
    );
  }

  return {
    entries,
    idf,
    avgdl: totalDocs === 0 ? 0 : totalLength / totalDocs,
    totalDocs,
    k1: opts.k1 ?? DEFAULT_K1,
    b: opts.b ?? DEFAULT_B,
  };
}

export function scoreBm25(query: string, index: Bm25Index): Bm25Score[] {
  const queryTerms = [...new Set(tokenize(query))];
  if (queryTerms.length === 0 || index.totalDocs === 0) return [];

  const scores: Bm25Score[] = [];
  for (const entry of index.entries) {
    let score = 0;
    for (const term of queryTerms) {
      const tf = entry.tokens.termCount.get(term) ?? 0;
      const idf = index.idf.get(term) ?? 0;
      if (tf === 0 || idf === 0) continue;
      score += idf * bm25TermScore(tf, entry.tokens.length, index);
    }
    if (score > 0) {
      scores.push({ relPath: entry.relPath, score });
    }
  }

  return scores.sort(
    (a, b) => b.score - a.score || a.relPath.localeCompare(b.relPath),
  );
}

function buildTokens(text: string): Tokens {
  const terms = tokenize(text);
  const termCount = new Map<string, number>();
  for (const term of terms) {
    termCount.set(term, (termCount.get(term) ?? 0) + 1);
  }
  return { terms, termCount, length: terms.length };
}

function bm25TermScore(tf: number, docLength: number, index: Bm25Index): number {
  const lengthRatio = index.avgdl === 0 ? 0 : docLength / index.avgdl;
  const denominator =
    tf + index.k1 * (1 - index.b + index.b * lengthRatio);
  return (tf * (index.k1 + 1)) / denominator;
}
