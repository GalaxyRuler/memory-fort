export interface RawTurn {
  header: string;
  kind: string;
  body: string;
}

export interface RawFilterResult {
  filtered: string;
  bytesIn: number;
  bytesOut: number;
  signalBytes: number;
  strippedByClass: Record<string, number>;
  noiseOnly: boolean;
}

const TURN_HEADER_RE = /^## \[\d{2}:\d{2}:\d{2}\] (.+)$/gm;

export function splitTurns(text: string): RawTurn[] {
  const matches = [...text.matchAll(TURN_HEADER_RE)];
  return matches.map((match, index) => {
    const headerStart = match.index ?? 0;
    const headerEnd = text.indexOf("\n", headerStart);
    const bodyStart = headerEnd === -1 ? text.length : headerEnd + 1;
    const nextStart = matches[index + 1]?.index ?? text.length;
    return {
      header: text.slice(headerStart, headerEnd === -1 ? text.length : headerEnd),
      kind: match[1] ?? "",
      body: text.slice(bodyStart, nextStart),
    };
  });
}

export function filterRawText(text: string): RawFilterResult {
  const bytesIn = Buffer.byteLength(text, "utf-8");
  const bytesOut = bytesIn;
  const turns = splitTurns(text);
  return {
    filtered: text,
    bytesIn,
    bytesOut,
    signalBytes: turns.length > 0
      ? turns.reduce((sum, turn) => sum + Buffer.byteLength(turn.body, "utf-8"), 0)
      : bytesIn,
    strippedByClass: {},
    noiseOnly: false,
  };
}
