export interface MarkdownChunk {
  readonly text: string;
  readonly headingPath: string | null;
  /** Estimated by a cheap whitespace-run heuristic, not a model tokenizer. */
  readonly tokenCount: number;
  /** UTF-8 byte offset into the original markdown Buffer. */
  readonly byteStart: number;
  /** UTF-8 byte offset into the original markdown Buffer. */
  readonly byteEnd: number;
}

export interface ChunkMarkdownOptions {
  readonly maxTokens?: number;
  readonly overlapTokens?: number;
  /** Per-chunk byte cap; using bytes keeps returned context bounded for huge sections. */
  readonly maxChunkChars?: number;
}

interface Section {
  readonly byteStart: number;
  readonly byteEnd: number;
  readonly headingPath: string | null;
}

interface Heading {
  readonly level: number;
  readonly title: string;
}

interface Piece {
  readonly byteStart: number;
  readonly byteEnd: number;
  readonly tokenCount: number;
}

const DEFAULT_MAX_TOKENS = 384;
const DEFAULT_OVERLAP_TOKENS = 48;
const CONTROL_LINE_LIMIT_BYTES = 8_192;

export function chunkMarkdown(md: string, options: ChunkMarkdownOptions = {}): MarkdownChunk[] {
  const maxTokens = positiveInteger(options.maxTokens ?? DEFAULT_MAX_TOKENS, "maxTokens");
  const maxChunkBytes = positiveInteger(options.maxChunkChars ?? Math.max(1_024, maxTokens * 24), "maxChunkChars");
  const overlapTokens = Math.min(
    Math.max(0, Math.trunc(options.overlapTokens ?? DEFAULT_OVERLAP_TOKENS)),
    Math.max(0, maxTokens - 1),
  );
  const source = Buffer.from(md, "utf8");
  const chunks: MarkdownChunk[] = [];

  for (const section of splitSections(source)) {
    appendSectionChunks(chunks, source, section, maxTokens, overlapTokens, maxChunkBytes);
  }

  return chunks;
}

function appendSectionChunks(
  chunks: MarkdownChunk[],
  source: Buffer,
  section: Section,
  maxTokens: number,
  overlapTokens: number,
  maxChunkBytes: number,
): void {
  let currentStart: number | null = null;
  let currentEnd = 0;

  for (const piece of iteratePieces(source, section.byteStart, section.byteEnd, maxTokens, maxChunkBytes)) {
    if (currentStart === null) {
      currentStart = piece.byteStart;
      currentEnd = piece.byteEnd;
      continue;
    }

    if (rangeFits(source, currentStart, piece.byteEnd, maxTokens, maxChunkBytes)) {
      currentEnd = piece.byteEnd;
      continue;
    }

    emitChunk(chunks, source, section.headingPath, currentStart, currentEnd);
    currentStart = startWithOverlap(source, currentStart, currentEnd, piece, overlapTokens, maxTokens, maxChunkBytes);
    currentEnd = piece.byteEnd;
  }

  if (currentStart !== null) {
    emitChunk(chunks, source, section.headingPath, currentStart, currentEnd);
  }
}

function emitChunk(
  chunks: MarkdownChunk[],
  source: Buffer,
  headingPath: string | null,
  byteStart: number,
  byteEnd: number,
): void {
  const trimmed = trimAsciiWhitespace(source, byteStart, byteEnd);
  if (trimmed.byteStart >= trimmed.byteEnd) return;
  chunks.push({
    text: source.subarray(trimmed.byteStart, trimmed.byteEnd).toString("utf8"),
    headingPath,
    tokenCount: countTokens(source, trimmed.byteStart, trimmed.byteEnd),
    byteStart: trimmed.byteStart,
    byteEnd: trimmed.byteEnd,
  });
}

function startWithOverlap(
  source: Buffer,
  previousStart: number,
  previousEnd: number,
  nextPiece: Piece,
  overlapTokens: number,
  maxTokens: number,
  maxChunkBytes: number,
): number {
  // Adjacent chunks in the same section carry a small tail overlap to reduce BM25
  // boundary-term bias. Callers should still dedupe/group by file and heading.
  let requestedOverlap = Math.min(overlapTokens, Math.max(0, maxTokens - nextPiece.tokenCount));
  while (requestedOverlap > 0) {
    const overlapStart = findStartOfLastTokens(source, previousStart, previousEnd, requestedOverlap);
    if (rangeFits(source, overlapStart, nextPiece.byteEnd, maxTokens, maxChunkBytes)) return overlapStart;
    requestedOverlap -= 1;
  }
  return nextPiece.byteStart;
}

function* iteratePieces(
  source: Buffer,
  byteStart: number,
  byteEnd: number,
  maxTokens: number,
  maxChunkBytes: number,
): Generator<Piece> {
  for (const paragraph of iterateParagraphs(source, byteStart, byteEnd)) {
    if (rangeFits(source, paragraph.byteStart, paragraph.byteEnd, maxTokens, maxChunkBytes)) {
      yield paragraph;
      continue;
    }

    for (const sentence of iterateSentences(source, paragraph.byteStart, paragraph.byteEnd)) {
      if (rangeFits(source, sentence.byteStart, sentence.byteEnd, maxTokens, maxChunkBytes)) {
        yield sentence;
        continue;
      }
      yield* iterateTokenWindows(source, sentence.byteStart, sentence.byteEnd, maxTokens, maxChunkBytes);
    }
  }
}

