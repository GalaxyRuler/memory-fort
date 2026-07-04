import {
  openReadOnlyIndexDb,
  resolveIndexDbPath,
  type IndexDb,
} from "../index/db.js";
import {
  createLocalBgeSmallEmbedClient,
  type LocalBgeSmallEmbedClient,
} from "../index/embed.js";
import {
  InlineSearchExecutor,
  readActiveEmbeddingProfile,
  readVectorReadiness,
  type SearchExecutorRequest,
} from "../index/vector-search.js";

export interface SearchProcessInit {
  readonly type: "init";
  readonly vaultRoot: string;
  readonly indexDbPath?: string;
}

export interface SearchProcessParentPort {
  postMessage(message: unknown): void;
  on(event: "message", listener: (message: unknown) => void): unknown;
}

export interface SearchProcessOptions {
  readonly parentPort: SearchProcessParentPort;
  readonly openReadOnlyIndexDbImpl?: typeof openReadOnlyIndexDb;
  readonly createVectorEmbedClientImpl?: () => Promise<LocalBgeSmallEmbedClient>;
  readonly exit?: (code: number) => void;
}

interface SearchRequestMessage {
  readonly type: "search-request";
  readonly id: string;
  readonly request: SearchExecutorRequest;
}

interface SearchCancelMessage {
  readonly type: "search-cancel";
  readonly id: string;
}

export function startSearchProcess(opts: SearchProcessOptions): Promise<void> {
  const openReadOnlyIndexDbImpl = opts.openReadOnlyIndexDbImpl ?? openReadOnlyIndexDb;
  const createVectorEmbedClientImpl = opts.createVectorEmbedClientImpl ?? createLocalBgeSmallEmbedClient;
  const exit = opts.exit ?? ((code) => process.exit(code));
  let indexDb: IndexDb | null = null;
  let init: SearchProcessInit | null = null;
  let vectorClient: Promise<LocalBgeSmallEmbedClient> | null = null;
  let executor: InlineSearchExecutor | null = null;
  let executorProfileId: string | null = null;
  let executorHasMatchingEmbedder = false;
  const controllers = new Map<string, AbortController>();

  async function start(message: SearchProcessInit): Promise<void> {
    init = message;
    indexDb = openReadOnlyIndexDbImpl(message.indexDbPath ?? resolveIndexDbPath({ vaultRoot: message.vaultRoot }));
    opts.parentPort.postMessage({
      type: "search-process-ready",
      pid: process.pid,
      dbPath: indexDb.path,
    });
  }

  async function search(message: SearchRequestMessage): Promise<void> {
    if (!indexDb) throw new Error("search process is not initialized");
    const controller = new AbortController();
    controllers.set(message.id, controller);
    try {
      const searchExecutor = await getExecutor();
      const response = await searchExecutor.search({
        ...message.request,
        signal: controller.signal,
      });
      opts.parentPort.postMessage({ type: "search-response", id: message.id, response });
    } catch (error) {
      opts.parentPort.postMessage({
        type: "search-error",
        id: message.id,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      controllers.delete(message.id);
    }
  }

  async function getExecutor(): Promise<InlineSearchExecutor> {
    if (!indexDb || !init) throw new Error("search process is not initialized");
    const activeProfile = readActiveEmbeddingProfile(indexDb.database);
    const activeProfileId = activeProfile?.profileId ?? null;
    const readiness = readVectorReadiness(indexDb.database, {
      vectorEnabled: true,
      embedderAvailable: true,
      profile: activeProfile,
    });
    if (
      executor &&
      executorProfileId === activeProfileId &&
      (executorHasMatchingEmbedder || readiness.vectorState !== "ready")
    ) {
      return executor;
    }
    if (executorProfileId !== activeProfileId) {
      vectorClient = null;
    }
    executor?.close();
    executor = null;
    executorProfileId = activeProfileId;
    executorHasMatchingEmbedder = false;
    let client: LocalBgeSmallEmbedClient | null = null;
    if (readiness.vectorState === "ready") {
      try {
        vectorClient ??= createVectorEmbedClientImpl();
        const loadedClient = await vectorClient;
        if (loadedClient.profile.profileId === activeProfileId) {
          client = loadedClient;
        } else {
          vectorClient = null;
        }
      } catch {
        client = null;
      }
    }
    executorHasMatchingEmbedder = Boolean(client);
    executor = new InlineSearchExecutor({
      indexDb,
      embedder: client,
      profile: activeProfile ?? undefined,
    });
    return executor;
  }

  function cancel(message: SearchCancelMessage): void {
    controllers.get(message.id)?.abort();
  }

  async function shutdown(): Promise<void> {
    for (const controller of controllers.values()) controller.abort();
    controllers.clear();
    executor?.close();
    executor = null;
    executorProfileId = null;
    executorHasMatchingEmbedder = false;
    indexDb?.close();
    indexDb = null;
    exit(0);
  }

  opts.parentPort.on("message", (raw) => {
    const message = unwrapParentPortMessage(raw);
    if (isShutdownMessage(message)) {
      void shutdown();
      return;
    }
    if (isInitMessage(message)) {
      start(message).catch((error: unknown) => {
        opts.parentPort.postMessage({
          type: "search-process-failed",
          error: error instanceof Error ? error.message : String(error),
        });
      });
      return;
    }
    if (isSearchRequestMessage(message)) {
      void search(message);
      return;
    }
    if (isSearchCancelMessage(message)) {
      cancel(message);
    }
  });

  process.once("SIGTERM", () => {
    void shutdown();
  });

  return Promise.resolve();
}

function isInitMessage(message: unknown): message is SearchProcessInit {
  return (
    typeof message === "object" &&
    message !== null &&
    (message as { type?: unknown }).type === "init" &&
    typeof (message as { vaultRoot?: unknown }).vaultRoot === "string"
  );
}

function isSearchRequestMessage(message: unknown): message is SearchRequestMessage {
  return (
    typeof message === "object" &&
    message !== null &&
    (message as { type?: unknown }).type === "search-request" &&
    typeof (message as { id?: unknown }).id === "string"
  );
}

function isSearchCancelMessage(message: unknown): message is SearchCancelMessage {
  return (
    typeof message === "object" &&
    message !== null &&
    (message as { type?: unknown }).type === "search-cancel" &&
    typeof (message as { id?: unknown }).id === "string"
  );
}

function isShutdownMessage(message: unknown): boolean {
  return message === "shutdown" || (
    typeof message === "object" &&
    message !== null &&
    (message as { type?: unknown }).type === "shutdown"
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

const processWithParentPort = process as NodeJS.Process & { parentPort?: SearchProcessParentPort };

if (processWithParentPort.parentPort) {
  startSearchProcess({ parentPort: processWithParentPort.parentPort }).catch((error: unknown) => {
    console.error(`[search-process] ${(error as Error)?.message ?? String(error)}`);
    process.exit(1);
  });
}
