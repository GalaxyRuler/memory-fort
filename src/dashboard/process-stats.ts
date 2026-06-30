import { monitorEventLoopDelay } from "node:perf_hooks";
import v8 from "node:v8";

export interface ProcessMemorySnapshot {
  readonly rss: number;
  readonly external: number;
  readonly arrayBuffers: number;
  readonly heapUsed: number;
  readonly usedHeapSize: number;
}

export interface ProcessPeakMemorySnapshot extends ProcessMemorySnapshot {
  readonly sampledAt: string;
}

export interface ProcessEventLoopDelaySnapshot {
  readonly minMs: number;
  readonly meanMs: number;
  readonly maxMs: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly p99Ms: number;
}

export interface ProcessStatsSnapshot {
  readonly current: ProcessMemorySnapshot;
  readonly peak: ProcessPeakMemorySnapshot;
  readonly eventLoopDelay: ProcessEventLoopDelaySnapshot;
}

export interface ProcessStatsRequest {
  readonly type: "process-stats";
  readonly id?: string;
}

export interface ProcessStatsResponse {
  readonly type: "process-stats";
  readonly id?: string;
  readonly role: string;
  readonly stats: ProcessStatsSnapshot;
}

export interface ProcessStatsMonitor {
  observe(): void;
  snapshot(): ProcessStatsSnapshot;
  close(): void;
}

export function createProcessStatsMonitor(opts: {
  readonly enabled?: boolean;
  readonly intervalMs?: number;
} = {}): ProcessStatsMonitor {
  const enabled = opts.enabled ?? process.env["MEMORY_PROCESS_STATS"] === "1";
  const delay = monitorEventLoopDelay({ resolution: 20 });
  let delayEnabled = false;
  let peak = { ...readMemory(), sampledAt: new Date().toISOString() };
  let interval: NodeJS.Timeout | null = null;

  function observe(): void {
    const current = readMemory();
    if (isHigherPeak(current, peak)) {
      peak = { ...current, sampledAt: new Date().toISOString() };
    }
  }

  if (enabled) {
    delay.enable();
    delayEnabled = true;
    interval = setInterval(observe, Math.max(50, opts.intervalMs ?? 250));
    interval.unref?.();
  }

  return {
    observe,
    snapshot: () => {
      observe();
      return {
        current: readMemory(),
        peak,
        eventLoopDelay: delayEnabled ? readEventLoopDelay(delay) : emptyEventLoopDelay(),
      };
    },
    close: () => {
      if (interval) {
        clearInterval(interval);
        interval = null;
      }
      if (delayEnabled) {
        delay.disable();
        delayEnabled = false;
      }
    },
  };
}

export function isProcessStatsRequest(message: unknown): message is ProcessStatsRequest {
  return (
    typeof message === "object" &&
    message !== null &&
    (message as { type?: unknown }).type === "process-stats"
  );
}

export function createProcessStatsResponse(
  role: string,
  request: ProcessStatsRequest,
  stats: ProcessStatsSnapshot,
): ProcessStatsResponse {
  return {
    type: "process-stats",
    ...(typeof request.id === "string" ? { id: request.id } : {}),
    role,
    stats,
  };
}

function readMemory(): ProcessMemorySnapshot {
  const memory = process.memoryUsage();
  return {
    rss: memory.rss,
    external: memory.external,
    arrayBuffers: memory.arrayBuffers,
    heapUsed: memory.heapUsed,
    usedHeapSize: v8.getHeapStatistics().used_heap_size,
  };
}

function isHigherPeak(current: ProcessMemorySnapshot, peak: ProcessPeakMemorySnapshot): boolean {
  return (
    current.rss > peak.rss ||
    current.external > peak.external ||
    current.arrayBuffers > peak.arrayBuffers ||
    current.heapUsed > peak.heapUsed ||
    current.usedHeapSize > peak.usedHeapSize
  );
}

function readEventLoopDelay(delay: ReturnType<typeof monitorEventLoopDelay>): ProcessEventLoopDelaySnapshot {
  return {
    minMs: nsToMs(delay.min),
    meanMs: nsToMs(delay.mean),
    maxMs: nsToMs(delay.max),
    p50Ms: nsToMs(delay.percentile(50)),
    p95Ms: nsToMs(delay.percentile(95)),
    p99Ms: nsToMs(delay.percentile(99)),
  };
}

function emptyEventLoopDelay(): ProcessEventLoopDelaySnapshot {
  return {
    minMs: 0,
    meanMs: 0,
    maxMs: 0,
    p50Ms: 0,
    p95Ms: 0,
    p99Ms: 0,
  };
}

function nsToMs(value: number): number {
  if (!Number.isFinite(value) || value <= 0 || value > Number.MAX_SAFE_INTEGER) return 0;
  return value / 1_000_000;
}
