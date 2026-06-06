import { createHash } from "node:crypto";
import { redactSecrets } from "../privacy/redaction.js";

export const EMBEDDING_PER_DOC_TOKEN_LIMIT = 30_000;
export const EMBEDDING_BATCH_TOKEN_LIMIT = 100_000;
export const CHARS_PER_TOKEN_ESTIMATE = 4;
const SECRET_HINT =
  /API[_-]?KEY|ACCESS[_-]?TOKEN|AUTH[_-]?TOKEN|TOKEN|SECRET|PASSWORD|PRIVATE KEY|sk-|AIza|gh[posru]_|xox[baprs]-|Bearer\s+/i;

export function toEmbeddingText(body: string): string {
  const safeBody = SECRET_HINT.test(body) ? redactSecrets(body) : body;
  return truncateToTokens(safeBody, EMBEDDING_PER_DOC_TOKEN_LIMIT);
}

export function toLegacyEmbeddingText(body: string): string {
  return truncateToTokens(body, EMBEDDING_PER_DOC_TOKEN_LIMIT);
}

export function hashEmbeddingBody(body: string): string {
  return hashText(toEmbeddingText(body));
}

export function hashLegacyEmbeddingBody(body: string): string {
  return hashText(toLegacyEmbeddingText(body));
}

export function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function estimateEmbeddingTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN_ESTIMATE);
}

export function truncateToTokens(text: string, maxTokens: number): string {
  const maxChars = maxTokens * CHARS_PER_TOKEN_ESTIMATE;
  if (text.length <= maxChars) return text;

  const truncated = text.slice(0, maxChars);
  const lastSpace = truncated.lastIndexOf(" ");
  return lastSpace > maxChars * 0.9 ? truncated.slice(0, lastSpace) : truncated;
}