function* iterateParagraphs(source: Buffer, byteStart: number, byteEnd: number): Generator<Piece> {
  let paragraphStart = byteStart;
  let lineStart = byteStart;

  while (lineStart < byteEnd) {
    const newline = source.indexOf(0x0a, lineStart);
    const lineContentEnd = newline === -1 || newline > byteEnd ? byteEnd : newline;
    const lineEnd = newline === -1 || newline >= byteEnd ? byteEnd : newline + 1;

    if (isBlankLine(source, lineStart, lineContentEnd)) {
      yield* yieldRange(source, paragraphStart, lineStart);
      paragraphStart = lineEnd;
    }

    lineStart = lineEnd;
  }

  yield* yieldRange(source, paragraphStart, byteEnd);
}

function* iterateSentences(source: Buffer, byteStart: number, byteEnd: number): Generator<Piece> {
  let sentenceStart = byteStart;
  for (let index = byteStart; index < byteEnd; index += 1) {
    const byte = source[index];
    if (!isSentenceTerminator(byte)) continue;
    const next = index + 1;
    if (next < byteEnd && !isWhitespaceByte(source[next])) continue;
    yield* yieldRange(source, sentenceStart, next);
    sentenceStart = next;
  }
  yield* yieldRange(source, sentenceStart, byteEnd);
}

function* iterateTokenWindows(
  source: Buffer,
  byteStart: number,
  byteEnd: number,
  maxTokens: number,
  maxChunkBytes: number,
): Generator<Piece> {
  let windowStart: number | null = null;
  let windowEnd = 0;
  let windowTokens = 0;
  let cursor = byteStart;

  while (cursor < byteEnd) {
    while (cursor < byteEnd && isWhitespaceByte(source[cursor])) cursor += 1;
    if (cursor >= byteEnd) break;

    const tokenStart = cursor;
    while (cursor < byteEnd && !isWhitespaceByte(source[cursor])) cursor += 1;
    const tokenEnd = cursor;

    if (tokenEnd - tokenStart > maxChunkBytes) {
      if (windowStart !== null) {
        yield { byteStart: windowStart, byteEnd: windowEnd, tokenCount: windowTokens };
        windowStart = null;
        windowTokens = 0;
      }
      yield* splitOversizedToken(source, tokenStart, tokenEnd, maxChunkBytes);
      continue;
    }

    if (windowStart === null) {
      windowStart = tokenStart;
      windowEnd = tokenEnd;
      windowTokens = 1;
      continue;
    }

    if (windowTokens + 1 > maxTokens || tokenEnd - windowStart > maxChunkBytes) {
      yield { byteStart: windowStart, byteEnd: windowEnd, tokenCount: windowTokens };
      windowStart = tokenStart;
      windowEnd = tokenEnd;
      windowTokens = 1;
      continue;
    }

    windowEnd = tokenEnd;
    windowTokens += 1;
  }

  if (windowStart !== null) {
    yield { byteStart: windowStart, byteEnd: windowEnd, tokenCount: windowTokens };
  }
}

function* splitOversizedToken(
  source: Buffer,
  byteStart: number,
  byteEnd: number,
  maxChunkBytes: number,
): Generator<Piece> {
  let cursor = byteStart;
  while (cursor < byteEnd) {
    const next = clampUtf8Boundary(source, Math.min(byteEnd, cursor + maxChunkBytes), cursor, byteEnd);
    yield { byteStart: cursor, byteEnd: next, tokenCount: 1 };
    cursor = next;
  }
}

function* yieldRange(source: Buffer, byteStart: number, byteEnd: number): Generator<Piece> {
  const trimmed = trimAsciiWhitespace(source, byteStart, byteEnd);
  if (trimmed.byteStart >= trimmed.byteEnd) return;
  yield {
    byteStart: trimmed.byteStart,
    byteEnd: trimmed.byteEnd,
    tokenCount: countTokens(source, trimmed.byteStart, trimmed.byteEnd),
  };
}

