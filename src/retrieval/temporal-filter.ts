import type { SearchDocument } from "./corpus.js";

/**
 * Parse and validate an `asOf` date string.
 * Returns undefined if input is undefined.
 * Throws on invalid/empty strings — callers should catch and return HTTP 400.
 */
export function parseAsOf(asOf: string | undefined): Date | undefined {
  if (asOf === undefined) return undefined;
  if (!asOf.trim()) throw new Error(`invalid asOf date: ${JSON.stringify(asOf)}`);
  const date = new Date(asOf);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`invalid asOf date: ${JSON.stringify(asOf)}`);
  }
  return date;
}

/**
 * Filter documents by temporal validity.
 * Intervals are inclusive: [valid_from, valid_until].
 * A page with valid_until: 2026-06-09 IS valid on 2026-06-09.
 * Untemporalized pages (no valid_from or valid_until) always pass.
 */
export function filterDocumentsByValidity(
  docs: SearchDocument[],
  asOf: string | undefined,
): SearchDocument[] {
  if (!asOf) return docs;

  const asOfDate = parseAsOf(asOf);
  if (!asOfDate) return docs;

  return docs.filter((doc) => {
    const rf = doc.rawFrontmatter;
    if (!rf) return true;

    const validFrom = rf["valid_from"] as string | undefined;
    const validUntil = rf["valid_until"] as string | undefined;

    if (!validFrom && !validUntil) return true;

    if (validFrom && new Date(validFrom) > asOfDate) return false;
    // Inclusive: valid_until: 2026-06-09 means valid ON 2026-06-09
    if (validUntil && new Date(validUntil) < asOfDate) return false;

    return true;
  });
}
