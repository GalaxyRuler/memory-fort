import { tokenize } from "./bm25.js";

export interface ExactSignals {
  filenameMatch: boolean;
  titleMatch: boolean;
  tagMatch: boolean;
}

export interface ExactBoost {
  relPath: string;
  score: number;
  signals: ExactSignals;
}

export interface ExactDoc {
  relPath: string;
  title?: string;
  tags?: string[];
}

export function exactBoosts(query: string, docs: ExactDoc[]): ExactBoost[] {
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) return [];

  const boosts: ExactBoost[] = [];
  for (const doc of docs) {
    const signals = exactSignals(queryTokens, doc);
    const score = exactScore(signals);
    if (score > 0) {
      boosts.push({ relPath: doc.relPath, score, signals });
    }
  }

  return boosts.sort(
    (a, b) => b.score - a.score || a.relPath.localeCompare(b.relPath),
  );
}

function exactSignals(queryTokens: string[], doc: ExactDoc): ExactSignals {
  const filename = basenameWithoutMarkdown(doc.relPath).toLowerCase();
  const title = (doc.title ?? "").toLowerCase();
  const tags = (doc.tags ?? []).map((tag) => tag.toLowerCase());

  return {
    filenameMatch: queryTokens.some((token) => filename.includes(token)),
    titleMatch: queryTokens.some((token) => title.includes(token)),
    tagMatch: queryTokens.some((token) => tags.includes(token)),
  };
}

function exactScore(signals: ExactSignals): number {
  if (!signals.filenameMatch && !signals.titleMatch && !signals.tagMatch) {
    return 0;
  }

  let score = 3;
  if (signals.filenameMatch) score += 2;
  if (signals.titleMatch) score += 2;
  if (signals.tagMatch) score += 1;
  return Math.min(score, 8);
}

function basenameWithoutMarkdown(relPath: string): string {
  const basename = relPath.split("/").at(-1) ?? relPath;
  return basename.replace(/\.md$/i, "");
}