function splitSections(source: Buffer): Section[] {
  const sections: Section[] = [];
  const headings: Heading[] = [];
  let sectionStart = 0;
  let sectionHeadingPath: string | null = null;
  let lineStart = 0;
  let inFrontmatter = false;
  let inFence: { marker: "`" | "~"; length: number } | null = null;

  while (lineStart < source.length) {
    const newline = source.indexOf(0x0a, lineStart);
    const lineContentEnd = newline === -1 ? source.length : newline;
    const lineEnd = newline === -1 ? source.length : newline + 1;
    const line = decodeControlLine(source, lineStart, lineContentEnd);
    const frontmatterDelimiter = /^(?:---|\.\.\.)[ \t]*$/.test(line);
    const opensFrontmatter = lineStart === 0 && /^---[ \t]*$/.test(line);
    const fence = parseFence(line);
    let heading: Heading | null = null;

    if (opensFrontmatter) {
      inFrontmatter = true;
    } else if (inFrontmatter) {
      if (frontmatterDelimiter) inFrontmatter = false;
    } else if (inFence) {
      if (fence && fence.marker === inFence.marker && fence.length >= inFence.length) {
        inFence = null;
      }
    } else if (fence) {
      inFence = fence;
    } else {
      heading = parseAtxHeading(line);
    }

    if (heading) {
      if (lineStart > sectionStart) {
        sections.push({ byteStart: sectionStart, byteEnd: lineStart, headingPath: sectionHeadingPath });
      }
      while (headings.length > 0 && headings[headings.length - 1]?.level >= heading.level) {
        headings.pop();
      }
      headings.push(heading);
      sectionStart = lineStart;
      sectionHeadingPath = headings.map((item) => item.title).join(" > ");
    }

    lineStart = lineEnd;
  }

  if (sectionStart < source.length) {
    sections.push({ byteStart: sectionStart, byteEnd: source.length, headingPath: sectionHeadingPath });
  }

  return sections;
}

function parseAtxHeading(line: string): Heading | null {
  const match = /^( {0,3})(#{1,6})(?:[ \t]+|$)(.*?)(?:[ \t]+#+[ \t]*)?$/.exec(line);
  if (!match) return null;
  return { level: match[2].length, title: match[3].trim() };
}

function parseFence(line: string): { marker: "`" | "~"; length: number } | null {
  const match = /^(?: {0,3})(`{3,}|~{3,})/.exec(line);
  if (!match) return null;
  return { marker: match[1][0] as "`" | "~", length: match[1].length };
}

function decodeControlLine(source: Buffer, byteStart: number, byteEnd: number): string {
  const limitedEnd = Math.min(byteEnd, byteStart + CONTROL_LINE_LIMIT_BYTES);
  return source.subarray(byteStart, limitedEnd).toString("utf8").replace(/\r$/, "");
}

function rangeFits(source: Buffer, byteStart: number, byteEnd: number, maxTokens: number, maxChunkBytes: number): boolean {
  return byteEnd - byteStart <= maxChunkBytes && countTokens(source, byteStart, byteEnd) <= maxTokens;
}

// Cheap token heuristic: any run of non-ASCII-whitespace bytes counts as one token.
// It is deliberately fast and deterministic, not a language model tokenizer.
function countTokens(source: Buffer, byteStart: number, byteEnd: number): number {
  let count = 0;
  let inToken = false;
  for (let index = byteStart; index < byteEnd; index += 1) {
    if (isWhitespaceByte(source[index])) {
      inToken = false;
    } else if (!inToken) {
      count += 1;
      inToken = true;
    }
  }
  return count;
}

function findStartOfLastTokens(source: Buffer, byteStart: number, byteEnd: number, maxTokens: number): number {
  if (maxTokens <= 0) return byteEnd;
  let found = 0;
  let cursor = byteEnd - 1;

  while (cursor >= byteStart) {
    while (cursor >= byteStart && isWhitespaceByte(source[cursor])) cursor -= 1;
    if (cursor < byteStart) break;
    while (cursor >= byteStart && !isWhitespaceByte(source[cursor])) cursor -= 1;
    const tokenStart = cursor + 1;
    found += 1;
    if (found === maxTokens) return tokenStart;
  }

  return byteStart;
}

function trimAsciiWhitespace(source: Buffer, byteStart: number, byteEnd: number): { byteStart: number; byteEnd: number } {
  let start = byteStart;
  let end = byteEnd;
  while (start < end && isWhitespaceByte(source[start])) start += 1;
  while (end > start && isWhitespaceByte(source[end - 1])) end -= 1;
  return { byteStart: start, byteEnd: end };
}

function isBlankLine(source: Buffer, byteStart: number, byteEnd: number): boolean {
  for (let index = byteStart; index < byteEnd; index += 1) {
    if (!isWhitespaceByte(source[index])) return false;
  }
  return true;
}

function isWhitespaceByte(byte: number): boolean {
  return byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d || byte === 0x0b || byte === 0x0c;
}

function isSentenceTerminator(byte: number): boolean {
  return byte === 0x2e || byte === 0x21 || byte === 0x3f;
}

function clampUtf8Boundary(source: Buffer, preferredEnd: number, byteStart: number, byteEnd: number): number {
  if (preferredEnd >= byteEnd) return byteEnd;
  let candidate = preferredEnd;
  while (candidate > byteStart && isUtf8ContinuationByte(source[candidate])) candidate -= 1;
  if (candidate > byteStart) return candidate;

  candidate = preferredEnd;
  while (candidate < byteEnd && isUtf8ContinuationByte(source[candidate])) candidate += 1;
  return Math.min(byteEnd, candidate);
}

function isUtf8ContinuationByte(byte: number): boolean {
  return (byte & 0xc0) === 0x80;
}

function positiveInteger(value: number, name: string): number {
  const integer = Math.trunc(value);
  if (!Number.isFinite(value) || integer < 1) {
    throw new RangeError(`${name} must be a positive integer`);
  }
  return integer;
}
