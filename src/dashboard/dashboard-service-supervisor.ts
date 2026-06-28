export interface DashboardServiceReady {
  url: string;
  port: number;
}

export interface DashboardServiceMainRuntimeEnv {
  electron: string | null;
  node: string;
  modules: string;
  platform: NodeJS.Platform;
  arch: string;
  appPath: string;
  servicePath: string;
  parentPid: number;
}

export interface DashboardServiceRuntimeEnv extends DashboardServiceMainRuntimeEnv {
  utilityChildPid: number | null;
}

export interface DashboardServiceChild {
  readonly pid?: number;
  readonly stdout?: NodeJS.ReadableStream | null;
  readonly stderr?: NodeJS.ReadableStream | null;
  postMessage(message: unknown): void;
  on?(event: "message", listener: (message: unknown) => void): unknown;
  off?(event: "message", listener: (message: unknown) => void): unknown;
  removeListener?(event: "message", listener: (message: unknown) => void): unknown;
  kill(): void;
  once(event: "message", listener: (message: unknown) => void): unknown;
  once(event: "exit", listener: (code: number | null, signal?: string | null) => void): unknown;
}

export interface DashboardServiceSupervisorOptions {
  servicePath: string;
  vaultRoot: string;
  dashboardDistRoot: string;
  fork: (servicePath: string) => DashboardServiceChild;
  setTimeout?: (handler: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
  onReady?: (ready: DashboardServiceReady) => void;
  onMessage?: (message: unknown) => void;
  onRuntimeEnv?: (env: DashboardServiceRuntimeEnv) => void;
  isReadyMessage?: (message: unknown) => message is DashboardServiceReady;
  runtimeEnv?: DashboardServiceMainRuntimeEnv;
  maxRestarts?: number;
  initialBackoffMs?: number;
  maxBackoffMs?: number;
}

export interface DashboardServiceSupervisor {
  start(): Promise<DashboardServiceReady>;
  stop(): void;
}

export function createDashboardServiceSupervisor(
  opts: DashboardServiceSupervisorOptions,
): DashboardServiceSupervisor {
  const setTimer = opts.setTimeout ?? ((handler: () => void, ms: number) => setTimeout(handler, ms));
  const clearTimer = opts.clearTimeout ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const maxRestarts = opts.maxRestarts ?? 6;
  const initialBackoffMs = opts.initialBackoffMs ?? 500;
  const maxBackoffMs = opts.maxBackoffMs ?? 8_000;
  const readyMessage = opts.isReadyMessage ?? isReadyMessage;
  let child: DashboardServiceChild | null = null;
  let stopped = false;
  let restartCount = 0;
  let restartTimer: unknown = null;
  const readyWaiters: Array<{
    resolve: (ready: DashboardServiceReady) => void;
    reject: (error: Error) => void;
  }> = [];

  function forkService(): void {
    child = opts.fork(opts.servicePath);
    const current = child;
    const runtimeEnv = opts.runtimeEnv
      ? {
        ...opts.runtimeEnv,
        utilityChildPid: typeof current.pid === "number" ? current.pid : null,
      }
      : undefined;
    if (runtimeEnv) opts.onRuntimeEnv?.(runtimeEnv);
    current.postMessage({
      vaultRoot: opts.vaultRoot,
      dashboardDistRoot: opts.dashboardDistRoot,
      ...(runtimeEnv ? { runtimeEnv } : {}),
    });

    current.once("exit", () => {
      if (stopped || current !== child) return;
      scheduleRestart();
    });

    listenForReady(current);
  }

  function listenForReady(current: DashboardServiceChild): void {
    let ready = false;
    const onMessage = (message: unknown) => {
      if (ready) return;
      if (!readyMessage(message)) {
        opts.onMessage?.(message);
        if (!opts.onMessage) {
          rejectReadyWaiters(new Error("dashboard service sent an invalid ready message"));
        }
        return;
      }

      ready = true;
      current.off?.("message", onMessage);
      current.removeListener?.("message", onMessage);
      restartCount = 0;
      opts.onReady?.(message);
      resolveReadyWaiters(message);
    };

    if (typeof current.on === "function") {
      current.on("message", onMessage);
    } else {
      current.once("message", onMessage);
    }
  }

  function scheduleRestart(): void {
    if (restartCount >= maxRestarts) {
      rejectReadyWaiters(new Error(`dashboard service failed to start after ${maxRestarts + 1} attempts`));
      return;
    }
    const delay = Math.min(initialBackoffMs * (2 ** restartCount), maxBackoffMs);
    restartCount += 1;
    restartTimer = setTimer(() => {
      restartTimer = null;
      forkService();
    }, delay);
  }

  return {
    start: () => {
      return new Promise((resolve, reject) => {
        readyWaiters.push({ resolve, reject });
        if (!child) forkService();
      });
    },
    stop: () => {
      stopped = true;
      if (restartTimer !== null) {
        clearTimer(restartTimer);
        restartTimer = null;
      }
      child?.postMessage({ type: "shutdown" });
      child?.kill();
      child = null;
    },
  };

  function resolveReadyWaiters(ready: DashboardServiceReady): void {
    const waiters = readyWaiters.splice(0);
    for (const waiter of waiters) waiter.resolve(ready);
  }

  function rejectReadyWaiters(error: Error): void {
    const waiters = readyWaiters.splice(0);
    for (const waiter of waiters) waiter.reject(error);
  }
}

function isReadyMessage(message: unknown): message is DashboardServiceReady {
  return (
    typeof message === "object" &&
    message !== null &&
    typeof (message as { url?: unknown }).url === "string" &&
    typeof (message as { port?: unknown }).port === "number"
  );
}
