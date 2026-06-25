export type FullCorpusJobKind = "search" | "verify" | "maintenance";

export interface FullCorpusAdmissionSnapshot {
  active: { kind: FullCorpusJobKind } | null;
  queuedSearches: number;
}

export type MaintenanceAdmissionResult<T> =
  | { started: true; result: T }
  | { started: false; reason: "busy" | "search-active" };

export interface FullCorpusAdmissionGate {
  runSearch<T>(operation: () => Promise<T>): Promise<T>;
  runVerify<T>(operation: () => Promise<T>): Promise<T>;
  tryRunMaintenance<T>(operation: () => Promise<T>): Promise<MaintenanceAdmissionResult<T>>;
  snapshot(): FullCorpusAdmissionSnapshot;
}

interface QueuedJob<T> {
  kind: FullCorpusJobKind;
  run: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

export function createFullCorpusAdmissionGate(): FullCorpusAdmissionGate {
  let active: { kind: FullCorpusJobKind } | null = null;
  const queue: Array<QueuedJob<unknown>> = [];

  async function runExclusive<T>(kind: FullCorpusJobKind, operation: () => Promise<T>): Promise<T> {
    if (!active) {
      return runNow(kind, operation);
    }

    return new Promise<T>((resolve, reject) => {
      queue.push({ kind, run: operation, resolve: resolve as (value: unknown) => void, reject });
    });
  }

  async function runNow<T>(kind: FullCorpusJobKind, operation: () => Promise<T>): Promise<T> {
    active = { kind };
    try {
      return await operation();
    } finally {
      active = null;
      drainQueue();
    }
  }

  function drainQueue(): void {
    if (active || queue.length === 0) return;
    const searchIndex = queue.findIndex((job) => job.kind === "search");
    const index = searchIndex >= 0 ? searchIndex : 0;
    const [job] = queue.splice(index, 1);
    if (!job) return;
    void runNow(job.kind, job.run).then(job.resolve, job.reject);
  }

  return {
    runSearch: (operation) => runExclusive("search", operation),
    runVerify: (operation) => runExclusive("verify", operation),
    async tryRunMaintenance<T>(operation: () => Promise<T>): Promise<MaintenanceAdmissionResult<T>> {
      if (active?.kind === "search" || queue.some((job) => job.kind === "search")) {
        return { started: false, reason: "search-active" };
      }
      if (active) return { started: false, reason: "busy" };
      return { started: true, result: await runNow("maintenance", operation) };
    },
    snapshot: () => ({
      active,
      queuedSearches: queue.filter((job) => job.kind === "search").length,
    }),
  };
}

export const defaultFullCorpusAdmissionGate = createFullCorpusAdmissionGate();
