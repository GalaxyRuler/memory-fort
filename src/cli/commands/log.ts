import {
  ensureRawSessionFile,
  appendBlock,
  formatObservationBlock,
} from "../../hooks/raw-file.js";

export interface LogOptions {
  text: string;
  tags?: string[];
  confidence?: number;
  /** For tests. */
  now?: Date;
  sessionId?: () => string;
}

export interface LogResult {
  path: string;
  sessionId: string;
  bytesAppended: number;
}

export async function runLog(opts: LogOptions): Promise<LogResult> {
  const text = opts.text.trim();
  if (text.length === 0) {
    throw new Error("memory log: text must be non-empty");
  }
  if (
    opts.confidence !== undefined &&
    (!Number.isFinite(opts.confidence) || opts.confidence < 0 || opts.confidence > 1)
  ) {
    throw new Error(
      `memory log: --confidence must be a number between 0 and 1 (got: ${opts.confidence})`,
    );
  }

  const now = opts.now ?? new Date();
  const sessionId = (opts.sessionId ?? (() => `manual-${now.getTime()}`))();
  const cwd = process.cwd();

  const filePath = await ensureRawSessionFile({
    tool: "manual",
    sessionId,
    cwd,
    now,
  });
  const block = formatObservationBlock({
    text,
    tags: opts.tags,
    confidence: opts.confidence,
    now,
  });
  await appendBlock({ tool: "manual", sessionId, block, now });

  return {
    path: filePath,
    sessionId,
    bytesAppended: Buffer.byteLength(block, "utf-8"),
  };
}
