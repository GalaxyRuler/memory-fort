import { fork as forkChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  IndexSearchExecutorResponse,
  SearchExecutor,
  SearchExecutorRequest,
} from "../index/vector-search.js";

export interface SearchProcessChild {
  readonly pid?: number;
  postMessage(message: unknown): void;
  on?(event: "message", listener: (message: unknown) => void): unknown;
  off?(event: "message", listener: (message: unknown) => void): unknown;
  removeListener?(event: "message", listener: (message: unknown) => void): unknown;
  once(event: "exit", listener: (code: number | null, signal?: string | null) => void): unknown;
  kill(): void;
}

export interface UtilityProcessSearchExecutorOptions {
  readonly vaultRoot: string;
  readonly indexDbPath?: string;
  readonly searchProcessPath?: string;
  readonly fork?: (entryPath: string) => SearchProcessChild;
  readonly requestTimeoutMs?: number;
}

interface PendingRequest {
  readonly resolve: (response: IndexSearchExecutorResponse) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

interface SearchResponseMessage {
  readonly type: "search-response";
  readonly id: string;
  readonly response: IndexSearchExecutorResponse;
}

interface SearchErrorMessage {
  readonly type: "search-error";
  readonly id: string;
  readonly error: string;
}

interface SearchReadyMessage {
  readonly type: "search-process-ready";
}

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

export class UtilityProcessSearchExecutor implements SearchExecutor {
  private child: SearchProcessChild | null = null;
  private ready: Promise<void> | null = null;
  private readyResolve: (() => void) | null = null;
  private readyReject: ((error: Error) => void) | null = null;
  private pending = new Map<string, PendingRequest>();
  private nextId = 1;

  constructor(private readonly opts: UtilityProcessSearchExecutorOptions) {}

  async search(req: SearchExecutorRequest): Promise<IndexSearchExecutorResponse> {
    await this.ensureStarted();
    const child = this.child;
    if (!child) throw new Error("search process is not running");
    const id = String(this.nextId++);
    const timeoutMs = Math.max(1, Math.trunc(this.opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS));

    return await new Promise<IndexSearchExecutorResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        child.postMessage({ type: "search-cancel", id });
        reject(new Error(`search process request timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      const abort = () => {
        clearTimeout(timer);
        this.pending.delete(id);
        child.postMessage({ type: "search-cancel", id });
        child.kill();
        this.child = null;
        this.ready = null;
        reject(abortError());
      };
      req.signal?.addEventListener("abort", abort, { once: true });
      this.pending.set(id, {
        resolve: (response) => {
          req.signal?.removeEventListener("abort", abort);
          clearTimeout(timer);
          resolve(response);
        },
        reject: (error) => {
          req.signal?.removeEventListener("abort", abort);
          clearTimeout(timer);
          reject(error);
        },
        timer,
      });
      child.postMessage({ type: "search-request", id, request: req });
    });
  }

  close(): void {
    this.rejectPending(new Error("search process closed"));
    this.child?.postMessage({ type: "shutdown" });
    this.child?.kill();
    this.child = null;
    this.ready = null;
  }

  private async ensureStarted(): Promise<void> {
    if (this.child && this.ready) {
      await this.ready;
      return;
    }
    const entryPath = this.opts.searchProcessPath ?? defaultSearchProcessPath();
    if (!entryPath || !existsSync(entryPath)) {
      throw new Error(`search process entry not found: ${entryPath ?? "unresolved"}`);
    }
    const child = (this.opts.fork ?? defaultFork)(entryPath);
    this.child = child;
    this.ready = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    child.on?.("message", (message) => this.handleMessage(message));
    child.once("exit", (code, signal) => {
      if (this.child === child) {
        this.child = null;
        this.ready = null;
      }
      const suffix = `code=${String(code)} signal=${signal ?? "n/a"}`;
      const error = new Error(`search process exited (${suffix})`);
      this.readyReject?.(error);
      this.rejectPending(error);
    });
    child.postMessage({
      type: "init",
      vaultRoot: this.opts.vaultRoot,
      indexDbPath: this.opts.indexDbPath,
    });
    await this.ready;
  }

  private handleMessage(raw: unknown): void {
    const message = unwrapParentPortMessage(raw);
    if (isReadyMessage(message)) {
      this.readyResolve?.();
      this.readyResolve = null;
      this.readyReject = null;
      return;
    }
    if (isResponseMessage(message)) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      pending.resolve(message.response);
      return;
    }
    if (isErrorMessage(message)) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      pending.reject(new Error(message.error));
    }
  }

  private rejectPending(error: Error): void {
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const request of pending) {
      clearTimeout(request.timer);
      request.reject(error);
    }
  }
}

export function resolveDefaultSearchProcessPath(): string | null {
  const appPath = process.env["MEMORY_FORT_APP_PATH"]?.trim();
  if (appPath) return resolve(appPath, "dist", "dashboard", "search-process.mjs");
  return defaultSearchProcessPath();
}

function defaultSearchProcessPath(): string | null {
  const currentDir = dirname(fileURLToPath(import.meta.url));
  return resolve(currentDir, "search-process.mjs");
}

function defaultFork(entryPath: string): SearchProcessChild {
  return forkChildProcess(entryPath, [], {
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  }) as unknown as SearchProcessChild;
}

function isReadyMessage(message: unknown): message is SearchReadyMessage {
  return (
    typeof message === "object" &&
    message !== null &&
    (message as { type?: unknown }).type === "search-process-ready"
  );
}

function isResponseMessage(message: unknown): message is SearchResponseMessage {
  return (
    typeof message === "object" &&
    message !== null &&
    (message as { type?: unknown }).type === "search-response" &&
    typeof (message as { id?: unknown }).id === "string"
  );
}

function isErrorMessage(message: unknown): message is SearchErrorMessage {
  return (
    typeof message === "object" &&
    message !== null &&
    (message as { type?: unknown }).type === "search-error" &&
    typeof (message as { id?: unknown }).id === "string" &&
    typeof (message as { error?: unknown }).error === "string"
  );
}

function unwrapParentPortMessage(message: unknown): unknown {
  if (
    typeof message === "object" &&
    message !== null &&
    "data" in message &&
    "ports" in message
  ) {
    return (message as { data: unknown }).data;
  }
  return message;
}

function abortError(): Error {
  const error = new Error("Search aborted");
  error.name = "AbortError";
  return error;
}
