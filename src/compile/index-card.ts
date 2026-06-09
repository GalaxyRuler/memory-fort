import { createHash } from "node:crypto";
import { redactSecrets } from "../privacy/redaction.js";

export interface IndexCardQuote {
  text: string;
  start_byte: number;
  end_byte: number;
}

export interface IndexCard {
  schema_version: 1;
  raw_path: string;
  raw_sha256: string;
  generated_at: string;
  model: string;
  topics: string[];
  quotes: IndexCardQuote[];
  summary: string;
}

export interface IndexCardLLM {
  complete: (prompt: string) => Promise<string>;
}

export interface GenerateIndexCardInput {
  rawPath: string;
  rawContent: string;
  llm: IndexCardLLM;
  now?: Date;
  model?: string;
}

export function isCardStale(card: IndexCard, rawContent: string): boolean {
  const currentHash = createHash("sha256").update(rawContent).digest("hex");
  return card.raw_sha256 !== currentHash;
}

export function loadIndexCard(json: string): IndexCard | null {
  try {
    const parsed = JSON.parse(json);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      parsed.schema_version !== 1
    ) {
      return null;
    }
    return parsed as IndexCard;
  } catch {
    return null;
  }
}

export async function generateIndexCard(
  input: GenerateIndexCardInput,
): Promise<IndexCard> {
  const now = input.now ?? new Date();
  const redacted = redactSecrets(input.rawContent);
  const sha256 = createHash("sha256").update(input.rawContent).digest("hex");

  const prompt = buildExtractionPrompt(redacted);
  const response = await input.llm.complete(prompt);
  const parsed = parseIndexCardResponse(response);

  return {
    schema_version: 1,
    raw_path: input.rawPath,
    raw_sha256: sha256,
    generated_at: now.toISOString(),
    model: input.model ?? "default",
    topics: parsed.topics,
    quotes: parsed.quotes.map((q) => ({
      text: redactSecrets(q.text),
      start_byte: q.start_byte,
      end_byte: q.end_byte,
    })),
    summary: parsed.summary,
  };
}

export function scoreSessionByIndexCard(
  sessionTopics: string[],
  wikiIdentifiers: string[],
): number {
  const wikiSet = new Set(wikiIdentifiers.map((w) => w.toLowerCase()));
  const unique = new Set(sessionTopics.map((t) => t.toLowerCase()));
  let score = 0;
  for (const topic of unique) {
    if (wikiSet.has(topic)) score += 1;
  }
  return score;
}

function buildExtractionPrompt(content: string): string {
  return [
    "Extract an index card from this raw session. Return JSON only.",
    "",
    "Schema: { topics: string[], quotes: Array<{text: string, start_byte: number, end_byte: number}>, summary: string }",
    "",
    "- topics: 2-8 short lowercase topic slugs",
    "- quotes: up to 5 notable exact spans (after any redaction)",
    "- summary: one sentence describing what happened",
    "",
    "Session content:",
    "---",
    content.slice(0, 30_000),
    "---",
  ].join("\n");
}

function parseIndexCardResponse(response: string): {
  topics: string[];
  quotes: IndexCardQuote[];
  summary: string;
} {
  const jsonMatch = response.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return { topics: [], quotes: [], summary: "" };
  try {
    const parsed = JSON.parse(jsonMatch[0]);
    return {
      topics: Array.isArray(parsed.topics)
        ? parsed.topics.filter((t: unknown) => typeof t === "string")
        : [],
      quotes: Array.isArray(parsed.quotes)
        ? parsed.quotes.filter(
            (q: unknown) =>
              typeof q === "object" &&
              q !== null &&
              typeof (q as Record<string, unknown>).text === "string" &&
              typeof (q as Record<string, unknown>).start_byte === "number" &&
              typeof (q as Record<string, unknown>).end_byte === "number",
          )
        : [],
      summary: typeof parsed.summary === "string" ? parsed.summary : "",
    };
  } catch {
    return { topics: [], quotes: [], summary: "" };
  }
}
