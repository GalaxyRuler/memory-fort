import type { CompressedFact } from "../facts/store.js";

export const NOISE_PATTERNS = [
  /\bTarget:\s*(Codex|Claude|Antigravity)\b/i,
  /\bSubagent\s+[A-Z]\b/,
  /\b(git|commit)\s+[0-9a-f]{7,40}\b/,
  /\bworkflow\s+boilerplate\b/i,
  /\b(prompt|scratchpad|tool\s+call)\b/i,
] as const;

export interface ConsolidationFact {
  fact_id: string;
  fact: CompressedFact;
  text: string;
  needs_review: boolean;
}

export interface FilteredFacts {
  accepted: ConsolidationFact[];
  dropped: Array<{ fact_id: string; reason: "workflow_noise" | "low_importance" }>;
}

export function filterNoiseForPage(pageTitle: string, facts: CompressedFact[]): FilteredFacts {
  const accepted: ConsolidationFact[] = [];
  const dropped: FilteredFacts["dropped"] = [];
  facts.forEach((fact, index) => {
    const factId = `f_${index}`;
    const text = fact.facts.join(" ");
    const isNoise = NOISE_PATTERNS.some((pattern) => pattern.test(text));
    if (isNoise && entityOverlap(pageTitle, text) < 0.5) {
      dropped.push({ fact_id: factId, reason: "workflow_noise" });
      return;
    }
    accepted.push({
      fact_id: factId,
      fact,
      text,
      needs_review: isNoise,
    });
  });
  return { accepted, dropped };
}

function entityOverlap(title: string, text: string): number {
  const titleTokens = tokenSet(title);
  if (titleTokens.size === 0) return 0;
  const textTokens = tokenSet(text);
  let overlap = 0;
  for (const token of titleTokens) {
    if (textTokens.has(token)) overlap += 1;
  }
  return overlap / titleTokens.size;
}

function tokenSet(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .map((token) => token.trim())
      .filter((token) => token.length > 2),
  );
}
