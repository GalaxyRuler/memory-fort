import { ClaudeCodeSniffer } from "../../sniffers/claude-code.js";
import { ClaudeDesktopSniffer } from "../../sniffers/claude-desktop.js";
import { runWatchRunner, type WatchRunnerResult } from "../../sniffers/watch-runner.js";
import type { Sniffer } from "../../sniffers/types.js";

export interface WatchOptions {
  clients?: string[] | string;
  sniffers?: Sniffer[];
  now?: Date;
  once?: boolean;
  shutdown?: Promise<void>;
  onStatus?: (line: string) => void;
}

export async function runWatch(opts: WatchOptions = {}): Promise<WatchRunnerResult> {
  const clients = normalizeClients(opts.clients);
  return runWatchRunner({
    clients,
    sniffers: opts.sniffers ?? defaultWatchSniffers(),
    now: opts.now,
    once: opts.once,
    shutdown: opts.shutdown,
    onStatus: opts.onStatus,
  });
}

export function formatWatchResult(result: WatchRunnerResult): string {
  const skipped = result.skipped
    .filter((item) => item.reason !== "filtered")
    .map((item) => `${item.sniffer}:${item.reason}`)
    .join(", ");
  return [
    `watching: ${result.started.length > 0 ? result.started.join(", ") : "(none)"}`,
    `captured: ${result.captured}`,
    skipped ? `skipped: ${skipped}` : null,
    `log: ${result.logPath}`,
    "",
  ].filter(Boolean).join("\n");
}

function defaultWatchSniffers(): Sniffer[] {
  return [
    new ClaudeCodeSniffer(),
    new ClaudeDesktopSniffer(),
  ];
}

function normalizeClients(value: string[] | string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) return value;
  return value
    .split(",")
    .map((client) => client.trim())
    .filter((client) => client.length > 0);
}
