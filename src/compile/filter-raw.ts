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
const KNOWN_TURN_RE = /^(Prompt|Response|Thinking|ToolUse(?:: .+)?|ToolResult(?:: .+)?|ToolError(?:: .+)?|Log(?:: .+)?|Event(?:: .+)?|SessionEnd)$/u;
const SIGNAL_TURN_RE = /^(Prompt|Response|Thinking)$/u;
const ANSI_RE = /\x1B\[[0-?]*[ -/]*[@-~]/gu;
const ASSET_TABLE_RE = /^.*\bdist\/assets\/\S+\s+\d+(?:\.\d+)?\s+kB\b.*\bgzip:\s*\d+(?:\.\d+)?\s+kB.*(?:\r?\n|$)/gimu;
const CWD_RESET_RE = /^.*Shell cwd was reset to .*$(?:\r?\n)?/gimu;
const BUILD_SUMMARY_RE = /^\s*[✓✔]\s*built in \d+(?:\.\d+)?\s*(?:ms|s)\s*$(?:\r?\n)?/gimu;
const SUGGESTION_PROMPT_RE = /# Overview[\s\S]*?Generate 0 to 3 hyperpersonalized[\s\S]*/u;
const DATA_BLOB_RE = /\bdata:[\w.+/-]+\/[\w.+-]+;base64,[A-Za-z0-9+/=]{200,}/gu;
const BASE64_BLOB_RE = /\b[A-Za-z0-9+/]{240,}={0,2}\b/gu;
const FAT_STRING_BYTES = 300;
const OUTPUT_MARKER = "**Output:**";
const OUTPUT_LINE_PRUNE_MIN_BYTES = 400;
const JSON_ALWAYS_KEEP_KEYS = new Set(["command", "cmd", "file_path", "path", "args", "argv", "input"]);
const JSON_ALWAYS_ELIDE_KEYS = new Set(["content", "originalFile", "structuredPatch"]);
const PROSE_SIGNAL_RES = [
  /^#{1,6}\s/mu,
  /\*\*(Findings|Summary|Conclusion|Decision|Recommendation|Result|Outcome|Root cause|Cause|Fix|Plan|Verdict)\b/iu,
  /\b(blocker|root cause|recommendation|conclusion|verdict|trade-?off)\b/iu,
];
const KEEP_LIST_RES = [
  /error[:\s]/iu,
  /\bfailed\b/iu,
  /^\s*\[[\w/.-]+ [0-9a-f]{7,}\]/imu,
  /\b\d+\s+(passed|failed|skipped)\b/iu,
  /\bfiles? changed\b/iu,
  /^@@ /mu,
  /^diff --git /mu,
  /^\s+at /mu,
  /Traceback/u,
  /error TS\d+/u,
  /MEMORY\.md/u,
  /\bRead\b.*\.(md|ts|tsx|js|jsx|json|yaml|yml|toml|txt)\b/iu,
  /```/u,
];
const LINE_SIGNAL_RES = [
  /error[:\s]/iu,
  /\bfailed\b/iu,
  /^\s*\[[\w/.-]+ [0-9a-f]{7,}\]/u,
  /\b\d+\s+(passed|failed|skipped)\b/iu,
  /\bfiles? changed\b/iu,
  /^@@ /u,
  /^diff --git /u,
  /^\s+at /u,
  /Traceback/u,
  /error TS\d+/u,
];

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
  const turns = splitTurns(text);
  const strippedByClass: Record<string, number> = {};
  const filtered = turns.length > 0 ? filterTurns(text, turns, strippedByClass) : stripNoise(text, strippedByClass).text;
  const bytesOut = Buffer.byteLength(filtered, "utf-8");
  const hasKeepSignal = hasKeepListSignal(text);
  const hasHardSignalTurn = turns.some((turn) => SIGNAL_TURN_RE.test(turn.kind));
  const hasUnknownTurn = turns.some((turn) => !KNOWN_TURN_RE.test(turn.kind));
  const noiseOnly = turns.length > 0
    && !hasKeepSignal
    && !hasHardSignalTurn
    && !hasUnknownTurn
    && turns.every((turn) => isKnownNoiseTurn(turn, strippedByClass));
  return {
    filtered,
    bytesIn,
    bytesOut,
    signalBytes: turns.length > 0
      ? turns.reduce((sum, turn) => sum + signalBytesForTurn(turn), 0)
      : bytesIn,
    strippedByClass,
    noiseOnly,
  };
}

function filterTurns(text: string, turns: RawTurn[], strippedByClass: Record<string, number>): string {
  let out = text.slice(0, text.indexOf(turns[0]!.header));
  for (const turn of turns) {
    const stripped = shouldStripTurn(turn) ? stripToolTurnBody(turn, strippedByClass) : turn.body;
    out += `${turn.header}\n${stripped}`;
  }
  return out;
}

function shouldStripTurn(turn: RawTurn): boolean {
  return /^(ToolUse(?:: .+)?|ToolResult(?:: .+)?|ToolError(?:: .+)?|Log(?:: .+)?|Event(?:: .+)?)$/u.test(turn.kind);
}

function shouldPruneWholeOutputTurn(turn: RawTurn): boolean {
  return /^(ToolResult(?:: .+)?|ToolError(?:: .+)?|Log(?:: .+)?|Event(?:: .+)?)$/u.test(turn.kind);
}

function stripNoise(text: string, strippedByClass: Record<string, number>): { text: string } {
  let next = text;
  next = replaceWithCount(next, ANSI_RE, "", "ansi", strippedByClass);
  next = replaceWithCount(next, ASSET_TABLE_RE, "", "asset-table", strippedByClass);
  next = replaceWithCount(next, BUILD_SUMMARY_RE, "", "build-summary", strippedByClass);
  next = stripFatJsonValues(next, strippedByClass);
  next = replaceWithCount(next, DATA_BLOB_RE, (match) => elisionFor(match), "data-blob", strippedByClass);
  next = replaceWithCount(next, BASE64_BLOB_RE, (match) => elisionFor(match), "base64-blob", strippedByClass);
  if (SUGGESTION_PROMPT_RE.test(next)) {
    const before = next;
    next = next.replace(SUGGESTION_PROMPT_RE, "");
    addStripped(strippedByClass, "suggestion-prompt", byteDelta(before, next));
  }
  next = replaceWithCount(next, CWD_RESET_RE, "", "cwd-reset", strippedByClass);
  return { text: next };
}

function stripToolTurnBody(turn: RawTurn, strippedByClass: Record<string, number>): string {
  const { body: text } = turn;
  const markerIndex = text.indexOf(OUTPUT_MARKER);
  if (markerIndex === -1) {
    const stripped = stripNoise(text, strippedByClass).text;
    if (
      shouldPruneWholeOutputTurn(turn)
      && Buffer.byteLength(stripped, "utf-8") > OUTPUT_LINE_PRUNE_MIN_BYTES
    ) {
      return pruneToolOutputLines(stripped, strippedByClass, false);
    }
    return stripped;
  }

  const beforeOutput = stripNoise(text.slice(0, markerIndex), strippedByClass).text;
  const output = stripNoise(text.slice(markerIndex), strippedByClass).text;
  if (Buffer.byteLength(output, "utf-8") <= OUTPUT_LINE_PRUNE_MIN_BYTES) {
    return `${beforeOutput}${output}`;
  }
  return `${beforeOutput}${pruneToolOutputLines(output, strippedByClass, true)}`;
}

function pruneToolOutputLines(text: string, strippedByClass: Record<string, number>, preserveOutputHeader: boolean): string {
  const lines = text.match(/[^\n]*(?:\n|$)/gu)?.filter((line) => line.length > 0) ?? [];
  let out = "";
  let dropped = "";
  let keptOutputHeader = !preserveOutputHeader;
  let keepNextDiffHunkLine = false;

  for (const line of lines) {
    const lineText = line.replace(/\r?\n$/u, "");
    if (!keptOutputHeader) {
      out += line;
      if (lineText.includes(OUTPUT_MARKER)) keptOutputHeader = true;
      continue;
    }
    if (isLineSignal(lineText)) {
      out += flushDroppedToolOutput(dropped, strippedByClass);
      dropped = "";
      out += line;
      keepNextDiffHunkLine = /^@@ /u.test(lineText);
    } else if (keepNextDiffHunkLine && /^[+\- ]/u.test(lineText)) {
      out += flushDroppedToolOutput(dropped, strippedByClass);
      dropped = "";
      out += line;
      keepNextDiffHunkLine = false;
    } else {
      dropped += line;
      keepNextDiffHunkLine = false;
    }
  }
  out += flushDroppedToolOutput(dropped, strippedByClass);
  return out;
}

function flushDroppedToolOutput(dropped: string, strippedByClass: Record<string, number>): string {
  if (dropped.length === 0) return "";
  if (dropped.trim().length === 0) return "";
  if (hasFatValueKeepSignal(dropped) && !hasJsonFileDumpKey(dropped)) return dropped;
  const droppedBytes = Buffer.byteLength(dropped, "utf-8");
  const placeholder = dropped.endsWith("\n")
    ? `[elided ${droppedBytes} bytes]\n`
    : `[elided ${droppedBytes} bytes]`;
  addStripped(strippedByClass, "tool-output", byteDelta(dropped, placeholder));
  return placeholder;
}

function isLineSignal(line: string): boolean {
  return LINE_SIGNAL_RES.some((re) => re.test(line));
}

function replaceWithCount(
  text: string,
  re: RegExp,
  replacement: string | ((match: string) => string),
  className: string,
  strippedByClass: Record<string, number>,
): string {
  return text.replace(re, (match: string) => {
    const next = typeof replacement === "function" ? replacement(match) : replacement;
    addStripped(strippedByClass, className, byteDelta(match, next));
    return next;
  });
}

function stripFatJsonValues(text: string, strippedByClass: Record<string, number>): string {
  const withFencedJson = stripJsonFences(text, strippedByClass);
  const trimmed = withFencedJson.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return stripJsonLines(withFencedJson, strippedByClass);
  const parsedWhole = replaceJsonText(trimmed, strippedByClass);
  if (parsedWhole !== null) {
    const leading = withFencedJson.slice(0, withFencedJson.indexOf(trimmed));
    const trailing = withFencedJson.slice(withFencedJson.indexOf(trimmed) + trimmed.length);
    return `${leading}${parsedWhole}${trailing}`;
  }
  return stripJsonLines(withFencedJson, strippedByClass);
}

function stripJsonFences(text: string, strippedByClass: Record<string, number>): string {
  return text.replace(/(```(?:json)?[^\S\r\n]*\r?\n)([\s\S]*?)(\r?\n```)/giu, (match, open: string, body: string, close: string) => {
    const trimmed = body.trim();
    if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return match;
    const replaced = replaceJsonText(trimmed, strippedByClass);
    if (replaced === null) return match;
    const leading = body.slice(0, body.indexOf(trimmed));
    const trailing = body.slice(body.indexOf(trimmed) + trimmed.length);
    return `${open}${leading}${replaced}${trailing}${close}`;
  });
}

function stripJsonLines(text: string, strippedByClass: Record<string, number>): string {
  return text.split(/(\r?\n)/).map((part) => {
    const trimmed = part.trim();
    if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return part;
    const replaced = replaceJsonText(trimmed, strippedByClass);
    if (replaced === null) return part;
    const leading = part.slice(0, part.indexOf(trimmed));
    const trailing = part.slice(part.indexOf(trimmed) + trimmed.length);
    return `${leading}${replaced}${trailing}`;
  }).join("");
}

function replaceJsonText(text: string, strippedByClass: Record<string, number>): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  let didStrip = false;
  const normalized = replaceFatJsonValue(parsed, [], (className, before, after) => {
    didStrip = true;
    addStripped(strippedByClass, className, byteDelta(before, after));
  });
  return didStrip ? JSON.stringify(normalized, null, 2) : null;
}

function replaceFatJsonValue(
  value: unknown,
  path: string[],
  onStrip: (className: string, before: string, after: string) => void,
): unknown {
  if (Array.isArray(value)) return value.map((item) => replaceFatJsonValue(item, path, onStrip));
  if (typeof value === "string") return replaceFatJsonStringValue(value, path, onStrip);
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  const next: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(record)) {
    if (key === "stderr" && typeof child === "string" && /^\n?Shell cwd was reset to /u.test(child)) {
      const bytes = Buffer.byteLength(child, "utf-8");
      const replacement = `[elided ${bytes} bytes]`;
      onStrip("cwd-reset", child, replacement);
      next[key] = replacement;
    } else {
      next[key] = replaceFatJsonValue(child, [...path, key], onStrip);
    }
  }
  return next;
}

function replaceFatJsonStringValue(
  value: string,
  path: string[],
  onStrip: (className: string, before: string, after: string) => void,
): string {
  const bytes = Buffer.byteLength(value, "utf-8");
  if (bytes <= FAT_STRING_BYTES) return value;
  const key = path.at(-1);
  if (key !== undefined && JSON_ALWAYS_KEEP_KEYS.has(key)) return value;
  if (key !== undefined && JSON_ALWAYS_ELIDE_KEYS.has(key)) {
    const mediaClass = mediaDataClass(value, path);
    const replacement = `[elided ${bytes} bytes]`;
    onStrip(mediaClass ?? "json-fat-value", value, replacement);
    return replacement;
  }

  const mediaClass = mediaDataClass(value, path);
  if (mediaClass !== null) {
    const replacement = `[elided ${bytes} bytes]`;
    onStrip(mediaClass, value, replacement);
    return replacement;
  }
  if (hasFatValueKeepSignal(value)) return value;
  const replacement = `[elided ${bytes} bytes]`;
  onStrip("json-fat-value", value, replacement);
  return replacement;
}

function mediaDataClass(value: string, path: string[]): "image-data" | "base64-blob" | null {
  const key = path.at(-1);
  if (key === "data" || key === "image" || key === "media_type") return "image-data";
  const compact = value.replace(/\s+/gu, "");
  if (/^[A-Za-z0-9+/]{240,}={0,2}$/u.test(compact) && !/[ \t]/u.test(value)) return "base64-blob";
  return null;
}

function hasFatValueKeepSignal(value: string): boolean {
  return hasLineSignal(value) || hasProseSignal(value);
}

function hasJsonFileDumpKey(value: string): boolean {
  return /"(?:content|originalFile|structuredPatch)"\s*:/u.test(value);
}

function hasLineSignal(value: string): boolean {
  const lines = value.match(/[^\n]*(?:\n|$)/gu)?.filter((line) => line.length > 0) ?? [];
  return lines.some((line) => isLineSignal(line.replace(/\r?\n$/u, "")));
}

function hasProseSignal(value: string): boolean {
  return PROSE_SIGNAL_RES.some((re) => re.test(value));
}

function isKnownNoiseTurn(turn: RawTurn, strippedByClass: Record<string, number>): boolean {
  if (SIGNAL_TURN_RE.test(turn.kind)) return false;
  if (/^SessionEnd$/u.test(turn.kind)) return turn.body.trim().length === 0;
  if (!shouldStripTurn(turn)) return turn.body.trim().length === 0;
  const stripped = stripNoise(turn.body, { ...strippedByClass }).text.trim();
  return stripped.length === 0 || isPlaceholderOnlyJson(stripped);
}

function isPlaceholderOnlyJson(text: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return false;
  }
  let sawPlaceholder = false;
  let sawSignal = false;
  visitJsonLeaves(parsed, (value) => {
    if (typeof value !== "string") {
      sawSignal = true;
      return;
    }
    if (/^\[elided \d+ bytes\]$/u.test(value)) sawPlaceholder = true;
    else if (value.trim().length > 0) sawSignal = true;
  });
  return sawPlaceholder && !sawSignal;
}

function visitJsonLeaves(value: unknown, visitor: (value: unknown) => void): void {
  if (Array.isArray(value)) {
    for (const item of value) visitJsonLeaves(item, visitor);
    return;
  }
  if (value && typeof value === "object") {
    for (const child of Object.values(value as Record<string, unknown>)) visitJsonLeaves(child, visitor);
    return;
  }
  visitor(value);
}

function signalBytesForTurn(turn: RawTurn): number {
  if (SIGNAL_TURN_RE.test(turn.kind) || !KNOWN_TURN_RE.test(turn.kind)) {
    return Buffer.byteLength(turn.body, "utf-8");
  }
  const stripped = shouldStripTurn(turn) ? stripToolTurnBody(turn, {}) : stripNoise(turn.body, {}).text;
  if (hasKeepListSignal(turn.body) && !shouldStripTurn(turn)) {
    return Buffer.byteLength(turn.body, "utf-8");
  }
  return isPlaceholderOnlyJson(stripped.trim()) ? 0 : Buffer.byteLength(stripped, "utf-8");
}

function hasKeepListSignal(text: string): boolean {
  return KEEP_LIST_RES.some((re) => re.test(text));
}

function elisionFor(value: string): string {
  return `[elided ${Buffer.byteLength(value, "utf-8")} bytes]`;
}

function addStripped(strippedByClass: Record<string, number>, className: string, bytes: number): void {
  if (bytes <= 0) return;
  strippedByClass[className] = (strippedByClass[className] ?? 0) + bytes;
}

function byteDelta(before: string, after: string): number {
  return Buffer.byteLength(before, "utf-8") - Buffer.byteLength(after, "utf-8");
}
