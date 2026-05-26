import { join } from "node:path";
import { atomicAppend, atomicWrite } from "../storage/atomic-write.js";
import { formatIsoDate, memoryRoot } from "../storage/paths.js";
import { rawSessionRelPath, renderRawSession } from "./run-sniffer.js";
import type { Closable, RawSession, Sniffer } from "./types.js";

export interface WatchRunnerOptions {
  clients?: string[];
  sniffers: Sniffer[];
  root?: string;
  now?: Date;
  once?: boolean;
  onceTimeoutMs?: number;
  shutdown?: Promise<void>;
  statusIntervalMs?: number;
  onStatus?: (line: string) => void;
}

export interface WatchRunnerResult {
  started: string[];
  skipped: Array<{ sniffer: string; reason: "filtered" | "unavailable" | "no-watch" | "failed" }>;
  captured: number;
  logPath: string;
}

export async function runWatchRunner(
  opts: WatchRunnerOptions,
): Promise<WatchRunnerResult> {
  const root = opts.root ?? memoryRoot();
  const now = opts.now ?? new Date();
  const logPath = join(root, "logs", `watch-${formatIsoDate(now)}.log`);
  const selected = new Set(opts.clients ?? []);
  const result: WatchRunnerResult = {
    started: [],
    skipped: [],
    captured: 0,
    logPath,
  };
  const closers: Closable[] = [];
  let resolveFirstCapture: (() => void) | undefined;
  const firstCapture = new Promise<void>((resolve) => {
    resolveFirstCapture = resolve;
  });

  const capture = async (sniffer: Sniffer, session: RawSession): Promise<void> => {
    const relPath = rawSessionRelPath(session);
    await atomicWrite(join(root, ...relPath.split("/")), renderRawSession(session));
    result.captured++;
    await appendWatchLog(logPath, `captured ${sniffer.name} ${session.sessionId} -> ${relPath}`);
    resolveFirstCapture?.();
  };

  for (const sniffer of opts.sniffers) {
    if (selected.size > 0 && !selected.has(sniffer.name)) {
      continue;
    }
    if (!(await sniffer.available())) {
      result.skipped.push({ sniffer: sniffer.name, reason: "unavailable" });
      await appendWatchLog(logPath, `skipped ${sniffer.name}: unavailable`);
      continue;
    }
    if (!sniffer.watch) {
      result.skipped.push({ sniffer: sniffer.name, reason: "no-watch" });
      await appendWatchLog(logPath, `skipped ${sniffer.name}: no live watcher`);
      continue;
    }

    try {
      const closer = sniffer.watch((session) => {
        void capture(sniffer, session);
      });
      closers.push(closer);
      result.started.push(sniffer.name);
      await appendWatchLog(logPath, `started ${sniffer.name}`);
    } catch {
      result.skipped.push({ sniffer: sniffer.name, reason: "failed" });
      await appendWatchLog(logPath, `failed to start ${sniffer.name}`);
    }
  }

  const statusInterval = setInterval(() => {
    opts.onStatus?.(
      `watching ${result.started.length} clients · ${result.captured} sessions captured this session`,
    );
  }, opts.statusIntervalMs ?? 30_000);

  try {
    if (opts.once) {
      if (result.started.length > 0) {
        await Promise.race([
          firstCapture,
          new Promise((resolve) => setTimeout(resolve, opts.onceTimeoutMs ?? 1000)),
        ]);
      }
      return result;
    }

    await (opts.shutdown ?? new Promise<void>(() => undefined));
    return result;
  } finally {
    clearInterval(statusInterval);
    await Promise.all(closers.map((closer) => closer.close()));
    await appendWatchLog(logPath, `stopped watch: captured ${result.captured}`);
  }
}

function appendWatchLog(logPath: string, line: string): Promise<void> {
  return atomicAppend(logPath, `[${new Date().toISOString()}] ${line}\n`);
}
