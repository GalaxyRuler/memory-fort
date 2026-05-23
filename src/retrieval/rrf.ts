export interface RankedItem {
  relPath: string;
  rank: number;
}

export interface RankedList {
  source: string;
  items: RankedItem[];
}

export interface RrfSource {
  source: string;
  rank: number;
}

export interface RrfResult {
  relPath: string;
  score: number;
  sources: RrfSource[];
}

export interface RrfOptions {
  k?: number;
}

const DEFAULT_K = 60;

export function rrfFuse(lists: RankedList[], opts: RrfOptions = {}): RrfResult[] {
  const k = opts.k ?? DEFAULT_K;
  const byPath = new Map<string, RrfResult>();

  for (const list of lists) {
    for (const item of list.items) {
      const existing =
        byPath.get(item.relPath) ??
        ({
          relPath: item.relPath,
          score: 0,
          sources: [],
        } satisfies RrfResult);
      existing.score += 1 / (k + item.rank);
      existing.sources.push({ source: list.source, rank: item.rank });
      byPath.set(item.relPath, existing);
    }
  }

  return [...byPath.values()]
    .map((result) => ({
      ...result,
      sources: [...result.sources].sort(
        (a, b) => a.source.localeCompare(b.source) || a.rank - b.rank,
      ),
    }))
    .sort((a, b) => b.score - a.score || a.relPath.localeCompare(b.relPath));
}
