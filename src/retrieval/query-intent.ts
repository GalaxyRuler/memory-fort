import { chatWithAudit } from "../llm/audit.js";
import type { LLMProvider } from "../llm/types.js";

export const INTENT_LABELS = [
  "decision",
  "procedure",
  "episodic",
  "preference",
  "current-truth",
  "code-context",
  "open-ended",
] as const;

export type IntentLabel = typeof INTENT_LABELS[number];

export interface IntentClassification {
  label: IntentLabel;
  confidence: number;
  method: "heuristic" | "llm" | "fallback" | "explicit";
  latencyMs: number;
  tokensUsed?: number;
  tokensIn?: number;
  tokensOut?: number;
}

export interface ClassifyQueryOptions {
  query: string;
  llm?: LLMProvider | null;
  vaultRoot: string;
  env?: NodeJS.ProcessEnv;
  nowMs?: () => number;
}

const SYSTEM_PROMPT = `Classify the user's query into exactly one of these intent buckets:
- decision: asking what was decided, why one option was chosen over another
- procedure: asking how to do something, what steps to take
- episodic: asking about specific past events or when something happened
- preference: asking about user/operator preferences
- current-truth: asking the current state of something
- code-context: asking about code, implementations, or files
- open-ended: anything that doesn't fit the above

Reply with exactly the bucket name, lowercase, on a single line, no explanation, no quotes. If the query is ambiguous, output: open-ended.`;

const KEYWORD_LOOKUP_BLOCKLIST = new Set([
  "crash",
  "current",
  "currently",
  "decide",
  "decided",
  "decision",
  "error",
  "exception",
  "fail",
  "failed",
  "find",
  "how",
  "now",
  "prefer",
  "preference",
  "show",
  "status",
  "today",
  "what",
  "when",
  "where",
  "why",
]);

export function classifyQueryHeuristic(query: string): IntentClassification | null {
  const started = Date.now();
  const normalized = query.trim().toLowerCase();
  if (normalized.length === 0) return null;

  const rules: Array<{ pattern: RegExp; label: IntentLabel; confidence: number }> = [
    { pattern: /^how (do|can|to|should) (i|we|you)\b/i, label: "procedure", confidence: 0.85 },
    { pattern: /^what.*\b(decide|decision|chose|chosen)\b/i, label: "decision", confidence: 0.85 },
    { pattern: /^why (did|do|does|is).+\b(instead|over|rather than)\b/i, label: "decision", confidence: 0.8 },
    { pattern: /^when (did|does)\b/i, label: "episodic", confidence: 0.8 },
    { pattern: /\b\d{4}-\d{2}-\d{2}\b|\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\s+\d{1,2}\b/i, label: "episodic", confidence: 0.8 },
    { pattern: /\b(?:user|i)\b.*\b(prefer|preference|like)\b/i, label: "preference", confidence: 0.75 },
    { pattern: /(?:\b(currently|right now|today|now)\b.*\b(is|are|status)\b|\b(is|are|status)\b.*\b(currently|right now|today|now)\b)/i, label: "current-truth", confidence: 0.75 },
    { pattern: /\b(show me|where is|find)\b.+\b(code|implementation|function|file)\b/i, label: "code-context", confidence: 0.8 },
    { pattern: /\b(error|exception|traceback|crash|fail)\b/i, label: "procedure", confidence: 0.7 },
  ];

  for (const rule of rules) {
    if (rule.pattern.test(normalized)) {
      return {
        label: rule.label,
        confidence: rule.confidence,
        method: "heuristic",
        latencyMs: Math.max(0, Date.now() - started),
      };
    }
  }

  return null;
}

export async function classifyQuery(opts: ClassifyQueryOptions): Promise<IntentClassification> {
  const nowMs = opts.nowMs ?? (() => Date.now());
  const started = nowMs();
  const env = opts.env ?? process.env;
  if (env["MEMORY_LLM_DISABLED"]?.trim().toLowerCase() === "true") {
    return fallbackClassification(started, nowMs);
  }

  const heuristic = classifyQueryHeuristic(opts.query);
  if (heuristic) return { ...heuristic, latencyMs: Math.max(0, nowMs() - started) };
  if (opts.llm) {
    const keywordLookup = classifyKeywordLookup(opts.query, started, nowMs);
    if (keywordLookup) return keywordLookup;
  }
  if (!opts.llm) return fallbackClassification(started, nowMs);

  try {
    const response = await chatWithAudit({
      llm: opts.llm,
      vaultRoot: opts.vaultRoot,
      consumer: "query-intent-classify",
      request: {
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: `Query: ${opts.query}` },
        ],
        maxTokens: 8,
        temperature: 0,
      },
    });
    const label = parseIntentLabel(response.content);
    if (!label) return fallbackClassification(started, nowMs);
    return {
      label,
      confidence: label === "open-ended" ? 0.6 : 0.75,
      method: "llm",
      latencyMs: Math.max(0, nowMs() - started),
      tokensUsed: response.tokensUsed?.total,
      tokensIn: response.tokensUsed?.prompt,
      tokensOut: response.tokensUsed?.completion,
    };
  } catch {
    return fallbackClassification(started, nowMs);
  }
}

function classifyKeywordLookup(
  query: string,
  started: number,
  nowMs: () => number,
): IntentClassification | null {
  if (query.includes("?")) return null;
  const words = query.trim().toLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? [];
  if (words.length < 1 || words.length > 4) return null;
  if (words.some((word) => KEYWORD_LOOKUP_BLOCKLIST.has(word))) return null;
  return {
    label: "open-ended",
    confidence: 0.55,
    method: "heuristic",
    latencyMs: Math.max(0, nowMs() - started),
  };
}

export function isIntentLabel(value: unknown): value is IntentLabel {
  return typeof value === "string" && (INTENT_LABELS as readonly string[]).includes(value);
}

function parseIntentLabel(content: string): IntentLabel | null {
  const normalized = content.trim().toLowerCase();
  return isIntentLabel(normalized) ? normalized : null;
}

function fallbackClassification(started: number, nowMs: () => number): IntentClassification {
  return {
    label: "open-ended",
    confidence: 0.5,
    method: "fallback",
    latencyMs: Math.max(0, nowMs() - started),
  };
}
