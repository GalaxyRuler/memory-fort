export class MemoryFortError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(message);
    this.name = "MemoryFortError";
  }
}

export interface MemoryFortClientOptions {
  baseUrl?: string;
  apiKey?: string;
  fetch?: typeof fetch;
}

export interface SearchResult {
  path: string;
  score: number;
  title?: string;
  snippet?: string;
  provenance?: Record<string, unknown>;
}

export interface PageMeta {
  path: string;
  title: string;
  type?: string;
  updated?: string;
  status?: string;
}

export interface SearchCapabilities {
  searchBackend: "legacy" | "index-lexical" | "index-hybrid";
  supportedParams: string[];
  unsupportedParams: string[];
  scopes: Array<"all" | "wiki" | "raw" | "crystals">;
}
export type SearchScope = "all" | "wiki" | "raw" | "crystals";

export interface SearchOptions {
  k?: number;
  scope?: SearchScope;
  agentId?: string;
  userId?: string;
  asOf?: string;
  identityMode?: "inclusive" | "strict";
  includeArchived?: boolean;
}

export interface LogOptions {
  tags?: string[];
  confidence?: number;
}

async function checked(res: Response): Promise<unknown> {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (body as { error?: string }).error ?? `HTTP ${res.status}`;
    throw new MemoryFortError(msg, res.status, body);
  }
  return body;
}

export class MemoryFortClient {
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;
  private readonly _fetch: typeof fetch;

  constructor(opts: MemoryFortClientOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? "http://127.0.0.1:4410/memory").replace(/\/$/, "");
    this.headers = {
      "content-type": "application/json",
      ...(opts.apiKey ? { authorization: `Bearer ${opts.apiKey}` } : {}),
    };
    this._fetch = opts.fetch ?? globalThis.fetch;
  }

  async search(query: string, opts: SearchOptions = {}): Promise<SearchResult[]> {
    validateSearchOptions(opts);
    const params = new URLSearchParams({ q: query });
    if (opts.k !== undefined) params.set("k", String(opts.k));
    if (opts.scope) params.set("scope", opts.scope);
    if (opts.agentId) params.set("agent_id", opts.agentId);
    if (opts.userId) params.set("user_id", opts.userId);
    if (opts.asOf) params.set("as_of", opts.asOf);
    if (opts.identityMode) params.set("identity_mode", opts.identityMode);
    if (opts.includeArchived !== undefined) params.set("includeArchived", String(opts.includeArchived));
    const res = await this._fetch(`${this.baseUrl}/api/search?${params}`, {
      headers: this.headers,
    });
    const data = (await checked(res)) as { results?: SearchResult[] };
    return data.results ?? [];
  }

  async searchCapabilities(): Promise<SearchCapabilities> {
    const res = await this._fetch(`${this.baseUrl}/api/search/capabilities`, {
      headers: this.headers,
    });
    return parseSearchCapabilities(await checked(res));
  }

  async add(text: string, opts: LogOptions = {}): Promise<void> {
    const res = await this._fetch(`${this.baseUrl}/api/observations`, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify({ text, ...opts }),
    });
    await checked(res);
  }

  async log(text: string, opts: LogOptions = {}): Promise<void> {
    return this.add(text, opts);
  }

  async listPages(opts: { type?: string } = {}): Promise<PageMeta[]> {
    const params = new URLSearchParams();
    if (opts.type) params.set("type", opts.type);
    const query = params.toString() ? `?${params}` : "";
    const res = await this._fetch(`${this.baseUrl}/api/pages${query}`, {
      headers: this.headers,
    });
    const data = (await checked(res)) as { pages?: PageMeta[] };
    return data.pages ?? [];
  }
}

export default MemoryFortClient;

function validateSearchOptions(opts: SearchOptions): void {
  if (
    opts.scope !== undefined
    && !["all", "wiki", "raw", "crystals"].includes(opts.scope)
  ) {
    throw new TypeError(`invalid scope: ${String(opts.scope)}`);
  }
  if (
    opts.identityMode !== undefined
    && opts.identityMode !== "inclusive"
    && opts.identityMode !== "strict"
  ) {
    throw new TypeError(`invalid identityMode: ${String(opts.identityMode)}`);
  }
  if (opts.includeArchived !== undefined && typeof opts.includeArchived !== "boolean") {
    throw new TypeError(`invalid includeArchived: ${String(opts.includeArchived)}`);
  }
}

function parseSearchCapabilities(value: unknown): SearchCapabilities {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("invalid search capabilities response");
  }
  const body = value as Record<string, unknown>;
  const backends = ["legacy", "index-lexical", "index-hybrid"];
  const scopes = ["all", "wiki", "raw", "crystals"];
  if (
    typeof body.searchBackend !== "string"
    || !backends.includes(body.searchBackend)
    || !isStringArray(body.supportedParams)
    || !isStringArray(body.unsupportedParams)
    || !isStringArray(body.scopes)
    || !body.scopes.every((scope) => scopes.includes(scope))
  ) {
    throw new TypeError("invalid search capabilities response");
  }
  return body as unknown as SearchCapabilities;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}
