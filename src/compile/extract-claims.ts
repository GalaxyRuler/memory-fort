import { createHash } from "node:crypto";

export interface Claim {
  claim_id: string;
  text: string;
  offset: [number, number];
}

export function extractClaimsFromParagraph(sectionId: string, paragraphMarkdown: string, bodyOffset = 0): Claim[] {
  const cleaned = cleanParagraphText(paragraphMarkdown);
  const claims: Claim[] = [];
  for (const sentence of splitSentences(cleaned)) {
    const text = sentence.trim();
    if (!text) continue;
    const localOffset = cleaned.indexOf(text);
    const start = bodyOffset + Math.max(0, localOffset);
    claims.push({
      claim_id: `c_${sha1(`${sectionId}\0${normalizeClaimText(text)}`).slice(0, 10)}`,
      text,
      offset: [start, start + text.length],
    });
  }
  return claims;
}

function cleanParagraphText(markdown: string): string {
  return markdown
    .replace(/`[^`\n]*`/g, "")
    .replace(/\[([^\]\n]+)\]\([^)]+\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function splitSentences(text: string): string[] {
  const segmenterConstructor = Intl as typeof Intl & {
    Segmenter?: new (locale: string, opts: { granularity: "sentence" }) => {
      segment(input: string): Iterable<{ segment: string }>;
    };
  };
  if (typeof segmenterConstructor.Segmenter === "function") {
    return [...new segmenterConstructor.Segmenter("en", { granularity: "sentence" }).segment(text)]
      .map((segment) => segment.segment.trim())
      .filter(Boolean);
  }
  return text
    .split(/(?<=[.!?])\s+(?=[A-Z0-9])/)
    .map((segment) => segment.trim())
    .filter(Boolean);
}

function normalizeClaimText(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

function sha1(value: string): string {
  return createHash("sha1").update(value).digest("hex");
}
