export interface CondenseIndexOptions {
  descChars: number;
  maxBytes: number;
}

export interface CondensedIndex {
  text: string;
  bytesIn: number;
  bytesOut: number;
}

const ENTRY_RE = /^(\s*-\s+\[[^\]]+\]\([^)]+\))(?:\s+-\s*(.*))?$/;

export function condenseIndex(indexText: string, opts: CondenseIndexOptions): CondensedIndex {
  const descChars = Math.max(0, Math.floor(opts.descChars));
  const maxBytes = Math.max(0, Math.floor(opts.maxBytes));
  const bytesIn = Buffer.byteLength(indexText, "utf-8");
  const lines = indexText.split("\n");
  const condensedLines = lines.map((line) => condenseLine(line, descChars));
  const cappedLines = capIndexLines(condensedLines, maxBytes);
  const text = cappedLines.join("\n");
  return {
    text,
    bytesIn,
    bytesOut: Buffer.byteLength(text, "utf-8"),
  };
}

function condenseLine(line: string, descChars: number): string {
  const match = ENTRY_RE.exec(line);
  if (!match) return line;
  const link = match[1]!;
  const description = (match[2] ?? "").replace(/\s+/g, " ").trim();
  if (description.length === 0) return link;
  const shortened = description.length > descChars
    ? `${description.slice(0, descChars).trimEnd()}...`
    : description;
  return `${link} - ${shortened}`;
}

function capIndexLines(lines: string[], maxBytes: number): string[] {
  if (Buffer.byteLength(lines.join("\n"), "utf-8") <= maxBytes) return lines;

  const capped = [...lines];
  let omitted = 0;
  while (Buffer.byteLength([...capped, truncationNote(omitted + 1)].join("\n"), "utf-8") > maxBytes) {
    const lastEntryIndex = findLastEntryIndex(capped);
    if (lastEntryIndex === -1) break;
    capped.splice(lastEntryIndex, 1);
    omitted += 1;
  }

  if (omitted > 0) {
    capped.push(truncationNote(omitted));
  }
  return capped;
}

function findLastEntryIndex(lines: string[]): number {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (ENTRY_RE.test(lines[index]!)) return index;
  }
  return -1;
}

function truncationNote(omitted: number): string {
  return `> [index truncated: ${omitted} more pages omitted]`;
}
