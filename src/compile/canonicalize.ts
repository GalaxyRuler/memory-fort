import type { SearchSource } from "../retrieval/corpus.js";
import { getConfidenceScore } from "../storage/confidence.js";
import type { ConfidenceVector } from "../storage/frontmatter.js";

export interface RawIdentity {
  source: SearchSource;
  session: string | null;
}

export interface CanonicalRawObservation {
  source: SearchSource;
  session: string | null;
  confidence: number;
  title: string;
  tags: string[];
  topicTags: string[];
  toolCallsSummary: string[];
  rawFrontmatter: Record<string, unknown>;
  body: string;
}

interface CanonicalizeRawObservationOptions {
  filename: string;
  identity: RawIdentity;
  frontmatter: Record<string, unknown>;
  body: string;
}

const SOURCE_CONFIDENCE: Record<SearchSource, number> = {
  "claude-code": 0.75,
  codex: 0.75,
  antigravity: 0.6,
  manual: 0.85,
  crystal: 0.9,
  unknown: 0.5,
};
const SESSION_KEYS = [
  "agent_session_id",
  "session_id",
  "sessionId",
  "session",
  "conversation_id",
  "thread_id",
];
const TOPIC_STOPWORDS = new Set([
  "and",
  "for",
  "from",
  "into",
  "the",
  "tool",
  "used",
  "with",
]);

export function canonicalizeRawObservation(
  opts: CanonicalizeRawObservationOptions,
): CanonicalRawObservation {
  const source = readSearchSource(opts.frontmatter.source) ?? opts.identity.source;
  const session =
    SESSION_KEYS.map((key) => readString(opts.frontmatter[key])).find(
      (value): value is string => value !== null,
    ) ?? opts.identity.session;
  const confidence = readConfidenceScore(
    opts.frontmatter.confidence,
    SOURCE_CONFIDENCE[source],
  );
  const h1 = firstHeading(opts.body);
  const title = readString(opts.frontmatter.title) ?? h1 ?? opts.filename;
  const frontmatterTags = readStringArray(opts.frontmatter.tags);
  const topicTags = buildTopicTags({
    frontmatterTags,
    title,
    filename: opts.filename,
  });
  const tags = uniqueStrings([
    ...frontmatterTags.flatMap((tag) => topicTokens(tag)),
    ...topicTags,
  ]);
  const toolCallsSummary = extractToolCalls(opts.body);

  return {
    source,
    session,
    confidence,
    title,
    tags,
    topicTags,
    toolCallsSummary,
    rawFrontmatter: { ...opts.frontmatter },
    body: appendCanonicalMetadata(opts.body, {
      source,
      session,
      topicTags,
      toolCallsSummary,
    }),
  };
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function readConfidenceScore(value: unknown, defaultScore: number): number {
  if (
    typeof value === "number" ||
    (typeof value === "object" && value !== null && !Array.isArray(value))
  ) {
    return getConfidenceScore(value as number | ConfidenceVector, defaultScore);
  }
  return defaultScore;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter((item) => item.length > 0)
    : [];
}

function readSearchSource(value: unknown): SearchSource | null {
  if (
    value === "claude-code" ||
    value === "codex" ||
    value === "antigravity" ||
    value === "manual" ||
    value === "crystal" ||
    value === "unknown"
  ) {
    return value;
  }
  return null;
}

function firstHeading(body: string): string | null {
  for (const line of body.split(/\r?\n/)) {
    const match = /^#\s+(.+?)\s*$/.exec(line);
    if (match) return match[1]!.trim();
  }
  return null;
}

function buildTopicTags(opts: {
  frontmatterTags: string[];
  title: string;
  filename: string;
}): string[] {
  return uniqueStrings([
    ...opts.frontmatterTags.flatMap(topicTokens),
    ...topicTokens(opts.title),
    ...topicTokens(opts.filename),
  ]);
}

function topicTokens(text: string): string[] {
  return text
    .split(/[^A-Za-z0-9]+/)
    .map((token) => token.trim().toLowerCase())
    .filter((token) => token.length >= 2 && !TOPIC_STOPWORDS.has(token));
}

function extractToolCalls(body: string): string[] {
  return uniqueStrings(
    body
      .split(/\r?\n/)
      .map((line) => /^(?:Tool|Used tool):\s*(.+?)\s*$/i.exec(line.trim())?.[1])
      .filter((tool): tool is string => tool !== undefined && tool.length > 0),
  );
}

function appendCanonicalMetadata(
  body: string,
  metadata: {
    source: SearchSource;
    session: string | null;
    topicTags: string[];
    toolCallsSummary: string[];
  },
): string {
  const lines = [
    `canonical agent source: ${metadata.source}`,
    ...(metadata.session ? [`canonical agent session: ${metadata.session}`] : []),
    ...(metadata.topicTags.length > 0
      ? [`canonical topics: ${metadata.topicTags.join(" ")}`]
      : []),
    ...(metadata.toolCallsSummary.length > 0
      ? [`canonical tools: ${metadata.toolCallsSummary.join(" | ")}`]
      : []),
  ];
  return `${body.trimEnd()}\n\n${lines.join("\n")}\n`;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))];
}
