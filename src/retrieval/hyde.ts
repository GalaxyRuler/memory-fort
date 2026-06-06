export interface HydeHeuristicInput {
  query: string;
  bm25HitCount: number;
}

export interface HydeHeuristicOptions {
  maxWordsForShort?: number;
}

export interface BuildHydePromptInput {
  query: string;
  templateContent: string;
  schemaSummary?: string;
}

export interface ApplyHydeExpansionInput {
  query: string;
  expansion: string;
}

const DEFAULT_MAX_WORDS_FOR_SHORT = 5;
const DEFAULT_SCHEMA_SUMMARY =
  "Types: projects, people, decisions, lessons, references, tools, crystal. Edges: uses, depends_on, supersedes, contradicts, caused_by, fixed_by, derived_from, mentioned_in, linked.";

export function shouldUseHyde(
  input: HydeHeuristicInput,
  opts: HydeHeuristicOptions = {},
): boolean {
  const maxWords = opts.maxWordsForShort ?? DEFAULT_MAX_WORDS_FOR_SHORT;
  const wordCount = input.query.trim().split(/\s+/).filter(Boolean).length;
  return wordCount <= maxWords || input.bm25HitCount === 0;
}

export function buildHydePrompt(input: BuildHydePromptInput): string {
  const schemaSummary = input.schemaSummary ?? defaultSchemaSummary();
  return input.templateContent.replace(/\{\{([a-z_]+)\}\}/g, (match, key) => {
    if (key === "query") return input.query;
    if (key === "schema_summary") return schemaSummary;
    return match;
  });
}

export function applyHydeExpansion(input: ApplyHydeExpansionInput): {
  embeddingInput: string;
} {
  return { embeddingInput: input.expansion };
}

export function defaultSchemaSummary(): string {
  return DEFAULT_SCHEMA_SUMMARY;
}
